//! The sync of the open vault as the application sees it (docs/sync-plan.md, Р5, Р12; stage Э4):
//! switching it on for a vault (a new space or an existing one), the session of the open vault,
//! its status, and the answers of the person. The keys and the token come from the system key
//! store, the address from the connection record; neither is kept in the vault.

use std::path::Path;
use std::sync::Arc;

use amby_sync_core::engine::RenameHint;

use crate::sync::connection::ConnectionStore;
use crate::sync::hints::RenameHints;
use crate::sync::secrets::SecretStore;
use crate::sync::session::{Schedule, SessionHooks};
use crate::sync::types::SyncError;
use crate::sync::vault_types::{
    ApprovalKind, ConflictChoice, SpaceTarget, SpaceView, VaultSyncStatus,
};

/// The state of the sync of the open vault.
pub struct SyncRuntime {
    _private: (),
}

impl SyncRuntime {
    /// A runtime that reads the credentials from `secrets` and `connection`, carries requests on
    /// `handle`, follows `schedule` and reports through `hooks`.
    pub fn new(
        _secrets: Arc<dyn SecretStore>,
        _connection: Arc<dyn ConnectionStore>,
        _handle: tokio::runtime::Handle,
        _schedule: Schedule,
        _hooks: Arc<dyn SessionHooks>,
    ) -> Self {
        todo!("Э4: SyncRuntime::new")
    }

    /// The renames made through Amby, waiting for the next pass (Д70).
    pub fn hints(&self) -> Arc<RenameHints> {
        todo!("Э4: SyncRuntime::hints")
    }

    /// The spaces of the account (needs a signed-in device).
    pub async fn list_spaces(&self) -> Result<Vec<SpaceView>, SyncError> {
        todo!("Э4: SyncRuntime::list_spaces")
    }

    /// Switches sync on for the vault at `vault` and starts it: makes a new space or connects an
    /// existing one, remembers the link in `.amby/sync/state.db`. While the gate of the plan is
    /// closed the vault must be marked as a test vault (`test_vault_required`). A vault already
    /// linked to a space is switched on again with the same space (the target is ignored).
    pub async fn enable(
        &self,
        _vault: &Path,
        _target: SpaceTarget,
        _test_vault: bool,
    ) -> Result<VaultSyncStatus, SyncError> {
        todo!("Э4: SyncRuntime::enable")
    }

    /// A vault was opened: starts sync when it was switched on and the device is signed in; the
    /// status of a vault that is not synchronised otherwise. Never fails because of the
    /// network.
    pub async fn activate_vault(&self, _vault: &Path) -> Result<VaultSyncStatus, SyncError> {
        todo!("Э4: SyncRuntime::activate_vault")
    }

    /// The vault was closed or another one is opened: stops the session.
    pub fn deactivate_vault(&self) {
        todo!("Э4: SyncRuntime::deactivate_vault")
    }

    /// Switches sync off for the open vault; the link with the space stays.
    pub fn disable(&self) -> Result<VaultSyncStatus, SyncError> {
        todo!("Э4: SyncRuntime::disable")
    }

    /// The status of the open vault (no network).
    pub fn status(&self) -> VaultSyncStatus {
        todo!("Э4: SyncRuntime::status")
    }

    /// A pass now.
    pub fn sync_now(&self) -> Result<(), SyncError> {
        todo!("Э4: SyncRuntime::sync_now")
    }

    /// A file changed in the open vault (from the watcher).
    pub fn notify_path(&self, _path: &Path) {
        todo!("Э4: SyncRuntime::notify_path")
    }

    /// An answer to a stop of Р8.
    pub fn approve(&self, _kind: ApprovalKind) -> Result<(), SyncError> {
        todo!("Э4: SyncRuntime::approve")
    }

    /// Resolves a conflict.
    pub fn resolve_conflict(&self, _id: &str, _choice: ConflictChoice) -> Result<(), SyncError> {
        todo!("Э4: SyncRuntime::resolve_conflict")
    }

    /// Passes the hints on to the session (also called before each pass by the session itself).
    pub fn push_hints(&self, _hints: Vec<RenameHint>) {
        todo!("Э4: SyncRuntime::push_hints")
    }
}
