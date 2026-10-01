use serde_yaml::{Mapping, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::model::{FrontmatterProperty, FrontmatterStatus, NoteProperties};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

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

#[cfg(test)]
thread_local! {
    static FORCE_HARD_LINK_UNSUPPORTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_NO_REPLACE_FALLBACK_COPY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CREATE_TARGET_AT_PUBLISH: std::cell::RefCell<Option<Vec<u8>>> = const { std::cell::RefCell::new(None) };
}

/// Flush the containing directory after publishing a rename. On Unix this
/// makes the rename durable across a sudden power loss, rather than merely
/// visible to the running process. Windows does not allow opening directories
/// as files through the standard library, so the renamed file's own sync is
/// still the strongest portable guarantee there.
#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

// Test-only fault injection makes every atomic-write boundary observable. It
// is deliberately compiled out of release builds, so no environment variable
// or hidden production switch can interrupt a user save.
#[cfg(test)]
thread_local! {
    static FAIL_ATOMIC_WRITE_STAGE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

// Test-only operation-level fault: fail the n-th `atomic_write_bytes` call on
// this thread, either before the rename (target untouched) or right after it
// (target published, caller sees an error as after a crash).
#[cfg(test)]
thread_local! {
    static FAIL_NTH_ATOMIC_WRITE: std::cell::Cell<(u64, bool)> = const { std::cell::Cell::new((0, false)) };
    static ATOMIC_WRITE_CALLS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn inject_nth_atomic_write_failure(nth: u64, after_publish: bool) {
    ATOMIC_WRITE_CALLS.with(|calls| calls.set(0));
    FAIL_NTH_ATOMIC_WRITE.with(|fault| fault.set((nth, after_publish)));
}

#[cfg(test)]
pub(crate) fn clear_atomic_write_failure() -> u64 {
    FAIL_NTH_ATOMIC_WRITE.with(|fault| fault.set((0, false)));
    ATOMIC_WRITE_CALLS.with(|calls| calls.get())
}

/// Returns `Some(after_publish)` when this call is the one to fail.
#[cfg(test)]
fn nth_write_fault() -> Option<bool> {
    let call = ATOMIC_WRITE_CALLS.with(|calls| {
        calls.set(calls.get() + 1);
        calls.get()
    });
    let (nth, after) = FAIL_NTH_ATOMIC_WRITE.with(|fault| fault.get());
    (nth != 0 && call == nth).then_some(after)
}

#[cfg(not(test))]
fn nth_write_fault() -> Option<bool> {
    None
}

#[cfg(test)]
fn fail_if_requested(stage: u64) -> Result<(), String> {
    if FAIL_ATOMIC_WRITE_STAGE.with(|requested| requested.get()) == stage {
        return Err(format!("injected atomic-write failure at stage {stage}"));
    }
    Ok(())
}

#[cfg(not(test))]
fn fail_if_requested(_stage: u64) -> Result<(), String> {
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum AtomicCreateError {
    AlreadyExists,
    Other(String),
}

fn atomic_create_error(error: std::io::Error) -> AtomicCreateError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        AtomicCreateError::AlreadyExists
    } else {
        AtomicCreateError::Other(error.to_string())
    }
}

fn hard_link_is_unsupported(error: &std::io::Error) -> bool {
    if matches!(error.kind(), std::io::ErrorKind::Unsupported) {
        return true;
    }
    // exFAT/FAT and network filesystems commonly report one of these native
    // errors instead of ErrorKind::Unsupported. The fallback remains safe
    // because it reserves the destination with create_new rather than rename.
    matches!(
        error.raw_os_error(),
        Some(1 | 5 | 17 | 18 | 31 | 45 | 50 | 95)
    )
}

fn create_hard_link(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.get()) {
        return Err(std::io::Error::from_raw_os_error(95));
    }
    fs::hard_link(source, target)
}

fn fallback_copy_temp_new(source: &Path, target: &Path) -> Result<(), AtomicCreateError> {
    let mut reader = fs::File::open(source).map_err(atomic_create_error)?;
    let mut created_target = false;
    let result = (|| -> Result<(), AtomicCreateError> {
        let mut writer = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(atomic_create_error)?;
        created_target = true;
        #[cfg(test)]
        if FAIL_NO_REPLACE_FALLBACK_COPY.with(|fail| fail.get()) {
            return Err(AtomicCreateError::Other(
                "injected no-replace fallback copy failure".to_string(),
            ));
        }
        std::io::copy(&mut reader, &mut writer).map_err(atomic_create_error)?;
        writer.sync_all().map_err(atomic_create_error)
    })();
    if result.is_err() && created_target {
        let _ = fs::remove_file(target);
    }
    result
}

/// Publish a fully prepared sibling file without replacing an existing target.
/// Hard links give an all-or-nothing publish where supported. Filesystems that
/// reject them use a create_new reservation plus streamed, synced copy; the
/// reservation preserves the no-overwrite guarantee even under a collision.
fn publish_prepared_no_replace(temp: &Path, target: &Path) -> Result<(), AtomicCreateError> {
    #[cfg(test)]
    if let Some(content) = CREATE_TARGET_AT_PUBLISH.with(|pending| pending.borrow_mut().take()) {
        fs::write(target, content).map_err(atomic_create_error)?;
    }
    match create_hard_link(temp, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AtomicCreateError::AlreadyExists)
        }
        Err(error) if hard_link_is_unsupported(&error) => fallback_copy_temp_new(temp, target),
        Err(error) => Err(atomic_create_error(error)),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMarkdown {
    pub frontmatter_status: FrontmatterStatus,
    pub id: Option<String>,
    pub display_title: Option<String>,
    pub legacy_id: Option<String>,
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
    LegacyCandidate(&'a str),
    Missing,
    InvalidAmbyId(&'a str),
}

impl ParsedMarkdown {
    pub fn identity(&self) -> ParsedNoteIdentity<'_> {
        if let Some(error) = self.identity_error.as_deref() {
            ParsedNoteIdentity::InvalidAmbyId(error)
        } else if let Some(id) = self.id.as_deref() {
            ParsedNoteIdentity::TrustedAmby(id)
        } else if let Some(id) = self.legacy_id.as_deref() {
            ParsedNoteIdentity::LegacyCandidate(id)
        } else {
            ParsedNoteIdentity::Missing
        }
    }

    /// Only the namespaced service field establishes authoritative identity.
    pub fn note_id(&self) -> Option<&str> {
        match self.identity() {
            ParsedNoteIdentity::TrustedAmby(id) => Some(id),
            _ => None,
        }
    }

    /// This candidate is usable only by the explicitly confirmed migration.
    pub fn migration_id(&self) -> Option<&str> {
        match self.identity() {
            ParsedNoteIdentity::TrustedAmby(id) | ParsedNoteIdentity::LegacyCandidate(id) => {
                Some(id)
            }
            _ => None,
        }
    }

    pub fn indexing_identity_error(&self) -> Option<String> {
        match self.identity() {
            ParsedNoteIdentity::LegacyCandidate(_) => Some("Legacy identity candidate requires explicit migration; generic id remains user-owned".into()),
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
pub(crate) fn replace_yaml_binding_lossless(
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
        || !key
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | ' '))
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
            .map(yaml_inline_value)
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
    let mut next_yaml = String::with_capacity(yaml.len());
    next_yaml.push_str(&yaml[..entry.line_start]);
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
            legacy_id: None,
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
            legacy_id: if map.contains_key(Value::String(AMBY_ID_FIELD.to_string())) {
                None
            } else {
                map.get(Value::String(LEGACY_ID_FIELD.to_string()))
                    .and_then(Value::as_str)
                    .filter(|id| is_amby_id(id))
                    .map(str::to_string)
            },
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
            legacy_id: None,
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
            legacy_id: None,
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
        let eol = opening.strip_prefix("---").unwrap();
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

pub(crate) fn rename_with_retry<F>(mut rename_op: F) -> std::io::Result<()>
where
    F: FnMut() -> std::io::Result<()>,
{
    let mut attempts = 0;
    loop {
        match rename_op() {
            Ok(()) => return Ok(()),
            Err(err) => {
                attempts += 1;
                let is_retryable = if cfg!(windows) {
                    matches!(err.raw_os_error(), Some(5) | Some(32))
                } else {
                    #[cfg(test)]
                    {
                        err.raw_os_error() == Some(32) || err.raw_os_error() == Some(5)
                    }
                    #[cfg(not(test))]
                    {
                        false
                    }
                };

                if is_retryable && attempts <= 5 {
                    let sleep_ms = 5 * 3_u64.pow(attempts - 1);
                    std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                    continue;
                }
                return Err(err);
            }
        }
    }
}

pub(crate) fn atomic_rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    rename_with_retry(|| fs::rename(from, to))
}

/// Write a complete replacement beside the target, sync it to disk, then
/// rename it into place. A unique sibling avoids collisions between concurrent
/// writes and keeps a crash from leaving a truncated user file at `path`.
pub fn atomic_write_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.to_string_lossy()))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let suffix = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{name}.amby-tmp-{}-{suffix}", std::process::id()));

    let nth_fault = nth_write_fault();
    let write_result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        if nth_fault == Some(false) {
            return Err("injected atomic-write failure before publish".to_owned());
        }
        fail_if_requested(1)?;
        file.write_all(content).map_err(|e| e.to_string())?;
        fail_if_requested(2)?;
        file.sync_all().map_err(|e| e.to_string())?;
        fail_if_requested(3)?;
        drop(file);
        fail_if_requested(4)?;
        atomic_rename_with_retry(&tmp, path).map_err(|e| e.to_string())?;
        if nth_fault == Some(true) {
            return Err("injected atomic-write failure after publish".to_owned());
        }
        sync_parent_directory(parent)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

/// Create a new binary file without ever replacing an existing one. The shared
/// publish helper prefers an all-or-nothing hard link and falls back to a
/// create_new reservation plus synced stream copy where hard links are absent.
pub fn atomic_write_bytes_new(path: &Path, content: &[u8]) -> Result<(), AtomicCreateError> {
    let parent = path.parent().ok_or_else(|| {
        AtomicCreateError::Other(format!("Path has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|err| AtomicCreateError::Other(err.to_string()))?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let suffix = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{name}.amby-tmp-{}-{suffix}", std::process::id()));

    let write_result = (|| -> Result<(), AtomicCreateError> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        file.write_all(content)
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        file.sync_all()
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        drop(file);
        publish_prepared_no_replace(&tmp, path)?;
        // The target is now safely published. A stale temp link is harmless,
        // but remove it eagerly so it cannot clutter the user vault.
        let _ = fs::remove_file(&tmp);
        sync_parent_directory(parent).map_err(AtomicCreateError::Other)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

/// Atomically copy a file to a new destination without replacing an existing file.
/// Reads via streaming buffer to avoid allocating the whole source file in memory,
/// enforces `max_bytes`, fsyncs, and uses the shared no-replace publisher.
pub fn atomic_copy_file_new(
    source: &Path,
    path: &Path,
    max_bytes: u64,
) -> Result<u64, AtomicCreateError> {
    let parent = path.parent().ok_or_else(|| {
        AtomicCreateError::Other(format!("Path has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|err| AtomicCreateError::Other(err.to_string()))?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let suffix = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{name}.amby-tmp-{}-{suffix}", std::process::id()));

    let copy_result = (|| -> Result<u64, AtomicCreateError> {
        let mut reader =
            fs::File::open(source).map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        let mut writer = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;

        let mut total_copied: u64 = 0;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read_bytes = reader
                .read(&mut buffer)
                .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
            if read_bytes == 0 {
                break;
            }
            total_copied += read_bytes as u64;
            if total_copied > max_bytes {
                return Err(AtomicCreateError::Other(format!(
                    "File size exceeds maximum allowed limit ({max_bytes} bytes)"
                )));
            }
            writer
                .write_all(&buffer[..read_bytes])
                .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        }

        writer
            .sync_all()
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        drop(writer);

        publish_prepared_no_replace(&tmp, path)?;

        let _ = fs::remove_file(&tmp);
        sync_parent_directory(parent).map_err(AtomicCreateError::Other)?;
        Ok(total_copied)
    })();

    if copy_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    copy_result
}

/// Text wrapper for [`atomic_write_bytes_new`].
pub fn atomic_write_new(path: &Path, content: &str) -> Result<(), AtomicCreateError> {
    atomic_write_bytes_new(path, content.as_bytes())
}

#[cfg(test)]
#[path = "frontmatter_test.rs"]
mod tests;
