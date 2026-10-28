//! The state of the device in `.amby/sync/state.db` (SQLite; docs/sync-plan.md, Р10; port
//! [`amby_sync_core::engine::StateStore`]). It is not a cache but not the only copy of the data
//! either: if the file is lost, the device reconciles everything again by content hashes and
//! deletes nothing. A file that cannot be read is moved aside (`state.db.broken-*`) and a new one
//! is made, so a damaged file never stops synchronisation and never loses evidence.
//!
//! The file has a schema number (`PRAGMA user_version`). A file of a newer schema is not touched:
//! opening it fails with the code `state_newer` (a newer Amby wrote it).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use amby_sync_core::crypto::header::ItemKind;
use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::names::NameProblem;
use amby_sync_core::engine::{
    CommitItem, ConflictKind, ConflictRecord, ItemRecord, LimitSource, PendingCommit,
    PendingUpload, StateError, StateLock, StateOp, StateStore, StateTx, SyncState, UnsyncedReason,
    UnsyncedRecord,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

/// The schema this build writes.
pub const SCHEMA_VERSION: u32 = 1;

/// Keys of the small table `meta` (device, space, switch and legacy metadata, Р10).
pub const META_DEVICE_ID: &str = "device_id";
/// The space (hex) this vault is linked to.
pub const META_SPACE_ID: &str = "space_id";
/// The name of the space as last read.
pub const META_SPACE_NAME: &str = "space_name";
/// Legacy local key, retained so existing vault metadata stays readable.
pub const META_TEST_VAULT: &str = "test_vault";
/// `1` when synchronisation is switched on for this vault.
pub const META_ENABLED: &str = "enabled";
/// The address of the server this state belongs to.
pub const META_SERVER_URL: &str = "server_url";
/// The key of the space wrapped by AK (hex), as the server keeps it (Ф12).
pub const META_WRAPPED_VK: &str = "wrapped_vk";
/// The epoch of that key.
pub const META_KEY_EPOCH: &str = "key_epoch";

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
    path: PathBuf,
    lock_path: PathBuf,
    conn: Connection,
}

fn db_error(error: rusqlite::Error) -> StateError {
    StateError::Io(format!("sqlite: {error}"))
}

fn io_error(error: std::io::Error) -> StateError {
    StateError::Io(format!("io: {error}"))
}

fn is_damaged(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt
            )
    )
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS link (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id BLOB,
    cursor INTEGER NOT NULL,
    head INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    item_id BLOB PRIMARY KEY,
    kind INTEGER NOT NULL,
    path TEXT NOT NULL,
    content_hash BLOB,
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    version INTEGER NOT NULL,
    body_id BLOB,
    deleted INTEGER NOT NULL,
    newer_format INTEGER NOT NULL,
    extra TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
    blob_id BLOB PRIMARY KEY,
    item_id BLOB NOT NULL,
    content_hash BLOB NOT NULL,
    size INTEGER NOT NULL,
    nonce_prefix BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_commit (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    commit_id BLOB NOT NULL,
    items TEXT NOT NULL,
    after TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conflicts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind INTEGER NOT NULL,
    original_path TEXT NOT NULL,
    copy_path TEXT NOT NULL,
    created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS unsynced (
    pos INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    reason TEXT NOT NULL
);
";

/// Opens `path`; a file that is not a database is moved aside and a new one is made.
fn open_connection(path: &Path) -> Result<Connection, StateError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let first = Connection::open(path).and_then(|conn| prepare(&conn).map(|()| conn));
    match first {
        Ok(conn) => Ok(conn),
        Err(error) if is_damaged(&error) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis());
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            for suffix in ["", "-wal", "-shm"] {
                let from = path.with_file_name(format!("{name}{suffix}"));
                if from.exists() {
                    let to = path.with_file_name(format!("{name}.broken-{stamp}{suffix}"));
                    fs::rename(&from, &to).map_err(io_error)?;
                }
            }
            let conn = Connection::open(path).map_err(db_error)?;
            prepare(&conn).map_err(db_error)?;
            Ok(conn)
        }
        Err(error) => Err(db_error(error)),
    }
}

/// The settings of the connection and the schema; a newer schema is refused.
fn prepare(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    let version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISUSE),
            Some("state_newer".to_string()),
        ));
    }
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    if version < SCHEMA_VERSION {
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT OR IGNORE INTO link (id, instance_id, cursor, head) VALUES (1, NULL, 0, 0)",
            [],
        )?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

/// Reads values of the table `meta` of the state of `vault` without changing anything: the file
/// is opened read-only, nothing is created or migrated. `None` when the vault has no readable
/// state (appendix Е, У5: the account overview only looks).
pub fn read_meta_only(vault: &Path, keys: &[&str]) -> Option<Vec<Option<String>>> {
    let path = state_path(vault);
    if !path.is_file() {
        return None;
    }
    let conn = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    keys.iter()
        .map(|key| {
            conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .ok()
        })
        .collect()
}

impl SqliteStateStore {
    /// Opens (and makes, with its folders) the state of the vault at `vault`.
    pub fn open(vault: &Path) -> Result<Self, StateError> {
        // The folder of the vault is never made here: a vault that is gone (an unplugged disk)
        // must not come back as an empty folder holding only a state (Р8, С8).
        if !vault.is_dir() {
            return Err(StateError::Io("vault_missing".to_string()));
        }
        let dir = state_dir(vault);
        fs::create_dir_all(&dir).map_err(io_error)?;
        Self::open_with_lock(state_path(vault), dir.join("lock"))
    }

    /// Opens a state file at an explicit path (tests); the lock file is next to it.
    pub fn open_file(path: &Path) -> Result<Self, StateError> {
        Self::open_with_lock(path.to_path_buf(), path.with_extension("lock"))
    }

    /// `.amby/sync/bases/` (Г6).
    fn bases_dir(&self) -> PathBuf {
        self.path
            .parent()
            .map_or_else(|| PathBuf::from("bases"), |dir| dir.join("bases"))
    }

    /// The file of the base `(item, hash)` (Г6).
    fn base_path(&self, item: &ItemId, hash: &[u8; 32]) -> PathBuf {
        self.bases_dir()
            .join(hex::encode(item.as_bytes()))
            .join(hex::encode(hash))
    }

    fn open_with_lock(path: PathBuf, lock_path: PathBuf) -> Result<Self, StateError> {
        let conn = match open_connection(&path) {
            Ok(conn) => conn,
            Err(StateError::Io(text)) if text.contains("state_newer") => {
                return Err(StateError::Io("state_newer".to_string()));
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            lock_path,
            conn,
        })
    }

    /// The file this store uses.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A value of the table `meta`.
    pub fn meta(&self, key: &str) -> Result<Option<String>, StateError> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_error)
    }

    /// Sets a value of the table `meta`.
    pub fn set_meta(&mut self, key: &str, value: &str) -> Result<(), StateError> {
        self.conn
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(db_error)
    }

    /// Removes a value of the table `meta`.
    pub fn remove_meta(&mut self, key: &str) -> Result<(), StateError> {
        self.conn
            .execute("DELETE FROM meta WHERE key = ?1", [key])
            .map(|_| ())
            .map_err(db_error)
    }

    /// The cursor of the feed: everything up to it is processed (Д5).
    pub fn cursor(&self) -> Result<u64, StateError> {
        let cursor: i64 = self
            .conn
            .query_row("SELECT cursor FROM link WHERE id = 1", [], |row| row.get(0))
            .map_err(db_error)?;
        to_u64(cursor)
    }

    /// The path of every live item by the hex of its `item_id` (Г27), without loading the whole
    /// state.
    pub fn live_paths(&self) -> Result<BTreeMap<String, String>, StateError> {
        let mut statement = self
            .conn
            .prepare("SELECT item_id, path FROM items WHERE deleted = 0")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        let mut paths = BTreeMap::new();
        for row in rows {
            let (item, path) = row.map_err(db_error)?;
            paths.insert(hex::encode(item), path);
        }
        Ok(paths)
    }

    /// The open conflicts and the "not synchronised" list, without loading the whole state.
    pub fn lists(&self) -> Result<(Vec<ConflictRecord>, Vec<UnsyncedRecord>), StateError> {
        let mut conflicts = Vec::new();
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, kind, original_path, copy_path, created_ms FROM conflicts ORDER BY seq",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (id, kind, original_path, copy_path, created_ms) = row.map_err(db_error)?;
            conflicts.push(ConflictRecord {
                id,
                kind: if kind == 0 {
                    ConflictKind::BothEdited
                } else {
                    ConflictKind::BothCreated
                },
                original_path,
                copy_path,
                created_ms,
            });
        }
        drop(statement);
        let mut unsynced = Vec::new();
        let mut statement = self
            .conn
            .prepare("SELECT path, reason FROM unsynced ORDER BY pos")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        for row in rows {
            let (path, reason) = row.map_err(db_error)?;
            let parsed = serde_json::from_str::<Value>(&reason)
                .ok()
                .and_then(|value| reason_from_json(&value));
            if let Some(reason) = parsed {
                unsynced.push(UnsyncedRecord { path, reason });
            }
        }
        Ok((conflicts, unsynced))
    }

    /// Forgets everything about the link with the server: bases, cursor, uploads, the commit in
    /// flight, conflicts and the "not synchronised" list. The `meta` table stays. Used when the
    /// vault was copied from another computer (Р10).
    pub fn clear_sync_state(&mut self) -> Result<(), StateError> {
        let tx = self.conn.transaction().map_err(db_error)?;
        tx.execute_batch(
            "DELETE FROM items; DELETE FROM uploads; DELETE FROM pending_commit;
             DELETE FROM conflicts; DELETE FROM unsynced;
             UPDATE link SET instance_id = NULL, cursor = 0, head = 0;",
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
}

fn to_i64(value: u64) -> Result<i64, StateError> {
    i64::try_from(value).map_err(|_| StateError::Io("a number is too large".to_string()))
}

fn to_u64(value: i64) -> Result<u64, StateError> {
    u64::try_from(value).map_err(|_| StateError::Io("a number is negative".to_string()))
}

fn id16(bytes: Vec<u8>) -> Result<[u8; 16], StateError> {
    bytes
        .try_into()
        .map_err(|_| StateError::Io("an identifier has the wrong size".to_string()))
}

fn hash32(bytes: Vec<u8>) -> Result<[u8; 32], StateError> {
    bytes
        .try_into()
        .map_err(|_| StateError::Io("a hash has the wrong size".to_string()))
}

fn kind_to_int(kind: ItemKind) -> i64 {
    match kind {
        ItemKind::File => 0,
        ItemKind::Folder => 1,
    }
}

fn kind_from_int(value: i64) -> Result<ItemKind, StateError> {
    match value {
        0 => Ok(ItemKind::File),
        1 => Ok(ItemKind::Folder),
        _ => Err(StateError::Io("an unknown kind of item".to_string())),
    }
}

fn record_json(record: &ItemRecord) -> Value {
    json!({
        "item_id": hex::encode(record.item_id.as_bytes()),
        "kind": kind_to_int(record.kind),
        "path": record.path,
        "content_hash": record.content_hash.map(hex::encode),
        "size": record.size,
        "mtime_ns": record.mtime_ns,
        "version": record.version,
        "body_id": record.body_id.map(|body| hex::encode(body.as_bytes())),
        "deleted": record.deleted,
        "newer_format": record.newer_format,
        "extra": record.extra,
    })
}

fn record_from_json(value: &Value) -> Result<ItemRecord, StateError> {
    let text = |name: &str| value.get(name).and_then(Value::as_str);
    let bad = || StateError::Io("a stored record is damaged".to_string());
    let hex_of = |name: &str| -> Result<Option<Vec<u8>>, StateError> {
        match value.get(name) {
            Some(Value::String(text)) => Ok(Some(hex::decode(text).map_err(|_| bad())?)),
            _ => Ok(None),
        }
    };
    Ok(ItemRecord {
        item_id: ItemId::from_bytes(id16(hex_of("item_id")?.ok_or_else(bad)?)?),
        kind: kind_from_int(value.get("kind").and_then(Value::as_i64).ok_or_else(bad)?)?,
        path: text("path").ok_or_else(bad)?.to_string(),
        content_hash: hex_of("content_hash")?.map(hash32).transpose()?,
        size: value.get("size").and_then(Value::as_u64).ok_or_else(bad)?,
        mtime_ns: value
            .get("mtime_ns")
            .and_then(Value::as_i64)
            .ok_or_else(bad)?,
        version: value
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(bad)?,
        body_id: hex_of("body_id")?
            .map(|bytes| id16(bytes).map(BodyId::from_bytes))
            .transpose()?,
        deleted: value
            .get("deleted")
            .and_then(Value::as_bool)
            .ok_or_else(bad)?,
        newer_format: value
            .get("newer_format")
            .and_then(Value::as_bool)
            .ok_or_else(bad)?,
        extra: serde_json::from_value(value.get("extra").cloned().ok_or_else(bad)?)
            .map_err(|_| bad())?,
    })
}

fn commit_item_json(item: &CommitItem) -> Value {
    json!({
        "item_id": hex::encode(item.item_id.as_bytes()),
        "base_version": item.base_version,
        "header": hex::encode(&item.header),
        "blob_id": item.blob_id.map(|body| hex::encode(body.as_bytes())),
        "deleted": item.deleted,
    })
}

fn commit_item_from_json(value: &Value) -> Result<CommitItem, StateError> {
    let bad = || StateError::Io("a stored commit is damaged".to_string());
    let hex_field = |name: &str| -> Result<Vec<u8>, StateError> {
        hex::decode(value.get(name).and_then(Value::as_str).ok_or_else(bad)?).map_err(|_| bad())
    };
    Ok(CommitItem {
        item_id: ItemId::from_bytes(id16(hex_field("item_id")?)?),
        base_version: value
            .get("base_version")
            .and_then(Value::as_u64)
            .ok_or_else(bad)?,
        header: hex_field("header")?,
        blob_id: match value.get("blob_id") {
            Some(Value::String(_)) => Some(BodyId::from_bytes(id16(hex_field("blob_id")?)?)),
            _ => None,
        },
        deleted: value
            .get("deleted")
            .and_then(Value::as_bool)
            .ok_or_else(bad)?,
    })
}

fn problem_json(problem: &NameProblem) -> Value {
    match problem {
        NameProblem::WindowsForbiddenChar(c) => json!({"t": "forbidden_char", "c": c.to_string()}),
        NameProblem::TrailingDotOrSpace => json!({"t": "trailing"}),
        NameProblem::ReservedName(name) => json!({"t": "reserved", "name": name}),
        NameProblem::SegmentTooLong => json!({"t": "segment_long"}),
        NameProblem::PathTooLong => json!({"t": "path_long"}),
    }
}

fn problem_from_json(value: &Value) -> Option<NameProblem> {
    Some(match value.get("t")?.as_str()? {
        "forbidden_char" => {
            NameProblem::WindowsForbiddenChar(value.get("c")?.as_str()?.chars().next()?)
        }
        "trailing" => NameProblem::TrailingDotOrSpace,
        "reserved" => NameProblem::ReservedName(value.get("name")?.as_str()?.to_string()),
        "segment_long" => NameProblem::SegmentTooLong,
        "path_long" => NameProblem::PathTooLong,
        _ => return None,
    })
}

fn reason_json(reason: &UnsyncedReason) -> Value {
    match reason {
        UnsyncedReason::Symlink => json!({"t": "symlink"}),
        UnsyncedReason::NotUtf8 => json!({"t": "not_utf8"}),
        UnsyncedReason::TooLarge { max_bytes, source } => json!({
            "t": "too_large",
            "max_bytes": max_bytes,
            "source": match source {
                LimitSource::Plan => "plan",
                LimitSource::Server => "server",
            },
        }),
        UnsyncedReason::QuotaFull => json!({"t": "quota_full"}),
        UnsyncedReason::TooBigForMemory => json!({"t": "too_big_for_memory"}),
        UnsyncedReason::ExcludedPath => json!({"t": "excluded_path"}),
        UnsyncedReason::InvalidName(problem) => {
            json!({"t": "invalid_name", "problem": problem_json(problem)})
        }
        UnsyncedReason::CaseCollision { with } => json!({"t": "case_collision", "with": with}),
        UnsyncedReason::NameCollision => json!({"t": "name_collision"}),
        UnsyncedReason::PathBusy => json!({"t": "path_busy"}),
        UnsyncedReason::NoAccess => json!({"t": "no_access"}),
    }
}

/// `None` for a reason this build does not know (written by a newer one): the list is made
/// again by every pass, so dropping the line is harmless.
fn reason_from_json(value: &Value) -> Option<UnsyncedReason> {
    Some(match value.get("t")?.as_str()? {
        "symlink" => UnsyncedReason::Symlink,
        "not_utf8" => UnsyncedReason::NotUtf8,
        "too_large" => UnsyncedReason::TooLarge {
            // A row written before appendix Е has neither field.
            max_bytes: value.get("max_bytes").and_then(Value::as_u64).unwrap_or(0),
            source: match value.get("source").and_then(Value::as_str) {
                Some("plan") => LimitSource::Plan,
                _ => LimitSource::Server,
            },
        },
        "quota_full" => UnsyncedReason::QuotaFull,
        "too_big_for_memory" => UnsyncedReason::TooBigForMemory,
        "excluded_path" => UnsyncedReason::ExcludedPath,
        "invalid_name" => UnsyncedReason::InvalidName(problem_from_json(value.get("problem")?)?),
        "case_collision" => UnsyncedReason::CaseCollision {
            with: value.get("with")?.as_str()?.to_string(),
        },
        "name_collision" => UnsyncedReason::NameCollision,
        "path_busy" => UnsyncedReason::PathBusy,
        "no_access" => UnsyncedReason::NoAccess,
        _ => return None,
    })
}

fn put_item(tx: &Transaction<'_>, record: &ItemRecord) -> Result<(), StateError> {
    tx.execute(
        "INSERT OR REPLACE INTO items
         (item_id, kind, path, content_hash, size, mtime_ns, version, body_id, deleted,
          newer_format, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            record.item_id.as_bytes().as_slice(),
            kind_to_int(record.kind),
            record.path,
            record.content_hash.as_ref().map(|hash| hash.as_slice()),
            to_i64(record.size)?,
            record.mtime_ns,
            to_i64(record.version)?,
            record
                .body_id
                .as_ref()
                .map(|body| body.as_bytes().as_slice()),
            record.deleted,
            record.newer_format,
            serde_json::to_string(&record.extra)
                .map_err(|error| StateError::Io(error.to_string()))?,
        ],
    )
    .map(|_| ())
    .map_err(db_error)
}

fn apply_op(tx: &Transaction<'_>, op: &StateOp) -> Result<(), StateError> {
    match op {
        StateOp::SetInstance(id) => tx
            .execute(
                "UPDATE link SET instance_id = ?1",
                [id.as_slice()],
            )
            .map(|_| ()),
        StateOp::SetCursor { cursor, head } => tx
            .execute(
                "UPDATE link SET cursor = ?1, head = ?2",
                params![to_i64(*cursor)?, to_i64(*head)?],
            )
            .map(|_| ()),
        StateOp::PutItem(record) => return put_item(tx, record),
        StateOp::RemoveItem(id) => tx
            .execute("DELETE FROM items WHERE item_id = ?1", [id.as_bytes().as_slice()])
            .map(|_| ()),
        StateOp::PutUpload(upload) => tx
            .execute(
                "INSERT OR REPLACE INTO uploads (blob_id, item_id, content_hash, size, nonce_prefix)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    upload.blob_id.as_bytes().as_slice(),
                    upload.item_id.as_bytes().as_slice(),
                    upload.content_hash.as_slice(),
                    to_i64(upload.size)?,
                    upload.nonce_prefix.as_slice(),
                ],
            )
            .map(|_| ()),
        StateOp::RemoveUpload(id) => tx
            .execute("DELETE FROM uploads WHERE blob_id = ?1", [id.as_bytes().as_slice()])
            .map(|_| ()),
        StateOp::SetCommit(None) => tx.execute("DELETE FROM pending_commit", []).map(|_| ()),
        StateOp::SetCommit(Some(commit)) => {
            let items: Vec<Value> = commit.items.iter().map(commit_item_json).collect();
            let after: Vec<Value> = commit.after.iter().map(record_json).collect();
            tx.execute(
                "INSERT OR REPLACE INTO pending_commit (id, commit_id, items, after)
                 VALUES (1, ?1, ?2, ?3)",
                params![
                    commit.commit_id.as_slice(),
                    Value::Array(items).to_string(),
                    Value::Array(after).to_string(),
                ],
            )
            .map(|_| ())
        }
        StateOp::AddConflict(conflict) => tx
            .execute(
                "INSERT OR IGNORE INTO conflicts (id, kind, original_path, copy_path, created_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    conflict.id,
                    match conflict.kind {
                        ConflictKind::BothEdited => 0,
                        ConflictKind::BothCreated => 1,
                    },
                    conflict.original_path,
                    conflict.copy_path,
                    conflict.created_ms,
                ],
            )
            .map(|_| ()),
        StateOp::RemoveConflict(id) => tx
            .execute("DELETE FROM conflicts WHERE id = ?1", [id])
            .map(|_| ()),
        StateOp::SetUnsynced(list) => {
            tx.execute("DELETE FROM unsynced", []).map_err(db_error)?;
            for (pos, record) in list.iter().enumerate() {
                tx.execute(
                    "INSERT INTO unsynced (pos, path, reason) VALUES (?1, ?2, ?3)",
                    params![pos as i64, record.path, reason_json(&record.reason).to_string()],
                )
                .map_err(db_error)?;
            }
            Ok(())
        }
        StateOp::ResetServerLink => tx
            .execute_batch(
                "DELETE FROM items; DELETE FROM uploads; DELETE FROM pending_commit;
                 UPDATE link SET cursor = 0, head = 0;",
            ),
    }
    .map_err(db_error)
}

impl StateStore for SqliteStateStore {
    fn load(&mut self) -> Result<SyncState, StateError> {
        let tx = self.conn.transaction().map_err(db_error)?;
        let mut state = SyncState::default();
        let (instance, cursor, head): (Option<Vec<u8>>, i64, i64) = tx
            .query_row(
                "SELECT instance_id, cursor, head FROM link WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(db_error)?;
        state.instance_id = instance.map(id16).transpose()?;
        state.cursor = to_u64(cursor)?;
        state.head = to_u64(head)?;

        let mut statement = tx
            .prepare(
                "SELECT item_id, kind, path, content_hash, size, mtime_ns, version, body_id,
                        deleted, newer_format, extra FROM items",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<Vec<u8>>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                    row.get::<_, bool>(8)?,
                    row.get::<_, bool>(9)?,
                    row.get::<_, String>(10)?,
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (item, kind, path, hash, size, mtime, version, body, deleted, newer, extra) =
                row.map_err(db_error)?;
            let extra: BTreeMap<String, Value> = serde_json::from_str(&extra)
                .map_err(|_| StateError::Io("a stored record is damaged".to_string()))?;
            let item_id = id16(item)?;
            state.items.insert(
                item_id,
                ItemRecord {
                    item_id: ItemId::from_bytes(item_id),
                    kind: kind_from_int(kind)?,
                    path,
                    content_hash: hash.map(hash32).transpose()?,
                    size: to_u64(size)?,
                    mtime_ns: mtime,
                    version: to_u64(version)?,
                    body_id: body
                        .map(|bytes| id16(bytes).map(BodyId::from_bytes))
                        .transpose()?,
                    deleted,
                    newer_format: newer,
                    extra,
                },
            );
        }
        drop(statement);

        let mut statement = tx
            .prepare("SELECT blob_id, item_id, content_hash, size, nonce_prefix FROM uploads")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (blob, item, hash, size, nonce) = row.map_err(db_error)?;
            let blob_id = id16(blob)?;
            state.uploads.insert(
                blob_id,
                PendingUpload {
                    blob_id: BodyId::from_bytes(blob_id),
                    item_id: ItemId::from_bytes(id16(item)?),
                    content_hash: hash32(hash)?,
                    size: to_u64(size)?,
                    nonce_prefix: nonce
                        .try_into()
                        .map_err(|_| StateError::Io("a nonce has the wrong size".to_string()))?,
                },
            );
        }
        drop(statement);

        let commit: Option<(Vec<u8>, String, String)> = tx
            .query_row(
                "SELECT commit_id, items, after FROM pending_commit WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db_error)?;
        if let Some((commit_id, items, after)) = commit {
            let damaged = || StateError::Io("a stored commit is damaged".to_string());
            let items: Vec<Value> = serde_json::from_str(&items).map_err(|_| damaged())?;
            let after: Vec<Value> = serde_json::from_str(&after).map_err(|_| damaged())?;
            state.commit = Some(PendingCommit {
                commit_id: id16(commit_id)?,
                items: items
                    .iter()
                    .map(commit_item_from_json)
                    .collect::<Result<_, _>>()?,
                after: after
                    .iter()
                    .map(record_from_json)
                    .collect::<Result<_, _>>()?,
            });
        }

        let mut statement = tx
            .prepare(
                "SELECT id, kind, original_path, copy_path, created_ms FROM conflicts ORDER BY seq",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (id, kind, original_path, copy_path, created_ms) = row.map_err(db_error)?;
            state.conflicts.push(ConflictRecord {
                id,
                kind: if kind == 0 {
                    ConflictKind::BothEdited
                } else {
                    ConflictKind::BothCreated
                },
                original_path,
                copy_path,
                created_ms,
            });
        }
        drop(statement);

        let mut statement = tx
            .prepare("SELECT path, reason FROM unsynced ORDER BY pos")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        for row in rows {
            let (path, reason) = row.map_err(db_error)?;
            let parsed = serde_json::from_str::<Value>(&reason)
                .ok()
                .and_then(|value| reason_from_json(&value));
            if let Some(reason) = parsed {
                state.unsynced.push(UnsyncedRecord { path, reason });
            }
        }
        drop(statement);
        tx.commit().map_err(db_error)?;
        Ok(state)
    }

    fn apply(&mut self, tx: &StateTx) -> Result<(), StateError> {
        let transaction = self.conn.transaction().map_err(db_error)?;
        for op in tx {
            apply_op(&transaction, op)?;
        }
        transaction.commit().map_err(db_error)
    }

    fn lock(&mut self) -> Result<StateLock, StateError> {
        if let Some(parent) = self.lock_path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&self.lock_path)
            .map_err(io_error)?;
        match file.try_lock() {
            Ok(()) => Ok(StateLock(Box::new(file))),
            Err(fs::TryLockError::WouldBlock) => Err(StateError::Locked),
            Err(fs::TryLockError::Error(error)) => Err(io_error(error)),
        }
    }

    /// Appendix Г, Г6–Г9: `.amby/sync/bases/<item id hex>/<hash hex>`, written through a temporary
    /// file and a rename, durable before it returns.
    fn base_put(&mut self, item: &ItemId, hash: &[u8; 32], bytes: &[u8]) -> Result<(), StateError> {
        use std::io::Write;
        let target = self.base_path(item, hash);
        let folder = target
            .parent()
            .ok_or_else(|| StateError::Io("a base has no folder".to_string()))?
            .to_path_buf();
        fs::create_dir_all(&folder).map_err(io_error)?;
        let temp = folder.join(format!(".{}.part", hex::encode(hash)));
        let written = (|| {
            let mut file = fs::File::create(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &target)
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(&temp);
            return Err(io_error(error));
        }
        // The rename itself must survive a power cut too.
        if let Ok(dir) = fs::File::open(&folder) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    fn base_get(&mut self, item: &ItemId, hash: &[u8; 32]) -> Result<Option<Vec<u8>>, StateError> {
        match fs::read(self.base_path(item, hash)) {
            Ok(bytes) if &blake3_hash(&bytes) == hash => Ok(Some(bytes)),
            Ok(_) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    fn base_prune(&mut self, keep: &[(ItemId, [u8; 32])]) -> Result<(), StateError> {
        let root = self.bases_dir();
        let wanted: std::collections::BTreeSet<PathBuf> = keep
            .iter()
            .map(|(item, hash)| self.base_path(item, hash))
            .collect();
        let Ok(folders) = fs::read_dir(&root) else {
            return Ok(());
        };
        for folder in folders.flatten() {
            let folder_path = folder.path();
            if !folder_path.is_dir() {
                let _ = fs::remove_file(&folder_path);
                continue;
            }
            if let Ok(files) = fs::read_dir(&folder_path) {
                for file in files.flatten() {
                    if !wanted.contains(&file.path()) {
                        let _ = fs::remove_file(file.path());
                    }
                }
            }
            // Only an empty folder goes; a failure here is not an error.
            let _ = fs::remove_dir(&folder_path);
        }
        Ok(())
    }
}
