//! The local file system of the engine (docs/sync-plan.md, Р4, Р8, Р10; port
//! [`amby_sync_core::engine::LocalFs`]) over the vault on disk and the services of the
//! application. Rules this port keeps:
//!
//! - a write is atomic: a temporary file `.<name>.amby-tmp-*` next to the target, published by a
//!   rename; when a file is replaced, a history snapshot with the reason `sync-overwrite` is made
//!   first, **even when the history is switched off** (Р8), and a failed snapshot fails the write;
//! - a file removed on behalf of the server goes to `.amby/trash/` whatever the delete mode (Р8);
//! - a rename never overwrites (Р12, Д17);
//! - the writes of the engine are **not** registered as writes of the application: the watcher
//!   reports them like any change made by another program, so an open editor treats them as an
//!   external edit and a note with unsaved changes gets the usual conflict dialog (Р7).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use amby_sync_core::engine::{
    FsError, Listing, LocalFs, NameRules, RootState, SnapshotReason, StagedWrite, TrashReason,
};

/// What the application does around a batch of incoming changes (Р8): merge the events of the
/// watcher and update the index once.
pub trait FsHooks: Send + Sync {
    /// A batch of incoming changes begins.
    fn batch_begin(&self) {}
    /// It ended (also after an error).
    fn batch_end(&self) {}
}

/// The vault as the engine sees it.
pub struct VaultFs {
    root: PathBuf,
    hooks: Option<Arc<dyn FsHooks>>,
}

impl VaultFs {
    /// The vault at `root`, with no hooks.
    pub fn new(root: PathBuf) -> Self {
        Self { root, hooks: None }
    }

    /// The vault at `root`; `hooks` are told about batches.
    pub fn with_hooks(root: PathBuf, hooks: Arc<dyn FsHooks>) -> Self {
        Self {
            root,
            hooks: Some(hooks),
        }
    }

    /// The folder of the vault.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Is there an unfinished journal of a multi-file operation in `.amby/` (Р8, Д59)? A journal is
/// unfinished when its `status` is `planned` or `inProgress`, or when it cannot be read: a
/// half-done operation must never leave the computer (the folders `recovery/database_relations`,
/// `database_relation_schemas`, `database_batches`, `creative`, `projects` and `migrations`; the
/// drafts of the editors in `recovery/` are not journals; `quarantine/` is ignored).
pub fn pending_journals(_vault: &Path) -> bool {
    todo!("Э4: pending_journals")
}

impl LocalFs for VaultFs {
    fn root_state(&mut self) -> Result<RootState, FsError> {
        todo!("Э4: VaultFs::root_state")
    }

    fn list(&mut self) -> Result<Listing, FsError> {
        todo!("Э4: VaultFs::list")
    }

    fn read(&mut self, _path: &str) -> Result<Vec<u8>, FsError> {
        todo!("Э4: VaultFs::read")
    }

    fn begin_write(&mut self, _path: &str) -> Result<Box<dyn StagedWrite>, FsError> {
        todo!("Э4: VaultFs::begin_write")
    }

    fn create_dir(&mut self, _path: &str) -> Result<(), FsError> {
        todo!("Э4: VaultFs::create_dir")
    }

    fn rename(&mut self, _from: &str, _to: &str) -> Result<(), FsError> {
        todo!("Э4: VaultFs::rename")
    }

    fn move_to_trash(&mut self, _path: &str, _reason: TrashReason) -> Result<(), FsError> {
        todo!("Э4: VaultFs::move_to_trash")
    }

    fn remove_empty_dir(&mut self, _path: &str) -> Result<bool, FsError> {
        todo!("Э4: VaultFs::remove_empty_dir")
    }

    fn recovery_pending(&mut self) -> Result<bool, FsError> {
        todo!("Э4: VaultFs::recovery_pending")
    }

    fn cleanup_staged(&mut self) -> Result<(), FsError> {
        todo!("Э4: VaultFs::cleanup_staged")
    }

    fn name_rules(&self) -> NameRules {
        todo!("Э4: VaultFs::name_rules")
    }

    fn batch_begin(&mut self) {
        todo!("Э4: VaultFs::batch_begin")
    }

    fn batch_end(&mut self) {
        todo!("Э4: VaultFs::batch_end")
    }
}

/// Kept for the signature of [`StagedWrite::publish`]: the only reason a snapshot is made.
pub const SNAPSHOT_REASON: SnapshotReason = SnapshotReason::SyncOverwrite;
