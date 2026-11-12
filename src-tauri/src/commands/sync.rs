//! IPC of the sync connect screen (docs/sync-plan.md, stage Э4). Thin: the flows are in
//! [`crate::sync::service`]. Every error is a machine code ([`SyncError`]); no password, key,
//! token or recovery code is logged or returned except the recovery code of a prepared account,
//! once, to be shown to the person.

use tauri::State;

use crate::sync::account_types::AccountOverview;
use crate::sync::conflict_store::NotePick;
use crate::sync::password::check_password;
use crate::sync::runtime::SyncRuntime;
use crate::sync::service::{PrepareRequest, RecoverRequest, SignInRequest, SyncService};
use crate::sync::types::{
    DeviceView, Endpoint, PasswordCheck, PreparedAccountView, ServerCheck, SignOutResult,
    SyncError, SyncStatus,
};
use crate::sync::vault_types::{
    ApprovalKind, ConflictChoice, ConflictVersions, GroupConflictVersions, SpaceTarget, SpaceView,
    VaultSyncStatus,
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
pub fn sync_status(
    app: tauri::AppHandle,
    service: State<'_, SyncService>,
    interactive: Option<bool>,
) -> Result<SyncStatus, SyncError> {
    if interactive == Some(true) {
        let status = crate::keychain_access::account_action(|| service.status())?;
        if status.connected {
            resume_open_vault(&app);
        }
        Ok(status)
    } else {
        service.status()
    }
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

/// Changes the password of the account; needs the old one (Р5, П18).
#[tauri::command]
#[specta::specta]
pub async fn sync_change_password(
    service: State<'_, SyncService>,
    old_password: String,
    new_password: String,
) -> Result<(), SyncError> {
    service.change_password(&old_password, &new_password).await
}

/// Changes a sealed device label without replacing its token.
#[tauri::command]
#[specta::specta]
pub async fn sync_rename_device(
    service: State<'_, SyncService>,
    device_id: String,
    name: String,
) -> Result<(), SyncError> {
    service.rename_device(&device_id, &name).await
}

/// Changes the login after current-password verification.
#[tauri::command]
#[specta::specta]
pub async fn sync_rename_account(
    service: State<'_, SyncService>,
    username: String,
    current_password: String,
) -> Result<SyncStatus, SyncError> {
    service.rename_account(&username, &current_password).await
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

/// Deletes the server copy of a space of the current account (appendix Л); local files stay.
#[tauri::command]
#[specta::specta]
pub async fn sync_delete_space(
    runtime: State<'_, SyncRuntime>,
    space_id: String,
) -> Result<(), SyncError> {
    runtime.delete_space(&space_id).await
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

/// The conflicting notes of a conflict of a group of note properties (З69).
#[tauri::command]
#[specta::specta]
pub fn sync_read_group_conflict(
    runtime: State<'_, SyncRuntime>,
    id: String,
) -> Result<GroupConflictVersions, SyncError> {
    runtime.read_group_conflict(&id)
}

/// Resolves a conflict of a group of note properties by notes (З69): a pick for every
/// conflicting note; refused with `conflict_changed` when a file changed since it was read.
#[tauri::command]
#[specta::specta]
pub fn sync_resolve_group_conflict(
    runtime: State<'_, SyncRuntime>,
    id: String,
    picks: std::collections::BTreeMap<String, NotePick>,
    stamp: String,
) -> Result<(), SyncError> {
    runtime.resolve_group_conflict(&id, picks, &stamp)
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

// ----- earlier versions and deleted files from the server (appendix И, Э5) -----
//
// Thin: the flows are in [`crate::sync::server_history`]. The server part of a list is never an
// error (И4, И13): without sync or a connection it is `available = false` with a reason.

use crate::lock_util::LockExt;
use crate::paths;
use crate::sync::server_history::{
    self, DeletedOnServer, HistoryLink, NoteServerVersions, RestoreDeletedOutcome,
    RestoreFileStatus, RestoreVersionOutcome, RestoreVersionStatus, ServerAccess,
    ServerVersionText,
};
use crate::watcher::{self, WatcherState};

fn storage_error<T>(_: T) -> SyncError {
    SyncError::new("storage_error")
}

/// Runs `work` on a blocking thread with the access to the server of the open vault, or with
/// `None` when sync of the vault is not running (И4). The state of the engine is read, the names
/// of devices and `history_days` are asked for as far as the server answers.
async fn with_server<T: Send + 'static>(
    runtime: &SyncRuntime,
    need_days: bool,
    work: impl FnOnce(Option<&ServerAccess<'_>>, &server_history::ServerHistoryCache) -> T
        + Send
        + 'static,
) -> Result<T, SyncError> {
    let cache = runtime.history_cache();
    let link: Option<HistoryLink> = runtime.history_link();
    let extras = match &link {
        Some(link) => Some(link.extras(need_days).await),
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Some((link, (device_names, history_days))) = link.zip(extras) else {
            return work(None, &cache);
        };
        let Ok(state) = link.load_state() else {
            return work(None, &cache);
        };
        cache.see_cursor(state.cursor);
        let connect = || link.connect();
        let access = ServerAccess {
            connect: &connect,
            space: amby_sync_core::crypto::keys::SpaceId::from_bytes(link.space_id),
            keys: vec![link.vk.clone()],
            state,
            this_device: link.device_id,
            device_names,
            history_days,
        };
        work(Some(&access), &cache)
    })
    .await
    .map_err(storage_error)
}

/// The server versions of a note for its history panel (И1–И4, И19).
#[tauri::command]
#[specta::specta]
pub async fn sync_note_versions(
    runtime: State<'_, SyncRuntime>,
    scope: State<'_, paths::VaultScope>,
    path: String,
) -> Result<NoteServerVersions, SyncError> {
    let vault = scope.get().map_err(storage_error)?;
    let note = paths::guard(&scope, &path).map_err(storage_error)?;
    with_server(&runtime, false, move |access, _| {
        server_history::note_versions(&vault, &note, access)
    })
    .await
}

/// The text of one server version of a note for the preview (И5, И19).
#[tauri::command]
#[specta::specta]
pub async fn sync_read_server_version(
    runtime: State<'_, SyncRuntime>,
    path: String,
    item_id: String,
    version: u64,
) -> Result<ServerVersionText, SyncError> {
    let _ = path;
    with_server(&runtime, false, move |access, _| {
        server_history::read_server_version(access, &item_id, version)
    })
    .await?
}

/// "Вернуть" for a server version of a note (И6, И19).
#[tauri::command]
#[specta::specta]
pub async fn sync_restore_server_version(
    app: tauri::AppHandle,
    runtime: State<'_, SyncRuntime>,
    scope: State<'_, paths::VaultScope>,
    path: String,
    item_id: String,
    version: u64,
    expected_hash: String,
) -> Result<RestoreVersionOutcome, SyncError> {
    use tauri::Manager;
    let vault = scope.get().map_err(storage_error)?;
    let note = paths::guard(&scope, &path).map_err(storage_error)?;
    let outcome = with_server(&runtime, false, {
        let (app, vault, note, expected) = (
            app.clone(),
            vault.clone(),
            note.clone(),
            expected_hash.clone(),
        );
        move |access, _| {
            let write = |target: &std::path::Path, bytes: &[u8]| -> Result<bool, String> {
                // The gate is held only for the check and the write, not for the download.
                let db = app.state::<VaultContext>();
                let watcher_state = app.state::<WatcherState>();
                let _gate = db.mutation_gate.lock_or_recover();
                let prepared =
                    watcher_state.prepare_write([(target, watcher::fingerprint_for_bytes(bytes))]);
                match server_history::plain_restore_write(&vault, target, bytes, &expected) {
                    Ok(true) => {
                        watcher_state.confirm_prepared_write(&prepared);
                        Ok(true)
                    }
                    other => {
                        watcher_state.cancel_prepared_write(&prepared);
                        other
                    }
                }
            };
            server_history::restore_server_version_with(
                &vault, &note, access, &item_id, version, &expected, &write,
            )
        }
    })
    .await??;
    if outcome.status == RestoreVersionStatus::Restored {
        let db = app.state::<VaultContext>();
        let _gate = db.mutation_gate.lock_or_recover();
        publish_and_index(&app, &db, &vault, std::slice::from_ref(&note)).map_err(storage_error)?;
    }
    Ok(outcome)
}

/// Tells the windows about the written files and re-reads them in the index, the same as after
/// a restore of a snapshot. The caller holds the `mutation_gate`.
fn publish_and_index(
    app: &tauri::AppHandle,
    db: &VaultContext,
    vault: &std::path::Path,
    paths: &[std::path::PathBuf],
) -> Result<(), String> {
    let generation = db.generation()?;
    watcher::notify_published_files(app, vault, generation, paths, None);
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let changed: std::collections::HashSet<std::path::PathBuf> = paths.iter().cloned().collect();
    if crate::vault_index::sync_paths(conn, vault, &changed)?.is_none() {
        crate::vault_index::sync_vault(conn, vault)?;
    }
    Ok(())
}

/// The "on the server" part of the archive (И9–И13, И19).
#[tauri::command]
#[specta::specta]
pub async fn sync_deleted_files(
    runtime: State<'_, SyncRuntime>,
    scope: State<'_, paths::VaultScope>,
) -> Result<DeletedOnServer, SyncError> {
    let vault = scope.get().map_err(storage_error)?;
    with_server(&runtime, true, move |access, cache| {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(0));
        server_history::deleted_files(&vault, access, cache, now_ms)
    })
    .await
}

/// "Вернуть" for deleted files of the server (И15, И17, И19).
#[tauri::command]
#[specta::specta]
pub async fn sync_restore_deleted(
    app: tauri::AppHandle,
    runtime: State<'_, SyncRuntime>,
    scope: State<'_, paths::VaultScope>,
    item_ids: Vec<String>,
) -> Result<RestoreDeletedOutcome, SyncError> {
    use tauri::Manager;
    let vault = scope.get().map_err(storage_error)?;
    let outcome = with_server(&runtime, false, {
        let (app, vault) = (app.clone(), vault.clone());
        move |access, cache| {
            let create = |target: &std::path::Path,
                          bytes: &[u8]|
             -> Result<(), crate::frontmatter::AtomicCreateError> {
                let db = app.state::<VaultContext>();
                let watcher_state = app.state::<WatcherState>();
                let _gate = db.mutation_gate.lock_or_recover();
                let prepared =
                    watcher_state.prepare_write([(target, watcher::fingerprint_for_bytes(bytes))]);
                let result = crate::frontmatter::atomic_write_bytes_new(target, bytes);
                match &result {
                    Ok(()) => watcher_state.confirm_prepared_write(&prepared),
                    Err(_) => watcher_state.cancel_prepared_write(&prepared),
                }
                result
            };
            let outcome = server_history::restore_deleted_with(&vault, access, &item_ids, &create);
            cache.invalidate();
            outcome
        }
    })
    .await??;
    let written: Vec<std::path::PathBuf> = outcome
        .results
        .iter()
        .filter(|result| {
            matches!(
                result.status,
                RestoreFileStatus::Restored | RestoreFileStatus::RestoredRenamed
            )
        })
        .filter_map(|result| result.final_path.as_deref())
        .map(|relative| vault.join(relative))
        .collect();
    if !written.is_empty() {
        let db = app.state::<VaultContext>();
        let _gate = db.mutation_gate.lock_or_recover();
        publish_and_index(&app, &db, &vault, &written).map_err(storage_error)?;
    }
    Ok(outcome)
}
