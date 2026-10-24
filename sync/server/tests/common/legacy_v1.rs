//! A database of schema version 1, built by hand: the shape the first release wrote. The SQL is a
//! frozen copy of `SCHEMA_V1` of `src/db.rs` (never regenerate it from the server: the test must
//! not follow the code it checks). Shared by `migration.rs` and the conformance suite.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

pub const V1_SCHEMA: &str = "
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

/// What `build` put in: ids to look for afterwards.
pub struct Legacy {
    pub dir: PathBuf,
    pub db: PathBuf,
    /// A user without a password (a waiting `user add`), who owns the space below.
    pub username: String,
    pub space_id: [u8; 16],
    /// Sizes of the two bodies of the one item: version 1 (replaced) and version 2 (latest).
    pub old_body: (Vec<u8>, u64),
    pub latest_body: (Vec<u8>, u64),
}

/// Makes `dir/amby-sync.db` at version 1 with one user, one space, two versions of one item
/// (the first replaced) and their bodies, a second user with nothing, and the two identity rows
/// of `meta`. The body files are written too.
pub fn build(dir: &Path) -> Legacy {
    std::fs::create_dir_all(dir).unwrap();
    let db = dir.join("amby-sync.db");
    let conn = Connection::open(&db).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute_batch(V1_SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('instance_id', ?1), ('prelogin_secret', ?2)",
        params![vec![7u8; 16], vec![9u8; 32]],
    )
    .unwrap();
    let username = "legacy".to_string();
    conn.execute(
        "INSERT INTO users (id, username, created_ms) VALUES (1, 'legacy', 1700000000000), (2, 'other', 1700000001000)",
        [],
    )
    .unwrap();
    let space_id = [0x51u8; 16];
    conn.execute(
        "INSERT INTO spaces (id, space_id, user_id, name_enc, key_epoch, wrapped_vk, seq, purged_seq, created_ms) \
         VALUES (1, ?1, 1, ?2, 1, ?3, 2, 0, 1700000002000)",
        params![space_id.as_slice(), vec![3u8; 64], vec![4u8; 72]],
    )
    .unwrap();
    let (old_blob, latest_blob) = ([0xa1u8; 16], [0xa2u8; 16]);
    for (blob, size) in [(old_blob, 3000i64), (latest_blob, 4000)] {
        conn.execute(
            "INSERT INTO blobs (space, blob_id, size, complete, created_ms, activity_ms) VALUES (1, ?1, ?2, 1, 1700000003000, 1700000003000)",
            params![blob.as_slice(), size],
        )
        .unwrap();
    }
    let item = [0xb1u8; 16];
    conn.execute(
        "INSERT INTO versions (space, item_id, version, seq, ord, header, blob_id, deleted, device_id, committed_ms, superseded_ms) \
         VALUES (1, ?1, 1, 1, 0, ?2, ?3, 0, ?4, 1700000004000, 1700000005000)",
        params![item.as_slice(), vec![5u8; 301], old_blob.as_slice(), vec![6u8; 16]],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO versions (space, item_id, version, seq, ord, header, blob_id, deleted, device_id, committed_ms, superseded_ms) \
         VALUES (1, ?1, 2, 2, 0, ?2, ?3, 0, ?4, 1700000005000, NULL)",
        params![item.as_slice(), vec![5u8; 302], latest_blob.as_slice(), vec![6u8; 16]],
    )
    .unwrap();
    drop(conn);
    // The bodies as the file store lays them out: blobs/<space>/<first byte>/<blob>/body.
    for (blob, size) in [(old_blob, 3000usize), (latest_blob, 4000)] {
        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let folder = dir
            .join("blobs")
            .join(hex(&space_id))
            .join(&hex(&blob)[..2])
            .join(hex(&blob));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("body"), vec![blob[0]; size]).unwrap();
    }
    Legacy {
        dir: dir.to_path_buf(),
        db,
        username,
        space_id,
        old_body: (old_blob.to_vec(), 3000),
        latest_body: (latest_blob.to_vec(), 4000),
    }
}

/// Every row of every table (except `sqlite_*`) as text, sorted: the content to compare before
/// and after a migration. Only the columns of version 1 are read.
pub fn dump(db: &Path) -> Vec<String> {
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut lines = Vec::new();
    let v1_columns = |table: &str| -> Vec<String> {
        let mut statement = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let columns: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .filter(|name| {
                let added_in_v2 = (table == "users" && name == "plan")
                    || (table == "versions" && name == "keep_until_ms");
                !added_in_v2
            })
            .collect();
        columns
    };
    for table in [
        "meta",
        "users",
        "devices",
        "revoked_tokens",
        "spaces",
        "blobs",
        "versions",
        "commits",
        "login_failures",
    ] {
        let columns = v1_columns(table);
        let select = columns
            .iter()
            .map(|c| format!("quote({c})"))
            .collect::<Vec<_>>()
            .join(" || '|' || ");
        let mut statement = conn
            .prepare(&format!("SELECT {select} FROM {table}"))
            .unwrap();
        let rows: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for row in rows {
            lines.push(format!("{table}: {row}"));
        }
    }
    lines.sort();
    lines
}

pub fn user_version(db: &Path) -> i64 {
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

pub fn has_column(db: &Path, table: &str, column: &str) -> bool {
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    let names: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    names.iter().any(|name| name == column)
}

/// The files in `dir/backups/`, by name.
pub fn backups(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir.join("backups"))
        .map(|entries| entries.map(|e| e.unwrap().path()).collect())
        .unwrap_or_default();
    found.sort();
    found
}
