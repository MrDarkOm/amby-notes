//! Reading and rewriting `amby-project.json`.
//!
//! The file is parsed leniently into a view for discovery, but a rewrite edits
//! the original JSON value so unknown fields survive. A format version this
//! build does not know is never rewritten.

use serde_json::{json, Map, Value};

use super::model::{ProjectKind, KNOWN_FORMAT_VERSION};
use crate::database::format::raw_revision;

/// The structure file is small; a larger one is treated as damaged.
pub const MAX_PROJECT_FILE_BYTES: usize = 1024 * 1024;
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Why a structure file cannot be listed as a project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatProblem {
    pub code: &'static str,
    pub detail: String,
}

fn problem(code: &'static str, detail: impl Into<String>) -> FormatProblem {
    FormatProblem {
        code,
        detail: detail.into(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupDoc {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SectionDoc {
    pub id: String,
    pub role: Option<String>,
    pub group_id: Option<String>,
    pub database_id: String,
    pub path_hint: String,
}

#[derive(Clone, Debug)]
pub struct ProjectDoc {
    /// SHA-256 of the raw bytes, BOM included.
    pub revision: String,
    pub format_version: u64,
    pub kind: ProjectKind,
    pub project_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub groups: Vec<GroupDoc>,
    pub sections: Vec<SectionDoc>,
    pub text_json: Option<String>,
    /// Entries of `sections` that were skipped, with the reason.
    pub skipped_sections: Vec<FormatProblem>,
    /// The whole document, for a rewrite that keeps unknown fields.
    pub raw: Value,
    pub has_bom: bool,
}

impl ProjectDoc {
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

pub fn parse_project_file(bytes: &[u8]) -> Result<ProjectDoc, FormatProblem> {
    if bytes.len() > MAX_PROJECT_FILE_BYTES {
        return Err(problem(
            "invalidProjectFile",
            "The structure file is too large",
        ));
    }
    let revision = raw_revision(bytes);
    let (has_bom, body) = match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let raw: Value = serde_json::from_slice(body)
        .map_err(|error| problem("invalidProjectFile", format!("Not valid JSON: {error}")))?;
    let object = raw
        .as_object()
        .ok_or_else(|| problem("invalidProjectFile", "The document is not an object"))?;

    let format_version = object
        .get("formatVersion")
        .and_then(Value::as_u64)
        .filter(|version| *version >= 1)
        .ok_or_else(|| problem("invalidProjectFile", "formatVersion is missing or invalid"))?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .and_then(ProjectKind::parse)
        .ok_or_else(|| problem("invalidProjectFile", "kind must be collection or story"))?;
    let project_id = text_field(object, "projectId")
        .filter(|id| valid_identifier(id))
        .ok_or_else(|| problem("invalidProjectFile", "projectId is missing or invalid"))?;
    let name = text_field(object, "name")
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty() && name.chars().count() <= 200)
        .ok_or_else(|| problem("invalidProjectFile", "name is missing or invalid"))?;

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

    let groups = object
        .get("groups")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .filter_map(|group| {
                    let group = group.as_object()?;
                    Some(GroupDoc {
                        id: text_field(group, "id").filter(|id| !id.is_empty())?,
                        name: text_field(group, "name").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut sections: Vec<SectionDoc> = Vec::new();
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
            let (Some(id), Some(database_id)) = (
                text_field(entry, "id").filter(|id| !id.is_empty()),
                text_field(entry, "databaseId").filter(|id| !id.is_empty()),
            ) else {
                skipped_sections.push(problem(
                    "invalidSection",
                    format!("sections[{index}] needs an id and a databaseId"),
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
            let path_hint = text_field(entry, "path").unwrap_or_default();
            if !path_hint.is_empty() && !is_safe_relative_hint(&path_hint) {
                skipped_sections.push(problem(
                    "unsafeSectionPath",
                    format!("section {id} has an unsafe path"),
                ));
                continue;
            }
            sections.push(SectionDoc {
                id,
                role: text_field(entry, "role").filter(|role| !role.is_empty()),
                group_id: text_field(entry, "group").filter(|group| !group.is_empty()),
                database_id,
                path_hint,
            });
        }
    }

    let text_json = object
        .get("text")
        .filter(|text| !text.is_null())
        .map(|text| text.to_string());

    Ok(ProjectDoc {
        revision,
        format_version,
        kind,
        project_id,
        name,
        icon,
        tags,
        groups,
        sections,
        text_json,
        skipped_sections,
        raw,
        has_bom,
    })
}

/// A section path is only a hint, but it must stay inside the project folder.
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
pub fn section_entry(
    id: &str,
    role: Option<&str>,
    group_id: Option<&str>,
    database_id: &str,
    path: &str,
) -> Value {
    let mut entry = json!({"id": id, "databaseId": database_id, "path": path});
    if let Some(role) = role {
        entry["role"] = json!(role);
    }
    if let Some(group) = group_id {
        entry["group"] = json!(group);
    }
    entry
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

/// Updates project metadata (`name`, `icon`, `tags`) in `raw`, keeping every other field.
/// For `icon`: `None` leaves it untouched, `Some(None)` removes the key, `Some(Some(v))` sets it.
pub fn with_project_metadata(
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
