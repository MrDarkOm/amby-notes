use crate::lock_util::LockExt;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Manager;

use crate::vault_context;
use crate::vault_index;
use crate::watcher::{self, WatcherState};

/// Grant the active vault to the asset protocol. Filesystem access stays in
/// backend commands; the renderer never receives a filesystem plugin scope.
pub fn grant_vault_scopes(app: &tauri::AppHandle, vault: &Path) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_directory(vault, true)
        .map_err(|error| error.to_string())?;
    if let Ok(modules_dir) = crate::package_manager::modules_root(app) {
        let _ = app
            .asset_protocol_scope()
            .allow_directory(&modules_dir, true);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn open_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result = rx.await.map_err(|e| e.to_string())?;
    let Some(path) = result else {
        return Ok(None);
    };
    Ok(Some(path.to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn load_vault(
    app: tauri::AppHandle,
    context: tauri::State<'_, vault_context::VaultContext>,
    runtime: tauri::State<'_, crate::database::runtime_state::DatabaseRuntimeState>,
    vault_path: String,
) -> Result<vault_index::LoadVaultResult, String> {
    let loaded = context.activate(
        &vault_path,
        |root| grant_vault_scopes(&app, root),
        |mut loaded, generation| {
            loaded.generation = generation;
            loaded
        },
    )?;
    let active = context.conn.lock_or_recover();
    if let Some(active) = active.as_ref() {
        if let Ok(Some(projection)) =
            crate::database::projection::cached_projection_version(&active.connection, &active.root)
        {
            runtime.set_enabled(loaded.generation, true);
            runtime.set_projection(loaded.generation, Some(projection));
        } else {
            runtime.reset_for_generation(Some(loaded.generation));
        }
    }
    if let Some(history) = app.try_state::<crate::database::history::DatabaseHistoryState>() {
        history.clear(None);
    }
    crate::shadow_check::note_full_tree(
        Path::new(&loaded.vault_path),
        loaded.generation,
        &loaded.tree,
    );
    Ok(loaded)
}

/// Read the vault that another window has already activated without replacing
/// the process-wide backend context a second time.
#[tauri::command]
#[specta::specta]
pub fn load_active_vault(
    context: tauri::State<'_, vault_context::VaultContext>,
    runtime: tauri::State<'_, crate::database::runtime_state::DatabaseRuntimeState>,
) -> Result<vault_index::LoadVaultResult, String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or("No vault open")?;
    let loaded = active.refresh()?;
    if let Ok(Some(projection)) =
        crate::database::projection::cached_projection_version(&active.connection, &active.root)
    {
        runtime.set_enabled(loaded.generation, true);
        runtime.set_projection(loaded.generation, Some(projection));
    } else {
        runtime.reset_for_generation(Some(loaded.generation));
    }
    crate::shadow_check::note_full_tree(&active.root, loaded.generation, &loaded.tree);
    Ok(loaded)
}

/// Bring the index and the sidebar tree up to date for the paths the watcher reported, without
/// reading the rest of the vault. `null` means a point refresh cannot cover them (the vault
/// root, a bulk change, an identity clash): the renderer then runs `load_active_vault`.
#[tauri::command]
#[specta::specta]
pub fn refresh_vault_paths(
    context: tauri::State<'_, vault_context::VaultContext>,
    paths: Vec<String>,
) -> Result<Option<vault_context::PathsRefresh>, String> {
    let mut changed = std::collections::HashSet::new();
    for path in paths {
        let path = std::path::PathBuf::from(path);
        if path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("A path may not leave the vault".to_string());
        }
        changed.insert(path);
    }
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or("No vault open")?;
    let refreshed = active.refresh_paths(changed)?;
    if let Some(refresh) = &refreshed {
        crate::shadow_check::note_patch(
            &active.root,
            active.generation,
            "refresh_paths",
            refresh.sync.path_to_id.len(),
            &refresh.patch,
        );
    }
    Ok(refreshed)
}

#[tauri::command]
#[specta::specta]
pub fn reindex_vault(
    context: tauri::State<'_, vault_context::VaultContext>,
    runtime: tauri::State<'_, crate::database::runtime_state::DatabaseRuntimeState>,
) -> Result<vault_index::LoadVaultResult, String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or("No vault open")?;
    let loaded = active.reindex()?;
    if let Ok(Some(projection)) =
        crate::database::projection::cached_projection_version(&active.connection, &active.root)
    {
        runtime.set_enabled(loaded.generation, true);
        runtime.set_projection(loaded.generation, Some(projection));
    } else {
        runtime.reset_for_generation(Some(loaded.generation));
    }
    crate::shadow_check::note_full_tree(&active.root, loaded.generation, &loaded.tree);
    Ok(loaded)
}

#[tauri::command]
#[specta::specta]
pub fn preflight_vault(vault_path: String) -> Result<vault_index::VaultPreflight, String> {
    let canonical = Path::new(&vault_path)
        .canonicalize()
        .map_err(|e| format!("Vault not accessible: {e}"))?;
    vault_index::preflight_vault(&canonical)
}

#[tauri::command]
#[specta::specta]
pub fn apply_id_migration(
    context: tauri::State<'_, vault_context::VaultContext>,
    vault_path: String,
) -> Result<vault_index::IdMigrationResult, String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let canonical = Path::new(&vault_path)
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("Vault is not a directory: {}", canonical.display()));
    }
    vault_index::apply_id_migration(&canonical)
}

#[tauri::command]
#[specta::specta]
pub fn inspect_id_migrations(
    vault_path: String,
) -> Result<Vec<vault_index::IdMigrationRecovery>, String> {
    let canonical = Path::new(&vault_path)
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    vault_index::unfinished_id_migrations(&canonical)
}

#[tauri::command]
#[specta::specta]
pub fn recover_id_migration(
    context: tauri::State<'_, vault_context::VaultContext>,
    vault_path: String,
    journal_path: String,
    action: vault_index::IdMigrationRecoveryAction,
) -> Result<vault_index::IdMigrationRecovery, String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let canonical = Path::new(&vault_path)
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    vault_index::recover_id_migration(&canonical, &journal_path, action)
}

#[tauri::command]
#[specta::specta]
pub fn list_files(
    db: tauri::State<'_, vault_context::VaultContext>,
) -> Result<Vec<vault_index::TreeItem>, String> {
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    conn.refresh().map(|loaded| {
        crate::shadow_check::note_full_tree(&conn.root, loaded.generation, &loaded.tree);
        loaded.tree
    })
}

#[tauri::command]
#[specta::specta]
pub fn start_vault_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    context: tauri::State<'_, vault_context::VaultContext>,
) -> Result<(), String> {
    use notify::Watcher;
    let (vault, generation, index_changes) = {
        let active = context.conn.lock_or_recover();
        let active = active.as_ref().ok_or("No vault open")?;
        (
            active.root.clone(),
            active.generation,
            Arc::clone(&active.index_changes),
        )
    };
    state.active_generation.store(generation, Ordering::Release);
    let own_writes = Arc::clone(&state.own_writes);
    let active_generation = Arc::clone(&state.active_generation);
    let batch = Arc::clone(&state.batch);
    let app_handle = app.clone();
    let watched_vault = vault.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if active_generation.load(Ordering::Acquire) != generation {
            return;
        }

        // Synchronisation hears about every change in the vault: also the ones Amby made itself
        // (the self-write records below only keep the renderer from reloading its own saves) and
        // the documented files in `.amby/` (docs/sync-plan.md, Р4, Р10).
        crate::sync::notify_watch_event(&app_handle, &watched_vault, &res);
        let changes = watcher::queue_external_changes(
            res,
            &watched_vault,
            &own_writes,
            generation,
            &index_changes,
        );
        // All renderer notifications, including database and project invalidation,
        // are released together after a sync batch is complete.
        for change in batch.push(changes) {
            watcher::emit_external_change(&app_handle, &watched_vault, generation, change);
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&vault, notify::RecursiveMode::Recursive)
        .map_err(|error| {
            state.active_generation.store(0, Ordering::Release);
            error.to_string()
        })?;

    *state.watcher.lock_or_recover() = Some(watcher);
    context.set_watcher_identity(Some(generation))?;
    crate::sync::activate_for_open_vault(&app, vault);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn stop_vault_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    context: tauri::State<'_, vault_context::VaultContext>,
) -> Result<(), String> {
    crate::sync::deactivate_for_closed_vault(&app);
    *state.watcher.lock_or_recover() = None;
    state.active_generation.store(0, Ordering::Release);
    context.set_watcher_identity(None)?;
    Ok(())
}
