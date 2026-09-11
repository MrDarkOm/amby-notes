use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::bundle::*;
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::frontmatter;
use crate::model::*;
use crate::paths;
use crate::recycle_bin;
use crate::system_recycle_bin;
use crate::vault_context::VaultContext;
use crate::vault_index;
use crate::watcher::{self, PathFingerprint, WatcherState};

enum PreparedWikiPlan {
    Cached(Vec<vault_index::PlannedWikiRewrite>),
    Inputs(vault_index::InboundWikiRewriteInputs),
}

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

fn inspect_note_layers(path: &Path) -> Result<NoteLayers, String> {
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
    let stem = file_stem(path)?;
    if parent_name != stem {
        return Ok(layers);
    }
    layers.canvas = parent.join(format!("{stem}.canvas")).is_file();
    layers.sketch = parent.join(format!("{stem}.excalidraw")).is_file();
    // Metadata.md is the readable legacy layer; ambd.json is the released DB layer.
    layers.database = parent.join("Metadata.md").is_file() || parent.join("ambd.json").is_file();
    Ok(layers)
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

/// Register every exact result of note creation before the first directory or
/// file becomes visible to the platform watcher. This closes the notify race
/// that otherwise reports Amby's own freshly-created note as an external edit.
fn prepare_note_creation(
    watcher_state: &WatcherState,
    plan: &CreateNotePlan,
) -> crate::watcher::PreparedSelfWrite {
    let mut writes = vec![(
        plan.planned_note().to_path_buf(),
        watcher::fingerprint_for_bytes(plan.initial_source().as_bytes()),
    )];
    if let Some((original_note, bundle_dir, promoted_main)) = plan.promotion_paths() {
        writes.push((promoted_main, watcher::path_fingerprint(original_note)));
        writes.push((original_note.to_path_buf(), PathFingerprint::Missing));
        writes.push((bundle_dir.to_path_buf(), PathFingerprint::Directory));
    }
    watcher_state.prepare_write(writes)
}

/// A directory move produces notify events for the moved root and for the
/// directories that lose, gain, or contain that root. Register those exact
/// directories as part of the move plan so the watcher does not trigger a
/// second full tree refresh while the optimistic tree is already in place.
fn prepare_move_paths(
    watcher_state: &WatcherState,
    source_path: &Path,
    target_path: &Path,
    changes: &[PathChange],
) -> Result<crate::watcher::PreparedSelfWrite, String> {
    let mut writes = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |path: PathBuf, expected: PathFingerprint| {
        if seen.insert(path.clone()) {
            writes.push((path, expected));
        }
    };

    for change in changes {
        if change.old_path.is_empty() || change.new_path.is_empty() {
            continue;
        }
        let old_path = PathBuf::from(&change.old_path);
        add(old_path.clone(), PathFingerprint::Missing);
        add(
            PathBuf::from(&change.new_path),
            watcher::path_fingerprint(&old_path),
        );
    }

    let source_root = resolve_item_root(source_path);
    let target_dir = if target_path.is_file() {
        if is_bundle_main_note(target_path) {
            target_path
                .parent()
                .ok_or_else(|| "Bundle note has no parent".to_string())?
                .to_path_buf()
        } else {
            target_path
                .parent()
                .ok_or_else(|| "Note has no parent".to_string())?
                .join(file_stem(target_path)?)
        }
    } else {
        target_path.to_path_buf()
    };

    if source_root.is_dir() {
        add(source_root.clone(), PathFingerprint::Missing);
        let source_name = source_root
            .file_name()
            .ok_or_else(|| format!("Invalid path: {}", path_string(&source_root)))?;
        add(target_dir.join(source_name), PathFingerprint::Directory);
    }
    if let Some(parent) = source_root.parent() {
        add(parent.to_path_buf(), PathFingerprint::Directory);
    }
    add(target_dir.clone(), PathFingerprint::Directory);
    if let Some(parent) = target_dir.parent() {
        add(parent.to_path_buf(), PathFingerprint::Directory);
    }

    Ok(watcher_state.prepare_write(writes))
}

pub fn sync_mutation_result(
    context: &VaultContext,
    vault_path: &Path,
    mut result: FsMutationResult,
) -> MutationOutcome {
    let index_result = (|| -> Result<(), String> {
        let (identities, deleted_ids) = {
            let conn_guard = context.conn.lock().unwrap();
            let conn = conn_guard.as_ref().ok_or("No vault open")?;
            vault_index::collect_index_mutation_inputs(
                conn,
                vault_path,
                &result.path_changes,
                &result.deleted_paths,
            )?
        };
        let prepared = vault_index::prepare_index_mutation(
            vault_path,
            &result.path_changes,
            &identities,
            deleted_ids,
        )?;
        let conn_guard = context.conn.lock().unwrap();
        let conn = conn_guard.as_ref().ok_or("No vault open")?;
        vault_index::apply_prepared_index_updates(conn, &prepared.notes, &prepared.deleted_ids)?;
        result.deleted_ids = prepared.deleted_ids;
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
            if let Ok(active) = context.conn.lock() {
                if let Some(active) = active.as_ref() {
                    active.index_health.set(IndexState::RebuildRequired);
                }
            }
            MutationOutcome {
                mutation: result,
                index_state: IndexState::RebuildRequired,
                warnings: vec![OperationWarning::IndexRebuildRequired],
            }
        }
    }
}

pub fn sync_path_changes(
    context: &VaultContext,
    vault_path: &Path,
    changes: &[PathChange],
) -> Result<(), String> {
    let identities = {
        let conn_guard = context.conn.lock().unwrap();
        let conn = conn_guard.as_ref().ok_or("No vault open")?;
        vault_index::collect_note_index_identities(conn)?
    };
    let prepared =
        vault_index::prepare_path_changes_with_identities(vault_path, changes, &identities)?;
    let conn_guard = context.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::apply_prepared_index_updates(conn, &prepared, &[])
}

#[cfg(test)]
mod failure_tests {
    use super::*;

    #[test]
    fn child_note_creation_is_registered_before_every_watcher_visible_change() {
        let root = std::env::temp_dir().join(format!(
            "amby-create-note-watcher-{}",
            ulid::Ulid::generate()
        ));
        fs::create_dir_all(&root).unwrap();
        let parent = root.join("Parent.md");
        fs::write(&parent, "parent body").unwrap();

        let watcher_state = WatcherState::new();
        let plan = prepare_create_note_impl(&parent, "Child").unwrap();
        let child = plan.planned_note().to_path_buf();
        let (_, bundle_dir, promoted_main) = plan.promotion_paths().unwrap();
        let bundle_dir = bundle_dir.to_path_buf();
        let prepared = prepare_note_creation(&watcher_state, &plan);

        plan.commit().unwrap();
        watcher_state.confirm_prepared_write(&prepared);

        assert!(watcher::reconcile_self_write(
            &watcher_state.own_writes,
            &child,
            "create",
            0
        ));
        assert!(watcher::reconcile_self_write(
            &watcher_state.own_writes,
            &parent,
            "remove",
            0
        ));
        assert!(watcher::reconcile_self_write(
            &watcher_state.own_writes,
            &promoted_main,
            "create",
            0
        ));
        assert!(watcher::reconcile_self_write(
            &watcher_state.own_writes,
            &bundle_dir,
            "create",
            0
        ));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_index_after_filesystem_success_does_not_relock_vault() {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let root = std::env::temp_dir()
                .join(format!("amby-mutation-failure-{}", ulid::Ulid::generate()));
            fs::create_dir_all(&root).unwrap();
            let context = VaultContext::new();
            context
                .activate(root.to_str().unwrap(), |_| Ok(()), |_, _| ())
                .unwrap();
            let root = context.root().unwrap();
            let result = crate::bundle::create_note_impl(&root, "Survivor").unwrap();
            let path = result.primary_path.clone().unwrap();
            vault_index::fail_next_index_stage(1);
            let outcome = sync_mutation_result(&context, &root, result);
            assert_eq!(outcome.index_state, IndexState::RebuildRequired);
            assert!(Path::new(&path).is_file());
            assert!(!outcome.warnings.is_empty());
            drop(context);
            fs::remove_dir_all(root).unwrap();
            sender.send(()).unwrap();
        });
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("index failure must return without deadlocking on the held vault mutex");
    }
}

#[tauri::command]
#[specta::specta]
pub fn ensure_bundle(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock().unwrap();
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
    let vault = db.root()?;
    Ok(sync_mutation_result(&db, &vault, result))
}

#[tauri::command]
#[specta::specta]
pub fn create_note(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock().unwrap();
    let parent_path = paths::guard(&db, &parent_path)?;
    let plan = crate::bundle::prepare_create_note_impl(&parent_path, &name)?;
    let prepared = prepare_note_creation(&watcher_state, &plan);
    let result = match plan.commit() {
        Ok(result) => {
            watcher_state.confirm_prepared_write(&prepared);
            result
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared);
            return Err(error);
        }
    };
    let vault = db.root()?;
    Ok(sync_mutation_result(&db, &vault, result))
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
    let _mutation_guard = db.mutation_gate.lock().unwrap();
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
    sync_path_changes(&db, &vault, &result.path_changes)?;
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
    let _mutation_guard = db.mutation_gate.lock().unwrap();
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
    let _mutation_guard = db.mutation_gate.lock().unwrap();
    let canvas_path = paths::guard(&db, &canvas_path)?;
    let result = attach_canvas_impl(&canvas_path)?;
    watcher_state.mark_write(mutation_paths(&result));
    let vault = db.root()?;
    Ok(sync_mutation_result(&db, &vault, result))
}

#[tauri::command]
#[specta::specta]
pub fn unlink_layer(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock().unwrap();
    let note_path = paths::guard(&db, &note_path)?;
    let result = unlink_layer_impl(&note_path, &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let vault = db.root()?;
    Ok(sync_mutation_result(&db, &vault, result))
}

#[tauri::command]
#[specta::specta]
pub fn delete_layer(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock().unwrap();
    let note_path = paths::guard(&db, &note_path)?;
    let vault = db.root()?;
    let result = delete_layer_impl(&vault, &note_path, &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let vault = db.root()?;
    Ok(sync_mutation_result(&db, &vault, result))
}

#[tauri::command]
#[specta::specta]
pub fn note_layers(
    scope: tauri::State<paths::VaultScope>,
    note_path: String,
) -> Result<NoteLayers, String> {
    let path = paths::guard(&scope, &note_path)?;
    inspect_note_layers(&path)
}

#[cfg(test)]
mod layer_tests {
    use super::*;

    #[test]
    fn note_layers_detects_the_durable_database_manifest() {
        let root =
            std::env::temp_dir().join(format!("amby-note-layers-{}", ulid::Ulid::generate()));
        let bundle = root.join("Meeting");
        fs::create_dir_all(&bundle).unwrap();
        let note = bundle.join("Meeting.md");
        fs::write(&note, "# Meeting\n").unwrap();
        fs::write(bundle.join("ambd.json"), "{}\n").unwrap();

        let layers = inspect_note_layers(&note).unwrap();
        assert!(layers.database);
        assert!(!layers.canvas);
        assert!(!layers.sketch);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
#[specta::specta]
pub fn move_item(
    db: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher_state: tauri::State<'_, WatcherState>,
    source_path: String,
    target_path: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock().unwrap();
    let source_path = paths::guard(&db, &source_path)?;
    let target_path = paths::guard(&db, &target_path)?;
    let preview = preview_move_item(&source_path, &target_path)?;
    let (vault_root, generation, prepared_plan) = {
        let conn_guard = db.conn.lock().unwrap();
        let conn = conn_guard.as_ref().ok_or("No vault open")?;
        let prepared_plan = conn
            .pending_move_refactor
            .lock()
            .unwrap()
            .take()
            .filter(|cached| {
                cached.source_path == source_path
                    && cached.target_path == target_path
                    && cached.path_changes.len() == preview.path_changes.len()
                    && cached.path_changes.iter().zip(&preview.path_changes).all(
                        |(cached, current)| {
                            cached.old_path == current.old_path
                                && cached.new_path == current.new_path
                        },
                    )
            })
            .map(|cached| PreparedWikiPlan::Cached(cached.plan))
            .map(Ok)
            .unwrap_or_else(|| {
                vault_index::collect_inbound_wiki_rewrite_inputs(
                    conn,
                    &conn.root,
                    &preview.path_changes,
                )
                .map(PreparedWikiPlan::Inputs)
            })?;
        (conn.root.clone(), conn.generation, prepared_plan)
    };
    let plan = match prepared_plan {
        PreparedWikiPlan::Cached(plan) => plan,
        PreparedWikiPlan::Inputs(inputs) => {
            vault_index::build_inbound_wiki_rewrites(&vault_root, &preview.path_changes, inputs)?
        }
    };
    if db.generation()? != generation {
        return Err("Vault changed before move".to_string());
    }
    let prepared_move = prepare_move_paths(
        &watcher_state,
        &source_path,
        &target_path,
        &preview.path_changes,
    )?;
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
    let rewritten = match vault_index::apply_planned_wiki_rewrites(&vault_root, &plan) {
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
    let rewritten_changes = rewritten
        .into_iter()
        .map(|path| PathChange {
            old_path: path_string(&path),
            new_path: path_string(&path),
        })
        .collect::<Vec<_>>();
    let mut outcome = sync_mutation_result(&db, &vault_root, result);
    if let Err(error) = sync_path_changes(&db, &vault_root, &rewritten_changes) {
        tracing::warn!(event = "index_update_failed", error = %error);
        if let Ok(conn_guard) = db.conn.lock() {
            if let Some(active) = conn_guard.as_ref() {
                active.index_health.set(IndexState::RebuildRequired);
            }
        }
        outcome.index_state = IndexState::RebuildRequired;
        outcome
            .warnings
            .push(OperationWarning::IndexRebuildRequired);
    }
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    if conn.generation != generation {
        return Err("Vault changed while applying move".to_string());
    }
    if runtime.state(Some(conn.generation)).enabled {
        match crate::database::projection::rebuild_database_projection(&conn.connection, &conn.root)
        {
            Ok(report) => {
                runtime.set_projection(
                    conn.generation,
                    Some(crate::database::model::ProjectionVersion {
                        epoch: report.epoch,
                        seq: report.seq,
                    }),
                );
            }
            Err(error) => {
                tracing::warn!(event = "database_projection_rebuild_failed", %error);
                outcome
                    .warnings
                    .push(OperationWarning::IndexRebuildRequired);
            }
        }
    }
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn create_file(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let _mutation_guard = db.mutation_gate.lock().unwrap();
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
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let _mutation_guard = db.mutation_gate.lock().unwrap();
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
    let _mutation_guard = db.mutation_gate.lock().unwrap();
    let path = paths::guard(&db, &path)?;
    let preview = preview_rename_item(&path, &new_name)?;
    let (vault_root, generation, inputs) = {
        let conn_guard = db.conn.lock().unwrap();
        let conn = conn_guard.as_ref().ok_or("No vault open")?;
        let inputs = vault_index::collect_inbound_wiki_rewrite_inputs(
            conn,
            &conn.root,
            &preview.path_changes,
        )?;
        (conn.root.clone(), conn.generation, inputs)
    };
    let plan =
        vault_index::build_inbound_wiki_rewrites(&vault_root, &preview.path_changes, inputs)?;
    if db.generation()? != generation {
        return Err("Vault changed before rename".to_string());
    }
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
    let rewritten = match vault_index::apply_planned_wiki_rewrites(&vault_root, &plan) {
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
    let rewritten_changes = rewritten
        .into_iter()
        .map(|path| PathChange {
            old_path: path_string(&path),
            new_path: path_string(&path),
        })
        .collect::<Vec<_>>();
    let mut outcome = sync_mutation_result(&db, &vault_root, result);
    if let Err(error) = sync_path_changes(&db, &vault_root, &rewritten_changes) {
        tracing::warn!(event = "index_update_failed", error = %error);
        if let Ok(conn_guard) = db.conn.lock() {
            if let Some(active) = conn_guard.as_ref() {
                active.index_health.set(IndexState::RebuildRequired);
            }
        }
        outcome.index_state = IndexState::RebuildRequired;
        outcome
            .warnings
            .push(OperationWarning::IndexRebuildRequired);
    }
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    if conn.generation != generation {
        return Err("Vault changed while applying rename".to_string());
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
    let _mutation_guard = db.mutation_gate.lock().unwrap();
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
    let result = match system_recycle_bin::move_to_system_trash(&vault, &path) {
        Ok(result) => {
            watcher_state.confirm_prepared_write(&prepared);
            result
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared);
            return Err(error);
        }
    };
    let vault = db.root()?;
    Ok(sync_mutation_result(&db, &vault, result))
}

#[tauri::command]
#[specta::specta]
pub fn archive_item(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock().unwrap();
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
    let vault = db.root()?;
    Ok(sync_mutation_result(&db, &vault, result))
}
