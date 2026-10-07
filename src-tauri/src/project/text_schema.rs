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
pub const PROPERTY_KEYS: [&str; 4] = ["level", "parent", "order", "format"];

fn default_label(key: &str) -> &'static str {
    match key {
        "property:level" => "Уровень",
        "property:parent" => "Родитель",
        "property:order" => "Порядок",
        "property:format" => "Формат",
        "level:book" => "Книга",
        "level:arc" => "Арка",
        "level:chapter" => "Глава",
        "level:page" => "Страница",
        "format:manuscript" => "Рукопись",
        "format:screenplay" => "Сценарий",
        "format:comic" => "Комикс",
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

/// What `create` produced: the property definitions that go into the new manifest and
/// the `text` block for the structure file. Both are journaled, so a repeat or a
/// cleanup rebuilds byte-identical files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextSchema {
    pub properties: Vec<Value>,
    pub text_block: Value,
}

/// Plans the schema for a text database that does not exist yet.
pub fn plan(
    vault: &Path,
    section_name: &str,
    ids: &PlannedDatabaseIds,
    labels: &BTreeMap<String, String>,
) -> Result<TextSchema, ProjectError> {
    let level_names = LEVEL_KEYS
        .iter()
        .map(|key| label(labels, &format!("level:{key}")))
        .collect::<Result<Vec<_>, _>>()?;
    let format_names = FORMAT_KINDS
        .iter()
        .map(|kind| label(labels, &format!("format:{kind}")))
        .collect::<Result<Vec<_>, _>>()?;
    let property_names = PROPERTY_KEYS
        .iter()
        .map(|key| label(labels, &format!("property:{key}")))
        .collect::<Result<Vec<_>, _>>()?;
    for names in [&level_names, &format_names, &property_names] {
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
        },
    });
    Ok(TextSchema {
        properties: vec![level, parent, order, format],
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
