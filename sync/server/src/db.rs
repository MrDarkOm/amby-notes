//! The SQLite database (Р11): one file in WAL mode, a schema with a version number and
//! migrations that are checked before and after they run.
//!
//! Every request takes the connection for the few milliseconds of its transaction; nothing waits
//! for the network or the disk of a body while holding it. Writers from another process (the
//! administrator commands run next to the server) wait for each other through SQLite's own lock
//! (`busy_timeout`), so two commands never see a half-written state.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rusqlite::{Connection, TransactionBehavior};

/// Migrations in order. The schema version is the number of entries applied (`user_version`).
/// Never edit an applied entry: add a new one.
const MIGRATIONS: &[&str] = &[SCHEMA_V1];

const SCHEMA_V1: &str = "
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
) WITHOUT ROWID;

CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE,
    created_ms          INTEGER NOT NULL,
    enroll_hash         BLOB,
    enroll_expires_ms   INTEGER,
    has_password        INTEGER NOT NULL DEFAULT 0,
    salt                BLOB,
    kdf_memory_kib      INTEGER,
    kdf_iterations      INTEGER,
    kdf_parallelism     INTEGER,
    auth_hash           BLOB,
    recovery_hash       BLOB,
    wrapped_ak          BLOB,
    wrapped_ak_recovery BLOB,
    keys_version        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE devices (
    id           INTEGER PRIMARY KEY,
    device_id    BLOB NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name_enc     BLOB NOT NULL,
    token_hash   BLOB NOT NULL UNIQUE,
    created_ms   INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL
);
CREATE INDEX devices_user ON devices(user_id, id);

CREATE TABLE revoked_tokens (
    token_hash BLOB PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE spaces (
    id          INTEGER PRIMARY KEY,
    space_id    BLOB NOT NULL UNIQUE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name_enc    BLOB NOT NULL,
    key_epoch   INTEGER NOT NULL,
    wrapped_vk  BLOB NOT NULL,
    seq         INTEGER NOT NULL DEFAULT 0,
    purged_seq  INTEGER NOT NULL DEFAULT 0,
    created_ms  INTEGER NOT NULL
);
CREATE INDEX spaces_user ON spaces(user_id, id);

CREATE TABLE blobs (
    space       INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    blob_id     BLOB NOT NULL,
    size        INTEGER NOT NULL,
    complete    INTEGER NOT NULL DEFAULT 0,
    created_ms  INTEGER NOT NULL,
    activity_ms INTEGER NOT NULL,
    PRIMARY KEY (space, blob_id)
) WITHOUT ROWID;

CREATE TABLE versions (
    space         INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    item_id       BLOB NOT NULL,
    version       INTEGER NOT NULL,
    seq           INTEGER NOT NULL,
    ord           INTEGER NOT NULL,
    header        BLOB NOT NULL,
    blob_id       BLOB,
    deleted       INTEGER NOT NULL,
    device_id     BLOB NOT NULL,
    committed_ms  INTEGER NOT NULL,
    superseded_ms INTEGER,
    PRIMARY KEY (space, item_id, version)
) WITHOUT ROWID;
CREATE INDEX versions_feed ON versions(space, seq, ord) WHERE superseded_ms IS NULL;
CREATE INDEX versions_blob ON versions(space, blob_id) WHERE blob_id IS NOT NULL;
CREATE INDEX versions_superseded ON versions(superseded_ms) WHERE superseded_ms IS NOT NULL;

CREATE TABLE commits (
    space        INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    commit_id    BLOB NOT NULL,
    digest       BLOB NOT NULL,
    response     TEXT NOT NULL,
    committed_ms INTEGER NOT NULL,
    PRIMARY KEY (space, commit_id)
) WITHOUT ROWID;

CREATE TABLE login_failures (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,
    addr  TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    -- A good sign-in clears the strict count of its pair; the loose count per name only ages (П16).
    strict_cleared INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX login_failures_name ON login_failures(name, at_ms);
CREATE INDEX login_failures_pair ON login_failures(name, addr, at_ms);
";

/// The schema version this code writes and understands.
pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

/// Name of the database file inside the data directory.
pub const DB_FILE: &str = "amby-sync.db";

/// Why the database could not be opened.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    /// The file system failed.
    #[error("data directory: {0}")]
    Io(String),
    /// SQLite failed.
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The database was written by a newer server; opening it could damage it.
    #[error("the database has schema version {found}, this server knows up to {known}: update the server")]
    TooNew {
        /// Version in the file.
        found: i64,
        /// Newest version this code knows.
        known: i64,
    },
    /// A check before or after a migration found damage.
    #[error("database check failed: {0}")]
    Damaged(String),
}

/// The database connection and the identity of the server stored in it.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Opens (creating it on first start) the database in `data_dir`, migrates it and makes sure
    /// `instance_id` (П10) and the secret of the fake salts (П13) exist.
    pub fn open(data_dir: &Path) -> Result<Self, DbError> {
        std::fs::create_dir_all(data_dir).map_err(|error| DbError::Io(error.to_string()))?;
        let mut conn = Connection::open(data_dir.join(DB_FILE))?;
        conn.busy_timeout(Duration::from_secs(30))?;
        // Data safety above speed: FULL syncs the log at every commit, so an accepted commit
        // survives a power cut.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut conn)?;
        init_identity(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Runs `work` with the connection. Keep it short and never wait inside.
    pub fn call<R>(&self, work: impl FnOnce(&mut Connection) -> R) -> R {
        work(&mut self.lock())
    }

    /// Runs `work` in one `BEGIN IMMEDIATE` transaction: it takes the write lock first, so the
    /// check and the write of a commit cannot be separated by another writer, in this process
    /// or in another (Р3, П27).
    pub fn write<R, E>(
        &self,
        work: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<R, E>,
    ) -> Result<R, E>
    where
        E: From<rusqlite::Error>,
    {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = work(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    /// Like [`Db::write`], and then runs `after` in a second `BEGIN IMMEDIATE` transaction while
    /// the lock is still held. For deleting files of rows the first transaction removed: files
    /// must not go before the commit (a failed commit would keep rows without files), and after
    /// it the lock must not be let go (a body started again under the same id would lose its
    /// fresh files). `after` checks the rows again, so another process cannot slip in either.
    pub fn write_then<R, E>(
        &self,
        work: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<R, E>,
        after: impl FnOnce(&rusqlite::Transaction<'_>, &R) -> Result<(), E>,
    ) -> Result<R, E>
    where
        E: From<rusqlite::Error>,
    {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = work(&tx)?;
        tx.commit()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        after(&tx, &result)?;
        tx.commit()?;
        Ok(result)
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

/// Checks the file, applies the missing migrations, checks again. Each migration is its own
/// transaction together with the change of the version number, so a crash leaves the old
/// version or the new one, never half.
fn migrate(conn: &mut Connection) -> Result<(), DbError> {
    let found = user_version(conn)?;
    if found > SCHEMA_VERSION {
        return Err(DbError::TooNew {
            found,
            known: SCHEMA_VERSION,
        });
    }
    if found == SCHEMA_VERSION {
        return Ok(());
    }
    if found > 0 {
        // An existing database is about to change: look for damage first, so that a migration
        // never runs on a broken file.
        quick_check(conn)?;
    }
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let target = index as i64 + 1;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Another process may have migrated while this one waited for the lock.
        if user_version(&tx)? >= target {
            continue;
        }
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", target)?;
        tx.commit()?;
    }
    quick_check(conn)?;
    let mut statement = conn.prepare("PRAGMA foreign_key_check")?;
    if statement.exists([])? {
        return Err(DbError::Damaged("foreign key check failed".into()));
    }
    Ok(())
}

fn quick_check(conn: &Connection) -> Result<(), DbError> {
    let verdict: String = conn.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if verdict == "ok" {
        Ok(())
    } else {
        Err(DbError::Damaged(verdict))
    }
}

/// `instance_id` and the secret of the fake salts are made together with the database and then
/// never change (П10, П13).
fn init_identity(conn: &mut Connection) -> Result<(), DbError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (key, length) in [("instance_id", 16usize), ("prelogin_secret", 32)] {
        let have: Option<Vec<u8>> = tx
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        if have.is_none() {
            let mut bytes = vec![0u8; length];
            getrandom::fill(&mut bytes).map_err(|error| DbError::Io(error.to_string()))?;
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, bytes],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// A stored value from `meta`.
pub fn meta_value(conn: &Connection, key: &str) -> rusqlite::Result<Vec<u8>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
}
