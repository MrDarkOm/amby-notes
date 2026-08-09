use serde_yaml::{Mapping, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::model::{FrontmatterProperty, NoteProperties};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMarkdown {
    pub id: Option<String>,
    pub body: String,
    pub frontmatter_tags: Vec<String>,
    pub has_frontmatter: bool,
    pub yaml_is_map: bool,
    pub parse_error: Option<String>,
}

fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    let rest = content.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let yaml = &rest[..end];
    let after = &rest[end + "\n---".len()..];
    let body = after.strip_prefix('\n').unwrap_or(after);
    Some((yaml, body))
}

/// Return the complete, byte-for-byte frontmatter envelope and the body.
///
/// `split_frontmatter` is intentionally convenient for parsing, but callers
/// that replace only a note body must not reconstruct YAML through serde: doing
/// so drops comments, key ordering and presentation details that belong to the
/// user. This companion keeps the exact prefix (opening fence, YAML, closing
/// fence and its following line break) for safe body-only writes.
fn split_frontmatter_envelope(content: &str) -> Option<(&str, &str)> {
    let (_, body) = split_frontmatter(content)?;
    let prefix_len = content.len().checked_sub(body.len())?;
    Some((&content[..prefix_len], body))
}

pub fn parse_markdown(content: &str) -> ParsedMarkdown {
    let Some((yaml, body)) = split_frontmatter(content) else {
        return ParsedMarkdown {
            id: None,
            body: content.to_string(),
            frontmatter_tags: Vec::new(),
            has_frontmatter: false,
            yaml_is_map: true,
            parse_error: None,
        };
    };

    match serde_yaml::from_str::<Value>(yaml) {
        Ok(Value::Mapping(map)) => ParsedMarkdown {
            id: map
                .get(Value::String("id".to_string()))
                .and_then(Value::as_str)
                .map(str::to_string),
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
            id: None,
            body: body.to_string(),
            frontmatter_tags: Vec::new(),
            has_frontmatter: true,
            yaml_is_map: false,
            parse_error: None,
        },
        Err(err) => ParsedMarkdown {
            id: None,
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
            has_frontmatter: false,
            properties: Vec::new(),
            parse_error: None,
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
        properties,
        parse_error: parsed.parse_error,
    }
}

pub fn read_markdown(path: &Path) -> Result<ParsedMarkdown, String> {
    fs::read_to_string(path)
        .map(|content| parse_markdown(&content))
        .map_err(|e| e.to_string())
}

pub fn body_with_id(content: &str, id: &str) -> Result<String, String> {
    let parsed = parse_markdown(content);
    if parsed.has_frontmatter && !parsed.yaml_is_map {
        return Err("Cannot update malformed or non-map frontmatter".to_string());
    }
    if parsed.id.is_some() {
        return Err("Refusing to replace an existing frontmatter id".to_string());
    }

    if let Some((yaml, body)) = split_frontmatter(content) {
        let mut map = serde_yaml::from_str::<Mapping>(yaml).map_err(|e| e.to_string())?;
        map.insert(
            Value::String("id".to_string()),
            Value::String(id.to_string()),
        );
        let yaml = serde_yaml::to_string(&map).map_err(|e| e.to_string())?;
        Ok(format!("---\n{}---\n{}", yaml, body))
    } else {
        Ok(format!("---\nid: {}\n---\n{}", id, content))
    }
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
        if parsed.id.as_deref() != Some(id) {
            return Err(
                "Refusing to replace frontmatter whose id no longer matches this note".to_string(),
            );
        }
        Ok(format!("{envelope}{body}"))
    } else {
        Ok(format!("---\nid: {}\n---\n{}", id, body))
    }
}

pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(path, &preserve_text_format(path, content)?)
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
    let has_bom = existing.starts_with(&[0xEF, 0xBB, 0xBF]);
    let text = if has_bom {
        &existing[3..]
    } else {
        &existing[..]
    };
    std::str::from_utf8(text).map_err(|_| {
        format!(
            "Refusing to overwrite non-UTF-8 text file: {}",
            path.display()
        )
    })?;

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
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

/// Atomically create a new file without ever replacing an existing one. The
/// hard link is created in the same directory as the prepared temporary file,
/// so it is an all-or-nothing publication of the complete synced content.
pub fn atomic_write_new(path: &Path, content: &str) -> Result<(), AtomicCreateError> {
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
        file.write_all(content.as_bytes())
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        file.sync_all()
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        drop(file);
        fs::hard_link(&tmp, path).map_err(|err| {
            if err.kind() == std::io::ErrorKind::AlreadyExists {
                AtomicCreateError::AlreadyExists
            } else {
                AtomicCreateError::Other(err.to_string())
            }
        })?;
        // The target is now safely published. A stale temp link is harmless,
        // but remove it eagerly so it cannot clutter the user vault.
        let _ = fs::remove_file(&tmp);
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_existing_id_and_body() {
        let parsed = parse_markdown("---\nid: 01ABC\n---\nHello");
        assert_eq!(parsed.id.as_deref(), Some("01ABC"));
        assert_eq!(parsed.body, "Hello");
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
        let content = body_with_id("Hello", "01ABC").unwrap();
        assert!(content.starts_with("---\nid: 01ABC\n---\n"));
        assert!(content.ends_with("Hello"));
    }

    #[test]
    fn refuses_to_replace_an_existing_id() {
        let result = body_with_id("---\nid: user-managed\n---\nHello", "01ABC");
        assert!(result.is_err());
    }

    #[test]
    fn body_replacement_keeps_frontmatter_bytes_exact() {
        let original = concat!(
            "---\n",
            "# User-owned comment\n",
            "title: Example\n",
            "custom: [one, two]\n",
            "id: 01ABC\n",
            "---\n",
            "Original body\n",
        );

        let replaced = replace_body_preserving_id(original, "Edited body\n", "01ABC").unwrap();

        assert_eq!(
            replaced,
            concat!(
                "---\n",
                "# User-owned comment\n",
                "title: Example\n",
                "custom: [one, two]\n",
                "id: 01ABC\n",
                "---\n",
                "Edited body\n",
            )
        );
    }

    #[test]
    fn body_replacement_refuses_an_unexpected_frontmatter_id() {
        let original = "---\nid: user-managed\n---\nOriginal body";
        assert!(replace_body_preserving_id(original, "Edited body", "01ABC").is_err());
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
    fn reads_yaml_tag_lists_without_changing_frontmatter() {
        let source = "---\nid: 01ABC\ntags:\n  - Project\n  - inbox/to-read\n---\nBody";
        let parsed = parse_markdown(source);
        assert_eq!(
            parsed.frontmatter_tags,
            vec!["Project".to_string(), "inbox/to-read".to_string()]
        );
        assert_eq!(parsed.body, "Body");
    }
}
