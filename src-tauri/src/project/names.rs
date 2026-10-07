//! Validation of the user-chosen names that become folders and file contents.

use std::fs;
use std::path::Path;

use super::model::ProjectError;

const MAX_NAME_CHARS: usize = 100;
const MAX_TAGS: usize = 32;
const MAX_TAG_CHARS: usize = 64;
/// Icons may be cropped raster data URLs.
const MAX_ICON_BYTES: usize = 256 * 1024;

fn invalid(field: &str, reason: &str) -> ProjectError {
    ProjectError::InvalidName {
        field: field.to_owned(),
        reason: reason.to_owned(),
    }
}

/// Windows device names are unusable as a file or folder stem on any platform
/// the vault may later be moved to.
fn is_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// A project or section name is also its folder name, so it must be a single,
/// portable, visible path component that the scanners will not skip.
pub fn normalize_entry_name(field: &str, raw: &str) -> Result<String, ProjectError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(invalid(field, "empty"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(invalid(field, "too long"));
    }
    if name.starts_with('.') {
        return Err(invalid(field, "hidden"));
    }
    if name.ends_with('.') {
        return Err(invalid(field, "trailing dot"));
    }
    if name.chars().any(|ch| {
        ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(invalid(field, "forbidden character"));
    }
    if is_device_name(name) {
        return Err(invalid(field, "reserved name"));
    }
    let lower = name.to_lowercase();
    if crate::vault::scan::is_service_directory(&lower) || lower == super::model::PROJECT_FILE_NAME
    {
        return Err(invalid(field, "reserved name"));
    }
    Ok(name.to_owned())
}

/// A group title is only text in the structure file.
pub fn normalize_title(field: &str, raw: &str) -> Result<String, ProjectError> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(invalid(field, "empty"));
    }
    if title.chars().count() > MAX_NAME_CHARS || title.chars().any(char::is_control) {
        return Err(invalid(field, "invalid"));
    }
    Ok(title.to_owned())
}

pub fn normalize_tags(raw: &[String]) -> Result<Vec<String>, ProjectError> {
    let mut tags: Vec<String> = Vec::new();
    for tag in raw {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS || tag.chars().any(char::is_control) {
            return Err(invalid("tag", "invalid"));
        }
        if !tags.iter().any(|existing| existing == tag) {
            tags.push(tag.to_owned());
        }
    }
    if tags.len() > MAX_TAGS {
        return Err(invalid("tags", "too many"));
    }
    Ok(tags)
}

pub fn normalize_icon(raw: Option<&str>) -> Result<Option<String>, ProjectError> {
    match raw {
        None | Some("") => Ok(None),
        Some(icon) if icon.len() > MAX_ICON_BYTES => Err(invalid("icon", "too large")),
        Some(icon) => Ok(Some(icon.to_owned())),
    }
}

/// True when `dir` holds an entry named `name`, comparing case-insensitively so
/// a collision is caught on case-insensitive filesystems as well.
pub fn exists_ignoring_case(dir: &Path, name: &str) -> Result<bool, ProjectError> {
    let wanted = name.to_lowercase();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(ProjectError::failed("readDirectory", error.to_string())),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| ProjectError::failed("readDirectory", error.to_string()))?;
        if entry.file_name().to_string_lossy().to_lowercase() == wanted {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_must_be_single_portable_visible_components() {
        assert_eq!(
            normalize_entry_name("name", "  Palooverse ").unwrap(),
            "Palooverse"
        );
        for bad in [
            "",
            "   ",
            ".hidden",
            "a/b",
            "a\\b",
            "a:b",
            "x.",
            "CON",
            "nul.txt",
            "COM1",
            "assets",
            "Assets",
            ".amby",
            "amby-project.json",
            "tab\there",
        ] {
            assert!(normalize_entry_name("name", bad).is_err(), "{bad:?}");
        }
        assert!(normalize_entry_name("name", &"я".repeat(101)).is_err());
        assert!(normalize_entry_name("name", &"я".repeat(100)).is_ok());
    }

    #[test]
    fn tags_are_trimmed_deduplicated_and_bounded() {
        let tags = normalize_tags(&[
            " Комикс ".into(),
            "Комикс".into(),
            "".into(),
            "Рассказ".into(),
        ])
        .unwrap();
        assert_eq!(tags, ["Комикс", "Рассказ"]);
        assert!(normalize_tags(&["x".repeat(65)]).is_err());
        assert!(normalize_tags(&(0..33).map(|n| n.to_string()).collect::<Vec<_>>()).is_err());
    }
}
