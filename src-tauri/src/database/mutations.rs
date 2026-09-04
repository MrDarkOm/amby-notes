//! Small, no-replace database creators used by the DB-10 command boundary.
//! Updates are intentionally deferred until the schema/view editor stage.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::format::{parse_manifest, parse_record, prepare_json, PropertyValue, RecordShard};
use super::format::{raw_revision, MAX_JSON_BYTES};
use super::validation::validate_record;
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabase {
    pub database_id: String,
    pub title: String,
    pub manifest_revision: String,
    pub view_id: String,
    pub view_revision: String,
    pub manifest_path: String,
    pub view_path: String,
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseNoteRevision {
    pub note_id: String,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseValueBatchResult {
    pub operation_id: String,
    pub database_id: String,
    pub revisions: Vec<DatabaseNoteRevision>,
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
        "openMode": "inline",
        "subitemsMode": "nested",
        "density": "comfortable",
        "fields": [{"kind": "system", "field": "title", "visible": true, "width": null, "frozen": true}],
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
    if request.operation_id.trim().is_empty() || request.cells.is_empty() {
        return Err("operationId and at least one cell are required".to_owned());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = container.join("ambd.json");
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes).map_err(|error| error.to_string())?;
    if manifest.value.locked {
        return Err("Database is locked".to_owned());
    }
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

    let prepared_writes = watcher.prepare_write(
        replacements
            .iter()
            .map(|(path, _, _, bytes)| (path, watcher::fingerprint_for_bytes(bytes))),
    );
    for (path, _, _, bytes) in &replacements {
        crate::history::snapshot_before_write(vault, path, bytes, "database-value")?;
    }
    let mut written: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for (path, expected_revision, original, bytes) in &replacements {
        let current = fs::read(path).map_err(|error| error.to_string())?;
        if raw_revision(&current) != *expected_revision {
            watcher.cancel_prepared_write(&prepared_writes);
            return Err(format!("Record revision conflict for {}", path.display()));
        }
        if let Err(error) = frontmatter::atomic_write_bytes(path, bytes) {
            for (written_path, original_bytes) in &written {
                let _ = frontmatter::atomic_write_bytes(written_path, original_bytes);
            }
            watcher.cancel_prepared_write(&prepared_writes);
            return Err(error);
        }
        written.push((path.clone(), original.clone()));
    }
    watcher.confirm_prepared_write(&prepared_writes);
    Ok(DatabaseValueBatchResult {
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        revisions: replacements
            .into_iter()
            .map(|(path, _, _, bytes)| DatabaseNoteRevision {
                note_id: path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or_default()
                    .to_owned(),
                revision: raw_revision(&bytes),
            })
            .collect(),
        warnings: Vec::new(),
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("amby-db-create-{stamp}"));
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
}
