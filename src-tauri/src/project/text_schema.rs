//! The schema of a story's text database: the four system properties and the
//! `text` block of the structure file that points at them.
//!
//! Decisions recorded in `docs/creative-format.md` (§3, §5): a level has no ID of
//! its own, `text.levels[].id` is the ID of an option of the level Select, and
//! `text.formats[].id` is the ID of an option of the format Select, both issued the
//! way `create_database_property` issues them. Names and colours live only in the
//! database; `levels` keeps the order and an optional icon.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};

use super::model::ProjectError;
use super::names::normalize_title;
use super::props::{ensure_distinct, PropertyBuilder};
use crate::database::mutations::PlannedDatabaseIds;

/// The level names of the preset, outermost first. Only the template knows them.
pub const LEVEL_KEYS: [&str; 4] = ["book", "arc", "chapter", "page"];
/// The format kinds the format Select is created with.
pub const FORMAT_KINDS: [&str; 4] = ["manuscript", "screenplay", "comic", "note"];
/// The status options the status property is created with (`notStarted`, `inProgress`, `done`).
pub const STATUS_KEYS: [&str; 3] = ["draft", "inProgress", "done"];
pub const PROPERTY_KEYS: [&str; 5] = ["level", "parent", "order", "format", "status"];
/// How many levels a story's text may have.
pub const MAX_TEXT_LEVELS: usize = 6;

fn default_label(key: &str) -> &'static str {
    match key {
        "property:level" => "Уровень",
        "property:parent" => "Родитель",
        "property:order" => "Порядок",
        "property:format" => "Формат",
        "property:status" => "Статус",
        "level:book" => "Книга",
        "level:arc" => "Арка",
        "level:chapter" => "Глава",
        "level:page" => "Страница",
        "format:manuscript" => "Рукопись",
        "format:screenplay" => "Сценарий",
        "format:comic" => "Комикс",
        "status:draft" => "Черновик",
        "status:inProgress" => "В работе",
        "status:done" => "Готово",
        _ => "Заметка",
    }
}

/// Keys of `labels` this schema reads, besides the section and group names.
pub fn is_schema_label(key: &str) -> bool {
    let known = |prefix: &str, list: &[&str]| {
        key.strip_prefix(prefix)
            .is_some_and(|rest| list.contains(&rest))
    };
    known("property:", &PROPERTY_KEYS)
        || known("level:", &LEVEL_KEYS)
        || known("format:", &FORMAT_KINDS)
        || known("status:", &STATUS_KEYS)
}

fn label(labels: &BTreeMap<String, String>, key: &str) -> Result<String, ProjectError> {
    normalize_title(
        "schemaName",
        labels
            .get(key)
            .map(String::as_str)
            .unwrap_or_else(|| default_label(key)),
    )
}

/// Resolves the property name and three option names (`notStarted`, `inProgress`, `done`) for the
/// page status property from `labels` or the Russian defaults.
pub fn resolve_status_labels(
    labels: &BTreeMap<String, String>,
) -> Result<(String, Vec<String>), ProjectError> {
    for key in labels.keys() {
        if !is_schema_label(key) {
            return Err(ProjectError::InvalidName {
                field: "labels".to_owned(),
                reason: format!("unknown label {key}"),
            });
        }
    }
    let property_name = label(labels, "property:status")?;
    let status_names = STATUS_KEYS
        .iter()
        .map(|key| label(labels, &format!("status:{key}")))
        .collect::<Result<Vec<_>, _>>()?;
    ensure_distinct(&status_names)?;
    Ok((property_name, status_names))
}

/// The levels a request names, checked before anything is written: 1 to [`MAX_TEXT_LEVELS`]
/// names, each a valid title, none repeated (case-insensitively, as option names are).
pub fn normalize_text_levels(raw: &[String]) -> Result<Vec<String>, ProjectError> {
    let invalid = |reason: &str| ProjectError::InvalidName {
        field: "textLevels".to_owned(),
        reason: reason.to_owned(),
    };
    if raw.is_empty() {
        return Err(invalid("empty"));
    }
    if raw.len() > MAX_TEXT_LEVELS {
        return Err(invalid("too many"));
    }
    let mut names: Vec<String> = Vec::with_capacity(raw.len());
    for name in raw {
        let name = normalize_title("textLevels", name)?;
        if names
            .iter()
            .any(|existing| existing.to_lowercase() == name.to_lowercase())
        {
            return Err(invalid("duplicate"));
        }
        names.push(name);
    }
    Ok(names)
}

/// What `create` produced: the property definitions that go into the new manifest and
/// the `text` block for the structure file. Both are journaled, so a repeat or a
/// cleanup rebuilds byte-identical files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextSchema {
    pub properties: Vec<Value>,
    pub text_block: Value,
}

/// Plans the schema for a text database that does not exist yet. `levels` are the names the
/// request chose (already normalized); without them the four levels of the template are named
/// from `labels`.
pub fn plan(
    vault: &Path,
    section_name: &str,
    ids: &PlannedDatabaseIds,
    labels: &BTreeMap<String, String>,
    levels: Option<&[String]>,
) -> Result<TextSchema, ProjectError> {
    let level_names = match levels {
        Some(names) => names.to_vec(),
        None => LEVEL_KEYS
            .iter()
            .map(|key| label(labels, &format!("level:{key}")))
            .collect::<Result<Vec<_>, _>>()?,
    };
    let format_names = FORMAT_KINDS
        .iter()
        .map(|kind| label(labels, &format!("format:{kind}")))
        .collect::<Result<Vec<_>, _>>()?;
    let status_names = STATUS_KEYS
        .iter()
        .map(|key| label(labels, &format!("status:{key}")))
        .collect::<Result<Vec<_>, _>>()?;
    let property_names = PROPERTY_KEYS
        .iter()
        .map(|key| label(labels, &format!("property:{key}")))
        .collect::<Result<Vec<_>, _>>()?;
    for names in [&level_names, &format_names, &status_names, &property_names] {
        ensure_distinct(names)?;
    }

    // The manifest the properties are checked against, as it is first written.
    let mut builder = PropertyBuilder::new(vault, section_name, ids)?;
    let (level, level_ids) = builder.add("select", &property_names[0], &level_names, &|_| {})?;
    // One-way, one parent: the parent never lists its children, they are found by query.
    let (parent, parent_ids) = builder.add("relation", &property_names[1], &[], &|spec| {
        spec.relation_max_items = Some(1);
        spec.relation_two_way = Some(false);
    })?;
    let (order, order_ids) = builder.add("text", &property_names[2], &[], &|_| {})?;
    let (format, format_ids) = builder.add("select", &property_names[3], &format_names, &|_| {})?;
    let (status, status_ids) = builder.add("status", &property_names[4], &status_names, &|_| {})?;
    builder.validate()?;

    let text_block = json!({
        "levels": level_ids.option_ids.iter().map(|id| json!({"id": id})).collect::<Vec<_>>(),
        "formats": FORMAT_KINDS
            .iter()
            .zip(&format_ids.option_ids)
            .map(|(kind, id)| json!({"id": id, "kind": kind}))
            .collect::<Vec<_>>(),
        "properties": {
            "level": level_ids.property_id,
            "parent": parent_ids.property_id,
            "order": order_ids.property_id,
            "format": format_ids.property_id,
            "status": status_ids.property_id,
        },
    });
    Ok(TextSchema {
        properties: vec![level, parent, order, format, status],
        text_block,
    })
}

/// Adds the `text` block to a structure document, keeping every other field.
pub fn with_text_block(raw: &Value, text_block: &Value) -> Result<Value, String> {
    let mut document = raw.clone();
    let object = document
        .as_object_mut()
        .ok_or_else(|| "The document is not an object".to_owned())?;
    object.insert("text".to_owned(), text_block.clone());
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
