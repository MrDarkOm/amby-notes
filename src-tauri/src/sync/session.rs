//! The sync of one open vault: the engine run on its own thread (docs/sync-plan.md, Р8, Р10,
//! Д10, Д19). A session wires the real ports (vault, server, SQLite state, clock, randomness)
//! into the engine and decides **when** a pass runs:
//!
//! - when a file in the vault changed (the watcher calls [`SyncSession::notify_path`]; paths the
//!   rules exclude, Р4, never start a pass) and when the server says a commit arrived (the
//!   notification stream, П34), after a short pause that merges bursts;
//! - when the person asks ("sync now", or an answer to a stop of Р8);
//! - every few minutes as a fallback, and again after a failure with a growing pause (Д19).
//!
//! A pass that stops (Р8) waits for the person; nothing is retried until they answer.

use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use amby_sync_client::{DeviceToken, ServerEvent, SyncClient};
use amby_sync_core::crypto::keys::{AccountKey, SpaceId, SpaceKey};
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::rules::is_excluded_path;
use amby_sync_core::engine::{
    Approvals, CycleOutcome, CycleReport, CycleRequest, Direction, Engine, EngineConfig,
    EngineError, LocalFs, Ports, RemoteError, RenameHint, StateError, StateOp, StateStore,
    StopReason, SyncEngine, UnsyncedReason, UnsyncedRecord,
};
use sha2::{Digest, Sha256};

use crate::sync::clock::SystemClock;
use crate::sync::conflict_store::{
    copy_name_id, ConflictEntry, ConflictError, ConflictSource, ConflictStore, FileConflictStore,
    Resolution,
};
use crate::sync::gate;
use crate::sync::remote::HttpRemote;
use crate::sync::state_db::{state_dir, SqliteStateStore, META_DEVICE_ID, META_SPACE_ID};
use crate::sync::types::SyncError;
use crate::sync::vault_fs::{FsHooks, VaultFs};
use crate::sync::vault_types::{
    ApprovalKind, ConflictChoice, ConflictVersions, ConflictView, PassSummary, PlannedView,
    StopView, SyncPhase, UnsyncedView, VaultSyncStatus,
};

/// When passes run (Д19).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Schedule {
    /// Changes closer together than this make one pass.
    pub debounce: Duration,
    /// A pass runs at least this often, whatever happened.
    pub poll: Duration,
    /// The first pause after a failure; it doubles with every failure in a row.
    pub backoff_base: Duration,
    /// The longest pause after failures.
    pub backoff_cap: Duration,
}

impl Schedule {
    /// What the application uses: 2 s, 5 min, 5 s, 5 min.
    pub fn production() -> Self {
        Self {
            debounce: Duration::from_secs(2),
            poll: Duration::from_secs(300),
            backoff_base: Duration::from_secs(5),
            backoff_cap: Duration::from_secs(300),
        }
    }

    /// Short times for tests: 30 ms, 10 min, 20 ms, 160 ms.
    pub fn fast() -> Self {
        Self {
            debounce: Duration::from_millis(30),
            poll: Duration::from_secs(600),
            backoff_base: Duration::from_millis(20),
            backoff_cap: Duration::from_millis(160),
        }
    }

    /// The pause after `failures` failures in a row: zero for none, `backoff_base` for one, then
    /// doubling up to `backoff_cap`; never overflows.
    pub fn backoff(&self, failures: u32) -> Duration {
        if failures == 0 {
            return Duration::ZERO;
        }
        let doublings = (failures - 1).min(30);
        self.backoff_base
            .checked_mul(1u32 << doublings)
            .map_or(self.backoff_cap, |pause| pause.min(self.backoff_cap))
    }
}

/// Does a change at `path` (absolute) start a pass in the vault at `vault`? Not when it is
/// outside the vault, in a place the rules exclude (Р4: `.git`, `.obsidian`, `.trash`, `.amby/`
/// except the documented files, temporary files, system litter).
pub fn should_trigger(vault: &Path, path: &Path) -> bool {
    let Ok(inside) = path.strip_prefix(vault) else {
        return false;
    };
    let parts: Vec<String> = inside
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        return true;
    }
    !is_excluded_path(&parts.join("/"))
}

/// What the application does around a session.
pub trait SessionHooks: FsHooks {
    /// The status changed (a pass started or ended, a stop, a failure).
    fn status_changed(&self, status: &VaultSyncStatus);

    /// A pass moved these files (paths in the vault `vault`) to the trash because they were deleted
    /// on another computer. The interface warns the person only about a note that is open.
    fn remote_deleted(&self, _vault: &Path, _paths: &[String]) {}

    /// A note that this computer deleted came back because another computer edited it (Р7, Д37).
    /// The interface says so whether or not the note is open.
    fn restored_after_deletion(&self, _paths: &[String]) {}

    /// A pass merged the edits of two computers into these notes (К1, Г17а). The interface shows a
    /// quiet card above the note, which never opens by itself. Called from the report's
    /// `merged_paths`; the call is written with the code of stage Э4б.
    fn merged_after_edits(&self, _paths: &[String]) {}
}

/// Hooks that do nothing.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoHooks;

impl FsHooks for NoHooks {}

impl SessionHooks for NoHooks {
    fn status_changed(&self, _status: &VaultSyncStatus) {}
}

/// Everything a session needs; made by the runtime after the person signed in and chose a space.
pub struct SessionConfig {
    /// The folder of the vault.
    pub vault: PathBuf,
    /// The server.
    pub client: SyncClient,
    /// The token of this device.
    pub token: DeviceToken,
    /// AK (for the names).
    pub account_key: AccountKey,
    /// The space.
    pub space_id: [u8; 16],
    /// Its name, if known.
    pub space_name: Option<String>,
    /// Its key.
    pub vk: SpaceKey,
    /// The identifier of this device on the server (Р10).
    pub device_id: String,
    /// The vault is marked as a test vault.
    pub test_vault: bool,
    /// When passes run.
    pub schedule: Schedule,
    /// Side effects of the application.
    pub hooks: Arc<dyn SessionHooks>,
    /// The runtime that carries the requests.
    pub handle: tokio::runtime::Handle,
}

/// Why the worker should look at the clock again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trigger {
    /// A file changed or the server announced a commit: after the pause.
    Ordinary,
    /// The person asked: at once, whatever holds the worker back.
    Now,
}

struct Control {
    /// When the next pass is due, if one is asked for.
    due: Option<Instant>,
    /// When the fallback pass is due.
    next_poll: Instant,
    /// Ordinary triggers are ignored: a pause after a failure runs, or a stop waits.
    hold: bool,
    /// Passes asked for / ended (for waiting callers).
    requested: u64,
    done: u64,
    approvals: Approvals,
    hints: Vec<RenameHint>,
    shutdown: bool,
}

struct Shared {
    config: SessionConfig,
    control: Mutex<Control>,
    changed: Condvar,
    status: Mutex<VaultSyncStatus>,
    /// Held while a pass runs or a conflict is resolved: the two never overlap.
    work: Mutex<()>,
    shutdown_listener: tokio::sync::Notify,
}

impl Shared {
    fn control(&self) -> MutexGuard<'_, Control> {
        self.control.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn trigger(&self, kind: Trigger) {
        let mut control = self.control();
        let now = Instant::now();
        match kind {
            Trigger::Now => {
                control.due = Some(now);
                control.requested += 1;
            }
            Trigger::Ordinary => {
                if control.hold {
                    return;
                }
                if control.due.is_none() {
                    control.due = Some(now + self.config.schedule.debounce);
                }
            }
        }
        self.changed.notify_all();
    }

    fn snapshot(&self) -> VaultSyncStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Changes the status and tells the application (outside the lock).
    fn update(&self, change: impl FnOnce(&mut VaultSyncStatus)) {
        let copy = {
            let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
            change(&mut status);
            status.clone()
        };
        self.config.hooks.status_changed(&copy);
    }
}

/// A running session.
pub struct SyncSession {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
    listener: Option<tokio::task::JoinHandle<()>>,
    /// The lock of the session: while it is held no other session works on this vault (С14).
    _lock: fs::File,
}

fn state_error(error: &StateError) -> SyncError {
    match error {
        StateError::Locked => SyncError::new("vault_locked"),
        StateError::Io(text) if text == "state_newer" => SyncError::new("state_newer"),
        StateError::Io(_) => SyncError::new("state_error"),
    }
}

impl SyncSession {
    /// Opens the state of the vault, takes the lock of the session (`vault_locked` when another
    /// session or process has it), compares the device identity with the one in the state (a
    /// vault copied from another computer starts from a full reconcile, Р10), and starts the
    /// worker and the listener of notifications. The first pass runs at once.
    pub fn start(config: SessionConfig) -> Result<SyncSession, SyncError> {
        let dir = state_dir(&config.vault);
        fs::create_dir_all(&dir).map_err(|_| SyncError::new("storage_error"))?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("session.lock"))
            .map_err(|_| SyncError::new("storage_error"))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Err(SyncError::new("vault_locked")),
            Err(fs::TryLockError::Error(_)) => return Err(SyncError::new("storage_error")),
        }

        // The identity of this device (Р10): a state of another device or of another space is not
        // ours — a vault copied from another computer reconciles again by content instead of
        // posing as the old one. Nothing is deleted by that (Р8, Д56).
        let mut store = SqliteStateStore::open(&config.vault).map_err(|e| state_error(&e))?;
        let space_hex = hex::encode(config.space_id);
        let known_device = store.meta(META_DEVICE_ID).map_err(|e| state_error(&e))?;
        let known_space = store.meta(META_SPACE_ID).map_err(|e| state_error(&e))?;
        let foreign = known_device.is_some_and(|device| device != config.device_id)
            || known_space.is_some_and(|space| space != space_hex);
        if foreign {
            store.clear_sync_state().map_err(|e| state_error(&e))?;
        }
        store
            .set_meta(META_DEVICE_ID, &config.device_id)
            .map_err(|e| state_error(&e))?;
        store
            .set_meta(META_SPACE_ID, &space_hex)
            .map_err(|e| state_error(&e))?;
        drop(store);

        let now = Instant::now();
        let status = VaultSyncStatus {
            enabled: true,
            linked: true,
            test_vault: config.test_vault,
            gate_closed: gate::gate_closed(),
            backup_path: crate::sync::backup::read_path(&config.vault),
            space_id: Some(space_hex),
            space_name: config.space_name.clone(),
            phase: SyncPhase::Idle,
            ..VaultSyncStatus::off(gate::gate_closed())
        };
        let shared = Arc::new(Shared {
            control: Mutex::new(Control {
                due: Some(now),
                next_poll: now + config.schedule.poll,
                hold: false,
                requested: 0,
                done: 0,
                approvals: Approvals::default(),
                hints: Vec::new(),
                shutdown: false,
            }),
            changed: Condvar::new(),
            status: Mutex::new(status),
            work: Mutex::new(()),
            shutdown_listener: tokio::sync::Notify::new(),
            config,
        });

        let worker = {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("amby-sync".to_string())
                .spawn(move || worker(&shared))
                .map_err(|_| SyncError::new("storage_error"))?
        };
        let listener = {
            let shared = shared.clone();
            shared.config.handle.clone().spawn(listen(shared))
        };
        Ok(SyncSession {
            shared,
            worker: Some(worker),
            listener: Some(listener),
            _lock: lock,
        })
    }

    /// The current status (no network).
    pub fn status(&self) -> VaultSyncStatus {
        self.shared.snapshot()
    }

    /// Asks for a pass now (no pause) and returns at once.
    pub fn sync_now(&self) {
        {
            let mut control = self.shared.control();
            control.hold = false;
        }
        self.shared.trigger(Trigger::Now);
    }

    /// Asks for a pass and waits until a pass that began after this call has ended; the status
    /// then. `Err(timeout)` when it does not end in time. For tests and "sync now".
    pub fn run_pass_blocking(&self, timeout: Duration) -> Result<VaultSyncStatus, SyncError> {
        let deadline = Instant::now() + timeout;
        let wanted = {
            let mut control = self.shared.control();
            control.hold = false;
            control.requested += 1;
            control.due = Some(Instant::now());
            self.shared.changed.notify_all();
            control.requested
        };
        let mut control = self.shared.control();
        while control.done < wanted {
            let now = Instant::now();
            if now >= deadline || control.shutdown {
                return Err(SyncError::new("timeout"));
            }
            let (guard, _) = self
                .shared
                .changed
                .wait_timeout(control, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            control = guard;
        }
        drop(control);
        Ok(self.status())
    }

    /// A file changed at `path` (absolute): starts a pass after the pause when the rules do not
    /// exclude it ([`should_trigger`]).
    pub fn notify_path(&self, path: &Path) {
        if should_trigger(&self.shared.config.vault, path) {
            self.shared.trigger(Trigger::Ordinary);
        }
    }

    /// The person answered a stop (Р8): the next pass goes on despite it, once.
    pub fn approve(&self, kind: ApprovalKind) {
        {
            let mut control = self.shared.control();
            match kind {
                ApprovalKind::MassChange => control.approvals.mass_change = true,
                ApprovalKind::EmptyVault => control.approvals.accept_empty_vault = true,
                ApprovalKind::Resync => control.approvals.resync = true,
            }
            control.hold = false;
        }
        self.shared.trigger(Trigger::Now);
    }

    /// Renames the person made through Amby since the last pass (Д70).
    pub fn add_rename_hints(&self, hints: Vec<RenameHint>) {
        if hints.is_empty() {
            return;
        }
        let mut control = self.shared.control();
        for hint in hints {
            if !control.hints.contains(&hint) {
                control.hints.push(hint);
            }
        }
    }

    /// Resolves a conflict of the list (Р7): the files are changed as `choice` says, the entry
    /// leaves the list, and a pass follows. `conflict_not_found` for an id that is not in the
    /// list.
    pub fn resolve_conflict(&self, id: &str, choice: ConflictChoice) -> Result<(), SyncError> {
        self.resolve_with(id, None, |store, entry, files, vault| match choice {
            ConflictChoice::KeepBoth => keep_both(store, entry, files, vault),
            ConflictChoice::KeepOriginal => store.resolve(&entry.id, Resolution::Current),
            ConflictChoice::KeepCopy => store.resolve(&entry.id, Resolution::Other),
        })
    }

    /// Resolves a conflict with a text put together by the comparison (stage Э4б): the text becomes
    /// the file, byte for byte; the version it replaces stays in the history; the second version
    /// goes to the trash of the vault and the entry leaves the list.
    pub fn resolve_conflict_with_text(
        &self,
        id: &str,
        text: &str,
        stamp: &str,
    ) -> Result<(), SyncError> {
        self.resolve_with(id, Some(stamp), |store, entry, _files, _vault| {
            store.resolve(
                &entry.id,
                Resolution::Assembled {
                    text: text.to_string(),
                },
            )
        })
    }

    /// The two versions of a conflict as text, for the comparison. `conflict_not_found` for an id
    /// that is not in the list.
    pub fn read_conflict_versions(&self, id: &str) -> Result<ConflictVersions, SyncError> {
        /// Larger files are not shown side by side; the person chooses a whole version.
        const LIMIT: u64 = 8 * 1024 * 1024;
        let shared = &self.shared;
        let _work = shared.work.lock().unwrap_or_else(|e| e.into_inner());
        let vault = &shared.config.vault;
        let mut store = SqliteStateStore::open(vault).map_err(|e| state_error(&e))?;
        let conflicts = list_conflicts(vault, &mut store).map_err(|e| state_error(&e))?;
        let conflict = conflicts
            .into_iter()
            .find(|conflict| conflict.id == id)
            .ok_or_else(|| SyncError::new("conflict_not_found"))?;
        let text = |relative: &str| {
            let path = vault.join(relative);
            if fs::metadata(&path).map_or(true, |meta| meta.len() > LIMIT) {
                return None;
            }
            fs::read(&path)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
        };
        Ok(ConflictVersions {
            original: text(&conflict.path),
            copy: text(&conflict.other_path),
            stamp: conflict_stamp(vault, &conflict),
        })
    }

    /// The common part of resolving a conflict: finds it, changes the files with `change`, takes
    /// the entry out of the list and starts a pass.
    fn resolve_with(
        &self,
        id: &str,
        expected_stamp: Option<&str>,
        change: impl FnOnce(
            &mut FileConflictStore,
            &ConflictEntry,
            &mut VaultFs,
            &Path,
        ) -> Result<(), ConflictError>,
    ) -> Result<(), SyncError> {
        let shared = &self.shared;
        let _work = shared.work.lock().unwrap_or_else(|e| e.into_inner());
        let vault = &shared.config.vault;
        let mut store = SqliteStateStore::open(vault).map_err(|e| state_error(&e))?;
        let conflicts = list_conflicts(vault, &mut store).map_err(|e| state_error(&e))?;
        let conflict = conflicts
            .into_iter()
            .find(|conflict| conflict.id == id)
            .ok_or_else(|| SyncError::new("conflict_not_found"))?;
        // A text built by the comparison is written only if both files are what the window read
        // (checked under the lock, at the border of the write).
        if expected_stamp.is_some_and(|stamp| conflict_stamp(vault, &conflict) != stamp) {
            return Err(SyncError::new("conflict_changed"));
        }

        let (mut conflict_store, mut files) =
            conflict_store_of(vault, &mut store, shared).map_err(|e| state_error(&e))?;
        files.batch_begin();
        let result = change(&mut conflict_store, &conflict, &mut files, vault);
        files.batch_end();
        result.map_err(|error| SyncError::new(conflict_error_code(&error)))?;

        let mut gone = vec![StateOp::RemoveConflict(conflict.id.clone())];
        if let Some(recorded) = copy_name_id(&conflict.other_path) {
            gone.push(StateOp::RemoveConflict(recorded));
        }
        store.apply(&gone).map_err(|e| state_error(&e))?;
        let conflicts = list_conflicts(vault, &mut store).map_err(|e| state_error(&e))?;
        let (_, unsynced) = store.lists().map_err(|e| state_error(&e))?;
        drop(store);
        shared.update(|status| {
            status.conflicts = conflicts.iter().map(conflict_view).collect();
            status.unsynced = unsynced.iter().map(unsynced_view).collect();
        });
        shared.trigger(Trigger::Ordinary);
        Ok(())
    }

    /// Stops the worker and the listener, waits for them and releases the lock. A pass that is
    /// running ends first: the state is whole at every point (Д4).
    pub fn stop(mut self) {
        {
            let mut control = self.shared.control();
            control.shutdown = true;
        }
        self.shared.changed.notify_all();
        self.shared.shutdown_listener.notify_one();
        if let Some(listener) = self.listener.take() {
            listener.abort();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for SyncSession {
    fn drop(&mut self) {
        // A session dropped without `stop` still lets its threads end.
        if self.worker.is_some() {
            if let Ok(mut control) = self.shared.control.lock() {
                control.shutdown = true;
            }
            self.shared.changed.notify_all();
            if let Some(listener) = self.listener.take() {
                listener.abort();
            }
        }
    }
}

/// A fingerprint of the two files of a conflict (their bytes, or size and time for a file too large to
/// read), so a text built from them can be refused when they have changed.
fn conflict_stamp(vault: &Path, conflict: &ConflictEntry) -> String {
    let mut digest = Sha256::new();
    for relative in [&conflict.path, &conflict.other_path] {
        let path = vault.join(relative);
        match fs::metadata(&path) {
            Err(_) => digest.update(b"missing;"),
            Ok(meta) if meta.len() > 64 * 1024 * 1024 => {
                digest.update(format!("large;{};{};", meta.len(), modified_ms(&path)));
            }
            Ok(meta) => {
                digest.update(format!("file;{};", meta.len()));
                digest.update(fs::read(&path).unwrap_or_default());
            }
        }
    }
    hex::encode(digest.finalize())
}

/// "Keep both" (Г29), kept until the interface of К3: the second version becomes a file beside the
/// note, as a copy was, with an identity of its own when it is a note; a set is removed.
fn keep_both(
    store: &mut FileConflictStore,
    entry: &ConflictEntry,
    files: &mut VaultFs,
    vault: &Path,
) -> Result<(), ConflictError> {
    use amby_sync_core::engine::names::conflict_copy_path;
    match entry.source {
        ConflictSource::LegacyCopy => {
            give_copy_its_own_identity(files, vault, &entry.path, &entry.other_path);
            Ok(())
        }
        ConflictSource::Bundle => {
            let copy = conflict_copy_path(&entry.path, &entry.id);
            let bytes = files
                .read(&entry.other_path)
                .map_err(|e| ConflictError::Storage(e.to_string()))?;
            let mut staged = files
                .begin_write(&copy)
                .map_err(|e| ConflictError::Storage(e.to_string()))?;
            for chunk in bytes.chunks(64 * 1024) {
                if let Err(error) = staged.write(chunk) {
                    staged.abort();
                    return Err(ConflictError::Storage(error.to_string()));
                }
            }
            staged
                .publish(None)
                .map_err(|e| ConflictError::Storage(e.to_string()))?;
            give_copy_its_own_identity(files, vault, &entry.path, &copy);
            store.resolve(&entry.id, Resolution::Current)
        }
    }
}

/// A copy of a note repeats the `amby-id` of its file, and Amby refuses to edit two notes with one
/// identity (docs/vault-format.md). When the person keeps both files, the copy becomes a note of its
/// own: a new `amby-id`, nothing else changed, the old text first in the history. Best effort:
/// a copy whose frontmatter cannot take it without guessing stays as it is (a read-only duplicate
/// that the person can still read and copy from).
fn give_copy_its_own_identity(files: &mut VaultFs, vault: &Path, original: &str, copy: &str) {
    let (Ok(copy_bytes), Ok(original_bytes)) = (files.read(copy), files.read(original)) else {
        return;
    };
    let (Ok(copy_text), Ok(original_text)) = (
        String::from_utf8(copy_bytes),
        String::from_utf8(original_bytes),
    ) else {
        return;
    };
    let copy_id = crate::frontmatter::parse_markdown(&copy_text)
        .note_id()
        .map(str::to_string);
    let original_id = crate::frontmatter::parse_markdown(&original_text)
        .note_id()
        .map(str::to_string);
    if copy_id.is_none() || copy_id != original_id {
        return;
    }
    let Ok(next) =
        crate::frontmatter::with_replaced_amby_id(&copy_text, &ulid::Ulid::generate().to_string())
    else {
        return;
    };
    let target = vault.join(copy);
    if crate::history::snapshot_before_write(vault, &target, next.as_bytes(), "id-assignment")
        .is_err()
    {
        return;
    }
    let Ok(mut staged) = files.begin_write(copy) else {
        return;
    };
    if staged.write(next.as_bytes()).is_err() {
        staged.abort();
        return;
    }
    let _: Result<(), _> = staged.publish(None);
}

/// The store of the conflicts of this vault (Г25, Г27) and the files it writes through.
fn conflict_store_of(
    vault: &Path,
    store: &mut SqliteStateStore,
    shared: &Shared,
) -> Result<(FileConflictStore, VaultFs), StateError> {
    let (recorded, _) = store.lists()?;
    let created_here = recorded.iter().map(|record| record.id.clone()).collect();
    let conflicts = FileConflictStore::new(vault.to_path_buf(), store.live_paths()?, created_here)
        .with_hooks(shared.config.hooks.clone());
    let files = VaultFs::with_hooks(vault.to_path_buf(), shared.config.hooks.clone());
    Ok((conflicts, files))
}

/// The open conflicts of the vault, as every computer lists them (Г25, Г29): the complete sets in
/// `.amby/conflicts/` and the old copies beside their files. The entries recorded on this computer
/// mean "made here"; one whose files are gone leaves the state, so resolving a conflict on one
/// computer clears it on all of them.
fn list_conflicts(
    vault: &Path,
    store: &mut SqliteStateStore,
) -> Result<Vec<ConflictEntry>, StateError> {
    let (recorded, _) = store.lists()?;
    let created_here = recorded.iter().map(|record| record.id.clone()).collect();
    let entries = FileConflictStore::new(vault.to_path_buf(), store.live_paths()?, created_here)
        .list()
        .map_err(|error| StateError::Io(error.to_string()))?;
    let mut open: std::collections::BTreeSet<String> =
        entries.iter().map(|entry| entry.id.clone()).collect();
    for entry in entries
        .iter()
        .filter(|entry| entry.source == ConflictSource::LegacyCopy)
    {
        open.extend(copy_name_id(&entry.other_path));
    }
    for record in recorded {
        if !open.contains(&record.id) {
            store.apply(&vec![StateOp::RemoveConflict(record.id)])?;
        }
    }
    Ok(entries)
}

/// The machine code of a refusal of the store (Г35).
fn conflict_error_code(error: &ConflictError) -> &'static str {
    match error {
        ConflictError::NotFound => "conflict_not_found",
        ConflictError::Incomplete => "conflict_incomplete",
        ConflictError::OriginalMissing => "conflict_original_missing",
        ConflictError::NotText => "conflict_not_text",
        ConflictError::Storage(_) => "storage_error",
    }
}

/// When a file was last written, in milliseconds since the epoch (0 when unknown; display only).
fn modified_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

fn conflict_view(conflict: &ConflictEntry) -> ConflictView {
    ConflictView {
        id: conflict.id.clone(),
        kind: conflict.kind.clone(),
        original_path: conflict.path.clone(),
        copy_path: conflict.other_path.clone(),
        created_ms: conflict.created_ms,
        source: Some(conflict.source),
        text: Some(conflict.text),
        has_base: Some(conflict.has_base),
        created_here: Some(conflict.created_here),
    }
}

fn unsynced_view(record: &UnsyncedRecord) -> UnsyncedView {
    use amby_sync_core::engine::names::NameProblem;
    let (reason, detail) = match &record.reason {
        UnsyncedReason::Symlink => ("symlink", None),
        UnsyncedReason::NotUtf8 => ("notUtf8", None),
        UnsyncedReason::TooLarge { .. } => ("tooLarge", None),
        UnsyncedReason::QuotaFull => ("quotaFull", None),
        UnsyncedReason::TooBigForMemory => ("tooBigForMemory", None),
        UnsyncedReason::ExcludedPath => ("excludedPath", None),
        UnsyncedReason::InvalidName(problem) => (
            "invalidName",
            Some(
                match problem {
                    NameProblem::WindowsForbiddenChar(_) => "forbiddenChar",
                    NameProblem::TrailingDotOrSpace => "trailingDot",
                    NameProblem::ReservedName(_) => "reservedName",
                    NameProblem::SegmentTooLong => "segmentTooLong",
                    NameProblem::PathTooLong => "pathTooLong",
                }
                .to_string(),
            ),
        ),
        UnsyncedReason::CaseCollision { with } => ("caseCollision", Some(with.clone())),
        UnsyncedReason::NameCollision => ("nameCollision", None),
        UnsyncedReason::PathBusy => ("pathBusy", None),
        UnsyncedReason::NoAccess => ("noAccess", None),
    };
    let (max_bytes, limit_source) = match &record.reason {
        UnsyncedReason::TooLarge { max_bytes, source } => (
            Some(*max_bytes),
            Some(
                match source {
                    amby_sync_core::engine::LimitSource::Plan => "plan",
                    amby_sync_core::engine::LimitSource::Server => "server",
                }
                .to_string(),
            ),
        ),
        _ => (None, None),
    };
    UnsyncedView {
        path: record.path.clone(),
        reason: reason.to_string(),
        detail,
        max_bytes,
        limit_source,
    }
}

/// The most files of a stop that go to the interface; the total is told separately.
const SHOWN_FILES: usize = 200;

fn stop_view(reason: &StopReason) -> StopView {
    use amby_sync_core::engine::PlannedKind;
    match reason {
        StopReason::MassChange { direction, files } => StopView::MassChange {
            direction: match direction {
                Direction::Incoming => "incoming",
                Direction::Outgoing => "outgoing",
            }
            .to_string(),
            total: u32::try_from(files.len()).unwrap_or(u32::MAX),
            files: files
                .iter()
                .take(SHOWN_FILES)
                .map(|file| PlannedView {
                    path: file.path.clone(),
                    action: match file.kind {
                        PlannedKind::Overwrite => "overwrite",
                        PlannedKind::Trash => "trash",
                        PlannedKind::SendDelete => "sendDelete",
                    }
                    .to_string(),
                })
                .collect(),
        },
        StopReason::VaultMissing => StopView::VaultMissing,
        StopReason::VaultEmpty => StopView::VaultEmpty,
        StopReason::ServerReset { .. } => StopView::ServerReset,
        StopReason::ServerBehind { .. } => StopView::ServerBehind,
        StopReason::Rollback { .. } => StopView::Rollback,
        StopReason::AuthRequired => StopView::AuthRequired,
        StopReason::IncompatibleServer => StopView::IncompatibleServer,
    }
}

fn now_ms() -> i64 {
    use amby_sync_core::engine::Clock;
    SystemClock.now_ms()
}

fn seconds_ceil(pause: Duration) -> u64 {
    pause.as_secs_f64().ceil().max(1.0) as u64
}

/// The worker: waits for the next pass, runs it, waits again.
fn worker(shared: &Arc<Shared>) {
    let schedule = shared.config.schedule;
    let mut failures: u32 = 0;
    loop {
        let (target, request) = {
            let mut control = shared.control();
            loop {
                if control.shutdown {
                    return;
                }
                let deadline = control.due.unwrap_or(control.next_poll);
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                let (guard, _) = shared
                    .changed
                    .wait_timeout(control, deadline - now)
                    .unwrap_or_else(|e| e.into_inner());
                control = guard;
            }
            control.due = None;
            let request = CycleRequest {
                approvals: std::mem::take(&mut control.approvals),
                rename_hints: std::mem::take(&mut control.hints),
            };
            (control.requested, request)
        };

        let outcome = {
            let _work = shared.work.lock().unwrap_or_else(|e| e.into_inner());
            run_pass(shared, &request)
        };
        let next = settle(shared, outcome, &mut failures, &schedule);

        let mut control = shared.control();
        let now = Instant::now();
        control.done = control.done.max(target);
        control.next_poll = now + next.poll;
        control.hold = next.hold;
        if control.requested > target {
            // Somebody asked for a pass while this one ran (a button, an answer, a caller that
            // waits for it): it is due now, whatever this pass decided.
            control.hold = false;
            control.due = Some(now);
        } else if let Some(pause) = next.retry_in {
            control.due = Some(now + pause);
        } else if next.hold {
            control.due = None;
        }
        shared.changed.notify_all();
    }
}

/// What the worker does after a pass.
struct Next {
    /// Ordinary triggers are ignored until the person acts or the pause ends.
    hold: bool,
    /// Another pass after this pause.
    retry_in: Option<Duration>,
    /// The fallback pass after this long.
    poll: Duration,
}

enum Outcome {
    Report(Box<CycleReport>),
    Failed(EngineError),
    Panicked,
    NoState(SyncError),
}

fn run_pass(shared: &Arc<Shared>, request: &CycleRequest) -> Outcome {
    let config = &shared.config;
    shared.update(|status| {
        status.phase = SyncPhase::Running;
        status.next_try_secs = None;
    });
    let state = match SqliteStateStore::open(&config.vault) {
        Ok(state) => state,
        // The engine would say the same after reading the state (Р8, Д55); it cannot start
        // without one, so the stop is made here.
        Err(StateError::Io(text)) if text == "vault_missing" => {
            return Outcome::Report(Box::new(CycleReport {
                outcome: CycleOutcome::Stopped(StopReason::VaultMissing),
                downloaded: 0,
                uploaded: 0,
                renamed: 0,
                trashed: 0,
                trashed_paths: Vec::new(),
                restored_paths: Vec::new(),
                merged_paths: Vec::new(),
                conflicts: Vec::new(),
                unsynced: Vec::new(),
                read_only: Vec::new(),
                needs_update: false,
                errors: Vec::new(),
                outgoing_paused: false,
                full_reconcile: false,
                limits: amby_sync_core::engine::PassLimits::unknown(),
            }));
        }
        Err(error) => return Outcome::NoState(state_error(&error)),
    };
    let fs_hooks: Arc<dyn FsHooks> = config.hooks.clone();
    let ports = Ports {
        fs: Box::new(VaultFs::with_hooks(config.vault.clone(), fs_hooks)),
        remote: Box::new(HttpRemote::new(
            config.handle.clone(),
            config.client.clone(),
            config.token.clone(),
            config.space_id,
        )),
        state: Box::new(state),
        clock: Box::new(SystemClock),
        rng: Box::new(OsRandom),
    };
    let mut engine = Engine::new(
        ports,
        EngineConfig::new(SpaceId::from_bytes(config.space_id), config.vk.clone()),
    );
    match catch_unwind(AssertUnwindSafe(|| engine.sync_cycle(request))) {
        Ok(Ok(report)) => Outcome::Report(Box::new(report)),
        Ok(Err(error)) => Outcome::Failed(error),
        Err(_) => Outcome::Panicked,
    }
}

/// The machine code of a failure of the server.
fn remote_code(error: &RemoteError) -> String {
    match error {
        RemoteError::Network(code) => code.clone(),
        RemoteError::Unauthorized => "unauthorized".to_string(),
        RemoteError::Revoked => "token_revoked".to_string(),
        RemoteError::Rejected { code, .. } => code.clone(),
    }
}

/// Updates the status after a pass and decides what comes next.
fn settle(shared: &Arc<Shared>, outcome: Outcome, failures: &mut u32, schedule: &Schedule) -> Next {
    let lists = SqliteStateStore::open(&shared.config.vault)
        .and_then(|mut store| {
            let conflicts = list_conflicts(&shared.config.vault, &mut store)?;
            let (_, unsynced) = store.lists()?;
            Ok((conflicts, unsynced))
        })
        .ok();
    let waiting = |failures: &mut u32, code: String, schedule: &Schedule| {
        *failures = failures.saturating_add(1);
        let pause = schedule.backoff(*failures);
        shared.update(|status| {
            status.phase = SyncPhase::Waiting;
            status.error_code = Some(code);
            status.next_try_secs = Some(seconds_ceil(pause));
            status.stop = None;
        });
        Next {
            hold: true,
            retry_in: Some(pause),
            poll: schedule.poll,
        }
    };
    let stopped = |code: Option<String>, retry_in: Option<Duration>| {
        shared.update(|status| {
            status.phase = SyncPhase::Stopped;
            status.error_code = code;
            status.next_try_secs = retry_in.map(seconds_ceil);
        });
        Next {
            hold: true,
            retry_in,
            poll: Duration::from_secs(60 * 60 * 24 * 365),
        }
    };
    match outcome {
        Outcome::Report(report) => {
            let report = *report;
            if !report.merged_paths.is_empty() {
                shared.config.hooks.merged_after_edits(&report.merged_paths);
            }
            if !report.restored_paths.is_empty() {
                shared
                    .config
                    .hooks
                    .restored_after_deletion(&report.restored_paths);
            }
            let apply_lists = |status: &mut VaultSyncStatus| {
                if let Some((conflicts, unsynced)) = &lists {
                    status.conflicts = conflicts.iter().map(conflict_view).collect();
                    status.unsynced = unsynced.iter().map(unsynced_view).collect();
                } else {
                    status.unsynced = report.unsynced.iter().map(unsynced_view).collect();
                }
            };
            match &report.outcome {
                CycleOutcome::Done => {
                    *failures = 0;
                    let item_errors = u32::try_from(report.errors.len()).unwrap_or(u32::MAX);
                    shared.update(|status| {
                        status.phase = SyncPhase::Idle;
                        status.last_sync_ms = Some(now_ms());
                        status.error_code = None;
                        status.next_try_secs = None;
                        status.stop = None;
                        status.outgoing_paused = report.outgoing_paused;
                        status.needs_update = report.needs_update;
                        status.item_errors = item_errors;
                        status.last = Some(PassSummary {
                            downloaded: count(report.downloaded),
                            uploaded: count(report.uploaded),
                            renamed: count(report.renamed),
                            trashed: count(report.trashed),
                        });
                        apply_lists(status);
                    });
                    if !report.trashed_paths.is_empty() {
                        shared
                            .config
                            .hooks
                            .remote_deleted(&shared.config.vault, &report.trashed_paths);
                    }
                    // Something is left to do that no event will announce: a journal that ends
                    // (it lives in `.amby/`, which the watcher does not report) or files that
                    // failed. Look again after a growing pause.
                    if report.outgoing_paused || item_errors > 0 {
                        *failures = failures.saturating_add(1);
                        Next {
                            hold: false,
                            retry_in: Some(schedule.backoff(*failures)),
                            poll: schedule.poll,
                        }
                    } else {
                        Next {
                            hold: false,
                            retry_in: None,
                            poll: schedule.poll,
                        }
                    }
                }
                CycleOutcome::Busy => {
                    shared.update(|status| {
                        status.phase = SyncPhase::Idle;
                        apply_lists(status);
                    });
                    Next {
                        hold: false,
                        retry_in: Some(schedule.backoff(1)),
                        poll: schedule.poll,
                    }
                }
                CycleOutcome::Stopped(reason) => {
                    let view = stop_view(reason);
                    let probe = matches!(reason, StopReason::AuthRequired);
                    let auto = matches!(reason, StopReason::VaultMissing);
                    *failures = if auto { failures.saturating_add(1) } else { 0 };
                    let retry = auto.then(|| schedule.backoff(*failures));
                    let code = if probe {
                        Some(probe_token(shared))
                    } else {
                        None
                    };
                    shared.update(|status| {
                        status.stop = Some(view);
                        apply_lists(status);
                    });
                    stopped(code, retry)
                }
            }
        }
        Outcome::Failed(error) => {
            tracing::warn!(event = "sync_pass_failed", kind = %failure_kind(&error));
            match &error {
                EngineError::Remote(error) => waiting(failures, remote_code(error), schedule),
                EngineError::Locked => waiting(failures, "vault_locked".to_string(), schedule),
                EngineError::Fs(_) => waiting(failures, "storage_error".to_string(), schedule),
                EngineError::State(state) => match state_error(state).code.as_str() {
                    "state_newer" => stopped(Some("state_newer".to_string()), None),
                    code => waiting(failures, code.to_string(), schedule),
                },
                EngineError::Crypto(_) => stopped(Some("crypto".to_string()), None),
            }
        }
        Outcome::NoState(error) => match error.code.as_str() {
            "state_newer" => stopped(Some("state_newer".to_string()), None),
            code => waiting(failures, code.to_string(), schedule),
        },
        Outcome::Panicked => {
            tracing::error!(event = "sync_pass_panicked");
            waiting(failures, "internal".to_string(), schedule)
        }
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn failure_kind(error: &EngineError) -> &'static str {
    match error {
        EngineError::Locked => "locked",
        EngineError::Remote(_) => "remote",
        EngineError::Fs(_) => "fs",
        EngineError::State(_) => "state",
        EngineError::Crypto(_) => "crypto",
    }
}

/// The engine reports a refused token as one stop; which refusal it was decides the wording
/// ("disconnected" or "sign in again"). One cheap request tells.
fn probe_token(shared: &Arc<Shared>) -> String {
    let config = &shared.config;
    match config.handle.block_on(config.client.devices(&config.token)) {
        Err(error) => error.code().to_string(),
        Ok(_) => "unauthorized".to_string(),
    }
}

/// The listener of notifications (П34): a commit by another device starts a pass without waiting
/// for the fallback. It reconnects with a growing pause and never stops by itself.
async fn listen(shared: Arc<Shared>) {
    let config = &shared.config;
    let schedule = config.schedule;
    let mut failures: u32 = 0;
    loop {
        if let Ok(mut stream) = config.client.events(&config.token, &config.space_id).await {
            {
                let mut heard = false;
                loop {
                    let next = tokio::select! {
                        event = stream.next() => event,
                        () = shared.shutdown_listener.notified() => return,
                    };
                    match next {
                        Ok(Some(ServerEvent::Ping)) => {}
                        // The greeting names the head of the feed: a pass is needed only when it is
                        // beyond what this device has processed (commits that came while the line
                        // was down, or between the first pass and the connection).
                        Ok(Some(ServerEvent::Hello { seq, .. })) => {
                            heard = true;
                            let vault = config.vault.clone();
                            let known = tokio::task::spawn_blocking(move || {
                                SqliteStateStore::open(&vault).and_then(|store| store.cursor())
                            })
                            .await;
                            if !matches!(known, Ok(Ok(cursor)) if cursor >= seq) {
                                shared.trigger(Trigger::Ordinary);
                            }
                        }
                        // Our own commit is already known to the pass that made it.
                        Ok(Some(ServerEvent::Commit { device_id, .. })) => {
                            heard = true;
                            if hex::encode(device_id) != config.device_id {
                                shared.trigger(Trigger::Ordinary);
                            }
                        }
                        Ok(None) | Err(_) => break,
                    }
                }
                if heard {
                    failures = 0;
                }
            }
        }
        failures = failures.saturating_add(1);
        let pause = schedule.backoff(failures).max(Duration::from_millis(10));
        tokio::select! {
            () = tokio::time::sleep(pause) => {}
            () = shared.shutdown_listener.notified() => return,
        }
    }
}
