use serde_yaml::{Mapping, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::model::{FrontmatterProperty, FrontmatterStatus, NoteProperties};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub const AMBY_ID_FIELD: &str = "amby-id";
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
    pub legacy_id: Option<String>,
    pub identity_error: Option<String>,
    pub body: String,
    pub frontmatter_tags: Vec<String>,
    pub has_frontmatter: bool,
    pub yaml_is_map: bool,
    pub parse_error: Option<String>,
}

impl ParsedMarkdown {
    /// Legacy IDs are read-only compatibility candidates, never permission to
    /// rewrite the user's generic `id`. An explicit namespaced value wins even
    /// when invalid: do not fall back and hide that conflict.
    pub fn note_id(&self) -> Option<&str> {
        if self.identity_error.is_some() {
            None
        } else {
            self.id.as_deref().or(self.legacy_id.as_deref())
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
            return Ok(content.as_bytes().to_vec())
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

    let write_result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        fail_if_requested(1)?;
        file.write_all(content).map_err(|e| e.to_string())?;
        fail_if_requested(2)?;
        file.sync_all().map_err(|e| e.to_string())?;
        fail_if_requested(3)?;
        drop(file);
        fail_if_requested(4)?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
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
mod tests {
    use super::*;

    #[test]
    fn parses_existing_id_and_body() {
        let parsed = parse_markdown("---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\nHello");
        assert_eq!(parsed.id.as_deref(), Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert_eq!(parsed.body, "Hello");
    }

    #[test]
    fn parses_crlf_frontmatter_without_treating_it_as_note_body() {
        let parsed = parse_markdown("---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\ntags:\r\n  - Finnish\r\n---\r\nHello\r\n");

        assert_eq!(parsed.id.as_deref(), Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert_eq!(parsed.frontmatter_tags, vec!["Finnish"]);
        assert_eq!(parsed.body, "Hello\r\n");
    }

    #[test]
    fn parses_bom_prefixed_crlf_frontmatter() {
        let parsed = parse_markdown(
            "\u{feff}---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n---\r\nHello\r\n",
        );

        assert_eq!(parsed.id.as_deref(), Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert_eq!(parsed.body, "Hello\r\n");
    }

    #[test]
    fn reads_properties_without_normalizing_yaml() {
        let properties = note_properties(
            "---\n# keep comment\ntitle: Project\ndone: true\ntags: [work, amby]\n---\nBody",
        );
        assert!(properties.has_frontmatter);
        assert_eq!(properties.parse_error, None);
        assert_eq!(properties.properties.len(), 3);
        assert_eq!(properties.properties[0].key, "title");
        assert_eq!(properties.properties[0].value, "Project");
        assert_eq!(properties.properties[1].value_kind, "checkbox");
        assert_eq!(properties.properties[2].value_kind, "list");
    }

    #[test]
    fn inserts_id_without_frontmatter() {
        let content = body_with_id("Hello", "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        assert!(content.starts_with("---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n"));
        assert!(content.ends_with("Hello"));
    }

    #[test]
    fn inserts_id_before_a_bom_prefixed_body_without_duplicating_the_bom() {
        let content = body_with_id("\u{feff}Hello", "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();

        assert!(content.starts_with("\u{feff}---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n"));
        assert_eq!(content.matches('\u{feff}').count(), 1);
        assert_eq!(parse_markdown(&content).body, "Hello");
    }

    #[test]
    fn refuses_to_replace_an_existing_id() {
        let result = body_with_id(
            "---\namby-id: user-managed\n---\nHello",
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        );
        assert!(result.is_err());
    }

    #[test]
    fn id_insertion_preserves_yaml_presentation_and_envelope_bytes() {
        for bom in ["", "\u{feff}"] {
            for eol in ["\n", "\r\n"] {
                for suffix in ["", "\nBody\n\n"] {
                    let yaml = concat!(
                        "# before first property\n",
                        "title: 'Single quoted'  # inline comment\n",
                        "double: \"Double quoted\"\n",
                        "inline: [a, b]\n",
                        "\n",
                        "nested: &nested\n",
                        "  value: 1\n",
                        "alias: *nested\n",
                        "literal: |\n",
                        "  keep these lines\n",
                        "  and their indentation\n",
                        "# after last property\n",
                    )
                    .replace('\n', eol);
                    let tail = format!("{yaml}---{}", suffix.replace('\n', eol));
                    let original = format!("{bom}---{eol}{tail}");
                    let inserted = body_with_id(&original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();

                    assert_eq!(
                        inserted,
                        format!("{bom}---{eol}amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV{eol}{tail}")
                    );
                    assert_eq!(
                        parse_markdown(&inserted).id.as_deref(),
                        Some("01ARZ3NDEKTSV4RRFFQ69G5FAV")
                    );
                    assert_eq!(
                        parse_markdown(&inserted).body,
                        parse_markdown(&original).body
                    );
                }
            }
        }
    }

    #[test]
    fn id_insertion_accepts_empty_and_comment_only_frontmatter() {
        for yaml in ["", "\n", "# comment\n", "  # comment\n\n"] {
            let original = format!("---\n{yaml}---\nBody");
            assert!(parse_markdown(&original).yaml_is_map);
            assert_eq!(
                body_with_id(&original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
                format!("---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n{yaml}---\nBody")
            );
        }
    }

    #[test]
    fn id_insertion_without_frontmatter_uses_source_line_ending() {
        for bom in ["", "\u{feff}"] {
            for body in ["", "# Hello", "# Hello\nBody\n", "# Hello\r\nBody\r\n"] {
                let eol = if body.contains("\r\n") { "\r\n" } else { "\n" };
                assert_eq!(
                    body_with_id(&format!("{bom}{body}"), "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
                    format!("{bom}---{eol}amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV{eol}---{eol}{body}")
                );
            }
        }
    }

    #[test]
    fn id_insertion_refuses_every_existing_id_value() {
        for value in [
            "external", "''", "null", "", "42", "false", "[a, b]", "{a: b}",
        ] {
            let original = format!("---\n'amby-id': {value}\n---\nBody");
            assert!(
                body_with_id(&original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err(),
                "{original}"
            );
        }
    }

    #[test]
    fn id_insertion_refuses_yaml_that_cannot_be_extended_losslessly() {
        for yaml in [
            "tags: [one,\n",
            "title: one\n  other: two\n",
            "null\n",
            "~\n",
            "scalar\n",
            "[one, two]\n",
            "{title: 'flow mapping'}\n",
            "{}\n",
            "  title: indented\n",
        ] {
            let original = format!("---\n{yaml}---\nBody");
            assert!(
                body_with_id(&original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err(),
                "{original}"
            );
        }
    }

    #[test]
    fn id_insertion_refuses_unterminated_frontmatter() {
        for original in ["---\ntitle: open\nBody", "\u{feff}---\r\ntags: [one,\r\n"] {
            assert!(body_with_id(original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err());
        }
    }

    #[test]
    fn body_replacement_keeps_frontmatter_bytes_exact() {
        let original = concat!(
            "---\n",
            "# User-owned comment\n",
            "title: Example\n",
            "custom: [one, two]\n",
            "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
            "---\n",
            "Original body\n",
        );

        let replaced =
            replace_body_preserving_id(original, "Edited body\n", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
                .unwrap();

        assert_eq!(
            replaced,
            concat!(
                "---\n",
                "# User-owned comment\n",
                "title: Example\n",
                "custom: [one, two]\n",
                "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
                "---\n",
                "Edited body\n",
            )
        );
    }

    #[test]
    fn body_replacement_keeps_bom_and_crlf_frontmatter_bytes_exact() {
        let original = concat!(
            "\u{feff}---\r\n",
            "# User-owned comment\r\n",
            "title: Example\r\n",
            "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n",
            "---\r\n",
            "Original body\r\n",
        );

        let replaced =
            replace_body_preserving_id(original, "Edited body\r\n", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
                .unwrap();

        assert_eq!(
            replaced,
            concat!(
                "\u{feff}---\r\n",
                "# User-owned comment\r\n",
                "title: Example\r\n",
                "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n",
                "---\r\n",
                "Edited body\r\n",
            )
        );
    }

    #[test]
    fn deleted_note_restore_template_preserves_opaque_yaml_bom_and_crlf() {
        let template = concat!(
            "\u{feff}---\r\n",
            "# User-owned comment\r\n",
            "custom: [one, two]\r\n",
            "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n",
            "---\r\n",
            "Original body\r\n",
        );
        let next =
            replace_body_preserving_id(template, "Restored\nbody\n", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
                .unwrap();
        let bytes = text_bytes_from_template(template, &next).unwrap();

        assert_eq!(
            bytes,
            concat!(
                "\u{feff}---\r\n",
                "# User-owned comment\r\n",
                "custom: [one, two]\r\n",
                "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n",
                "---\r\n",
                "Restored\r\n",
                "body\r\n",
            )
            .as_bytes()
        );
    }

    #[test]
    fn body_replacement_refuses_an_unexpected_frontmatter_id() {
        let original = "---\namby-id: user-managed\n---\nOriginal body";
        assert!(
            replace_body_preserving_id(original, "Edited body", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
                .is_err()
        );
    }

    #[test]
    fn atomic_write_replaces_existing_content_without_leaving_a_temp_file() {
        let dir = std::env::temp_dir().join(format!(
            "amby-atomic-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        fs::write(&path, "old").unwrap();

        atomic_write(&path, "new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_preserves_utf8_bom_and_crlf() {
        let dir = std::env::temp_dir().join(format!(
            "amby-text-format-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        fs::write(&path, b"\xEF\xBB\xBFbefore\r\ntext\r\n").unwrap();

        atomic_write(&path, "after\ntext\n").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFafter\r\ntext\r\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn id_insertion_preserves_one_bom_crlf_and_terminal_line_breaks() {
        let dir = std::env::temp_dir().join(format!(
            "amby-frontmatter-format-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        fs::write(&path, b"\xEF\xBB\xBFbody\r\n\r\n\r\n").unwrap();

        let source = fs::read_to_string(&path).unwrap();
        let next = body_with_id(&source, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        atomic_write(&path, &next).unwrap();

        let persisted = fs::read(&path).unwrap();
        assert!(persisted.starts_with(b"\xEF\xBB\xBF---\r\n"));
        assert_eq!(
            persisted
                .windows(3)
                .filter(|bytes| *bytes == b"\xEF\xBB\xBF")
                .count(),
            1
        );
        assert!(!persisted.windows(2).any(|bytes| bytes == b"\n\n"));
        assert!(persisted.ends_with(b"body\r\n\r\n\r\n"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_failure_at_each_phase_keeps_original_and_cleans_temp() {
        let dir = std::env::temp_dir().join(format!(
            "amby-atomic-failure-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");

        for stage in 1..=4 {
            fs::write(&path, "original").unwrap();
            FAIL_ATOMIC_WRITE_STAGE.with(|requested| requested.set(stage));
            let error = atomic_write_bytes(&path, b"replacement").unwrap_err();
            assert!(error.contains("injected"));
            assert_eq!(fs::read_to_string(&path).unwrap(), "original");
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "stage {stage}");
        }
        FAIL_ATOMIC_WRITE_STAGE.with(|requested| requested.set(0));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_new_never_replaces_an_existing_file() {
        let dir = std::env::temp_dir().join(format!(
            "amby-create-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        fs::write(&path, "original").unwrap();

        assert_eq!(
            atomic_write_new(&path, "replacement"),
            Err(AtomicCreateError::AlreadyExists)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");

        let new_path = dir.join("copy.md");
        atomic_write_new(&new_path, "copy").unwrap();
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "copy");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_replace_fallback_handles_unsupported_hard_links_and_collisions() {
        let dir = std::env::temp_dir().join(format!(
            "amby-no-replace-fallback-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");
        let source = dir.join("source.bin");
        let copied = dir.join("copied.bin");
        fs::write(&source, b"source bytes").unwrap();

        FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.set(true));
        atomic_write_new(&path, "created by fallback").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "created by fallback");
        assert_eq!(
            atomic_write_new(&path, "must not replace"),
            Err(AtomicCreateError::AlreadyExists)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "created by fallback");

        assert_eq!(
            atomic_copy_file_new(&source, &copied, 1024).unwrap(),
            b"source bytes".len() as u64
        );
        assert_eq!(fs::read(&copied).unwrap(), b"source bytes");
        FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.set(false));

        assert_eq!(fs::read_dir(&dir).unwrap().count(), 3);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_replace_fallback_cleans_a_reserved_target_after_copy_failure() {
        let dir = std::env::temp_dir().join(format!(
            "amby-no-replace-cleanup-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("note.md");

        FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.set(true));
        FAIL_NO_REPLACE_FALLBACK_COPY.with(|fail| fail.set(true));
        let error = atomic_write_new(&path, "partial").unwrap_err();
        FAIL_NO_REPLACE_FALLBACK_COPY.with(|fail| fail.set(false));
        FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.set(false));

        assert!(matches!(error, AtomicCreateError::Other(_)));
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unsupported_hard_link_error_classes_select_the_fallback() {
        for code in [1, 5, 17, 18, 31, 45, 50, 95] {
            assert!(hard_link_is_unsupported(
                &std::io::Error::from_raw_os_error(code)
            ));
        }
    }

    #[test]
    fn reads_yaml_tag_lists_without_changing_frontmatter() {
        let source = "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ntags:\n  - Project\n  - inbox/to-read\n---\nBody";
        let parsed = parse_markdown(source);
        assert_eq!(
            parsed.frontmatter_tags,
            vec!["Project".to_string(), "inbox/to-read".to_string()]
        );
        assert_eq!(parsed.body, "Body");
    }

    #[test]
    fn atomic_copy_file_new_streams_file_and_enforces_max_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "amby-copy-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("source.bin");
        let dest = dir.join("dest.bin");

        // Write 1KB payload
        let payload = vec![0x42u8; 1024];
        fs::write(&src, &payload).unwrap();

        // 1. Success copy
        let copied = atomic_copy_file_new(&src, &dest, 2048).unwrap();
        assert_eq!(copied, 1024);
        assert_eq!(fs::read(&dest).unwrap(), payload);

        // 2. Reject existing destination
        assert_eq!(
            atomic_copy_file_new(&src, &dest, 2048),
            Err(AtomicCreateError::AlreadyExists)
        );

        // 3. Reject if source exceeds max_bytes
        let dest_small_limit = dir.join("dest2.bin");
        assert!(atomic_copy_file_new(&src, &dest_small_limit, 512).is_err());
        assert!(!dest_small_limit.exists());

        fs::remove_dir_all(dir).unwrap();
    }
}
