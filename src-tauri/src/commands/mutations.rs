use crate::lock_util::LockExt;
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
    paths.extend(result.also_touched.iter().cloned());
    paths
}

fn inspect_note_layers(path: &Path) -> Result<NoteLayers, String> {
    let mut layers = NoteLayers::default();
    if path.is_dir() {
        let stem = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        layers.note = path.join(format!("{stem}.md")).is_file();
        layers.canvas = path.join(format!("{stem}.canvas")).is_file();
        layers.sketch = path.join(format!("{stem}.excalidraw")).is_file();
        layers.database = path.join(format!("{stem}.json")).is_file()
            || path.join(format!("{stem}.database")).is_file()
            || path.join("ambd.json").is_file()
            || path.join("Metadata.md").is_file();
        return Ok(layers);
    }
    if !path.is_file() {
        return Ok(layers);
    }
    layers.note = path.extension().is_some_and(|ext| ext == "md");
    layers.canvas = path.extension().is_some_and(|ext| ext == "canvas");
    layers.sketch = path.extension().is_some_and(|ext| ext == "excalidraw");
    layers.database = path
        .extension()
        .is_some_and(|ext| ext == "json" || ext == "database")
        || path
            .file_name()
            .is_some_and(|n| n == "ambd.json" || n == "Metadata.md");

    let Some(parent) = path.parent() else {
        return Ok(layers);
    };
    let Some(parent_name) = parent.file_name().map(|s| s.to_string_lossy().to_string()) else {
        return Ok(layers);
    };
    let stem = if path.file_name().is_some_and(|n| n == "ambd.json") {
        parent_name.clone()
    } else {
        file_stem(path)?
    };
    if parent_name != stem {
        return Ok(layers);
    }
    layers.note = parent.join(format!("{stem}.md")).is_file();
    layers.canvas = parent.join(format!("{stem}.canvas")).is_file();
    layers.sketch = parent.join(format!("{stem}.excalidraw")).is_file();
    // Database layer: <stem>.json, <stem>.database, ambd.json, or legacy Metadata.md.
    layers.database = parent.join(format!("{stem}.json")).is_file()
        || parent.join(format!("{stem}.database")).is_file()
        || parent.join("ambd.json").is_file()
        || parent.join("Metadata.md").is_file();
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
            let conn_guard = context.conn.lock_or_recover();
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
        let conn_guard = context.conn.lock_or_recover();
        let conn = conn_guard.as_ref().ok_or("No vault open")?;
        // A renamed note whose key was made from its path (a broken header, a duplicate id)
        // gets a new key: the row under the old one must go, without being reported as a delete.
        let mut removed = prepared.deleted_ids.clone();
        removed.extend(vault_index::stale_path_identities(
            vault_path,
            &identities,
            &result.path_changes,
            &prepared.notes,
        ));
        vault_index::apply_prepared_index_updates(conn, &prepared.notes, &removed)?;
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
        Ok(()) => {
            let action = action_of(&result);
            result.tree_patch =
                tree_patch_for(context, vault_path, action, &mutation_paths(&result), &[]);
            MutationOutcome {
                mutation: result,
                index_state: IndexState::Healthy,
                warnings: Vec::new(),
                rewritten_notes: None,
            }
        }
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
                rewritten_notes: None,
            }
        }
    }
}

/// A short name for what a mutation did, for the shadow check's report.
fn action_of(result: &FsMutationResult) -> &'static str {
    if !result.deleted_paths.is_empty() {
        "delete"
    } else if result
        .path_changes
        .iter()
        .any(|change| !change.old_path.is_empty() && !change.new_path.is_empty())
    {
        "rename_move_or_layer"
    } else if result
        .path_changes
        .iter()
        .any(|change| change.old_path.is_empty())
    {
        "create"
    } else {
        "mutation"
    }
}

/// The tree patch for `paths` (and `extra`, files rewritten along the way), or `None` when the
/// renderer has to reload the whole tree. A failure here never fails the mutation.
fn tree_patch_for(
    context: &VaultContext,
    vault: &Path,
    action: &str,
    paths: &[PathBuf],
    extra: &[PathBuf],
) -> Option<crate::vault::tree_patch::TreePatch> {
    let conn_guard = context.conn.lock_or_recover();
    let active = conn_guard.as_ref()?;
    let all = paths.iter().chain(extra).cloned().collect::<Vec<_>>();
    match crate::vault::tree_patch::patch_for_paths(&active.connection, vault, &all) {
        Ok(patch) => {
            if let Some(patch) = &patch {
                crate::shadow_check::note_patch(
                    &active.root,
                    active.generation,
                    action,
                    all.len(),
                    patch,
                );
            }
            patch
        }
        Err(error) => {
            tracing::warn!(event = "tree_patch_failed", %error);
            None
        }
    }
}

/// Does any of `paths` lie inside a database folder (one with a manifest), or is it one?
fn touches_database(vault: &Path, paths: &[PathBuf]) -> bool {
    let mut checked = HashSet::new();
    for path in paths {
        for ancestor in path.ancestors() {
            if ancestor == vault || !ancestor.starts_with(vault) {
                break;
            }
            // Already examined, with everything above it.
            if !checked.insert(ancestor.to_path_buf()) {
                break;
            }
            if crate::vault::scan::is_database_dir(ancestor) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
pub(crate) fn touches_database_for_tests(vault: &Path, paths: &[PathBuf]) -> bool {
    touches_database(vault, paths)
}

pub fn sync_path_changes(
    context: &VaultContext,
    vault_path: &Path,
    changes: &[PathChange],
) -> Result<(), String> {
    let identities = {
        let conn_guard = context.conn.lock_or_recover();
        let conn = conn_guard.as_ref().ok_or("No vault open")?;
        vault_index::collect_note_index_identities(conn)?
    };
    let prepared =
        vault_index::prepare_path_changes_with_identities(vault_path, changes, &identities)?;
    let conn_guard = context.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::apply_prepared_index_updates(conn, &prepared, &[])
}

#[cfg(test)]
mod failure_tests {
    use super::*;

    fn scratch_vault(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("amby-{label}-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_renamed_page_keeps_its_explicit_title_in_step_and_nothing_else() {
        let vault = scratch_vault("retitle");
        let note = vault.join("Дмитрий.md");
        fs::write(
            &note,
            "---\namby-id: 01M4QNH4T7BJ3BNBMPAD63TZQ9\namby-title: \"Без названия\"\nx-other: keep\n---\n## Основное\n",
        )
        .unwrap();

        let changed = retitle_renamed_note(&vault, &note, "Дмитрий").unwrap();
        assert_eq!(changed.as_deref(), Some(note.as_path()));
        let after = fs::read_to_string(&note).unwrap();
        assert!(after.contains("amby-title: Дмитрий"), "{after}");
        assert!(after.contains("amby-id: 01M4QNH4T7BJ3BNBMPAD63TZQ9"));
        assert!(after.contains("x-other: keep"));
        assert!(after.ends_with("## Основное\n"));

        // Already in step: nothing is written again.
        assert!(retitle_renamed_note(&vault, &note, "Дмитрий")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_page_without_an_explicit_title_or_with_a_broken_header_is_left_alone() {
        let vault = scratch_vault("retitle-none");
        let plain = vault.join("Plain.md");
        fs::write(
            &plain,
            "---\namby-id: 01M4QNH4T7BJ3BNBMPAD63TZQ9\n---\nbody\n",
        )
        .unwrap();
        assert!(retitle_renamed_note(&vault, &plain, "Other")
            .unwrap()
            .is_none());
        assert_eq!(
            fs::read_to_string(&plain).unwrap(),
            "---\namby-id: 01M4QNH4T7BJ3BNBMPAD63TZQ9\n---\nbody\n"
        );

        let broken = vault.join("Broken.md");
        fs::write(&broken, "---\namby-title: \"Old\"\nno closing fence\n").unwrap();
        assert!(retitle_renamed_note(&vault, &broken, "New")
            .unwrap()
            .is_none());

        let folder = vault.join("Folder");
        fs::create_dir_all(&folder).unwrap();
        assert!(retitle_renamed_note(&vault, &folder, "New")
            .unwrap()
            .is_none());
    }

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
    fn a_note_made_into_a_super_note_is_noted_as_a_move_before_it_moves() {
        // Д70а: the hint goes first, so a pass cannot read the move as a deletion and a new file.
        let root =
            std::env::temp_dir().join(format!("amby-ensure-bundle-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Idea.md"), "text of the idea").unwrap();
        let context = VaultContext::new();
        context
            .activate(root.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .unwrap();
        let root = context.root().unwrap();
        let old = root.join("Idea.md");
        let new = root.join("Idea").join("Idea.md");
        let seen = std::cell::RefCell::new(Vec::new());
        let record = |vault: &Path, changes: &[PathChange]| {
            seen.borrow_mut().push((
                vault.to_path_buf(),
                old.is_file() && !new.exists(),
                changes
                    .iter()
                    .map(|change| (change.old_path.clone(), change.new_path.clone()))
                    .collect::<Vec<_>>(),
            ));
        };
        let outcome =
            ensure_bundle_inner(&context, &WatcherState::new(), &record, path_string(&old))
                .unwrap();
        assert_eq!(outcome.mutation.primary_path, Some(path_string(&new)));
        assert!(new.is_file() && !old.exists());
        let seen = seen.into_inner();
        assert_eq!(seen.len(), 1, "one call with the one change");
        assert_eq!(seen[0].0, root);
        assert!(seen[0].1, "the hint is recorded before the file moves");
        assert_eq!(seen[0].2, vec![(path_string(&old), path_string(&new))]);
        drop(context);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_note_that_is_already_a_super_note_records_no_hint() {
        let root =
            std::env::temp_dir().join(format!("amby-ensure-bundle-{}", ulid::Ulid::generate()));
        fs::create_dir_all(root.join("Idea")).unwrap();
        fs::write(root.join("Idea/Idea.md"), "text").unwrap();
        let context = VaultContext::new();
        context
            .activate(root.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .unwrap();
        let root = context.root().unwrap();
        let calls = std::cell::Cell::new(0);
        let record = |_: &Path, changes: &[PathChange]| {
            if !changes.is_empty() {
                calls.set(calls.get() + 1);
            }
        };
        ensure_bundle_inner(
            &context,
            &WatcherState::new(),
            &record,
            path_string(&root.join("Idea/Idea.md")),
        )
        .unwrap();
        assert_eq!(calls.get(), 0);
        drop(context);
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
        // A deadlock never returns; the limit only has to outlast a slow, loaded CI runner,
        // where activating the vault alone once took longer than five seconds.
        receiver
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("index failure must return without deadlocking on the held vault mutex");
    }
}

#[tauri::command]
#[specta::specta]
pub fn ensure_bundle(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    sync_runtime: tauri::State<'_, crate::sync::runtime::SyncRuntime>,
    path: String,
) -> Result<MutationOutcome, String> {
    let outcome = ensure_bundle_inner(
        &db,
        &watcher_state,
        &|root, changes| sync_runtime.note_renames(root, changes),
        path,
    )?;
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

/// The body of `ensure_bundle` without the Tauri state wrappers (see `rename_item_inner`).
pub(crate) fn ensure_bundle_inner(
    db: &VaultContext,
    watcher_state: &WatcherState,
    note_renames: &dyn Fn(&Path, &[PathChange]),
    path: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let path = paths::guard(db, &path)?;
    // Synchronisation learns that this is a move, before the file moves (Д70а): a pass that starts
    // between the move and a later hint would read it as a deletion and a new file.
    let expected = preview_ensure_bundle_path(&path);
    if !expected.is_empty() {
        if let Ok(root) = db.root() {
            note_renames(&root, &expected);
        }
    }
    let (primary, path_changes) = ensure_bundle_path(&path)?;
    let result = FsMutationResult {
        tree_patch: None,
        also_touched: Vec::new(),
        primary_id: None,
        primary_path: Some(path_string(&primary)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    };
    watcher_state.mark_write(mutation_paths(&result));
    let vault = db.root()?;
    let mut outcome = sync_mutation_result(db, &vault, result);
    outcome.rewritten_notes = Some((db.generation()?, Vec::new()));
    Ok(outcome)
}

/// Publish structural changes to every window after the durable mutation succeeded.
fn notify_structural_mutation(
    app: &tauri::AppHandle,
    db: &VaultContext,
    outcome: &MutationOutcome,
) {
    if let Some((generation, rewritten)) = &outcome.rewritten_notes {
        if let Ok(vault) = db.root() {
            let mut paths = mutation_paths(&outcome.mutation);
            paths.extend(rewritten.iter().cloned());
            paths.sort();
            paths.dedup();
            watcher::notify_published_files(app, &vault, *generation, &paths, None);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn create_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
) -> Result<MutationOutcome, String> {
    let outcome = create_note_inner(&db, &watcher_state, parent_path, name)?;
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

/// The body of `create_note` without the Tauri state wrappers (see `rename_item_inner`).
pub(crate) fn create_note_inner(
    db: &VaultContext,
    watcher_state: &WatcherState,
    parent_path: String,
    name: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let parent_path = paths::guard(db, &parent_path)?;
    let plan = crate::bundle::prepare_create_note_impl(&parent_path, &name)?;
    let prepared = prepare_note_creation(watcher_state, &plan);
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
    let mut outcome = sync_mutation_result(db, &vault, result);
    outcome.rewritten_notes = Some((db.generation()?, Vec::new()));
    tracing::info!(
        event = "create_note",
        parent = %parent_path.display(),
        name = %name,
        primary_path = ?outcome.mutation.primary_path,
    );
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn create_layer(
    app: tauri::AppHandle,
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<LayerResult, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
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
    watcher_state.mark_write(&paths);
    let vault = scope.get()?;
    let mut changes = result.path_changes.clone();
    if crate::vault::scan::is_markdown(Path::new(&result.layer_path)) {
        changes.push(PathChange {
            old_path: String::new(),
            new_path: result.layer_path.clone(),
        });
    }
    sync_path_changes(&db, &vault, &changes)?;
    watcher::notify_published_files(&app, &vault, db.generation()?, &paths, None);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn create_canvas(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let parent_path = paths::guard(&db, &parent_path)?;
    let path = create_canvas_impl(&parent_path, &name)?;
    watcher_state.mark_write([path.as_path()]);
    watcher::notify_published_files(
        &app,
        &db.root()?,
        db.generation()?,
        std::slice::from_ref(&path),
        None,
    );
    Ok(path_string(&path))
}

#[tauri::command]
#[specta::specta]
pub fn attach_canvas_to_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    canvas_path: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let canvas_path = paths::guard(&db, &canvas_path)?;
    let result = attach_canvas_impl(&canvas_path)?;
    watcher_state.mark_write(mutation_paths(&result));
    let vault = db.root()?;
    let mut outcome = sync_mutation_result(&db, &vault, result);
    outcome.rewritten_notes = Some((db.generation()?, Vec::new()));
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn create_sketch(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let parent_path = paths::guard(&db, &parent_path)?;
    let path = create_sketch_impl(&parent_path, &name)?;
    watcher_state.mark_write([path.as_path()]);
    watcher::notify_published_files(
        &app,
        &db.root()?,
        db.generation()?,
        std::slice::from_ref(&path),
        None,
    );
    Ok(path_string(&path))
}

#[tauri::command]
#[specta::specta]
pub fn attach_sketch_to_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    sketch_path: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let sketch_path = paths::guard(&db, &sketch_path)?;
    let result = attach_sketch_impl(&sketch_path)?;
    watcher_state.mark_write(mutation_paths(&result));
    let vault = db.root()?;
    let mut outcome = sync_mutation_result(&db, &vault, result);
    outcome.rewritten_notes = Some((db.generation()?, Vec::new()));
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn unlink_layer(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let note_path = paths::guard(&db, &note_path)?;
    let result = unlink_layer_impl(&note_path, &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let vault = db.root()?;
    let mut outcome = sync_mutation_result(&db, &vault, result);
    outcome.rewritten_notes = Some((db.generation()?, Vec::new()));
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn delete_layer(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let note_path = paths::guard(&db, &note_path)?;
    let vault = db.root()?;
    let result = delete_layer_impl(&vault, &note_path, &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let vault = db.root()?;
    let mut outcome = sync_mutation_result(&db, &vault, result);
    outcome.rewritten_notes = Some((db.generation()?, Vec::new()));
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
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
        assert!(layers.note);

        let canvas_file = bundle.join("Meeting.canvas");
        fs::write(&canvas_file, "{}\n").unwrap();
        let canvas_layers = inspect_note_layers(&canvas_file).unwrap();
        assert!(canvas_layers.canvas);
        assert!(canvas_layers.note);
        assert!(canvas_layers.database);

        let db_dir = root.join("Projects");
        fs::create_dir_all(&db_dir).unwrap();
        fs::write(db_dir.join("Projects.json"), "{}\n").unwrap();
        let db_layers = inspect_note_layers(&db_dir).unwrap();
        assert!(db_layers.database);
        assert!(!db_layers.note);
        assert!(!db_layers.canvas);
        assert!(!db_layers.sketch);

        fs::write(db_dir.join("Projects.md"), "# Projects\n").unwrap();
        let db_layers_with_note = inspect_note_layers(&db_dir).unwrap();
        assert!(db_layers_with_note.database);
        assert!(db_layers_with_note.note);

        fs::remove_dir_all(root).unwrap();
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MovedPathsEvent {
    generation: u64,
    origin_window: String,
    path_changes: Vec<PathChange>,
}

fn notify_moved_paths(app: &tauri::AppHandle, origin_window: &str, outcome: &MutationOutcome) {
    use tauri::Emitter;
    let Some((generation, _)) = &outcome.rewritten_notes else {
        return;
    };
    let path_changes: Vec<_> = outcome
        .mutation
        .path_changes
        .iter()
        .filter(|change| !change.old_path.is_empty() && !change.new_path.is_empty())
        .cloned()
        .collect();
    if path_changes.is_empty() {
        return;
    }
    if let Err(error) = app.emit(
        "amby:paths-moved",
        MovedPathsEvent {
            generation: *generation,
            origin_window: origin_window.to_owned(),
            path_changes,
        },
    ) {
        tracing::warn!(event = "moved_paths_event_failed", %error);
    }
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn move_item(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher_state: tauri::State<'_, WatcherState>,
    sync_runtime: tauri::State<'_, crate::sync::runtime::SyncRuntime>,
    source_path: String,
    target_path: String,
) -> Result<MutationOutcome, String> {
    let outcome = move_item_inner(
        &db,
        &runtime,
        &watcher_state,
        &|root, changes| sync_runtime.note_renames(root, changes),
        source_path,
        target_path,
    )?;
    notify_moved_paths(&app, window.label(), &outcome);
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

/// The body of `move_item` without the Tauri state wrappers (see `rename_item_inner`).
pub(crate) fn move_item_inner(
    db: &VaultContext,
    runtime: &DatabaseRuntimeState,
    watcher_state: &WatcherState,
    note_renames: &dyn Fn(&Path, &[PathChange]),
    source_path: String,
    target_path: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let source_path = paths::guard(db, &source_path)?;
    let target_path = paths::guard(db, &target_path)?;
    let preview = preview_move_item(&source_path, &target_path)?;
    // Synchronisation learns that this is a move, before the change reaches the disk (Д70).
    if let Ok(root) = db.root() {
        note_renames(&root, &preview.path_changes);
    }
    let (vault_root, generation, prepared_plan) = {
        let conn_guard = db.conn.lock_or_recover();
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
        watcher_state,
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
                return Err(format!(
                    "Reference update failed: {error}; filesystem rollback also failed: {rollback_error}"
                ));
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
    let rewritten_paths = rewritten.clone();
    let rewritten_changes = rewritten
        .into_iter()
        .map(|path| PathChange {
            old_path: path_string(&path),
            new_path: path_string(&path),
        })
        .collect::<Vec<_>>();
    let mut outcome = sync_mutation_result(db, &vault_root, result);
    if let Err(error) = sync_path_changes(db, &vault_root, &rewritten_changes) {
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
        outcome.mutation.tree_patch = None;
    } else if !rewritten_changes.is_empty() {
        // The notes whose links were rewritten have new times in the tree.
        let rewritten = rewritten_changes
            .iter()
            .map(|change| PathBuf::from(&change.new_path))
            .collect::<Vec<_>>();
        outcome.mutation.tree_patch = tree_patch_for(
            db,
            &vault_root,
            "rename_or_move",
            &mutation_paths(&outcome.mutation),
            &rewritten,
        );
    }
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    if conn.generation != generation {
        return Err("Vault changed while applying move".to_string());
    }
    refresh_database_projection(runtime, conn, &mut outcome, &rewritten_paths);
    outcome.rewritten_notes = Some((generation, rewritten_paths));
    Ok(outcome)
}

/// A move or a rename changes the title or the place of pages that databases list, and the
/// projection they read is not rebuilt by the filesystem watcher for writes the app made itself.
/// Without this the lists would keep showing the old name until the next full refresh.
///
/// A page outside every database, whether it moves, is renamed or has its links rewritten, is in no
/// projection, so the projection is rebuilt only when `paths` reach into a database or are one.
fn refresh_database_projection(
    runtime: &DatabaseRuntimeState,
    conn: &crate::vault_context::ActiveVault,
    outcome: &mut MutationOutcome,
    rewritten: &[PathBuf],
) {
    if !runtime.state(Some(conn.generation)).enabled {
        return;
    }
    let mut paths = mutation_paths(&outcome.mutation);
    paths.extend(rewritten.iter().cloned());
    if !touches_database(&conn.root, &paths) {
        return;
    }
    match crate::database::projection::rebuild_database_projection(&conn.connection, &conn.root) {
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

#[tauri::command]
#[specta::specta]
pub fn create_file(
    app: tauri::AppHandle,
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
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
    watcher::notify_published_files(
        &app,
        &db.root()?,
        db.generation()?,
        std::slice::from_ref(&path),
        None,
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn create_folder(
    app: tauri::AppHandle,
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let path = paths::guard(&scope, &path)?;
    if path.exists() {
        return Err(format!("Folder already exists: {}", path.display()));
    }
    let prepared = watcher_state.prepare_write([(&path, PathFingerprint::Directory)]);
    match fs::create_dir_all(&path) {
        Ok(()) => {
            watcher_state.confirm_prepared_write(&prepared);
            tracing::info!(event = "create_folder", path = %path.display());
            watcher::notify_published_files(
                &app,
                &db.root()?,
                db.generation()?,
                std::slice::from_ref(&path),
                None,
            );
            Ok(())
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared);
            Err(error.to_string())
        }
    }
}

/// A page renamed from the tree is renamed as a page. A note's explicit display title
/// (`amby-title`) wins over its file name, so when it has one the title follows the new name;
/// otherwise a database would keep listing the old title while the file and the editor show the
/// new one. Nothing else in the file is touched, and a note with no explicit title, a malformed
/// frontmatter or a title that already matches is left as it is.
fn retitle_renamed_note(
    vault: &Path,
    note_path: &Path,
    new_name: &str,
) -> Result<Option<PathBuf>, String> {
    if !crate::vault::scan::is_markdown(note_path) || !note_path.is_file() {
        return Ok(None);
    }
    let original = fs::read_to_string(note_path).map_err(|error| error.to_string())?;
    let parsed = frontmatter::parse_markdown(&original);
    if parsed.frontmatter_status.is_malformed() {
        return Ok(None);
    }
    match parsed.display_title.as_deref() {
        None => return Ok(None),
        Some(title) if title == new_name => return Ok(None),
        Some(_) => {}
    }
    let next = frontmatter::replace_yaml_binding_lossless(
        &original,
        frontmatter::AMBY_TITLE_FIELD,
        &serde_yaml::Value::String(new_name.to_owned()),
    )?;
    if next == original {
        return Ok(None);
    }
    crate::history::snapshot_before_write(vault, note_path, next.as_bytes(), "rename")?;
    frontmatter::atomic_write_bytes(note_path, next.as_bytes())?;
    Ok(Some(note_path.to_path_buf()))
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn rename_item(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher_state: tauri::State<'_, WatcherState>,
    sync_runtime: tauri::State<'_, crate::sync::runtime::SyncRuntime>,
    path: String,
    new_name: String,
) -> Result<MutationOutcome, String> {
    let outcome = rename_item_inner(
        &db,
        &runtime,
        &watcher_state,
        &|root, changes| sync_runtime.note_renames(root, changes),
        path,
        new_name,
    )?;
    notify_moved_paths(&app, window.label(), &outcome);
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

/// The body of `rename_item` without the Tauri state wrappers, so the large-vault
/// benchmark and the equivalence tests run the same code as the command.
pub(crate) fn rename_item_inner(
    db: &VaultContext,
    runtime: &DatabaseRuntimeState,
    watcher_state: &WatcherState,
    note_renames: &dyn Fn(&Path, &[PathChange]),
    path: String,
    new_name: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let path = paths::guard(db, &path)?;
    let preview = preview_rename_item(&path, &new_name)?;
    // Synchronisation learns that this is a rename, before the change reaches the disk (Д70).
    if let Ok(root) = db.root() {
        note_renames(&root, &preview.path_changes);
    }
    let (vault_root, generation, inputs) = {
        let conn_guard = db.conn.lock_or_recover();
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
    let prepared_rename = prepare_path_changes(watcher_state, &preview.path_changes);
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
    let mut rewritten = match vault_index::apply_planned_wiki_rewrites(&vault_root, &plan) {
        Ok(rewritten) => rewritten,
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared_rename);
            if let Err(rollback_error) = rollback_rename_item(&path, &result) {
                return Err(format!(
                    "Reference update failed: {error}; filesystem rollback also failed: {rollback_error}"
                ));
            }
            return Err(format!(
                "Reference update failed; rename was rolled back: {error}"
            ));
        }
    };
    // The rename itself is done. Keeping the page's own title in step is best effort: a failure
    // here leaves the old title, which is what the page showed before.
    if let Some(note_path) = result.primary_path.as_deref().map(PathBuf::from) {
        match retitle_renamed_note(&vault_root, &note_path, &new_name) {
            Ok(Some(changed)) => rewritten.push(changed),
            Ok(None) => {}
            Err(error) => tracing::warn!(event = "rename_retitle_failed", %error),
        }
    }
    watcher_state.mark_write(rewritten.iter());
    let rewritten_paths = rewritten.clone();
    let rewritten_changes = rewritten
        .into_iter()
        .map(|path| PathChange {
            old_path: path_string(&path),
            new_path: path_string(&path),
        })
        .collect::<Vec<_>>();
    let mut outcome = sync_mutation_result(db, &vault_root, result);
    if let Err(error) = sync_path_changes(db, &vault_root, &rewritten_changes) {
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
        outcome.mutation.tree_patch = None;
    } else if !rewritten_changes.is_empty() {
        // The notes whose links were rewritten have new times in the tree.
        let rewritten = rewritten_changes
            .iter()
            .map(|change| PathBuf::from(&change.new_path))
            .collect::<Vec<_>>();
        outcome.mutation.tree_patch = tree_patch_for(
            db,
            &vault_root,
            "rename_or_move",
            &mutation_paths(&outcome.mutation),
            &rewritten,
        );
    }
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    if conn.generation != generation {
        return Err("Vault changed while applying rename".to_string());
    }
    refresh_database_projection(runtime, conn, &mut outcome, &rewritten_paths);
    outcome.rewritten_notes = Some((generation, rewritten_paths));
    tracing::info!(
        event = "rename_item",
        path = %path.display(),
        new_name = %new_name,
    );
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn delete_item(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
    mode: recycle_bin::DeleteMode,
) -> Result<MutationOutcome, String> {
    let outcome = delete_item_inner(&db, &watcher_state, path, mode)?;
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

/// The body of `delete_item` without the Tauri state wrappers (see `rename_item_inner`).
pub(crate) fn delete_item_inner(
    db: &VaultContext,
    watcher_state: &WatcherState,
    path: String,
    mode: recycle_bin::DeleteMode,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    if mode == recycle_bin::DeleteMode::Permanent {
        recycle_bin::reject_symlink_for_permanent_delete(Path::new(&path))?;
    }
    let path = paths::guard(db, &path)?;
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
    let removal = match mode {
        recycle_bin::DeleteMode::System => system_recycle_bin::move_to_system_trash(&vault, &path),
        // К4: the setting «Переносить в архив» does what «В архив» does.
        recycle_bin::DeleteMode::Archive => crate::archive::move_to_archive(&vault, &path),
        recycle_bin::DeleteMode::Permanent => recycle_bin::delete_permanently(&vault, &path),
    };
    let result = match removal {
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
    let mut outcome = sync_mutation_result(db, &vault, result);
    outcome.rewritten_notes = Some((db.generation()?, Vec::new()));
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn archive_item(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<MutationOutcome, String> {
    let outcome = archive_item_inner(&db, &watcher_state, path)?;
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

/// The body of `archive_item` without the Tauri state wrappers (see `delete_item_inner`): «В архив»
/// (docs/sync-plan.md, К1).
pub(crate) fn archive_item_inner(
    db: &VaultContext,
    watcher_state: &WatcherState,
    path: String,
) -> Result<MutationOutcome, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let path = paths::guard(db, &path)?;
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
    let result = match crate::archive::move_to_archive(&vault, &path) {
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
    let mut outcome = sync_mutation_result(db, &vault, result);
    outcome.rewritten_notes = Some((db.generation()?, Vec::new()));
    Ok(outcome)
}
