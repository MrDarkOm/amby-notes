//! Database creation and durable, conflict-aware metadata/schema/value mutations.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::format::{
    parse_manifest, parse_record, prepare_json, PropertyDefinition, PropertyValue, RecordShard,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
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
    let manifest_path = container.join("ambd.json");
    let view_path = container
        .join(".ambd/views")
        .join(format!("{view_id}.json"));
    if manifest_path.exists() {
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

    let manifest = json!({
        "format": "amby-database",
        "formatVersion": 1,
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
    let manifest_path = container.join("ambd.json");
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

pub fn delete_database_property(
    vault: &Path,
    watcher: &WatcherState,
    request: &DeleteDatabasePropertyRequest,
) -> Result<DeletedDatabaseProperty, String> {
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = container.join("ambd.json");
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
    let manifest_path = container.join("ambd.json");
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
    let manifest_path = container.join("ambd.json");
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
    let manifest_path = container.join("ambd.json");
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
    let manifest_path = container.join("ambd.json");
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
        let manifest_path = vault.join("Projects/ambd.json");
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
            operation_id,
            database_id: ulid::Ulid::generate().to_string(),
            request_revision: "request".to_owned(),
            status: "inProgress".to_owned(),
            steps: vec![BatchRecoveryStep {
                record_path: format!(".ambd/records/{note_id}.json"),
                backup_path: backup_path
                    .strip_prefix(&container)
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
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
}
