use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::bundle::ensure_bundle_path;
use crate::database::format::{parse_manifest, prepare_json, raw_revision};
use crate::database::validation::validate_manifest;
use crate::frontmatter::{self};
use crate::watcher::{self, WatcherState};

use super::*;

/// IDs chosen before the database exists, so a repeated or recovered multi-step
/// operation (a creative project) builds byte-identical manifests.
#[derive(Clone, Debug)]
pub(crate) struct PlannedDatabaseIds {
    pub(crate) database_id: String,
    pub(crate) view_id: String,
}

impl PlannedDatabaseIds {
    pub(crate) fn generate() -> Self {
        Self {
            database_id: ulid::Ulid::generate().to_string(),
            view_id: ulid::Ulid::generate().to_string(),
        }
    }
}

pub fn create_database(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabaseRequest,
) -> Result<CreatedDatabase, String> {
    create_database_with_ids(vault, watcher, request, None, &NewDatabaseExtras::default())
}

/// What a new database starts with beyond an empty table. Everything here is decided before
/// the first write (so a repeat or a cleanup rebuilds the same bytes) and serialized into the
/// caller's journal.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewDatabaseExtras {
    #[serde(default = "legacy_layout_version")]
    pub(crate) layout_version: u64,
    #[serde(default)]
    pub(crate) template: Option<serde_json::Value>,
    /// Definitions built by [`build_new_property`].
    #[serde(default)]
    pub(crate) properties: Vec<serde_json::Value>,
    /// Replaces the default table view. It must carry the planned database and view IDs;
    /// start from [`default_table_view`].
    #[serde(default)]
    pub(crate) view: Option<serde_json::Value>,
    /// An encoded `IconValue`.
    #[serde(default)]
    pub(crate) icon: Option<String>,
    /// A template the manifest lists and defaults to. The caller writes its file
    /// (`.ambd/templates/<id>.json`).
    #[serde(default)]
    pub(crate) template_id: Option<String>,
}

fn legacy_layout_version() -> u64 {
    1
}

impl Default for NewDatabaseExtras {
    fn default() -> Self {
        Self {
            layout_version: 2,
            template: None,
            properties: Vec::new(),
            view: None,
            icon: None,
            template_id: None,
        }
    }
}

/// The view a new database gets: a table of titles, sorted by title.
pub(crate) fn default_table_view(ids: &PlannedDatabaseIds) -> serde_json::Value {
    json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": ids.database_id,
        "viewId": ids.view_id,
        "name": "Table",
        "layout": "table",
        "openMode": "centerPeek",
        "subitemsMode": "nested",
        "density": "default",
        "fields": [{"field": {"kind": "system", "field": "title"}, "visible": true, "width": null, "frozen": true}],
        "filter": null,
        "sorts": [{"field": {"kind": "system", "field": "title"}, "direction": "asc", "nulls": "last"}],
        "group": null,
        "manualOrder": [],
        "aggregates": [],
        "layoutConfig": {},
    })
}

/// The exact bytes `create_database` publishes for a new database. Pure, so a caller can
/// later recognise an untouched manifest it created itself.
pub(crate) fn new_database_manifest_bytes(
    name: &str,
    container_kind: &str,
    ids: &PlannedDatabaseIds,
    extras: &NewDatabaseExtras,
) -> Result<Vec<u8>, String> {
    let view_id = &ids.view_id;
    let view = extras
        .view
        .clone()
        .unwrap_or_else(|| default_table_view(ids));
    let mut manifest = json!({
        "format": "amby-database",
        "formatVersion": extras.layout_version,
        "containerKind": container_kind,
        "databaseId": ids.database_id,
        "name": name,
        "icon": extras.icon,
        "cover": null,
        "locked": false,
        "membership": {"kind": "filesystem-descendants", "recursive": true},
        "properties": extras.properties,
        "viewOrder": [view_id],
        "defaultViewId": view_id,
        "templateOrder": extras.template_id.iter().collect::<Vec<_>>(),
        "defaultTemplateId": extras.template_id,
        "views": [view],
    });
    if extras.layout_version >= 2 {
        manifest["templates"] = json!(extras.template.iter().collect::<Vec<_>>());
    }
    json_bytes(&manifest)
}

pub(crate) fn create_database_with_ids(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabaseRequest,
    planned: Option<&PlannedDatabaseIds>,
    extras: &NewDatabaseExtras,
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
    let ids = planned
        .cloned()
        .unwrap_or_else(PlannedDatabaseIds::generate);
    let PlannedDatabaseIds {
        database_id,
        view_id,
    } = ids.clone();
    let manifest_path = crate::database::discovery::manifest_path_for_container(&container);
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
    let manifest_bytes = new_database_manifest_bytes(name, container_kind, &ids, extras)?;
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
    let manifest_path = crate::database::discovery::manifest_path_for_container(&container);
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
