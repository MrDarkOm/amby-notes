use crate::bundle::{path_string, resolve_item_root};
use crate::frontmatter;
use crate::model::{FsMutationResult, PathChange};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ulid::Ulid;

const TRASH_DIR: &str = "trash";

/// Where `delete_item` sends an item. `System` is the default; `Vault` keeps a
/// restorable copy under `.amby/trash`; `Permanent` removes the item for good
/// and must only be requested after an explicit user confirmation.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DeleteMode {
    #[default]
    System,
    Vault,
    Permanent,
}

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

/// Removes an item without keeping any copy. Bundles and their Markdown index
/// entries are resolved exactly like a trash move so callers can report the
/// same `deleted_paths`.
pub fn delete_permanently(vault: &Path, path: &Path) -> Result<FsMutationResult, String> {
    let preview = preview_move_to_trash(vault, path)?;
    let deleted_paths = preview
        .deleted_paths
        .iter()
        .map(|path| path_string(path))
        .collect();
    // `symlink_metadata` keeps a symlinked item from being followed: only the
    // link itself is removed, never its target.
    let metadata =
        fs::symlink_metadata(&preview.original_path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(&preview.original_path).map_err(|error| error.to_string())?;
    } else {
        fs::remove_file(&preview.original_path).map_err(|error| error.to_string())?;
    }
    Ok(FsMutationResult {
        primary_id: None,
        primary_path: None,
        path_changes: Vec::new(),
        deleted_paths,
        deleted_ids: Vec::new(),
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

/// A trash record that no longer matches its payload, typically after a crash
/// between moving the payload and writing (or removing) its manifest. Nothing
/// is deleted automatically: the evidence stays in `.amby/trash`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrashAnomaly {
    pub id: String,
    pub kind: TrashAnomalyKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrashAnomalyKind {
    /// A payload directory exists but its manifest was never written.
    PayloadWithoutManifest,
    /// A manifest exists but its payload is gone (e.g. interrupted restore).
    ManifestWithoutPayload,
}

pub fn detect_anomalies(vault: &Path) -> Vec<TrashAnomaly> {
    let trash_root = root(vault);
    let Ok(read_dir) = fs::read_dir(&trash_root) else {
        return Vec::new();
    };
    let mut anomalies = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if name.parse::<Ulid>().is_ok() && !manifest_path(&trash_root, name).is_file() {
                anomalies.push(TrashAnomaly {
                    id: name.to_owned(),
                    kind: TrashAnomalyKind::PayloadWithoutManifest,
                });
            }
        } else if let Some(id) = name.strip_suffix(".json") {
            let Ok(entry) =
                serde_json::from_slice::<TrashEntry>(&fs::read(&path).unwrap_or_default())
            else {
                continue;
            };
            if entry.id == id && !trash_root.join(id).join(&entry.name).exists() {
                anomalies.push(TrashAnomaly {
                    id: id.to_owned(),
                    kind: TrashAnomalyKind::ManifestWithoutPayload,
                });
            }
        }
    }
    anomalies.sort_by(|left, right| left.id.cmp(&right.id));
    anomalies
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
    if let Some(done) = finish_interrupted_restore(vault, id)? {
        return Ok(done);
    }
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

/// A restore that renamed the payload back but crashed before removing its
/// manifest leaves a record whose payload is gone while the destination exists.
/// Repeating the restore completes that cleanup instead of failing forever. It
/// only drops the stale record, never any file.
fn finish_interrupted_restore(vault: &Path, id: &str) -> Result<Option<FsMutationResult>, String> {
    id.parse::<Ulid>()
        .map_err(|_| "Invalid trash identifier".to_string())?;
    let trash_root = root(vault);
    let manifest = manifest_path(&trash_root, id);
    let Ok(bytes) = fs::read(&manifest) else {
        return Ok(None);
    };
    let Ok(entry) = serde_json::from_slice::<TrashEntry>(&bytes) else {
        return Ok(None);
    };
    if entry.id != id || trash_root.join(id).join(&entry.name).exists() {
        return Ok(None);
    }
    let destination = crate::paths::confine_rel(vault, &entry.original_path)?;
    if !destination.exists() {
        return Ok(None);
    }
    fs::remove_file(&manifest).map_err(|error| error.to_string())?;
    let _ = fs::remove_dir(trash_root.join(id));
    Ok(Some(FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&destination)),
        path_changes: Vec::new(),
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    }))
}

pub fn purge(vault: &Path, id: &str) -> Result<(), String> {
    id.parse::<Ulid>()
        .map_err(|_| "Invalid trash identifier".to_string())?;
    let trash_root = root(vault);
    let manifest = manifest_path(&trash_root, id);
    if !manifest.is_file() {
        return Err("Trash entry not found".to_string());
    }
    fs::remove_file(manifest).map_err(|error| error.to_string())?;
    let payload = trash_root.join(id);
    if payload.exists() {
        fs::remove_dir_all(payload).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_orphans_and_completes_an_interrupted_restore_without_deleting_files() {
        let vault = std::env::temp_dir().join(format!("amby-anomaly-{}", Ulid::generate()));
        fs::create_dir_all(&vault).unwrap();
        let note = vault.join("Note.md");
        fs::write(&note, "kept").unwrap();
        assert!(detect_anomalies(&vault).is_empty());

        // Crash after the payload was moved but before the manifest was written.
        let orphan = Ulid::generate().to_string();
        let orphan_dir = root(&vault).join(&orphan);
        fs::create_dir_all(&orphan_dir).unwrap();
        fs::write(orphan_dir.join("Lost.md"), "payload").unwrap();
        assert_eq!(
            detect_anomalies(&vault),
            vec![TrashAnomaly {
                id: orphan.clone(),
                kind: TrashAnomalyKind::PayloadWithoutManifest
            }]
        );
        assert_eq!(fs::read(orphan_dir.join("Lost.md")).unwrap(), b"payload");

        // Crash after a restore renamed the payload back, before manifest removal.
        move_to_trash(&vault, &note).unwrap();
        let id = list(&vault)[0].id.clone();
        let preview = preview_restore(&vault, &id).unwrap();
        fs::rename(&preview.payload, &preview.destination).unwrap();
        assert!(detect_anomalies(&vault)
            .iter()
            .any(|a| a.id == id && a.kind == TrashAnomalyKind::ManifestWithoutPayload));
        let finished = restore(&vault, &id).unwrap();
        assert_eq!(
            finished
                .primary_path
                .map(PathBuf::from)
                .map(|path| path.canonicalize().unwrap()),
            Some(note.canonicalize().unwrap())
        );
        assert_eq!(fs::read(&note).unwrap(), b"kept");
        assert!(list(&vault).is_empty());
        // The unrelated orphan is still untouched.
        assert!(orphan_dir.join("Lost.md").is_file());
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn permanent_delete_removes_item_without_a_trash_copy() {
        let vault = std::env::temp_dir().join(format!("amby-perm-{}", Ulid::generate()));
        let tree = vault.join("Folder");
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("Note.md"), "note").unwrap();
        let outside = vault.join("keep.md");
        fs::write(&outside, "keep").unwrap();
        let deleted = delete_permanently(&vault, &tree).unwrap();
        assert_eq!(deleted.deleted_paths.len(), 1);
        assert!(!tree.exists());
        assert!(list(&vault).is_empty(), "permanent delete keeps no copy");
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        assert!(delete_permanently(&vault, &tree).is_err());
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn permanent_delete_rejects_paths_outside_the_vault() {
        let base = std::env::temp_dir().join(format!("amby-perm-out-{}", Ulid::generate()));
        let vault = base.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let outside = base.join("outside.md");
        fs::write(&outside, "keep").unwrap();
        assert!(delete_permanently(&vault, &outside).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        fs::remove_dir_all(&base).ok();
    }

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

    #[test]
    fn trash_root_failure_keeps_the_source_intact() {
        let vault = std::env::temp_dir().join(format!("amby-trash-failure-{}", Ulid::generate()));
        fs::create_dir_all(vault.join(".amby")).unwrap();
        let source = vault.join("Note.md");
        fs::write(&source, "precious content").unwrap();
        fs::write(root(&vault), "blocks trash directory creation").unwrap();

        assert!(move_to_trash(&vault, &source).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), "precious content");
        assert!(root(&vault).is_file());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn restore_collision_keeps_both_original_and_trashed_bytes() {
        let vault = std::env::temp_dir().join(format!("amby-trash-collision-{}", Ulid::generate()));
        fs::create_dir_all(&vault).unwrap();
        let source = vault.join("Note.md");
        fs::write(&source, "original bytes").unwrap();
        move_to_trash(&vault, &source).unwrap();
        let entry = list(&vault).pop().unwrap();
        fs::write(&source, "new external bytes").unwrap();

        assert!(restore(&vault, &entry.id).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), "new external bytes");
        assert_eq!(
            fs::read_to_string(root(&vault).join(&entry.id).join("Note.md")).unwrap(),
            "original bytes"
        );
        assert_eq!(list(&vault).len(), 1);
        fs::remove_dir_all(vault).unwrap();
    }
}
