use std::fs;
use std::path::{Path, PathBuf};

use crate::bundle::*;
use crate::frontmatter;
use crate::model::*;
use crate::paths;
use crate::recycle_bin;
use crate::vault_context::VaultContext;
use crate::vault_index;
use crate::watcher::{self, PathFingerprint, WatcherState};

pub fn mutation_paths(result: &FsMutationResult) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(primary) = &result.primary_path {
        paths.push(PathBuf::from(primary));
    }
    for change in &result.path_changes {
        if !change.old_path.is_empty() {
            paths.push(PathBuf::from(&change.old_path));
        }
        if !change.new_path.is_empty() {
            paths.push(PathBuf::from(&change.new_path));
        }
    }
    for deleted in &result.deleted_paths {
        paths.push(PathBuf::from(deleted));
    }
    paths
}

/// Register a rename/move plan before it publishes filesystem events. Each old
/// path must become missing and each new path must retain the old path's exact
/// fingerprint; no directory-wide marker is ever used.
fn prepare_path_changes(
    watcher_state: &WatcherState,
    changes: &[PathChange],
) -> crate::watcher::PreparedSelfWrite {
    let mut writes = Vec::new();
    for change in changes {
        if change.old_path.is_empty() || change.new_path.is_empty() {
            continue;
        }
        let old_path = PathBuf::from(&change.old_path);
        writes.push((old_path.clone(), PathFingerprint::Missing));
        writes.push((
            PathBuf::from(&change.new_path),
            watcher::path_fingerprint(&old_path),
        ));
    }
    watcher_state.prepare_write(writes)
}

pub fn sync_mutation_result(
    context: &VaultContext,
    conn: &rusqlite::Connection,
    vault_path: &Path,
    mut result: FsMutationResult,
) -> MutationOutcome {
    let index_result = (|| -> Result<(), String> {
        result.deleted_ids = vault_index::index_apply_mutation(
            conn,
            vault_path,
            &result.path_changes,
            &result.deleted_paths,
        )?;
        result.primary_id = result
            .primary_path
            .as_ref()
            .map(|path| vault_index::note_id_for_path(conn, vault_path, Path::new(path)))
            .transpose()?
            .flatten();
        Ok(())
    })();

    match index_result {
        Ok(()) => MutationOutcome {
            mutation: result,
            index_state: IndexState::Healthy,
            warnings: Vec::new(),
        },
        Err(error) => {
            tracing::warn!(event = "index_update_failed", error = %error);
            let _ = context.mark_index_rebuild_required();
            MutationOutcome {
                mutation: result,
                index_state: IndexState::RebuildRequired,
                warnings: vec![OperationWarning::IndexRebuildRequired],
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn ensure_bundle(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<MutationOutcome, String> {
    let path = paths::guard(&db, &path)?;
    let (primary, path_changes) = ensure_bundle_path(&path)?;
    let result = FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&primary)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    };
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
pub fn create_note(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
) -> Result<MutationOutcome, String> {
    let parent_path = paths::guard(&db, &parent_path)?;
    let result = crate::bundle::create_note_impl(&parent_path, &name)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
pub fn create_layer(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<LayerResult, String> {
    let note_path = paths::guard(&scope, &note_path)?;
    let result = create_layer_impl(&note_path, &kind)?;
    let mut paths = vec![PathBuf::from(&result.layer_path)];
    for change in &result.path_changes {
        if !change.old_path.is_empty() {
            paths.push(PathBuf::from(&change.old_path));
        }
        if !change.new_path.is_empty() {
            paths.push(PathBuf::from(&change.new_path));
        }
    }
    watcher_state.mark_write(paths);
    let vault = scope.get()?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::index_apply_path_changes(conn, &vault, &result.path_changes)?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn create_canvas(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let parent_path = paths::guard(&db, &parent_path)?;
    let path = create_canvas_impl(&parent_path, &name)?;
    watcher_state.mark_write([path.as_path()]);
    Ok(path_string(&path))
}

#[tauri::command]
#[specta::specta]
pub fn attach_canvas_to_note(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    canvas_path: String,
) -> Result<MutationOutcome, String> {
    let canvas_path = paths::guard(&db, &canvas_path)?;
    let result = attach_canvas_impl(&canvas_path)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
pub fn unlink_layer(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<MutationOutcome, String> {
    let note_path = paths::guard(&db, &note_path)?;
    let result = unlink_layer_impl(&note_path, &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
pub fn delete_layer(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<MutationOutcome, String> {
    let note_path = paths::guard(&db, &note_path)?;
    let vault = db.root()?;
    let result = delete_layer_impl(&vault, &note_path, &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
pub fn note_layers(
    scope: tauri::State<paths::VaultScope>,
    note_path: String,
) -> Result<NoteLayers, String> {
    let path = paths::guard(&scope, &note_path)?;
    let mut layers = NoteLayers::default();
    if !path.is_file() {
        return Ok(layers);
    }
    let Some(parent) = path.parent() else {
        return Ok(layers);
    };
    let Some(parent_name) = parent.file_name().map(|s| s.to_string_lossy().to_string()) else {
        return Ok(layers);
    };
    let stem = file_stem(&path)?;
    if parent_name != stem {
        return Ok(layers);
    }
    layers.canvas = parent.join(format!("{stem}.canvas")).is_file();
    layers.sketch = parent.join(format!("{stem}.excalidraw")).is_file();
    layers.database = parent.join("Metadata.md").is_file();
    Ok(layers)
}

#[tauri::command]
#[specta::specta]
pub fn move_item(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    source_path: String,
    target_path: String,
) -> Result<MutationOutcome, String> {
    let source_path = paths::guard(&db, &source_path)?;
    let target_path = paths::guard(&db, &target_path)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let preview = preview_move_item(&source_path, &target_path)?;
    let plan = vault_index::plan_inbound_wiki_rewrites(conn, &conn.root, &preview.path_changes)?;
    let prepared_move = prepare_path_changes(&watcher_state, &preview.path_changes);
    let result = match move_item_impl(&source_path, &target_path) {
        Ok(result) => {
            watcher_state.confirm_prepared_write(&prepared_move);
            result
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared_move);
            return Err(error);
        }
    };
    let rewritten = match vault_index::apply_planned_wiki_rewrites(&conn.root, &plan) {
        Ok(rewritten) => rewritten,
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared_move);
            if let Err(rollback_error) = rollback_move_item(&source_path, &target_path, &result) {
                return Err(format!("Reference update failed: {error}; filesystem rollback also failed: {rollback_error}"));
            }
            return Err(format!(
                "Reference update failed; move was rolled back: {error}"
            ));
        }
    };
    // Move paths were registered before their rename. Link-refactor paths are
    // currently produced by the rewrite plan after the move and retain their
    // narrow per-file post-write records.
    watcher_state.mark_write(rewritten.iter());
    let mut outcome = sync_mutation_result(&db, conn, &conn.root, result);
    let rewritten_changes = rewritten
        .into_iter()
        .map(|path| PathChange {
            old_path: path_string(&path),
            new_path: path_string(&path),
        })
        .collect::<Vec<_>>();
    if let Err(error) = vault_index::index_apply_path_changes(conn, &conn.root, &rewritten_changes)
    {
        tracing::warn!(event = "index_update_failed", error = %error);
        let _ = db.mark_index_rebuild_required();
        outcome.index_state = IndexState::RebuildRequired;
        outcome
            .warnings
            .push(OperationWarning::IndexRebuildRequired);
    }
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn create_file(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let path = paths::guard(&scope, &path)?;
    if path.exists() {
        return Err(format!("File already exists: {}", path.display()));
    }
    let prepared = watcher_state.prepare_write([(&path, watcher::fingerprint_for_bytes(b""))]);
    match frontmatter::atomic_write_new(&path, "") {
        Ok(()) => watcher_state.confirm_prepared_write(&prepared),
        Err(frontmatter::AtomicCreateError::AlreadyExists) => {
            watcher_state.cancel_prepared_write(&prepared);
            return Err(format!("File already exists: {}", path.display()));
        }
        Err(frontmatter::AtomicCreateError::Other(error)) => {
            watcher_state.cancel_prepared_write(&prepared);
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn create_folder(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let path = paths::guard(&scope, &path)?;
    if path.exists() {
        return Err(format!("Folder already exists: {}", path.display()));
    }
    let prepared = watcher_state.prepare_write([(&path, PathFingerprint::Directory)]);
    match fs::create_dir_all(&path) {
        Ok(()) => {
            watcher_state.confirm_prepared_write(&prepared);
            Ok(())
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared);
            Err(error.to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn rename_item(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
    new_name: String,
) -> Result<MutationOutcome, String> {
    let path = paths::guard(&db, &path)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let preview = preview_rename_item(&path, &new_name)?;
    let plan = vault_index::plan_inbound_wiki_rewrites(conn, &conn.root, &preview.path_changes)?;
    let prepared_rename = prepare_path_changes(&watcher_state, &preview.path_changes);
    let result = match rename_item_impl(&path, &new_name) {
        Ok(result) => {
            watcher_state.confirm_prepared_write(&prepared_rename);
            result
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared_rename);
            return Err(error);
        }
    };
    let rewritten = match vault_index::apply_planned_wiki_rewrites(&conn.root, &plan) {
        Ok(rewritten) => rewritten,
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared_rename);
            if let Err(rollback_error) = rollback_rename_item(&path, &result) {
                return Err(format!("Reference update failed: {error}; filesystem rollback also failed: {rollback_error}"));
            }
            return Err(format!(
                "Reference update failed; rename was rolled back: {error}"
            ));
        }
    };
    watcher_state.mark_write(rewritten.iter());
    let mut outcome = sync_mutation_result(&db, conn, &conn.root, result);
    let rewritten_changes = rewritten
        .into_iter()
        .map(|path| PathChange {
            old_path: path_string(&path),
            new_path: path_string(&path),
        })
        .collect::<Vec<_>>();
    if let Err(error) = vault_index::index_apply_path_changes(conn, &conn.root, &rewritten_changes)
    {
        tracing::warn!(event = "index_update_failed", error = %error);
        let _ = db.mark_index_rebuild_required();
        outcome.index_state = IndexState::RebuildRequired;
        outcome
            .warnings
            .push(OperationWarning::IndexRebuildRequired);
    }
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn delete_item(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<MutationOutcome, String> {
    let path = paths::guard(&db, &path)?;
    let vault = db.root()?;
    let preview = recycle_bin::preview_move_to_trash(&vault, &path)?;
    let mut writes = vec![(preview.original_path.clone(), PathFingerprint::Missing)];
    writes.extend(
        preview
            .deleted_paths
            .iter()
            .cloned()
            .map(|path| (path, PathFingerprint::Missing)),
    );
    let prepared = watcher_state.prepare_write(writes);
    let result = match recycle_bin::move_to_trash(&vault, &path) {
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
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}
