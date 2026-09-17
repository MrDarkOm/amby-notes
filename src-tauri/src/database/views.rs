//! Durable saved-view service.
//!
//! Views are portable JSON shards. SQLite only mirrors them for fast listing
//! and querying, so every operation below validates and publishes the source
//! files before a projection refresh is requested by the command layer.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::discovery::discover_vault;
use super::format::{parse_manifest, parse_view, raw_revision, DatabaseManifest, DatabaseViewFile};
use super::model::{
    CreateDatabaseViewRequest, DatabaseViewDocument, DatabaseViewMutationResult,
    DatabaseViewRequest, DeleteDatabaseViewRequest, RenameDatabaseViewRequest,
    ReorderDatabaseViewsRequest, UpdateDatabaseViewConfigRequest,
};
use super::validation::validate_view;
use crate::frontmatter::{self, AtomicCreateError};
use crate::watcher::{self, WatcherState};

fn database_container(vault: &Path, database_id: &str) -> Result<PathBuf, String> {
    discover_vault(vault)?
        .databases
        .into_iter()
        .find(|database| database.database_id == database_id)
        .map(|database| database.container_path)
        .ok_or_else(|| "Database was not found".to_owned())
}

fn read_manifest(
    vault: &Path,
    database_id: &str,
) -> Result<
    (
        PathBuf,
        Vec<u8>,
        super::format::ParsedJson<DatabaseManifest>,
    ),
    String,
> {
    let container = database_container(vault, database_id)?;
    let path = super::discovery::manifest_path_for_container(&container);
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&bytes).map_err(|error| error.to_string())?;
    if parsed.value.database_id != database_id {
        return Err("Database manifest identity mismatch".to_owned());
    }
    Ok((container, bytes, parsed))
}

fn json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn publish_existing(watcher: &WatcherState, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let prepared = watcher.prepare_write([(path, watcher::fingerprint_for_bytes(bytes))]);
    if let Err(error) = frontmatter::atomic_write_bytes(path, bytes) {
        watcher.cancel_prepared_write(&prepared);
        return Err(error);
    }
    watcher.confirm_prepared_write(&prepared);
    Ok(())
}

fn publish_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match frontmatter::atomic_write_bytes_new(path, bytes) {
        Ok(()) => Ok(()),
        Err(AtomicCreateError::AlreadyExists) => {
            Err(format!("File already exists: {}", path.display()))
        }
        Err(AtomicCreateError::Other(error)) => Err(error),
    }
}

fn ensure_writable_manifest(
    parsed: &super::format::ParsedJson<DatabaseManifest>,
    expected_revision: &str,
) -> Result<(), String> {
    if parsed.revision != expected_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }
    Ok(())
}

fn ensure_writable_view(
    view: &super::format::ParsedJson<DatabaseViewFile>,
    expected_revision: &str,
) -> Result<(), String> {
    if view.revision != expected_revision {
        return Err("View revision conflict".to_owned());
    }
    if view.read_only.is_some() {
        return Err("View is read-only because its format is unsupported".to_owned());
    }
    Ok(())
}

fn view_path(container: &Path, view_id: &str) -> PathBuf {
    container
        .join(".ambd/views")
        .join(format!("{view_id}.json"))
}

fn document(database_id: &str, bytes: &[u8]) -> Result<DatabaseViewDocument, String> {
    let parsed = parse_view(bytes).map_err(|error| error.to_string())?;
    Ok(DatabaseViewDocument {
        database_id: database_id.to_owned(),
        view_id: parsed.value.view_id.clone(),
        title: parsed.value.name.clone(),
        layout: parsed.value.layout.clone(),
        revision: parsed.revision,
        config_json: String::from_utf8(bytes.to_vec()).map_err(|error| error.to_string())?,
    })
}

pub fn get_view(
    vault: &Path,
    request: &DatabaseViewRequest,
) -> Result<DatabaseViewDocument, String> {
    let (container, _, _) = read_manifest(vault, &request.database_id)?;
    let bytes =
        fs::read(view_path(&container, &request.view_id)).map_err(|error| error.to_string())?;
    let parsed = parse_view(&bytes).map_err(|error| error.to_string())?;
    if parsed.value.database_id != request.database_id || parsed.value.view_id != request.view_id {
        return Err("View identity mismatch".to_owned());
    }
    if parsed.revision != request.expected_view_revision {
        return Err("View revision conflict".to_owned());
    }
    document(&request.database_id, &bytes)
}

pub fn create_view(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabaseViewRequest,
) -> Result<DatabaseViewDocument, String> {
    let name = request.name.trim();
    if name.is_empty() || name.contains(['/', '\\', '\n', '\r']) {
        return Err("View name is invalid".to_owned());
    }
    if !matches!(
        request.layout.as_str(),
        "table" | "board" | "list" | "gallery" | "chart"
    ) {
        return Err("Unsupported view layout".to_owned());
    }
    let (container, _original_manifest, parsed_manifest) =
        read_manifest(vault, &request.database_id)?;
    ensure_writable_manifest(&parsed_manifest, &request.expected_manifest_revision)?;
    let view_id = ulid::Ulid::generate().to_string();
    let view = json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": request.database_id,
        "viewId": view_id,
        "name": name,
        "layout": request.layout,
        "openMode": "sidePeek",
        "subitemsMode": "nested",
        "density": "default",
        "fields": [{"field": {"kind": "system", "field": "title"}, "visible": true, "width": null, "frozen": true}],
        "filter": null,
        "sorts": [{"field": {"kind": "system", "field": "title"}, "direction": "asc", "nulls": "last"}],
        "group": null,
        "manualOrder": [],
        "aggregates": [],
        "layoutConfig": {}
    });
    let view_bytes = json_bytes(&view)?;
    let view = parse_view(&view_bytes).map_err(|error| error.to_string())?;
    let report = validate_view(&view.value, Some(&parsed_manifest.value));
    if !report.errors.is_empty() {
        return Err("View would make the database configuration invalid".to_owned());
    }
    let mut manifest = parsed_manifest.value.clone();
    manifest.view_order.push(view_id.clone());
    if manifest.default_view_id.is_none() {
        manifest.default_view_id = Some(view_id.clone());
    }
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let manifest_bytes =
        json_bytes(&serde_json::to_value(&manifest).map_err(|error| error.to_string())?)?;
    crate::history::snapshot_before_write(vault, &manifest_path, &manifest_bytes, "database-view")?;
    let path = view_path(&container, &view_id);
    fs::create_dir_all(path.parent().ok_or("View has no parent")?)
        .map_err(|error| error.to_string())?;
    let prepared = watcher.prepare_write([
        (&path, watcher::fingerprint_for_bytes(&view_bytes)),
        (
            &manifest_path,
            watcher::fingerprint_for_bytes(&manifest_bytes),
        ),
    ]);
    if let Err(error) = publish_new(&path, &view_bytes) {
        watcher.cancel_prepared_write(&prepared);
        return Err(error);
    }
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &manifest_bytes) {
        let _ = fs::remove_file(&path);
        watcher.cancel_prepared_write(&prepared);
        return Err(error);
    }
    watcher.confirm_prepared_write(&prepared);
    document(&request.database_id, &view_bytes)
}

pub fn rename_view(
    vault: &Path,
    watcher: &WatcherState,
    request: &RenameDatabaseViewRequest,
) -> Result<DatabaseViewMutationResult, String> {
    let name = request.name.trim();
    if name.is_empty() || name.contains(['/', '\\', '\n', '\r']) {
        return Err("View name is invalid".to_owned());
    }
    let (container, _, manifest) = read_manifest(vault, &request.database_id)?;
    if manifest.value.locked {
        return Err("Database is locked".to_owned());
    }
    let path = view_path(&container, &request.view_id);
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let parsed = parse_view(&bytes).map_err(|error| error.to_string())?;
    ensure_writable_view(&parsed, &request.expected_view_revision)?;
    let mut value = serde_json::to_value(parsed.value).map_err(|error| error.to_string())?;
    value["name"] = Value::String(name.to_owned());
    let next = json_bytes(&value)?;
    crate::history::snapshot_before_write(vault, &path, &next, "database-view")?;
    publish_existing(watcher, &path, &next)?;
    Ok(DatabaseViewMutationResult {
        database_id: request.database_id.clone(),
        view_id: request.view_id.clone(),
        view_revision: raw_revision(&next),
        manifest_revision: manifest.revision,
        warnings: Vec::new(),
    })
}

pub fn update_view_config(
    vault: &Path,
    watcher: &WatcherState,
    request: &UpdateDatabaseViewConfigRequest,
) -> Result<DatabaseViewMutationResult, String> {
    let (container, _, manifest) = read_manifest(vault, &request.database_id)?;
    if manifest.value.locked {
        return Err("Database is locked".to_owned());
    }
    let path = view_path(&container, &request.view_id);
    let current = fs::read(&path).map_err(|error| error.to_string())?;
    let parsed = parse_view(&current).map_err(|error| error.to_string())?;
    ensure_writable_view(&parsed, &request.expected_view_revision)?;
    let next: DatabaseViewFile = serde_json::from_str(&request.config_json)
        .map_err(|error| format!("View config is invalid JSON: {error}"))?;
    if next.database_id != request.database_id || next.view_id != request.view_id {
        return Err("View config identity does not match the request".to_owned());
    }
    let report = validate_view(&next, Some(&manifest.value));
    if !report.errors.is_empty() {
        return Err("View configuration is invalid".to_owned());
    }
    let next = json_bytes(&serde_json::to_value(&next).map_err(|error| error.to_string())?)?;
    crate::history::snapshot_before_write(vault, &path, &next, "database-view")?;
    publish_existing(watcher, &path, &next)?;
    Ok(DatabaseViewMutationResult {
        database_id: request.database_id.clone(),
        view_id: request.view_id.clone(),
        view_revision: raw_revision(&next),
        manifest_revision: manifest.revision,
        warnings: Vec::new(),
    })
}

pub fn duplicate_view(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseViewRequest,
) -> Result<DatabaseViewDocument, String> {
    let (container, _original_manifest, manifest) = read_manifest(vault, &request.database_id)?;
    let expected_manifest = request
        .expected_manifest_revision
        .as_deref()
        .unwrap_or(&manifest.revision);
    ensure_writable_manifest(&manifest, expected_manifest)?;
    let source_path = view_path(&container, &request.view_id);
    let source = fs::read(&source_path).map_err(|error| error.to_string())?;
    let parsed = parse_view(&source).map_err(|error| error.to_string())?;
    ensure_writable_view(&parsed, &request.expected_view_revision)?;
    let new_id = ulid::Ulid::generate().to_string();
    let mut value = serde_json::to_value(parsed.value).map_err(|error| error.to_string())?;
    value["viewId"] = Value::String(new_id.clone());
    value["name"] = Value::String(format!("{} copy", value["name"].as_str().unwrap_or("View")));
    let next_view = json_bytes(&value)?;
    let mut next_manifest = manifest.value.clone();
    next_manifest.view_order.push(new_id.clone());
    let next_manifest =
        json_bytes(&serde_json::to_value(&next_manifest).map_err(|error| error.to_string())?)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let path = view_path(&container, &new_id);
    let prepared = watcher.prepare_write([
        (&path, watcher::fingerprint_for_bytes(&next_view)),
        (
            &manifest_path,
            watcher::fingerprint_for_bytes(&next_manifest),
        ),
    ]);
    if let Err(error) = publish_new(&path, &next_view) {
        watcher.cancel_prepared_write(&prepared);
        return Err(error);
    }
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &next_manifest) {
        let _ = fs::remove_file(&path);
        watcher.cancel_prepared_write(&prepared);
        return Err(error);
    }
    watcher.confirm_prepared_write(&prepared);
    document(&request.database_id, &next_view)
}

pub fn delete_view(
    vault: &Path,
    watcher: &WatcherState,
    request: &DeleteDatabaseViewRequest,
) -> Result<DatabaseViewMutationResult, String> {
    let (container, original_manifest, manifest) = read_manifest(vault, &request.database_id)?;
    ensure_writable_manifest(&manifest, &request.expected_manifest_revision)?;
    if manifest.value.view_order.len() <= 1 {
        return Err("The last database view cannot be deleted".to_owned());
    }
    if !manifest
        .value
        .view_order
        .iter()
        .any(|id| id == &request.view_id)
    {
        return Err("View was not found in the manifest".to_owned());
    }
    let path = view_path(&container, &request.view_id);
    let current = fs::read(&path).map_err(|error| error.to_string())?;
    let parsed = parse_view(&current).map_err(|error| error.to_string())?;
    ensure_writable_view(&parsed, &request.expected_view_revision)?;
    let mut next_manifest = manifest.value.clone();
    next_manifest.view_order.retain(|id| id != &request.view_id);
    if next_manifest.default_view_id.as_deref() == Some(request.view_id.as_str()) {
        next_manifest.default_view_id = next_manifest.view_order.first().cloned();
    }
    let next_manifest =
        json_bytes(&serde_json::to_value(&next_manifest).map_err(|error| error.to_string())?)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    crate::history::snapshot_before_write(vault, &path, &current, "database-view")?;
    crate::history::snapshot_before_write(vault, &manifest_path, &next_manifest, "database-view")?;
    frontmatter::atomic_write_bytes(&manifest_path, &next_manifest)?;
    if let Err(error) = fs::remove_file(&path) {
        // The manifest still points to no deleted view only after this branch;
        // restore it from the exact original bytes if the shard removal fails.
        let _ = frontmatter::atomic_write_bytes(&manifest_path, &original_manifest);
        return Err(error.to_string());
    }
    let _ = watcher;
    Ok(DatabaseViewMutationResult {
        database_id: request.database_id.clone(),
        view_id: request.view_id.clone(),
        view_revision: parsed.revision,
        manifest_revision: raw_revision(&next_manifest),
        warnings: Vec::new(),
    })
}

pub fn reorder_views(
    vault: &Path,
    watcher: &WatcherState,
    request: &ReorderDatabaseViewsRequest,
) -> Result<DatabaseViewMutationResult, String> {
    let (container, _, manifest) = read_manifest(vault, &request.database_id)?;
    ensure_writable_manifest(&manifest, &request.expected_manifest_revision)?;
    let existing = manifest.value.view_order.clone();
    let requested = request
        .view_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    if requested.len() != existing.len()
        || requested.len() != request.view_ids.len()
        || existing.iter().any(|id| !requested.contains(id))
    {
        return Err("View order must contain every view exactly once".to_owned());
    }
    if existing == request.view_ids {
        return Ok(DatabaseViewMutationResult {
            database_id: request.database_id.clone(),
            view_id: String::new(),
            view_revision: String::new(),
            manifest_revision: manifest.revision,
            warnings: Vec::new(),
        });
    }
    let mut next = manifest.value.clone();
    next.view_order = request.view_ids.clone();
    let bytes = json_bytes(&serde_json::to_value(&next).map_err(|error| error.to_string())?)?;
    let path = super::discovery::manifest_path_for_container(&container);
    crate::history::snapshot_before_write(vault, &path, &bytes, "database-view")?;
    publish_existing(watcher, &path, &bytes)?;
    Ok(DatabaseViewMutationResult {
        database_id: request.database_id.clone(),
        view_id: String::new(),
        view_revision: String::new(),
        manifest_revision: raw_revision(&bytes),
        warnings: Vec::new(),
    })
}

pub fn set_default_view(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseViewRequest,
) -> Result<DatabaseViewMutationResult, String> {
    let (container, _, manifest) = read_manifest(vault, &request.database_id)?;
    let expected_manifest = request
        .expected_manifest_revision
        .as_deref()
        .unwrap_or(&manifest.revision);
    ensure_writable_manifest(&manifest, expected_manifest)?;
    if !manifest
        .value
        .view_order
        .iter()
        .any(|id| id == &request.view_id)
    {
        return Err("View was not found in the manifest".to_owned());
    }
    let view_bytes =
        fs::read(view_path(&container, &request.view_id)).map_err(|error| error.to_string())?;
    let view = parse_view(&view_bytes).map_err(|error| error.to_string())?;
    ensure_writable_view(&view, &request.expected_view_revision)?;
    let mut next = manifest.value.clone();
    next.default_view_id = Some(request.view_id.clone());
    let bytes = json_bytes(&serde_json::to_value(&next).map_err(|error| error.to_string())?)?;
    let path = super::discovery::manifest_path_for_container(&container);
    crate::history::snapshot_before_write(vault, &path, &bytes, "database-view")?;
    publish_existing(watcher, &path, &bytes)?;
    Ok(DatabaseViewMutationResult {
        database_id: request.database_id.clone(),
        view_id: request.view_id.clone(),
        view_revision: String::new(),
        manifest_revision: raw_revision(&bytes),
        warnings: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::mutations::{create_database, CreateDatabaseRequest, DatabaseCreateMode};

    fn temp_vault(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("amby-db-view-{name}-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn manifest_revision(container: &Path) -> String {
        raw_revision(
            &fs::read(super::super::discovery::manifest_path_for_container(
                container,
            ))
            .unwrap(),
        )
    }

    #[test]
    fn view_crud_preserves_portable_files_and_cas_revisions() {
        let vault = temp_vault("crud");
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Library".to_owned(),
            },
        )
        .unwrap();
        let container = vault.join("Library");
        let initial_manifest_revision = manifest_revision(&container);
        let second = create_view(
            &vault,
            &watcher,
            &CreateDatabaseViewRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: initial_manifest_revision,
                name: "Cards".to_owned(),
                layout: "gallery".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(second.title, "Cards");
        assert_eq!(second.layout, "gallery");
        assert!(view_path(&container, &second.view_id).is_file());

        let renamed = rename_view(
            &vault,
            &watcher,
            &RenameDatabaseViewRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                view_id: second.view_id.clone(),
                expected_view_revision: second.revision.clone(),
                name: "Cards renamed".to_owned(),
            },
        )
        .unwrap();
        let duplicated = duplicate_view(
            &vault,
            &watcher,
            &DatabaseViewRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                view_id: second.view_id.clone(),
                expected_view_revision: renamed.view_revision,
                expected_manifest_revision: Some(renamed.manifest_revision.clone()),
            },
        )
        .unwrap();
        assert_ne!(duplicated.view_id, second.view_id);
        assert!(duplicated.title.ends_with(" copy"));

        let manifest_revision = manifest_revision(&container);
        let deleted = delete_view(
            &vault,
            &watcher,
            &DeleteDatabaseViewRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                view_id: duplicated.view_id.clone(),
                expected_view_revision: duplicated.revision,
                expected_manifest_revision: manifest_revision,
            },
        )
        .unwrap();
        assert!(!Path::new(&view_path(&container, &duplicated.view_id)).exists());
        assert!(!deleted.manifest_revision.is_empty());
        let _ = fs::remove_dir_all(vault);
    }
}
