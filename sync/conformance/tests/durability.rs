//! Backups and the server's own database (Р11, Р13, С7, П10, П38). In-process servers only.
//!
//! Written by the reviewer after the mutation check of Э2, not by the author of the server:
//! `backup` and the refusal of an unreadable or newer database had no test.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;

use amby_sync_conformance::client::{enroll, info, login, new_item, Space, PASSWORD};
use amby_sync_conformance::inprocess::{InProcess, START_MS};
use amby_sync_conformance::{in_process_or_skip, Target};
use amby_sync_server::{AppState, Config, ManualClock};

#[test]
fn a_backup_restores_into_a_working_server_that_shows_its_older_state() {
    // Р11, П38, П10, С7: the copy holds accounts, keys, spaces, versions and bodies. A server
    // started on it has the same instance_id and the head of the moment of the copy, so a device
    // that saw later commits notices the step back (a head below its cursor) and stops (Р8).
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "Notes/a.md", b"in the backup")]);
    let copy = tempfile::tempdir().unwrap();
    let dir = copy.path().join("backup");
    control.backup(&dir);
    space.commit_ok(&[space.file(&item, 1, "Notes/a.md", b"after the backup")]);
    let instance = info(&target.api)["instance_id"].clone();

    let restored = Target::from_process(InProcess::start_in(
        dir,
        None,
        Arc::new(ManualClock::new(START_MS)),
        |_| {},
    ));
    assert_eq!(info(&restored.api)["instance_id"], instance);
    let signed_in = login(
        &restored.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "restored",
    )
    .expect(200)
    .json();
    let there = Space {
        api: restored.api.clone(),
        token: signed_in["token"].as_str().unwrap().to_string(),
        id: space.id,
        vk: space.vk.clone(),
    };
    let changes = there.all_changes(0);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["version"], 1);
    assert_eq!(there.fetch_file(&changes[0]), b"in the backup");
    assert_eq!(there.changes(0, None).expect(200).json()["seq"], 1);
}

/// A data directory with the database of a fresh server, closed again, and the path of that file.
fn fresh_database() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    drop(
        AppState::try_open(config(&dir), Arc::new(ManualClock::new(START_MS)))
            .expect("a fresh server must open"),
    );
    let db = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "db"))
        .expect("the server keeps its data in one SQLite file");
    (dir, db)
}

fn config(dir: &tempfile::TempDir) -> Config {
    Config {
        data_dir: dir.path().to_path_buf(),
        ..Config::default()
    }
}

#[test]
fn an_unreadable_database_is_refused_and_left_as_it_is() {
    // Р11, О4, С7: a damaged database must never be taken for a new, empty server: that would hand
    // out a new instance_id and lose every account. The server refuses to start and leaves the
    // file alone, so it can be repaired or restored from a backup.
    let (dir, db) = fresh_database();
    let garbage = b"not a SQLite database, but somebody's data ".repeat(200);
    std::fs::write(&db, &garbage).unwrap();
    assert!(AppState::try_open(config(&dir), Arc::new(ManualClock::new(START_MS))).is_err());
    assert_eq!(std::fs::read(&db).unwrap(), garbage);
}

#[test]
fn a_database_of_a_newer_server_is_refused_and_left_as_it_is() {
    // Р13, Р11: an older server neither runs nor migrates a database it does not understand.
    let (dir, db) = fresh_database();
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        let current: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        conn.pragma_update(None, "user_version", current + 1)
            .unwrap();
    }
    let before = std::fs::read(&db).unwrap();
    assert!(AppState::try_open(config(&dir), Arc::new(ManualClock::new(START_MS))).is_err());
    assert_eq!(std::fs::read(&db).unwrap(), before);
}

// ----- the migration to schema version 2 seen from a running server (appendix Е, П58) -----

#[path = "../../server/tests/common/legacy_v1.rs"]
mod legacy_v1;

#[test]
fn a_migrated_version_1_database_serves_its_old_data_and_has_no_limits_but_the_ceilings() {
    // П58: "a server without a plans file after the update is not different by one byte of
    // behaviour". The old rows are served, the quota counts them by the new rule (the replaced
    // version is history), the cleanup treats the old replaced version by the old rule, and the
    // account says "no plan".
    let dir = tempfile::tempdir().unwrap();
    let legacy = legacy_v1::build(dir.path());
    let server = InProcess::start_in(
        dir.path().to_path_buf(),
        None,
        Arc::new(ManualClock::new(START_MS)),
        |_| {},
    );
    let target = Target::from_process(server);
    let control = target.control().unwrap();
    assert_eq!(
        legacy_v1::user_version(&legacy.db),
        2,
        "the server migrated the file on start"
    );
    // the user who was waiting for a code gets one, and sees the space of before the update
    let ticket = target
        .try_user_add(&legacy.username)
        .expect("a waiting user can get a code");
    let account = amby_sync_conformance::client::enroll_with(
        &target,
        &ticket.username,
        &ticket.enroll_code,
        PASSWORD,
    );
    let spaces = account.get("/v1/spaces").expect(200).json();
    assert_eq!(spaces["spaces"].as_array().unwrap().len(), 1);
    assert_eq!(
        spaces["spaces"][0]["space_id"],
        legacy
            .space_id
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            .as_str()
    );
    let overview = account.overview();
    assert_eq!(overview["plan"]["name"], serde_json::Value::Null);
    assert_eq!(overview["usage"]["live_bytes"], 4000);
    assert_eq!(overview["usage"]["history_bytes"], 3000);
    // the old replaced version has no term of its own: it is old (2023), so the old rule removes it
    control.run_maintenance();
    let after = account.overview();
    assert_eq!(after["usage"]["history_bytes"], 0);
    assert_eq!(after["usage"]["live_bytes"], 4000);
}

#[test]
fn a_new_server_on_a_migrated_database_makes_ordinary_new_accounts() {
    // П58: after the update an ordinary new user works as before, in the same file.
    let dir = tempfile::tempdir().unwrap();
    legacy_v1::build(dir.path());
    let target = Target::from_process(InProcess::start_in(
        dir.path().to_path_buf(),
        None,
        Arc::new(ManualClock::new(START_MS)),
        |_| {},
    ));
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"after the update")]);
    assert_eq!(space.all_changes(0).len(), 1);
    assert_eq!(account.overview()["usage"]["spaces"], 1);
    assert_eq!(
        legacy_v1::backups(dir.path()).len(),
        1,
        "one copy was made before the migration"
    );
}
