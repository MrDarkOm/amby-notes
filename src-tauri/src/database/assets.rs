use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::discovery::discover_vault;
use crate::bundle::{sanitize_ext, unique_name, MAX_ATTACHMENT_FILE_SIZE};
use crate::frontmatter::{self, AtomicCreateError};
use crate::paths;
use crate::watcher::{self, WatcherState};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportDatabaseAssetRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub note_id: String,
    pub source_path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDatabaseAsset {
    pub database_id: String,
    pub note_id: String,
    pub asset_id: String,
    pub name: String,
    pub relative_path: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

pub fn import_database_asset(
    vault: &Path,
    watcher: &WatcherState,
    request: &ImportDatabaseAssetRequest,
) -> Result<ImportedDatabaseAsset, String> {
    if ulid::Ulid::from_string(&request.database_id).is_err()
        || ulid::Ulid::from_string(&request.note_id).is_err()
    {
        return Err("databaseId and noteId must be canonical ULIDs".to_owned());
    }
    let discovery = discover_vault(vault)?;
    let database = discovery
        .databases
        .iter()
        .find(|database| database.database_id == request.database_id)
        .ok_or_else(|| "Database was not found".to_owned())?;
    if database.read_only {
        return Err("Database is read-only".to_owned());
    }
    if !discovery.notes.iter().any(|note| {
        note.note_id.as_deref() == Some(request.note_id.as_str())
            && note.owner_database_id.as_deref() == Some(request.database_id.as_str())
    }) {
        return Err("Row does not belong to database".to_owned());
    }
    let source = Path::new(&request.source_path);
    let metadata = source
        .metadata()
        .map_err(|error| format!("Could not read source asset: {error}"))?;
    if !metadata.is_file() {
        return Err("Source asset is not a file".to_owned());
    }
    if metadata.len() > MAX_ATTACHMENT_FILE_SIZE {
        return Err("Source asset exceeds the attachment size limit".to_owned());
    }
    let stem = source
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".to_owned());
    let extension = source
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = sanitize_ext(&extension);
    let asset_id = ulid::Ulid::generate().to_string();
    let assets_dir = database
        .container_path
        .join(".ambd/assets")
        .join(&request.note_id);
    let assets_dir = paths::confine(vault, &assets_dir)?;
    fs::create_dir_all(&assets_dir).map_err(|error| error.to_string())?;
    for _ in 0..1_000 {
        let name = unique_name(&assets_dir, &stem, &extension);
        let destination = paths::confine(vault, &assets_dir.join(&name))?;
        let prepared = watcher.prepare_write([(&destination, watcher::path_fingerprint(source))]);
        match frontmatter::atomic_copy_file_new(source, &destination, MAX_ATTACHMENT_FILE_SIZE) {
            Ok(_) => {
                watcher.confirm_prepared_write(&prepared);
                return Ok(ImportedDatabaseAsset {
                    database_id: request.database_id.clone(),
                    note_id: request.note_id.clone(),
                    asset_id,
                    name: name.clone(),
                    relative_path: format!("assets/{}/{}", request.note_id, name),
                    mime_type: mime_type_for(&name),
                    size_bytes: metadata.len(),
                });
            }
            Err(AtomicCreateError::AlreadyExists) => watcher.cancel_prepared_write(&prepared),
            Err(AtomicCreateError::Other(error)) => {
                watcher.cancel_prepared_write(&prepared);
                return Err(error);
            }
        }
    }
    Err("Could not allocate a unique database asset filename".to_owned())
}

fn mime_type_for(name: &str) -> String {
    match name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::mutations::{create_database, CreateDatabaseRequest, DatabaseCreateMode};
    use crate::database::rows::{create_database_row, CreateDatabaseRowRequest};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn imports_assets_into_a_row_scoped_directory() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let vault = std::env::temp_dir().join(format!("amby-db-asset-{stamp}"));
        std::fs::create_dir_all(&vault).unwrap();
        let database = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Media".to_owned(),
            },
        )
        .unwrap();
        let row = create_database_row(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id.clone(),
                title: "Row".to_owned(),
            },
        )
        .unwrap();
        let source = vault.join("outside.png");
        std::fs::write(&source, b"png").unwrap();
        let asset = import_database_asset(
            &vault,
            &WatcherState::new(),
            &ImportDatabaseAssetRequest {
                expected_generation: 1,
                database_id: database.database_id,
                note_id: row.note_id.clone(),
                source_path: source.to_string_lossy().to_string(),
            },
        )
        .unwrap();
        assert!(asset.relative_path.starts_with("assets/"));
        assert!(vault
            .join("Media/.ambd")
            .join(&asset.relative_path)
            .is_file());
        let _ = std::fs::remove_dir_all(vault);
    }
}
