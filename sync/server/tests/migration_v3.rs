//! The migration of the database from version 2 to 3 (appendix Н, Н7; rules of П58): a copy first,
//! one transaction, a record of the result, `users.plan_until_ms`. The version-2 file is built by
//! hand from the frozen SQL of versions 1 and 2, so the test does not follow the code it checks.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::path::Path;
use std::sync::Arc;

use amby_sync_server::{AppState, Config, DbError, ManualClock};
use common::legacy_v1::{backups, build, has_column, user_version, Legacy};
use rusqlite::Connection;

const START_MS: i64 = 1_792_497_600_000;
const TABLES: [&str; 9] = [
    "meta",
    "users",
    "devices",
    "revoked_tokens",
    "spaces",
    "blobs",
    "versions",
    "commits",
    "login_failures",
];

/// Frozen copy of `SCHEMA_V2`.
const V2_SCHEMA: &str = "
ALTER TABLE users ADD COLUMN plan TEXT;
ALTER TABLE versions ADD COLUMN keep_until_ms INTEGER;
CREATE INDEX versions_keep ON versions(keep_until_ms) WHERE keep_until_ms IS NOT NULL;
";

/// A database of version 2: the v1 file of `legacy_v1` plus the changes of version 2, one user
/// pinned to a plan and one version with a `keep_until_ms`.
fn build_v2(dir: &Path) -> Legacy {
    let legacy = build(dir);
    let conn = Connection::open(&legacy.db).unwrap();
    conn.execute_batch(V2_SCHEMA).unwrap();
    conn.execute("UPDATE users SET plan = 'big' WHERE id = 1", [])
        .unwrap();
    conn.execute(
        "UPDATE versions SET keep_until_ms = 1700000009000 WHERE version = 1",
        [],
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    drop(conn);
    legacy
}

fn open(dir: &Path) -> Result<AppState, DbError> {
    AppState::try_open(
        Config {
            data_dir: dir.to_path_buf(),
            ..Config::default()
        },
        Arc::new(ManualClock::new(START_MS)),
    )
}

/// Every row of every table with every column that exists in version 2, as text, sorted. The
/// `last_migration` row of `meta` is left out: it is the record of the migration itself.
fn dump_v2(db: &Path) -> Vec<String> {
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut lines = Vec::new();
    for table in TABLES {
        let mut statement = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let columns: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .filter(|name| !(table == "users" && name == "plan_until_ms"))
            .collect();
        let select = columns
            .iter()
            .map(|column| format!("quote({column})"))
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
        lines.extend(rows.into_iter().map(|row| format!("{table}: {row}")));
    }
    lines.retain(|line| !line.starts_with("meta: 'last_migration'"));
    lines.sort();
    lines
}

fn counts(db: &Path) -> Vec<(String, i64)> {
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    TABLES
        .iter()
        .map(|table| {
            // П58, Н7: the migration itself adds the record `meta.last_migration`; the other
            // rows of `meta` and of every table stay as they were.
            let sql = if *table == "meta" {
                "SELECT COUNT(*) FROM meta WHERE key != 'last_migration'".to_string()
            } else {
                format!("SELECT COUNT(*) FROM {table}")
            };
            let n: i64 = conn.query_row(&sql, [], |row| row.get(0)).unwrap();
            (table.to_string(), n)
        })
        .collect()
}

fn meta(db: &Path, key: &str) -> Option<Vec<u8>> {
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .ok()
}

#[test]
fn a_version_2_database_becomes_version_3_with_the_new_column() {
    // Н7: `ALTER TABLE users ADD COLUMN plan_until_ms INTEGER`; user_version 3.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build_v2(dir.path());
    assert!(!has_column(&legacy.db, "users", "plan_until_ms"));
    drop(open(dir.path()).expect("a version-2 database must be migrated, not refused"));
    assert_eq!(user_version(&legacy.db), 3);
    assert!(has_column(&legacy.db, "users", "plan_until_ms"));
}

#[test]
fn old_users_get_an_empty_end_and_keep_every_old_row_and_column() {
    // Н7: only the one ALTER; no row is rewritten. The pin of the old user stays, its end is NULL
    // (no end: pinned for good, Н2), the counts of all the tables are the same.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build_v2(dir.path());
    let before = dump_v2(&legacy.db);
    let before_counts = counts(&legacy.db);
    assert!(before.len() >= 8, "the fixture has data: {before:?}");
    drop(open(dir.path()).expect("must migrate"));
    assert_eq!(
        dump_v2(&legacy.db),
        before,
        "every old column of every old row"
    );
    assert_eq!(
        counts(&legacy.db),
        before_counts,
        "the counts of all the tables"
    );
    let conn = Connection::open(&legacy.db).unwrap();
    let with_end: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM users WHERE plan_until_ms IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("the column `users.plan_until_ms` must exist");
    assert_eq!(with_end, 0, "no old user has an end");
    let plan: Option<String> = conn
        .query_row("SELECT plan FROM users WHERE id = 1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(plan.as_deref(), Some("big"), "the old pin is untouched");
    assert!(legacy.dir.join("blobs").exists(), "the body files stay");
}

#[test]
fn a_copy_is_made_before_the_migration_and_it_opens_as_version_2() {
    // Н7, П58: `VACUUM INTO backups/pre-v3-<ms>.db`, checked with quick_check, before the change.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build_v2(dir.path());
    let before = dump_v2(&legacy.db);
    drop(open(dir.path()).expect("must migrate"));
    let copies = backups(dir.path());
    assert_eq!(copies.len(), 1, "one copy: {copies:?}");
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        name.starts_with("pre-v3-") && name.ends_with(".db"),
        "pre-v<N>-<ms>.db with N the new version: {name}"
    );
    assert_eq!(user_version(&copies[0]), 2, "the copy is the old version");
    assert!(
        !has_column(&copies[0], "users", "plan_until_ms"),
        "the copy was made before the change"
    );
    let conn = Connection::open(&copies[0]).unwrap();
    let verdict: String = conn
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .unwrap();
    assert_eq!(verdict, "ok");
    drop(conn);
    assert_eq!(dump_v2(&copies[0]), before, "the copy holds all the data");
}

#[test]
fn the_result_is_recorded_in_meta_last_migration() {
    // Н7, П58: from 2, to 3, when, the name of the copy.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build_v2(dir.path());
    drop(open(dir.path()).expect("must migrate"));
    let raw = meta(&legacy.db, "last_migration").expect("`meta.last_migration` must be written");
    let record: serde_json::Value = serde_json::from_slice(&raw).expect("a JSON object");
    assert_eq!(record["from"], 2);
    assert_eq!(record["to"], 3);
    assert!(record["at_ms"].as_i64().unwrap() >= START_MS);
    let copy = backups(dir.path())[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(record["backup"], copy.as_str());
}

#[test]
fn starting_again_does_not_migrate_or_copy_again() {
    // Н7, П58.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build_v2(dir.path());
    drop(open(dir.path()).expect("must migrate"));
    let record = meta(&legacy.db, "last_migration").expect("written");
    let copies = backups(dir.path());
    drop(open(dir.path()).expect("the second start"));
    assert_eq!(backups(dir.path()), copies);
    assert_eq!(meta(&legacy.db, "last_migration").unwrap(), record);
    assert_eq!(user_version(&legacy.db), 3);
}

#[test]
fn a_failure_in_the_migration_leaves_version_2_untouched_and_the_copy_in_place() {
    // Н7, П58: one transaction. The column is already there, so the ALTER fails: the version
    // stays 2, no record of a migration that did not happen, the copy stays.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build_v2(dir.path());
    Connection::open(&legacy.db)
        .unwrap()
        .execute_batch("ALTER TABLE users ADD COLUMN plan_until_ms INTEGER;")
        .unwrap();
    let before = dump_v2(&legacy.db);
    assert!(
        open(dir.path()).is_err(),
        "a migration that cannot finish is an error"
    );
    assert_eq!(user_version(&legacy.db), 2);
    assert_eq!(dump_v2(&legacy.db), before);
    assert_eq!(backups(dir.path()).len(), 1, "the copy stays");
    assert_eq!(meta(&legacy.db, "last_migration"), None);
}

#[test]
fn a_fresh_database_is_made_at_version_3_without_a_copy() {
    // Н7: nothing to copy when there was no database.
    let dir = tempfile::tempdir().unwrap();
    drop(open(dir.path()).expect("a fresh data directory"));
    let db = dir.path().join("amby-sync.db");
    assert_eq!(user_version(&db), 3);
    assert!(has_column(&db, "users", "plan"));
    assert!(has_column(&db, "users", "plan_until_ms"));
    assert!(has_column(&db, "versions", "keep_until_ms"));
    assert!(backups(dir.path()).is_empty());
}

#[test]
fn a_database_of_version_4_is_refused_as_too_new_and_left_alone() {
    // Н7, П58: the old image will not start on version 3 and this one will not start on 4;
    // the rollback is the copy `pre-v3-*`. Nothing is written to a file of a newer server.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build_v2(dir.path());
    let conn = Connection::open(&legacy.db).unwrap();
    conn.execute_batch("ALTER TABLE users ADD COLUMN plan_until_ms INTEGER;")
        .unwrap();
    conn.pragma_update(None, "user_version", 4).unwrap();
    drop(conn);
    let before = dump_v2(&legacy.db);
    match open(dir.path()) {
        Err(DbError::TooNew { found, known }) => {
            assert_eq!((found, known), (4, 3));
        }
        Err(other) => panic!("expected TooNew, got {other:?}"),
        Ok(_) => panic!("a database of a newer server must be refused"),
    }
    assert_eq!(user_version(&legacy.db), 4);
    assert_eq!(dump_v2(&legacy.db), before);
    assert!(backups(dir.path()).is_empty());
}
