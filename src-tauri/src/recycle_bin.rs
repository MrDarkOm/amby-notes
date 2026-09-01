use crate::bundle::{path_string, resolve_item_root};
use crate::frontmatter;
use crate::model::{FsMutationResult, PathChange};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ulid::Ulid;

const TRASH_DIR: &str = "trash";

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub original_path: String,
    pub deleted_at_ms: u64,
    pub name: String,
}

/// Filesystem state determined before a trash move publishes its rename
/// events. Commands use it to register exact `Missing` watcher records first.
#[derive(Clone, Debug)]
pub struct TrashMovePreview {
    pub original_path: PathBuf,
    pub deleted_paths: Vec<PathBuf>,
}

/// Filesystem state determined before a trash restore publishes its rename
/// events. `restored_paths` are source payload paths, paired with paths below
/// `destination` in the eventual vault tree.
#[derive(Clone, Debug)]
pub struct TrashRestorePreview {
    pub manifest: PathBuf,
    pub destination: PathBuf,
    pub payload: PathBuf,
    pub restored_paths: Vec<PathBuf>,
}

fn root(vault: &Path) -> PathBuf {
    vault.join(".amby").join(TRASH_DIR)
}

fn manifest_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}

fn collect_markdown_paths(path: &Path) -> Result<Vec<PathBuf>, String> {
    if path.is_file() {
        return Ok(
            if path.extension().is_some_and(|extension| extension == "md") {
                vec![path.to_path_buf()]
            } else {
                Vec::new()
            },
        );
    }
    if !path.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        paths.extend(collect_markdown_paths(
            &entry.map_err(|error| error.to_string())?.path(),
        )?);
    }
    Ok(paths)
}

pub fn preview_move_to_trash(vault: &Path, path: &Path) -> Result<TrashMovePreview, String> {
    let requested_path = path.canonicalize().map_err(|error| error.to_string())?;
    let original_path = resolve_item_root(&requested_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let vault_path = vault.canonicalize().map_err(|error| error.to_string())?;
    if !original_path.starts_with(&vault_path) {
        return Err("Cannot trash a path outside the vault".to_string());
    }
    Ok(TrashMovePreview {
        deleted_paths: collect_markdown_paths(&original_path)?,
        original_path,
    })
}

pub fn move_to_trash(vault: &Path, path: &Path) -> Result<FsMutationResult, String> {
    let preview = preview_move_to_trash(vault, path)?;
    let original_path = preview.original_path;
    let vault_path = vault.canonicalize().map_err(|error| error.to_string())?;
    let original_relative = original_path
        .strip_prefix(&vault_path)
        .map_err(|_| "Cannot determine the vault-relative trash path".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let deleted_paths = preview
        .deleted_paths
        .iter()
        .map(|path| path_string(path))
        .collect();
    let id = Ulid::generate().to_string();
    let trash_root = root(vault);
    let container = trash_root.join(&id);
    fs::create_dir_all(&container).map_err(|error| error.to_string())?;
    let name = original_path
        .file_name()
        .ok_or("Trash target has no name")?
        .to_string_lossy()
        .to_string();
    let payload = container.join(&name);
    fs::rename(&original_path, &payload).map_err(|error| error.to_string())?;
    let entry = TrashEntry {
        id: id.clone(),
        original_path: original_relative,
        deleted_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64,
        name,
    };
    if let Err(error) = frontmatter::atomic_write_bytes(
        &manifest_path(&trash_root, &id),
        &serde_json::to_vec_pretty(&entry).map_err(|error| error.to_string())?,
    ) {
        let _ = fs::rename(&payload, &original_path);
        let _ = fs::remove_dir(&container);
        return Err(error);
    }
    Ok(FsMutationResult {
        primary_id: None,
        primary_path: None,
        path_changes: Vec::new(),
        deleted_paths,
        deleted_ids: Vec::new(),
    })
}

pub fn preview_restore(vault: &Path, id: &str) -> Result<TrashRestorePreview, String> {
    id.parse::<Ulid>()
        .map_err(|_| "Invalid trash identifier".to_string())?;
    let trash_root = root(vault);
    let manifest = manifest_path(&trash_root, id);
    let entry: TrashEntry =
        serde_json::from_slice(&fs::read(&manifest).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if entry.id != id {
        return Err("Invalid trash manifest".to_string());
    }
    let destination = crate::paths::confine_rel(vault, &entry.original_path)?;
    if destination.exists() {
        return Err(format!(
            "Cannot restore because the original path is occupied: {}",
            destination.display()
        ));
    }
    let payload = trash_root.join(id).join(&entry.name);
    Ok(TrashRestorePreview {
        manifest,
        destination,
        restored_paths: collect_markdown_paths(&payload)?,
        payload,
    })
}

pub fn list(vault: &Path) -> Vec<TrashEntry> {
    let mut entries = fs::read_dir(root(vault))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<TrashEntry>(&bytes).ok())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.deleted_at_ms));
    entries
}

pub fn restore(vault: &Path, id: &str) -> Result<FsMutationResult, String> {
    let preview = preview_restore(vault, id)?;
    let trash_root = root(vault);
    let payload_root = preview.payload.clone();
    let destination_root = preview.destination.clone();
    fs::create_dir_all(
        preview
            .destination
            .parent()
            .ok_or("Restore target has no parent")?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&preview.payload, &preview.destination).map_err(|error| error.to_string())?;
    let primary_path = if preview.destination.is_dir() {
        preview
            .destination
            .file_name()
            .map(|name| {
                preview
                    .destination
                    .join(format!("{}.md", name.to_string_lossy()))
            })
            .filter(|main| main.is_file())
            .unwrap_or_else(|| preview.destination.clone())
    } else {
        preview.destination.clone()
    };
    let path_changes = preview
        .restored_paths
        .into_iter()
        .filter_map(|old_path| {
            let relative = old_path.strip_prefix(&payload_root).ok()?;
            Some(PathChange {
                old_path: String::new(),
                new_path: path_string(&destination_root.join(relative)),
            })
        })
        .collect();
    fs::remove_file(preview.manifest).map_err(|error| error.to_string())?;
    fs::remove_dir(trash_root.join(id)).map_err(|error| error.to_string())?;
    Ok(FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&primary_path)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}

pub fn purge(vault: &Path, id: &str) -> Result<(), String> {
    id.parse::<Ulid>().map_err(|_| "Invalid trash identifier".to_string())?;
    let trash_root = root(vault);
    let manifest = manifest_path(&trash_root, id);
    if !manifest.is_file() { return Err("Trash entry not found".to_string()); }
    fs::remove_file(manifest).map_err(|error| error.to_string())?;
    let payload = trash_root.join(id);
    if payload.exists() { fs::remove_dir_all(payload).map_err(|error| error.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_a_deleted_tree_with_its_attachment() {
        let vault = std::env::temp_dir().join(format!("amby-trash-{}", Ulid::generate()));
        let tree = vault.join("Folder");
        fs::create_dir_all(tree.join("assets")).unwrap();
        fs::write(tree.join("Note.md"), "note").unwrap();
        fs::write(tree.join("assets/image.png"), "image").unwrap();
        let deleted = move_to_trash(&vault, &tree).unwrap();
        assert_eq!(deleted.deleted_paths.len(), 1);
        let entry = list(&vault).pop().unwrap();

        let restored = restore(&vault, &entry.id).unwrap();
        assert_eq!(restored.path_changes.len(), 1);
        assert_eq!(fs::read_to_string(tree.join("Note.md")).unwrap(), "note");
        assert_eq!(
            fs::read_to_string(tree.join("assets/image.png")).unwrap(),
            "image"
        );
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn trashing_a_super_note_moves_and_restores_the_entire_bundle() {
        let vault = std::env::temp_dir().join(format!("amby-trash-bundle-{}", Ulid::generate()));
        let bundle = vault.join("Parent");
        fs::create_dir_all(bundle.join("assets")).unwrap();
        let main = bundle.join("Parent.md");
        fs::write(&main, "main").unwrap();
        fs::write(bundle.join("Parent.canvas"), "canvas").unwrap();
        fs::write(bundle.join("Parent.excalidraw"), "draw").unwrap();
        fs::write(bundle.join("Child.md"), "child").unwrap();
        fs::write(bundle.join("assets/image.png"), "image").unwrap();

        let deleted = move_to_trash(&vault, &main).unwrap();

        assert!(!bundle.exists());
        assert_eq!(deleted.deleted_paths.len(), 2);
        let entry = list(&vault).pop().unwrap();
        let restored = restore(&vault, &entry.id).unwrap();

        assert_eq!(
            Path::new(restored.primary_path.as_deref().unwrap())
                .canonicalize()
                .unwrap(),
            main.canonicalize().unwrap()
        );
        assert_eq!(fs::read_to_string(&main).unwrap(), "main");
        assert_eq!(
            fs::read_to_string(bundle.join("Parent.canvas")).unwrap(),
            "canvas"
        );
        assert_eq!(
            fs::read_to_string(bundle.join("Parent.excalidraw")).unwrap(),
            "draw"
        );
        assert_eq!(
            fs::read_to_string(bundle.join("Child.md")).unwrap(),
            "child"
        );
        assert_eq!(
            fs::read_to_string(bundle.join("assets/image.png")).unwrap(),
            "image"
        );
        fs::remove_dir_all(vault).unwrap();
    }
}
