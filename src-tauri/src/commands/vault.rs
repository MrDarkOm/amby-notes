use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

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
    vault_path: String,
) -> Result<vault_index::LoadVaultResult, String> {
    context.activate(
        &vault_path,
        |root| grant_vault_scopes(&app, root),
        |mut loaded, generation| {
            loaded.generation = generation;
            loaded
        },
    )
}

/// Read the vault that another window has already activated without replacing
/// the process-wide backend context a second time.
#[tauri::command]
#[specta::specta]
pub fn load_active_vault(
    context: tauri::State<'_, vault_context::VaultContext>,
) -> Result<vault_index::LoadVaultResult, String> {
    let active = context.conn.lock().unwrap();
    let active = active.as_ref().ok_or("No vault open")?;
    active.refresh()
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
pub fn apply_id_migration(vault_path: String) -> Result<vault_index::IdMigrationResult, String> {
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
    vault_path: String,
    journal_path: String,
    action: vault_index::IdMigrationRecoveryAction,
) -> Result<vault_index::IdMigrationRecovery, String> {
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
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    conn.refresh().map(|loaded| loaded.tree)
}

#[tauri::command]
#[specta::specta]
pub fn start_vault_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    context: tauri::State<'_, vault_context::VaultContext>,
) -> Result<(), String> {
    use notify::Watcher;
    use tauri::Emitter;

    let (vault, generation, index_changes) = {
        let active = context.conn.lock().unwrap();
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
    let app_handle = app.clone();
    let watched_vault = vault.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if active_generation.load(Ordering::Acquire) != generation {
            return;
        }

        for change in watcher::queue_external_changes(
            res,
            &watched_vault,
            &own_writes,
            generation,
            &index_changes,
        ) {
            let _ = app_handle.emit("vault-file-changed", change);
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&vault, notify::RecursiveMode::Recursive)
        .map_err(|error| {
            state.active_generation.store(0, Ordering::Release);
            error.to_string()
        })?;

    *state.watcher.lock().unwrap() = Some(watcher);
    context.set_watcher_identity(Some(generation))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn stop_vault_watcher(
    state: tauri::State<'_, WatcherState>,
    context: tauri::State<'_, vault_context::VaultContext>,
) -> Result<(), String> {
    *state.watcher.lock().unwrap() = None;
    state.active_generation.store(0, Ordering::Release);
    context.set_watcher_identity(None)?;
    Ok(())
}
