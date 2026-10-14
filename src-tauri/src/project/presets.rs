//! Workshop section presets ("заготовки"): starting properties, views and templates
//! for workshop databases.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::model::ProjectError;
use super::names::normalize_title;
use super::props::{ensure_distinct, gallery_grouped_by, PropertyBuilder};
use crate::database::mutations::{
    default_table_view, json_bytes, NewDatabaseExtras, PlannedDatabaseIds,
};

const IMPORTANCE: [&str; 3] = ["main", "side", "episode"];
const KINDS: [&str; 4] = ["city", "district", "place", "nature"];
const ARC_KINDS: [&str; 3] = ["character", "plot", "mini"];
const TAGS: [&str; 3] = ["blue", "green", "red"];
const STATUSES: [&str; 3] = ["draft", "inProgress", "done"];

fn default_label(key: &str) -> &'static str {
    match key {
        "preset:stories" => "Истории",
        "preset:characters" => "Персонажи",
        "preset:locations" => "Локации",
        "preset:universes" => "Вселенные",
        "preset:arcs" => "Арки",
        "preset:anchors" => "Якоря",
        "preset:notes" => "Заметки",
        "preset:status" => "Статус",
        "preset:synopsis" => "Синопсис",
        "preset:description" => "Описание",
        "preset:importance" => "Значимость",
        "preset:kind" => "Тип",
        "preset:portrait" => "Портрет",
        "preset:image" => "Изображение",
        "preset:participants" => "Участники",
        "preset:tag" => "Метка",
        "status:draft" => "Черновик",
        "status:inProgress" => "В работе",
        "status:done" => "Готово",
        "importance:main" => "Главные",
        "importance:side" => "Второстепенные",
        "importance:episode" => "Эпизодические",
        "kind:city" => "Город",
        "kind:district" => "Район",
        "kind:place" => "Место",
        "kind:nature" => "Природа",
        "arcKind:character" => "Линия персонажа",
        "arcKind:plot" => "Сюжетная",
        "arcKind:mini" => "Мини-арка",
        "tag:blue" => "Синий",
        "tag:green" => "Зелёный",
        "tag:red" => "Красный",
        "heading:basic" => "Основное",
        "heading:traits" => "Характеристика",
        "heading:appearance" => "Внешность",
        "heading:biography" => "Биография",
        "heading:description" => "Описание",
        "heading:history" => "История",
        "view:gallery" => "Галерея",
        "view:table" => "Таблица",
        _ => "Досье",
    }
}

pub fn is_preset_label(key: &str) -> bool {
    let known = |prefix: &str, list: &[&str]| {
        key.strip_prefix(prefix)
            .is_some_and(|rest| list.contains(&rest))
    };
    known(
        "preset:",
        &[
            "stories",
            "characters",
            "locations",
            "universes",
            "arcs",
            "anchors",
            "notes",
            "status",
            "synopsis",
            "description",
            "importance",
            "kind",
            "portrait",
            "image",
            "participants",
            "tag",
        ],
    ) || known("importance:", &IMPORTANCE)
        || known("kind:", &KINDS)
        || known("arcKind:", &ARC_KINDS)
        || known("tag:", &TAGS)
        || known("status:", &STATUSES)
        || known(
            "heading:",
            &[
                "basic",
                "traits",
                "appearance",
                "biography",
                "description",
                "history",
            ],
        )
        || key == "view:gallery"
        || key == "view:table"
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
    pub template: Option<PlannedTemplate>,
}

/// Plans starting properties, view and template for a workshop section database.
pub fn plan(
    vault: &Path,
    role: &str,
    section_name: &str,
    ids: &PlannedDatabaseIds,
    labels: &BTreeMap<String, String>,
    target_databases: &BTreeMap<String, String>,
    pending_databases: &[String],
) -> Result<PresetPlan, ProjectError> {
    let mut builder =
        PropertyBuilder::new(vault, section_name, ids)?.with_pending_databases(pending_databases);
    let mut properties = Vec::new();
    let view;
    let mut template = None;
    let mut icon = None;

    match role {
        "stories" => {
            icon = Some("amby-icon:book-open:%2364748b".to_owned());
            let status_options = STATUSES
                .iter()
                .map(|key| label(labels, &format!("status:{key}")))
                .collect::<Result<Vec<_>, _>>()?;
            ensure_distinct(&status_options)?;
            let (status_prop, _) = builder.add(
                "status",
                &label(labels, "preset:status")?,
                &status_options,
                &|_| {},
            )?;
            let (synopsis_prop, _) =
                builder.add("text", &label(labels, "preset:synopsis")?, &[], &|_| {})?;
            properties.push(status_prop);
            properties.push(synopsis_prop);
            view = Some(default_table_view(ids));
        }
        "characters" => {
            icon = Some("amby-icon:users:%2364748b".to_owned());
            if let Some(stories_id) = target_databases.get("stories") {
                let (stories_prop, _) = builder.add(
                    "relation",
                    &label(labels, "preset:stories")?,
                    &[],
                    &|spec| {
                        spec.relation_target_database_id = Some(stories_id.clone());
                        spec.relation_two_way = Some(false);
                    },
                )?;
                properties.push(stories_prop);
            }
            let importance_options = IMPORTANCE
                .iter()
                .map(|key| label(labels, &format!("importance:{key}")))
                .collect::<Result<Vec<_>, _>>()?;
            ensure_distinct(&importance_options)?;
            let (importance_prop, importance_ids) = builder.add(
                "select",
                &label(labels, "preset:importance")?,
                &importance_options,
                &|_| {},
            )?;
            let (portrait_prop, _) =
                builder.add("files", &label(labels, "preset:portrait")?, &[], &|_| {})?;
            properties.push(importance_prop);
            properties.push(portrait_prop);

            let tmpl = PlannedTemplate {
                template_id: ulid::Ulid::generate().to_string(),
                name: label(labels, "template:dossier")?,
                body: ["basic", "traits", "appearance", "biography"]
                    .iter()
                    .map(|h| {
                        label(labels, &format!("heading:{h}")).map(|name| format!("## {name}\n\n"))
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .concat(),
            };
            view = Some(gallery_grouped_by(
                ids,
                &label(labels, "view:gallery")?,
                &importance_ids.property_id,
            ));
            template = Some(tmpl);
        }
        "locations" => {
            icon = Some("amby-icon:map-pin:%2364748b".to_owned());
            if let Some(stories_id) = target_databases.get("stories") {
                let (stories_prop, _) = builder.add(
                    "relation",
                    &label(labels, "preset:stories")?,
                    &[],
                    &|spec| {
                        spec.relation_target_database_id = Some(stories_id.clone());
                        spec.relation_two_way = Some(false);
                    },
                )?;
                properties.push(stories_prop);
            }
            let kind_options = KINDS
                .iter()
                .map(|key| label(labels, &format!("kind:{key}")))
                .collect::<Result<Vec<_>, _>>()?;
            ensure_distinct(&kind_options)?;
            let (kind_prop, kind_ids) = builder.add(
                "select",
                &label(labels, "preset:kind")?,
                &kind_options,
                &|_| {},
            )?;
            let (image_prop, _) =
                builder.add("files", &label(labels, "preset:image")?, &[], &|_| {})?;
            properties.push(kind_prop);
            properties.push(image_prop);

            let tmpl = PlannedTemplate {
                template_id: ulid::Ulid::generate().to_string(),
                name: label(labels, "template:dossier")?,
                body: ["description", "history"]
                    .iter()
                    .map(|h| {
                        label(labels, &format!("heading:{h}")).map(|name| format!("## {name}\n\n"))
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .concat(),
            };
            view = Some(gallery_grouped_by(
                ids,
                &label(labels, "view:gallery")?,
                &kind_ids.property_id,
            ));
            template = Some(tmpl);
        }
        "universes" => {
            icon = Some("amby-icon:globe:%2364748b".to_owned());
            let (desc_prop, _) =
                builder.add("text", &label(labels, "preset:description")?, &[], &|_| {})?;
            let (image_prop, _) =
                builder.add("files", &label(labels, "preset:image")?, &[], &|_| {})?;
            properties.push(desc_prop);
            properties.push(image_prop);
            view = Some(default_table_view(ids));
        }
        "arcs" => {
            icon = Some("amby-icon:git-branch:%2364748b".to_owned());
            if let Some(stories_id) = target_databases.get("stories") {
                let (stories_prop, _) = builder.add(
                    "relation",
                    &label(labels, "preset:stories")?,
                    &[],
                    &|spec| {
                        spec.relation_target_database_id = Some(stories_id.clone());
                        spec.relation_two_way = Some(false);
                    },
                )?;
                properties.push(stories_prop);
            }
            if let Some(chars_id) = target_databases.get("characters") {
                let (chars_prop, _) = builder.add(
                    "relation",
                    &label(labels, "preset:characters")?,
                    &[],
                    &|spec| {
                        spec.relation_target_database_id = Some(chars_id.clone());
                        spec.relation_two_way = Some(false);
                    },
                )?;
                properties.push(chars_prop);
            }
            let arc_kinds = ARC_KINDS
                .iter()
                .map(|key| label(labels, &format!("arcKind:{key}")))
                .collect::<Result<Vec<_>, _>>()?;
            ensure_distinct(&arc_kinds)?;
            let (kind_prop, _) = builder.add(
                "select",
                &label(labels, "preset:kind")?,
                &arc_kinds,
                &|_| {},
            )?;
            let status_options = STATUSES
                .iter()
                .map(|key| label(labels, &format!("status:{key}")))
                .collect::<Result<Vec<_>, _>>()?;
            ensure_distinct(&status_options)?;
            let (status_prop, _) = builder.add(
                "status",
                &label(labels, "preset:status")?,
                &status_options,
                &|_| {},
            )?;
            properties.push(kind_prop);
            properties.push(status_prop);
            view = Some(default_table_view(ids));
        }
        "anchors" => {
            icon = Some("amby-icon:anchor:%2364748b".to_owned());
            if let Some(stories_id) = target_databases.get("stories") {
                let (stories_prop, _) = builder.add(
                    "relation",
                    &label(labels, "preset:stories")?,
                    &[],
                    &|spec| {
                        spec.relation_target_database_id = Some(stories_id.clone());
                        spec.relation_two_way = Some(false);
                    },
                )?;
                properties.push(stories_prop);
            }
            if let Some(chars_id) = target_databases.get("characters") {
                let (chars_prop, _) = builder.add(
                    "relation",
                    &label(labels, "preset:participants")?,
                    &[],
                    &|spec| {
                        spec.relation_target_database_id = Some(chars_id.clone());
                        spec.relation_two_way = Some(false);
                    },
                )?;
                properties.push(chars_prop);
            }
            if let Some(arcs_id) = target_databases.get("arcs") {
                let (arcs_prop, _) =
                    builder.add("relation", &label(labels, "preset:arcs")?, &[], &|spec| {
                        spec.relation_target_database_id = Some(arcs_id.clone());
                        spec.relation_two_way = Some(false);
                    })?;
                properties.push(arcs_prop);
            }
            let (desc_prop, _) =
                builder.add("text", &label(labels, "preset:description")?, &[], &|_| {})?;
            properties.push(desc_prop);
            view = Some(default_table_view(ids));
        }
        "notes" => {
            icon = Some("amby-icon:file-text:%2364748b".to_owned());
            if let Some(stories_id) = target_databases.get("stories") {
                let (stories_prop, _) = builder.add(
                    "relation",
                    &label(labels, "preset:stories")?,
                    &[],
                    &|spec| {
                        spec.relation_target_database_id = Some(stories_id.clone());
                        spec.relation_two_way = Some(false);
                    },
                )?;
                properties.push(stories_prop);
            }
            view = Some(default_table_view(ids));
        }
        _ => {
            view = Some(default_table_view(ids));
        }
    }

    builder.validate()?;

    Ok(PresetPlan {
        extras: NewDatabaseExtras {
            properties,
            view,
            icon,
            template_id: template.as_ref().map(|t| t.template_id.clone()),
        },
        template,
    })
}
