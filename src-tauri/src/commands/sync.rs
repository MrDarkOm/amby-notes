//! IPC of the sync connect screen (docs/sync-plan.md, stage Э4). Thin: the flows are in
//! [`crate::sync::service`]. Every error is a machine code ([`SyncError`]); no password, key,
//! token or recovery code is logged or returned except the recovery code of a prepared account,
//! once, to be shown to the person.

use tauri::State;

use crate::sync::account_types::AccountOverview;
use crate::sync::password::check_password;
use crate::sync::runtime::SyncRuntime;
use crate::sync::service::{PrepareRequest, RecoverRequest, SignInRequest, SyncService};
use crate::sync::types::{
    DeviceView, Endpoint, PasswordCheck, PreparedAccountView, ServerCheck, SignOutResult,
    SyncError, SyncStatus,
};
use crate::sync::vault_types::{
    ApprovalKind, ConflictChoice, ConflictVersions, SpaceTarget, SpaceView, VaultSyncStatus,
};
use crate::vault_context::VaultContext;

/// After the device signed in or out the sync of the open vault starts or stops with it: the
/// session is made again from what the key store holds now.
fn resume_open_vault(app: &tauri::AppHandle) {
    use tauri::Manager;
    let root = app
        .try_state::<VaultContext>()
        .and_then(|context| context.root().ok());
    if let Some(root) = root {
        crate::sync::activate_for_open_vault(app, root);
    }
}

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
    app: tauri::AppHandle,
    service: State<'_, SyncService>,
    groups: Vec<String>,
) -> Result<SyncStatus, SyncError> {
    let status = service.confirm_recovery_code(&groups).await?;
    resume_open_vault(&app);
    Ok(status)
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
    app: tauri::AppHandle,
    service: State<'_, SyncService>,
    url: String,
    allow_http: bool,
    username: String,
    password: String,
    device_name: String,
) -> Result<SyncStatus, SyncError> {
    let status = service
        .sign_in(SignInRequest {
            endpoint: endpoint(url, allow_http),
            username,
            password,
            device_name,
        })
        .await?;
    resume_open_vault(&app);
    Ok(status)
}

/// Replaces a forgotten password with the recovery code and signs in (Р5, О3).
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn sync_recover(
    app: tauri::AppHandle,
    service: State<'_, SyncService>,
    url: String,
    allow_http: bool,
    username: String,
    recovery_code: String,
    new_password: String,
    device_name: String,
) -> Result<SyncStatus, SyncError> {
    let status = service
        .recover(RecoverRequest {
            endpoint: endpoint(url, allow_http),
            username,
            recovery_code,
            new_password,
            device_name,
        })
        .await?;
    resume_open_vault(&app);
    Ok(status)
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
pub async fn sync_sign_out(
    app: tauri::AppHandle,
    service: State<'_, SyncService>,
) -> Result<SignOutResult, SyncError> {
    let result = service.sign_out().await?;
    resume_open_vault(&app);
    Ok(result)
}

// ----- the sync of the open vault (stage Э4) -----

fn open_vault(context: &VaultContext) -> Result<std::path::PathBuf, SyncError> {
    context.root().map_err(|_| SyncError::new("no_vault_open"))
}

/// The state of the sync of the open vault; no network.
#[tauri::command]
#[specta::specta]
pub fn sync_vault_status(runtime: State<'_, SyncRuntime>) -> VaultSyncStatus {
    runtime.status()
}

/// The spaces of the account, for "connect an existing vault" (Р5).
#[tauri::command]
#[specta::specta]
pub async fn sync_list_spaces(
    runtime: State<'_, SyncRuntime>,
) -> Result<Vec<SpaceView>, SyncError> {
    runtime.list_spaces().await
}

/// The storages of the account with the plan, the limits and the sizes (appendix Е, У5).
/// `known_vaults` are the folders of the vaults the application knows, to name the ones linked to
/// a space.
#[tauri::command]
#[specta::specta]
pub async fn sync_account_overview(
    runtime: State<'_, SyncRuntime>,
    known_vaults: Vec<String>,
) -> Result<AccountOverview, SyncError> {
    let paths: Vec<std::path::PathBuf> = known_vaults.into_iter().map(Into::into).collect();
    runtime.account_overview(&paths).await
}

/// Switches sync on for the open vault after a complete external backup.
/// `test_vault` is a legacy IPC compatibility argument; the current UI sends false.
#[tauri::command]
#[specta::specta]
pub async fn sync_enable_vault(
    runtime: State<'_, SyncRuntime>,
    context: State<'_, VaultContext>,
    target: SpaceTarget,
    test_vault: bool,
) -> Result<VaultSyncStatus, SyncError> {
    let vault = open_vault(&context)?;
    runtime.enable(&vault, target, test_vault).await
}

/// Switches sync off for the open vault; the link with the space stays.
#[tauri::command]
#[specta::specta]
pub fn sync_disable_vault(runtime: State<'_, SyncRuntime>) -> Result<VaultSyncStatus, SyncError> {
    runtime.disable()
}

/// A pass now.
#[tauri::command]
#[specta::specta]
pub fn sync_run_now(runtime: State<'_, SyncRuntime>) -> Result<(), SyncError> {
    runtime.sync_now()
}

/// The answer to a stop of Р8.
#[tauri::command]
#[specta::specta]
pub fn sync_approve(runtime: State<'_, SyncRuntime>, kind: ApprovalKind) -> Result<(), SyncError> {
    runtime.approve(kind)
}

/// Resolves a conflict of the list (Р7).
#[tauri::command]
#[specta::specta]
pub fn sync_resolve_conflict(
    runtime: State<'_, SyncRuntime>,
    id: String,
    choice: ConflictChoice,
) -> Result<(), SyncError> {
    runtime.resolve_conflict(&id, choice)
}

/// The two versions of a conflict as text, for the comparison (stage Э4б).
#[tauri::command]
#[specta::specta]
pub fn sync_read_conflict_versions(
    runtime: State<'_, SyncRuntime>,
    id: String,
) -> Result<ConflictVersions, SyncError> {
    runtime.read_conflict_versions(&id)
}

/// Resolves a conflict with a text put together by the comparison (stage Э4б).
#[tauri::command]
#[specta::specta]
pub fn sync_resolve_conflict_with_text(
    runtime: State<'_, SyncRuntime>,
    id: String,
    text: String,
    stamp: String,
) -> Result<(), SyncError> {
    runtime.resolve_conflict_with_text(&id, &text, &stamp)
}
