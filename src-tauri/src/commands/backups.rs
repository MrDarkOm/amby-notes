//! Backup paths are derived from the active vault; a restore parent is chosen natively.
use crate::sync::backup::restore::{self, BackupInfo, RestoredBackup};
use crate::sync::types::SyncError;
use crate::vault_context::VaultContext;
use std::path::PathBuf;
use tauri::Manager;

fn scoped(context: &VaultContext, expected_generation: u64) -> Result<PathBuf, SyncError> {
    let active = context
        .conn
        .lock()
        .map_err(|_| SyncError::new("backup_failed"))?;
    let active = active
        .as_ref()
        .ok_or_else(|| SyncError::new("no_vault_open"))?;
    if active.generation != expected_generation {
        return Err(SyncError::new("backup_stale_vault"));
    }
    Ok(active.root.clone())
}
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupCatalog {
    pub vault: String,
    pub generation: u64,
    pub backups: Vec<BackupInfo>,
}

#[tauri::command]
#[specta::specta]
pub async fn list_vault_backups(
    context: tauri::State<'_, VaultContext>,
    expected_vault: String,
) -> Result<BackupCatalog, SyncError> {
    let (vault, generation) = {
        let state = context
            .conn
            .lock()
            .map_err(|_| SyncError::new("backup_failed"))?;
        let active = state
            .as_ref()
            .ok_or_else(|| SyncError::new("no_vault_open"))?;
        if active.root != std::path::Path::new(&expected_vault) {
            return Err(SyncError::new("backup_stale_vault"));
        }
        (active.root.clone(), active.generation)
    };
    let source = expected_vault;
    let backups = tauri::async_runtime::spawn_blocking(move || restore::list(&vault))
        .await
        .map_err(|_| SyncError::new("backup_failed"))??;
    Ok(BackupCatalog {
        vault: source,
        generation,
        backups,
    })
}
#[tauri::command]
#[specta::specta]
pub async fn verify_vault_backup(
    context: tauri::State<'_, VaultContext>,
    expected_generation: u64,
    backup_id: String,
) -> Result<BackupInfo, SyncError> {
    let vault = scoped(&context, expected_generation)?;
    tauri::async_runtime::spawn_blocking(move || restore::verify(&vault, &backup_id))
        .await
        .map_err(|_| SyncError::new("backup_failed"))?
}
#[tauri::command]
#[specta::specta]
pub async fn restore_vault_backup(
    app: tauri::AppHandle,
    expected_generation: u64,
    backup_id: String,
    operation_id: String,
) -> Result<Option<RestoredBackup>, SyncError> {
    use tauri_plugin_dialog::DialogExt;
    let context = app.state::<VaultContext>();
    let vault = scoped(&context, expected_generation)?;
    // Verify before asking where to write. A bad backup must never offer a restore.
    let check_vault = vault.clone();
    let check_id = backup_id.clone();
    tauri::async_runtime::spawn_blocking(move || restore::verify(&check_vault, &check_id))
        .await
        .map_err(|_| SyncError::new("backup_failed"))??;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let Some(parent) = rx.await.map_err(|_| SyncError::new("backup_failed"))? else {
        return Ok(None);
    };
    if scoped(&context, expected_generation)? != vault {
        return Err(SyncError::new("backup_stale_vault"));
    }
    let parent = parent
        .into_path()
        .map_err(|_| SyncError::new("backup_unsafe_destination"))?;
    tauri::async_runtime::spawn_blocking(move || {
        restore::restore(&vault, &backup_id, &parent, &operation_id).map(Some)
    })
    .await
    .map_err(|_| SyncError::new("backup_failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_dialog_generations_cannot_target_a_new_vault() {
        let root =
            std::env::temp_dir().join(format!("amby-backup-scope-{}", ulid::Ulid::generate()));
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        {
            let context = VaultContext::new();
            let one = context
                .activate(
                    first.to_str().unwrap(),
                    |_| Ok(()),
                    |_, generation| generation,
                )
                .unwrap();
            assert_eq!(
                scoped(&context, one).unwrap(),
                first.canonicalize().unwrap()
            );
            let two = context
                .activate(
                    second.to_str().unwrap(),
                    |_| Ok(()),
                    |_, generation| generation,
                )
                .unwrap();
            assert_eq!(
                scoped(&context, one).unwrap_err().code,
                "backup_stale_vault"
            );
            assert_eq!(
                scoped(&context, two).unwrap(),
                second.canonicalize().unwrap()
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
