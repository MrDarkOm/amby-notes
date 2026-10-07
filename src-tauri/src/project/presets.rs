//! Section presets ("заготовки"): what a new world section starts with. A preset sets an
//! icon, a few starting properties, a default view and the starter headings of the page
//! template (the dossier's sections, `docs/creative-format.md` §10). After creation the
//! section is an ordinary database with no special status.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::model::ProjectError;
use super::names::normalize_title;
use super::props::{ensure_distinct, gallery_grouped_by, PropertyBuilder};
use crate::database::mutations::{json_bytes, NewDatabaseExtras, PlannedDatabaseIds};

const IMPORTANCE: [&str; 3] = ["main", "side", "episode"];
const KINDS: [&str; 4] = ["city", "district", "place", "nature"];
const HEADINGS: [&str; 6] = [
    "basic",
    "traits",
    "appearance",
    "biography",
    "description",
    "history",
];

fn default_label(key: &str) -> &'static str {
    match key {
        "preset:importance" => "Значимость",
        "preset:kind" => "Тип",
        "preset:portrait" => "Портрет",
        "preset:image" => "Изображение",
        "importance:main" => "Главные",
        "importance:side" => "Второстепенные",
        "importance:episode" => "Эпизодические",
        "kind:city" => "Город",
        "kind:district" => "Район",
        "kind:place" => "Место",
        "kind:nature" => "Природа",
        "heading:basic" => "Основное",
        "heading:traits" => "Характеристика",
        "heading:appearance" => "Внешность",
        "heading:biography" => "Биография",
        "heading:description" => "Описание",
        "heading:history" => "История",
        "view:gallery" => "Галерея",
        _ => "Досье",
    }
}

/// Keys of `labels` the presets read.
pub fn is_preset_label(key: &str) -> bool {
    let known = |prefix: &str, list: &[&str]| {
        key.strip_prefix(prefix)
            .is_some_and(|rest| list.contains(&rest))
    };
    known("preset:", &["importance", "kind", "portrait", "image"])
        || known("importance:", &IMPORTANCE)
        || known("kind:", &KINDS)
        || known("heading:", &HEADINGS)
        || key == "view:gallery"
        || key == "template:dossier"
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

/// The page template of a section, listed in its manifest and written as a template file.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTemplate {
    pub template_id: String,
    pub name: String,
    pub body: String,
}

/// Bytes of `.ambd/templates/<id>.json`, recomputable from the journal.
pub fn template_file_bytes(
    database_id: &str,
    template: &PlannedTemplate,
) -> Result<Vec<u8>, String> {
    json_bytes(&json!({
        "format": "amby-database-template",
        "formatVersion": 1,
        "databaseId": database_id,
        "templateId": template.template_id,
        "name": template.name,
        "body": template.body,
        "values": {},
    }))
}

pub struct PresetPlan {
    pub extras: NewDatabaseExtras,
    pub template: PlannedTemplate,
}

struct Shape {
    icon: &'static str,
    /// The Select the gallery groups by: `importance` or `kind`.
    group: &'static str,
    /// The files property that holds the picture.
    media: &'static str,
    headings: &'static [&'static str],
}

fn shape(preset: &str) -> Option<Shape> {
    Some(match preset {
        "characters" => Shape {
            icon: "users",
            group: "importance",
            media: "portrait",
            headings: &["basic", "traits", "appearance", "biography"],
        },
        "locations" => Shape {
            icon: "map-pin",
            group: "kind",
            media: "image",
            headings: &["description", "history"],
        },
        "organizations" => Shape {
            icon: "building-2",
            group: "importance",
            media: "image",
            headings: &["description", "history"],
        },
        "items" => Shape {
            icon: "package",
            group: "importance",
            media: "image",
            headings: &["description", "history"],
        },
        _ => return None,
    })
}

pub fn is_preset(key: &str) -> bool {
    shape(key).is_some()
}

/// Plans a preset for a database that does not exist yet.
pub fn plan(
    vault: &Path,
    preset: &str,
    section_name: &str,
    ids: &PlannedDatabaseIds,
    labels: &BTreeMap<String, String>,
) -> Result<PresetPlan, ProjectError> {
    let shape = shape(preset).ok_or_else(|| ProjectError::UnsupportedPreset {
        preset: preset.to_owned(),
    })?;
    let (group_key, options): (&str, Vec<String>) = if shape.group == "kind" {
        (
            "preset:kind",
            KINDS
                .iter()
                .map(|kind| label(labels, &format!("kind:{kind}")))
                .collect::<Result<_, _>>()?,
        )
    } else {
        (
            "preset:importance",
            IMPORTANCE
                .iter()
                .map(|key| label(labels, &format!("importance:{key}")))
                .collect::<Result<_, _>>()?,
        )
    };
    let group_name = label(labels, group_key)?;
    let media_name = label(labels, &format!("preset:{}", shape.media))?;
    ensure_distinct(&options)?;
    ensure_distinct(&[group_name.clone(), media_name.clone()])?;

    let mut builder = PropertyBuilder::new(vault, section_name, ids)?;
    let (group_property, group_ids) = builder.add("select", &group_name, &options, &|_| {})?;
    let (media_property, _) = builder.add("files", &media_name, &[], &|_| {})?;
    builder.validate()?;

    let template = PlannedTemplate {
        template_id: ulid::Ulid::generate().to_string(),
        name: label(labels, "template:dossier")?,
        body: shape
            .headings
            .iter()
            .map(|heading| {
                label(labels, &format!("heading:{heading}")).map(|name| format!("## {name}\n\n"))
            })
            .collect::<Result<Vec<_>, _>>()?
            .concat(),
    };
    let view = gallery_grouped_by(ids, &label(labels, "view:gallery")?, &group_ids.property_id);
    Ok(PresetPlan {
        extras: NewDatabaseExtras {
            properties: vec![group_property, media_property],
            view: Some(view),
            icon: Some(format!("amby-icon:{}:%2364748b", shape.icon)),
            template_id: Some(template.template_id.clone()),
        },
        template,
    })
}
