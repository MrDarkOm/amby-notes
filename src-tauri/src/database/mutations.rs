//! Database creation and durable, conflict-aware metadata/schema/value mutations.

use crate::durable::valid_operation_id;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::format::{
    parse_manifest, parse_template, prepare_json, PropertyDefinition, PropertyFields,
    PropertyValue, YamlBinding,
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
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub expected_target_manifest_revision: Option<String>,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabaseProperty {
    pub database_id: String,
    pub property_id: String,
    pub name: String,
    pub property_type: String,
    pub manifest_revision: String,
    pub operation_id: Option<String>,
    pub inverse_property_id: Option<String>,
    pub manifest_revisions: Vec<DatabaseManifestRevision>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseManifestRevision {
    pub database_id: String,
    pub revision: String,
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
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub expected_related_manifest_revisions: Vec<DatabaseManifestRevision>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseRelationValueRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub expected_revision: String,
    pub database_id: String,
    pub note_id: String,
    pub property_id: String,
    pub target_note_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseAffectedNote {
    pub database_id: String,
    pub note_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseRelationValueResult {
    pub operation_id: String,
    pub database_id: String,
    pub note_id: String,
    pub target_note_ids: Vec<String>,
    pub affected_notes: Vec<DatabaseAffectedNote>,
    pub revisions: Vec<DatabaseNoteRevision>,
    pub warnings: Vec<String>,
}

pub(super) struct RelationPlannedWrite {
    pub(super) path: PathBuf,
    pub(super) post_bytes: Vec<u8>,
    pub(super) pre_bytes: Vec<u8>,
    pub(super) affected_note: DatabaseAffectedNote,
}

#[cfg(test)]
type RelationBeforePublishHook = Box<dyn FnOnce()>;
#[cfg(test)]
type RelationBeforeWriteHook = Box<dyn FnMut(usize)>;

#[cfg(test)]
thread_local! {
    static RELATION_BEFORE_PUBLISH_HOOK: std::cell::RefCell<Option<RelationBeforePublishHook>> = const { std::cell::RefCell::new(None) };
    static RELATION_BEFORE_WRITE_HOOK: std::cell::RefCell<Option<RelationBeforeWriteHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_relation_before_publish_hook(hook: RelationBeforePublishHook) {
    RELATION_BEFORE_PUBLISH_HOOK.with(|pending| *pending.borrow_mut() = Some(hook));
}

#[cfg(test)]
fn set_relation_before_write_hook(hook: RelationBeforeWriteHook) {
    RELATION_BEFORE_WRITE_HOOK.with(|pending| *pending.borrow_mut() = Some(hook));
}

fn check_relation_file_revision(
    vault: &Path,
    path: &Path,
    expected: &[u8],
    kind: &str,
) -> Result<(), String> {
    if crate::paths::confine(vault, path)? != path {
        return Err(format!("Relation {kind} path changed before publication"));
    }
    let current =
        fs::read(path).map_err(|error| format!("Relation {kind} revision conflict: {error}"))?;
    if current != expected {
        return Err(format!("Relation {kind} revision conflict"));
    }
    Ok(())
}

fn check_relation_manifest_revisions(
    vault: &Path,
    manifests: &[(PathBuf, Vec<u8>)],
) -> Result<(), String> {
    for (path, bytes) in manifests {
        check_relation_file_revision(vault, path, bytes, "manifest")?;
    }
    Ok(())
}

fn rollback_relation_writes(vault: &Path, written: &[&RelationPlannedWrite]) -> Vec<String> {
    let mut errors = Vec::new();
    for planned in written.iter().rev() {
        let result = (|| {
            if crate::paths::confine(vault, &planned.path)? != planned.path {
                return Err("path changed; rollback refused".to_owned());
            }
            let current = fs::read(&planned.path).map_err(|error| error.to_string())?;
            if current == planned.pre_bytes {
                return Ok(());
            }
            if current != planned.post_bytes {
                return Err("file changed externally; rollback refused".to_owned());
            }
            frontmatter::atomic_write_bytes(&planned.path, &planned.pre_bytes)
        })();
        if let Err(error) = result {
            errors.push(format!("{}: {error}", planned.affected_note.note_id));
        }
    }
    errors
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDatabasePropertyType {
    pub database_id: String,
    pub property_id: String,
    pub property_type: String,
    pub manifest_revision: String,
    pub operation_id: Option<String>,
    pub inverse_property_id: Option<String>,
    pub manifest_revisions: Vec<DatabaseManifestRevision>,
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
    let two_way = request.property_type == "relation" && request.relation_two_way == Some(true);
    if two_way {
        if let Some(result) = super::relation_schema_recovery::replay(vault, request)? {
            return Ok(result);
        }
    }
    super::relation_schema_recovery::ensure_no_pending(vault)?;
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
    if request.property_type == "relation" {
        ensure_relation_name_available(&parsed.value, name)?;
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

    // Validate the requested insertion before preparing the reciprocal schema.
    // No target manifest may be published while the source is still fallible.
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
    let mut target_write = None;

    // Prepare both schemas without filesystem writes. The durable publisher
    // compares all originals, journals them, then publishes the complete plan.
    if two_way {
        let target_database_id = config
            .get("targetDatabaseId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&request.database_id);
        let inv_id = config
            .get("inversePropertyId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Failed to generate inverse property ID".to_owned())?;

        if target_database_id == request.database_id {
            if request
                .expected_target_manifest_revision
                .as_deref()
                .is_some_and(|revision| revision != request.expected_manifest_revision)
            {
                return Err("Target manifest revision conflict".to_owned());
            }
            let inv_name = request
                .relation_inverse_property_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Обратная связь");
            ensure_relation_name_available(&manifest, inv_name)?;
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
            if request.expected_target_manifest_revision.as_deref() != Some(&target_parsed.revision)
            {
                return Err("Target manifest revision conflict".to_owned());
            }
            if target_parsed.value.locked {
                return Err("Target database is locked".to_owned());
            }
            let inv_name = request
                .relation_inverse_property_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&parsed.value.name);
            ensure_relation_name_available(&target_parsed.value, inv_name)?;
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
            target_write = Some(super::relation_schema_recovery::SchemaPlannedWrite {
                database_id: target_database_id.to_owned(),
                path: target_manifest_path,
                pre_bytes: target_original,
                post_bytes: target_prepared.bytes,
            });
        }
    }

    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    let mut result = CreatedDatabaseProperty {
        database_id: request.database_id.clone(),
        property_id,
        name: name.to_owned(),
        property_type: request.property_type.clone(),
        manifest_revision: prepared.revision.clone(),
        operation_id: two_way.then(|| request.operation_id.clone()).flatten(),
        inverse_property_id: config
            .get("inversePropertyId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        manifest_revisions: vec![DatabaseManifestRevision {
            database_id: request.database_id.clone(),
            revision: prepared.revision,
        }],
        warnings: Vec::new(),
    };
    if two_way {
        let mut writes = vec![super::relation_schema_recovery::SchemaPlannedWrite {
            database_id: request.database_id.clone(),
            path: manifest_path,
            pre_bytes: original,
            post_bytes: prepared.bytes,
        }];
        if let Some(target_write) = target_write {
            result.manifest_revisions.push(DatabaseManifestRevision {
                database_id: target_write.database_id.clone(),
                revision: raw_revision(&target_write.post_bytes),
            });
            writes.push(target_write);
        }
        super::relation_schema_recovery::publish(vault, watcher, request, &writes, &result)?;
        return Ok(result);
    }
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
    Ok(result)
}

fn ensure_relation_name_available(
    manifest: &super::format::DatabaseManifest,
    name: &str,
) -> Result<(), String> {
    if super::format::is_reserved_system_key(name)
        || manifest.properties.iter().any(|property| {
            let opaque_collision = if let PropertyDefinition::Opaque(value) = property {
                [
                    value.get("name"),
                    value.get("id"),
                    value.pointer("/yamlBinding/key"),
                ]
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .any(|key| key.trim().eq_ignore_ascii_case(name))
            } else {
                false
            };
            opaque_collision
                || property
                    .name()
                    .is_some_and(|existing| existing.trim().eq_ignore_ascii_case(name))
                || property
                    .id()
                    .is_some_and(|id| id.eq_ignore_ascii_case(name))
                || (!matches!(
                    property,
                    PropertyDefinition::Formula(_) | PropertyDefinition::Rollup(_)
                ) && property
                    .frontmatter_key()
                    .is_some_and(|key| key.trim().eq_ignore_ascii_case(name)))
        })
    {
        return Err(
            "Relation property name conflicts with an existing property or YAML key".to_owned(),
        );
    }
    Ok(())
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

fn relation_targets_from_mapping(
    mapping: &serde_yaml::Mapping,
    property: &PropertyDefinition,
) -> Result<bool, String> {
    let mut aliases = Vec::new();
    if let Some(key) = property.storage_key() {
        aliases.push(key);
    }
    if let Some(id) = property.id() {
        aliases.push(id);
    }
    if let Some(name) = property.name() {
        aliases.push(name);
    }
    let mut found = false;
    let mut nonempty = false;
    for (key, value) in mapping {
        let serde_yaml::Value::String(key) = key else {
            continue;
        };
        if !aliases
            .iter()
            .any(|alias| alias.trim().eq_ignore_ascii_case(key.trim()))
        {
            continue;
        }
        found = true;
        let items = match value {
            serde_yaml::Value::Sequence(items) => items
                .iter()
                .map(|item| {
                    item.as_str()
                        .ok_or_else(|| "Invalid stored relation value".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?,
            serde_yaml::Value::String(item) => vec![item.as_str()],
            serde_yaml::Value::Null => Vec::new(),
            _ => return Err("Invalid stored relation value".to_owned()),
        };
        for item in items {
            let item = item.trim();
            let id = match item.strip_prefix("[[") {
                Some(inner) => inner
                    .strip_suffix("]]")
                    .ok_or_else(|| "Invalid stored relation target ID".to_owned())?
                    .trim(),
                None => item,
            };
            if !frontmatter::is_amby_id(id) {
                return Err("Invalid stored relation target ID".to_owned());
            }
            nonempty = true;
        }
    }
    Ok(found && nonempty)
}

fn ensure_property_has_no_durable_values(
    vault: &Path,
    database_id: &str,
    container: &Path,
    property: &PropertyDefinition,
) -> Result<(), String> {
    let canonical_vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let vault = canonical_vault.as_path();
    let property_id = property.id().unwrap_or_default();
    let prop_name = property.name();
    let prop_key = property.frontmatter_key();

    let discovery = super::discovery::discover_vault(vault)?;
    let container_relative = container
        .strip_prefix(vault)
        .map_err(|_| "Database container is outside the vault".to_owned())?
        .to_string_lossy()
        .replace('\\', "/");
    let nested_containers = discovery
        .databases
        .iter()
        .filter(|database| {
            database.database_id != database_id && database.container_path.starts_with(container)
        })
        .map(|database| database.container_path.clone())
        .collect::<Vec<_>>();
    for diagnostic in &discovery.diagnostics {
        if !matches!(
            diagnostic.severity,
            super::discovery::DiagnosticSeverity::Error
        ) {
            continue;
        }
        let in_container = container_relative.is_empty()
            || diagnostic.path == container_relative
            || diagnostic
                .path
                .strip_prefix(&container_relative)
                .is_some_and(|suffix| suffix.starts_with('/'));
        let diagnostic_path = vault.join(&diagnostic.path);
        let in_nested = nested_containers.iter().any(|nested| {
            diagnostic_path.starts_with(nested)
                && discovery
                    .databases
                    .iter()
                    .find(|database| database.container_path == *nested)
                    .and_then(|database| database.attached_note_path.as_ref())
                    != Some(&diagnostic_path)
        });
        if in_container && !in_nested {
            return Err(format!(
                "Cannot safely inspect database-owned values at {}: {}",
                diagnostic.path, diagnostic.message
            ));
        }
    }
    for note in discovery
        .notes
        .iter()
        .filter(|note| note.owner_database_id.as_deref() == Some(database_id))
    {
        let content = fs::read_to_string(&note.path).map_err(|error| error.to_string())?;
        let mapping = frontmatter::frontmatter_yaml_mapping(&content)
            .map_err(|error| format!("Invalid YAML in {}: {error}", note.relative_path))?;
        let Some(mapping) = mapping else {
            continue;
        };
        let has_prop = if property.kind() == "relation" {
            relation_targets_from_mapping(&mapping, property)?
        } else {
            mapping.iter().any(|(k, _)| {
                if let serde_yaml::Value::String(k_str) = k {
                    let k_trim = k_str.trim();
                    k_trim.eq_ignore_ascii_case(property_id)
                        || prop_name.is_some_and(|pn| k_trim.eq_ignore_ascii_case(pn))
                        || prop_key.is_some_and(|pk| k_trim.eq_ignore_ascii_case(pk))
                } else {
                    false
                }
            })
        };
        if has_prop {
            return Err(
                "Property type can only be changed after its existing values are cleared"
                    .to_owned(),
            );
        }
    }

    // The legacy record/template stores are scoped to this database
    // container. Read/parse failures are fatal so a conversion cannot
    // silently proceed around an unreadable durable value.
    let records_dir = container.join(".ambd/records");
    let records_present = match fs::symlink_metadata(&records_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Database record store is a symbolic link".to_owned());
        }
        Ok(metadata) if metadata.is_dir() => true,
        Ok(_) => return Err("Database record store is not a directory".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    if records_present {
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
            let has_value = parsed.value.values.get(property_id).is_some_and(|value| {
                !matches!(
                    value,
                    super::format::PropertyValue::Relation { target_note_ids, .. }
                        if target_note_ids.is_empty()
                )
            });
            if has_value || parsed.value.yaml_sync_bases.contains_key(property_id) {
                return Err(
                    "Property type can only be changed after its existing values are cleared"
                        .to_owned(),
                );
            }
        }
    }

    let templates_dir = container.join(".ambd/templates");
    let templates_present = match fs::symlink_metadata(&templates_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Database template store is a symbolic link".to_owned());
        }
        Ok(metadata) if metadata.is_dir() => true,
        Ok(_) => return Err("Database template store is not a directory".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    if templates_present {
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
            let has_value = parsed.value.values.get(property_id).is_some_and(|value| {
                !matches!(
                    value,
                    super::format::PropertyValue::Relation { target_note_ids, .. }
                        if target_note_ids.is_empty()
                )
            });
            if has_value {
                return Err(
                    "Property type can only be changed after its template values are cleared"
                        .to_owned(),
                );
            }
        }
    }
    Ok(())
}

fn manifest_revision_is_valid(revision: &str) -> bool {
    revision.len() == 64
        && revision
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn normalize_relation_max_items(value: Option<u8>) -> Option<u8> {
    value.and_then(|limit| (limit == 1).then_some(1))
}

fn related_revision_map(
    request: &ChangeDatabasePropertyTypeRequest,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut revisions = std::collections::BTreeMap::new();
    for revision in &request.expected_related_manifest_revisions {
        if !frontmatter::is_amby_id(&revision.database_id)
            || revision.database_id == request.database_id
            || !manifest_revision_is_valid(&revision.revision)
            || revisions
                .insert(revision.database_id.clone(), revision.revision.clone())
                .is_some()
        {
            return Err("Invalid related manifest revision".to_owned());
        }
    }
    Ok(revisions)
}

fn relation_config(
    property: &PropertyDefinition,
) -> Option<(&str, &str, Option<u8>, Option<&str>)> {
    match property {
        PropertyDefinition::Relation(fields) => Some((
            fields.id.as_str(),
            fields.config.target_database_id.as_str(),
            fields.config.max_items,
            fields.config.inverse_property_id.as_deref(),
        )),
        _ => None,
    }
}

fn property_with_relation_config(
    property: &PropertyDefinition,
    target_database_id: &str,
    max_items: Option<u8>,
    inverse_property_id: Option<&str>,
) -> Result<PropertyDefinition, String> {
    let mut value = serde_json::to_value(property).map_err(|error| error.to_string())?;
    value["type"] = serde_json::Value::String("relation".to_owned());
    let config = value
        .get_mut("config")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "Relation property config is not editable".to_owned())?;
    config.insert(
        "targetDatabaseId".to_owned(),
        serde_json::Value::String(target_database_id.to_owned()),
    );
    config.insert(
        "maxItems".to_owned(),
        max_items.map_or(serde_json::Value::Null, |value| json!(value)),
    );
    config.insert(
        "inversePropertyId".to_owned(),
        inverse_property_id.map_or(serde_json::Value::Null, |value| {
            serde_json::Value::String(value.to_owned())
        }),
    );
    serde_json::from_value(value).map_err(|error| error.to_string())
}

fn property_with_type_and_config(
    property: &PropertyDefinition,
    property_type: &str,
    config: serde_json::Value,
) -> Result<PropertyDefinition, String> {
    let mut value = serde_json::to_value(property).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Property definition is not editable".to_owned())?;
    object.insert(
        "type".to_owned(),
        serde_json::Value::String(property_type.to_owned()),
    );
    let mut merged_config = object
        .get("config")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    let requested_config = config
        .as_object()
        .ok_or_else(|| "Property configuration must be an object".to_owned())?;
    for (key, value) in requested_config {
        merged_config.insert(key.clone(), value.clone());
    }
    object.insert(
        "config".to_owned(),
        serde_json::Value::Object(merged_config),
    );
    serde_json::from_value(value).map_err(|error| error.to_string())
}

fn relation_inverse_property(
    id: &str,
    name: &str,
    source_database_id: &str,
    source_property_id: &str,
) -> Result<PropertyDefinition, String> {
    serde_json::from_value(json!({
        "type": "relation",
        "id": id,
        "name": name,
        "pageVisibility": "alwaysShow",
        "yamlBinding": null,
        "config": {
            "targetDatabaseId": source_database_id,
            "maxItems": null,
            "inversePropertyId": source_property_id,
        },
    }))
    .map_err(|error| error.to_string())
}

fn relation_property_mut<'a>(
    manifest: &'a mut super::format::DatabaseManifest,
    property_id: &str,
) -> Result<&'a mut PropertyDefinition, String> {
    manifest
        .properties
        .iter_mut()
        .find(|property| property.id() == Some(property_id))
        .ok_or_else(|| "Related inverse property was not found".to_owned())
}

pub fn change_database_property_type(
    vault: &Path,
    watcher: &WatcherState,
    request: &ChangeDatabasePropertyTypeRequest,
) -> Result<ChangedDatabasePropertyType, String> {
    let operation_may_be_relation =
        request.property_type == "relation" || request.operation_id.is_some();
    if operation_may_be_relation {
        if let Some(result) = super::relation_schema_recovery::replay_type_change(vault, request)? {
            return Ok(result);
        }
        super::relation_schema_recovery::ensure_no_pending(vault)?;
        super::relation_recovery::ensure_no_pending(vault)?;
    }

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
    let index = parsed
        .value
        .properties
        .iter()
        .position(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property was not found".to_owned())?;
    let current_property = parsed.value.properties[index].clone();
    let old_relation = relation_config(&current_property);
    let new_relation = request.property_type == "relation";
    if (old_relation.is_some() || new_relation)
        && request
            .operation_id
            .as_deref()
            .is_none_or(|id| id.is_empty())
    {
        return Err("Relation property changes require operationId".to_owned());
    }

    if old_relation.is_none() && !new_relation && current_property.kind() == request.property_type {
        return Ok(ChangedDatabasePropertyType {
            database_id: request.database_id.clone(),
            property_id: request.property_id.clone(),
            property_type: request.property_type.clone(),
            manifest_revision: parsed.revision.clone(),
            operation_id: None,
            inverse_property_id: None,
            manifest_revisions: vec![DatabaseManifestRevision {
                database_id: request.database_id.clone(),
                revision: parsed.revision,
            }],
            warnings: Vec::new(),
        });
    }

    let related_revisions = related_revision_map(request)?;
    let old_relation_target = old_relation.map(|(_, target, _, _)| target.to_owned());
    let old_inverse_id = old_relation.and_then(|(_, _, _, inverse)| inverse.map(str::to_owned));
    if old_inverse_id.as_deref() == Some(request.property_id.as_str()) {
        return Err("Relation inverse property cannot be the source property".to_owned());
    }
    let target_database_id = if new_relation {
        request
            .relation_target_database_id
            .as_deref()
            .or(old_relation_target.as_deref())
            .unwrap_or(&request.database_id)
            .to_owned()
    } else {
        request.database_id.clone()
    };
    if new_relation && !frontmatter::is_amby_id(&target_database_id) {
        return Err("Invalid Relation target database ID".to_owned());
    }
    let old_max_items = old_relation.and_then(|(_, _, max_items, _)| max_items);
    let max_items = if new_relation {
        request.relation_max_items.map_or(old_max_items, |value| {
            normalize_relation_max_items(Some(value))
        })
    } else {
        None
    };
    let old_two_way = old_inverse_id.is_some();
    let new_two_way = new_relation && request.relation_two_way.unwrap_or(old_two_way);
    let topology_changed = old_relation.is_some()
        && (!new_relation
            || old_relation_target.as_deref() != Some(target_database_id.as_str())
            || old_two_way != new_two_way
            || old_max_items != max_items);

    if current_property.kind() != request.property_type && current_property.yaml_binding().is_some()
    {
        return Err("Remove the YAML binding before changing the property type".to_owned());
    }
    for property in &parsed.value.properties {
        let referenced = match property {
            PropertyDefinition::Formula(fields) => {
                fields
                    .config
                    .dependencies
                    .iter()
                    .any(|dependency| dependency == &request.property_id)
                    || super::formula::extract_dependencies(&fields.config.expression).is_ok_and(
                        |dependencies| {
                            dependencies.iter().any(|dependency| {
                                dependency == &request.property_id
                                    || Some(dependency.as_str()) == current_property.name()
                            })
                        },
                    )
            }
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

    if old_relation.is_none() || topology_changed {
        ensure_property_has_no_durable_values(
            vault,
            &request.database_id,
            &container,
            &current_property,
        )?;
    }
    let mut related = std::collections::BTreeMap::<
        String,
        (
            PathBuf,
            Vec<u8>,
            super::format::ParsedJson<super::format::DatabaseManifest>,
            super::format::DatabaseManifest,
        ),
    >::new();
    let mut load_related = |database_id: &str| -> Result<(), String> {
        if database_id == request.database_id || related.contains_key(database_id) {
            return Ok(());
        }
        let expected = related_revisions.get(database_id).ok_or_else(|| {
            format!("Expected manifest revision is required for related database {database_id}")
        })?;
        let related_container = find_database_container(vault, database_id)?;
        let related_path = super::discovery::manifest_path_for_container(&related_container);
        let related_bytes = fs::read(&related_path).map_err(|error| error.to_string())?;
        let related_parsed = parse_manifest(&related_bytes).map_err(|error| error.to_string())?;
        if related_parsed.revision != *expected {
            return Err("Related manifest revision conflict".to_owned());
        }
        if !related_parsed.is_writable() {
            return Err("Related database manifest is read-only".to_owned());
        }
        if related_parsed.value.locked {
            return Err("Related database is locked".to_owned());
        }
        related.insert(
            database_id.to_owned(),
            (
                related_path,
                related_bytes,
                related_parsed.clone(),
                related_parsed.value.clone(),
            ),
        );
        Ok(())
    };

    if let Some(old_target) = old_relation_target.as_deref() {
        if old_inverse_id.is_some() && old_target != request.database_id {
            load_related(old_target)?;
        }
    }
    if new_relation && target_database_id != request.database_id {
        load_related(&target_database_id)?;
    }
    if related.keys().any(|id| !related_revisions.contains_key(id)) {
        return Err("Related manifest revisions must match every related manifest".to_owned());
    }

    let mut source_manifest = parsed.value.clone();

    // Detach the former counterpart before deciding whether a new target needs
    // an inverse. The counterpart remains in place with all unknown metadata.
    if let Some(old_inverse_id) = old_inverse_id.as_deref() {
        let old_target = old_relation_target
            .as_deref()
            .ok_or_else(|| "Relation inverse has no target database".to_owned())?;
        let old_manifest = if old_target == request.database_id {
            &mut source_manifest
        } else {
            &mut related
                .get_mut(old_target)
                .ok_or_else(|| "Old Relation target was not loaded".to_owned())?
                .3
        };
        let inverse = relation_property_mut(old_manifest, old_inverse_id)?;
        let Some((_, inverse_target, _, inverse_inverse)) = relation_config(inverse) else {
            return Err("Related inverse property is not a Relation".to_owned());
        };
        if inverse_target != request.database_id
            || inverse_inverse != Some(request.property_id.as_str())
        {
            return Err("Related inverse property is not reciprocal".to_owned());
        }
        let inverse_before = inverse.clone();
        if topology_changed {
            let inverse_container = if old_target == request.database_id {
                container.clone()
            } else {
                find_database_container(vault, old_target)?
            };
            ensure_property_has_no_durable_values(
                vault,
                old_target,
                &inverse_container,
                &inverse_before,
            )?;
        }
        if !new_two_way || old_target != target_database_id {
            *inverse = property_with_relation_config(
                &inverse_before,
                request.database_id.as_str(),
                relation_config(&inverse_before).and_then(|(_, _, max, _)| max),
                None,
            )?;
        }
    }

    let inverse_property_id = if new_relation && new_two_way {
        if old_target_matches(old_relation_target.as_deref(), target_database_id.as_str())
            && old_inverse_id.is_some()
        {
            old_inverse_id.clone()
        } else {
            Some(ulid::Ulid::generate().to_string())
        }
    } else {
        None
    };
    let source_property = if new_relation {
        property_with_relation_config(
            &current_property,
            &target_database_id,
            max_items,
            inverse_property_id.as_deref(),
        )?
    } else {
        let config = default_property_config(
            &request.property_type,
            &request.database_id,
            None,
            None,
            None,
        )?;
        property_with_type_and_config(&current_property, &request.property_type, config)?
    };
    source_manifest.properties[index] = source_property;

    if new_relation && new_two_way {
        let inverse_id = inverse_property_id
            .as_deref()
            .ok_or_else(|| "Failed to determine Relation inverse ID".to_owned())?;
        let inverse_exists = if target_database_id == request.database_id {
            source_manifest
                .properties
                .iter()
                .any(|property| property.id() == Some(inverse_id))
        } else {
            related
                .get(&target_database_id)
                .is_some_and(|(_, _, _, manifest)| {
                    manifest
                        .properties
                        .iter()
                        .any(|property| property.id() == Some(inverse_id))
                })
        };
        if !inverse_exists {
            let target_manifest = if target_database_id == request.database_id {
                &mut source_manifest
            } else {
                &mut related
                    .get_mut(&target_database_id)
                    .ok_or_else(|| "New Relation target was not loaded".to_owned())?
                    .3
            };
            let inverse_name = request
                .relation_inverse_property_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| {
                    if target_database_id == request.database_id {
                        "Обратная связь"
                    } else {
                        current_property.name().unwrap_or("Обратная связь")
                    }
                });
            ensure_relation_name_available(target_manifest, inverse_name)?;
            target_manifest.properties.push(relation_inverse_property(
                inverse_id,
                inverse_name,
                &request.database_id,
                &request.property_id,
            )?);
        } else {
            let target_manifest = if target_database_id == request.database_id {
                &mut source_manifest
            } else {
                &mut related
                    .get_mut(&target_database_id)
                    .ok_or_else(|| "New Relation target was not loaded".to_owned())?
                    .3
            };
            let inverse = relation_property_mut(target_manifest, inverse_id)?;
            let inverse_before = inverse.clone();
            if relation_config(&inverse_before).is_none_or(|(_, target, _, inverse)| {
                target != request.database_id || inverse != Some(request.property_id.as_str())
            }) {
                return Err("Existing Relation inverse is not reciprocal".to_owned());
            }
            *inverse = property_with_relation_config(
                &inverse_before,
                &request.database_id,
                relation_config(&inverse_before).and_then(|(_, _, max, _)| max),
                Some(&request.property_id),
            )?;
        }
    }

    let report = validate_manifest(&source_manifest);
    if !report.errors.is_empty() {
        return Err("Property type change would make the database manifest invalid".to_owned());
    }
    for (_, _, _, manifest) in related.values() {
        let report = validate_manifest(manifest);
        if !report.errors.is_empty() {
            return Err("Related property type change would make a manifest invalid".to_owned());
        }
    }

    let read_guard_paths = related
        .values()
        .map(|(path, original, _, manifest)| (path.clone(), original.clone(), manifest.clone()))
        .collect::<Vec<_>>();
    let source_prepared =
        prepare_json(&parsed, &source_manifest).map_err(|error| error.to_string())?;
    let mut writes = vec![super::relation_schema_recovery::SchemaPlannedWrite {
        database_id: request.database_id.clone(),
        path: manifest_path,
        pre_bytes: original,
        post_bytes: source_prepared.bytes,
    }];
    let mut manifest_revisions = vec![DatabaseManifestRevision {
        database_id: request.database_id.clone(),
        revision: source_prepared.revision.clone(),
    }];
    for (database_id, (path, original, parsed, manifest)) in related {
        if manifest == parsed.value {
            continue;
        }
        let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
        writes.push(super::relation_schema_recovery::SchemaPlannedWrite {
            database_id: database_id.clone(),
            path,
            pre_bytes: original,
            post_bytes: prepared.bytes.clone(),
        });
        manifest_revisions.push(DatabaseManifestRevision {
            database_id,
            revision: prepared.revision,
        });
    }
    if writes.len() > 1 && related_revisions.len() < writes.len() - 1 {
        return Err("Related manifest revisions are incomplete".to_owned());
    }

    let mut result = ChangedDatabasePropertyType {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        property_type: request.property_type.clone(),
        manifest_revision: manifest_revisions[0].revision.clone(),
        operation_id: request.operation_id.clone(),
        inverse_property_id,
        manifest_revisions,
        warnings: Vec::new(),
    };
    for (path, original, _) in read_guard_paths {
        if writes.iter().any(|write| write.path == path) {
            continue;
        }
        check_relation_file_revision(vault, &path, &original, "related manifest")?;
    }
    if writes
        .iter()
        .all(|write| write.pre_bytes == write.post_bytes)
    {
        // No durable operation is published for an unchanged request. Do not
        // report its caller-supplied ID as a persisted replayable outcome.
        result.operation_id = None;
        return Ok(result);
    }
    if old_relation.is_none() && !new_relation {
        let current = fs::read(&writes[0].path).map_err(|error| error.to_string())?;
        if current != writes[0].pre_bytes {
            return Err("Manifest revision conflict".to_owned());
        }
        crate::history::snapshot_before_write(
            vault,
            &writes[0].path,
            &writes[0].post_bytes,
            "database-schema",
        )?;
        let prepared_write = watcher.prepare_write([(
            writes[0].path.clone(),
            watcher::fingerprint_for_bytes(&writes[0].post_bytes),
        )]);
        if let Err(error) = frontmatter::atomic_write_bytes(&writes[0].path, &writes[0].post_bytes)
        {
            watcher.cancel_prepared_write(&prepared_write);
            return Err(error);
        }
        watcher.confirm_prepared_write(&prepared_write);
        return Ok(result);
    }
    super::relation_schema_recovery::publish_type_change(
        vault, watcher, request, &writes, &result,
    )?;
    Ok(result)
}

fn old_target_matches(old_target: Option<&str>, new_target: &str) -> bool {
    old_target == Some(new_target)
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

/// Pin a legacy field's existing YAML key before changing its display name.
/// Renaming is a manifest-only operation; note bytes remain user-owned.
fn rename_stored_property<C>(fields: &mut PropertyFields<C>, name: &str) {
    if fields.yaml_binding.is_none() {
        fields.yaml_binding = Some(YamlBinding {
            key: fields.name.clone(),
            direction: "twoWay".to_owned(),
            extra: Default::default(),
        });
    }
    fields.name = name.to_owned();
}

fn preflight_renamed_property_values(
    container: &Path,
    before: &PropertyDefinition,
    after: &PropertyDefinition,
) -> Result<(), String> {
    let discovery = super::discovery::discover_vault(container)?;
    for note in discovery
        .notes
        .iter()
        .filter(|note| note.owner_container_path.as_deref() == Some(""))
    {
        let content = fs::read_to_string(&note.path).map_err(|error| error.to_string())?;
        // Invalid YAML has no projected property values; it remains untouched.
        let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&content) else {
            continue;
        };
        if super::format::resolve_property_yaml_value(&mapping, before)
            != super::format::resolve_property_yaml_value(&mapping, after)
        {
            return Err(format!(
                "Property rename would change a legacy YAML value in {}",
                note.relative_path
            ));
        }
    }
    Ok(())
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

    let previous_property = parsed
        .value
        .properties
        .iter()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property cannot be renamed".to_owned())?;
    if previous_property.name() != Some(name) {
        for property in &parsed.value.properties {
            if let PropertyDefinition::Formula(fields) = property {
                if super::formula::extract_dependencies(&fields.config.expression).is_ok_and(
                    |dependencies| {
                        dependencies
                            .iter()
                            .any(|dependency| Some(dependency.as_str()) == previous_property.name())
                    },
                ) {
                    return Err(format!(
                        "Property rename would break formula dependencies in {}",
                        fields.name
                    ));
                }
            }
        }
    }

    let mut manifest = parsed.value.clone();
    let property = manifest
        .properties
        .iter_mut()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property cannot be renamed".to_owned())?;
    match property {
        PropertyDefinition::Text(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Number(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Checkbox(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Date(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Select(fields) | PropertyDefinition::MultiSelect(fields) => {
            rename_stored_property(fields, name);
        }
        PropertyDefinition::Status(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Url(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Files(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Relation(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Formula(fields) => fields.name = name.to_owned(),
        PropertyDefinition::Rollup(fields) => fields.name = name.to_owned(),
        PropertyDefinition::Opaque(_) => return Err("Property cannot be renamed".to_owned()),
    }

    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property rename would make the database manifest invalid".to_owned());
    }
    let renamed_property = manifest
        .properties
        .iter()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property cannot be renamed".to_owned())?;
    if let Some(binding) = renamed_property.yaml_binding() {
        let collision = manifest.properties.iter().any(|property| {
            property.id() != renamed_property.id()
                && (property
                    .id()
                    .is_some_and(|id| id.trim().eq_ignore_ascii_case(binding.key.trim()))
                    || (!matches!(
                        property,
                        PropertyDefinition::Formula(_) | PropertyDefinition::Rollup(_)
                    ) && property
                        .frontmatter_key()
                        .is_some_and(|key| key.trim().eq_ignore_ascii_case(binding.key.trim()))))
        });
        if collision {
            return Err("Property rename would create an ambiguous YAML binding".to_owned());
        }
        preflight_renamed_property_values(&container, previous_property, renamed_property)?;
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

pub fn resolve_note_path_for_id(
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Result<PathBuf, String> {
    resolve_note_path_for_id_optional(vault, container, note_id)?.ok_or_else(|| {
        format!(
            "Note not found for ID {note_id} in database container {}",
            container.display()
        )
    })
}

fn resolve_note_path_for_id_optional(
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Result<Option<PathBuf>, String> {
    let mut matches = Vec::new();
    let mut unreadable_entry = None;

    for entry in walkdir::WalkDir::new(container)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let file_name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                // Do not descend into service directories
                if crate::vault::scan::is_service_directory(file_name.as_ref()) {
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
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                unreadable_entry.get_or_insert_with(|| error.to_string());
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            match frontmatter::read_markdown(path) {
                Ok(parsed) => {
                    if parsed.note_id() == Some(note_id) {
                        matches.push(path.to_path_buf());
                    } else if let Some(error) = parsed.parse_error {
                        unreadable_entry.get_or_insert(error);
                    }
                }
                Err(error) => {
                    unreadable_entry.get_or_insert(error);
                }
            }
        }
    }

    if matches.len() == 1 {
        return Ok(Some(matches.remove(0)));
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
                let parsed = frontmatter::read_markdown(&full)
                    .map_err(|error| format!("Note {note_id} is not readable: {error}"))?;
                if parsed.note_id() == Some(note_id) {
                    return Ok(Some(full));
                }
            }
        }
    }
    if let Some(error) = unreadable_entry {
        return Err(format!(
            "Cannot resolve note {note_id}: an entry in database container {} is not readable: {error}",
            container.display()
        ));
    }
    Ok(None)
}

fn relation_targets_from_content(
    content: &str,
    property: &PropertyDefinition,
) -> Result<Vec<String>, String> {
    let Some(mapping) = frontmatter::frontmatter_yaml_mapping(content)? else {
        return Ok(Vec::new());
    };
    let Some(value) = super::format::resolve_property_yaml_value(&mapping, property) else {
        return Ok(Vec::new());
    };
    let items = match value {
        serde_yaml::Value::String(item) => vec![item.as_str()],
        serde_yaml::Value::Sequence(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .ok_or_else(|| "Invalid stored relation value".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("Invalid stored relation value".to_owned()),
    };
    items
        .into_iter()
        .map(|item| {
            let item = item.trim();
            let id = match item.strip_prefix("[[") {
                Some(inner) => inner
                    .strip_suffix("]]")
                    .ok_or_else(|| "Invalid stored relation target ID".to_owned())?
                    .trim(),
                None => item,
            };
            if !frontmatter::is_amby_id(id) {
                return Err("Invalid stored relation target ID".to_owned());
            }
            Ok(id.to_owned())
        })
        .collect()
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

    if !valid_operation_id(&request.operation_id) {
        return Err("Invalid batch operationId".to_string());
    }

    let recovery_dir = vault
        .join(".amby")
        .join("recovery")
        .join("database_batches");
    let journal_path = recovery_dir.join(format!("{}.json", request.operation_id));
    let _ = fs::create_dir_all(&recovery_dir);

    if journal_path.is_file() {
        if let Ok(existing) = read_batch_journal(&journal_path) {
            if existing.status == "completed" {
                if let Some(res) = existing.result {
                    return Ok(res);
                }
            }
        }
    }

    let _ = recover_other_value_batches(vault, &recovery_dir, &request.operation_id);

    let op_backup_dir = recovery_dir.join(&request.operation_id);
    let _ = fs::create_dir_all(&op_backup_dir);

    let mut steps = Vec::new();
    for (path, post_bytes, pre_bytes, note_id) in &planned_writes {
        let rel_record = path
            .strip_prefix(vault)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let backup_file = op_backup_dir.join(format!("{note_id}.md"));
        let _ = frontmatter::atomic_write_bytes(&backup_file, pre_bytes);
        let rel_backup = backup_file
            .strip_prefix(vault)
            .unwrap_or(&backup_file)
            .to_string_lossy()
            .to_string();
        steps.push(BatchRecoveryStep {
            record_path: rel_record,
            backup_path: rel_backup,
            original_revision: raw_revision(pre_bytes),
            target_revision: raw_revision(post_bytes),
            status: "planned".to_owned(),
        });
    }

    let mut journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        request_revision: raw_revision(&manifest_bytes),
        status: "inProgress".to_owned(),
        steps,
        result: None,
    };
    write_batch_journal(&journal_path, &journal)?;

    for (path, bytes, _, _) in &planned_writes {
        crate::history::snapshot_before_write(vault, path, bytes, "database-value")?;
    }

    let prepared_writes = watcher.prepare_write(
        planned_writes
            .iter()
            .map(|(path, bytes, _, _)| (path.as_path(), watcher::fingerprint_for_bytes(bytes))),
    );

    let mut write_error = None;
    for (path, bytes, _, _) in &planned_writes {
        if let Err(error) = frontmatter::atomic_write_bytes(path, bytes) {
            write_error = Some(error);
            break;
        }
    }

    if let Some(error) = write_error {
        watcher.cancel_prepared_write(&prepared_writes);
        let _ = rollback_batch_journal(vault, &journal_path, journal);
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

    for step in &mut journal.steps {
        step.status = "applied".to_owned();
    }
    journal.status = "completed".to_owned();
    let batch_result = DatabaseValueBatchResult {
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        revisions,
        warnings: Vec::new(),
    };
    journal.result = Some(batch_result.clone());
    let _ = write_batch_journal(&journal_path, &journal);
    let _ = fs::remove_dir_all(&op_backup_dir);

    Ok(batch_result)
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

/// Outcome of startup recovery for interrupted batch operations.
#[derive(Debug, Default)]
pub struct BatchRecoveryReport {
    pub recovered: usize,
    /// Journals that could not be read or rolled back. They are moved, not
    /// deleted, to `quarantine/` beside the journals together with their
    /// backups, so the evidence survives and the vault still opens.
    pub quarantined: Vec<String>,
}

/// Rolls back every interrupted batch. Every journal is attempted. A journal
/// that is unreadable (corrupt, newer format) or cannot be rolled back (a note
/// changed after the crash, missing backup) must neither disappear nor lock the
/// user out of the vault, so it is quarantined and reported to the caller.
pub fn recover_pending_batches(vault: &Path) -> Result<BatchRecoveryReport, String> {
    let recovery_root = vault
        .join(".amby")
        .join("recovery")
        .join("database_batches");
    let entries = match fs::read_dir(&recovery_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BatchRecoveryReport::default())
        }
        Err(error) => return Err(format!("Cannot read database batch recovery: {error}")),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|error| format!("Cannot read database batch recovery: {error}"))?
            .path();
        if path.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("json")
        {
            paths.push(path);
        }
    }
    paths.sort();
    let mut report = BatchRecoveryReport::default();
    for path in paths {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let failure = match read_batch_journal(&path) {
            Err(error) => Some(error),
            Ok(journal) if journal.status == "planned" || journal.status == "inProgress" => {
                match rollback_batch_journal(vault, &path, journal) {
                    Ok(()) => {
                        report.recovered += 1;
                        None
                    }
                    Err(error) => Some(error),
                }
            }
            Ok(_) => None,
        };
        if let Some(error) = failure {
            quarantine_batch_journal(&recovery_root, &path).map_err(|move_error| {
                format!("{name}: {error}; quarantine failed: {move_error}")
            })?;
            report.quarantined.push(format!("{name}: {error}"));
        }
    }
    Ok(report)
}

/// Moves a stuck journal (and its backup directory, when present) under
/// `quarantine/`. Nothing is deleted. A name collision gets a numeric suffix.
fn quarantine_batch_journal(root: &Path, journal: &Path) -> Result<(), String> {
    let quarantine = root.join("quarantine");
    fs::create_dir_all(&quarantine).map_err(|error| error.to_string())?;
    let stem = journal
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .ok_or("Journal has no name")?;
    let mut suffix = 0u32;
    let dir_name = |suffix: u32| {
        if suffix == 0 {
            stem.clone()
        } else {
            format!("{stem}.{suffix}")
        }
    };
    // Pick a suffix free for BOTH the journal file and its backup directory.
    let target_json = loop {
        let candidate = quarantine.join(format!("{}.json", dir_name(suffix)));
        if !candidate.exists() && !quarantine.join(dir_name(suffix)).exists() {
            break candidate;
        }
        suffix += 1;
    };
    let backups = root.join(&stem);
    // A journal literally named `quarantine` would own the quarantine folder
    // itself; never move that directory into itself.
    if backups.is_dir() && stem != "quarantine" {
        fs::rename(&backups, quarantine.join(dir_name(suffix)))
            .map_err(|error| error.to_string())?;
    }
    fs::rename(journal, target_json).map_err(|error| error.to_string())
}

/// All-or-nothing: every step is checked (record revision, backup hash) before
/// the first byte is restored, so a failure can never leave a batch half
/// reverted. Only then are the backups written back.
fn rollback_batch_journal(
    container: &Path,
    journal_path: &Path,
    mut journal: BatchRecoveryJournal,
) -> Result<(), String> {
    // Phase 1: read-only preflight.
    let mut restores: Vec<(usize, PathBuf, Vec<u8>)> = Vec::new();
    let mut already_original: Vec<usize> = Vec::new();
    for (index, step) in journal.steps.iter().enumerate() {
        let (record_path, backup_path) =
            recovery_step_paths(container, &journal.operation_id, step)?;
        if !record_path.is_file() {
            continue;
        }
        let current = fs::read(&record_path).map_err(|error| error.to_string())?;
        let current_revision = raw_revision(&current);
        if current_revision == step.original_revision {
            already_original.push(index);
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
        restores.push((index, record_path, backup));
    }
    // Phase 2: write.
    for index in already_original {
        journal.steps[index].status = "rolledBack".to_owned();
    }
    for (index, record_path, backup) in restores {
        frontmatter::atomic_write_bytes(&record_path, &backup)?;
        journal.steps[index].status = "rolledBack".to_owned();
    }
    journal.status = "rolledBack".to_owned();
    journal.result = None;
    write_batch_journal(journal_path, &journal)
}

fn recovery_step_paths(
    container: &Path,
    _operation_id: &str,
    step: &BatchRecoveryStep,
) -> Result<(PathBuf, PathBuf), String> {
    if step.record_path.contains("..") || step.backup_path.contains("..") {
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
    #[cfg(test)]
    let before_publish_hook = RELATION_BEFORE_PUBLISH_HOOK.with(|hook| hook.borrow_mut().take());
    #[cfg(test)]
    let mut before_write_hook = RELATION_BEFORE_WRITE_HOOK.with(|hook| hook.borrow_mut().take());
    if request.expected_revision.is_empty() {
        return Err("expectedRevision is required for relation updates".to_owned());
    }
    if !frontmatter::is_amby_id(&request.note_id) || !frontmatter::is_amby_id(&request.property_id)
    {
        return Err("noteId and propertyId must be canonical ULIDs".to_owned());
    }
    if let Some(result) = super::relation_recovery::replay(vault, request)? {
        return Ok(result);
    }
    super::relation_recovery::ensure_no_pending(vault)?;
    super::relation_schema_recovery::ensure_no_pending(vault)?;
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes).map_err(|error| error.to_string())?;
    let mut manifest_inputs = vec![(manifest_path, manifest_bytes)];
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
    if request
        .target_note_ids
        .iter()
        .any(|id| !frontmatter::is_amby_id(id))
    {
        return Err("targetNoteIds must be canonical ULIDs".to_owned());
    }
    let mut clean_targets = Vec::new();
    for id in &request.target_note_ids {
        if !clean_targets.contains(id) {
            clean_targets.push(id.clone());
            if max_items == Some(1) {
                break;
            }
        }
    }

    // 1. Update source note frontmatter
    let note_path = crate::paths::confine(
        vault,
        &resolve_note_path_for_id(vault, &container, &request.note_id)?,
    )?;
    let original_bytes = fs::read(&note_path).map_err(|e| e.to_string())?;
    if raw_revision(&original_bytes) != request.expected_revision {
        return Err("Relation source revision conflict".to_owned());
    }
    let content = String::from_utf8(original_bytes.clone()).map_err(|e| e.to_string())?;
    let prop_def = PropertyDefinition::Relation(rel_prop.clone());
    let prop_name = prop_def
        .frontmatter_key()
        .ok_or_else(|| "Relation property has no storage key or name".to_owned())?;

    // Get previous targets from frontmatter if any
    let prev_targets = relation_targets_from_content(&content, &prop_def)?;
    let mut warnings = Vec::new();

    let mut planned_writes = Vec::<RelationPlannedWrite>::new();

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
        manifest_inputs.push((target_manifest_path, target_bytes));
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
        if !matches!(inv_prop_def, PropertyDefinition::Relation(_)) {
            return Err("Inverse property is not a relation".to_owned());
        }
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
            .collect::<std::collections::BTreeSet<_>>();

        for target_id in added_targets {
            if target_id == &request.note_id {
                // Self-relation: update source_content directly
                let mut list = relation_targets_from_content(&source_content, inv_prop_def)?;
                if !list.contains(&request.note_id) {
                    list.push(request.note_id.clone());
                    let r_val = PropertyValue::Relation {
                        target_note_ids: list,
                        extra: Default::default(),
                    };
                    if let Some(y_val) =
                        super::format::property_value_to_frontmatter_value(&r_val, inv_prop_def)
                    {
                        source_content = frontmatter::replace_yaml_binding_lossless(
                            &source_content,
                            inv_prop_name,
                            &y_val,
                        )?;
                    }
                }
            } else {
                let t_path = crate::paths::confine(
                    vault,
                    &resolve_note_path_for_id(vault, &target_container, target_id)?,
                )?;
                let t_orig = fs::read(&t_path)
                    .map_err(|e| format!("Target note not readable {target_id}: {e}"))?;
                let t_content = String::from_utf8(t_orig.clone()).map_err(|e| e.to_string())?;
                let mut list = relation_targets_from_content(&t_content, inv_prop_def)?;
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
                        planned_writes.push(RelationPlannedWrite {
                            path: t_path,
                            post_bytes: t_next.into_bytes(),
                            pre_bytes: t_orig,
                            affected_note: DatabaseAffectedNote {
                                database_id: target_database_id.clone(),
                                note_id: target_id.clone(),
                            },
                        });
                    }
                }
            }
        }

        for target_id in removed_targets {
            if target_id == &request.note_id {
                // Self-relation: update source_content directly
                let mut list = relation_targets_from_content(&source_content, inv_prop_def)?;
                if list.contains(&request.note_id) {
                    list.retain(|id| id != &request.note_id);
                    if list.is_empty() {
                        source_content = frontmatter::remove_yaml_binding_lossless(
                            &source_content,
                            inv_prop_name,
                        )?;
                    } else {
                        let r_val = PropertyValue::Relation {
                            target_note_ids: list,
                            extra: Default::default(),
                        };
                        if let Some(y_val) =
                            super::format::property_value_to_frontmatter_value(&r_val, inv_prop_def)
                        {
                            source_content = frontmatter::replace_yaml_binding_lossless(
                                &source_content,
                                inv_prop_name,
                                &y_val,
                            )?;
                        }
                    }
                }
            } else {
                let Some(t_path) =
                    resolve_note_path_for_id_optional(vault, &target_container, target_id)?
                else {
                    warnings.push(format!(
                        "Previous relation target {target_id} was not found; inverse value could not be updated"
                    ));
                    continue;
                };
                let t_path = crate::paths::confine(vault, &t_path)?;
                let t_orig = fs::read(&t_path)
                    .map_err(|error| format!("Target note not readable {target_id}: {error}"))?;
                let t_content =
                    String::from_utf8(t_orig.clone()).map_err(|error| error.to_string())?;
                let mut list = relation_targets_from_content(&t_content, inv_prop_def)?;
                if list.contains(&request.note_id) {
                    list.retain(|id| id != &request.note_id);
                    let t_next = if list.is_empty() {
                        frontmatter::remove_yaml_binding_lossless(&t_content, inv_prop_name)?
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
                    planned_writes.push(RelationPlannedWrite {
                        path: t_path,
                        post_bytes: t_next.into_bytes(),
                        pre_bytes: t_orig,
                        affected_note: DatabaseAffectedNote {
                            database_id: target_database_id.clone(),
                            note_id: target_id.clone(),
                        },
                    });
                }
            }
        }
    }

    // Source note is included in planned writes
    planned_writes.insert(
        0,
        RelationPlannedWrite {
            path: note_path,
            post_bytes: source_content.into_bytes(),
            pre_bytes: original_bytes,
            affected_note: DatabaseAffectedNote {
                database_id: request.database_id.clone(),
                note_id: request.note_id.clone(),
            },
        },
    );

    #[cfg(test)]
    if let Some(hook) = before_publish_hook {
        hook();
    }
    check_relation_manifest_revisions(vault, &manifest_inputs)?;
    for planned in &planned_writes {
        check_relation_file_revision(vault, &planned.path, &planned.pre_bytes, "record")?;
    }

    let affected_notes = planned_writes
        .iter()
        .map(|planned| {
            (
                planned.affected_note.database_id.clone(),
                planned.affected_note.note_id.clone(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|(database_id, note_id)| DatabaseAffectedNote {
            database_id,
            note_id,
        })
        .collect();
    let result = UpdateDatabaseRelationValueResult {
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        note_id: request.note_id.clone(),
        target_note_ids: clean_targets,
        affected_notes,
        revisions: planned_writes
            .iter()
            .map(|planned| DatabaseNoteRevision {
                note_id: planned.affected_note.note_id.clone(),
                revision: raw_revision(&planned.post_bytes),
            })
            .collect(),
        warnings,
    };

    // Snapshot and execute atomic writes with rollback
    for planned in &planned_writes {
        crate::history::snapshot_before_write(
            vault,
            &planned.path,
            &planned.post_bytes,
            "database-value",
        )?;
    }
    let mut journal = super::relation_recovery::prepare(vault, request, &planned_writes, &result)?;
    let write = watcher.prepare_write(planned_writes.iter().map(|planned| {
        (
            planned.path.as_path(),
            watcher::fingerprint_for_bytes(&planned.post_bytes),
        )
    }));

    let mut written = Vec::new();
    let mut write_err = None;
    for planned in &planned_writes {
        #[cfg(test)]
        if let Some(hook) = before_write_hook.as_mut() {
            hook(written.len());
        }
        if let Err(error) = journal
            .check_revision()
            .and_then(|()| check_relation_manifest_revisions(vault, &manifest_inputs))
            .and_then(|()| {
                check_relation_file_revision(vault, &planned.path, &planned.pre_bytes, "record")
            })
        {
            write_err = Some(error);
            break;
        }
        // Even an atomic write that reports a post-rename sync failure may
        // have published its bytes. Conditional rollback verifies what remains.
        written.push(planned);
        if let Err(error) = frontmatter::atomic_write_bytes(&planned.path, &planned.post_bytes) {
            write_err = Some(error);
            break;
        }
        if let Err(error) = journal.applied(written.len() - 1) {
            write_err = Some(error);
            break;
        }
    }

    if let Some(error) = write_err {
        watcher.cancel_prepared_write(&write);
        let rollback_errors = rollback_relation_writes(vault, &written);
        if !rollback_errors.is_empty() {
            return Err(format!(
                "Relation write failed: {error}; rollback incomplete: {}",
                rollback_errors.join("; ")
            ));
        }
        if let Err(outcome_error) = journal.rolled_back() {
            return Err(format!(
                "Relation write failed: {error}; notes rolled back but journal outcome could not be recorded: {outcome_error}"
            ));
        }
        return Err(format!(
            "Relation write failed; rolled back written files: {error}"
        ));
    }
    if let Err(error) = journal.completed() {
        watcher.cancel_prepared_write(&write);
        return Err(format!(
            "Relation files were written but completion could not be recorded for operation {}: {error}; recovery journal retained",
            request.operation_id
        ));
    }
    watcher.confirm_prepared_write(&write);

    if let Some(history) = history {
        if !planned_writes.is_empty() {
            let files = planned_writes
                .iter()
                .map(|planned| super::history::DatabaseHistoryFile {
                    path: planned.path.clone(),
                    note_id: planned.affected_note.note_id.clone(),
                    pre_bytes: planned.pre_bytes.clone(),
                    pre_revision: raw_revision(&planned.pre_bytes),
                    post_bytes: planned.post_bytes.clone(),
                    post_revision: raw_revision(&planned.post_bytes),
                })
                .collect();
            history.push(super::history::DatabaseHistoryEntry {
                database_id: request.database_id.clone(),
                description: format!("Update relation for note {}", request.note_id),
                files,
            });
        }
    }

    Ok(result)
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
#[path = "mutations_test.rs"]
mod tests;
