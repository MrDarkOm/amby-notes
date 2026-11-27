use serde_yaml::{Mapping, Value};
use std::fs;
use std::path::Path;

use crate::model::{FrontmatterProperty, FrontmatterStatus, NoteProperties};

// The atomic-write layer lives in `atomic_fs`; the old paths stay valid.
pub use crate::atomic_fs::{
    atomic_copy_file_new, atomic_write_bytes, atomic_write_bytes_new, atomic_write_new,
    AtomicCreateError,
};
pub use crate::atomic_fs::{
    atomic_rename_with_retry, publish_prepared_no_replace, sync_parent_directory,
};
#[cfg(test)]
pub(crate) use crate::atomic_fs::{
    clear_atomic_write_failure, inject_nth_atomic_write_abort, inject_nth_atomic_write_failure,
};

pub const AMBY_ID_FIELD: &str = "amby-id";
/// Optional Amby-owned display name. It is intentionally namespaced so a
/// user's generic `title` metadata keeps its existing meaning.
pub const AMBY_TITLE_FIELD: &str = "amby-title";
pub const LEGACY_ID_FIELD: &str = "id";

pub fn is_amby_id(id: &str) -> bool {
    ulid::Ulid::from_string(id)
        .map(|parsed| parsed.to_string() == id)
        .unwrap_or(false)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMarkdown {
    pub frontmatter_status: FrontmatterStatus,
    pub id: Option<String>,
    pub display_title: Option<String>,
    pub identity_error: Option<String>,
    pub body: String,
    pub frontmatter_tags: Vec<String>,
    pub has_frontmatter: bool,
    pub yaml_is_map: bool,
    pub parse_error: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParsedNoteIdentity<'a> {
    TrustedAmby(&'a str),
    Missing,
    InvalidAmbyId(&'a str),
}

impl ParsedMarkdown {
    pub fn identity(&self) -> ParsedNoteIdentity<'_> {
        if let Some(error) = self.identity_error.as_deref() {
            ParsedNoteIdentity::InvalidAmbyId(error)
        } else if let Some(id) = self.id.as_deref() {
            ParsedNoteIdentity::TrustedAmby(id)
        } else {
            ParsedNoteIdentity::Missing
        }
    }

    /// Only the namespaced service field establishes authoritative identity. A generic `id`
    /// (a ULID included) belongs to the user or another app and is never read as one.
    pub fn note_id(&self) -> Option<&str> {
        match self.identity() {
            ParsedNoteIdentity::TrustedAmby(id) => Some(id),
            _ => None,
        }
    }

    pub fn indexing_identity_error(&self) -> Option<String> {
        match self.identity() {
            ParsedNoteIdentity::InvalidAmbyId(error) => Some(error.into()),
            _ => None,
        }
    }
}

fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let rest = content
        .strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))?;

    let mut line_start = 0;
    for line in rest.split_inclusive('\n') {
        let line_without_ending = line.strip_suffix('\n').unwrap_or(line);
        let line_without_ending = line_without_ending
            .strip_suffix('\r')
            .unwrap_or(line_without_ending);
        if line_without_ending == "---" {
            let yaml_with_ending = &rest[..line_start];
            let yaml = yaml_with_ending
                .strip_suffix("\r\n")
                .or_else(|| yaml_with_ending.strip_suffix('\n'))
                .unwrap_or(yaml_with_ending);
            return Some((yaml, &rest[line_start + line.len()..]));
        }
        line_start += line.len();
    }

    None
}

/// Return the complete, byte-for-byte frontmatter envelope and the body.
///
/// `split_frontmatter` is intentionally convenient for parsing, but callers
/// that replace only a note body must not reconstruct YAML through serde: doing
/// so drops comments, key ordering and presentation details that belong to the
/// user. This companion keeps the exact prefix (opening fence, YAML, closing
/// fence and its following line break) for safe body-only writes.
pub(crate) fn split_frontmatter_envelope(content: &str) -> Option<(&str, &str)> {
    let (_, body) = split_frontmatter(content)?;
    let prefix_len = content.len().checked_sub(body.len())?;
    Some((&content[..prefix_len], body))
}

/// Parse the user-owned YAML mapping without reconstructing its envelope.
/// Callers that need to write must use one of the lossless splice helpers
/// below; this read helper exists for database YAML conflict projection.
pub(crate) fn frontmatter_yaml_mapping(content: &str) -> Result<Option<Mapping>, String> {
    let Some((yaml, _)) = split_frontmatter(content) else {
        return Ok(None);
    };
    match parse_yaml(yaml).map_err(|error| error.to_string())? {
        Value::Mapping(mapping) => Ok(Some(mapping)),
        _ => Err("Frontmatter must be a YAML mapping".to_owned()),
    }
}

fn parse_yaml(yaml: &str) -> Result<Value, serde_yaml::Error> {
    // Empty/comment-only envelopes can accept their first property. Explicit
    // YAML null scalars (`null`, `~`) remain non-maps and must not be replaced.
    let value = serde_yaml::from_str(yaml)?;
    if matches!(value, Value::Null)
        && yaml.lines().all(|line| {
            let line = line.trim();
            line.is_empty() || line.starts_with('#')
        })
    {
        Ok(Value::Mapping(Mapping::new()))
    } else {
        Ok(value)
    }
}

#[derive(Debug)]
struct TopLevelYamlEntry {
    key: Value,
    line_start: usize,
    line_end: usize,
    value_start: usize,
    value_end: usize,
    value_kind: YamlValueKind,
}

#[derive(Debug, PartialEq, Eq)]
enum YamlValueKind {
    Scalar,
    InlineCollection,
    Complex,
}

/// Replace or append one top-level YAML binding without serializing the
/// surrounding document. The source is scanned only for mapping entries at
/// column zero; nested mappings and block scalar contents therefore remain
/// opaque bytes. The parsed mapping comparison below is the final guard
/// against a splice that changes anything besides the requested key.
pub fn replace_yaml_binding_lossless(
    content: &str,
    key: &str,
    value: &Value,
) -> Result<String, String> {
    validate_binding_key(key)?;
    let scalar = yaml_inline_value(value)?;
    let (yaml, _) = split_frontmatter(content)
        .ok_or_else(|| "YAML binding requires a closed frontmatter envelope".to_owned())?;
    let (yaml_start, yaml_end, envelope_end) = frontmatter_yaml_offsets(content, yaml)?;
    let original =
        parse_yaml(yaml).map_err(|error| format!("Invalid frontmatter YAML: {error}"))?;
    let mut original_mapping = match original {
        Value::Mapping(mapping) => mapping,
        _ => return Err("YAML binding requires a mapping frontmatter root".to_owned()),
    };
    let entries = scan_top_level_yaml_entries(yaml)?;
    validate_mapping_entries(&original_mapping, &entries)?;

    let target = Value::String(key.to_owned());
    let matching = entries
        .iter()
        .filter(|entry| entry.key == target)
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        return Err(format!("YAML binding key '{key}' is duplicated"));
    }
    if matching.is_empty() {
        original_mapping.insert(target, value.clone());
    } else {
        let entry = matching[0];
        if entry.value_kind == YamlValueKind::Complex {
            return Err(format!(
                "YAML binding key '{key}' has an unsupported, anchored, or multiline value"
            ));
        }
        if original_mapping.get(&target) == Some(value) {
            // A semantically identical update should not change quoting, spacing,
            // comments, or any other presentation byte in the source.
            return Ok(content.to_owned());
        }
        original_mapping.insert(target, value.clone());
    }

    let mut next_yaml = yaml.to_owned();
    if let Some(entry) = matching.first() {
        let value_start = entry.value_start;
        let value_end = entry.value_end;
        next_yaml.replace_range(value_start..value_end, &scalar);
    } else {
        let eol = frontmatter_eol(content);
        if !next_yaml.is_empty() {
            next_yaml.push_str(eol);
        }
        next_yaml.push_str(key);
        next_yaml.push_str(": ");
        next_yaml.push_str(&scalar);
    }

    let next = format!(
        "{}{}{}{}",
        &content[..yaml_start],
        next_yaml,
        &content[yaml_end..envelope_end],
        &content[envelope_end..]
    );
    validate_yaml_mapping_change(&next, &original_mapping)
}

fn validate_binding_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || !key.chars().all(|character| {
            character.is_alphanumeric()
                || matches!(character, '-' | '_' | ' ')
                || unicode_normalization::char::is_combining_mark(character)
        })
    {
        return Err("YAML binding key is not a safe top-level key".to_owned());
    }
    Ok(())
}

fn frontmatter_yaml_offsets(content: &str, yaml: &str) -> Result<(usize, usize, usize), String> {
    let envelope = split_frontmatter_envelope(content)
        .map(|(envelope, _)| envelope)
        .ok_or_else(|| "YAML binding requires a closed frontmatter envelope".to_owned())?;
    let without_bom = content.strip_prefix('\u{feff}').unwrap_or(content);
    let bom_len = content.len() - without_bom.len();
    let opening_len = bom_len
        + if without_bom.starts_with("---\r\n") {
            5
        } else {
            4
        };
    let yaml_start = opening_len;
    let yaml_end = yaml_start
        .checked_add(yaml.len())
        .ok_or_else(|| "YAML frontmatter is too large".to_owned())?;
    if yaml_end > envelope.len() {
        return Err("YAML frontmatter boundary is inconsistent".to_owned());
    }
    Ok((yaml_start, yaml_end, envelope.len()))
}

fn frontmatter_eol(content: &str) -> &'static str {
    let without_bom = content.strip_prefix('\u{feff}').unwrap_or(content);
    if without_bom.starts_with("---\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn scan_top_level_yaml_entries(yaml: &str) -> Result<Vec<TopLevelYamlEntry>, String> {
    let mut entries = Vec::new();
    let mut ranges = Vec::new();
    let mut line_start = 0;
    for line in yaml.split_inclusive('\n') {
        ranges.push((line_start, line_start + line.len()));
        line_start += line.len();
    }

    for (line_index, (line_start, line_end)) in ranges.iter().copied().enumerate() {
        let line = &yaml[line_start..line_end];
        let line_without_lf = line.strip_suffix('\n').unwrap_or(line);
        let line_without_eol = line_without_lf
            .strip_suffix('\r')
            .unwrap_or(line_without_lf);
        if let Some((key_text, colon)) = top_level_key_colon(line_without_eol) {
            let key = parse_top_level_key(key_text)?;
            let after_colon = colon + 1;
            let value_start = line_without_eol[after_colon..]
                .find(|character: char| !character.is_ascii_whitespace())
                .map_or(line_without_eol.len(), |offset| after_colon + offset);
            let value_limit = yaml_value_limit(&line_without_eol[value_start..])
                .map_or(line_without_eol.len(), |offset| value_start + offset);
            let value_end = line_without_eol[value_start..value_limit]
                .trim_end_matches([' ', '\t'])
                .len()
                + value_start;
            let value_text = line_without_eol[value_start..value_end].trim();
            let has_continuation = ranges
                .iter()
                .enumerate()
                .skip(line_index + 1)
                .take_while(|(_, (start, end))| {
                    let next_line = yaml[*start..*end].trim_end_matches(['\n', '\r']);
                    top_level_key_colon(next_line).is_none()
                })
                .any(|(_, (start, end))| {
                    let next_line = yaml[*start..*end].trim_end_matches(['\n', '\r']);
                    !next_line.trim().is_empty()
                        && !next_line.trim_start().starts_with('#')
                        && next_line.starts_with(char::is_whitespace)
                });
            let value_kind = if has_continuation
                || value_text.is_empty()
                || value_text.starts_with(['|', '>'])
                || contains_unsafe_yaml_indicator(value_text)
            {
                YamlValueKind::Complex
            } else if value_text.starts_with(['[', '{']) {
                if is_safe_inline_collection(value_text) {
                    YamlValueKind::InlineCollection
                } else {
                    YamlValueKind::Complex
                }
            } else {
                YamlValueKind::Scalar
            };
            entries.push(TopLevelYamlEntry {
                key,
                line_start,
                line_end,
                value_start: line_start + value_start,
                value_end: line_start + value_end,
                value_kind,
            });
        }
    }
    Ok(entries)
}

/// Return whether a value contains an anchor, alias, or tag token outside a
/// quoted scalar. These constructs can carry context outside this one line;
/// refusing them keeps a byte splice from silently changing YAML semantics.
fn contains_unsafe_yaml_indicator(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    let mut flow_depth = 0usize;
    let mut token_start = true;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if double_quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                double_quoted = false;
            }
            index += 1;
            continue;
        }
        if single_quoted {
            if byte == b'\'' {
                if bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                single_quoted = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' if token_start => {
                double_quoted = true;
                token_start = false;
            }
            b'\'' if token_start => {
                single_quoted = true;
                token_start = false;
            }
            b'&' | b'*' | b'!' if token_start => return true,
            b'[' | b'{' if token_start || flow_depth > 0 => {
                flow_depth += 1;
                token_start = true;
            }
            b']' | b'}' if flow_depth > 0 => {
                flow_depth -= 1;
                token_start = false;
            }
            b',' | b':' if flow_depth > 0 => token_start = true,
            byte if byte.is_ascii_whitespace() => {}
            _ => token_start = false,
        }
        index += 1;
    }
    false
}

/// Validate a one-line flow sequence or mapping without deserializing it.
/// serde_yaml performs the semantic validation later; this lexical pass only
/// proves that delimiters are balanced and no context-bearing YAML token is
/// hidden inside an unquoted fragment.
fn is_safe_inline_collection(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some(&opening) = bytes.first() else {
        return false;
    };
    if !matches!(opening, b'[' | b'{') || bytes.last() != Some(&matching_close(opening)) {
        return false;
    }
    let mut stack = Vec::new();
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    let mut token_start = true;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if double_quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                double_quoted = false;
            }
            index += 1;
            continue;
        }
        if single_quoted {
            if byte == b'\'' {
                if bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                single_quoted = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' if token_start => {
                double_quoted = true;
                token_start = false;
            }
            b'\'' if token_start => {
                single_quoted = true;
                token_start = false;
            }
            b'&' | b'*' | b'!' if token_start => return false,
            b'[' | b'{' => {
                stack.push(byte);
                token_start = true;
            }
            b']' | b'}' if stack.pop().map(matching_close) != Some(byte) => return false,
            b']' | b'}' => token_start = false,
            b',' | b':' => token_start = true,
            byte if byte.is_ascii_whitespace() => {}
            _ => token_start = false,
        }
        index += 1;
    }
    !single_quoted && !double_quoted && stack.is_empty()
}

fn matching_close(opening: u8) -> u8 {
    match opening {
        b'[' => b']',
        b'{' => b'}',
        _ => 0,
    }
}

fn top_level_key_colon(line: &str) -> Option<(&str, usize)> {
    if line.is_empty() || line.starts_with(char::is_whitespace) || line.starts_with('#') {
        return None;
    }
    let bytes = line.as_bytes();
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if double_quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                double_quoted = false;
            }
            index += 1;
            continue;
        }
        if single_quoted {
            if byte == b'\'' {
                if bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                single_quoted = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' if index == 0 => double_quoted = true,
            b'\'' if index == 0 => single_quoted = true,
            b':' if bytes
                .get(index + 1)
                .is_none_or(|next| next.is_ascii_whitespace() || *next == b'#') =>
            {
                let key = line[..index].trim_end();
                if key.is_empty() {
                    return None;
                }
                return Some((key, index));
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn parse_top_level_key(key_text: &str) -> Result<Value, String> {
    let source = format!("{key_text}: null");
    let value = serde_yaml::from_str::<Value>(&source)
        .map_err(|error| format!("Unsupported top-level YAML key '{key_text}': {error}"))?;
    let Value::Mapping(mapping) = value else {
        return Err(format!("Unsupported top-level YAML key '{key_text}'"));
    };
    let Some((key, value)) = mapping.into_iter().next() else {
        return Err(format!("Unsupported top-level YAML key '{key_text}'"));
    };
    if value != Value::Null {
        return Err(format!("Unsupported top-level YAML key '{key_text}'"));
    }
    if !matches!(key, Value::String(_)) {
        return Err(format!(
            "Unsupported non-string top-level YAML key '{key_text}'"
        ));
    }
    Ok(key)
}

fn yaml_value_limit(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    let mut flow_depth = 0usize;
    let mut token_start = true;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if double_quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                double_quoted = false;
            }
            index += 1;
            continue;
        }
        if single_quoted {
            if byte == b'\'' {
                if bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                single_quoted = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' if token_start => {
                double_quoted = true;
                token_start = false;
            }
            b'\'' if token_start => {
                single_quoted = true;
                token_start = false;
            }
            b'[' | b'{' if token_start || flow_depth > 0 => {
                flow_depth += 1;
                token_start = true;
            }
            b']' | b'}' if flow_depth > 0 => {
                flow_depth -= 1;
                token_start = false;
            }
            b',' | b':' if flow_depth > 0 => token_start = true,
            b'#' if flow_depth == 0 && (index == 0 || bytes[index - 1].is_ascii_whitespace()) => {
                return Some(index);
            }
            byte if byte.is_ascii_whitespace() => {}
            _ => token_start = false,
        }
        index += 1;
    }
    None
}

fn validate_mapping_entries(
    mapping: &Mapping,
    entries: &[TopLevelYamlEntry],
) -> Result<(), String> {
    for (index, left) in entries.iter().enumerate() {
        if entries[..index].iter().any(|right| right.key == left.key) {
            return Err("YAML binding key is duplicated".to_owned());
        }
    }
    if entries.len() != mapping.len() {
        return Err(
            "Unsupported YAML mapping representation; only explicit top-level entries can be mutated"
                .to_owned(),
        );
    }
    for left in entries {
        if !mapping.contains_key(&left.key) {
            return Err("Unsupported YAML mapping key representation".to_owned());
        }
    }
    Ok(())
}

fn validate_yaml_mapping_change(
    content: &str,
    expected_mapping: &Mapping,
) -> Result<String, String> {
    let (yaml, _) = split_frontmatter(content)
        .ok_or_else(|| "YAML binding update produced an invalid frontmatter envelope".to_owned())?;
    let actual = parse_yaml(yaml)
        .map_err(|error| format!("YAML binding update produced invalid frontmatter: {error}"))?;
    if actual == Value::Mapping(expected_mapping.clone()) {
        Ok(content.to_owned())
    } else {
        Err("YAML binding update changed more than the requested top-level key".to_owned())
    }
}

fn yaml_inline_value(value: &Value) -> Result<String, String> {
    if let Value::Sequence(items) = value {
        let rendered = items
            .iter()
            .map(|item| match item {
                // A comma or a bracket in an item would split or end the flow list.
                Value::String(text)
                    if text.is_empty()
                        || text.contains([',', '[', ']', '{', '}', '#', '\n'])
                        || text.contains(": ")
                        || text.starts_with(char::is_whitespace)
                        || text.ends_with(char::is_whitespace) =>
                {
                    Ok(format!("'{}'", text.replace('\'', "''")))
                }
                other => yaml_inline_value(other),
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        return Ok(format!("[{rendered}]"));
    }
    if let Value::Mapping(map) = value {
        let rendered = map
            .iter()
            .map(|(k, v)| {
                let k_str = yaml_inline_value(k)?;
                let v_str = yaml_inline_value(v)?;
                Ok::<String, String>(format!("{k_str}: {v_str}"))
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        return Ok(format!("{{{rendered}}}"));
    }
    let scalar = serde_yaml::to_string(value)
        .map_err(|error| error.to_string())?
        .trim()
        .to_owned();
    if scalar.is_empty() || scalar.contains(['\n', '\r']) {
        return Err(
            "YAML binding value must be a scalar, inline sequence, or inline mapping".to_owned(),
        );
    }
    Ok(scalar)
}

/// Remove one top-level scalar YAML binding while preserving every other byte
/// in the frontmatter envelope. A missing key is a no-op; duplicate keys are
/// refused rather than guessing which user value should be removed.
pub(crate) fn remove_yaml_binding_lossless(content: &str, key: &str) -> Result<String, String> {
    validate_binding_key(key)?;
    let (yaml, _) = split_frontmatter(content)
        .ok_or_else(|| "YAML binding requires a closed frontmatter envelope".to_owned())?;
    let (yaml_start, yaml_end, envelope_end) = frontmatter_yaml_offsets(content, yaml)?;
    let original =
        parse_yaml(yaml).map_err(|error| format!("Invalid frontmatter YAML: {error}"))?;
    let mut expected = match original {
        Value::Mapping(mapping) => mapping,
        _ => return Err("YAML binding requires a mapping frontmatter root".to_owned()),
    };
    let entries = scan_top_level_yaml_entries(yaml)?;
    validate_mapping_entries(&expected, &entries)?;
    let target = Value::String(key.to_owned());
    let matching = entries
        .iter()
        .filter(|entry| entry.key == target)
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        return Err(format!("YAML binding key '{key}' is duplicated"));
    }
    let Some(entry) = matching.first() else {
        return Ok(content.to_owned());
    };
    if entry.value_kind == YamlValueKind::Complex {
        return Err(format!(
            "YAML binding key '{key}' has an unsupported, anchored, or multiline value"
        ));
    }
    expected.remove(&target);
    // The last line has no newline of its own inside `yaml`: drop the one that ends the line
    // before it, so the closing fence does not get an empty line above it.
    let mut start = entry.line_start;
    if entry.line_end == yaml.len() && !yaml[entry.line_start..].trim().is_empty() {
        if let Some(before) = yaml[..start].strip_suffix('\n') {
            start = before.strip_suffix('\r').unwrap_or(before).len();
        }
    }
    let mut next_yaml = String::with_capacity(yaml.len());
    next_yaml.push_str(&yaml[..start]);
    next_yaml.push_str(&yaml[entry.line_end..]);
    let next = format!(
        "{}{}{}{}",
        &content[..yaml_start],
        next_yaml,
        &content[yaml_end..envelope_end],
        &content[envelope_end..]
    );
    validate_yaml_mapping_change(&next, &expected)
}

/// A top-level key of the header as appendix З reads it (З1, З24): a key that YAML reads as a
/// string, with the value as text and the mark that the value cannot be rewritten without loss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeaderKey {
    /// The key as spelled in the header.
    pub key: String,
    /// Text of the value: a string as it is, a flag or a number as YAML spells it, an empty value
    /// as an empty string, a list of scalars joined with `, `.
    pub value: String,
    /// The items when the value is a YAML list of scalars, as they are; empty otherwise.
    pub items: Vec<String>,
    /// Multiline, block string, anchor, tag or anything else the lossless writer refuses (З26).
    pub complex: bool,
}

/// What the header of a note holds, for reading only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HeaderKeys {
    /// The note has no header.
    Absent,
    /// The header is not closed, not YAML, not a mapping or repeats a key (З25).
    Unreadable,
    /// The keys in the order of the header; keys that are not strings are left out.
    Keys(Vec<HeaderKey>),
}

/// The items of a YAML list of scalars; nothing for any other value.
pub(crate) fn list_items(value: &Value) -> Vec<String> {
    match value {
        Value::Sequence(items)
            if items.iter().all(|item| {
                !matches!(
                    item,
                    Value::Sequence(_) | Value::Mapping(_) | Value::Tagged(_)
                )
            }) =>
        {
            items.iter().map(value_as_text).collect()
        }
        _ => Vec::new(),
    }
}

/// Writes a list as the value of a key without glueing its items: an item with a comma or a bracket
/// is quoted (appendix З, З62).
pub(crate) fn upsert_frontmatter_list(
    content: &str,
    note_id: &str,
    key: &str,
    items: &[String],
) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Property key cannot be empty".to_owned());
    }
    let content_with_envelope = if split_frontmatter(content).is_some() {
        content.to_owned()
    } else {
        body_with_identity_field(content, note_id, AMBY_ID_FIELD)?
    };
    let list = Value::Sequence(items.iter().cloned().map(Value::String).collect());
    replace_yaml_binding_lossless(&content_with_envelope, key, &list)
}

pub(crate) fn value_as_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Sequence(items)
            if items.iter().all(|item| {
                !matches!(
                    item,
                    Value::Sequence(_) | Value::Mapping(_) | Value::Tagged(_)
                )
            }) =>
        {
            items
                .iter()
                .map(value_as_text)
                .collect::<Vec<_>>()
                .join(", ")
        }
        other => yaml_display(other),
    }
}

fn header_keys_by_lines(yaml: &str) -> HeaderKeys {
    let Ok(entries) = scan_top_level_yaml_entries(yaml) else {
        return HeaderKeys::Unreadable;
    };
    let mut seen: Vec<&Value> = Vec::new();
    let mut keys = Vec::new();
    for entry in &entries {
        if seen.contains(&&entry.key) {
            return HeaderKeys::Unreadable;
        }
        seen.push(&entry.key);
        if let Value::String(key) = &entry.key {
            keys.push(HeaderKey {
                key: key.clone(),
                value: yaml[entry.value_start..entry.value_end].trim().to_string(),
                items: Vec::new(),
                complex: true,
            });
        }
    }
    if keys.is_empty() {
        HeaderKeys::Unreadable
    } else {
        HeaderKeys::Keys(keys)
    }
}

/// Reads the keys of the header without writing anything and without caring whether a key could
/// be changed (appendix З: З1, З24–З26).
pub(crate) fn header_keys(content: &str) -> HeaderKeys {
    let Some((yaml, _)) = split_frontmatter(content) else {
        let without_bom = content.strip_prefix('\u{feff}').unwrap_or(content);
        return if without_bom.starts_with("---\n") || without_bom.starts_with("---\r\n") {
            HeaderKeys::Unreadable
        } else {
            HeaderKeys::Absent
        };
    };
    let mapping = match parse_yaml(yaml) {
        Ok(Value::Mapping(mapping)) => mapping,
        Ok(_) => return HeaderKeys::Unreadable,
        // YAML that libyaml refuses (an anchor with a non-ASCII name): the lines are still
        // readable one by one, and every such value is one the writer will not touch.
        Err(_) => return header_keys_by_lines(yaml),
    };
    let entries = scan_top_level_yaml_entries(yaml).ok();
    let keys = mapping
        .iter()
        .filter_map(|(key, value)| {
            let Value::String(key) = key else {
                return None;
            };
            let complex = entries.as_ref().is_some_and(|entries| {
                entries.iter().any(|entry| {
                    matches!(&entry.key, Value::String(k) if k == key)
                        && entry.value_kind == YamlValueKind::Complex
                        && !matches!(value, Value::Null)
                })
            }) || matches!(value, Value::Mapping(_) | Value::Tagged(_))
                || matches!(value, Value::Sequence(items) if items.iter().any(|item| matches!(item, Value::Sequence(_) | Value::Mapping(_) | Value::Tagged(_))));
            Some(HeaderKey {
                key: key.clone(),
                value: value_as_text(value),
                items: list_items(value),
                complex,
            })
        })
        .collect();
    HeaderKeys::Keys(keys)
}

/// Is `key` a key the lossless writer accepts (letters, digits, `-`, `_`, space)?
pub(crate) fn is_safe_binding_key(key: &str) -> bool {
    validate_binding_key(key).is_ok()
}

/// Renames one top-level key without touching its value or anything else of the header (З9,
/// З28). The value may not be complex; the new key may not exist yet.
pub(crate) fn rename_yaml_key_lossless(
    content: &str,
    old_key: &str,
    new_key: &str,
) -> Result<String, String> {
    validate_binding_key(old_key)?;
    validate_binding_key(new_key)?;
    let (yaml, _) = split_frontmatter(content)
        .ok_or_else(|| "YAML binding requires a closed frontmatter envelope".to_owned())?;
    let (yaml_start, yaml_end, envelope_end) = frontmatter_yaml_offsets(content, yaml)?;
    let original =
        parse_yaml(yaml).map_err(|error| format!("Invalid frontmatter YAML: {error}"))?;
    let Value::Mapping(mapping) = original else {
        return Err("YAML binding requires a mapping frontmatter root".to_owned());
    };
    let entries = scan_top_level_yaml_entries(yaml)?;
    validate_mapping_entries(&mapping, &entries)?;
    let old = Value::String(old_key.to_owned());
    let new = Value::String(new_key.to_owned());
    if entries.iter().any(|entry| entry.key == new) {
        return Err(format!("YAML binding key '{new_key}' already exists"));
    }
    let matching = entries
        .iter()
        .filter(|entry| entry.key == old)
        .collect::<Vec<_>>();
    let [entry] = matching.as_slice() else {
        return Err(format!(
            "YAML binding key '{old_key}' is missing or duplicated"
        ));
    };
    if entry.value_kind == YamlValueKind::Complex {
        return Err(format!(
            "YAML binding key '{old_key}' has an unsupported, anchored, or multiline value"
        ));
    }
    let line = &yaml[entry.line_start..entry.line_end];
    let (key_text, _) = top_level_key_colon(line.trim_end_matches(['\n', '\r']))
        .ok_or_else(|| "YAML binding key line is not understood".to_owned())?;
    let key_start = entry.line_start;
    let key_end = key_start + key_text.len();
    let mut next_yaml = yaml.to_owned();
    next_yaml.replace_range(key_start..key_end, new_key);
    let mut expected = Mapping::new();
    for (key, value) in mapping {
        expected.insert(if key == old { new.clone() } else { key }, value);
    }
    let next = format!(
        "{}{}{}{}",
        &content[..yaml_start],
        next_yaml,
        &content[yaml_end..envelope_end],
        &content[envelope_end..]
    );
    validate_yaml_mapping_change(&next, &expected)
}

pub fn property_value_to_yaml_value(value: &str, property_type: &str) -> Value {
    let trimmed = value.trim();
    match property_type {
        "checkbox" => {
            let is_checked = trimmed.eq_ignore_ascii_case("true") || trimmed == "1";
            Value::Bool(is_checked)
        }
        "number" => {
            if let Ok(v @ Value::Number(_)) = serde_yaml::from_str::<Value>(trimmed) {
                v
            } else {
                Value::String(value.to_string())
            }
        }
        "list" => {
            if (trimmed.starts_with('[') && trimmed.ends_with(']')) || trimmed.starts_with('-') {
                if let Ok(v @ Value::Sequence(_)) = serde_yaml::from_str::<Value>(trimmed) {
                    v
                } else {
                    let items: Vec<Value> = trimmed
                        .split(',')
                        .map(|s| Value::String(s.trim().to_string()))
                        .filter(|v| {
                            if let Value::String(s) = v {
                                !s.is_empty()
                            } else {
                                true
                            }
                        })
                        .collect();
                    Value::Sequence(items)
                }
            } else {
                let items: Vec<Value> = trimmed
                    .split(',')
                    .map(|s| Value::String(s.trim().to_string()))
                    .filter(|v| {
                        if let Value::String(s) = v {
                            !s.is_empty()
                        } else {
                            true
                        }
                    })
                    .collect();
                Value::Sequence(items)
            }
        }
        _ => Value::String(value.to_string()),
    }
}

pub fn upsert_frontmatter_property(
    content: &str,
    note_id: &str,
    key: &str,
    value: &str,
    property_type: &str,
) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Property key cannot be empty".to_owned());
    }
    let yaml_value = property_value_to_yaml_value(value, property_type);

    let content_with_envelope = if split_frontmatter(content).is_some() {
        content.to_owned()
    } else {
        body_with_identity_field(content, note_id, AMBY_ID_FIELD)?
    };

    replace_yaml_binding_lossless(&content_with_envelope, key, &yaml_value)
}

pub fn remove_frontmatter_property(content: &str, key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Property key cannot be empty".to_owned());
    }
    remove_yaml_binding_lossless(content, key)
}

pub fn parse_markdown(content: &str) -> ParsedMarkdown {
    let Some((yaml, body)) = split_frontmatter(content) else {
        let without_bom = content.strip_prefix('\u{feff}').unwrap_or(content);
        let unclosed = without_bom.starts_with("---\n") || without_bom.starts_with("---\r\n");
        return ParsedMarkdown {
            frontmatter_status: if unclosed {
                FrontmatterStatus::Unterminated
            } else {
                FrontmatterStatus::None
            },
            id: None,
            display_title: None,
            identity_error: None,
            body: content.to_string(),
            frontmatter_tags: Vec::new(),
            has_frontmatter: unclosed,
            yaml_is_map: !unclosed,
            parse_error: unclosed.then(|| {
                "Frontmatter closing delimiter is missing; showing the complete source".into()
            }),
        };
    };

    match parse_yaml(yaml) {
        Ok(Value::Mapping(map)) => ParsedMarkdown {
            frontmatter_status: FrontmatterStatus::Valid,
            id: map
                .get(Value::String(AMBY_ID_FIELD.to_string()))
                .and_then(Value::as_str)
                .map(str::to_string),
            display_title: map
                .get(Value::String(AMBY_TITLE_FIELD.to_string()))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string),
            identity_error: map
                .get(Value::String(AMBY_ID_FIELD.to_string()))
                .filter(|value| !value.as_str().is_some_and(is_amby_id))
                .map(|_| format!("Invalid {AMBY_ID_FIELD}: expected a canonical uppercase ULID")),
            body: body.to_string(),
            frontmatter_tags: map
                .get(Value::String("tags".to_string()))
                .and_then(Value::as_sequence)
                .map(|tags| {
                    tags.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            has_frontmatter: true,
            yaml_is_map: true,
            parse_error: None,
        },
        Ok(_) => ParsedMarkdown {
            frontmatter_status: FrontmatterStatus::Invalid,
            id: None,
            display_title: None,
            identity_error: None,
            body: body.to_string(),
            frontmatter_tags: Vec::new(),
            has_frontmatter: true,
            yaml_is_map: false,
            parse_error: Some("Frontmatter must be a YAML mapping".into()),
        },
        Err(err) => ParsedMarkdown {
            frontmatter_status: FrontmatterStatus::Invalid,
            id: None,
            display_title: None,
            identity_error: None,
            body: body.to_string(),
            frontmatter_tags: Vec::new(),
            has_frontmatter: true,
            yaml_is_map: false,
            parse_error: Some(err.to_string()),
        },
    }
}

fn yaml_value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "checkbox",
        Value::Number(_) => "number",
        Value::String(_) => "text",
        Value::Sequence(_) => "list",
        Value::Mapping(_) => "object",
        Value::Tagged(_) => "unknown",
    }
}

fn yaml_display(value: &Value) -> String {
    if let Some(value) = value.as_str() {
        return value.to_string();
    }
    serde_yaml::to_string(value)
        .unwrap_or_else(|_| "<unavailable YAML value>".to_string())
        .trim()
        .to_string()
}

/// Extract a display-only property list without rewriting or normalizing YAML.
/// Unknown values remain represented by their YAML text instead of being
/// coerced into a narrower frontend type.
pub fn note_properties(content: &str) -> NoteProperties {
    let parsed = parse_markdown(content);
    let Some((yaml, _)) = split_frontmatter(content) else {
        return NoteProperties {
            has_frontmatter: parsed.has_frontmatter,
            frontmatter_status: parsed.frontmatter_status,
            body_read_only: false,
            properties: Vec::new(),
            parse_error: parsed.parse_error,
            custom_properties: Vec::new(),
        };
    };

    let properties = match serde_yaml::from_str::<Value>(yaml) {
        Ok(Value::Mapping(map)) => map
            .iter()
            .map(|(key, value)| FrontmatterProperty {
                key: yaml_display(key),
                value: yaml_display(value),
                value_kind: yaml_value_kind(value).to_string(),
                items: list_items(value),
            })
            .collect(),
        _ => Vec::new(),
    };
    NoteProperties {
        has_frontmatter: parsed.has_frontmatter,
        frontmatter_status: parsed.frontmatter_status,
        body_read_only: parsed.identity_error.is_some(),
        properties,
        parse_error: parsed.parse_error.or(parsed.identity_error),
        custom_properties: Vec::new(),
    }
}

pub fn read_markdown(path: &Path) -> Result<ParsedMarkdown, String> {
    fs::read_to_string(path)
        .map(|content| parse_markdown(&content))
        .map_err(|e| e.to_string())
}

pub fn body_with_id(content: &str, id: &str) -> Result<String, String> {
    if !is_amby_id(id) {
        return Err(format!(
            "Invalid {AMBY_ID_FIELD}: expected a canonical uppercase ULID"
        ));
    }
    body_with_identity_field(content, id, AMBY_ID_FIELD)
}

// The field parameter is only used to recognize/restore version-1 migration
// output. New note writes always go through body_with_id and AMBY_ID_FIELD.
pub(crate) fn body_with_identity_field(
    content: &str,
    id: &str,
    field: &str,
) -> Result<String, String> {
    // Keep a source BOM at byte zero while inserting the generated envelope.
    // Leaving it attached to the old body would make `atomic_write` restore a
    // second BOM at byte zero and persist the original one inside Markdown.
    let (bom, content_without_bom) = content
        .strip_prefix('\u{feff}')
        .map_or(("", content), |content| ("\u{feff}", content));
    let opening = if content_without_bom.starts_with("---\r\n") {
        Some("---\r\n")
    } else if content_without_bom.starts_with("---\n") {
        Some("---\n")
    } else {
        None
    };
    let mut expected = Mapping::new();
    let next = if let Some(opening) = opening {
        let (yaml, _) = split_frontmatter(content)
            .ok_or_else(|| "Cannot insert an id into unterminated frontmatter".to_string())?;
        expected = match parse_yaml(yaml).map_err(|e| e.to_string())? {
            Value::Mapping(map) => map,
            _ => return Err("Cannot update malformed or non-map frontmatter".to_string()),
        };
        if expected.contains_key(Value::String(field.to_string())) {
            return Err(format!(
                "Refusing to replace an existing frontmatter {field}"
            ));
        }
        let insertion = bom.len() + opening.len();
        let eol = opening
            .strip_prefix("---")
            .expect("`opening` is one of the two literals that start with `---`");
        format!(
            "{}{field}: {id}{eol}{}",
            &content[..insertion],
            &content[insertion..]
        )
    } else {
        let eol = content_without_bom
            .find('\n')
            .filter(|index| content_without_bom[..*index].ends_with('\r'))
            .map_or("\n", |_| "\r\n");
        format!("{bom}---{eol}{field}: {id}{eol}---{eol}{content_without_bom}")
    };
    expected.insert(
        Value::String(field.to_string()),
        Value::String(id.to_string()),
    );

    // Validate the splice without serializing user YAML. Flow/indented root
    // maps and other representations that cannot accept this line safely are
    // rejected; anchors, comments, scalar styles and all source bytes survive.
    let valid = split_frontmatter(&next)
        .and_then(|(yaml, _)| parse_yaml(yaml).ok())
        .is_some_and(|value| value == Value::Mapping(expected));
    if !valid {
        return Err("Cannot insert an id without changing existing YAML".to_string());
    }
    Ok(next)
}

/// The text with the value of its `amby-id` replaced by `id`, and nothing else changed (BOM, line
/// endings, comments, the other keys and the body are kept byte for byte). For the copy of a
/// conflict of synchronisation that stays as a note of its own (docs/sync-plan.md, Р7). It refuses
/// what it cannot do without guessing: no trusted `amby-id`, an id that is not a ULID, the key
/// twice, or a result that does not read back as `id`.
pub fn with_replaced_amby_id(content: &str, id: &str) -> Result<String, String> {
    if !is_amby_id(id) {
        return Err(format!(
            "Invalid {AMBY_ID_FIELD}: expected a canonical uppercase ULID"
        ));
    }
    let parsed = parse_markdown(content);
    let old = parsed
        .note_id()
        .ok_or_else(|| "The note has no trusted amby-id to replace".to_string())?
        .to_string();
    let (envelope, body) = split_frontmatter_envelope(content)
        .ok_or_else(|| "The note has no frontmatter".to_string())?;
    let mut changed = String::with_capacity(content.len());
    let mut replaced = 0;
    for line in envelope.split_inclusive('\n') {
        let text = line.trim_end_matches(['\r', '\n']);
        let eol = &line[text.len()..];
        // Only the key at the start of a line, with the value that was read as the id.
        if let Some(rest) = text.strip_prefix("amby-id:") {
            if rest.trim().trim_matches(['"', '\'']) == old {
                changed.push_str(&format!("{AMBY_ID_FIELD}: {id}{eol}"));
                replaced += 1;
                continue;
            }
        }
        changed.push_str(line);
    }
    if replaced != 1 {
        return Err("Cannot find exactly one amby-id line to replace".to_string());
    }
    changed.push_str(body);
    let reparsed = parse_markdown(&changed);
    if reparsed.note_id() != Some(id) || reparsed.body != parsed.body {
        return Err("The replacement did not read back as expected".to_string());
    }
    Ok(changed)
}

pub fn replace_body_preserving_id(content: &str, body: &str, id: &str) -> Result<String, String> {
    let parsed = parse_markdown(content);
    if parsed.has_frontmatter && !parsed.yaml_is_map {
        return Err("Cannot update malformed or non-map frontmatter".to_string());
    }

    if let Some((envelope, _)) = split_frontmatter_envelope(content) {
        // `write_note` is body-only. The service ID is established before a
        // note is indexed, so rewriting YAML here would provide no benefit and
        // would silently normalize comments, ordering and unknown YAML forms.
        // Refuse an unexpected identity instead of replacing a user edit.
        if parsed.note_id() != Some(id) {
            return Err(
                "Refusing to replace frontmatter whose id no longer matches this note".to_string(),
            );
        }
        Ok(format!("{envelope}{body}"))
    } else {
        body_with_id(body, id)
    }
}

/// Body-only editing does not require parsing the opaque YAML envelope. This
/// helper is only used after validating a path-scoped malformed-note key.
pub fn replace_body_preserving_opaque_frontmatter(
    content: &str,
    body: &str,
) -> Result<String, String> {
    let (envelope, old_body) = split_frontmatter_envelope(content)
        .ok_or("The frontmatter boundary changed; refresh and reopen the note")?;
    let body = text_bytes_from_template(old_body, body)?;
    let body = String::from_utf8(body).map_err(|error| error.to_string())?;
    Ok(format!("{envelope}{body}"))
}

/// Read-only reconstruction of historical version-1 migration outputs. Used
/// solely to verify crash recovery/rollback against raw backups. Never publish
/// these bytes: all new assignments use the namespaced field.
pub(crate) fn legacy_migration_outputs(content: &str, id: &str) -> Result<Vec<Vec<u8>>, String> {
    let mut outputs = Vec::new();
    if let Ok(lossless) = body_with_identity_field(content, id, LEGACY_ID_FIELD) {
        outputs.push(lossless.into_bytes());
    }
    let (bom, without_bom) = content
        .strip_prefix('\u{feff}')
        .map_or(("", content), |text| ("\u{feff}", text));
    let serialized = if let Some((yaml, body)) = split_frontmatter(content) {
        let mut map = match parse_yaml(yaml).map_err(|e| e.to_string())? {
            Value::Mapping(map) => map,
            _ => return Err("Invalid legacy migration backup".into()),
        };
        map.insert(
            Value::String(LEGACY_ID_FIELD.into()),
            Value::String(id.into()),
        );
        format!(
            "{bom}---\n{}---\n{body}",
            serde_yaml::to_string(&map).map_err(|e| e.to_string())?
        )
    } else {
        format!("{bom}---\n{LEGACY_ID_FIELD}: {id}\n---\n{without_bom}")
    };
    outputs.push(text_bytes_from_template(content, &serialized)?);
    Ok(outputs)
}

pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(path, &text_bytes_for_write(path, content)?)
}

/// Return the exact bytes `atomic_write` will publish for an existing text
/// file. Watcher own-write records use this before publication so the atomic
/// rename event can be matched without a post-write race.
pub fn text_bytes_for_write(path: &Path, content: &str) -> Result<Vec<u8>, String> {
    preserve_text_format(path, content)
}

/// Apply the BOM and dominant line-ending convention of an in-memory source
/// template. External deletion removes the path before Amby can inspect its
/// bytes, so explicit restoration uses the last complete source read instead.
pub fn text_bytes_from_template(template: &str, content: &str) -> Result<Vec<u8>, String> {
    preserve_text_format_bytes(template.as_bytes(), content, "restore template")
}

/// Keep the on-disk text convention when replacing an existing UTF-8 file.
/// Editors commonly normalize strings to LF and omit a BOM, so restoring both
/// characteristics here prevents an otherwise unrelated save from reformatting
/// a vault shared with another editor.
fn preserve_text_format(path: &Path, content: &str) -> Result<Vec<u8>, String> {
    let existing = match fs::read(path) {
        Ok(existing) => existing,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(content.as_bytes().to_vec());
        }
        Err(err) => return Err(err.to_string()),
    };
    preserve_text_format_bytes(&existing, content, &path.display().to_string())
}

fn preserve_text_format_bytes(
    existing: &[u8],
    content: &str,
    source_label: &str,
) -> Result<Vec<u8>, String> {
    let has_bom = existing.starts_with(&[0xEF, 0xBB, 0xBF]);
    let text = if has_bom { &existing[3..] } else { existing };
    std::str::from_utf8(text)
        .map_err(|_| format!("Refusing to use non-UTF-8 text template: {source_label}"))?;

    let mut normalized = content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .replace("\r\n", "\n");
    normalized = normalized.replace('\r', "\n");
    let crlf_count = text.windows(2).filter(|pair| *pair == b"\r\n").count();
    let lone_lf_count = text
        .iter()
        .enumerate()
        .filter(|(index, byte)| **byte == b'\n' && (*index == 0 || text[*index - 1] != b'\r'))
        .count();
    if crlf_count > lone_lf_count {
        normalized = normalized.replace('\n', "\r\n");
    }

    let mut bytes = Vec::with_capacity(normalized.len() + usize::from(has_bom) * 3);
    if has_bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(normalized.as_bytes());
    Ok(bytes)
}

#[cfg(test)]
#[path = "frontmatter_test.rs"]
mod tests;
