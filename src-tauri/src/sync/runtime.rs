//! The sync of the open vault as the application sees it (docs/sync-plan.md, Р5, Р12; stage Э4):
//! switching it on for a vault (a new space or an existing one), the session of the open vault,
//! its status, and the answers of the person. The keys and the token come from the system key
//! store, the address from the connection record; neither is kept in the vault.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use amby_sync_client::{DeviceToken, ServerUrl, SyncClient};
use amby_sync_core::crypto::keys::AccountKey;
use amby_sync_core::engine::RenameHint;
use zeroize::Zeroizing;

use crate::sync::connection::ConnectionStore;
use crate::sync::gate;
use crate::sync::hints::RenameHints;
use crate::sync::secrets::{SecretStore, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use crate::sync::session::{Schedule, SessionConfig, SessionHooks, SyncSession};
use crate::sync::space::{self, LinkedSpace};
use crate::sync::state_db::{
    state_path, SqliteStateStore, META_DEVICE_ID, META_ENABLED, META_KEY_EPOCH, META_SERVER_URL,
    META_SPACE_ID, META_SPACE_NAME, META_TEST_VAULT, META_WRAPPED_VK,
};
use crate::sync::types::SyncError;
use crate::sync::vault_types::{
    ApprovalKind, ConflictChoice, ConflictVersions, SpaceTarget, SpaceView, VaultSyncStatus,
};

/// Who this device is on the server.
struct Credentials {
    /// The address of the server as the connection record keeps it.
    server_url: String,
    client: SyncClient,
    token: DeviceToken,
    account_key: AccountKey,
    device_id: String,
}

/// What the state of a vault says about its link.
struct Link {
    /// The server the link was made on; `None` for a link made before the address was kept.
    server_url: Option<String>,
    space_id: [u8; 16],
    space_name: Option<String>,
    test_vault: bool,
    enabled: bool,
    device_id: Option<String>,
    kept_key: Option<(u32, Vec<u8>)>,
}

#[derive(Default)]
struct Inner {
    vault: Option<PathBuf>,
    session: Option<SyncSession>,
    /// The status while no session runs (switched off, not linked, cannot start).
    resting: Option<VaultSyncStatus>,
}

/// The state of the sync of the open vault.
pub struct SyncRuntime {
    secrets: Arc<dyn SecretStore>,
    connection: Arc<dyn ConnectionStore>,
    handle: tokio::runtime::Handle,
    schedule: Schedule,
    hooks: Arc<dyn SessionHooks>,
    hints: Arc<RenameHints>,
    inner: Mutex<Inner>,
    /// Counts the requests to open, close or switch on a vault: an answer that comes after a
    /// newer request is out of date and changes nothing.
    epoch: AtomicU64,
}

fn hex_32(text: &str) -> Option<Zeroizing<[u8; 32]>> {
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    for (index, pair) in text.as_bytes().chunks(2).enumerate() {
        bytes[index] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(bytes)
}

fn hex_16(text: &str) -> Option<[u8; 16]> {
    hex::decode(text).ok()?.try_into().ok()
}

fn state_failure(error: &amby_sync_core::engine::StateError) -> SyncError {
    match error {
        amby_sync_core::engine::StateError::Io(text) if text == "state_newer" => {
            SyncError::new("state_newer")
        }
        _ => SyncError::new("state_error"),
    }
}

impl SyncRuntime {
    /// A runtime that reads the credentials from `secrets` and `connection`, carries requests on
    /// `handle`, follows `schedule` and reports through `hooks`.
    pub fn new(
        secrets: Arc<dyn SecretStore>,
        connection: Arc<dyn ConnectionStore>,
        handle: tokio::runtime::Handle,
        schedule: Schedule,
        hooks: Arc<dyn SessionHooks>,
    ) -> Self {
        Self {
            secrets,
            connection,
            handle,
            schedule,
            hooks,
            hints: Arc::new(RenameHints::new()),
            inner: Mutex::new(Inner::default()),
            epoch: AtomicU64::new(0),
        }
    }

    /// A new request about the open vault begins: whatever was started for an older one must not
    /// install itself any more. The caller passes the token to [`SyncRuntime::activate_with`].
    pub fn next_epoch(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, token: u64) -> bool {
        self.epoch.load(Ordering::SeqCst) == token
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The renames made through Amby, waiting for the next pass (Д70).
    pub fn hints(&self) -> Arc<RenameHints> {
        self.hints.clone()
    }

    fn credentials(&self) -> Result<Credentials, SyncError> {
        let record = self
            .connection
            .load()
            .map_err(|_| SyncError::new("storage_error"))?
            .ok_or_else(|| SyncError::new("not_connected"))?;
        let key = self
            .secrets
            .get(SECRET_ACCOUNT_KEY)
            .map_err(|_| SyncError::new("keychain_unavailable"))?
            .ok_or_else(|| SyncError::new("not_connected"))?;
        let token = self
            .secrets
            .get(SECRET_DEVICE_TOKEN)
            .map_err(|_| SyncError::new("keychain_unavailable"))?
            .ok_or_else(|| SyncError::new("not_connected"))?;
        let key = Zeroizing::new(key);
        let account_key = hex_32(&key)
            .map(|bytes| AccountKey::from_bytes(*bytes))
            .ok_or_else(|| SyncError::new("not_connected"))?;
        let url = ServerUrl::parse(&record.server_url, record.allow_http)?;
        Ok(Credentials {
            server_url: record.server_url.clone(),
            client: SyncClient::new(&url)?,
            token: DeviceToken::new(token),
            account_key,
            device_id: record.device_id,
        })
    }

    /// The spaces of the account (needs a signed-in device).
    pub async fn list_spaces(&self) -> Result<Vec<SpaceView>, SyncError> {
        let credentials = self.credentials()?;
        space::list_spaces(
            &credentials.client,
            &credentials.token,
            &credentials.account_key,
        )
        .await
    }

    /// What the state of `vault` says about its link, if it has a state at all.
    fn read_link(vault: &Path) -> Result<Option<Link>, SyncError> {
        if !state_path(vault).is_file() {
            return Ok(None);
        }
        let store = SqliteStateStore::open(vault).map_err(|e| state_failure(&e))?;
        let get = |key: &str| store.meta(key).map_err(|e| state_failure(&e));
        let Some(space_hex) = get(META_SPACE_ID)? else {
            return Ok(None);
        };
        let Some(space_id) = hex_16(&space_hex) else {
            return Ok(None);
        };
        let kept_key = match (get(META_KEY_EPOCH)?, get(META_WRAPPED_VK)?) {
            (Some(epoch), Some(wrapped)) => {
                epoch.parse::<u32>().ok().zip(hex::decode(wrapped).ok())
            }
            _ => None,
        };
        Ok(Some(Link {
            server_url: get(META_SERVER_URL)?,
            space_id,
            space_name: get(META_SPACE_NAME)?,
            test_vault: get(META_TEST_VAULT)?.as_deref() == Some("1"),
            enabled: get(META_ENABLED)?.as_deref() == Some("1"),
            device_id: get(META_DEVICE_ID)?,
            kept_key,
        }))
    }

    /// A vault whose state belongs to another device was copied here (Р10): the mark of a test
    /// vault and the switch stay behind with the rest of the link, so it is switched on only by
    /// marking it again. Returns the link as this device sees it.
    fn forget_foreign_marks(
        vault: &Path,
        mut link: Link,
        credentials: &Credentials,
    ) -> Result<Link, SyncError> {
        let foreign = link
            .device_id
            .as_ref()
            .is_some_and(|device| *device != credentials.device_id);
        if foreign {
            let mut store = SqliteStateStore::open(vault).map_err(|e| state_failure(&e))?;
            store
                .remove_meta(META_TEST_VAULT)
                .and_then(|()| store.set_meta(META_ENABLED, "0"))
                .map_err(|e| state_failure(&e))?;
            link.test_vault = false;
            link.enabled = false;
        }
        Ok(link)
    }

    fn remember_link(
        vault: &Path,
        server_url: &str,
        space: &LinkedSpace,
        test_vault: bool,
        enabled: bool,
    ) -> Result<(), SyncError> {
        let mut store = SqliteStateStore::open(vault).map_err(|e| state_failure(&e))?;
        match &space.name {
            Some(name) => store.set_meta(META_SPACE_NAME, name),
            None => store.remove_meta(META_SPACE_NAME),
        }
        .map_err(|e| state_failure(&e))?;
        let mut set =
            |key: &str, value: &str| store.set_meta(key, value).map_err(|e| state_failure(&e));
        set(META_SPACE_ID, &hex::encode(space.space_id))?;
        set(META_SERVER_URL, server_url)?;
        set(META_WRAPPED_VK, &hex::encode(&space.wrapped_vk))?;
        set(META_KEY_EPOCH, &space.key_epoch.to_string())?;
        set(META_TEST_VAULT, if test_vault { "1" } else { "0" })?;
        set(META_ENABLED, if enabled { "1" } else { "0" })
    }

    fn set_enabled(vault: &Path, enabled: bool) -> Result<(), SyncError> {
        let mut store = SqliteStateStore::open(vault).map_err(|e| state_failure(&e))?;
        store
            .set_meta(META_ENABLED, if enabled { "1" } else { "0" })
            .map_err(|e| state_failure(&e))
    }

    /// Does the link belong to this connection? Only a link made on this very server and with
    /// this very account may be resumed: the address is the one kept with the link, and the key
    /// of the space it kept opens with this account's key (an account key of another account
    /// does not open it). A link that cannot be proved to belong here is a stale one: it is never
    /// followed, whatever it points at.
    fn link_matches(link: &Link, credentials: &Credentials) -> bool {
        link.server_url.as_deref() == Some(credentials.server_url.as_str())
            && link.kept_key.as_ref().is_some_and(|(epoch, wrapped)| {
                space::unwrap_kept_key(&credentials.account_key, link.space_id, *epoch, wrapped)
                    .is_ok()
            })
    }

    /// Forgets the link of the vault with a space and everything the engine remembers about it
    /// (the bases of what was synchronised there). The notes themselves are not touched.
    fn forget_link(vault: &Path) -> Result<(), SyncError> {
        let mut store = SqliteStateStore::open(vault).map_err(|e| state_failure(&e))?;
        store.clear_sync_state().map_err(|e| state_failure(&e))?;
        for key in [
            META_SPACE_ID,
            META_SPACE_NAME,
            META_WRAPPED_VK,
            META_KEY_EPOCH,
            META_TEST_VAULT,
            META_SERVER_URL,
        ] {
            store.remove_meta(key).map_err(|e| state_failure(&e))?;
        }
        store
            .set_meta(META_ENABLED, "0")
            .map_err(|e| state_failure(&e))
    }

    /// The status of a vault that is linked but not running; `resumable` when the link belongs
    /// to the connection of this device (see [`SyncRuntime::link_matches`]).
    fn resting_status(&self, link: &Link, error_code: Option<&str>) -> VaultSyncStatus {
        let resumable = self
            .credentials()
            .is_ok_and(|credentials| Self::link_matches(link, &credentials));
        VaultSyncStatus {
            linked: true,
            resumable,
            test_vault: link.test_vault,
            space_id: Some(hex::encode(link.space_id)),
            space_name: link.space_name.clone(),
            error_code: error_code.map(str::to_string),
            ..VaultSyncStatus::off(gate::gate_closed())
        }
    }

    /// Starts the session of `vault`; the previous one (if any) is stopped first.
    fn start_session(
        &self,
        vault: &Path,
        credentials: Credentials,
        space: LinkedSpace,
        test_vault: bool,
        token: u64,
    ) -> Result<VaultSyncStatus, SyncError> {
        self.stop_session();
        if !self.is_current(token) {
            // The person opened another vault in the meantime.
            return Ok(VaultSyncStatus::off(gate::gate_closed()));
        }
        let session = SyncSession::start(SessionConfig {
            vault: vault.to_path_buf(),
            client: credentials.client,
            token: credentials.token,
            account_key: credentials.account_key,
            space_id: space.space_id,
            space_name: space.name.clone(),
            vk: space.vk,
            device_id: credentials.device_id,
            test_vault,
            schedule: self.schedule,
            hooks: self.hooks.clone(),
            handle: self.handle.clone(),
        })?;
        let status = session.status();
        let mut inner = self.inner();
        if !self.is_current(token) {
            drop(inner);
            session.stop();
            return Ok(VaultSyncStatus::off(gate::gate_closed()));
        }
        inner.vault = Some(vault.to_path_buf());
        inner.resting = None;
        inner.session = Some(session);
        drop(inner);
        self.hooks.status_changed(&status);
        Ok(status)
    }

    fn stop_session(&self) {
        let session = self.inner().session.take();
        if let Some(session) = session {
            session.stop();
        }
    }

    fn rest(&self, vault: &Path, status: VaultSyncStatus) -> VaultSyncStatus {
        let mut inner = self.inner();
        inner.vault = Some(vault.to_path_buf());
        inner.resting = Some(status.clone());
        drop(inner);
        self.hooks.status_changed(&status);
        status
    }

    /// [`SyncRuntime::rest`] unless a newer request came in the meantime.
    fn rest_current(&self, vault: &Path, status: VaultSyncStatus, token: u64) -> VaultSyncStatus {
        if self.is_current(token) {
            self.rest(vault, status)
        } else {
            VaultSyncStatus::off(gate::gate_closed())
        }
    }

    /// Switches sync on for the vault at `vault` and starts it: makes a new space or connects an
    /// existing one, remembers the link in `.amby/sync/state.db`. While the gate of the plan is
    /// closed the vault must be marked as a test vault (`test_vault_required`). A vault already
    /// linked to a space is switched on again with the same space (the target is ignored).
    pub async fn enable(
        &self,
        vault: &Path,
        target: SpaceTarget,
        test_vault: bool,
    ) -> Result<VaultSyncStatus, SyncError> {
        let vault = vault
            .canonicalize()
            .map_err(|_| SyncError::new("storage_error"))?;
        let link = Self::read_link(&vault)?;
        let credentials = self.credentials().ok();
        let link = match (link, &credentials) {
            (Some(link), Some(credentials)) => {
                Some(Self::forget_foreign_marks(&vault, link, credentials)?)
            }
            (link, _) => link,
        };
        // Only a link of this server and account is resumed (with its own space, the target is
        // ignored). Any other link is stale: the person chooses a space as the first time.
        let resumable = match (&link, &credentials) {
            (Some(link), Some(credentials)) => Self::link_matches(link, credentials),
            _ => false,
        };
        // The mark of a test vault belongs to the vault and to its link: a resumed link needs no
        // new mark, a stale one does not lend its mark to another space.
        let marked = test_vault || (resumable && link.as_ref().is_some_and(|link| link.test_vault));
        gate::check_gate(marked)?;
        let credentials = self.credentials()?;

        let space = match &link {
            // The server is asked, so a space that is gone is found before anything is sent.
            Some(link) if resumable => {
                match space::open_space(
                    &credentials.client,
                    &credentials.token,
                    &credentials.account_key,
                    link.space_id,
                )
                .await
                {
                    Ok(space) => space,
                    Err(error) if error.code == "space_not_found" => {
                        Self::forget_link(&vault)?;
                        self.rest(&vault, VaultSyncStatus::off(gate::gate_closed()));
                        return Err(error);
                    }
                    Err(error) => return Err(error),
                }
            }
            _ => match target {
                SpaceTarget::New { name } => {
                    let name = if name.trim().is_empty() {
                        space::default_space_name(&vault)
                    } else {
                        name
                    };
                    space::create_space(
                        &credentials.client,
                        &credentials.token,
                        &credentials.account_key,
                        &name,
                    )
                    .await?
                }
                SpaceTarget::Existing { space_id } => {
                    let id = hex_16(&space_id).ok_or_else(|| SyncError::new("invalid_space"))?;
                    space::open_space(
                        &credentials.client,
                        &credentials.token,
                        &credentials.account_key,
                        id,
                    )
                    .await?
                }
            },
        };
        if link.is_some() && !resumable {
            // What the engine remembers belongs to the stale link, not to this space.
            Self::forget_link(&vault)?;
        }
        Self::remember_link(&vault, &credentials.server_url, &space, marked, true)?;
        let token = self.next_epoch();
        self.start_session(&vault, credentials, space, marked, token)
    }

    /// The key of a space this vault was linked to: from the state when it is kept there (no
    /// network), otherwise from the server.
    async fn open_linked(
        &self,
        credentials: &Credentials,
        link: &Link,
    ) -> Result<LinkedSpace, SyncError> {
        if let Some((epoch, wrapped)) = &link.kept_key {
            if let Ok(vk) =
                space::unwrap_kept_key(&credentials.account_key, link.space_id, *epoch, wrapped)
            {
                return Ok(LinkedSpace {
                    space_id: link.space_id,
                    name: link.space_name.clone(),
                    vk,
                    wrapped_vk: wrapped.clone(),
                    key_epoch: *epoch,
                });
            }
        }
        space::open_space(
            &credentials.client,
            &credentials.token,
            &credentials.account_key,
            link.space_id,
        )
        .await
    }

    /// A vault was opened: starts sync when it was switched on and the device is signed in; the
    /// status of a vault that is not synchronised otherwise. Never fails because of the
    /// network.
    pub async fn activate_vault(&self, vault: &Path) -> Result<VaultSyncStatus, SyncError> {
        let token = self.next_epoch();
        self.activate_with(vault, token).await
    }

    /// The same for a request that was announced by [`SyncRuntime::next_epoch`] when it was made.
    pub async fn activate_with(
        &self,
        vault: &Path,
        token: u64,
    ) -> Result<VaultSyncStatus, SyncError> {
        self.stop_session();
        let vault = vault
            .canonicalize()
            .map_err(|_| SyncError::new("storage_error"))?;
        let Some(link) = Self::read_link(&vault)? else {
            return Ok(self.rest_current(&vault, VaultSyncStatus::off(gate::gate_closed()), token));
        };
        // A link made by another device loses its mark and switch first, so a vault that rests
        // shows what switching it on will really ask for.
        let link = match self.credentials() {
            Ok(credentials) => Self::forget_foreign_marks(&vault, link, &credentials)?,
            Err(_) => link,
        };
        if !link.enabled {
            return Ok(self.rest_current(&vault, self.resting_status(&link, None), token));
        }
        let credentials = match self.credentials() {
            Ok(credentials) => credentials,
            Err(error) => {
                return Ok(self.rest_current(
                    &vault,
                    self.resting_status(&link, Some(&error.code)),
                    token,
                ));
            }
        };
        let space = match self.open_linked(&credentials, &link).await {
            Ok(space) => space,
            Err(error) => {
                // The key is not in the state and the server cannot be asked now: the vault
                // waits, the link stays.
                return Ok(self.rest_current(
                    &vault,
                    self.resting_status(&link, Some(&error.code)),
                    token,
                ));
            }
        };
        match self.start_session(&vault, credentials, space, link.test_vault, token) {
            Ok(status) => Ok(status),
            Err(error) => {
                Ok(self.rest_current(&vault, self.resting_status(&link, Some(&error.code)), token))
            }
        }
    }

    /// The vault was closed or another one is opened: stops the session.
    pub fn deactivate_vault(&self) {
        self.next_epoch();
        self.stop_session();
        let mut inner = self.inner();
        inner.vault = None;
        inner.resting = None;
    }

    /// Switches sync off for the open vault; the link with the space stays.
    pub fn disable(&self) -> Result<VaultSyncStatus, SyncError> {
        let vault = self
            .inner()
            .vault
            .clone()
            .ok_or_else(|| SyncError::new("no_vault_open"))?;
        self.stop_session();
        Self::set_enabled(&vault, false)?;
        let link = Self::read_link(&vault)?;
        let status = match link {
            Some(link) => self.resting_status(&link, None),
            None => VaultSyncStatus::off(gate::gate_closed()),
        };
        Ok(self.rest(&vault, status))
    }

    /// The status of the open vault (no network).
    pub fn status(&self) -> VaultSyncStatus {
        let inner = self.inner();
        if let Some(session) = &inner.session {
            return session.status();
        }
        inner
            .resting
            .clone()
            .unwrap_or_else(|| VaultSyncStatus::off(gate::gate_closed()))
    }

    /// Hands the renames waiting in the queue to the session (Д70).
    fn flush_hints(&self, session: &SyncSession) {
        session.add_rename_hints(self.hints.take());
    }

    fn with_session<T>(&self, action: impl FnOnce(&SyncSession) -> T) -> Result<T, SyncError> {
        let inner = self.inner();
        let session = inner
            .session
            .as_ref()
            .ok_or_else(|| SyncError::new("sync_not_running"))?;
        Ok(action(session))
    }

    /// A pass now.
    pub fn sync_now(&self) -> Result<(), SyncError> {
        self.with_session(|session| {
            self.flush_hints(session);
            session.sync_now();
        })
    }

    /// A file changed in the open vault (from the watcher).
    pub fn notify_path(&self, path: &Path) {
        let _ = self.with_session(|session| {
            self.flush_hints(session);
            session.notify_path(path);
        });
    }

    /// An answer to a stop of Р8.
    pub fn approve(&self, kind: ApprovalKind) -> Result<(), SyncError> {
        self.with_session(|session| {
            self.flush_hints(session);
            session.approve(kind);
        })
    }

    /// Resolves a conflict.
    pub fn resolve_conflict(&self, id: &str, choice: ConflictChoice) -> Result<(), SyncError> {
        self.with_session(|session| session.resolve_conflict(id, choice))?
    }

    /// Resolves a conflict with a text put together by the comparison (stage Э4б).
    pub fn resolve_conflict_with_text(
        &self,
        id: &str,
        text: &str,
        stamp: &str,
    ) -> Result<(), SyncError> {
        self.with_session(|session| session.resolve_conflict_with_text(id, text, stamp))?
    }

    /// The two versions of a conflict as text, for the comparison.
    pub fn read_conflict_versions(&self, id: &str) -> Result<ConflictVersions, SyncError> {
        self.with_session(|session| session.read_conflict_versions(id))?
    }

    /// The person renamed or moved something through Amby (Д70): remembered for the next pass.
    /// Nothing is kept when no session runs, so the queue cannot grow unused.
    pub fn note_renames(&self, vault: &Path, changes: &[crate::model::PathChange]) {
        let running = self.inner().session.is_some();
        if running {
            self.hints.record(vault, changes);
        }
    }

    /// Passes the hints on to the session (also done before each answer and each notification).
    pub fn push_hints(&self, hints: Vec<RenameHint>) {
        let _ = self.with_session(|session| session.add_rename_hints(hints));
    }
}
