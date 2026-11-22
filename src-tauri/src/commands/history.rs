use crate::history;
use crate::lock_util::LockExt;
use crate::model::*;
use crate::paths;
use crate::recovery::RecoveryEntry;
use crate::recycle_bin;
use crate::vault_context::{PreparedMoveRefactor, VaultContext};
use crate::vault_index;
use crate::watcher::{self, WatcherState};
use std::path::{Path, PathBuf};

use super::mutations::{mutation_paths, sync_mutation_result};

fn scoped_recovery_root(
    context: &VaultContext,
    expected_generation: Option<u64>,
    expected_vault: Option<&str>,
) -> Result<(std::path::PathBuf, u64), String> {
    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or("No vault is open")?;
    if let Some(expected) = expected_generation {
        if active.generation != expected {
            return Err("Recovery draft belongs to an older vault activation".to_string());
        }
    }
    if let Some(expected) = expected_vault {
        let expected = Path::new(expected)
            .canonicalize()
            .map_err(|error| format!("Recovery vault is not accessible: {error}"))?;
        if expected != active.root {
            return Err("Recovery draft belongs to a different vault".to_string());
        }
    }
    Ok((active.root.clone(), active.generation))
}

#[tauri::command]
#[specta::specta]
pub fn list_snapshots(
    scope: tauri::State<paths::VaultScope>,
    source_path: String,
) -> Result<Vec<history::SnapshotEntry>, String> {
    let source_path = paths::guard(&scope, &source_path)?;
    history::list_snapshots(&scope.get()?, &source_path)
}

#[tauri::command]
#[specta::specta]
pub fn get_history_stats(
    scope: tauri::State<paths::VaultScope>,
) -> Result<history::HistoryStats, String> {
    history::get_history_stats(&scope.get()?)
}

#[tauri::command]
#[specta::specta]
pub fn cleanup_history(
    scope: tauri::State<paths::VaultScope>,
    retention: history::HistoryRetention,
    source_path: Option<String>,
) -> Result<history::HistoryCleanupResult, String> {
    let _mutation_guard = scope.mutation_gate.lock_or_recover();
    let source_path = source_path
        .as_deref()
        .map(|path| paths::guard(&scope, path))
        .transpose()?;
    history::cleanup_history_for_source(&scope.get()?, retention, source_path.as_deref())
}

#[tauri::command]
#[specta::specta]
pub fn preview_history_cleanup(
    scope: tauri::State<paths::VaultScope>,
    retention: history::HistoryRetention,
    source_path: Option<String>,
) -> Result<history::HistoryCleanupPreview, String> {
    let source_path = source_path
        .as_deref()
        .map(|path| paths::guard(&scope, path))
        .transpose()?;
    history::preview_history_cleanup_for_source(&scope.get()?, retention, source_path.as_deref())
}

#[tauri::command]
#[specta::specta]
pub fn restore_snapshot(
    app: tauri::AppHandle,
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    snapshot_id: String,
) -> Result<String, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let vault = scope.get()?;
    let generation = db.generation()?;
    let prepared_restore = history::prepare_snapshot_restore(&vault, &snapshot_id)?;
    let prepared_write = watcher_state.self_writes.prepare_write([(
        &prepared_restore.path,
        watcher::fingerprint_for_bytes(&prepared_restore.bytes),
    )]);
    let path = match history::commit_snapshot_restore(&vault, prepared_restore) {
        Ok(path) => {
            watcher_state
                .self_writes
                .confirm_prepared_write(&prepared_write);
            path
        }
        Err(error) => {
            watcher_state
                .self_writes
                .cancel_prepared_write(&prepared_write);
            return Err(error);
        }
    };
    watcher::notify_published_files(&app, &vault, generation, std::slice::from_ref(&path), None);
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    // One note was restored: re-read it and nothing else. Only a case the point update cannot
    // judge (see `sync_paths`) takes the full scan.
    let changed = std::collections::HashSet::from([path.clone()]);
    if vault_index::sync_paths(conn, &vault, &changed)?.is_none() {
        vault_index::sync_vault(conn, &vault)?;
    }
    Ok(crate::bundle::path_string(&path))
}

#[tauri::command]
#[specta::specta]
pub fn delete_snapshot(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    snapshot_id: String,
) -> Result<(), String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    history::delete_snapshot(&scope.get()?, &snapshot_id)
}

#[tauri::command]
#[specta::specta]
pub fn read_snapshot_text(
    scope: tauri::State<paths::VaultScope>,
    snapshot_id: String,
) -> Result<history::SnapshotText, String> {
    history::read_snapshot_text(&scope.get()?, &snapshot_id)
}

#[tauri::command]
#[specta::specta]
pub fn save_recovery(
    context: tauri::State<'_, VaultContext>,
    id: String,
    document_kind: String,
    path_hint: String,
    content: String,
    expected_generation: Option<u64>,
    expected_vault: Option<String>,
) -> Result<RecoveryEntry, String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let (vault, generation) =
        scoped_recovery_root(&context, expected_generation, expected_vault.as_deref())?;
    crate::recovery::save_recovery(
        &vault,
        generation,
        &id,
        &document_kind,
        &path_hint,
        &content,
    )
}

#[tauri::command]
#[specta::specta]
pub fn read_recovery(
    context: tauri::State<'_, VaultContext>,
    id: String,
    expected_generation: Option<u64>,
    expected_vault: Option<String>,
) -> Result<Option<RecoveryEntry>, String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let (vault, _) =
        scoped_recovery_root(&context, expected_generation, expected_vault.as_deref())?;
    crate::recovery::read_recovery(&vault, &id)
}

#[tauri::command]
#[specta::specta]
pub fn delete_recovery(
    context: tauri::State<'_, VaultContext>,
    id: String,
    expected_content_hash: Option<String>,
    expected_generation: Option<u64>,
    expected_vault: Option<String>,
) -> Result<(), String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let (vault, _) =
        scoped_recovery_root(&context, expected_generation, expected_vault.as_deref())?;
    crate::recovery::delete_recovery(&vault, &id, expected_content_hash.as_deref())
}

#[tauri::command]
#[specta::specta]
pub fn list_recovery(
    context: tauri::State<'_, VaultContext>,
    expected_generation: Option<u64>,
    expected_vault: Option<String>,
) -> Result<Vec<RecoveryEntry>, String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let (vault, _) =
        scoped_recovery_root(&context, expected_generation, expected_vault.as_deref())?;
    crate::recovery::list_recovery(&vault)
}

#[tauri::command]
#[specta::specta]
pub fn list_trash(
    scope: tauri::State<paths::VaultScope>,
) -> Result<Vec<recycle_bin::TrashEntry>, String> {
    Ok(recycle_bin::list(&scope.get()?))
}

#[tauri::command]
#[specta::specta]
pub fn read_trash_preview(
    scope: tauri::State<paths::VaultScope>,
    trash_id: String,
    relative_path: String,
) -> Result<recycle_bin::TrashPreview, String> {
    let _mutation_guard = scope.mutation_gate.lock_or_recover();
    recycle_bin::read_preview(&scope.get()?, &trash_id, &relative_path)
}

#[tauri::command]
#[specta::specta]
pub fn restore_trash(
    app: tauri::AppHandle,
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    trash_id: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let vault = scope.get()?;
    let generation = db.generation()?;
    let preview = recycle_bin::preview_restore(&vault, &trash_id)?;
    let mut writes = vec![(
        (preview.destination.clone()),
        watcher::path_fingerprint_for_move(&preview.payload),
    )];
    writes.extend(preview.restored_paths.iter().filter_map(|source| {
        let relative = source.strip_prefix(&preview.payload).ok()?;
        Some((
            preview.destination.join(relative),
            watcher::path_fingerprint_for_move(source),
        ))
    }));
    let mut restored_paths: Vec<_> = writes.iter().map(|(path, _)| path.clone()).collect();
    let prepared = watcher_state.self_writes.prepare_write(writes);
    let result = match recycle_bin::restore(&vault, &trash_id) {
        Ok(result) => {
            watcher_state.self_writes.confirm_prepared_write(&prepared);
            result
        }
        Err(error) => {
            watcher_state.self_writes.cancel_prepared_write(&prepared);
            return Err(error);
        }
    };
    let outcome = sync_mutation_result(&db, &vault, result);
    restored_paths.extend(mutation_paths(&outcome.mutation));
    restored_paths.sort();
    restored_paths.dedup();
    watcher::notify_published_files(&app, &vault, generation, &restored_paths, None);
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn purge_trash(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    trash_id: String,
) -> Result<(), String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    recycle_bin::purge(&scope.get()?, &trash_id)
}

/// The files of the archive `.amby/archive/` (docs/sync-plan.md, К6): the panel shows only these.
#[tauri::command]
#[specta::specta]
pub fn list_archive(
    db: tauri::State<'_, VaultContext>,
    vault_path: String,
) -> Result<Vec<crate::archive::ArchiveEntry>, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    Ok(crate::archive::list(&archive_vault(&db, &vault_path)?))
}

fn archive_vault(db: &VaultContext, vault_path: &str) -> Result<PathBuf, String> {
    let vault = db.root()?;
    if Path::new(vault_path).canonicalize().ok().as_ref() != Some(&vault) {
        return Err("Archive belongs to a different workspace".into());
    }
    Ok(vault)
}

/// A read-only look at an archived file (К6).
#[tauri::command]
#[specta::specta]
pub fn read_archive_preview(
    scope: tauri::State<paths::VaultScope>,
    archive_id: String,
    relative_path: String,
) -> Result<recycle_bin::TrashPreview, String> {
    let _mutation_guard = scope.mutation_gate.lock_or_recover();
    crate::archive::read_preview(&scope.get()?, &archive_id, &relative_path)
}

/// «Вернуть» from the archive (К6): without replacing, a free name when the path is taken; the
/// final path is `primary_path` of the mutation.
#[tauri::command]
#[specta::specta]
pub fn restore_archive(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    archive_id: String,
    vault_path: String,
) -> Result<MutationOutcome, String> {
    let ArchiveRestore {
        outcome,
        vault,
        generation,
        restored_paths,
    } = restore_archive_inner(&db, &watcher_state, &archive_id, &vault_path)?;
    watcher::notify_published_files(&app, &vault, generation, &restored_paths, None);
    Ok(outcome)
}

pub(crate) struct ArchiveRestore {
    pub(crate) outcome: MutationOutcome,
    vault: PathBuf,
    generation: u64,
    restored_paths: Vec<PathBuf>,
}

pub(crate) fn restore_archive_inner(
    db: &VaultContext,
    watcher_state: &WatcherState,
    archive_id: &str,
    vault_path: &str,
) -> Result<ArchiveRestore, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let vault = archive_vault(db, vault_path)?;
    let generation = db.generation()?;
    let (source, target) = crate::archive::restore_places(&vault, archive_id)?;
    let writes = vec![(target.clone(), watcher::path_fingerprint_for_move(&source))];
    let mut restored_paths = vec![target];
    let prepared = watcher_state.self_writes.prepare_write(writes);
    let result = match crate::archive::restore(&vault, archive_id) {
        Ok(result) => {
            watcher_state.self_writes.confirm_prepared_write(&prepared);
            result
        }
        Err(error) => {
            watcher_state.self_writes.cancel_prepared_write(&prepared);
            return Err(error);
        }
    };
    let outcome = sync_mutation_result(db, &vault, result);
    restored_paths.extend(mutation_paths(&outcome.mutation));
    restored_paths.sort();
    restored_paths.dedup();
    Ok(ArchiveRestore {
        outcome,
        vault,
        generation,
        restored_paths,
    })
}

/// Developer command (К9, К11 (е)): puts the entries moved by the migration of the old trash back
/// into `.amby/trash/` by the journal. Not wired to any button; called by hand from the console of
/// the developer tools: `invoke("rollback_archive_migration")`.
#[tauri::command]
#[specta::specta]
pub fn rollback_archive_migration(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
) -> Result<Vec<String>, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let report = crate::archive_migration::rollback(&scope.get()?)?;
    Ok(report.skipped)
}

/// «Удалить из архива» (К6) by the setting of К4: the system trash, or for good.
#[tauri::command]
#[specta::specta]
pub fn purge_archive(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    archive_id: String,
    mode: recycle_bin::DeleteMode,
) -> Result<(), String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    crate::archive::purge(
        &scope.get()?,
        &archive_id,
        mode,
        &crate::system_recycle_bin::OsTrash,
    )
}

#[tauri::command]
#[specta::specta]
pub fn preview_rename_refactor(
    db: tauri::State<'_, VaultContext>,
    path: String,
    new_name: String,
) -> Result<vault_index::RefactorPreview, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let path = paths::guard(&db, &path)?;
    let root = db.root()?;
    super::mutations::require_supernotes_item_root(&root, &path)?;
    let operation_path = super::mutations::rename_operation_path(&root, &path)?;
    let preview = crate::bundle::preview_rename_item(&root, &operation_path, &new_name)?;
    let (vault, inputs) = {
        let conn_guard = db.conn.lock_or_recover();
        let conn = conn_guard.as_ref().ok_or("No vault open")?;
        let inputs = vault_index::collect_inbound_wiki_rewrite_inputs(
            conn,
            &conn.root,
            &preview.path_changes,
        )?;
        (conn.root.clone(), inputs)
    };
    let plan = vault_index::build_inbound_wiki_rewrites(&vault, &preview.path_changes, inputs)?;
    Ok(vault_index::refactor_preview(&plan))
}

#[tauri::command]
#[specta::specta]
pub fn preview_move_refactor(
    db: tauri::State<'_, VaultContext>,
    source_path: String,
    target_path: String,
) -> Result<vault_index::RefactorPreview, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let source_path = paths::guard(&db, &source_path)?;
    let target_path = paths::guard(&db, &target_path)?;
    let root = db.root()?;
    super::mutations::require_supernotes_move_target(&root, &target_path)?;
    super::mutations::require_supernotes_item_root(&root, &source_path)?;
    let preview = crate::bundle::preview_move_item(&root, &source_path, &target_path)?;
    let (vault, generation, inputs) = {
        let conn_guard = db.conn.lock_or_recover();
        let conn = conn_guard.as_ref().ok_or("No vault open")?;
        let inputs = vault_index::collect_inbound_wiki_rewrite_inputs(
            conn,
            &conn.root,
            &preview.path_changes,
        )?;
        (conn.root.clone(), conn.generation, inputs)
    };
    let plan = vault_index::build_inbound_wiki_rewrites(&vault, &preview.path_changes, inputs)?;
    let summary = vault_index::refactor_preview(&plan);
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    if conn.generation != generation {
        return Err("Vault changed while preparing move preview".to_string());
    }
    conn.pending_move_refactor
        .lock_or_recover()
        .replace(PreparedMoveRefactor {
            source_path,
            target_path,
            path_changes: preview.path_changes,
            plan,
        });
    Ok(summary)
}
