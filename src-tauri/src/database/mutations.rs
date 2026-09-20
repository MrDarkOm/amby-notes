//! Database creation and durable, conflict-aware metadata/schema/value mutations.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::format::{
    parse_manifest, parse_template, prepare_json, PropertyDefinition, PropertyValue,
};
use super::format::{raw_revision, MAX_JSON_BYTES};
use super::validation::validate_manifest;
use crate::bundle::{ensure_bundle_path, rollback_bundle_promotion};
use crate::frontmatter::{self, AtomicCreateError};
use crate::watcher::{self, WatcherState};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseCreateMode {
    Standalone,
    Attached,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseRequest {
    pub expected_generation: u64,
    pub mode: DatabaseCreateMode,
    pub parent_path: Option<String>,
    pub note_path: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabase {
    pub database_id: String,
    pub title: String,
    pub manifest_revision: String,
    pub view_id: String,
    pub view_revision: String,
    pub manifest_path: String,
    pub view_path: String,
    pub note_path: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseValueMutation {
    pub note_id: String,
    pub property_id: String,
    pub value_json: Option<String>,
    pub expected_revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseValueBatchRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub operation_id: String,
    pub cells: Vec<DatabaseValueMutation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseNoteRevision {
    pub note_id: String,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseValueBatchResult {
    pub operation_id: String,
    pub database_id: String,
    pub revisions: Vec<DatabaseNoteRevision>,
    pub warnings: Vec<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchRecoveryStep {
    record_path: String,
    backup_path: String,
    original_revision: String,
    target_revision: String,
    status: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchRecoveryJournal {
    format: String,
    format_version: u64,
    operation_id: String,
    database_id: String,
    request_revision: String,
    status: String,
    steps: Vec<BatchRecoveryStep>,
    result: Option<DatabaseValueBatchResult>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabasePropertyRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub expected_manifest_revision: String,
    pub name: String,
    pub property_type: String,
    pub before_property_id: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub formula_expression: Option<String>,
    #[serde(default)]
    pub relation_target_database_id: Option<String>,
    #[serde(default)]
    pub relation_max_items: Option<u8>,
    #[serde(default)]
    pub relation_two_way: Option<bool>,
    #[serde(default)]
    pub relation_inverse_property_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameDatabaseRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub expected_manifest_revision: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenamedDatabase {
    pub database_id: String,
    pub title: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabaseProperty {
    pub database_id: String,
    pub property_id: String,
    pub name: String,
    pub property_type: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameDatabasePropertyRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenamedDatabaseProperty {
    pub database_id: String,
    pub property_id: String,
    pub name: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDatabasePropertyTypeRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
    pub property_type: String,
    #[serde(default)]
    pub relation_target_database_id: Option<String>,
    #[serde(default)]
    pub relation_max_items: Option<u8>,
    #[serde(default)]
    pub relation_two_way: Option<bool>,
    #[serde(default)]
    pub relation_inverse_property_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseRelationValueRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub note_id: String,
    pub property_id: String,
    pub target_note_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseRelationValueResult {
    pub database_id: String,
    pub note_id: String,
    pub target_note_ids: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDatabasePropertyType {
    pub database_id: String,
    pub property_id: String,
    pub property_type: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDatabasePropertyRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedDatabaseProperty {
    pub database_id: String,
    pub property_id: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderDatabasePropertiesRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub expected_manifest_revision: String,
    pub property_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderedDatabaseProperties {
    pub database_id: String,
    pub property_ids: Vec<String>,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

pub fn create_database(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabaseRequest,
) -> Result<CreatedDatabase, String> {
    let name = request.name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("Invalid database name".to_owned());
    }

    let mut promoted_from: Option<(PathBuf, PathBuf)> = None;
    let mut created_note_path: Option<String> = None;
    let container = match request.mode {
        DatabaseCreateMode::Standalone => {
            let parent = request
                .parent_path
                .as_deref()
                .ok_or("Standalone database requires a parent path")?;
            let parent = Path::new(parent);
            if !parent.is_dir() {
                return Err(format!(
                    "Database parent is not a directory: {}",
                    parent.display()
                ));
            }
            parent.join(name)
        }
        DatabaseCreateMode::Attached => {
            let note_path = request
                .note_path
                .as_deref()
                .ok_or("Attached database requires a note path")?;
            let note_path = Path::new(note_path);
            let original = note_path.to_path_buf();
            let (main_note, _) = ensure_bundle_path(note_path)?;
            if main_note != original {
                promoted_from = Some((original, main_note.clone()));
            }
            created_note_path = Some(main_note.to_string_lossy().to_string());
            main_note
                .parent()
                .ok_or("Attached note has no bundle parent")?
                .to_path_buf()
        }
    };
    if !container.starts_with(vault) {
        return Err("Database container escapes vault".to_owned());
    }
    if !container.exists() {
        fs::create_dir(&container).map_err(|error| error.to_string())?;
    }
    let database_id = ulid::Ulid::generate().to_string();
    let view_id = ulid::Ulid::generate().to_string();
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    if manifest_path.exists() || container.join("ambd.json").exists() {
        rollback_promotion(promoted_from.as_ref())?;
        return Err(format!(
            "Database manifest already exists: {}",
            manifest_path.display()
        ));
    }

    let container_kind = match request.mode {
        DatabaseCreateMode::Standalone => "standalone",
        DatabaseCreateMode::Attached => "attached",
    };
    let view = json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": database_id,
        "viewId": view_id,
        "name": "Table",
        "layout": "table",
        "openMode": "sidePeek",
        "subitemsMode": "nested",
        "density": "default",
        "fields": [{"field": {"kind": "system", "field": "title"}, "visible": true, "width": null, "frozen": true}],
        "filter": null,
        "sorts": [{"field": {"kind": "system", "field": "title"}, "direction": "asc", "nulls": "last"}],
        "group": null,
        "manualOrder": [],
        "aggregates": [],
        "layoutConfig": {},
    });
    let manifest = json!({
        "format": "amby-database",
        "formatVersion": 1,
        "containerKind": container_kind,
        "databaseId": database_id,
        "name": name,
        "icon": null,
        "cover": null,
        "locked": false,
        "membership": {"kind": "filesystem-descendants", "recursive": true},
        "properties": [],
        "viewOrder": [view_id],
        "defaultViewId": view_id,
        "templateOrder": [],
        "defaultTemplateId": null,
        "views": [view],
    });
    let manifest_bytes = json_bytes(&manifest)?;
    let prepared = watcher.prepare_write([(
        &manifest_path,
        watcher::fingerprint_for_bytes(&manifest_bytes),
    )]);
    if let Err(error) = write_new(&manifest_path, &manifest_bytes) {
        watcher.cancel_prepared_write(&prepared);
        rollback_promotion(promoted_from.as_ref())?;
        return Err(error);
    }
    watcher.confirm_prepared_write(&prepared);

    Ok(CreatedDatabase {
        database_id,
        title: name.to_owned(),
        manifest_revision: raw_revision(&manifest_bytes),
        view_id,
        view_revision: raw_revision(&manifest_bytes),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        view_path: manifest_path.to_string_lossy().to_string(),
        note_path: created_note_path,
        warnings: Vec::new(),
    })
}

pub fn create_database_property(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabasePropertyRequest,
) -> Result<CreatedDatabaseProperty, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Property name is required".to_owned());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }
    if parsed.value.properties.iter().any(|property| {
        serde_json::to_value(property)
            .ok()
            .and_then(|value| {
                value
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .is_some_and(|existing| existing.trim().eq_ignore_ascii_case(name))
    }) {
        return Err("A property with this name already exists".to_owned());
    }

    let property_id = ulid::Ulid::generate().to_string();
    let config = match request.property_type.as_str() {
        "text" => json!({"multiline": false}),
        "number" => json!({"format": "number", "currency": null}),
        "checkbox" | "url" => json!({}),
        "date" => json!({"includeTime": false, "allowRange": false}),
        "select" | "multiSelect" | "status" => {
            let mut names = std::collections::HashSet::new();
            let options = request
                .options
                .iter()
                .map(|name| name.trim())
                .filter(|name| !name.is_empty())
                .filter(|name| names.insert(name.to_lowercase()))
                .map(|name| {
                    json!({
                        "id": ulid::Ulid::generate().to_string(),
                        "name": name,
                        "color": "#94a3b8",
                    })
                })
                .collect::<Vec<_>>();
            json!({"options": options})
        }
        "formula" => json!({
            "version": 1,
            "expression": request
                .formula_expression
                .as_deref()
                .unwrap_or("0")
                .trim(),
            "resultType": null,
            "dependencies": [],
        }),
        "relation" => {
            let target_database_id = request
                .relation_target_database_id
                .as_deref()
                .or_else(|| {
                    request
                        .options
                        .first()
                        .filter(|id| !id.trim().is_empty())
                        .map(String::as_str)
                })
                .unwrap_or(&request.database_id);
            find_database_container(vault, target_database_id)?;
            let max_items = request.relation_max_items.filter(|&limit| limit == 1);
            let two_way = request.relation_two_way.unwrap_or(false);
            let inverse_property_id = if two_way {
                Some(ulid::Ulid::generate().to_string())
            } else {
                None
            };
            json!({
                "targetDatabaseId": target_database_id,
                "maxItems": max_items,
                "inversePropertyId": inverse_property_id,
            })
        }
        // Rollups need a relation and target property at creation time. The
        // generic create dialog does not have enough information to produce a
        // valid portable config, so they are created through a future config
        // editor rather than emitting an invalid shard.
        "rollup" => return Err("Rollup requires a relation and target property".to_owned()),
        _ => return Err("Unsupported property type".to_owned()),
    };
    let property: PropertyDefinition = serde_json::from_value(json!({
        "type": request.property_type,
        "id": property_id,
        "name": name,
        "pageVisibility": "alwaysShow",
        "yamlBinding": null,
        "config": config,
    }))
    .map_err(|error| error.to_string())?;
    let mut manifest = parsed.value.clone();

    // If two-way relation is requested, create the reciprocal property
    if request.property_type == "relation" && request.relation_two_way == Some(true) {
        let target_database_id = config
            .get("targetDatabaseId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&request.database_id);
        let inv_id = config
            .get("inversePropertyId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Failed to generate inverse property ID".to_owned())?;

        if target_database_id == request.database_id {
            let inv_name = request
                .relation_inverse_property_name
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Обратная связь");
            let self_inv_prop: PropertyDefinition = serde_json::from_value(json!({
                "type": "relation",
                "id": inv_id,
                "name": inv_name,
                "pageVisibility": "alwaysShow",
                "yamlBinding": null,
                "config": {
                    "targetDatabaseId": request.database_id,
                    "maxItems": null,
                    "inversePropertyId": property_id,
                },
            }))
            .map_err(|error| error.to_string())?;
            manifest.properties.push(self_inv_prop);
        } else {
            let target_container = find_database_container(vault, target_database_id)?;
            let target_manifest_path =
                super::discovery::manifest_path_for_container(&target_container);
            let target_original =
                fs::read(&target_manifest_path).map_err(|error| error.to_string())?;
            let target_parsed =
                parse_manifest(&target_original).map_err(|error| error.to_string())?;
            if target_parsed.value.locked {
                return Err("Target database is locked".to_owned());
            }
            let inv_name = request
                .relation_inverse_property_name
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&parsed.value.name);
            let target_inv_prop: PropertyDefinition = serde_json::from_value(json!({
                "type": "relation",
                "id": inv_id,
                "name": inv_name,
                "pageVisibility": "alwaysShow",
                "yamlBinding": null,
                "config": {
                    "targetDatabaseId": request.database_id,
                    "maxItems": null,
                    "inversePropertyId": property_id,
                },
            }))
            .map_err(|error| error.to_string())?;

            let mut target_manifest = target_parsed.value.clone();
            target_manifest.properties.push(target_inv_prop);
            let target_report = validate_manifest(&target_manifest);
            if !target_report.errors.is_empty() {
                return Err("Inverse property would make target manifest invalid".to_owned());
            }
            let target_prepared = prepare_json(&target_parsed, &target_manifest)
                .map_err(|error| error.to_string())?;
            crate::history::snapshot_before_write(
                vault,
                &target_manifest_path,
                &target_prepared.bytes,
                "database-schema",
            )?;
            let target_write = watcher.prepare_write([(
                &target_manifest_path,
                watcher::fingerprint_for_bytes(&target_prepared.bytes),
            )]);
            if let Err(error) =
                frontmatter::atomic_write_bytes(&target_manifest_path, &target_prepared.bytes)
            {
                watcher.cancel_prepared_write(&target_write);
                return Err(error);
            }
            watcher.confirm_prepared_write(&target_write);
        }
    }

    if let Some(before_property_id) = request.before_property_id.as_deref() {
        let index = manifest
            .properties
            .iter()
            .position(|candidate| candidate.id() == Some(before_property_id))
            .ok_or_else(|| "Insert position property was not found".to_owned())?;
        manifest.properties.insert(index, property);
    } else {
        manifest.properties.push(property);
    }
    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    let current = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    if raw_revision(&current) != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    crate::history::snapshot_before_write(
        vault,
        &manifest_path,
        &prepared.bytes,
        "database-schema",
    )?;
    let write = watcher.prepare_write([(
        &manifest_path,
        watcher::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &prepared.bytes) {
        watcher.cancel_prepared_write(&write);
        return Err(error);
    }
    watcher.confirm_prepared_write(&write);
    Ok(CreatedDatabaseProperty {
        database_id: request.database_id.clone(),
        property_id,
        name: name.to_owned(),
        property_type: request.property_type.clone(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

fn default_property_config(
    property_type: &str,
    database_id: &str,
    relation_target_database_id: Option<&str>,
    relation_max_items: Option<u8>,
    relation_inverse_property_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    match property_type {
        "text" => Ok(json!({"multiline": false})),
        "number" => Ok(json!({"format": "number", "currency": null})),
        "checkbox" | "url" => Ok(json!({})),
        "date" => Ok(json!({"includeTime": false, "allowRange": false})),
        "select" | "multiSelect" | "status" => Ok(json!({"options": []})),
        "formula" => Ok(json!({
            "version": 1,
            "expression": "0",
            "resultType": null,
            "dependencies": [],
        })),
        "relation" => Ok(json!({
            "targetDatabaseId": relation_target_database_id.unwrap_or(database_id),
            "maxItems": relation_max_items.filter(|&limit| limit == 1),
            "inversePropertyId": relation_inverse_property_id,
        })),
        _ => Err("Unsupported property type".to_owned()),
    }
}

fn ensure_property_has_no_durable_values(
    container: &Path,
    property: &PropertyDefinition,
) -> Result<(), String> {
    let property_id = property.id().unwrap_or_default();
    let prop_name = property.name();
    let prop_key = property.frontmatter_key();

    for entry in walkdir::WalkDir::new(container)
        .min_depth(1)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|ext| ext.to_str()) != Some("md")
        {
            continue;
        }
        if let Ok(content) = fs::read_to_string(entry.path()) {
            if let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&content) {
                let has_prop = mapping.iter().any(|(k, _)| {
                    if let serde_yaml::Value::String(k_str) = k {
                        let k_trim = k_str.trim();
                        k_trim.eq_ignore_ascii_case(property_id)
                            || prop_name.is_some_and(|pn| k_trim.eq_ignore_ascii_case(pn))
                            || prop_key.is_some_and(|pk| k_trim.eq_ignore_ascii_case(pk))
                    } else {
                        false
                    }
                });
                if has_prop {
                    return Err(
                        "Property type can only be changed after its existing values are cleared"
                            .to_owned(),
                    );
                }
            }
        }
    }

    let records_dir = container.join(".ambd/records");
    if records_dir.exists() {
        for entry in fs::read_dir(&records_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let parsed = super::format::parse_record(
                &fs::read(entry.path()).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            if !parsed.is_writable() {
                return Err("A record is read-only; property type was not changed".to_owned());
            }
            if parsed.value.values.contains_key(property_id)
                || parsed.value.yaml_sync_bases.contains_key(property_id)
            {
                return Err(
                    "Property type can only be changed after its existing values are cleared"
                        .to_owned(),
                );
            }
        }
    }

    let templates_dir = container.join(".ambd/templates");
    if templates_dir.exists() {
        for entry in fs::read_dir(&templates_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let parsed =
                parse_template(&fs::read(entry.path()).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            if !parsed.is_writable() {
                return Err("A template is read-only; property type was not changed".to_owned());
            }
            if parsed.value.values.contains_key(property_id) {
                return Err(
                    "Property type can only be changed after its template values are cleared"
                        .to_owned(),
                );
            }
        }
    }
    Ok(())
}

pub fn change_database_property_type(
    vault: &Path,
    watcher: &WatcherState,
    request: &ChangeDatabasePropertyTypeRequest,
) -> Result<ChangedDatabasePropertyType, String> {
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if !parsed.is_writable() {
        return Err("Database manifest is read-only".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }

    let Some(index) = parsed
        .value
        .properties
        .iter()
        .position(|property| property.id() == Some(request.property_id.as_str()))
    else {
        return Err("Property was not found".to_owned());
    };
    let current_property = &parsed.value.properties[index];
    let configuring_relation =
        current_property.kind() == "relation" && request.property_type == "relation";

    if current_property.kind() == request.property_type && !configuring_relation {
        return Ok(ChangedDatabasePropertyType {
            database_id: request.database_id.clone(),
            property_id: request.property_id.clone(),
            property_type: request.property_type.clone(),
            manifest_revision: parsed.revision,
            warnings: Vec::new(),
        });
    }

    let mut target_db_id = request
        .relation_target_database_id
        .as_deref()
        .unwrap_or(&request.database_id);
    let mut max_items = request.relation_max_items.filter(|&limit| limit == 1);
    let mut inverse_prop_id = None;

    if configuring_relation {
        let current_rel_config = match current_property {
            PropertyDefinition::Relation(fields) => Some(&fields.config),
            _ => None,
        };
        target_db_id = request
            .relation_target_database_id
            .as_deref()
            .or_else(|| current_rel_config.map(|c| c.target_database_id.as_str()))
            .unwrap_or(&request.database_id);
        find_database_container(vault, target_db_id)?;

        if request.relation_max_items.is_some() {
            max_items = request.relation_max_items.filter(|&limit| limit == 1);
        } else {
            max_items = current_rel_config.and_then(|c| c.max_items);
        }

        inverse_prop_id = current_rel_config.and_then(|c| c.inverse_property_id.clone());

        if request.relation_two_way == Some(true) {
            if inverse_prop_id.is_none() {
                let new_inv_id = ulid::Ulid::generate().to_string();
                if target_db_id == request.database_id {
                    let inv_name = request
                        .relation_inverse_property_name
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or("Обратная связь");
                    let self_inv_prop: PropertyDefinition = serde_json::from_value(json!({
                        "type": "relation",
                        "id": new_inv_id,
                        "name": inv_name,
                        "pageVisibility": "alwaysShow",
                        "yamlBinding": null,
                        "config": {
                            "targetDatabaseId": request.database_id,
                            "maxItems": null,
                            "inversePropertyId": request.property_id,
                        },
                    }))
                    .map_err(|error| error.to_string())?;
                    let mut extra_manifest = parsed.value.clone();
                    extra_manifest.properties.push(self_inv_prop);
                } else {
                    let target_container = find_database_container(vault, target_db_id)?;
                    let target_manifest_path =
                        super::discovery::manifest_path_for_container(&target_container);
                    let target_original =
                        fs::read(&target_manifest_path).map_err(|error| error.to_string())?;
                    let target_parsed =
                        parse_manifest(&target_original).map_err(|error| error.to_string())?;
                    if target_parsed.value.locked {
                        return Err("Target database is locked".to_owned());
                    }
                    let inv_name = request
                        .relation_inverse_property_name
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or(&parsed.value.name);
                    let target_inv_prop: PropertyDefinition = serde_json::from_value(json!({
                        "type": "relation",
                        "id": new_inv_id,
                        "name": inv_name,
                        "pageVisibility": "alwaysShow",
                        "yamlBinding": null,
                        "config": {
                            "targetDatabaseId": request.database_id,
                            "maxItems": null,
                            "inversePropertyId": request.property_id,
                        },
                    }))
                    .map_err(|error| error.to_string())?;

                    let mut target_manifest = target_parsed.value.clone();
                    target_manifest.properties.push(target_inv_prop);
                    let target_prepared = prepare_json(&target_parsed, &target_manifest)
                        .map_err(|error| error.to_string())?;
                    crate::history::snapshot_before_write(
                        vault,
                        &target_manifest_path,
                        &target_prepared.bytes,
                        "database-schema",
                    )?;
                    let target_write = watcher.prepare_write([(
                        &target_manifest_path,
                        watcher::fingerprint_for_bytes(&target_prepared.bytes),
                    )]);
                    if let Err(error) = frontmatter::atomic_write_bytes(
                        &target_manifest_path,
                        &target_prepared.bytes,
                    ) {
                        watcher.cancel_prepared_write(&target_write);
                        return Err(error);
                    }
                    watcher.confirm_prepared_write(&target_write);
                }
                inverse_prop_id = Some(new_inv_id);
            }
        } else if request.relation_two_way == Some(false) {
            inverse_prop_id = None;
        }
    } else if request.property_type == "relation" {
        find_database_container(vault, target_db_id)?;
    }

    let config = default_property_config(
        &request.property_type,
        &request.database_id,
        Some(target_db_id),
        max_items,
        inverse_prop_id.as_deref(),
    )?;

    if current_property.yaml_binding().is_some() {
        return Err("Remove the YAML binding before changing the property type".to_owned());
    }
    for property in &parsed.value.properties {
        let referenced = match property {
            PropertyDefinition::Formula(fields) => fields
                .config
                .dependencies
                .iter()
                .any(|dependency| dependency == &request.property_id),
            PropertyDefinition::Rollup(fields) => {
                fields.config.relation_property_id == request.property_id
                    || fields.config.target_property_id == request.property_id
            }
            _ => false,
        };
        if referenced {
            return Err(
                "Property type cannot be changed while another property depends on it".to_owned(),
            );
        }
    }

    if !configuring_relation {
        ensure_property_has_no_durable_values(&container, current_property)?;
    }

    let mut replacement =
        serde_json::to_value(current_property).map_err(|error| error.to_string())?;
    let object = replacement
        .as_object_mut()
        .ok_or_else(|| "Property definition is not editable".to_owned())?;
    object.insert(
        "type".to_owned(),
        serde_json::Value::String(request.property_type.clone()),
    );
    object.insert("config".to_owned(), config);
    let replacement = serde_json::from_value::<PropertyDefinition>(replacement)
        .map_err(|error| error.to_string())?;

    let mut manifest = parsed.value.clone();
    manifest.properties[index] = replacement;
    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property type change would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    let current = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    if raw_revision(&current) != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    crate::history::snapshot_before_write(
        vault,
        &manifest_path,
        &prepared.bytes,
        "database-schema",
    )?;
    let write = watcher.prepare_write([(
        &manifest_path,
        watcher::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &prepared.bytes) {
        watcher.cancel_prepared_write(&write);
        return Err(error);
    }
    watcher.confirm_prepared_write(&write);
    Ok(ChangedDatabasePropertyType {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        property_type: request.property_type.clone(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

pub fn delete_database_property(
    vault: &Path,
    watcher: &WatcherState,
    request: &DeleteDatabasePropertyRequest,
) -> Result<DeletedDatabaseProperty, String> {
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }
    let mut manifest = parsed.value.clone();
    let Some(index) = manifest
        .properties
        .iter()
        .position(|property| property.id() == Some(request.property_id.as_str()))
    else {
        return Err("Property was not found".to_owned());
    };
    manifest.properties.remove(index);
    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property deletion would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    let current = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    if raw_revision(&current) != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    crate::history::snapshot_before_write(
        vault,
        &manifest_path,
        &prepared.bytes,
        "database-schema",
    )?;
    let write = watcher.prepare_write([(
        &manifest_path,
        watcher::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &prepared.bytes) {
        watcher.cancel_prepared_write(&write);
        return Err(error);
    }
    watcher.confirm_prepared_write(&write);
    Ok(DeletedDatabaseProperty {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

pub fn reorder_database_properties(
    vault: &Path,
    watcher: &WatcherState,
    request: &ReorderDatabasePropertiesRequest,
) -> Result<ReorderedDatabaseProperties, String> {
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }
    let known_ids = parsed
        .value
        .properties
        .iter()
        .filter_map(|property| property.id().map(str::to_owned))
        .collect::<Vec<_>>();
    let requested = request
        .property_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    if request.property_ids.len() != known_ids.len()
        || requested.len() != request.property_ids.len()
        || known_ids.iter().any(|id| !requested.contains(id))
    {
        return Err("Property order must contain every editable property exactly once".to_owned());
    }
    if request.property_ids == known_ids {
        return Ok(ReorderedDatabaseProperties {
            database_id: request.database_id.clone(),
            property_ids: request.property_ids.clone(),
            manifest_revision: parsed.revision,
            warnings: Vec::new(),
        });
    }
    let mut by_id = parsed
        .value
        .properties
        .iter()
        .filter_map(|property| property.id().map(|id| (id.to_owned(), property.clone())))
        .collect::<std::collections::HashMap<_, _>>();
    let mut ordered = request.property_ids.iter();
    let mut manifest = parsed.value.clone();
    for property in &mut manifest.properties {
        if property.id().is_none() {
            continue;
        }
        let id = ordered
            .next()
            .ok_or_else(|| "Property order ended unexpectedly".to_owned())?;
        *property = by_id
            .remove(id)
            .ok_or_else(|| "Property order references a missing property".to_owned())?;
    }
    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property reorder would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    let current = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    if raw_revision(&current) != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    crate::history::snapshot_before_write(
        vault,
        &manifest_path,
        &prepared.bytes,
        "database-schema",
    )?;
    let write = watcher.prepare_write([(
        &manifest_path,
        watcher::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &prepared.bytes) {
        watcher.cancel_prepared_write(&write);
        return Err(error);
    }
    watcher.confirm_prepared_write(&write);
    Ok(ReorderedDatabaseProperties {
        database_id: request.database_id.clone(),
        property_ids: request.property_ids.clone(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

pub fn rename_database_property(
    vault: &Path,
    watcher: &WatcherState,
    request: &RenameDatabasePropertyRequest,
) -> Result<RenamedDatabaseProperty, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Property name is required".to_owned());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }

    let duplicate = parsed.value.properties.iter().any(|property| {
        if property.id() == Some(request.property_id.as_str()) {
            return false;
        }
        serde_json::to_value(property)
            .ok()
            .and_then(|value| {
                value
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .is_some_and(|existing| existing.trim().eq_ignore_ascii_case(name))
    });
    if duplicate {
        return Err("A property with this name already exists".to_owned());
    }

    let mut manifest = parsed.value.clone();
    let mut renamed = false;
    for property in &mut manifest.properties {
        let matches = match property {
            PropertyDefinition::Text(fields) => fields.id == request.property_id,
            PropertyDefinition::Number(fields) => fields.id == request.property_id,
            PropertyDefinition::Checkbox(fields) => fields.id == request.property_id,
            PropertyDefinition::Date(fields) => fields.id == request.property_id,
            PropertyDefinition::Select(fields) => fields.id == request.property_id,
            PropertyDefinition::MultiSelect(fields) => fields.id == request.property_id,
            PropertyDefinition::Status(fields) => fields.id == request.property_id,
            PropertyDefinition::Url(fields) => fields.id == request.property_id,
            PropertyDefinition::Files(fields) => fields.id == request.property_id,
            PropertyDefinition::Relation(fields) => fields.id == request.property_id,
            PropertyDefinition::Formula(fields) => fields.id == request.property_id,
            PropertyDefinition::Rollup(fields) => fields.id == request.property_id,
            PropertyDefinition::Opaque(_) => false,
        };
        if !matches {
            continue;
        }
        match property {
            PropertyDefinition::Text(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Number(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Checkbox(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Date(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Select(fields) => fields.name = name.to_owned(),
            PropertyDefinition::MultiSelect(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Status(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Url(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Files(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Relation(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Formula(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Rollup(fields) => fields.name = name.to_owned(),
            PropertyDefinition::Opaque(_) => unreachable!(),
        }
        renamed = true;
        break;
    }
    if !renamed {
        return Err("Property cannot be renamed".to_owned());
    }

    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property rename would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    let current = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    if raw_revision(&current) != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    crate::history::snapshot_before_write(
        vault,
        &manifest_path,
        &prepared.bytes,
        "database-schema",
    )?;
    let write = watcher.prepare_write([(
        &manifest_path,
        watcher::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &prepared.bytes) {
        watcher.cancel_prepared_write(&write);
        return Err(error);
    }
    watcher.confirm_prepared_write(&write);
    let old_name = parsed
        .value
        .properties
        .iter()
        .find(|p| p.id() == Some(request.property_id.as_str()))
        .and_then(|p| p.name())
        .unwrap_or("")
        .to_string();

    if !old_name.is_empty() && old_name != name {
        for entry in walkdir::WalkDir::new(&container)
            .min_depth(1)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let note_path = entry.path();
            if note_path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(note_path) {
                if let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&content) {
                    let matching_val = mapping.iter().find_map(|(k, v)| {
                        if let Some(s) = k.as_str() {
                            if s.trim().eq_ignore_ascii_case(&old_name) {
                                return Some(v.clone());
                            }
                        }
                        None
                    });
                    if let Some(val) = matching_val {
                        if let Ok(removed) =
                            frontmatter::remove_yaml_binding_lossless(&content, &old_name)
                        {
                            if let Ok(updated) =
                                frontmatter::replace_yaml_binding_lossless(&removed, name, &val)
                            {
                                let _ =
                                    frontmatter::atomic_write_bytes(note_path, updated.as_bytes());
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(RenamedDatabaseProperty {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        name: name.to_owned(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

pub fn rename_database(
    vault: &Path,
    watcher: &WatcherState,
    request: &RenameDatabaseRequest,
) -> Result<RenamedDatabase, String> {
    let name = request.name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("Invalid database name".to_owned());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }
    if parsed.value.name == name {
        return Ok(RenamedDatabase {
            database_id: request.database_id.clone(),
            title: name.to_owned(),
            manifest_revision: parsed.revision,
            warnings: Vec::new(),
        });
    }
    let mut manifest = parsed.value.clone();
    manifest.name = name.to_owned();
    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Database name would make the manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    let current = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    if raw_revision(&current) != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    crate::history::snapshot_before_write(
        vault,
        &manifest_path,
        &prepared.bytes,
        "database-metadata",
    )?;
    let write = watcher.prepare_write([(
        &manifest_path,
        watcher::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &prepared.bytes) {
        watcher.cancel_prepared_write(&write);
        return Err(error);
    }
    watcher.confirm_prepared_write(&write);
    Ok(RenamedDatabase {
        database_id: request.database_id.clone(),
        title: name.to_owned(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

fn json_bytes(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_JSON_BYTES {
        return Err("Generated database JSON is too large".to_owned());
    }
    Ok(bytes)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match frontmatter::atomic_write_bytes_new(path, bytes) {
        Ok(()) => Ok(()),
        Err(AtomicCreateError::AlreadyExists) => {
            Err(format!("File already exists: {}", path.display()))
        }
        Err(AtomicCreateError::Other(error)) => Err(error),
    }
}

fn rollback_promotion(promoted: Option<&(PathBuf, PathBuf)>) -> Result<(), String> {
    if let Some((original, main_note)) = promoted {
        rollback_bundle_promotion(original, main_note)?;
    }
    Ok(())
}

pub fn resolve_note_path_for_id(
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Result<PathBuf, String> {
    let mut matches = Vec::new();

    for entry in walkdir::WalkDir::new(container)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let file_name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                // Do not descend into service directories
                if matches!(
                    file_name.as_ref(),
                    ".amby" | ".obsidian" | ".git" | ".trash" | "assets" | ".ambd"
                ) {
                    return false;
                }
                // Do not descend into nested database containers
                if e.path() != container && super::discovery::find_manifest_path(e.path()).is_some()
                {
                    return false;
                }
            }
            true
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            if let Ok(parsed) = frontmatter::read_markdown(path) {
                if parsed.note_id() == Some(note_id) {
                    matches.push(path.to_path_buf());
                }
            }
        }
    }

    if matches.len() == 1 {
        return Ok(matches.remove(0));
    }
    if matches.len() > 1 {
        return Err(format!(
            "Ambiguous note ID: {note_id} found in multiple notes under {}",
            container.display()
        ));
    }

    if let Ok(conn) = crate::index::open_connection(vault) {
        let rel_path: Result<String, _> =
            conn.query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
                row.get(0)
            });
        if let Ok(rel) = rel_path {
            let full = vault.join(&rel);
            if full.is_file() && full.starts_with(container) {
                if let Ok(parsed) = frontmatter::read_markdown(&full) {
                    if parsed.note_id() == Some(note_id) {
                        return Ok(full);
                    }
                }
            }
        }
    }
    Err(format!(
        "Note not found for ID {note_id} in database container {}",
        container.display()
    ))
}

/// Validate the complete batch and write property values directly into each
/// note's frontmatter using raw-byte CAS.
pub fn apply_value_batch(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseValueBatchRequest,
    history: Option<&super::history::DatabaseHistoryState>,
) -> Result<DatabaseValueBatchResult, String> {
    if !valid_operation_id(&request.operation_id) || request.cells.is_empty() {
        return Err("operationId and at least one cell are required".to_owned());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes).map_err(|error| error.to_string())?;

    let mut cells_by_note =
        std::collections::BTreeMap::<String, Vec<&DatabaseValueMutation>>::new();
    for cell in &request.cells {
        if ulid::Ulid::from_string(&cell.note_id).is_err()
            || ulid::Ulid::from_string(&cell.property_id).is_err()
        {
            return Err("noteId and propertyId must be canonical ULIDs".to_owned());
        }
        if !manifest
            .value
            .properties
            .iter()
            .any(|p| p.id() == Some(cell.property_id.as_str()))
        {
            return Err(format!(
                "Property does not belong to database: {}",
                cell.property_id
            ));
        }
        cells_by_note
            .entry(cell.note_id.clone())
            .or_default()
            .push(cell);
    }

    let mut planned_writes = Vec::new();
    let mut revisions = Vec::new();

    for (note_id, cells) in cells_by_note {
        let note_path = resolve_note_path_for_id(vault, &container, &note_id)?;
        let original_bytes = fs::read(&note_path).map_err(|error| error.to_string())?;
        let original_rev = raw_revision(&original_bytes);
        let mut content =
            String::from_utf8(original_bytes.clone()).map_err(|error| error.to_string())?;

        // Ensure frontmatter envelope and amby-id exist
        if frontmatter::frontmatter_yaml_mapping(&content)
            .ok()
            .flatten()
            .is_none()
        {
            content = format!("---\namby-id: {note_id}\n---\n{content}");
        } else if frontmatter::read_markdown(&note_path)
            .ok()
            .and_then(|p| p.id)
            .is_none()
        {
            if let Ok(updated) = frontmatter::replace_yaml_binding_lossless(
                &content,
                "amby-id",
                &serde_yaml::Value::String(note_id.clone()),
            ) {
                content = updated;
            }
        }

        let mut all_already_matched = true;
        let mut updated_content = content.clone();

        for cell in &cells {
            let prop_def = manifest
                .value
                .properties
                .iter()
                .find(|p| p.id() == Some(cell.property_id.as_str()))
                .ok_or_else(|| {
                    format!("Property does not belong to database: {}", cell.property_id)
                })?;
            let prop_name = prop_def
                .frontmatter_key()
                .ok_or_else(|| "Property has no storage key or name".to_owned())?;

            if let Some(raw_val) = cell.value_json.as_deref() {
                let prop_val = serde_json::from_str::<PropertyValue>(raw_val)
                    .map_err(|error| format!("Invalid value for {}: {error}", cell.property_id))?;
                if let Some(yaml_val) =
                    super::format::property_value_to_frontmatter_value(&prop_val, prop_def)
                {
                    let next = frontmatter::replace_yaml_binding_lossless(
                        &updated_content,
                        prop_name,
                        &yaml_val,
                    )?;
                    if next != updated_content {
                        all_already_matched = false;
                        updated_content = next;
                    }
                } else {
                    let next =
                        frontmatter::remove_yaml_binding_lossless(&updated_content, prop_name)?;
                    if next != updated_content {
                        all_already_matched = false;
                        updated_content = next;
                    }
                }
            } else {
                let next = frontmatter::remove_yaml_binding_lossless(&updated_content, prop_name)?;
                if next != updated_content {
                    all_already_matched = false;
                    updated_content = next;
                }
            }
        }

        // Check revision conflict only if changes are actually needed
        if !all_already_matched {
            for cell in &cells {
                if !cell.expected_revision.is_empty() && cell.expected_revision != original_rev {
                    return Err(format!(
                        "Record revision conflict for {}",
                        note_path.display()
                    ));
                }
            }
            planned_writes.push((
                note_path,
                updated_content.into_bytes(),
                original_bytes,
                note_id,
            ));
        } else {
            revisions.push(DatabaseNoteRevision {
                note_id,
                revision: original_rev,
            });
        }
    }

    for (path, bytes, _, _) in &planned_writes {
        crate::history::snapshot_before_write(vault, path, bytes, "database-value")?;
    }

    let prepared_writes = watcher.prepare_write(
        planned_writes
            .iter()
            .map(|(path, bytes, _, _)| (path.as_path(), watcher::fingerprint_for_bytes(bytes))),
    );

    let mut written_paths = Vec::new();
    let mut write_error = None;
    for (path, bytes, _, _) in &planned_writes {
        if let Err(error) = frontmatter::atomic_write_bytes(path, bytes) {
            write_error = Some(error);
            break;
        }
        written_paths.push(path);
    }

    if let Some(error) = write_error {
        watcher.cancel_prepared_write(&prepared_writes);
        // Roll back any files already written in this batch to their original bytes
        for (path, _, orig, _) in &planned_writes {
            if written_paths.contains(&path) {
                let _ = frontmatter::atomic_write_bytes(path, orig);
            }
        }
        return Err(format!(
            "Batch write failed; rolled back written notes: {error}"
        ));
    }
    watcher.confirm_prepared_write(&prepared_writes);

    if let Some(history) = history {
        if !planned_writes.is_empty() {
            let files = planned_writes
                .iter()
                .map(
                    |(path, post_bytes, pre_bytes, note_id)| super::history::DatabaseHistoryFile {
                        path: path.clone(),
                        note_id: note_id.clone(),
                        pre_bytes: pre_bytes.clone(),
                        pre_revision: raw_revision(pre_bytes),
                        post_bytes: post_bytes.clone(),
                        post_revision: raw_revision(post_bytes),
                    },
                )
                .collect();
            history.push(super::history::DatabaseHistoryEntry {
                database_id: request.database_id.clone(),
                description: format!("Update {} cell(s)", request.cells.len()),
                files,
            });
        }
    }

    for (_, bytes, _, note_id) in &planned_writes {
        revisions.push(DatabaseNoteRevision {
            note_id: note_id.clone(),
            revision: raw_revision(bytes),
        });
    }

    Ok(DatabaseValueBatchResult {
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        revisions,
        warnings: Vec::new(),
    })
}

fn valid_operation_id(operation_id: &str) -> bool {
    !operation_id.is_empty()
        && operation_id.len() <= 160
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[allow(dead_code)]
fn journal_bytes(journal: &BatchRecoveryJournal) -> Result<Vec<u8>, String> {
    json_bytes(&serde_json::to_value(journal).map_err(|error| error.to_string())?)
}

#[allow(dead_code)]
fn read_batch_journal(path: &Path) -> Result<BatchRecoveryJournal, String> {
    let journal: BatchRecoveryJournal =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid database recovery journal: {error}"))?;
    if journal.format != "amby-database-recovery"
        || journal.format_version != 1
        || !valid_operation_id(&journal.operation_id)
        || ulid::Ulid::from_string(&journal.database_id).is_err()
        || journal.result.as_ref().is_some_and(|result| {
            result.operation_id != journal.operation_id || result.database_id != journal.database_id
        })
    {
        return Err("Invalid database recovery journal header".to_owned());
    }
    Ok(journal)
}

#[allow(dead_code)]
fn write_batch_journal(path: &Path, journal: &BatchRecoveryJournal) -> Result<(), String> {
    frontmatter::atomic_write_bytes(path, &journal_bytes(journal)?)
}

#[allow(dead_code)]
fn recover_other_value_batches(
    container: &Path,
    recovery_root: &Path,
    current_operation_id: &str,
) -> Result<(), String> {
    let entries = fs::read_dir(recovery_root).map_err(|error| error.to_string())?;
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json")
            || path.file_stem().and_then(|stem| stem.to_str()) == Some(current_operation_id)
        {
            continue;
        }
        let journal = read_batch_journal(&path)?;
        if journal.status == "planned" || journal.status == "inProgress" {
            rollback_batch_journal(container, &path, journal)?;
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn rollback_batch_journal(
    container: &Path,
    journal_path: &Path,
    mut journal: BatchRecoveryJournal,
) -> Result<(), String> {
    for step in &mut journal.steps {
        let (record_path, backup_path) =
            recovery_step_paths(container, &journal.operation_id, step)?;
        let current = fs::read(&record_path).map_err(|error| error.to_string())?;
        let current_revision = raw_revision(&current);
        if current_revision == step.original_revision {
            step.status = "rolledBack".to_owned();
            continue;
        }
        if current_revision != step.target_revision {
            return Err(format!(
                "record changed after the batch: {}",
                record_path.display()
            ));
        }
        let backup = fs::read(&backup_path).map_err(|error| error.to_string())?;
        if raw_revision(&backup) != step.original_revision {
            return Err(format!(
                "recovery backup is corrupt: {}",
                backup_path.display()
            ));
        }
        frontmatter::atomic_write_bytes(&record_path, &backup)?;
        step.status = "rolledBack".to_owned();
    }
    journal.status = "rolledBack".to_owned();
    journal.result = None;
    write_batch_journal(journal_path, &journal)
}

#[allow(dead_code)]
fn recovery_step_paths(
    container: &Path,
    operation_id: &str,
    step: &BatchRecoveryStep,
) -> Result<(PathBuf, PathBuf), String> {
    let note_id = step
        .record_path
        .strip_prefix(".ambd/records/")
        .and_then(|path| path.strip_suffix(".json"))
        .ok_or_else(|| "Invalid record path in database recovery journal".to_owned())?;
    if ulid::Ulid::from_string(note_id).is_err()
        || step.record_path != format!(".ambd/records/{note_id}.json")
        || step.backup_path != format!(".ambd/recovery/{operation_id}/{note_id}.json")
    {
        return Err("Unsafe path in database recovery journal".to_owned());
    }
    let record_path = crate::paths::confine(container, &container.join(&step.record_path))?;
    let backup_path = crate::paths::confine(container, &container.join(&step.backup_path))?;
    Ok((record_path, backup_path))
}

pub fn update_database_relation_value(
    vault: &Path,
    watcher: &WatcherState,
    request: &UpdateDatabaseRelationValueRequest,
    history: Option<&super::history::DatabaseHistoryState>,
) -> Result<UpdateDatabaseRelationValueResult, String> {
    if ulid::Ulid::from_string(&request.note_id).is_err()
        || ulid::Ulid::from_string(&request.property_id).is_err()
    {
        return Err("noteId and propertyId must be canonical ULIDs".to_owned());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes).map_err(|error| error.to_string())?;
    if manifest.value.locked {
        return Err("Database is locked".to_owned());
    }

    let rel_prop = manifest
        .value
        .properties
        .iter()
        .find_map(|p| match p {
            PropertyDefinition::Relation(fields) if fields.id == request.property_id => {
                Some(fields.clone())
            }
            _ => None,
        })
        .ok_or_else(|| format!("Relation property not found: {}", request.property_id))?;

    let target_database_id = rel_prop.config.target_database_id.clone();
    let max_items = rel_prop.config.max_items;
    let inverse_property_id = rel_prop.config.inverse_property_id.clone();

    // Respect max_items == Some(1)
    let mut clean_targets = Vec::new();
    for id in &request.target_note_ids {
        if ulid::Ulid::from_string(id).is_ok() && !clean_targets.contains(id) {
            clean_targets.push(id.clone());
            if max_items == Some(1) {
                break;
            }
        }
    }

    // 1. Update source note frontmatter
    let note_path = resolve_note_path_for_id(vault, &container, &request.note_id)?;
    let original_bytes = fs::read(&note_path).map_err(|e| e.to_string())?;
    let content = String::from_utf8(original_bytes.clone()).map_err(|e| e.to_string())?;
    let prop_def = PropertyDefinition::Relation(rel_prop.clone());
    let prop_name = prop_def
        .frontmatter_key()
        .ok_or_else(|| "Relation property has no storage key or name".to_owned())?;

    // Get previous targets from frontmatter if any
    let prev_targets = if let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&content) {
        if let Some(val) = super::format::resolve_property_yaml_value(&mapping, &prop_def) {
            match super::format::frontmatter_value_to_property_value(val, &prop_def) {
                Some(PropertyValue::Relation {
                    target_note_ids, ..
                }) => target_note_ids,
                _ => Vec::new(),
            }
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let mut planned_writes: Vec<(PathBuf, Vec<u8>, Vec<u8>, String)> = Vec::new();

    let mut source_content = content;
    if clean_targets.is_empty() {
        source_content = frontmatter::remove_yaml_binding_lossless(&source_content, prop_name)?;
    } else {
        let val = PropertyValue::Relation {
            target_note_ids: clean_targets.clone(),
            extra: Default::default(),
        };
        if let Some(yaml_val) = super::format::property_value_to_frontmatter_value(
            &val,
            &PropertyDefinition::Relation(rel_prop.clone()),
        ) {
            source_content =
                frontmatter::replace_yaml_binding_lossless(&source_content, prop_name, &yaml_val)?;
        }
    }

    if let Some(inv_prop_id) = inverse_property_id {
        let target_container = find_database_container(vault, &target_database_id)?;
        let target_manifest_path = super::discovery::manifest_path_for_container(&target_container);
        let target_bytes = fs::read(&target_manifest_path).map_err(|e| e.to_string())?;
        let target_manifest = parse_manifest(&target_bytes).map_err(|e| e.to_string())?;
        if target_manifest.value.locked {
            return Err("Target database is locked".to_owned());
        }
        let inv_prop_def = target_manifest
            .value
            .properties
            .iter()
            .find(|p| p.id() == Some(inv_prop_id.as_str()))
            .ok_or_else(|| {
                format!("Inverse property {inv_prop_id} not found in target database")
            })?;
        let inv_prop_name = inv_prop_def
            .frontmatter_key()
            .ok_or_else(|| "Inverse property has no storage key or name".to_owned())?;

        let added_targets = clean_targets
            .iter()
            .filter(|id| !prev_targets.contains(id))
            .collect::<Vec<_>>();
        let removed_targets = prev_targets
            .iter()
            .filter(|id| !clean_targets.contains(id))
            .collect::<Vec<_>>();

        for target_id in added_targets {
            if target_id == &request.note_id {
                // Self-relation: update source_content directly
                let mut list = Vec::new();
                if let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&source_content) {
                    if let Some(v) =
                        super::format::resolve_property_yaml_value(&mapping, inv_prop_def)
                    {
                        if let Some(PropertyValue::Relation {
                            target_note_ids, ..
                        }) = super::format::frontmatter_value_to_property_value(v, inv_prop_def)
                        {
                            list = target_note_ids;
                        }
                    }
                }
                if !list.contains(&request.note_id) {
                    list.push(request.note_id.clone());
                    let r_val = PropertyValue::Relation {
                        target_note_ids: list,
                        extra: Default::default(),
                    };
                    if let Some(y_val) =
                        super::format::property_value_to_frontmatter_value(&r_val, inv_prop_def)
                    {
                        if let Ok(next) = frontmatter::replace_yaml_binding_lossless(
                            &source_content,
                            inv_prop_name,
                            &y_val,
                        ) {
                            source_content = next;
                        }
                    }
                }
            } else {
                let t_path = resolve_note_path_for_id(vault, &target_container, target_id)?;
                let t_orig = fs::read(&t_path)
                    .map_err(|e| format!("Target note not readable {target_id}: {e}"))?;
                let t_content = String::from_utf8(t_orig.clone()).map_err(|e| e.to_string())?;
                let mut list = Vec::new();
                if let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&t_content) {
                    if let Some(v) =
                        super::format::resolve_property_yaml_value(&mapping, inv_prop_def)
                    {
                        if let Some(PropertyValue::Relation {
                            target_note_ids, ..
                        }) = super::format::frontmatter_value_to_property_value(v, inv_prop_def)
                        {
                            list = target_note_ids;
                        }
                    }
                }
                if !list.contains(&request.note_id) {
                    list.push(request.note_id.clone());
                    let r_val = PropertyValue::Relation {
                        target_note_ids: list,
                        extra: Default::default(),
                    };
                    if let Some(y_val) =
                        super::format::property_value_to_frontmatter_value(&r_val, inv_prop_def)
                    {
                        let t_next = frontmatter::replace_yaml_binding_lossless(
                            &t_content,
                            inv_prop_name,
                            &y_val,
                        )?;
                        planned_writes.push((
                            t_path,
                            t_next.into_bytes(),
                            t_orig,
                            target_id.clone(),
                        ));
                    }
                }
            }
        }

        for target_id in removed_targets {
            if target_id == &request.note_id {
                // Self-relation: update source_content directly
                let mut list = Vec::new();
                if let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&source_content) {
                    if let Some(v) =
                        super::format::resolve_property_yaml_value(&mapping, inv_prop_def)
                    {
                        if let Some(PropertyValue::Relation {
                            target_note_ids, ..
                        }) = super::format::frontmatter_value_to_property_value(v, inv_prop_def)
                        {
                            list = target_note_ids;
                        }
                    }
                }
                if list.contains(&request.note_id) {
                    list.retain(|id| id != &request.note_id);
                    if list.is_empty() {
                        if let Ok(next) = frontmatter::remove_yaml_binding_lossless(
                            &source_content,
                            inv_prop_name,
                        ) {
                            source_content = next;
                        }
                    } else {
                        let r_val = PropertyValue::Relation {
                            target_note_ids: list,
                            extra: Default::default(),
                        };
                        if let Some(y_val) =
                            super::format::property_value_to_frontmatter_value(&r_val, inv_prop_def)
                        {
                            if let Ok(next) = frontmatter::replace_yaml_binding_lossless(
                                &source_content,
                                inv_prop_name,
                                &y_val,
                            ) {
                                source_content = next;
                            }
                        }
                    }
                }
            } else if let Ok(t_path) = resolve_note_path_for_id(vault, &target_container, target_id)
            {
                if let Ok(t_orig) = fs::read(&t_path) {
                    if let Ok(t_content) = String::from_utf8(t_orig.clone()) {
                        let mut list = Vec::new();
                        if let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&t_content)
                        {
                            if let Some(v) =
                                super::format::resolve_property_yaml_value(&mapping, inv_prop_def)
                            {
                                if let Some(PropertyValue::Relation {
                                    target_note_ids, ..
                                }) = super::format::frontmatter_value_to_property_value(
                                    v,
                                    inv_prop_def,
                                ) {
                                    list = target_note_ids;
                                }
                            }
                        }
                        if list.contains(&request.note_id) {
                            list.retain(|id| id != &request.note_id);
                            let t_next = if list.is_empty() {
                                frontmatter::remove_yaml_binding_lossless(
                                    &t_content,
                                    inv_prop_name,
                                )?
                            } else {
                                let r_val = PropertyValue::Relation {
                                    target_note_ids: list,
                                    extra: Default::default(),
                                };
                                let y_val = super::format::property_value_to_frontmatter_value(
                                    &r_val,
                                    inv_prop_def,
                                )
                                .ok_or_else(|| "Failed to serialize relation".to_owned())?;
                                frontmatter::replace_yaml_binding_lossless(
                                    &t_content,
                                    inv_prop_name,
                                    &y_val,
                                )?
                            };
                            planned_writes.push((
                                t_path,
                                t_next.into_bytes(),
                                t_orig,
                                target_id.clone(),
                            ));
                        }
                    }
                }
            }
        }
    }

    // Source note is included in planned writes
    planned_writes.insert(
        0,
        (
            note_path,
            source_content.into_bytes(),
            original_bytes,
            request.note_id.clone(),
        ),
    );

    // Snapshot and execute atomic writes with rollback
    for (path, bytes, _, _) in &planned_writes {
        crate::history::snapshot_before_write(vault, path, bytes, "database-value")?;
    }
    let write = watcher.prepare_write(
        planned_writes
            .iter()
            .map(|(path, bytes, _, _)| (path.as_path(), watcher::fingerprint_for_bytes(bytes))),
    );

    let mut written_paths = Vec::new();
    let mut write_err = None;
    for (path, bytes, _, _) in &planned_writes {
        if let Err(error) = frontmatter::atomic_write_bytes(path, bytes) {
            write_err = Some(error);
            break;
        }
        written_paths.push(path.clone());
    }

    if let Some(error) = write_err {
        watcher.cancel_prepared_write(&write);
        for (path, _, orig, _) in &planned_writes {
            if written_paths.contains(path) {
                let _ = frontmatter::atomic_write_bytes(path, orig);
            }
        }
        return Err(format!(
            "Relation write failed; rolled back written files: {error}"
        ));
    }
    watcher.confirm_prepared_write(&write);

    if let Some(history) = history {
        if !planned_writes.is_empty() {
            let files = planned_writes
                .iter()
                .map(
                    |(path, post_bytes, pre_bytes, note_id)| super::history::DatabaseHistoryFile {
                        path: path.clone(),
                        note_id: note_id.clone(),
                        pre_bytes: pre_bytes.clone(),
                        pre_revision: raw_revision(pre_bytes),
                        post_bytes: post_bytes.clone(),
                        post_revision: raw_revision(post_bytes),
                    },
                )
                .collect();
            history.push(super::history::DatabaseHistoryEntry {
                database_id: request.database_id.clone(),
                description: format!("Update relation for note {}", request.note_id),
                files,
            });
        }
    }

    Ok(UpdateDatabaseRelationValueResult {
        database_id: request.database_id.clone(),
        note_id: request.note_id.clone(),
        target_note_ids: clean_targets,
        warnings: Vec::new(),
    })
}

pub fn find_database_container(vault: &Path, database_id: &str) -> Result<PathBuf, String> {
    let discovery = super::discovery::discover_vault(vault)?;
    discovery
        .databases
        .into_iter()
        .find(|database| database.database_id == database_id)
        .map(|database| database.container_path)
        .ok_or_else(|| "Database was not found".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> PathBuf {
        let path = std::env::temp_dir().join(format!("amby-db-create-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn standalone_creation_writes_manifest_and_default_view_without_markdown() {
        let vault = temp_vault();
        let result = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        assert!(Path::new(&result.manifest_path).is_file());
        assert!(Path::new(&result.view_path).is_file());
        let manifest =
            super::super::format::parse_manifest(&fs::read(&result.manifest_path).unwrap())
                .unwrap();
        assert_eq!(manifest.value.views.len(), 1);
        let view = &manifest.value.views[0];
        let validation = super::super::validation::validate_view(view, None);
        assert!(
            validation.errors.is_empty(),
            "generated view failed validation: {:?}",
            validation.errors
        );
        assert!(!vault.join("Projects").join("Projects.md").exists());
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn attached_creation_preserves_note_bytes() {
        let vault = temp_vault();
        let note = vault.join("Meeting.md");
        let original = b"---\ntitle: Meeting\n---\n\nBody\r\n";
        fs::write(&note, original).unwrap();
        let result = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Attached,
                parent_path: None,
                note_path: Some(note.to_string_lossy().to_string()),
                name: "Meeting DB".to_owned(),
            },
        )
        .unwrap();
        let moved_note = vault.join("Meeting").join("Meeting.md");
        assert_eq!(fs::read(moved_note).unwrap(), original);
        assert!(Path::new(&result.manifest_path).is_file());
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn property_creation_updates_manifest_with_raw_revision_cas() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let property = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision.clone(),
                name: "Priority".to_owned(),
                property_type: "number".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();
        let bytes = fs::read(&created.manifest_path).unwrap();
        let parsed = parse_manifest(&bytes).unwrap();
        assert_eq!(parsed.revision, property.manifest_revision);
        assert_eq!(parsed.value.properties.len(), 1);
        assert_eq!(
            parsed.value.properties[0].id(),
            Some(property.property_id.as_str())
        );
        assert!(create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id,
                expected_manifest_revision: created.manifest_revision,
                name: "Stale".to_owned(),
                property_type: "text".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .is_err());
        assert_eq!(fs::read(&created.manifest_path).unwrap(), bytes);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn select_property_creation_preserves_unique_non_empty_options() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id,
                expected_manifest_revision: created.manifest_revision,
                name: "Status".to_owned(),
                property_type: "select".to_owned(),
                before_property_id: None,
                options: vec!["Todo".to_owned(), " todo ".to_owned(), "".to_owned()],
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();

        let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
        let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
        let options = value["config"]["options"].as_array().unwrap();
        assert_eq!(options.len(), 1);
        assert_eq!(options[0]["name"], "Todo");
        assert!(ulid::Ulid::from_string(options[0]["id"].as_str().unwrap()).is_ok());
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn formula_property_creation_stores_the_validated_expression() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id,
                expected_manifest_revision: created.manifest_revision,
                name: "Score".to_owned(),
                property_type: "formula".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: Some("1 + 2".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
        let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
        assert_eq!(value["type"], "formula");
        assert_eq!(value["config"]["expression"], "1 + 2");
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn relation_property_creation_defaults_to_the_current_database() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision,
                name: "Related projects".to_owned(),
                property_type: "relation".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();

        let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
        let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
        assert_eq!(value["type"], "relation");
        assert_eq!(value["config"]["targetDatabaseId"], created.database_id);
        assert!(value["config"]["maxItems"].is_null());
        assert!(value["config"]["inversePropertyId"].is_null());
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn relation_property_creation_can_target_another_database() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let source = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Characters".to_owned(),
            },
        )
        .unwrap();
        let target = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Locations".to_owned(),
            },
        )
        .unwrap();
        create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: source.database_id.clone(),
                expected_manifest_revision: source.manifest_revision,
                name: "Location".to_owned(),
                property_type: "relation".to_owned(),
                before_property_id: None,
                options: vec![target.database_id.clone()],
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();

        let parsed = parse_manifest(&fs::read(&source.manifest_path).unwrap()).unwrap();
        let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
        assert_eq!(value["config"]["targetDatabaseId"], target.database_id);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn property_type_change_updates_an_unused_definition() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let property = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision,
                name: "Estimate".to_owned(),
                property_type: "text".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();

        let changed = change_database_property_type(
            &vault,
            &watcher,
            &ChangeDatabasePropertyTypeRequest {
                expected_generation: 1,
                database_id: created.database_id,
                property_id: property.property_id.clone(),
                expected_manifest_revision: property.manifest_revision,
                property_type: "number".to_owned(),
                relation_target_database_id: None,
                ..Default::default()
            },
        )
        .unwrap();

        let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
        assert_eq!(parsed.revision, changed.manifest_revision);
        assert_eq!(parsed.value.properties[0].kind(), "number");
        assert_eq!(
            parsed.value.properties[0].id(),
            Some(property.property_id.as_str())
        );
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn property_type_change_refuses_to_discard_existing_values() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let property = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision,
                name: "Estimate".to_owned(),
                property_type: "text".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();
        let note_id = ulid::Ulid::generate().to_string();
        let record_path = Path::new(&created.manifest_path)
            .parent()
            .unwrap()
            .join(".ambd/records")
            .join(format!("{note_id}.json"));
        fs::create_dir_all(record_path.parent().unwrap()).unwrap();
        fs::write(
            record_path,
            serde_json::to_vec_pretty(&json!({
                "format": "amby-database-record",
                "formatVersion": 1,
                "databaseId": created.database_id,
                "noteId": note_id,
                "values": {
                    property.property_id.clone(): {"type": "text", "value": "keep me"}
                },
                "yamlSyncBases": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let manifest_before = fs::read(&created.manifest_path).unwrap();

        let error = change_database_property_type(
            &vault,
            &watcher,
            &ChangeDatabasePropertyTypeRequest {
                expected_generation: 1,
                database_id: created.database_id,
                property_id: property.property_id,
                expected_manifest_revision: property.manifest_revision,
                property_type: "number".to_owned(),
                relation_target_database_id: None,
                ..Default::default()
            },
        )
        .unwrap_err();

        assert!(error.contains("existing values"));
        assert_eq!(fs::read(&created.manifest_path).unwrap(), manifest_before);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn property_rename_updates_manifest_and_preserves_property_id() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let property = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision.clone(),
                name: "Priority".to_owned(),
                property_type: "number".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();
        let renamed = rename_database_property(
            &vault,
            &watcher,
            &RenameDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                property_id: property.property_id.clone(),
                expected_manifest_revision: property.manifest_revision.clone(),
                name: "Importance".to_owned(),
            },
        )
        .unwrap();
        let bytes = fs::read(&created.manifest_path).unwrap();
        let parsed = parse_manifest(&bytes).unwrap();
        assert_eq!(parsed.revision, renamed.manifest_revision);
        assert_eq!(
            parsed.value.properties[0].id(),
            Some(property.property_id.as_str())
        );
        let serialized = serde_json::to_value(&parsed.value.properties[0]).unwrap();
        assert_eq!(
            serialized.get("name").and_then(|value| value.as_str()),
            Some("Importance")
        );
        assert!(rename_database_property(
            &vault,
            &watcher,
            &RenameDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id,
                property_id: property.property_id,
                expected_manifest_revision: property.manifest_revision,
                name: "Stale".to_owned(),
            },
        )
        .is_err());
        assert_eq!(fs::read(&created.manifest_path).unwrap(), bytes);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn property_insert_and_delete_update_schema_order() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let right = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision,
                name: "Right".to_owned(),
                property_type: "text".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();
        let left = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: right.manifest_revision,
                name: "Left".to_owned(),
                property_type: "number".to_owned(),
                before_property_id: Some(right.property_id.clone()),
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();
        let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
        assert_eq!(
            parsed.value.properties[0].id(),
            Some(left.property_id.as_str())
        );
        assert_eq!(
            parsed.value.properties[1].id(),
            Some(right.property_id.as_str())
        );

        let reordered = reorder_database_properties(
            &vault,
            &watcher,
            &ReorderDatabasePropertiesRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: left.manifest_revision,
                property_ids: vec![right.property_id.clone(), left.property_id.clone()],
            },
        )
        .unwrap();
        let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
        assert_eq!(
            parsed.value.properties[0].id(),
            Some(right.property_id.as_str())
        );
        assert_eq!(
            parsed.value.properties[1].id(),
            Some(left.property_id.as_str())
        );

        let deleted = delete_database_property(
            &vault,
            &watcher,
            &DeleteDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id,
                property_id: left.property_id,
                expected_manifest_revision: reordered.manifest_revision,
            },
        )
        .unwrap();
        let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
        assert_eq!(parsed.revision, deleted.manifest_revision);
        assert_eq!(parsed.value.properties.len(), 1);
        assert_eq!(
            parsed.value.properties[0].id(),
            Some(right.property_id.as_str())
        );
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn database_rename_updates_manifest_with_raw_revision_cas() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let renamed = rename_database(
            &vault,
            &watcher,
            &RenameDatabaseRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision.clone(),
                name: "Roadmap".to_owned(),
            },
        )
        .unwrap();
        let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
        assert_eq!(parsed.value.name, "Roadmap");
        assert_eq!(parsed.revision, renamed.manifest_revision);
        assert!(rename_database(
            &vault,
            &watcher,
            &RenameDatabaseRequest {
                expected_generation: 1,
                database_id: created.database_id,
                expected_manifest_revision: created.manifest_revision,
                name: "Stale".to_owned(),
            },
        )
        .is_err());
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn value_batch_validates_every_cell_before_publishing_any_record() {
        let vault = temp_vault();
        let created = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let property_id = ulid::Ulid::generate().to_string();
        let note_id = ulid::Ulid::generate().to_string();
        let manifest_path = Path::new(&created.manifest_path);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
        manifest["properties"] = json!([{
            "id": property_id.clone(),
            "name": "Status",
            "type": "text",
            "pageVisibility": "alwaysShow",
            "yamlBinding": null,
            "config": {"multiline": false}
        }]);
        fs::write(manifest_path, json_bytes(&manifest).unwrap()).unwrap();
        let record_path = vault
            .join("Projects/.ambd/records")
            .join(format!("{note_id}.json"));
        fs::create_dir_all(record_path.parent().unwrap()).unwrap();
        let original = json_bytes(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": created.database_id.clone(),
            "noteId": note_id.clone(),
            "values": {}
        }))
        .unwrap();
        fs::write(&record_path, &original).unwrap();
        let result = apply_value_batch(
            &vault,
            &WatcherState::new(),
            &DatabaseValueBatchRequest {
                expected_generation: 1,
                database_id: created.database_id,
                operation_id: ulid::Ulid::generate().to_string(),
                cells: vec![
                    DatabaseValueMutation {
                        note_id: note_id.clone(),
                        property_id,
                        value_json: Some(r#"{"kind":"text","value":"done"}"#.to_owned()),
                        expected_revision: raw_revision(&original),
                    },
                    DatabaseValueMutation {
                        note_id,
                        property_id: ulid::Ulid::generate().to_string(),
                        value_json: None,
                        expected_revision: raw_revision(&original),
                    },
                ],
            },
            None,
        );
        assert!(result.is_err());
        assert_eq!(fs::read(record_path).unwrap(), original);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn value_batch_writes_a_durable_completed_journal_and_replays_idempotently() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let property = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision,
                name: "Summary".to_owned(),
                property_type: "text".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();
        let row = crate::database::rows::create_database_row(
            &vault,
            &watcher,
            &crate::database::rows::CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                title: "First".to_owned(),
                template: crate::database::rows::DatabaseRowTemplate::Default,
            },
        )
        .unwrap();
        let manifest_path =
            crate::database::discovery::manifest_path_for_container(&vault.join("Projects"));
        let mut locked_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        locked_manifest["locked"] = serde_json::Value::Bool(true);
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&locked_manifest).unwrap(),
        )
        .unwrap();
        let request = DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: created.database_id,
            operation_id: format!("test-{}", ulid::Ulid::generate()),
            cells: vec![DatabaseValueMutation {
                note_id: row.note_id,
                property_id: property.property_id,
                value_json: Some(r#"{"type":"text","value":"done"}"#.to_owned()),
                expected_revision: row.record_revision,
            }],
        };
        let first = apply_value_batch(&vault, &watcher, &request, None).unwrap();
        let replay = apply_value_batch(&vault, &watcher, &request, None).unwrap();
        assert_eq!(first, replay);
        let note_content = fs::read_to_string(&row.note_path).unwrap();
        assert!(note_content.contains("done"));
        assert!(!vault.join("Projects/.ambd/records").exists());
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn recovery_rollback_restores_only_the_exact_batch_revision() {
        let container = temp_vault();
        let note_id = ulid::Ulid::generate().to_string();
        let operation_id = format!("test-{}", ulid::Ulid::generate());
        let record_path = container
            .join(".ambd/records")
            .join(format!("{note_id}.json"));
        let backup_path = container
            .join(".ambd/recovery")
            .join(&operation_id)
            .join(format!("{note_id}.json"));
        let journal_path = container
            .join(".ambd/recovery")
            .join(format!("{operation_id}.json"));
        fs::create_dir_all(record_path.parent().unwrap()).unwrap();
        fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
        let original = br#"{"values":{}}"#;
        let target = br#"{"values":{"changed":true}}"#;
        fs::write(&record_path, target).unwrap();
        fs::write(&backup_path, original).unwrap();
        let journal = BatchRecoveryJournal {
            format: "amby-database-recovery".to_owned(),
            format_version: 1,
            operation_id: operation_id.clone(),
            database_id: ulid::Ulid::generate().to_string(),
            request_revision: "request".to_owned(),
            status: "inProgress".to_owned(),
            steps: vec![BatchRecoveryStep {
                record_path: format!(".ambd/records/{note_id}.json"),
                backup_path: format!(".ambd/recovery/{operation_id}/{note_id}.json"),
                original_revision: raw_revision(original),
                target_revision: raw_revision(target),
                status: "written".to_owned(),
            }],
            result: None,
        };
        write_new(&journal_path, &journal_bytes(&journal).unwrap()).unwrap();
        rollback_batch_journal(&container, &journal_path, journal).unwrap();
        assert_eq!(fs::read(record_path).unwrap(), original);
        assert_eq!(
            read_batch_journal(&journal_path).unwrap().status,
            "rolledBack"
        );
        let _ = fs::remove_dir_all(container);
    }

    #[test]
    fn recovery_rejects_paths_not_derived_from_the_operation_and_note_ids() {
        let container = temp_vault();
        let step = BatchRecoveryStep {
            record_path: ".ambd/records/../../outside.json".to_owned(),
            backup_path: ".ambd/recovery/safe/../../outside.json".to_owned(),
            original_revision: "original".to_owned(),
            target_revision: "target".to_owned(),
            status: "written".to_owned(),
        };
        assert!(recovery_step_paths(&container, "safe", &step).is_err());
        let _ = fs::remove_dir_all(container);
    }

    #[test]
    fn two_way_relation_creates_property_in_target_database_and_links_reciprocals() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let tasks_db = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Tasks".to_owned(),
            },
        )
        .unwrap();
        let projects_db = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();

        let tasks_rel = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: tasks_db.database_id.clone(),
                expected_manifest_revision: tasks_db.manifest_revision.clone(),
                name: "Project".to_owned(),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(projects_db.database_id.clone()),
                relation_max_items: Some(1),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some("Tasks".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let tasks_manifest = parse_manifest(&fs::read(&tasks_db.manifest_path).unwrap()).unwrap();
        let tasks_prop_val = serde_json::to_value(&tasks_manifest.value.properties[0]).unwrap();
        assert_eq!(tasks_prop_val["name"], "Project");
        assert_eq!(
            tasks_prop_val["config"]["targetDatabaseId"],
            projects_db.database_id
        );
        assert_eq!(tasks_prop_val["config"]["maxItems"], 1);
        let inverse_id = tasks_prop_val["config"]["inversePropertyId"]
            .as_str()
            .unwrap()
            .to_string();

        let projects_manifest =
            parse_manifest(&fs::read(&projects_db.manifest_path).unwrap()).unwrap();
        let projects_prop_val =
            serde_json::to_value(&projects_manifest.value.properties[0]).unwrap();
        assert_eq!(projects_prop_val["name"], "Tasks");
        assert_eq!(projects_prop_val["id"], inverse_id);
        assert_eq!(
            projects_prop_val["config"]["targetDatabaseId"],
            tasks_db.database_id
        );
        assert_eq!(
            projects_prop_val["config"]["inversePropertyId"],
            tasks_rel.property_id
        );

        // Now test update_database_relation_value syncs reciprocal records
        let task_note_id = ulid::Ulid::generate().to_string();
        let project_note_id = ulid::Ulid::generate().to_string();

        let tasks_dir = Path::new(&tasks_db.manifest_path).parent().unwrap();
        let task_note_path = tasks_dir.join("Task.md");
        fs::write(
            &task_note_path,
            format!("---\namby-id: {task_note_id}\n---\n# Task\n"),
        )
        .unwrap();

        let projects_dir = Path::new(&projects_db.manifest_path).parent().unwrap();
        let project_note_path = projects_dir.join("Project.md");
        fs::write(
            &project_note_path,
            format!("---\namby-id: {project_note_id}\n---\n# Project\n"),
        )
        .unwrap();

        update_database_relation_value(
            &vault,
            &watcher,
            &UpdateDatabaseRelationValueRequest {
                expected_generation: 1,
                database_id: tasks_db.database_id.clone(),
                note_id: task_note_id.clone(),
                property_id: tasks_rel.property_id.clone(),
                target_note_ids: vec![project_note_id.clone()],
            },
            None,
        )
        .unwrap();

        // Check task note frontmatter
        let task_content = fs::read_to_string(&task_note_path).unwrap();
        let task_mapping = frontmatter::frontmatter_yaml_mapping(&task_content)
            .unwrap()
            .unwrap();
        let task_rel_val = task_mapping
            .get(&serde_yaml::Value::String("Project".to_string()))
            .expect("Task frontmatter must contain Project relation");
        let task_prop_def = &tasks_manifest.value.properties[0];
        let task_prop_val = crate::database::format::frontmatter_value_to_property_value(
            task_rel_val,
            task_prop_def,
        )
        .expect("Valid relation value in Task");
        match task_prop_val {
            PropertyValue::Relation {
                target_note_ids, ..
            } => {
                assert_eq!(target_note_ids, &[project_note_id.clone()]);
            }
            other => panic!("expected relation value, got {other:?}"),
        }

        // Check project note frontmatter was reciprocally updated!
        let project_content = fs::read_to_string(&project_note_path).unwrap();
        let project_mapping = frontmatter::frontmatter_yaml_mapping(&project_content)
            .unwrap()
            .unwrap();
        let project_rel_val = project_mapping
            .get(&serde_yaml::Value::String("Tasks".to_string()))
            .expect("Project frontmatter must contain Tasks reciprocal relation");
        let project_prop_def = &projects_manifest.value.properties[0];
        let project_prop_val = crate::database::format::frontmatter_value_to_property_value(
            project_rel_val,
            project_prop_def,
        )
        .expect("Valid relation value in Project");
        match project_prop_val {
            PropertyValue::Relation {
                target_note_ids, ..
            } => {
                assert_eq!(target_note_ids, &[task_note_id.clone()]);
            }
            other => panic!("expected inverse relation value on project, got {other:?}"),
        }

        // Now unlink
        update_database_relation_value(
            &vault,
            &watcher,
            &UpdateDatabaseRelationValueRequest {
                expected_generation: 1,
                database_id: tasks_db.database_id.clone(),
                note_id: task_note_id.clone(),
                property_id: tasks_rel.property_id.clone(),
                target_note_ids: vec![],
            },
            None,
        )
        .unwrap();

        let project_content_after = fs::read_to_string(&project_note_path).unwrap();
        let project_mapping_after = frontmatter::frontmatter_yaml_mapping(&project_content_after)
            .unwrap()
            .unwrap();
        if let Some(val) =
            project_mapping_after.get(&serde_yaml::Value::String("Tasks".to_string()))
        {
            let prop_val =
                crate::database::format::frontmatter_value_to_property_value(val, project_prop_def)
                    .unwrap_or(PropertyValue::Relation {
                        target_note_ids: vec![],
                        extra: Default::default(),
                    });
            match prop_val {
                PropertyValue::Relation {
                    target_note_ids, ..
                } => {
                    assert!(target_note_ids.is_empty());
                }
                other => panic!("expected empty inverse relation, got {other:?}"),
            }
        }

        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn creates_standalone_database_with_named_json_file() {
        let vault = temp_vault();
        let watcher = WatcherState::new();

        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "My Tasks".to_owned(),
            },
        )
        .unwrap();

        assert_eq!(created.title, "My Tasks");
        let db_dir = vault.join("My Tasks");
        assert!(db_dir.is_dir());

        // The manifest MUST be named "My Tasks.json"
        let manifest_path = db_dir.join("My Tasks.json");
        assert!(manifest_path.is_file());
        assert!(!db_dir.join("ambd.json").exists());

        // Verify content
        let parsed = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();
        assert_eq!(parsed.value.name, "My Tasks");
        assert_eq!(parsed.value.database_id, created.database_id);

        // Add a property
        let prop = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                expected_manifest_revision: parsed.revision.clone(),
                database_id: created.database_id.clone(),
                name: "Priority".to_owned(),
                property_type: "select".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();

        // Verify property was written to "My Tasks.json"
        let parsed_after = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();
        assert_eq!(parsed_after.revision, prop.manifest_revision);
        assert_eq!(parsed_after.value.properties.len(), 1);

        // Rename the database item via crate::bundle::rename_item_impl
        crate::bundle::rename_item_impl(&db_dir, "All Tasks").unwrap();

        let new_db_dir = vault.join("All Tasks");
        assert!(new_db_dir.is_dir());
        assert!(!db_dir.exists());

        // The manifest file should have been renamed to "All Tasks.json"
        let new_manifest_path = new_db_dir.join("All Tasks.json");
        assert!(new_manifest_path.is_file());
        assert!(!new_db_dir.join("My Tasks.json").exists());

        // The internal "name" should be updated to "All Tasks"
        let parsed_renamed = parse_manifest(&fs::read(&new_manifest_path).unwrap()).unwrap();
        assert_eq!(parsed_renamed.value.name, "All Tasks");

        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn st04_batch_write_failure_rolls_back_first_file() {
        use std::os::unix::fs::PermissionsExt;

        let vault = temp_vault();
        let watcher = WatcherState::new();

        let db = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Tasks".to_owned(),
            },
        )
        .unwrap();

        let prop = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                expected_manifest_revision: db.manifest_revision.clone(),
                database_id: db.database_id.clone(),
                name: "Status".to_owned(),
                property_type: "text".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();

        let note1_id = ulid::Ulid::generate().to_string();
        let note1_path = vault.join("Tasks").join("Note1.md");
        let note1_orig = format!("---\namby-id: {note1_id}\nStatus: Old1\n---\n\nBody 1\n");
        fs::write(&note1_path, &note1_orig).unwrap();

        let note2_id = ulid::Ulid::generate().to_string();
        let sub_dir = vault.join("Tasks").join("locked_sub");
        fs::create_dir_all(&sub_dir).unwrap();
        let note2_path = sub_dir.join("Note2.md");
        let note2_orig = format!("---\namby-id: {note2_id}\nStatus: Old2\n---\n\nBody 2\n");
        fs::write(&note2_path, &note2_orig).unwrap();

        // Make sub_dir read-only so write to note2 will fail
        let orig_perms = fs::metadata(&sub_dir).unwrap().permissions();
        fs::set_permissions(&sub_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let batch_req = DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: db.database_id.clone(),
            operation_id: "op-test-rollback".to_owned(),
            cells: vec![
                DatabaseValueMutation {
                    note_id: note1_id.clone(),
                    property_id: prop.property_id.clone(),
                    value_json: Some(
                        serde_json::to_string(&PropertyValue::Text {
                            value: "New1".to_owned(),
                            extra: Default::default(),
                        })
                        .unwrap(),
                    ),
                    expected_revision: String::new(),
                },
                DatabaseValueMutation {
                    note_id: note2_id.clone(),
                    property_id: prop.property_id.clone(),
                    value_json: Some(
                        serde_json::to_string(&PropertyValue::Text {
                            value: "New2".to_owned(),
                            extra: Default::default(),
                        })
                        .unwrap(),
                    ),
                    expected_revision: String::new(),
                },
            ],
        };

        let result = apply_value_batch(&vault, &watcher, &batch_req, None);
        assert!(
            result.is_err(),
            "Batch write should fail because note2 cannot be written"
        );

        // Verify that note1 was rolled back to original bytes!
        let note1_after = fs::read_to_string(&note1_path).unwrap();
        assert_eq!(
            note1_after, note1_orig,
            "Note 1 must be rolled back to original content after batch failure"
        );

        // Restore permissions for cleanup
        fs::set_permissions(&sub_dir, orig_perms).unwrap();
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn st04_two_way_relation_target_locked_or_missing_fails_cleanly() {
        let vault = temp_vault();
        let watcher = WatcherState::new();

        let db_a = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();

        let db_b = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Tasks".to_owned(),
            },
        )
        .unwrap();

        let projects_manifest_path = vault.join("Projects").join("Projects.json");
        let projects_bytes = fs::read(&projects_manifest_path).unwrap();
        let projects_manifest = parse_manifest(&projects_bytes).unwrap();

        let a_prop = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                expected_manifest_revision: projects_manifest.revision.clone(),
                database_id: db_a.database_id.clone(),
                name: "Tasks".to_owned(),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(db_b.database_id.clone()),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some("Project".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let proj_note_id = ulid::Ulid::generate().to_string();
        let proj_note_path = vault.join("Projects").join("Project 1.md");
        let proj_orig = format!("---\namby-id: {proj_note_id}\n---\n\nProject content\n");
        fs::write(&proj_note_path, &proj_orig).unwrap();

        // 1. Target note is missing
        let missing_note_id = ulid::Ulid::generate().to_string();
        let rel_req = UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            database_id: db_a.database_id.clone(),
            note_id: proj_note_id.clone(),
            property_id: a_prop.property_id.clone(),
            target_note_ids: vec![missing_note_id.clone()],
        };
        let res = update_database_relation_value(&vault, &watcher, &rel_req, None);
        assert!(res.is_err(), "Must fail when target note is missing");
        assert_eq!(
            fs::read_to_string(&proj_note_path).unwrap(),
            proj_orig,
            "Source note must not be modified if target note is missing"
        );

        // 2. Target database is locked
        let task_note_id = ulid::Ulid::generate().to_string();
        let task_note_path = vault.join("Tasks").join("Task 1.md");
        let task_orig = format!("---\namby-id: {task_note_id}\n---\n\nTask content\n");
        fs::write(&task_note_path, &task_orig).unwrap();

        // Lock target database
        let tasks_manifest_path = vault.join("Tasks").join("Tasks.json");
        let mut target_m = parse_manifest(&fs::read(&tasks_manifest_path).unwrap()).unwrap();
        target_m.value.locked = true;
        fs::write(
            &tasks_manifest_path,
            serde_json::to_vec_pretty(&target_m.value).unwrap(),
        )
        .unwrap();

        let rel_req2 = UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            database_id: db_a.database_id.clone(),
            note_id: proj_note_id.clone(),
            property_id: a_prop.property_id.clone(),
            target_note_ids: vec![task_note_id.clone()],
        };
        let res2 = update_database_relation_value(&vault, &watcher, &rel_req2, None);
        assert!(res2.is_err(), "Must fail when target database is locked");
        assert_eq!(
            fs::read_to_string(&proj_note_path).unwrap(),
            proj_orig,
            "Source note must not be modified if target database is locked"
        );

        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn st04_self_relation_updates_single_file_without_conflict() {
        let vault = temp_vault();
        let watcher = WatcherState::new();

        let db = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Tasks".to_owned(),
            },
        )
        .unwrap();

        let manifest_path = vault.join("Tasks").join("Tasks.json");
        let manifest = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();

        let subtask_prop = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                expected_manifest_revision: manifest.revision.clone(),
                database_id: db.database_id.clone(),
                name: "Subtasks".to_owned(),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(db.database_id.clone()),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some("Parent".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let note_id = ulid::Ulid::generate().to_string();
        let note_path = vault.join("Tasks").join("RecursiveTask.md");
        let note_orig = format!("---\namby-id: {note_id}\n---\n\nSelf-referencing task\n");
        fs::write(&note_path, &note_orig).unwrap();

        let rel_req = UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            database_id: db.database_id.clone(),
            note_id: note_id.clone(),
            property_id: subtask_prop.property_id.clone(),
            target_note_ids: vec![note_id.clone()],
        };

        let res = update_database_relation_value(&vault, &watcher, &rel_req, None);
        assert!(
            res.is_ok(),
            "Self-relation update must succeed: {:?}",
            res.err()
        );

        let content_after = fs::read_to_string(&note_path).unwrap();
        let mapping = frontmatter::frontmatter_yaml_mapping(&content_after)
            .unwrap()
            .unwrap();

        let sub_val = mapping
            .get(&serde_yaml::Value::String("Subtasks".to_string()))
            .unwrap();
        let par_val = mapping
            .get(&serde_yaml::Value::String("Parent".to_string()))
            .unwrap();

        assert_eq!(
            sub_val,
            &serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(note_id.clone())])
        );
        assert_eq!(
            par_val,
            &serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(note_id.clone())])
        );

        let _ = fs::remove_dir_all(vault);
    }
    #[test]
    fn review_future_manifest_prevents_batch_write() {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let property = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision,
                name: "Summary".to_owned(),
                property_type: "text".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();
        let row = crate::database::rows::create_database_row(
            &vault,
            &watcher,
            &crate::database::rows::CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                title: "First".to_owned(),
                template: crate::database::rows::DatabaseRowTemplate::Default,
            },
        )
        .unwrap();
        let manifest_path =
            crate::database::discovery::manifest_path_for_container(&vault.join("Projects"));
        let mut locked_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        locked_manifest["formatVersion"] = serde_json::json!(999);
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&locked_manifest).unwrap(),
        )
        .unwrap();
        let request = DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: created.database_id,
            operation_id: format!("test-{}", ulid::Ulid::generate()),
            cells: vec![DatabaseValueMutation {
                note_id: row.note_id,
                property_id: property.property_id,
                value_json: Some(r#"{"type":"text","value":"done"}"#.to_owned()),
                expected_revision: row.record_revision,
            }],
        };
        let before = fs::read(&row.note_path).unwrap();
        let result = apply_value_batch(&vault, &watcher, &request, None);
        assert_eq!(
            fs::read(&row.note_path).unwrap(),
            before,
            "future-format database was changed: {result:?}"
        );
        assert!(result.is_err());
        let _ = fs::remove_dir_all(vault);
    }
}
