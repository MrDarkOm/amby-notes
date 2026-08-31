use crate::history;
use crate::model::*;
use crate::paths;
use crate::recovery::RecoveryEntry;
use crate::recycle_bin;
use crate::vault_context::VaultContext;
use crate::vault_index;
use crate::watcher::{self, WatcherState};

use super::mutations::sync_mutation_result;

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
) -> Result<history::HistoryCleanupResult, String> {
    history::cleanup_history(&scope.get()?, retention)
}

#[tauri::command]
#[specta::specta]
pub fn preview_history_cleanup(
    scope: tauri::State<paths::VaultScope>,
    retention: history::HistoryRetention,
) -> Result<history::HistoryCleanupPreview, String> {
    history::preview_history_cleanup(&scope.get()?, retention)
}

#[tauri::command]
#[specta::specta]
pub fn restore_snapshot(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    snapshot_id: String,
) -> Result<String, String> {
    let vault = scope.get()?;
    let prepared_restore = history::prepare_snapshot_restore(&vault, &snapshot_id)?;
    let prepared_write = watcher_state.prepare_write([(
        &prepared_restore.path,
        watcher::fingerprint_for_bytes(&prepared_restore.bytes),
    )]);
    let path = match history::commit_snapshot_restore(&vault, prepared_restore) {
        Ok(path) => {
            watcher_state.confirm_prepared_write(&prepared_write);
            path
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared_write);
            return Err(error);
        }
    };
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::sync_vault(conn, &vault)?;
    Ok(crate::bundle::path_string(&path))
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
) -> Result<RecoveryEntry, String> {
    let vault = context.root()?;
    let generation = context.generation()?;
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
) -> Result<Option<RecoveryEntry>, String> {
    let vault = context.root()?;
    crate::recovery::read_recovery(&vault, &id)
}

#[tauri::command]
#[specta::specta]
pub fn delete_recovery(context: tauri::State<'_, VaultContext>, id: String) -> Result<(), String> {
    let vault = context.root()?;
    crate::recovery::delete_recovery(&vault, &id)
}

#[tauri::command]
#[specta::specta]
pub fn list_recovery(
    context: tauri::State<'_, VaultContext>,
) -> Result<Vec<RecoveryEntry>, String> {
    let vault = context.root()?;
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
pub fn restore_trash(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    trash_id: String,
) -> Result<MutationOutcome, String> {
    let vault = scope.get()?;
    let preview = recycle_bin::preview_restore(&vault, &trash_id)?;
    let mut writes = vec![(
        (preview.destination.clone()),
        watcher::path_fingerprint(&preview.payload),
    )];
    writes.extend(preview.restored_paths.iter().filter_map(|source| {
        let relative = source.strip_prefix(&preview.payload).ok()?;
        Some((
            preview.destination.join(relative),
            watcher::path_fingerprint(source),
        ))
    }));
    let prepared = watcher_state.prepare_write(writes);
    let result = match recycle_bin::restore(&vault, &trash_id) {
        Ok(result) => {
            watcher_state.confirm_prepared_write(&prepared);
            result
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared);
            return Err(error);
        }
    };
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(conn, &vault, result))
}

#[tauri::command]
#[specta::specta]
pub fn preview_rename_refactor(
    db: tauri::State<'_, VaultContext>,
    path: String,
    new_name: String,
) -> Result<vault_index::RefactorPreview, String> {
    let path = paths::guard(&db, &path)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let preview = crate::bundle::preview_rename_item(&path, &new_name)?;
    let plan = vault_index::plan_inbound_wiki_rewrites(conn, &conn.root, &preview.path_changes)?;
    Ok(vault_index::refactor_preview(&plan))
}

#[tauri::command]
#[specta::specta]
pub fn preview_move_refactor(
    db: tauri::State<'_, VaultContext>,
    source_path: String,
    target_path: String,
) -> Result<vault_index::RefactorPreview, String> {
    let source_path = paths::guard(&db, &source_path)?;
    let target_path = paths::guard(&db, &target_path)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let preview = crate::bundle::preview_move_item(&source_path, &target_path)?;
    let plan = vault_index::plan_inbound_wiki_rewrites(conn, &conn.root, &preview.path_changes)?;
    Ok(vault_index::refactor_preview(&plan))
}
