//! Reading and rewriting `amby-workshop.json` and `amby-story.json`.
//!
//! The files are parsed leniently into views for discovery, but rewrites edit
//! the original JSON values so unknown fields survive. A format version this
//! build does not know is never rewritten.

use serde_json::{json, Map, Value};

use super::model::KNOWN_FORMAT_VERSION;
use crate::database::format::raw_revision;

/// The structure file is small; a larger one is treated as damaged.
pub const MAX_PROJECT_FILE_BYTES: usize = 1024 * 1024;
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Why a structure file cannot be read or validated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatProblem {
    pub code: &'static str,
    pub detail: String,
}

pub fn problem(code: &'static str, detail: impl Into<String>) -> FormatProblem {
    FormatProblem {
        code,
        detail: detail.into(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkshopSectionDoc {
    pub id: String,
    pub role: String,
    pub name: String,
    pub database_id: String,
    pub path: String,
}

#[derive(Clone, Debug)]
pub struct WorkshopDoc {
    /// SHA-256 of the raw bytes, BOM included.
    pub revision: String,
    pub format_version: u64,
    pub workshop_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub sections: Vec<WorkshopSectionDoc>,
    /// Entries of `sections` that were skipped, with the reason.
    pub skipped_sections: Vec<FormatProblem>,
    /// The whole document, for a rewrite that keeps unknown fields.
    pub raw: Value,
    pub has_bom: bool,
}

impl WorkshopDoc {
    pub fn is_known_version(&self) -> bool {
        self.format_version == KNOWN_FORMAT_VERSION
    }
}

#[derive(Clone, Debug)]
pub struct StoryDoc {
    pub revision: String,
    pub format_version: u64,
    pub story_id: String,
    pub text_json: Option<String>,
    pub raw: Value,
    pub has_bom: bool,
}

impl StoryDoc {
    pub fn is_known_version(&self) -> bool {
        self.format_version == KNOWN_FORMAT_VERSION
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn text_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub fn parse_workshop_file(bytes: &[u8]) -> Result<WorkshopDoc, FormatProblem> {
    if bytes.len() > MAX_PROJECT_FILE_BYTES {
        return Err(problem(
            "invalidWorkshopFile",
            "The workshop file is too large",
        ));
    }
    let revision = raw_revision(bytes);
    let (has_bom, body) = match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let raw: Value = serde_json::from_slice(body)
        .map_err(|error| problem("invalidWorkshopFile", format!("Not valid JSON: {error}")))?;
    let object = raw
        .as_object()
        .ok_or_else(|| problem("invalidWorkshopFile", "The document is not an object"))?;

    let format_version = object
        .get("formatVersion")
        .and_then(Value::as_u64)
        .filter(|version| *version >= 1)
        .ok_or_else(|| problem("invalidWorkshopFile", "formatVersion is missing or invalid"))?;
    let workshop_id = text_field(object, "workshopId")
        .filter(|id| valid_identifier(id))
        .ok_or_else(|| problem("invalidWorkshopFile", "workshopId is missing or invalid"))?;
    let name = text_field(object, "name")
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty() && name.chars().count() <= 200)
        .ok_or_else(|| problem("invalidWorkshopFile", "name is missing or invalid"))?;

    let icon = text_field(object, "icon").filter(|icon| !icon.is_empty());
    let tags = object
        .get("tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    let mut sections: Vec<WorkshopSectionDoc> = Vec::new();
    let mut skipped_sections = Vec::new();
    if let Some(entries) = object.get("sections").and_then(Value::as_array) {
        for (index, entry) in entries.iter().enumerate() {
            let Some(entry) = entry.as_object() else {
                skipped_sections.push(problem(
                    "invalidSection",
                    format!("sections[{index}] is not an object"),
                ));
                continue;
            };
            let (Some(id), Some(role), Some(database_id)) = (
                text_field(entry, "id").filter(|id| !id.is_empty()),
                text_field(entry, "role").filter(|role| !role.is_empty()),
                text_field(entry, "databaseId").filter(|id| !id.is_empty()),
            ) else {
                skipped_sections.push(problem(
                    "invalidSection",
                    format!("sections[{index}] needs an id, a role and a databaseId"),
                ));
                continue;
            };
            if sections.iter().any(|existing| existing.id == id) {
                skipped_sections.push(problem(
                    "duplicateSectionId",
                    format!("section id {id} appears more than once"),
                ));
                continue;
            }
            let name = text_field(entry, "name").unwrap_or_else(|| id.clone());
            let path = text_field(entry, "path").unwrap_or_else(|| name.clone());
            if !path.is_empty() && !is_safe_relative_hint(&path) {
                skipped_sections.push(problem(
                    "unsafeSectionPath",
                    format!("section {id} has an unsafe path"),
                ));
                continue;
            }
            sections.push(WorkshopSectionDoc {
                id,
                role,
                name,
                database_id,
                path,
            });
        }
    }

    Ok(WorkshopDoc {
        revision,
        format_version,
        workshop_id,
        name,
        icon,
        tags,
        sections,
        skipped_sections,
        raw,
        has_bom,
    })
}

pub fn parse_story_file(bytes: &[u8]) -> Result<StoryDoc, FormatProblem> {
    if bytes.len() > MAX_PROJECT_FILE_BYTES {
        return Err(problem("invalidStoryFile", "The story file is too large"));
    }
    let revision = raw_revision(bytes);
    let (has_bom, body) = match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let raw: Value = serde_json::from_slice(body)
        .map_err(|error| problem("invalidStoryFile", format!("Not valid JSON: {error}")))?;
    let object = raw
        .as_object()
        .ok_or_else(|| problem("invalidStoryFile", "The document is not an object"))?;

    let format_version = object
        .get("formatVersion")
        .and_then(Value::as_u64)
        .filter(|version| *version >= 1)
        .ok_or_else(|| problem("invalidStoryFile", "formatVersion is missing or invalid"))?;
    let story_id = text_field(object, "storyId")
        .filter(|id| valid_identifier(id))
        .ok_or_else(|| problem("invalidStoryFile", "storyId is missing or invalid"))?;

    let text_json = object
        .get("text")
        .filter(|text| !text.is_null())
        .map(|text| text.to_string());

    Ok(StoryDoc {
        revision,
        format_version,
        story_id,
        text_json,
        raw,
        has_bom,
    })
}

/// A section path is only a hint, but it must stay inside the workshop folder.
pub fn is_safe_relative_hint(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.starts_with('/')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Serializes a document the way Amby writes it: pretty JSON, one trailing
/// newline, and the BOM the file already had.
pub fn document_bytes(value: &Value, with_bom: bool) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    if with_bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend(serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?);
    bytes.push(b'\n');
    if bytes.len() > MAX_PROJECT_FILE_BYTES {
        return Err("The structure file would be too large".to_owned());
    }
    Ok(bytes)
}

/// A section entry in the shape the contract defines.
pub fn workshop_section_entry(
    id: &str,
    role: &str,
    name: &str,
    database_id: &str,
    path: &str,
) -> Value {
    json!({
        "id": id,
        "role": role,
        "name": name,
        "databaseId": database_id,
        "path": path,
    })
}

/// Appends a section to `raw`, keeping every other field untouched.
pub fn with_section_appended(raw: &Value, entry: Value) -> Result<Value, String> {
    let mut document = raw.clone();
    let object = document
        .as_object_mut()
        .ok_or_else(|| "The document is not an object".to_owned())?;
    match object.get_mut("sections") {
        Some(Value::Array(sections)) => sections.push(entry),
        Some(_) => return Err("sections is not an array".to_owned()),
        None => {
            object.insert("sections".to_owned(), Value::Array(vec![entry]));
        }
    }
    Ok(document)
}

/// Updates workshop metadata (`name`, `icon`, `tags`) in `raw`, keeping every other field.
/// For `icon`: `None` leaves it untouched, `Some(None)` removes the key, `Some(Some(v))` sets it.
pub fn with_workshop_metadata(
    raw: &Value,
    name: Option<&str>,
    icon: Option<Option<&str>>,
    tags: Option<&[String]>,
) -> Result<Value, String> {
    let mut document = raw.clone();
    let object = document
        .as_object_mut()
        .ok_or_else(|| "The document is not an object".to_owned())?;
    if let Some(name) = name {
        object.insert("name".to_owned(), json!(name));
    }
    if let Some(icon) = icon {
        match icon {
            Some(value) => {
                object.insert("icon".to_owned(), json!(value));
            }
            None => {
                object.remove("icon");
            }
        }
    }
    if let Some(tags) = tags {
        object.insert("tags".to_owned(), json!(tags));
    }
    Ok(document)
}

/// Removes the section entry with `id == section_id` from `raw["sections"]`, keeping every other
/// entry and field untouched.
pub fn with_section_removed(raw: &Value, section_id: &str) -> Result<Value, String> {
    let mut document = raw.clone();
    let object = document
        .as_object_mut()
        .ok_or_else(|| "The document is not an object".to_owned())?;
    let Some(Value::Array(sections)) = object.get_mut("sections") else {
        return Err("sections is not an array".to_owned());
    };
    sections.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(section_id));
    Ok(document)
}

/// Reorders the known sections in `raw["sections"]` to match `section_ids`, keeping every entry's
/// full JSON object (including unknown fields) and preserving any skipped/unrecognized entries at
/// the end.
pub fn with_sections_reordered(raw: &Value, section_ids: &[String]) -> Result<Value, String> {
    let mut document = raw.clone();
    let object = document
        .as_object_mut()
        .ok_or_else(|| "The document is not an object".to_owned())?;
    let Some(Value::Array(sections)) = object.get_mut("sections") else {
        return Err("sections is not an array".to_owned());
    };
    let original = std::mem::take(sections);
    let mut reordered = Vec::with_capacity(original.len());
    let mut used = vec![false; original.len()];
    for wanted in section_ids {
        if let Some((index, _)) = original.iter().enumerate().find(|(idx, entry)| {
            !used[*idx] && entry.get("id").and_then(Value::as_str) == Some(wanted.as_str())
        }) {
            used[index] = true;
            reordered.push(original[index].clone());
        }
    }
    for (index, entry) in original.into_iter().enumerate() {
        if !used[index] {
            reordered.push(entry);
        }
    }
    *sections = reordered;
    Ok(document)
}

/// Replaces `text.levels` in `raw` with `(id, icon)` entries in the given order, preserving any
/// unknown fields on existing level objects and all other fields of `text` and `raw`.
pub fn with_text_levels_updated(
    raw: &Value,
    levels: &[(String, Option<String>)],
) -> Result<Value, String> {
    let mut document = raw.clone();
    let object = document
        .as_object_mut()
        .ok_or_else(|| "The document is not an object".to_owned())?;
    let text = object
        .get_mut("text")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "The text block is not an object".to_owned())?;
    let existing = text
        .get("levels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next = Vec::with_capacity(levels.len());
    for (id, icon) in levels {
        let mut entry = existing
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .cloned()
            .unwrap_or_else(|| json!({"id": id}));
        let Some(entry_obj) = entry.as_object_mut() else {
            return Err("A level entry is not an object".to_owned());
        };
        entry_obj.insert("id".to_owned(), json!(id));
        match icon {
            Some(icon) => {
                entry_obj.insert("icon".to_owned(), json!(icon));
            }
            None => {
                entry_obj.remove("icon");
            }
        }
        next.push(entry);
    }
    text.insert("levels".to_owned(), Value::Array(next));
    Ok(document)
}

/// Sets `text.properties.status` in `raw`, keeping all other fields of `text` and `raw`.
pub fn with_text_status_property(raw: &Value, property_id: &str) -> Result<Value, String> {
    let mut document = raw.clone();
    let object = document
        .as_object_mut()
        .ok_or_else(|| "The document is not an object".to_owned())?;
    let text = object
        .get_mut("text")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "The text block is not an object".to_owned())?;
    let properties = text
        .entry("properties")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "text.properties is not an object".to_owned())?;
    properties.insert("status".to_owned(), json!(property_id));
    Ok(document)
}
