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

// ---- Scoped rebuild (DB-02): a change in one database must not rebuild unrelated ones. ----

fn id(suffix: &str) -> String {
    format!("01J{suffix:0>23}")
}

fn write_manifest(vault: &Path, folder: &str, database_id: &str, properties: serde_json::Value) {
    let database = vault.join(folder);
    fs::create_dir_all(database.join(".ambd/records")).unwrap();
    let manifest = json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": database_id,
        "name": folder,
        "locked": false,
        "membership": {"kind": "filesystem-descendants", "recursive": true},
        "properties": properties,
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
}

fn number_property(property_id: &str, name: &str) -> serde_json::Value {
    json!({
        "id": property_id, "name": name, "type": "number",
        "pageVisibility": "alwaysShow", "yamlBinding": null,
        "config": {"format": "number", "currency": null}
    })
}

fn write_record(
    vault: &Path,
    folder: &str,
    database_id: &str,
    note_id: &str,
    values: serde_json::Value,
) {
    fs::write(
        vault
            .join(folder)
            .join(format!(".ambd/records/{note_id}.json")),
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record", "formatVersion": 1,
            "databaseId": database_id, "noteId": note_id, "values": values
        }))
        .unwrap(),
    )
    .unwrap();
}

fn set_hours(vault: &Path, hours: &str) {
    write_record(
        vault,
        "Tasks",
        &id("T"),
        &id("T1"),
        json!({ id("TH"): {"type": "number", "decimal": hours} }),
    );
}

/// Projects (relation + rollup over Tasks.hours), Tasks, and an unrelated Other.
fn linked_vault(name: &str) -> (PathBuf, Connection) {
    let vault = temp_vault(name);
    write_manifest(
        &vault,
        "Tasks",
        &id("T"),
        json!([number_property(&id("TH"), "Hours")]),
    );
    write_row(&vault, "Tasks", "Task", &id("T1"));
    set_hours(&vault, "5");
    write_manifest(
        &vault,
        "Projects",
        &id("P"),
        json!([
            {
                "id": id("PR"), "name": "Tasks", "type": "relation",
                "pageVisibility": "alwaysShow", "yamlBinding": null,
                "config": {"targetDatabaseId": id("T"), "maxItems": null, "inversePropertyId": null}
            },
            {
                "id": id("PS"), "name": "Total", "type": "rollup",
                "pageVisibility": "alwaysShow", "yamlBinding": null,
                "config": {"relationPropertyId": id("PR"), "targetPropertyId": id("TH"), "aggregation": "sum"}
            }
        ]),
    );
    write_row(&vault, "Projects", "Project", &id("P1"));
    write_record(
        &vault,
        "Projects",
        &id("P"),
        &id("P1"),
        json!({ id("PR"): {"type": "relation", "targetNoteIds": [id("T1")]} }),
    );
    write_manifest(
        &vault,
        "Other",
        &id("Q"),
        json!([number_property(&id("QH"), "Count")]),
    );
    write_row(&vault, "Other", "Item", &id("Q1"));
    let conn = open_connection(&vault).unwrap();
    sync_vault(&conn, &vault).unwrap();
    assert!(
        rebuild_database_projection(&conn, &vault)
            .unwrap()
            .published
    );
    (vault, conn)
}

fn mark(conn: &Connection, database_id: &str) {
    conn.execute(
        "UPDATE db_databases SET name = 'SENTINEL' WHERE database_id = ?1",
        [database_id],
    )
    .unwrap();
}

fn database_name(conn: &Connection, database_id: &str) -> String {
    conn.query_row(
        "SELECT name FROM db_databases WHERE database_id = ?1",
        [database_id],
        |row| row.get(0),
    )
    .unwrap()
}

fn rollup_total(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = ?3",
        params![id("P"), id("P1"), id("PS")],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn version(conn: &Connection) -> (String, String) {
    (
        metadata_value(conn, "database_projection_epoch")
            .unwrap()
            .unwrap(),
        metadata_value(conn, "database_projection_seq")
            .unwrap()
            .unwrap(),
    )
}

/// The projection tables in a form that does not depend on row ids or timestamps.
fn dump(conn: &Connection) -> Vec<String> {
    let queries = [
        "SELECT 'db', database_id || '|' || name || '|' || container_path || '|' || projection_state || '|' || manifest_revision FROM db_databases",
        "SELECT 'prop', database_id || '|' || property_id || '|' || position || '|' || name || '|' || property_type || '|' || config_json FROM db_properties",
        "SELECT 'member', database_id || '|' || note_id FROM db_members",
        "SELECT 'rev', database_id || '|' || note_id || '|' || revision FROM db_record_revisions",
        "SELECT 'value', database_id || '|' || note_id || '|' || property_id || '|' || value_type || '|' || canonical_json || '|' || IFNULL(decimal_value, '') FROM db_values",
        "SELECT 'edge', source_note_id || '|' || target_note_id || '|' || target_state FROM db_relation_edges",
        "SELECT 'diag', scope_kind || '|' || scope_key || '|' || code FROM db_diagnostics",
    ];
    let mut lines = Vec::new();
    for query in queries {
        let mut statement = conn.prepare(query).unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok(format!(
                    "{}:{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        lines.extend(rows);
    }
    lines.sort();
    lines
}

#[test]
fn scoped_rebuild_after_new_row_leaves_unrelated_databases_untouched() {
    let (vault, conn) = linked_vault("scoped-row");
    mark(&conn, &id("Q"));
    let (epoch, seq) = version(&conn);

    write_row(&vault, "Tasks", "Second", &id("T2"));
    sync_vault(&conn, &vault).unwrap();
    let report = rebuild_database_projection_scoped(&conn, &vault, &[&id("T")]).unwrap();

    assert!(report.published);
    assert_eq!(member_titles(&conn, &id("T")), ["Second", "Task"]);
    assert_eq!(
        database_name(&conn, &id("Q")),
        "SENTINEL",
        "an unrelated database must not be rebuilt"
    );
    let (new_epoch, new_seq) = version(&conn);
    assert_eq!(new_epoch, epoch);
    assert_eq!(
        new_seq.parse::<u64>().unwrap(),
        seq.parse::<u64>().unwrap() + 1
    );
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn scoped_rebuild_after_new_property_leaves_unrelated_databases_untouched() {
    let (vault, conn) = linked_vault("scoped-property");
    mark(&conn, &id("P"));

    write_manifest(
        &vault,
        "Other",
        &id("Q"),
        json!([
            number_property(&id("QH"), "Count"),
            number_property(&id("QJ"), "Extra")
        ]),
    );
    rebuild_database_projection_scoped(&conn, &vault, &[&id("Q")]).unwrap();
    let properties: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM db_properties WHERE database_id = ?1",
            [id("Q")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(properties, 2);
    assert_eq!(
        database_name(&conn, &id("P")),
        "SENTINEL",
        "a database with no relation to the changed one must not be rebuilt"
    );
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn scoped_rebuild_also_rebuilds_databases_that_depend_through_relations() {
    let (vault, conn) = linked_vault("scoped-linked");
    assert_eq!(rollup_total(&conn).as_deref(), Some("5"));
    mark(&conn, &id("P"));
    mark(&conn, &id("Q"));

    set_hours(&vault, "8");
    rebuild_database_projection_scoped(&conn, &vault, &[&id("T")]).unwrap();

    assert_eq!(
        rollup_total(&conn).as_deref(),
        Some("8"),
        "the rollup in Projects follows Tasks"
    );
    assert_eq!(database_name(&conn, &id("P")), "Projects");
    assert_eq!(database_name(&conn, &id("Q")), "SENTINEL");
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn scoped_rebuild_equals_full_rebuild() {
    let (vault, conn) = linked_vault("scoped-equal");
    set_hours(&vault, "8");
    write_row(&vault, "Tasks", "Second", &id("T2"));
    write_manifest(
        &vault,
        "Tasks",
        &id("T"),
        json!([
            number_property(&id("TH"), "Hours"),
            number_property(&id("TJ"), "Extra")
        ]),
    );
    sync_vault(&conn, &vault).unwrap();

    rebuild_database_projection_scoped(&conn, &vault, &[&id("T")]).unwrap();
    let scoped = dump(&conn);
    rebuild_database_projection(&conn, &vault).unwrap();
    assert_eq!(scoped, dump(&conn));
    assert!(scoped
        .iter()
        .any(|line| line.starts_with("value:") && line.contains("|8")));
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn scoped_rebuild_falls_back_to_full_when_another_database_is_out_of_date() {
    let (vault, conn) = linked_vault("scoped-fallback");
    write_row(&vault, "Tasks", "Second", &id("T2"));
    write_row(&vault, "Other", "Late", &id("Q2"));
    sync_vault(&conn, &vault).unwrap();

    rebuild_database_projection_scoped(&conn, &vault, &[&id("T")]).unwrap();

    assert_eq!(member_titles(&conn, &id("Q")), ["Item", "Late"]);
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}
