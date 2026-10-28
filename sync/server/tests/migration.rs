//! The migration of the database from version 1 to 2 (appendix Е, П58): a copy first, one
//! transaction, a record of the result. The version-1 file is built by hand
//! (`common/legacy_v1.rs`), so the test does not depend on what the new code would write.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::sync::Arc;

use amby_sync_server::{AppState, Config, ManualClock};
use common::legacy_v1::{backups, build, dump, has_column, user_version};
use rusqlite::Connection;

const START_MS: i64 = 1_792_497_600_000;

fn open(dir: &std::path::Path) -> Result<AppState, amby_sync_server::DbError> {
    AppState::try_open(
        Config {
            data_dir: dir.to_path_buf(),
            ..Config::default()
        },
        Arc::new(ManualClock::new(START_MS)),
    )
}

fn meta(db: &std::path::Path, key: &str) -> Option<Vec<u8>> {
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .ok()
}

#[test]
fn a_version_1_database_becomes_version_2_with_the_new_columns() {
    // П58: ALTER … ADD COLUMN users.plan, versions.keep_until_ms, the index; user_version 2.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build(dir.path());
    drop(open(dir.path()).expect("a version-1 database must be migrated, not refused"));
    assert_eq!(user_version(&legacy.db), 2);
    assert!(has_column(&legacy.db, "users", "plan"));
    assert!(has_column(&legacy.db, "versions", "keep_until_ms"));
    let conn = Connection::open(&legacy.db).unwrap();
    let index: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'versions_keep'",
            [],
            |row| row.get(0),
        )
        .ok();
    assert_eq!(index.as_deref(), Some("versions_keep"));
}

#[test]
fn the_migration_does_not_rewrite_any_existing_data() {
    // П58: users, spaces, blobs, versions — byte for byte the same; `plan` and `keep_until_ms`
    // are empty everywhere (the old rule applies to old rows, "by default" to old users).
    let dir = tempfile::tempdir().unwrap();
    let legacy = build(dir.path());
    let before = dump(&legacy.db);
    assert!(before.len() >= 8, "the fixture has data: {before:?}");
    drop(open(dir.path()).expect("must migrate"));
    let after: Vec<String> = dump(&legacy.db)
        .into_iter()
        .filter(|line| !line.starts_with("meta: 'last_migration'"))
        .collect();
    let before: Vec<String> = before
        .into_iter()
        .filter(|line| !line.starts_with("meta: 'last_migration'"))
        .collect();
    assert_eq!(after, before);
    let conn = Connection::open(&legacy.db).unwrap();
    let plans: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM users WHERE plan IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("the column `users.plan` must exist");
    let keeps: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM versions WHERE keep_until_ms IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("the column `versions.keep_until_ms` must exist");
    assert_eq!((plans, keeps), (0, 0));
    let bodies = legacy.dir.join("blobs");
    assert!(bodies.exists(), "the body files stay");
}

#[test]
fn a_copy_is_made_before_the_migration_and_it_opens_as_version_1() {
    // П58: `VACUUM INTO backups/pre-v2-<ms>.db`, checked with quick_check, before the change.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build(dir.path());
    let before = dump(&legacy.db);
    drop(open(dir.path()).expect("must migrate"));
    let copies = backups(dir.path());
    assert_eq!(copies.len(), 1, "one copy: {copies:?}");
    let name = copies[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        name.starts_with("pre-v2-") && name.ends_with(".db"),
        "pre-v<N>-<ms>.db with N the new version: {name}"
    );
    assert_eq!(user_version(&copies[0]), 1, "the copy is the old version");
    let conn = Connection::open(&copies[0]).unwrap();
    let verdict: String = conn
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .unwrap();
    assert_eq!(verdict, "ok");
    drop(conn);
    assert_eq!(
        dump(&copies[0]),
        before,
        "the copy holds all the data of the moment before"
    );
}

#[test]
fn the_result_is_recorded_in_meta_so_that_a_person_can_find_the_copy() {
    // П58: `last_migration` — from which version, to which, when, the name of the copy.
    // The format is not fixed by the plan; the tests ask for a JSON object with these fields.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build(dir.path());
    drop(open(dir.path()).expect("must migrate"));
    let raw = meta(&legacy.db, "last_migration").expect("`meta.last_migration` must be written");
    let record: serde_json::Value = serde_json::from_slice(&raw).expect("a JSON object");
    assert_eq!(record["from"], 1);
    assert_eq!(record["to"], 2);
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
    // П58: the record tells that the migration is done.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build(dir.path());
    drop(open(dir.path()).expect("must migrate"));
    let record = meta(&legacy.db, "last_migration").expect("written");
    let copies = backups(dir.path());
    drop(open(dir.path()).expect("the second start"));
    assert_eq!(backups(dir.path()), copies);
    assert_eq!(meta(&legacy.db, "last_migration").unwrap(), record);
    assert_eq!(user_version(&legacy.db), 2);
}

#[test]
fn a_failure_in_the_middle_leaves_version_1_untouched_and_the_copy_in_place() {
    // П58: one transaction with `user_version`. Here the second ALTER fails (the column is
    // already there): the first ALTER must not stay, the version must stay 1.
    let dir = tempfile::tempdir().unwrap();
    let legacy = build(dir.path());
    Connection::open(&legacy.db)
        .unwrap()
        .execute_batch("ALTER TABLE versions ADD COLUMN keep_until_ms INTEGER;")
        .unwrap();
    let before = dump(&legacy.db);
    assert!(
        open(dir.path()).is_err(),
        "a migration that cannot finish is an error"
    );
    assert_eq!(user_version(&legacy.db), 1);
    assert!(
        !has_column(&legacy.db, "users", "plan"),
        "the first step of the failed migration must be rolled back"
    );
    assert_eq!(dump(&legacy.db), before);
    assert_eq!(backups(dir.path()).len(), 1, "the copy stays");
    assert_eq!(
        meta(&legacy.db, "last_migration"),
        None,
        "no record of a migration that did not happen"
    );
}

#[test]
fn a_fresh_database_is_made_at_version_2_without_a_copy() {
    // П58: there is nothing to copy when there was no database.
    let dir = tempfile::tempdir().unwrap();
    drop(open(dir.path()).expect("a fresh data directory"));
    let db = dir.path().join("amby-sync.db");
    assert_eq!(user_version(&db), 2);
    assert!(has_column(&db, "users", "plan"));
    assert!(has_column(&db, "versions", "keep_until_ms"));
    assert!(backups(dir.path()).is_empty());
}

#[test]
fn a_damaged_version_1_database_is_not_migrated_and_not_copied_over() {
    // П58, Р11: "проверка до": the check before the change refuses a broken file; nothing is
    // changed. (The file is a v1 database with a corrupted page header after the schema.)
    let dir = tempfile::tempdir().unwrap();
    let legacy = build(dir.path());
    let mut bytes = std::fs::read(&legacy.db).unwrap();
    let before_len = bytes.len();
    assert!(before_len > 8192);
    // Wipe a data page in the middle: the schema stays readable, the content does not.
    for byte in &mut bytes[4096 * 2..4096 * 3] {
        *byte = 0xff;
    }
    std::fs::write(&legacy.db, &bytes).unwrap();
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.path().join(format!("amby-sync.db{ext}")));
    }
    let detectable = Connection::open(&legacy.db)
        .and_then(|conn| {
            conn.pragma_query_value(None, "quick_check", |row| row.get::<_, String>(0))
        })
        .map_or(true, |verdict| verdict != "ok");
    assert!(
        detectable,
        "fixture check: the damage must show in quick_check"
    );
    let bytes = std::fs::read(&legacy.db).unwrap();
    assert!(open(dir.path()).is_err());
    assert_eq!(
        std::fs::read(&legacy.db).unwrap(),
        bytes,
        "the file is left as it was"
    );
    assert!(
        backups(dir.path()).is_empty(),
        "no copy of a broken file is passed off as a backup"
    );
}
