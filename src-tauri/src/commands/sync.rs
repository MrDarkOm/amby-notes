//! IPC of the sync connect screen (docs/sync-plan.md, stage Э4). Thin: the flows are in
//! [`crate::sync::service`]. Every error is a machine code ([`SyncError`]); no password, key,
//! token or recovery code is logged or returned except the recovery code of a prepared account,
//! once, to be shown to the person.

use tauri::State;

use crate::sync::password::check_password;
use crate::sync::service::{PrepareRequest, RecoverRequest, SignInRequest, SyncService};
use crate::sync::types::{
    DeviceView, Endpoint, PasswordCheck, PreparedAccountView, ServerCheck, SignOutResult,
    SyncError, SyncStatus,
};

fn endpoint(url: String, allow_http: bool) -> Endpoint {
    Endpoint { url, allow_http }
}

/// Asks a server for `/v1/info` and checks the address (П9, П41).
#[tauri::command]
#[specta::specta]
pub async fn sync_check_server(
    service: State<'_, SyncService>,
    url: String,
    allow_http: bool,
) -> Result<ServerCheck, SyncError> {
    service.check_server(&endpoint(url, allow_http)).await
}

/// The verdict on a password while the person types it (Р5).
#[tauri::command]
#[specta::specta]
pub fn sync_check_password(password: String, username: String) -> PasswordCheck {
    check_password(&password, &[username.as_str()])
}

/// Makes the keys of a new account and returns the recovery code to show (Р5, О3).
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn sync_prepare_account(
    service: State<'_, SyncService>,
    url: String,
    allow_http: bool,
    username: String,
    enroll_code: String,
    password: String,
    device_name: String,
) -> Result<PreparedAccountView, SyncError> {
    service
        .prepare_account(PrepareRequest {
            endpoint: endpoint(url, allow_http),
            username,
            enroll_code,
            password,
            device_name,
        })
        .await
}

/// The person typed back the asked groups of the recovery code: sends the account (О3).
#[tauri::command]
#[specta::specta]
pub async fn sync_confirm_recovery_code(
    service: State<'_, SyncService>,
    groups: Vec<String>,
) -> Result<SyncStatus, SyncError> {
    service.confirm_recovery_code(&groups).await
}

/// Another invitation code for the prepared account (the keys and the recovery code stay).
#[tauri::command]
#[specta::specta]
pub fn sync_set_enroll_code(
    service: State<'_, SyncService>,
    enroll_code: String,
) -> Result<(), SyncError> {
    service.set_enroll_code(&enroll_code)
}

/// Forgets the prepared account.
#[tauri::command]
#[specta::specta]
pub fn sync_cancel_pending(service: State<'_, SyncService>) {
    service.cancel_pending();
}

/// Signs in on this device with the password (Р5).
#[tauri::command]
#[specta::specta]
pub async fn sync_sign_in(
    service: State<'_, SyncService>,
    url: String,
    allow_http: bool,
    username: String,
    password: String,
    device_name: String,
) -> Result<SyncStatus, SyncError> {
    service
        .sign_in(SignInRequest {
            endpoint: endpoint(url, allow_http),
            username,
            password,
            device_name,
        })
        .await
}

/// Replaces a forgotten password with the recovery code and signs in (Р5, О3).
#[tauri::command]
#[specta::specta]
pub async fn sync_recover(
    service: State<'_, SyncService>,
    url: String,
    allow_http: bool,
    username: String,
    recovery_code: String,
    new_password: String,
    device_name: String,
) -> Result<SyncStatus, SyncError> {
    service
        .recover(RecoverRequest {
            endpoint: endpoint(url, allow_http),
            username,
            recovery_code,
            new_password,
            device_name,
        })
        .await
}

/// The state of the connection (no network).
#[tauri::command]
#[specta::specta]
pub fn sync_status(service: State<'_, SyncService>) -> Result<SyncStatus, SyncError> {
    service.status()
}

/// The devices of the account (П19).
#[tauri::command]
#[specta::specta]
pub async fn sync_list_devices(
    service: State<'_, SyncService>,
) -> Result<Vec<DeviceView>, SyncError> {
    service.list_devices().await
}

/// Disconnects a device (П19).
#[tauri::command]
#[specta::specta]
pub async fn sync_disconnect_device(
    service: State<'_, SyncService>,
    device_id: String,
) -> Result<(), SyncError> {
    service.disconnect_device(&device_id).await
}

/// Signs this device out (Р5).
#[tauri::command]
#[specta::specta]
pub async fn sync_sign_out(service: State<'_, SyncService>) -> Result<SignOutResult, SyncError> {
    service.sign_out().await
}
