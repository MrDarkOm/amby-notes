//! Database creation and durable, conflict-aware metadata/schema/value mutations.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::format::{
    parse_manifest, parse_record, parse_template, prepare_json, PropertyDefinition, PropertyValue,
    RecordShard,
};
use super::format::{raw_revision, MAX_JSON_BYTES};
use super::validation::{validate_manifest, validate_record};
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchRecoveryStep {
    record_path: String,
    backup_path: String,
    original_revision: String,
    target_revision: String,
    status: String,
}

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
    let view_path = container
        .join(".ambd/views")
        .join(format!("{view_id}.json"));
    if manifest_path.exists() || container.join("ambd.json").exists() {
        rollback_promotion(promoted_from.as_ref())?;
        return Err(format!(
            "Database manifest already exists: {}",
            manifest_path.display()
        ));
    }
    if view_path.exists() {
        rollback_promotion(promoted_from.as_ref())?;
        return Err(format!(
            "Database view already exists: {}",
            view_path.display()
        ));
    }

    let container_kind = match request.mode {
        DatabaseCreateMode::Standalone => "standalone",
        DatabaseCreateMode::Attached => "attached",
    };
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
    });
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
    let manifest_bytes = json_bytes(&manifest)?;
    let view_bytes = json_bytes(&view)?;
    let prepared = watcher.prepare_write([
        (
            &manifest_path,
            watcher::fingerprint_for_bytes(&manifest_bytes),
        ),
        (&view_path, watcher::fingerprint_for_bytes(&view_bytes)),
    ]);
    let result = (|| {
        fs::create_dir_all(view_path.parent().ok_or("View has no parent")?)
            .map_err(|error| error.to_string())?;
        write_new(&manifest_path, &manifest_bytes)?;
        if let Err(error) = write_new(&view_path, &view_bytes) {
            let _ = fs::remove_file(&manifest_path);
            return Err(error);
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            watcher.confirm_prepared_write(&prepared);
        }
        Err(error) => {
            watcher.cancel_prepared_write(&prepared);
            let _ = fs::remove_file(&view_path);
            let _ = fs::remove_file(&manifest_path);
            rollback_promotion(promoted_from.as_ref())?;
            return Err(error);
        }
    }

    Ok(CreatedDatabase {
        database_id,
        title: name.to_owned(),
        manifest_revision: raw_revision(&manifest_bytes),
        view_id,
        view_revision: raw_revision(&view_bytes),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        view_path: view_path.to_string_lossy().to_string(),
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
    property_id: &str,
) -> Result<(), String> {
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
            let parsed = parse_record(&fs::read(entry.path()).map_err(|error| error.to_string())?)
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
        ensure_property_has_no_durable_values(&container, &request.property_id)?;
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

/// Validate the complete batch before publishing any record shard, then write
/// each changed shard with a raw-byte CAS. The projection is rebuilt by the
/// command after this function returns successfully.
pub fn apply_value_batch(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseValueBatchRequest,
) -> Result<DatabaseValueBatchResult, String> {
    if !valid_operation_id(&request.operation_id) || request.cells.is_empty() {
        return Err("operationId and at least one cell are required".to_owned());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let request_revision = raw_revision(
        &serde_json::to_vec(request).map_err(|error| format!("Invalid batch request: {error}"))?,
    );
    let recovery_root = container.join(".ambd/recovery");
    fs::create_dir_all(&recovery_root).map_err(|error| error.to_string())?;
    recover_other_value_batches(&container, &recovery_root, &request.operation_id)?;
    let journal_path = recovery_root.join(format!("{}.json", request.operation_id));
    if journal_path.exists() {
        let existing = read_batch_journal(&journal_path)?;
        if existing.request_revision != request_revision
            || existing.database_id != request.database_id
        {
            return Err("operationId was already used for a different batch".to_owned());
        }
        if existing.status == "completed" {
            return existing
                .result
                .ok_or_else(|| "Completed recovery journal has no result".to_owned());
        }
        if existing.status == "planned" || existing.status == "inProgress" {
            rollback_batch_journal(&container, &journal_path, existing)?;
        }
        let _ = fs::remove_file(&journal_path);
        let _ = fs::remove_dir_all(recovery_root.join(&request.operation_id));
    }
    let backup_dir = recovery_root.join(&request.operation_id);
    if backup_dir.exists() {
        fs::remove_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    }
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes).map_err(|error| error.to_string())?;
    let property_ids = manifest
        .value
        .properties
        .iter()
        .filter_map(|property| property.id())
        .collect::<std::collections::HashSet<_>>();
    let mut planned = std::collections::BTreeMap::<String, (RecordShard, String, Vec<u8>)>::new();
    for cell in &request.cells {
        if ulid::Ulid::from_string(&cell.note_id).is_err()
            || ulid::Ulid::from_string(&cell.property_id).is_err()
        {
            return Err("noteId and propertyId must be canonical ULIDs".to_owned());
        }
        if !property_ids.contains(cell.property_id.as_str()) {
            return Err(format!(
                "Property does not belong to database: {}",
                cell.property_id
            ));
        }
        let path = container
            .join(".ambd/records")
            .join(format!("{}.json", cell.note_id));
        let original = fs::read(&path).map_err(|error| error.to_string())?;
        if !planned.contains_key(&cell.note_id) {
            let parsed = parse_record(&original).map_err(|error| error.to_string())?;
            planned.insert(
                cell.note_id.clone(),
                (parsed.value, parsed.revision, original.clone()),
            );
        }
        let entry = planned
            .get_mut(&cell.note_id)
            .ok_or_else(|| "record plan disappeared".to_owned())?;
        if entry.1 != cell.expected_revision {
            return Err(format!("Record revision conflict for {}", cell.note_id));
        }
        let value = match cell.value_json.as_deref() {
            None => None,
            Some(raw) => Some(
                serde_json::from_str::<PropertyValue>(raw)
                    .map_err(|error| format!("Invalid value for {}: {error}", cell.property_id))?,
            ),
        };
        match value {
            Some(value) => {
                entry.0.values.insert(cell.property_id.clone(), value);
            }
            None => {
                entry.0.values.remove(&cell.property_id);
            }
        }
    }

    let mut replacements = Vec::new();
    for (note_id, (record, expected_revision, original)) in planned {
        let report = validate_record(&record, Some(&manifest.value));
        if !report.errors.is_empty() {
            return Err(format!("Invalid record batch for {note_id}"));
        }
        let parsed = parse_record(&original).map_err(|error| error.to_string())?;
        let prepared = prepare_json(&parsed, &record).map_err(|error| error.to_string())?;
        replacements.push((
            container
                .join(".ambd/records")
                .join(format!("{note_id}.json")),
            expected_revision,
            original,
            prepared.bytes,
        ));
    }

    for (path, _, _, bytes) in &replacements {
        crate::history::snapshot_before_write(vault, path, bytes, "database-value")?;
    }
    for (path, expected_revision, _, _) in &replacements {
        let current = fs::read(path).map_err(|error| error.to_string())?;
        if raw_revision(&current) != *expected_revision {
            return Err(format!("Record revision conflict for {}", path.display()));
        }
    }

    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    let mut journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        request_revision,
        status: "planned".to_owned(),
        steps: Vec::new(),
        result: None,
    };
    let setup_result = (|| {
        for (path, _, original, bytes) in &replacements {
            let note_id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .ok_or_else(|| "Record path has no note ID".to_owned())?;
            let backup_path = backup_dir.join(format!("{note_id}.json"));
            write_new(&backup_path, original)?;
            journal.steps.push(BatchRecoveryStep {
                record_path: format!(".ambd/records/{note_id}.json"),
                backup_path: format!(".ambd/recovery/{}/{note_id}.json", request.operation_id),
                original_revision: raw_revision(original),
                target_revision: raw_revision(bytes),
                status: "planned".to_owned(),
            });
        }
        write_new(&journal_path, &journal_bytes(&journal)?)
    })();
    if let Err(error) = setup_result {
        let _ = fs::remove_file(&journal_path);
        let _ = fs::remove_dir_all(&backup_dir);
        return Err(error);
    }
    journal.status = "inProgress".to_owned();
    write_batch_journal(&journal_path, &journal)?;

    let prepared_writes = watcher.prepare_write(
        replacements
            .iter()
            .map(|(path, _, _, bytes)| (path, watcher::fingerprint_for_bytes(bytes))),
    );
    for (index, (path, _, _, bytes)) in replacements.iter().enumerate() {
        let publish = frontmatter::atomic_write_bytes(path, bytes).and_then(|()| {
            journal.steps[index].status = "written".to_owned();
            write_batch_journal(&journal_path, &journal)
        });
        if let Err(error) = publish {
            watcher.cancel_prepared_write(&prepared_writes);
            return match rollback_batch_journal(&container, &journal_path, journal) {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(format!(
                    "{error}; rollback incomplete and recovery is required: {rollback_error}"
                )),
            };
        }
    }

    let result = DatabaseValueBatchResult {
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        revisions: replacements
            .iter()
            .map(|(path, _, _, bytes)| DatabaseNoteRevision {
                note_id: path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or_default()
                    .to_owned(),
                revision: raw_revision(bytes),
            })
            .collect(),
        warnings: Vec::new(),
    };
    journal.status = "completed".to_owned();
    journal.result = Some(result.clone());
    if let Err(error) = write_batch_journal(&journal_path, &journal) {
        watcher.cancel_prepared_write(&prepared_writes);
        return match rollback_batch_journal(&container, &journal_path, journal) {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(format!(
                "{error}; rollback incomplete and recovery is required: {rollback_error}"
            )),
        };
    }
    watcher.confirm_prepared_write(&prepared_writes);
    let _ = fs::remove_dir_all(backup_dir);
    Ok(result)
}

fn valid_operation_id(operation_id: &str) -> bool {
    !operation_id.is_empty()
        && operation_id.len() <= 160
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn journal_bytes(journal: &BatchRecoveryJournal) -> Result<Vec<u8>, String> {
    json_bytes(&serde_json::to_value(journal).map_err(|error| error.to_string())?)
}

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

fn write_batch_journal(path: &Path, journal: &BatchRecoveryJournal) -> Result<(), String> {
    frontmatter::atomic_write_bytes(path, &journal_bytes(journal)?)
}

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

    let target_database_id = rel_prop.config.target_database_id;
    let max_items = rel_prop.config.max_items;
    let inverse_property_id = rel_prop.config.inverse_property_id;

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

    // 1. Read current record of request.note_id to get previous target_note_ids
    let record_dir = container.join(".ambd/records");
    fs::create_dir_all(&record_dir).map_err(|error| error.to_string())?;
    let record_path = record_dir.join(format!("{}.json", request.note_id));
    let (mut current_record, current_original) = if record_path.exists() {
        let bytes = fs::read(&record_path).map_err(|error| error.to_string())?;
        let parsed = parse_record(&bytes).map_err(|error| error.to_string())?;
        (parsed.value, bytes)
    } else {
        let default_rec = RecordShard {
            format: "amby-database-record".to_owned(),
            format_version: 1,
            database_id: request.database_id.clone(),
            note_id: request.note_id.clone(),
            values: std::collections::BTreeMap::new(),
            yaml_sync_bases: std::collections::BTreeMap::new(),
            extra: Default::default(),
        };
        let bytes = serde_json::to_vec_pretty(&default_rec).map_err(|e| e.to_string())?;
        (default_rec, bytes)
    };

    let prev_targets = match current_record.values.get(&request.property_id) {
        Some(PropertyValue::Relation {
            target_note_ids, ..
        }) => target_note_ids.clone(),
        _ => Vec::new(),
    };

    if clean_targets.is_empty() {
        current_record.values.remove(&request.property_id);
    } else {
        current_record.values.insert(
            request.property_id.clone(),
            PropertyValue::Relation {
                target_note_ids: clean_targets.clone(),
                extra: Default::default(),
            },
        );
    }

    let report = validate_record(&current_record, Some(&manifest.value));
    if !report.errors.is_empty() {
        return Err(format!("Invalid record for {}", request.note_id));
    }
    let parsed_temp = parse_record(&current_original).map_err(|e| e.to_string())?;
    let prepared = prepare_json(&parsed_temp, &current_record).map_err(|e| e.to_string())?;
    crate::history::snapshot_before_write(vault, &record_path, &prepared.bytes, "database-value")?;
    let write = watcher.prepare_write([(
        &record_path,
        watcher::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&record_path, &prepared.bytes) {
        watcher.cancel_prepared_write(&write);
        return Err(error);
    }
    watcher.confirm_prepared_write(&write);

    // 2. If inversePropertyId exists, update the target notes reciprocally
    let warnings = Vec::new();
    if let Some(inv_prop_id) = inverse_property_id {
        if let Ok(target_container) = find_database_container(vault, &target_database_id) {
            let target_records_dir = target_container.join(".ambd/records");
            let _ = fs::create_dir_all(&target_records_dir);

            let added_targets = clean_targets
                .iter()
                .filter(|id| !prev_targets.contains(id))
                .collect::<Vec<_>>();
            let removed_targets = prev_targets
                .iter()
                .filter(|id| !clean_targets.contains(id))
                .collect::<Vec<_>>();

            for target_id in added_targets {
                let path = target_records_dir.join(format!("{target_id}.json"));
                let (mut rec, orig) = if path.exists() {
                    match fs::read(&path).map_err(|e| e.to_string()).and_then(|b| {
                        parse_record(&b)
                            .map(|p| (p.value, b))
                            .map_err(|e| e.to_string())
                    }) {
                        Ok(pair) => pair,
                        Err(_) => continue,
                    }
                } else {
                    let r = RecordShard {
                        format: "amby-database-record".to_owned(),
                        format_version: 1,
                        database_id: target_database_id.clone(),
                        note_id: target_id.clone(),
                        values: std::collections::BTreeMap::new(),
                        yaml_sync_bases: std::collections::BTreeMap::new(),
                        extra: Default::default(),
                    };
                    let b = serde_json::to_vec_pretty(&r).unwrap_or_default();
                    (r, b)
                };

                let mut list = match rec.values.get(&inv_prop_id) {
                    Some(PropertyValue::Relation {
                        target_note_ids, ..
                    }) => target_note_ids.clone(),
                    _ => Vec::new(),
                };
                if !list.contains(&request.note_id) {
                    list.push(request.note_id.clone());
                    rec.values.insert(
                        inv_prop_id.clone(),
                        PropertyValue::Relation {
                            target_note_ids: list,
                            extra: Default::default(),
                        },
                    );
                    if let Ok(p) = parse_record(&orig) {
                        if let Ok(prep) = prepare_json(&p, &rec) {
                            let _ = crate::history::snapshot_before_write(
                                vault,
                                &path,
                                &prep.bytes,
                                "database-value",
                            );
                            let w = watcher.prepare_write([(
                                &path,
                                watcher::fingerprint_for_bytes(&prep.bytes),
                            )]);
                            if frontmatter::atomic_write_bytes(&path, &prep.bytes).is_ok() {
                                watcher.confirm_prepared_write(&w);
                            } else {
                                watcher.cancel_prepared_write(&w);
                            }
                        }
                    }
                }
            }

            for target_id in removed_targets {
                let path = target_records_dir.join(format!("{target_id}.json"));
                if !path.exists() {
                    continue;
                }
                if let Ok((mut rec, orig)) =
                    fs::read(&path).map_err(|e| e.to_string()).and_then(|b| {
                        parse_record(&b)
                            .map(|p| (p.value, b))
                            .map_err(|e| e.to_string())
                    })
                {
                    if let Some(PropertyValue::Relation {
                        target_note_ids, ..
                    }) = rec.values.get_mut(&inv_prop_id)
                    {
                        if target_note_ids.contains(&request.note_id) {
                            target_note_ids.retain(|id| id != &request.note_id);
                            if let Ok(p) = parse_record(&orig) {
                                if let Ok(prep) = prepare_json(&p, &rec) {
                                    let _ = crate::history::snapshot_before_write(
                                        vault,
                                        &path,
                                        &prep.bytes,
                                        "database-value",
                                    );
                                    let w = watcher.prepare_write([(
                                        &path,
                                        watcher::fingerprint_for_bytes(&prep.bytes),
                                    )]);
                                    if frontmatter::atomic_write_bytes(&path, &prep.bytes).is_ok() {
                                        watcher.confirm_prepared_write(&w);
                                    } else {
                                        watcher.cancel_prepared_write(&w);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(UpdateDatabaseRelationValueResult {
        database_id: request.database_id.clone(),
        note_id: request.note_id.clone(),
        target_note_ids: clean_targets,
        warnings,
    })
}

fn find_database_container(vault: &Path, database_id: &str) -> Result<PathBuf, String> {
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
        let view = super::super::format::parse_view(&fs::read(&result.view_path).unwrap()).unwrap();
        let validation = super::super::validation::validate_view(&view.value, None);
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
        let first = apply_value_batch(&vault, &watcher, &request).unwrap();
        let replay = apply_value_batch(&vault, &watcher, &request).unwrap();
        assert_eq!(first, replay);
        let journal_path = vault
            .join("Projects/.ambd/recovery")
            .join(format!("{}.json", request.operation_id));
        let journal = read_batch_journal(&journal_path).unwrap();
        assert_eq!(journal.status, "completed");
        assert_eq!(journal.result, Some(first));
        assert!(!vault
            .join("Projects/.ambd/recovery")
            .join(&request.operation_id)
            .exists());
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
        )
        .unwrap();

        // Check task record
        let task_rec_path = Path::new(&tasks_db.manifest_path)
            .parent()
            .unwrap()
            .join(format!(".ambd/records/{task_note_id}.json"));
        let task_rec = parse_record(&fs::read(&task_rec_path).unwrap())
            .unwrap()
            .value;
        match task_rec.values.get(&tasks_rel.property_id) {
            Some(PropertyValue::Relation {
                target_note_ids, ..
            }) => {
                assert_eq!(target_note_ids, &[project_note_id.clone()]);
            }
            other => panic!("expected relation value, got {other:?}"),
        }

        // Check project record was reciprocally updated!
        let project_rec_path = Path::new(&projects_db.manifest_path)
            .parent()
            .unwrap()
            .join(format!(".ambd/records/{project_note_id}.json"));
        let project_rec = parse_record(&fs::read(&project_rec_path).unwrap())
            .unwrap()
            .value;
        match project_rec.values.get(&inverse_id) {
            Some(PropertyValue::Relation {
                target_note_ids, ..
            }) => {
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
        )
        .unwrap();

        let project_rec_after = parse_record(&fs::read(&project_rec_path).unwrap())
            .unwrap()
            .value;
        match project_rec_after.values.get(&inverse_id) {
            Some(PropertyValue::Relation {
                target_note_ids, ..
            }) => {
                assert!(target_note_ids.is_empty());
            }
            None => {} // valid if emptied or removed
            other => panic!("expected empty inverse relation, got {other:?}"),
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
}
