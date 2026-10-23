//! The state of the device in `.amby/sync/state.db` (SQLite; docs/sync-plan.md, Р10; port
//! [`amby_sync_core::engine::StateStore`]). It is not a cache but not the only copy of the data
//! either: if the file is lost, the device reconciles everything again by content hashes and
//! deletes nothing. A file that cannot be read is moved aside (`state.db.broken-*`) and a new one
//! is made, so a damaged file never stops synchronisation and never loses evidence.
//!
//! The file has a schema number (`PRAGMA user_version`). A file of a newer schema is not touched:
//! opening it fails with the code `state_newer` (a newer Amby wrote it).

use std::path::{Path, PathBuf};

use amby_sync_core::engine::{StateError, StateLock, StateStore, StateTx, SyncState};

/// The schema this build writes.
pub const SCHEMA_VERSION: u32 = 1;

/// Keys of the small table `meta` (ID of the device and of the space, the switch, the mark of a
/// test vault, Р10).
pub const META_DEVICE_ID: &str = "device_id";
/// The space (hex) this vault is linked to.
pub const META_SPACE_ID: &str = "space_id";
/// The name of the space as last read.
pub const META_SPACE_NAME: &str = "space_name";
/// `1` when the person marked this vault as a test vault.
pub const META_TEST_VAULT: &str = "test_vault";
/// `1` when synchronisation is switched on for this vault.
pub const META_ENABLED: &str = "enabled";
/// The address of the server this state belongs to.
pub const META_SERVER_URL: &str = "server_url";

/// The folder `.amby/sync/` of a vault.
pub fn state_dir(vault: &Path) -> PathBuf {
    vault.join(".amby").join("sync")
}

/// The file `.amby/sync/state.db` of a vault.
pub fn state_path(vault: &Path) -> PathBuf {
    state_dir(vault).join("state.db")
}

/// The state in SQLite.
pub struct SqliteStateStore {
    _path: PathBuf,
}

impl SqliteStateStore {
    /// Opens (and makes, with its folders) the state of the vault at `vault`.
    pub fn open(_vault: &Path) -> Result<Self, StateError> {
        todo!("Э4: SqliteStateStore::open")
    }

    /// Opens a state file at an explicit path (tests); the lock file is next to it.
    pub fn open_file(_path: &Path) -> Result<Self, StateError> {
        todo!("Э4: SqliteStateStore::open_file")
    }

    /// A value of the table `meta`.
    pub fn meta(&self, _key: &str) -> Result<Option<String>, StateError> {
        todo!("Э4: SqliteStateStore::meta")
    }

    /// Sets a value of the table `meta`.
    pub fn set_meta(&mut self, _key: &str, _value: &str) -> Result<(), StateError> {
        todo!("Э4: SqliteStateStore::set_meta")
    }

    /// Removes a value of the table `meta`.
    pub fn remove_meta(&mut self, _key: &str) -> Result<(), StateError> {
        todo!("Э4: SqliteStateStore::remove_meta")
    }

    /// Forgets everything about the link with the server: bases, cursor, uploads, the commit in
    /// flight, conflicts and the "not synchronised" list. The `meta` table stays. Used when the
    /// vault was copied from another computer (Р10).
    pub fn clear_sync_state(&mut self) -> Result<(), StateError> {
        todo!("Э4: SqliteStateStore::clear_sync_state")
    }
}

impl StateStore for SqliteStateStore {
    fn load(&mut self) -> Result<SyncState, StateError> {
        todo!("Э4: SqliteStateStore::load")
    }

    fn apply(&mut self, _tx: &StateTx) -> Result<(), StateError> {
        todo!("Э4: SqliteStateStore::apply")
    }

    fn lock(&mut self) -> Result<StateLock, StateError> {
        todo!("Э4: SqliteStateStore::lock")
    }
}
