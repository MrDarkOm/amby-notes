//! An error freezes only the database whose container holds the faulty file.

use super::*;
use crate::index::{open_connection, sync_vault};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCOPE_A: &str = "01J0000000000000000000000A";
const SCOPE_B: &str = "01J0000000000000000000000B";

fn temp_vault(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("amby-projection-scope-{name}-{nanos}"));
    fs::create_dir_all(&root).unwrap();
    root
}

fn write_database(vault: &Path, folder: &str, database_id: &str, row_id: &str) {
    let database = vault.join(folder);
    fs::create_dir_all(&database).unwrap();
    let manifest = json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": database_id,
        "name": folder,
        "locked": false,
        "membership": {"kind": "filesystem-descendants", "recursive": true},
        "properties": [],
        "viewOrder": [],
        "defaultViewId": null,
        "templateOrder": [],
        "defaultTemplateId": null
    });
    fs::write(
        database.join("ambd.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    write_row(vault, folder, "Row", row_id);
}

fn write_row(vault: &Path, folder: &str, name: &str, note_id: &str) {
    fs::write(
        vault.join(folder).join(format!("{name}.md")),
        format!("---\namby-id: {note_id}\n---\n# {name}\n"),
    )
    .unwrap();
}

fn member_titles(conn: &Connection, database_id: &str) -> Vec<String> {
    let mut statement = conn
        .prepare(
            "SELECT n.title FROM db_members m JOIN notes n ON n.id = m.note_id \
             WHERE m.database_id = ?1 ORDER BY n.title",
        )
        .unwrap();
    statement
        .query_map([database_id], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn database_state(conn: &Connection, database_id: &str) -> String {
    conn.query_row(
        "SELECT projection_state FROM db_databases WHERE database_id = ?1",
        [database_id],
        |row| row.get(0),
    )
    .unwrap()
}

fn two_published_databases(name: &str) -> (PathBuf, Connection) {
    let vault = temp_vault(name);
    write_database(&vault, "A", SCOPE_A, "01J00000000000000000000A01");
    write_database(&vault, "B", SCOPE_B, "01J00000000000000000000B01");
    let conn = open_connection(&vault).unwrap();
    sync_vault(&conn, &vault).unwrap();
    assert!(
        rebuild_database_projection(&conn, &vault)
            .unwrap()
            .published
    );
    (vault, conn)
}

#[test]
fn unreadable_note_outside_databases_does_not_block_publishing() {
    let (vault, conn) = two_published_databases("outside");

    fs::create_dir_all(vault.join("Loose")).unwrap();
    fs::write(
        vault.join("Loose/Broken.md"),
        [0xff, 0xfe, 0x00, 0xc3, 0x28],
    )
    .unwrap();
    write_row(&vault, "A", "Created", "01J00000000000000000000A02");
    sync_vault(&conn, &vault).unwrap();
    let report = rebuild_database_projection(&conn, &vault).unwrap();

    assert!(
        report.published,
        "an error outside any database must not freeze"
    );
    assert_eq!(member_titles(&conn, SCOPE_A), ["Created", "Row"]);
    assert_eq!(database_state(&conn, SCOPE_A), HEALTHY);
    assert_eq!(database_state(&conn, SCOPE_B), HEALTHY);
    let broken: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM db_diagnostics WHERE code = 'brokenNote'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(broken, 1, "the diagnostic is still recorded");
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn duplicate_note_id_freezes_only_its_own_database() {
    let (vault, conn) = two_published_databases("duplicate");

    write_row(&vault, "B", "Twin", "01J00000000000000000000B01");
    write_row(&vault, "A", "Created", "01J00000000000000000000A02");
    sync_vault(&conn, &vault).unwrap();
    let report = rebuild_database_projection(&conn, &vault).unwrap();

    assert!(report.published, "database A still publishes");
    assert_eq!(report.state, STALE_READ_ONLY);
    assert_eq!(member_titles(&conn, SCOPE_A), ["Created", "Row"]);
    assert_eq!(database_state(&conn, SCOPE_A), HEALTHY);
    assert_eq!(
        member_titles(&conn, SCOPE_B),
        ["Row"],
        "the frozen database keeps its last good rows"
    );
    assert_eq!(database_state(&conn, SCOPE_B), STALE_READ_ONLY);
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn error_inside_a_database_still_freezes_that_database() {
    let (vault, conn) = two_published_databases("inside");

    write_row(&vault, "A", "Twin", "01J00000000000000000000A01");
    write_row(&vault, "A", "Created", "01J00000000000000000000A02");
    write_row(&vault, "B", "Added", "01J00000000000000000000B02");
    sync_vault(&conn, &vault).unwrap();
    let report = rebuild_database_projection(&conn, &vault).unwrap();
    assert!(report.published, "database B is still rebuilt");
    assert_eq!(member_titles(&conn, SCOPE_A), ["Row"]);
    assert_eq!(database_state(&conn, SCOPE_A), STALE_READ_ONLY);
    assert_eq!(member_titles(&conn, SCOPE_B), ["Added", "Row"]);
    assert_eq!(database_state(&conn, SCOPE_B), HEALTHY);

    // With only the faulty database left, nothing is published at all.
    fs::remove_dir_all(vault.join("B")).unwrap();
    sync_vault(&conn, &vault).unwrap();
    let report = rebuild_database_projection(&conn, &vault).unwrap();
    assert!(!report.published);
    assert_eq!(member_titles(&conn, SCOPE_A), ["Row"]);
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}
