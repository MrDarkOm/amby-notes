//! The link between the application and encrypted sync (docs/sync-plan.md, Р5, Р12; stage Э4,
//! the connect screen). Notes are not synchronised yet: this module only signs the device in.
//!
//! - [`types`]: what crosses the IPC border (Specta types, `SyncError` with a machine code);
//! - [`password`]: the length and the strength rule of the password (Р5, `zxcvbn`);
//! - [`secrets`]: AK and the device token live only in the system key store
//!   (`com.ambynotes.sync`, like [`crate::credentials`]);
//! - [`connection`]: the server address and the user name in the app data (not a secret);
//! - [`service`]: the flows — check a server, create an account (the recovery code is confirmed
//!   before anything is sent), sign in, recover, devices, sign out.
//!
//! Neither the password nor a key nor a token nor the recovery code is written to the settings,
//! to the vault or to a log (О1, Р5).

pub mod app_hooks;
pub mod clock;
pub mod conflict_store;
pub mod connection;
pub mod gate;
pub mod hints;
pub mod password;
pub mod remote;
pub mod runtime;
pub mod secrets;
pub mod service;
pub mod session;
pub mod space;
pub mod state_db;
pub mod types;
pub mod vault_fs;
pub mod vault_types;

use std::path::{Path, PathBuf};

use tauri::Manager;

/// A change reported by the file watcher: tells the sync of the open vault (if any). An event
/// without paths, one that asks for a full rescan and an error of the watcher all mean "look at
/// the whole vault".
pub fn notify_watch_event(
    app: &tauri::AppHandle,
    vault: &Path,
    event: &notify::Result<notify::Event>,
) {
    let Some(runtime) = app.try_state::<runtime::SyncRuntime>() else {
        return;
    };
    match event {
        Ok(event) if !event.need_rescan() && !event.paths.is_empty() => {
            for path in &event.paths {
                runtime.notify_path(path);
            }
        }
        _ => runtime.notify_path(vault),
    }
}

/// A vault was opened and its watcher runs: starts its sync when it was switched on. The network
/// is not waited for.
pub fn activate_for_open_vault(app: &tauri::AppHandle, vault: PathBuf) {
    let Some(runtime) = app.try_state::<runtime::SyncRuntime>() else {
        return;
    };
    let token = runtime.next_epoch();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(runtime) = app.try_state::<runtime::SyncRuntime>() {
            if let Err(error) = runtime.activate_with(&vault, token).await {
                tracing::warn!(event = "sync_activation_failed", code = %error.code);
            }
        }
    });
}

/// The vault was closed: stops its sync.
pub fn deactivate_for_closed_vault(app: &tauri::AppHandle) {
    if let Some(runtime) = app.try_state::<runtime::SyncRuntime>() {
        runtime.deactivate_vault();
    }
}

#[cfg(test)]
mod base_store_tests;
#[cfg(test)]
mod conflict_store_tests;
#[cfg(test)]
mod connection_tests;
#[cfg(test)]
mod gate_tests;
#[cfg(test)]
mod hints_tests;
#[cfg(test)]
mod password_tests;
#[cfg(test)]
mod ports_scenarios_tests;
#[cfg(test)]
mod remote_tests;
#[cfg(test)]
mod rules_doc_tests;
#[cfg(test)]
mod runtime_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod space_tests;
#[cfg(test)]
mod state_db_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod vault_fs_tests;
