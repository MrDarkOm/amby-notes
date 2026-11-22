//! «Вернуть» for operations that changed other notes (docs/notices.md, section 9): a rename or a
//! move that rewrote links, and a merge of two notes. The undo is exact and never rewrites links
//! back; the filesystem part is `amby_core::undo`. Everything runs under the mutation gate.

use std::fs;
use std::path::{Path, PathBuf};

use crate::bundle::path_string;
use crate::commands::mutations::{
    archive_item_locked, finish_path_mutation, notify_moved_paths, notify_structural_mutation,
    prepare_path_changes, sync_mutation_result,
};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::lock_util::LockExt;
use crate::model::*;
use crate::paths;
use crate::storage_error::{StorageError, StorageErrorCode};
use crate::vault_context::VaultContext;
use crate::vault_index;
use crate::watcher::{self, WatcherState};
use amby_core::undo::{self as core_undo, confined};

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn undo_mutation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher_state: tauri::State<'_, WatcherState>,
    sync_runtime: tauri::State<'_, crate::sync::runtime::SyncRuntime>,
    record: UndoRecord,
) -> Result<MutationOutcome, StorageError> {
    let outcome = undo_mutation_inner(
        &db,
        &runtime,
        &watcher_state,
        &|root, changes| sync_runtime.note_renames(root, changes),
        record,
    )?;
    notify_moved_paths(&app, window.label(), &outcome);
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

/// The merge keeps the target's text as a version before the renderer writes the merged text.
#[tauri::command]
#[specta::specta]
pub fn begin_merge(
    db: tauri::State<'_, VaultContext>,
    target_path: String,
) -> Result<String, StorageError> {
    begin_merge_inner(&db, target_path)
}

/// After the merged text is saved: the merged note goes to the archive, and the result carries
/// the record that undoes the merge.
#[tauri::command]
#[specta::specta]
pub fn finish_merge(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher_state: tauri::State<'_, WatcherState>,
    source_path: String,
    target_path: String,
    snapshot_id: String,
) -> Result<MutationOutcome, StorageError> {
    let outcome = finish_merge_inner(
        &db,
        &runtime,
        &watcher_state,
        source_path,
        target_path,
        snapshot_id,
    )?;
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

pub(crate) fn begin_merge_inner(
    db: &VaultContext,
    target_path: String,
) -> Result<String, StorageError> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let target = paths::guard(db, &target_path)?;
    let vault = db.root()?;
    Ok(crate::history::snapshot_current(
        &vault,
        &target,
        crate::history::MERGE_REASON,
    )?)
}

pub(crate) fn finish_merge_inner(
    db: &VaultContext,
    runtime: &DatabaseRuntimeState,
    watcher_state: &WatcherState,
    source_path: String,
    target_path: String,
    snapshot_id: String,
) -> Result<MutationOutcome, StorageError> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let source = paths::guard(db, &source_path)?;
    let target = paths::guard(db, &target_path)?;
    let vault = db.root()?;
    // The version must be there now, or the merge would not be undoable.
    crate::history::read_snapshot_bytes(&vault, &snapshot_id)
        .map_err(|error| core_undo::unavailable(format!("Merge version: {error}")))?;
    let merged = fs::read(&target).map_err(|error| StorageError::from_io(&error))?;
    let source_bytes = fs::read(&source).ok();
    let archived = archive_item_locked(db, watcher_state, Some(runtime), &source_path)?;
    let (mut outcome, archive_id, archived) = (
        archived.outcome,
        archived.archive_id,
        archived.original_path,
    );
    outcome.mutation.undo = archive_id.map(|archive_id| UndoRecord::Merge {
        target: RewrittenNote {
            path: path_string(&target),
            snapshot_id,
            digest: core_undo::digest(&merged),
        },
        source_path: path_string(&archived),
        archive_id,
        source_digest: (archived == source)
            .then(|| source_bytes.as_deref().map(core_undo::digest))
            .flatten(),
    });
    Ok(outcome)
}

pub(crate) fn undo_mutation_inner(
    db: &VaultContext,
    runtime: &DatabaseRuntimeState,
    watcher_state: &WatcherState,
    note_renames: &dyn Fn(&Path, &[PathChange]),
    record: UndoRecord,
) -> Result<MutationOutcome, StorageError> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let vault = db.root()?;
    let outcome = match &record {
        UndoRecord::Merge {
            target,
            source_path,
            archive_id,
            source_digest,
        } => undo_merge(
            db,
            watcher_state,
            &vault,
            target,
            source_path,
            archive_id,
            source_digest.as_deref(),
        ),
        _ => undo_paths(db, runtime, watcher_state, note_renames, &vault, &record),
    };
    match &outcome {
        Ok(_) => tracing::info!(event = "undo_mutation"),
        Err(error) => tracing::info!(event = "undo_mutation_refused", code = ?error.code),
    }
    outcome
}

fn undo_paths(
    db: &VaultContext,
    runtime: &DatabaseRuntimeState,
    watcher_state: &WatcherState,
    note_renames: &dyn Fn(&Path, &[PathChange]),
    vault: &Path,
    record: &UndoRecord,
) -> Result<MutationOutcome, StorageError> {
    let (primary_path, old_root, changes, extra, rewritten) = match record {
        UndoRecord::Rename {
            original_path,
            primary_path,
            path_changes,
            extra_renames,
            rewritten,
        } => {
            let original = confined(vault, original_path)?;
            let primary = confined(vault, primary_path)?;
            for extra in extra_renames {
                confined(vault, &extra.old_path)?;
                confined(vault, &extra.new_path)?;
            }
            (
                primary_path,
                core_undo::rename_old_root(vault, &original, &primary),
                path_changes,
                extra_renames.as_slice(),
                rewritten,
            )
        }
        UndoRecord::Move {
            source_path,
            target_path,
            primary_path,
            path_changes,
            rewritten,
        } => {
            let source = confined(vault, source_path)?;
            confined(vault, target_path)?;
            let primary = confined(vault, primary_path)?;
            (
                primary_path,
                core_undo::move_old_root(vault, &source, &primary),
                path_changes,
                &[][..],
                rewritten,
            )
        }
        UndoRecord::Merge { .. } => {
            return Err(core_undo::unavailable("Not a path operation"));
        }
    };
    core_undo::check_location(vault, primary_path, &old_root, changes)?;
    let prepared = core_undo::prepare_restores(vault, rewritten)?;
    let inverse = core_undo::inverse_changes(changes);
    // Synchronisation learns that this is a move, before the change reaches the disk (Д70).
    note_renames(vault, &inverse);
    let generation = db.generation()?;
    let prepared_moves = prepare_path_changes(watcher_state, &inverse);
    watcher_state
        .self_writes
        .mark_write(prepared.iter().map(|restore| restore.path.clone()));
    if let Err(error) = core_undo::write_previous(&prepared) {
        watcher_state
            .self_writes
            .cancel_prepared_write(&prepared_moves);
        return Err(StorageError::from(error));
    }
    let result = match core_undo::reverse_paths(vault, record) {
        Ok(result) => {
            watcher_state
                .self_writes
                .confirm_prepared_write(&prepared_moves);
            result
        }
        Err(error) => {
            watcher_state
                .self_writes
                .cancel_prepared_write(&prepared_moves);
            core_undo::write_current(&prepared);
            return Err(StorageError::from(format!(
                "Undo failed and was rolled back: {error}"
            )));
        }
    };
    let mut moved = changes.to_vec();
    moved.extend(extra.iter().cloned());
    let restored = prepared
        .iter()
        .map(|restore| core_undo::path_after_undo(&moved, &restore.path))
        .collect::<Vec<PathBuf>>();
    Ok(finish_path_mutation(
        db,
        runtime,
        watcher_state,
        vault,
        generation,
        result,
        restored,
        "undo",
    )?)
}

fn undo_merge(
    db: &VaultContext,
    watcher_state: &WatcherState,
    vault: &Path,
    target: &RewrittenNote,
    source_path: &str,
    archive_id: &str,
    source_digest: Option<&str>,
) -> Result<MutationOutcome, StorageError> {
    let source = confined(vault, source_path)?;
    let archived = crate::archive::entry_path(vault, archive_id)
        .ok_or_else(|| core_undo::unavailable("The merged note is no longer in the archive"))?;
    if let Some(expected) = source_digest {
        let bytes = fs::read(&archived).map_err(|error| StorageError::from_io(&error))?;
        if core_undo::digest(&bytes) != expected {
            return Err(core_undo::unavailable("The archived note is another one"));
        }
    }
    if fs::symlink_metadata(&source).is_ok() {
        return Err(core_undo::moved("The merged note's place is taken"));
    }
    let prepared = core_undo::prepare_restores(vault, std::slice::from_ref(target))?;
    let generation = db.generation()?;
    let mut writes = vec![(
        source.clone(),
        watcher::path_fingerprint_for_move(&archived),
    )];
    writes.extend(prepared.iter().map(|restore| {
        (
            restore.path.clone(),
            watcher::fingerprint_for_bytes(&restore.previous),
        )
    }));
    let prepared_writes = watcher_state.self_writes.prepare_write(writes);
    if let Err(error) = core_undo::write_previous(&prepared) {
        watcher_state
            .self_writes
            .cancel_prepared_write(&prepared_writes);
        return Err(StorageError::from(error));
    }
    if let Err(error) = crate::archive::restore_exact(vault, archive_id, &source) {
        watcher_state
            .self_writes
            .cancel_prepared_write(&prepared_writes);
        core_undo::write_current(&prepared);
        return Err(StorageError::from(format!(
            "Undo failed and was rolled back: {error}"
        )));
    }
    watcher_state
        .self_writes
        .confirm_prepared_write(&prepared_writes);
    let restored_markdown = crate::recycle_bin::markdown_like(&source);
    let result = FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&source)),
        path_changes: if restored_markdown {
            vec![PathChange {
                old_path: String::new(),
                new_path: path_string(&source),
            }]
        } else {
            Vec::new()
        },
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
        tree_patch: None,
        also_touched: Vec::new(),
        undo: None,
    };
    let mut outcome = sync_mutation_result(db, vault, result);
    let target_path = prepared[0].path.clone();
    {
        let conn_guard = db.conn.lock_or_recover();
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| StorageError::new(StorageErrorCode::Failed, "No vault open"))?;
        let changed = std::collections::HashSet::from([target_path.clone()]);
        let synced = vault_index::sync_paths(conn, vault, &changed).and_then(|done| match done {
            Some(_) => Ok(()),
            None => vault_index::sync_vault(conn, vault).map(|_| ()),
        });
        if let Err(error) = synced {
            tracing::warn!(event = "index_update_failed", %error);
            outcome.index_state = IndexState::RebuildRequired;
            outcome
                .warnings
                .push(OperationWarning::IndexRebuildRequired);
        }
    }
    outcome.rewritten_notes = Some((generation, vec![target_path]));
    Ok(outcome)
}
