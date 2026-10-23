//! What a session does to the running application (docs/sync-plan.md, Р8, stage Э4): tells the
//! windows when the status changes, and merges the events of the file watcher while a batch of
//! incoming changes is written, so that the editors get each path once afterwards instead of a
//! storm of events in the middle of it. The writes of synchronisation are **not** hidden from the
//! watcher: an open editor must learn about them like about any change made by another program
//! (Р7), so that a note with unsaved changes gets the usual conflict dialog.

use std::path::Path;
use std::sync::Arc;

use tauri::Emitter;

use crate::sync::session::SessionHooks;
use crate::sync::vault_fs::FsHooks;
use crate::sync::vault_types::VaultSyncStatus;
use crate::watcher::EventBatch;

/// The name of the event the windows listen to.
pub const STATUS_EVENT: &str = "sync-status-changed";

/// The event for files deleted on another computer.
pub const REMOTE_DELETED_EVENT: &str = "sync-remote-deleted";

/// The payload of [`REMOTE_DELETED_EVENT`]: the vault the paths are in, so that a window which has
/// moved on to another vault can ignore a late report about the previous one.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeletedPayload {
    /// The folder of the vault, as the session knows it.
    pub vault: String,
    /// The paths of the deleted files, relative to the vault.
    pub paths: Vec<String>,
}

/// Hooks that talk to the windows of the application.
pub struct AppHooks {
    app: tauri::AppHandle,
    batch: Arc<EventBatch>,
}

impl AppHooks {
    /// Hooks for `app`; `batch` is the one the watcher callback pushes its events through.
    pub fn new(app: tauri::AppHandle, batch: Arc<EventBatch>) -> Self {
        Self { app, batch }
    }
}

impl FsHooks for AppHooks {
    fn batch_begin(&self) {
        self.batch.begin();
    }

    fn batch_end(&self) {
        for event in self.batch.end() {
            let _ = self.app.emit("vault-file-changed", event);
        }
    }
}

impl SessionHooks for AppHooks {
    fn status_changed(&self, status: &VaultSyncStatus) {
        let _ = self.app.emit(STATUS_EVENT, status);
    }

    fn remote_deleted(&self, vault: &Path, paths: &[String]) {
        let payload = RemoteDeletedPayload {
            vault: vault.to_string_lossy().into_owned(),
            paths: paths.to_vec(),
        };
        let _ = self.app.emit(REMOTE_DELETED_EVENT, payload);
    }
}
