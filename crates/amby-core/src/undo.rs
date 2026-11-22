//! Exact undo of operations that changed other notes: a rename or a move that rewrote links, and a
//! merge (docs/notices.md, section 9). The undo never rewrites links back, because a note that
//! already linked to the new name would be changed too. It writes back the bytes each rewritten note
//! had, from the version the operation kept, after checking that nothing changed since.
//!
//! This module holds the filesystem part. The desktop command around it holds the mutation gate,
//! marks the writes as the app's own and brings the index in step.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::bundle::{path_string, rollback_move_item, rollback_rename_item};
use crate::model::{FsMutationResult, PathChange, RewrittenNote, UndoRecord};
use crate::storage_error::{StorageError, StorageErrorCode};

/// SHA-256 of the bytes an operation wrote, as lowercase hex.
pub fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn moved(detail: impl Into<String>) -> StorageError {
    StorageError::new(StorageErrorCode::UndoItemMoved, detail)
}

pub fn changed(detail: impl Into<String>) -> StorageError {
    StorageError::new(StorageErrorCode::UndoNoteChanged, detail)
}

pub fn unavailable(detail: impl Into<String>) -> StorageError {
    StorageError::new(StorageErrorCode::UndoUnavailable, detail)
}

/// A path of the record, inside the vault.
pub fn confined(vault: &Path, path: &str) -> Result<PathBuf, StorageError> {
    crate::paths::confine(vault, Path::new(path))
        .map_err(|error| StorageError::new(StorageErrorCode::InvalidPath, error))
}

/// A rewritten file ready to be put back: its current bytes (what the operation wrote, checked by
/// digest) and the bytes from before.
pub struct PreparedRestore {
    pub path: PathBuf,
    pub current: Vec<u8>,
    pub previous: Vec<u8>,
}

/// Checks that each rewritten file still holds exactly what the operation wrote, and reads the
/// version to put back. Nothing is written.
pub fn prepare_restores(
    vault: &Path,
    notes: &[RewrittenNote],
) -> Result<Vec<PreparedRestore>, StorageError> {
    let mut prepared = Vec::with_capacity(notes.len());
    for note in notes {
        let path = confined(vault, &note.path)?;
        let current = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(moved(format!("Rewritten file is gone: {}", note.path)));
            }
            Err(error) => return Err(StorageError::from_io(&error)),
        };
        if digest(&current) != note.digest {
            return Err(changed(format!("Changed since: {}", note.path)));
        }
        let previous = crate::history::read_snapshot_bytes(vault, &note.snapshot_id)
            .map_err(|error| unavailable(format!("Version {}: {error}", note.snapshot_id)))?;
        prepared.push(PreparedRestore {
            path,
            current,
            previous,
        });
    }
    Ok(prepared)
}

/// Writes the previous bytes back. A failure puts the files already written back to what the
/// operation wrote, so the vault is as it was before the undo.
pub fn write_previous(prepared: &[PreparedRestore]) -> Result<(), String> {
    for (index, restore) in prepared.iter().enumerate() {
        if let Err(error) = crate::frontmatter::atomic_write_bytes(&restore.path, &restore.previous)
        {
            write_current(&prepared[..index]);
            return Err(error);
        }
    }
    Ok(())
}

/// Puts back what the operation wrote (the rollback of [`write_previous`]).
pub fn write_current(prepared: &[PreparedRestore]) {
    for restore in prepared.iter().rev() {
        if let Err(error) = crate::frontmatter::atomic_write_bytes(&restore.path, &restore.current)
        {
            tracing::warn!(event = "undo_rollback_write_failed", %error);
        }
    }
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// The item is where the rename or the move left it, and its old place is free. Refuses with
/// `UndoItemMoved` otherwise. `old_root` is the place the item comes back to.
pub fn check_location(
    vault: &Path,
    primary_path: &str,
    old_root: &Path,
    path_changes: &[PathChange],
) -> Result<(), StorageError> {
    let primary = confined(vault, primary_path)?;
    if !exists(&primary) {
        return Err(moved("The item is no longer where the operation left it"));
    }
    if exists(old_root) {
        return Err(moved("The old place of the item is taken"));
    }
    for change in path_changes {
        if change.old_path.is_empty() || change.new_path.is_empty() {
            continue;
        }
        if !exists(&confined(vault, &change.new_path)?) {
            return Err(moved(format!("Moved since: {}", change.new_path)));
        }
        if exists(&confined(vault, &change.old_path)?) {
            return Err(moved(format!("Old place taken: {}", change.old_path)));
        }
    }
    Ok(())
}

/// The root of the item before a rename: the group folder of a main note, otherwise the path.
pub fn rename_old_root(vault: &Path, original: &Path, primary: &Path) -> PathBuf {
    let in_group = |path: &Path| {
        let stem = path.file_stem();
        let parent = path.parent();
        parent.is_some_and(|dir| dir != vault && dir.file_name() == stem && stem.is_some())
    };
    // A main note of a group was renamed with its folder.
    if !in_group(original) || !in_group(primary) {
        return original.to_path_buf();
    }
    original.parent().map(Path::to_path_buf).unwrap_or_default()
}

/// The root of the item before a move: the group folder of a main note, otherwise the path.
pub fn move_old_root(vault: &Path, source: &Path, primary: &Path) -> PathBuf {
    let stem = source.file_stem();
    match source.parent() {
        Some(parent)
            if parent != vault
                && parent.file_name() == stem
                && primary.parent().and_then(Path::file_name) == stem =>
        {
            parent.to_path_buf()
        }
        _ => source.to_path_buf(),
    }
}

/// The reverse of the record's path changes, for the index, the tree and the history.
pub fn inverse_changes(changes: &[PathChange]) -> Vec<PathChange> {
    changes
        .iter()
        .filter(|change| !change.old_path.is_empty() && !change.new_path.is_empty())
        .map(|change| PathChange {
            old_path: change.new_path.clone(),
            new_path: change.old_path.clone(),
        })
        .collect()
}

/// Where a path is after the undo.
pub fn path_after_undo(changes: &[PathChange], path: &Path) -> PathBuf {
    let text = path_string(path);
    for change in changes {
        if change.new_path == text {
            return PathBuf::from(&change.old_path);
        }
    }
    path.to_path_buf()
}

fn result_with(primary: Option<String>, path_changes: Vec<PathChange>) -> FsMutationResult {
    FsMutationResult {
        primary_id: None,
        primary_path: primary,
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
        tree_patch: None,
        also_touched: Vec::new(),
        undo: None,
    }
}

/// Moves or renames the item back, without touching any link. Returns the result of the undo as a
/// mutation: the reverse path changes, with the item's old place as the primary path.
pub fn reverse_paths(vault: &Path, record: &UndoRecord) -> Result<FsMutationResult, String> {
    match record {
        UndoRecord::Rename {
            original_path,
            primary_path,
            path_changes,
            extra_renames,
            ..
        } => {
            let original = Path::new(original_path);
            let done = result_with(Some(primary_path.clone()), path_changes.clone());
            rollback_rename_item(vault, original, &done)?;
            // A database folder's own description was renamed with the folder: it is now inside the
            // folder at its old place, under the new name.
            let old_dir = original;
            for extra in extra_renames {
                let (Some(new_name), Some(old_name)) = (
                    Path::new(&extra.new_path).file_name(),
                    Path::new(&extra.old_path).file_name(),
                ) else {
                    continue;
                };
                let current = old_dir.join(new_name);
                let previous = old_dir.join(old_name);
                if current.is_file() && !exists(&previous) {
                    crate::atomic_fs::rename_no_replace(&current, &previous)
                        .map_err(|error| error.to_string())?;
                }
            }
            Ok(result_with(
                Some(original_path.clone()),
                inverse_changes(path_changes),
            ))
        }
        UndoRecord::Move {
            source_path,
            target_path,
            primary_path,
            path_changes,
            ..
        } => {
            let done = result_with(Some(primary_path.clone()), path_changes.clone());
            rollback_move_item(vault, Path::new(source_path), Path::new(target_path), &done)?;
            Ok(result_with(
                Some(source_path.clone()),
                inverse_changes(path_changes),
            ))
        }
        UndoRecord::Merge { .. } => Err("A merge is not undone by moving paths".into()),
    }
}
