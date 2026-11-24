use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use super::{
    failed, ImportCandidate, ImportField, ImportMapping, ImportPreview, ImportSource,
    ImportSourceKind, ImportSourcePreview, ImportedField, ImportedNote, Registry,
};
use crate::database::{discovery, format::raw_revision, model::DatabasePropertySummary, summary};
use crate::durable::{guarded_path, relative_components};
use crate::frontmatter::{self, is_amby_id};
use crate::index::ensure_unique_identity;
use crate::project::model::{ProjectError, SectionState, WorkshopSummary};

const MAX_SOURCES: usize = 24;
const MAX_PREVIEW_NOTES: usize = 500;
const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EXAMPLE_CHARS: usize = 300;

fn invalid(cause: impl std::fmt::Display) -> ProjectError {
    failed("workshopImportInvalid", cause)
}

fn sql(cause: rusqlite::Error) -> ProjectError {
    failed("workshopImportRead", cause)
}

fn guarded(vault: &Path, path: &str) -> Result<PathBuf, ProjectError> {
    let parts = relative_components(path, "workshop import").map_err(invalid)?;
    if parts
        .iter()
        .any(|part| part.starts_with('.') || crate::vault::scan::is_service_directory(part))
    {
        return Err(invalid(
            "Import path starts with a service or hidden folder",
        ));
    }
    guarded_path(vault, path, "workshop import").map_err(invalid)
}

fn limited_text(vault: &Path, path: &str) -> Result<String, ProjectError> {
    let file = guarded(vault, path)?;
    let metadata = fs::metadata(&file).map_err(|error| failed("workshopImportRead", error))?;
    if !metadata.is_file() || metadata.len() > MAX_NOTE_BYTES {
        return Err(invalid("Source note is unavailable or too large"));
    }
    fs::read_to_string(file).map_err(|error| failed("workshopImportRead", error))
}

fn read_durable_note(conn: &Connection, vault: &Path, id: &str, path: &str) -> Option<String> {
    if !is_amby_id(id) || ensure_unique_identity(conn, id).is_err() {
        return None;
    }
    let text = limited_text(vault, path).ok()?;
    (frontmatter::parse_markdown(&text).note_id() == Some(id)).then_some(text)
}

fn field_kind(property_type: &str) -> Option<&str> {
    match property_type {
        "text" | "number" | "checkbox" | "date" | "url" | "select" | "multiSelect" | "status" => {
            Some(property_type)
        }
        _ => None,
    }
}

fn shorten(text: &str) -> String {
    text.chars().take(MAX_EXAMPLE_CHARS).collect()
}

fn database_fields(conn: &Connection, id: &str) -> Vec<ImportField> {
    summary::database_properties(conn, id)
        .into_iter()
        .filter_map(|property| {
            let value_type = field_kind(&property.property_type)?.to_owned();
            Some(ImportField {
                key: property.property_id,
                name: property.name,
                value_type,
                example: None,
            })
        })
        .collect()
}

fn folder_fields(text: &str) -> Vec<ImportField> {
    let Some(map) = frontmatter::frontmatter_yaml_mapping(text).ok().flatten() else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(key, value)| {
            let key = key.as_str()?;
            if key.trim().is_empty() || key == "id" || key.starts_with("amby-") {
                return None;
            }
            let kind = match value {
                serde_yaml::Value::String(_) => "text",
                serde_yaml::Value::Number(_) => "number",
                serde_yaml::Value::Bool(_) => "checkbox",
                _ => return None,
            };
            Some(ImportField {
                key: key.into(),
                name: key.into(),
                value_type: kind.into(),
                example: Some(shorten(&frontmatter::value_as_text(value))),
            })
        })
        .collect()
}

fn database_revision(conn: &Connection, vault: &Path, id: &str) -> Result<String, ProjectError> {
    let (path, indexed): (String, String) = conn
        .query_row(
            "SELECT container_path, manifest_revision FROM db_databases WHERE database_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(sql)?
        .ok_or_else(|| invalid("Database is missing"))?;
    let container = guarded(vault, &path)?;
    let manifest = discovery::find_manifest_path(&container)
        .ok_or_else(|| invalid("Database manifest is missing"))?;
    let relative =
        crate::durable::relative_string(vault, &manifest, "workshop import").map_err(invalid)?;
    let bytes = fs::read(guarded(vault, &relative)?)
        .map_err(|error| failed("workshopImportRead", error))?;
    let parsed = crate::database::format::parse_manifest(&bytes).map_err(invalid)?;
    let revision = raw_revision(&bytes);
    if parsed.value.database_id != id || revision != indexed {
        return Err(ProjectError::RevisionConflict {
            actual_revision: revision,
        });
    }
    Ok(revision)
}

type SourceRow = (String, String, String);

fn source_rows(
    conn: &Connection,
    vault: &Path,
    source: &ImportSource,
    limit: usize,
) -> Result<Vec<SourceRow>, ProjectError> {
    let (query, key) = match source.kind {
        ImportSourceKind::Database => (
            "SELECT n.id, n.path, n.title FROM notes n JOIN db_members m ON m.note_id = n.id
             WHERE m.database_id = ?1 ORDER BY n.path LIMIT ?2",
            source.source_id.clone(),
        ),
        ImportSourceKind::Folder => {
            let folder = guarded(vault, &source.source_id)?;
            if !folder.is_dir() {
                return Err(invalid("Source folder is missing"));
            }
            let inside_database: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM db_databases d WHERE ?1 = d.container_path
                 OR substr(?1, 1, length(d.container_path) + 1) = d.container_path || '/')",
                    [&source.source_id],
                    |row| row.get(0),
                )
                .map_err(sql)?;
            if inside_database {
                return Err(invalid("Choose this source as a database"));
            }
            (
                "SELECT n.id, n.path, n.title FROM notes n
                 WHERE substr(n.path, 1, length(?1)) = ?1
                 AND NOT EXISTS (
                   SELECT 1 FROM db_databases d
                   WHERE substr(n.path, 1, length(d.container_path) + 1) = d.container_path || '/'
                 )
                 ORDER BY n.path LIMIT ?2",
                format!("{}/", source.source_id),
            )
        }
    };
    let mut stmt = conn.prepare(query).map_err(sql)?;
    let rows = stmt
        .query_map((&key, limit), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(sql)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sql)
}

fn section_database<'a>(workshop: &'a WorkshopSummary, section: &str) -> Option<&'a str> {
    workshop
        .sections
        .iter()
        .find(|item| {
            item.id == section
                && item.state != SectionState::Missing
                && !matches!(item.role.as_str(), "stories" | "universes")
        })
        .map(|item| item.database_id.as_str())
}

fn display_db_value(value: &Value, property: &DatabasePropertySummary) -> Option<String> {
    match value {
        Value::String(text) => Some(shorten(text)),
        Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
        Value::Array(items) => {
            let strings = items
                .iter()
                .filter_map(|item| display_db_value(item, property))
                .collect::<Vec<_>>();
            (!strings.is_empty()).then(|| shorten(&strings.join(", ")))
        }
        Value::Object(object) => {
            if let Some(option_id) = object.get("optionId").and_then(Value::as_str) {
                return property
                    .options
                    .iter()
                    .find(|option| option.option_id == option_id)
                    .map(|option| option.name.clone());
            }
            object
                .get("value")
                .or_else(|| object.get("optionIds"))
                .and_then(|inner| display_db_value(inner, property))
        }
        _ => None,
    }
}

fn values_for_db(conn: &Connection, note_id: &str, database_id: &str) -> BTreeMap<String, String> {
    let Some(context) = summary::database_note_context(conn, 0, note_id)
        .ok()
        .flatten()
    else {
        return BTreeMap::new();
    };
    if context.database_id != database_id {
        return BTreeMap::new();
    }
    let values: Value = serde_json::from_str(&context.row.values_json).unwrap_or_default();
    context
        .properties
        .iter()
        .filter_map(|property| {
            Some((
                property.property_id.clone(),
                display_db_value(values.get(&property.property_id)?, property)?,
            ))
        })
        .collect()
}

pub(super) fn build(
    conn: &Connection,
    vault: &Path,
    workshop: &WorkshopSummary,
    registry: &Registry,
    registry_revision: &str,
    write_path: String,
    sources: &[ImportSource],
) -> Result<ImportPreview, ProjectError> {
    if sources.is_empty() || sources.len() > MAX_SOURCES {
        return Err(failed(
            "workshopImportLimit",
            "Choose between one and 24 sources",
        ));
    }
    let existing = registry
        .entries
        .iter()
        .map(|entry| (entry.section_id.as_str(), entry.note_id.as_str()))
        .collect::<BTreeSet<_>>();
    let mut input_versions = vec![registry_revision.to_owned(), workshop.file_revision.clone()];
    let mut previews = Vec::new();
    let mut remaining = MAX_PREVIEW_NOTES;
    for source in sources {
        let dest = section_database(workshop, &source.section_id)
            .ok_or_else(|| invalid("Choose a reference or notes section"))?;
        if source.kind == ImportSourceKind::Database && dest == source.source_id {
            return Err(invalid("Source and destination are the same database"));
        }
        input_versions.push(database_revision(conn, vault, dest)?);
        let db = (source.kind == ImportSourceKind::Database).then_some(source.source_id.as_str());
        if let Some(id) = db {
            input_versions.push(database_revision(conn, vault, id)?);
        }
        let target_fields = database_fields(conn, dest);
        let rows = source_rows(conn, vault, source, remaining + 1)?;
        if rows.len() > remaining {
            return Err(failed(
                "workshopImportLimit",
                "Preview is larger than 500 notes",
            ));
        }
        remaining -= rows.len();
        let mut source_fields: BTreeMap<_, _> = db
            .map(|id| {
                database_fields(conn, id)
                    .into_iter()
                    .map(|field| (field.key.clone(), field))
                    .collect()
            })
            .unwrap_or_default();
        let mut conflicts = BTreeSet::new();
        let mut candidates = Vec::new();
        for (id, path, title) in rows {
            let text = read_durable_note(conn, vault, &id, &path);
            if let Some(ref text) = text {
                input_versions.push(raw_revision(text.as_bytes()));
                if let Some(db_id) = db {
                    if source_fields.values().any(|field| field.example.is_none()) {
                        for (key, value) in values_for_db(conn, &id, db_id) {
                            if let Some(field) = source_fields.get_mut(&key) {
                                field.example.get_or_insert(value);
                            }
                        }
                    }
                } else {
                    for field in folder_fields(text) {
                        if let Some(other) = source_fields.get(&field.key) {
                            if other.value_type != field.value_type {
                                conflicts.insert(field.key);
                            }
                        } else {
                            source_fields.insert(field.key.clone(), field);
                        }
                    }
                }
            }
            candidates.push(ImportCandidate {
                already_linked: existing.contains(&(source.section_id.as_str(), id.as_str())),
                note_id: text.map(|_| id),
                path,
                title,
            });
        }
        let source_fields = source_fields
            .into_values()
            .filter(|field| !conflicts.contains(&field.key))
            .collect::<Vec<_>>();
        let suggested = target_fields
            .iter()
            .filter_map(|target| {
                let name = target.name.trim().to_lowercase();
                let matches = source_fields
                    .iter()
                    .filter(|field| {
                        field.value_type == target.value_type
                            && field.name.trim().to_lowercase() == name
                    })
                    .collect::<Vec<_>>();
                if let [field] = matches.as_slice() {
                    Some(ImportMapping {
                        source_key: field.key.clone(),
                        target_id: target.key.clone(),
                    })
                } else {
                    None
                }
            })
            .collect();
        previews.push(ImportSourcePreview {
            source: source.clone(),
            candidates,
            source_fields,
            target_fields,
            suggested,
        });
    }
    let input_bytes = serde_json::to_vec(&(input_versions, &previews))
        .map_err(|error| failed("workshopImportRead", error))?;
    Ok(ImportPreview {
        revision: raw_revision(&input_bytes),
        write_path,
        sources: previews,
    })
}

pub(super) fn resolve_entries(
    conn: &Connection,
    vault: &Path,
    workshop: &WorkshopSummary,
    registry: &Registry,
) -> Vec<ImportedNote> {
    let mut targets = BTreeMap::new();
    registry
        .entries
        .iter()
        .filter_map(|entry| {
            let dest = section_database(workshop, &entry.section_id)?;
            let current = conn
                .query_row(
                    "SELECT path, title FROM notes WHERE id = ?1",
                    [&entry.note_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .ok()
                .and_then(|(path, title)| {
                    read_durable_note(conn, vault, &entry.note_id, &path).map(|text| (text, title))
                });
            let fields = current
                .as_ref()
                .map(|(text, _)| {
                    let names = targets
                        .entry(dest)
                        .or_insert_with(|| database_fields(conn, dest));
                    let values = match &entry.database_id {
                        Some(id) => values_for_db(conn, &entry.note_id, id),
                        None => folder_fields(text)
                            .into_iter()
                            .filter_map(|field| Some((field.key, field.example?)))
                            .collect(),
                    };
                    entry
                        .mappings
                        .iter()
                        .filter_map(|mapping| {
                            let target =
                                names.iter().find(|field| field.key == mapping.target_id)?;
                            Some(ImportedField {
                                name: target.name.clone(),
                                value: values.get(&mapping.source_key)?.clone(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(ImportedNote {
                operation_id: entry.operation_id.clone(),
                section_id: entry.section_id.clone(),
                note_id: entry.note_id.clone(),
                title: current
                    .as_ref()
                    .map(|(_, title)| title)
                    .unwrap_or(&entry.title)
                    .clone(),
                available: current.is_some(),
                fields,
            })
        })
        .collect()
}
