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

const MAX_RESOLVED_ASSETS: usize = 200;
const PREVIEW_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolveDatabaseAssetPathsRequest {
    pub expected_generation: u64,
    pub database_id: String,
    /// Stored `assets/<note-id>/<file>` paths from Files values.
    pub relative_paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDatabaseAssetPaths {
    /// Absolute path per requested item, in request order; `None` when the
    /// asset is missing, not a regular image file, or not a database asset path.
    pub paths: Vec<Option<String>>,
}

/// Resolves stored Files paths to absolute image paths for card covers. Nothing
/// outside `<container>/.ambd/assets/<note-id>/` is ever returned, and links are
/// rejected, so the renderer cannot be steered to another file by edited data.
pub fn resolve_database_asset_paths(
    vault: &Path,
    request: &ResolveDatabaseAssetPathsRequest,
) -> Result<ResolvedDatabaseAssetPaths, String> {
    if request.relative_paths.len() > MAX_RESOLVED_ASSETS {
        return Err(format!(
            "At most {MAX_RESOLVED_ASSETS} assets can be resolved at once"
        ));
    }
    let container = super::mutations::find_database_container(vault, &request.database_id)?;
    let assets_root = container.join(".ambd");
    let paths = request
        .relative_paths
        .iter()
        .map(|relative| resolve_one_asset(vault, &assets_root, relative))
        .collect();
    Ok(ResolvedDatabaseAssetPaths { paths })
}

fn resolve_one_asset(vault: &Path, base: &Path, relative: &str) -> Option<String> {
    let segments: Vec<&str> = relative.split('/').collect();
    let [assets, note_id, name] = segments.as_slice() else {
        return None;
    };
    let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
    if *assets != "assets"
        || ulid::Ulid::from_string(note_id).is_err()
        || name.is_empty()
        || name.starts_with('.')
        || name.contains(['\\', ':'])
        || !PREVIEW_EXTENSIONS.contains(&extension.as_str())
    {
        return None;
    }
    // `confine` resolves links, so check every link in the chain lexically: a
    // link anywhere (`.ambd`, `assets`, the row folder or the file) is refused.
    let mut path = base.to_path_buf();
    for part in [".", assets, note_id, name] {
        if part != "." {
            path.push(part);
        }
        if fs::symlink_metadata(&path).ok()?.file_type().is_symlink() {
            return None;
        }
    }
    let path = paths::confine(vault, &path).ok()?;
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ATTACHMENT_FILE_SIZE {
        return None;
    }
    Some(path.to_string_lossy().into_owned())
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
    use crate::database::rows::{
        create_database_row, CreateDatabaseRowRequest, DatabaseRowTemplate,
    };
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
                template: DatabaseRowTemplate::Default,
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

    #[test]
    fn resolves_only_regular_image_assets_inside_the_database() {
        let vault =
            std::env::temp_dir().join(format!("amby-asset-resolve-{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(&vault).unwrap();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Media".to_owned(),
            },
        )
        .unwrap();
        let note_id = ulid::Ulid::generate().to_string();
        let dir = vault.join("Media/.ambd/assets").join(&note_id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cover.png"), b"png").unwrap();
        std::fs::write(dir.join("notes.txt"), b"text").unwrap();
        let outside = vault.join("secret.png");
        std::fs::write(&outside, b"secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("link.png")).unwrap();

        let ask = |paths: Vec<String>| {
            resolve_database_asset_paths(
                &vault,
                &ResolveDatabaseAssetPathsRequest {
                    expected_generation: 1,
                    database_id: created.database_id.clone(),
                    relative_paths: paths,
                },
            )
        };
        let good = format!("assets/{note_id}/cover.png");
        let resolved = ask(vec![
            good.clone(),
            format!("assets/{note_id}/missing.png"),
            format!("assets/{note_id}/notes.txt"),
            format!("assets/{note_id}/link.png"),
            format!("assets/{note_id}/../../../../secret.png"),
            "assets/not-an-id/cover.png".to_owned(),
            "/etc/passwd.png".to_owned(),
            format!("assets/{note_id}/dir\\cover.png"),
        ])
        .unwrap();
        assert!(resolved.paths[0].as_deref().unwrap().ends_with("cover.png"));
        assert!(
            resolved.paths[1..].iter().all(Option::is_none),
            "{:?}",
            resolved.paths
        );
        assert!(ask(vec![good; MAX_RESOLVED_ASSETS + 1]).is_err());
        let _ = std::fs::remove_dir_all(vault);
    }
}
