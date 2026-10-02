use super::*;
use crate::database::model::{
    DatabaseFieldRef, DatabasePageRequest, DatabaseQueryRequest, DatabaseQuerySource,
    DatabaseQuerySpec, DatabaseSortSpec,
};
use crate::database::query::query_database;
use crate::index::{open_connection, sync_vault};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_vault(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("amby-projection-{name}-{nanos}"));
    fs::create_dir_all(&root).unwrap();
    root
}

fn manifest(id: &str, view_id: Option<&str>) -> Value {
    json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": id,
        "name": "Database",
        "locked": false,
        "membership": {"kind": "filesystem-descendants", "recursive": true},
        "properties": [{
            "id": "01J00000000000000000000004",
            "name": "Count",
            "type": "number",
            "pageVisibility": "alwaysShow",
            "yamlBinding": null,
            "config": {"format": "number", "currency": null}
        }],
        "viewOrder": view_id.into_iter().collect::<Vec<_>>(),
        "defaultViewId": view_id,
        "templateOrder": [],
        "defaultTemplateId": null
    })
}

#[test]
fn exact_decimal_keys_order_negative_prefixes_and_normalize_equal_values() {
    let ordered = [
        "-90071992547409931234567890.125",
        "-90071992547409931234567890.12",
        "-100",
        "-10.01",
        "-10",
        "-1.23",
        "-1.2",
        "-1.001",
        "-1",
        "-0.001",
        "0",
        "0.001",
        "1",
        "1.001",
        "1.2",
        "1.23",
        "10",
        "90071992547409931234567890.12",
        "90071992547409931234567890.125",
    ];
    for pair in ordered.windows(2) {
        assert!(
            decimal_sort_key(pair[0]).unwrap() < decimal_sort_key(pair[1]).unwrap(),
            "{} must precede {}",
            pair[0],
            pair[1]
        );
    }
    for (left, right) in [
        ("-1.200", "-1.2"),
        ("-0", "0"),
        ("1.2e3", "1200"),
        ("+001.00", "1"),
    ] {
        assert_eq!(decimal_sort_key(left), decimal_sort_key(right));
    }
}

#[test]
fn relations_resolve_against_the_declared_target_and_rebuild_without_source_changes() {
    let vault = temp_vault("relation-target");
    let source_id = "01J00000000000000000000000";
    let target_id = "01J00000000000000000000010";
    let row_id = "01J00000000000000000000001";
    let target_note_id = "01J00000000000000000000011";
    let missing_id = "01J00000000000000000000012";
    let property_id = "01J00000000000000000000004";
    let mut sources = Vec::new();
    for (name, database_id, note_id) in [
        ("Source", source_id, row_id),
        ("Target", target_id, target_note_id),
    ] {
        let container = vault.join(name);
        fs::create_dir_all(container.join(".ambd/records")).unwrap();
        let mut definition = manifest(database_id, None);
        definition["name"] = json!(name);
        definition["properties"] = if database_id == source_id {
            json!([{
                "id": property_id, "name": "Related", "type": "relation",
                "pageVisibility": "alwaysShow", "yamlBinding": null,
                "config": {"targetDatabaseId": target_id, "maxItems": null, "inversePropertyId": null}
            }])
        } else {
            json!([])
        };
        sources.push((
            container.join("ambd.json"),
            serde_json::to_vec_pretty(&definition).unwrap(),
        ));
        sources.push((
            container.join("Row.md"),
            format!("---\namby-id: {note_id}\n---\n# Row\n").into_bytes(),
        ));
    }
    sources.push((vault.join(format!("Source/.ambd/records/{row_id}.json")),
            serde_json::to_vec_pretty(&json!({
                "format": "amby-database-record", "formatVersion": 1,
                "databaseId": source_id, "noteId": row_id,
                "values": {property_id: {"type":"relation", "targetNoteIds":[target_note_id, row_id, missing_id]}}
            })).unwrap()));
    for (path, bytes) in &sources {
        fs::write(path, bytes).unwrap();
    }

    // Two independent, empty indexes must reconstruct the same links.
    for _ in 0..2 {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        sync_vault(&conn, &vault).unwrap();
        let report = rebuild_database_projection(&conn, &vault).unwrap();
        assert_eq!(report.state, HEALTHY);
        let mut statement = conn
            .prepare("SELECT target_note_id, target_state FROM db_relation_edges ORDER BY position")
            .unwrap();
        let edges = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            edges,
            [
                (target_note_id, "resolved"),
                (row_id, "outsideDatabase"),
                (missing_id, "missing")
            ]
            .map(|(id, state)| (id.to_owned(), state.to_owned()))
        );
        update_database_values_incremental(&conn, &vault, source_id, &[row_id.to_owned()]).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM db_relation_edges", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 3);
        for (path, bytes) in &sources {
            assert_eq!(fs::read(path).unwrap(), *bytes);
        }
    }
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn rebuild_publishes_complete_projection_and_exact_decimal_columns() {
    let vault = temp_vault("publish");
    let database = vault.join("Database");
    fs::create_dir_all(database.join(".ambd/records")).unwrap();
    fs::write(
        database.join("ambd.json"),
        serde_json::to_vec_pretty(&manifest("01J00000000000000000000000", None)).unwrap(),
    )
    .unwrap();
    fs::write(
        database.join("Row.md"),
        "---\namby-id: 01J00000000000000000000001\n---\n# Row\n",
    )
    .unwrap();
    fs::write(
            database.join(".ambd/records/01J00000000000000000000001.json"),
            serde_json::to_vec_pretty(&json!({
                "format": "amby-database-record",
                "formatVersion": 1,
                "databaseId": "01J00000000000000000000000",
                "noteId": "01J00000000000000000000001",
                "values": {
                    "01J00000000000000000000004": {"type":"number", "decimal":"90071992547409931234567890.125"}
                }
            }))
            .unwrap(),
        )
        .unwrap();
    let conn = open_connection(&vault).unwrap();
    sync_vault(&conn, &vault).unwrap();
    let report = rebuild_database_projection(&conn, &vault).unwrap();
    assert!(report.published);
    assert_eq!(report.state, HEALTHY);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM db_databases", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let decimal: String = conn
        .query_row("SELECT decimal_value FROM db_values", [], |row| row.get(0))
        .unwrap();
    assert_eq!(decimal, "90071992547409931234567890.125");
    let real_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('db_values') WHERE type = 'REAL'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(real_columns, 0);
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn rebuild_projects_yaml_field_conflicts_without_mutating_sources() {
    let vault = temp_vault("yaml-conflict");
    let database = vault.join("Database");
    let note_id = "01J00000000000000000000001";
    let database_id = "01J00000000000000000000000";
    let property_id = "01J00000000000000000000004";
    fs::create_dir_all(database.join(".ambd/records")).unwrap();
    let mut manifest = manifest(database_id, None);
    manifest["properties"][0]["yamlBinding"] = json!({
        "key": "count",
        "direction": "twoWay"
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    fs::write(database.join("ambd.json"), &manifest_bytes).unwrap();
    let note_source = format!("---\namby-id: {note_id}\ncount: 3\n---\n# Row\n");
    fs::write(database.join("Row.md"), &note_source).unwrap();
    fs::write(
        database.join(format!(".ambd/records/{note_id}.json")),
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": database_id,
            "noteId": note_id,
            "values": {
                property_id: {"type":"number", "decimal":"2"}
            },
            "yamlSyncBases": {
                property_id: {
                    "state":"value",
                    "value":{"type":"number", "decimal":"1"}
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let conn = open_connection(&vault).unwrap();
    sync_vault(&conn, &vault).unwrap();
    rebuild_database_projection(&conn, &vault).unwrap();
    let conflicts: i64 = conn
        .query_row("SELECT COUNT(*) FROM db_yaml_conflicts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(conflicts, 1);
    let diagnostic: String = conn
        .query_row(
            "SELECT code FROM db_diagnostics WHERE code = 'yamlConflict'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(diagnostic, "yamlConflict");
    assert_eq!(
        fs::read(database.join("Row.md")).unwrap(),
        note_source.as_bytes()
    );
    assert_eq!(
        fs::read(database.join("ambd.json")).unwrap(),
        manifest_bytes
    );
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn broken_rebuild_preserves_existing_projection_and_marks_stale() {
    let vault = temp_vault("stale");
    let database = vault.join("Database");
    fs::create_dir_all(&database).unwrap();
    fs::write(
        database.join("ambd.json"),
        serde_json::to_vec_pretty(&manifest("01J00000000000000000000000", None)).unwrap(),
    )
    .unwrap();
    let conn = open_connection(&vault).unwrap();
    let first = rebuild_database_projection(&conn, &vault).unwrap();
    assert!(first.published);
    fs::write(database.join("ambd.json"), b"{broken").unwrap();
    let second = rebuild_database_projection(&conn, &vault).unwrap();
    assert!(!second.published);
    assert_eq!(second.state, STALE_READ_ONLY);
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM db_databases", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn healthy_projection_can_be_reused_without_rereading_sources() {
    let vault = temp_vault("cache");
    let database = vault.join("Database");
    fs::create_dir_all(&database).unwrap();
    fs::write(
        database.join("ambd.json"),
        serde_json::to_vec_pretty(&manifest("01J00000000000000000000000", None)).unwrap(),
    )
    .unwrap();
    let conn = open_connection(&vault).unwrap();
    let report = rebuild_database_projection(&conn, &vault).unwrap();
    assert_eq!(
        cached_projection_version(&conn, &vault).unwrap(),
        Some(crate::database::model::ProjectionVersion {
            epoch: report.epoch,
            seq: report.seq,
        })
    );
    let mut changed_manifest = manifest("01J00000000000000000000000", None);
    changed_manifest["name"] = json!("Changed");
    fs::write(
        database.join("ambd.json"),
        serde_json::to_vec_pretty(&changed_manifest).unwrap(),
    )
    .unwrap();
    assert!(cached_projection_version(&conn, &vault).unwrap().is_none());
    conn.execute(
        "UPDATE index_metadata SET value = ?1 WHERE key = 'database_projection_status'",
        [STALE_READ_ONLY],
    )
    .unwrap();
    assert!(cached_projection_version(&conn, &vault).unwrap().is_none());
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn foreign_keys_and_projection_metadata_are_present() {
    let vault = temp_vault("schema");
    let conn = open_connection(&vault).unwrap();
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'db_%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(tables >= 12);
    let version: String = conn
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'database_schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "1");
    drop(conn);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
#[ignore = "run through scripts/run-database-benchmark.mjs"]
fn database_fixture_benchmark_reports_rebuild_and_query_timings() {
    let root = PathBuf::from(
        std::env::var("AMBY_DB_BENCHMARK_ROOT")
            .expect("AMBY_DB_BENCHMARK_ROOT must point to a disposable fixture"),
    );
    let database_id = std::env::var("AMBY_DB_BENCHMARK_DATABASE_ID")
        .expect("AMBY_DB_BENCHMARK_DATABASE_ID must be set");
    let connection = open_connection(&root).unwrap();
    let sync_start = std::time::Instant::now();
    sync_vault(&connection, &root).unwrap();
    let sync_ms = sync_start.elapsed().as_secs_f64() * 1000.0;
    let rebuild_start = std::time::Instant::now();
    rebuild_database_projection(&connection, &root).unwrap();
    let rebuild_ms = rebuild_start.elapsed().as_secs_f64() * 1000.0;
    let request = DatabaseQueryRequest {
        expected_generation: 1,
        database_id: database_id.clone(),
        context_page_id: None,
        search: None,
        sorts: Some(vec![DatabaseSortSpec {
            field: DatabaseFieldRef::System {
                field: "title".to_owned(),
            },
            direction: "asc".to_owned(),
            nulls: "last".to_owned(),
        }]),
        filter: None,
        source: DatabaseQuerySource::Inline {
            spec: DatabaseQuerySpec {
                filter: None,
                sorts: Vec::new(),
            },
        },
        page: DatabasePageRequest {
            limit: 100,
            cursor: None,
        },
    };
    let query_start = std::time::Instant::now();
    let result = query_database(&connection, &request).unwrap();
    let query_ms = query_start.elapsed().as_secs_f64() * 1000.0;
    let search_start = std::time::Instant::now();
    let mut search_count = 0_u64;
    for term in ["Алекс", "Unicode", "Character 000500"] {
        let mut search_request = request.clone();
        search_request.search = Some(term.to_owned());
        search_count += query_database(&connection, &search_request)
            .unwrap()
            .total_count;
    }
    let search_ms = search_start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "DB_BENCHMARK_JSON={}",
        json!({
            "databaseId": database_id,
            "rowCount": result.total_count,
            "firstPage": result.rows.len(),
            "syncMs": sync_ms,
            "rebuildMs": rebuild_ms,
            "firstPageMs": query_ms,
            "threeSearchesMs": search_ms,
            "searchCountChecksum": search_count,
        })
    );
}

#[test]
fn st07_rebuild_and_incremental_are_equivalent() {
    let vault = temp_vault("equiv");
    let db_dir = vault.join("Projects");
    fs::create_dir_all(&db_dir).unwrap();

    let db_id = ulid::Ulid::generate().to_string();
    let prop_status_id = ulid::Ulid::generate().to_string();
    let prop_priority_id = ulid::Ulid::generate().to_string();

    let manifest_val = json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": db_id,
        "name": "Projects",
        "containerKind": "standalone",
        "locked": false,
        "membership": { "kind": "filesystem-descendants", "recursive": true },
        "properties": [
            {
                "type": "text",
                "id": prop_status_id,
                "name": "Status",
                "pageVisibility": "alwaysShow",
                "yamlBinding": { "key": "Status", "direction": "twoWay" },
                "config": { "multiline": false }
            },
            {
                "type": "number",
                "id": prop_priority_id,
                "name": "Priority",
                "pageVisibility": "alwaysShow",
                "yamlBinding": { "key": "Priority", "direction": "twoWay" },
                "config": { "format": "number", "currency": null }
            }
        ],
        "views": [
            {
                "format": "amby-database-view",
                "formatVersion": 1,
                "databaseId": db_id,
                "viewId": ulid::Ulid::generate().to_string(),
                "name": "Table",
                "layout": "table",
                "fields": [],
                "filter": null,
                "sorts": [],
                "group": null
            }
        ],
        "templateOrder": []
    });
    fs::write(
        db_dir.join("Projects.json"),
        serde_json::to_vec_pretty(&manifest_val).unwrap(),
    )
    .unwrap();

    let note1_id = ulid::Ulid::generate().to_string();
    let note2_id = ulid::Ulid::generate().to_string();

    fs::write(
        db_dir.join("Note1.md"),
        format!("---\namby-id: {note1_id}\nStatus: Active\nPriority: 10\n---\n# Note 1\n"),
    )
    .unwrap();
    fs::write(
        db_dir.join("Note2.md"),
        format!("---\namby-id: {note2_id}\nStatus: Pending\nPriority: 5\n---\n# Note 2\n"),
    )
    .unwrap();

    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    sync_vault(&conn, &vault).unwrap();
    rebuild_database_projection(&conn, &vault).unwrap();

    // Now modify Note 2 in markdown frontmatter
    fs::write(
        db_dir.join("Note2.md"),
        format!("---\namby-id: {note2_id}\nStatus: Completed\nPriority: 42\n---\n# Note 2\n"),
    )
    .unwrap();

    // Incremental update
    update_database_values_incremental(&conn, &vault, &db_id, &[note2_id.clone()]).unwrap();

    // Capture state after incremental
    let get_state =
        |c: &Connection| -> Vec<(String, String, String, Option<String>, Option<String>)> {
            let mut stmt = c.prepare(
                "SELECT note_id, property_id, value_type, text_value, decimal_value FROM db_values ORDER BY note_id, property_id"
            ).unwrap();
            stmt.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        };

    let incremental_state = get_state(&conn);

    // Now perform a full rebuild on a fresh connection
    let fresh_conn = Connection::open_in_memory().unwrap();
    init_schema(&fresh_conn).unwrap();
    sync_vault(&fresh_conn, &vault).unwrap();
    rebuild_database_projection(&fresh_conn, &vault).unwrap();

    let rebuild_state = get_state(&fresh_conn);

    assert_eq!(
        incremental_state, rebuild_state,
        "Incremental update and full rebuild must produce identical SQLite db_values rows"
    );

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn computation_diagnostics_survive_full_and_incremental_projection() {
    let vault = temp_vault("computed-diagnostics");
    let database = vault.join("Computed");
    fs::create_dir_all(database.join(".ambd/records")).unwrap();
    let database_id = "01J00000000000000000000040";
    let broken_note_id = "01J00000000000000000000041";
    let healthy_note_id = "01J00000000000000000000042";
    let minimum_id = "01J00000000000000000000044";
    let divisor_id = "01J00000000000000000000045";
    let quotient_id = "01J00000000000000000000046";
    let manifest = json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": database_id,
        "name": "Computed",
        "containerKind": "standalone",
        "locked": false,
        "membership": {"kind": "filesystem-descendants", "recursive": true},
        "properties": [
            {
                "type": "number", "id": minimum_id, "name": "Minimum",
                "pageVisibility": "alwaysShow", "yamlBinding": null,
                "config": {"format": "number", "currency": null}
            },
            {
                "type": "number", "id": divisor_id, "name": "Divisor",
                "pageVisibility": "alwaysShow", "yamlBinding": null,
                "config": {"format": "number", "currency": null}
            },
            {
                "type": "formula", "id": quotient_id, "name": "Quotient",
                "pageVisibility": "alwaysShow", "yamlBinding": null,
                "config": {
                    "version": 1, "expression": "Minimum / Divisor",
                    "resultType": "number", "dependencies": [minimum_id, divisor_id]
                }
            }
        ],
        "viewOrder": [], "defaultViewId": null, "templateOrder": [],
        "defaultTemplateId": null
    });
    fs::write(
        database.join("ambd.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    for (note_id, title) in [(broken_note_id, "Broken"), (healthy_note_id, "Healthy")] {
        fs::write(
            database.join(format!("{title}.md")),
            format!("---\namby-id: {note_id}\n---\n# {title}\n"),
        )
        .unwrap();
    }
    write_projection_number_record(
        &database,
        database_id,
        broken_note_id,
        minimum_id,
        divisor_id,
        "-170141183460469231731687303715884105728",
        "-1",
    );
    write_projection_number_record(
        &database,
        database_id,
        healthy_note_id,
        minimum_id,
        divisor_id,
        "10",
        "-2",
    );

    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    sync_vault(&conn, &vault).unwrap();
    let full = rebuild_database_projection(&conn, &vault).unwrap();
    assert!(full.published);
    assert_eq!(full.state, HEALTHY);
    assert_eq!(full.diagnostics, 1);
    assert_eq!(
        projection_diagnostic_count(&conn, database_id, broken_note_id),
        1
    );
    assert_eq!(
        projection_value(&conn, database_id, healthy_note_id, quotient_id),
        Some("-5".to_owned())
    );
    assert_eq!(
        projection_value(&conn, database_id, broken_note_id, quotient_id),
        None
    );

    write_projection_number_record(
        &database,
        database_id,
        broken_note_id,
        minimum_id,
        divisor_id,
        "3",
        "-1",
    );
    let repaired = update_database_values_incremental(
        &conn,
        &vault,
        database_id,
        &[broken_note_id.to_owned()],
    )
    .unwrap();
    assert_eq!(repaired.diagnostics, 0);
    assert_eq!(
        projection_diagnostic_count(&conn, database_id, broken_note_id),
        0
    );
    assert_eq!(
        projection_value(&conn, database_id, broken_note_id, quotient_id),
        Some("-3".to_owned())
    );

    write_projection_number_record(
        &database,
        database_id,
        broken_note_id,
        minimum_id,
        divisor_id,
        "-170141183460469231731687303715884105728",
        "-1",
    );
    let broken_again = update_database_values_incremental(
        &conn,
        &vault,
        database_id,
        &[broken_note_id.to_owned()],
    )
    .unwrap();
    assert_eq!(broken_again.diagnostics, 1);
    assert_eq!(
        projection_diagnostic_count(&conn, database_id, broken_note_id),
        1
    );
    assert_eq!(
        projection_value(&conn, database_id, broken_note_id, quotient_id),
        None
    );

    let fresh_conn = Connection::open_in_memory().unwrap();
    init_schema(&fresh_conn).unwrap();
    sync_vault(&fresh_conn, &vault).unwrap();
    let rebuilt = rebuild_database_projection(&fresh_conn, &vault).unwrap();
    assert_eq!(rebuilt.diagnostics, 1);
    assert_eq!(
        projection_diagnostic_count(&fresh_conn, database_id, broken_note_id),
        1
    );
    assert_eq!(
        projection_value(&fresh_conn, database_id, healthy_note_id, quotient_id),
        Some("-5".to_owned())
    );

    fs::remove_dir_all(vault).unwrap();
}

fn write_projection_number_record(
    database: &PathBuf,
    database_id: &str,
    note_id: &str,
    minimum_id: &str,
    divisor_id: &str,
    minimum: &str,
    divisor: &str,
) {
    let record = json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": database_id,
        "noteId": note_id,
        "values": {
            minimum_id: {"type": "number", "decimal": minimum},
            divisor_id: {"type": "number", "decimal": divisor}
        }
    });
    fs::write(
        database.join(format!(".ambd/records/{note_id}.json")),
        serde_json::to_vec_pretty(&record).unwrap(),
    )
    .unwrap();
}

fn projection_value(
    conn: &Connection,
    database_id: &str,
    note_id: &str,
    property_id: &str,
) -> Option<String> {
    conn.query_row(
        "SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = ?3",
        params![database_id, note_id, property_id],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn projection_diagnostic_count(conn: &Connection, database_id: &str, note_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM db_diagnostics WHERE diagnostic_id = ?1",
        [format!("computed:formula:{database_id}:{note_id}")],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn relation_projection_refreshes_inverse_and_rollup_after_replacement_and_unlink() {
    use crate::database::mutations::{self, UpdateDatabaseRelationValueRequest};
    use crate::database::projection::update_relation_values_incremental;
    use crate::watcher::WatcherState;

    let vault = temp_vault("relation-incremental-replacement");
    let tasks_db = "01J00000000000000000000050";
    let projects_db = "01J00000000000000000000060";
    let task_id = "01J00000000000000000000051";
    let old_project_id = "01J00000000000000000000061";
    let new_project_id = "01J00000000000000000000062";
    let task_relation_id = "01J00000000000000000000052";
    let inverse_relation_id = "01J00000000000000000000063";
    let hours_id = "01J00000000000000000000064";
    let task_count_id = "01J00000000000000000000065";

    let tasks = vault.join("Tasks");
    let projects = vault.join("Projects");
    fs::create_dir_all(tasks.join(".ambd/records")).unwrap();
    fs::create_dir_all(projects.join(".ambd/records")).unwrap();
    fs::write(
        tasks.join("ambd.json"),
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": tasks_db,
            "name": "Tasks",
            "locked": false,
            "membership": {"kind": "filesystem-descendants", "recursive": true},
            "properties": [
                {
                    "type": "relation", "id": task_relation_id, "name": "Project",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {
                        "targetDatabaseId": projects_db, "maxItems": 1,
                        "inversePropertyId": inverse_relation_id
                    }
                },
                {
                    "type": "number", "id": hours_id, "name": "Hours",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {"format": "number", "currency": null}
                }
            ],
            "viewOrder": [], "defaultViewId": null, "templateOrder": [],
            "defaultTemplateId": null
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        projects.join("ambd.json"),
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": projects_db,
            "name": "Projects",
            "locked": false,
            "membership": {"kind": "filesystem-descendants", "recursive": true},
            "properties": [
                {
                    "type": "relation", "id": inverse_relation_id, "name": "Tasks",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {
                        "targetDatabaseId": tasks_db, "maxItems": null,
                        "inversePropertyId": task_relation_id
                    }
                },
                {
                    "type": "rollup", "id": task_count_id, "name": "Task Count",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {
                        "relationPropertyId": inverse_relation_id,
                        "targetPropertyId": hours_id,
                        "aggregation": "count"
                    }
                }
            ],
            "viewOrder": [], "defaultViewId": null, "templateOrder": [],
            "defaultTemplateId": null
        }))
        .unwrap(),
    )
    .unwrap();
    let task_bytes =
        format!("---\namby-id: {task_id}\nHours: 4\nkept: yes\n---\n# Task\n").into_bytes();
    let old_project_bytes = format!("---\namby-id: {old_project_id}\n---\n# Old\n").into_bytes();
    let new_project_bytes = format!("---\namby-id: {new_project_id}\n---\n# New\n").into_bytes();
    fs::write(tasks.join("Task.md"), &task_bytes).unwrap();
    fs::write(projects.join("Old.md"), &old_project_bytes).unwrap();
    fs::write(projects.join("New.md"), &new_project_bytes).unwrap();

    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    sync_vault(&conn, &vault).unwrap();
    rebuild_database_projection(&conn, &vault).unwrap();
    let watcher = WatcherState::new();

    let initial = mutations::update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: tasks_db.to_owned(),
            note_id: task_id.to_owned(),
            property_id: task_relation_id.to_owned(),
            expected_revision: raw_revision(&fs::read(tasks.join("Task.md")).unwrap()),
            target_note_ids: vec![old_project_id.to_owned()],
        },
        None,
    )
    .unwrap();
    assert_eq!(
        affected_note_pairs(&initial),
        vec![
            (tasks_db.to_owned(), task_id.to_owned()),
            (projects_db.to_owned(), old_project_id.to_owned()),
        ]
    );
    let after_initial = update_relation_values_incremental(&conn, &vault, &initial.affected_notes);
    assert!(after_initial.projection.is_some());
    assert!(after_initial.warnings.is_empty());
    assert_eq!(
        relation_edges(&conn, tasks_db, task_id, task_relation_id),
        vec![old_project_id]
    );
    assert_eq!(
        relation_edges(&conn, projects_db, old_project_id, inverse_relation_id),
        vec![task_id]
    );
    assert_eq!(
        projection_value(&conn, projects_db, old_project_id, task_count_id),
        Some("1".to_owned())
    );

    let replacement = mutations::update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: tasks_db.to_owned(),
            note_id: task_id.to_owned(),
            property_id: task_relation_id.to_owned(),
            expected_revision: raw_revision(&fs::read(tasks.join("Task.md")).unwrap()),
            target_note_ids: vec![new_project_id.to_owned()],
        },
        None,
    )
    .unwrap();
    assert_eq!(
        affected_note_pairs(&replacement),
        vec![
            (tasks_db.to_owned(), task_id.to_owned()),
            (projects_db.to_owned(), old_project_id.to_owned()),
            (projects_db.to_owned(), new_project_id.to_owned()),
        ]
    );
    let bytes_after_replacement = [
        (
            tasks.join("Task.md"),
            fs::read(tasks.join("Task.md")).unwrap(),
        ),
        (
            projects.join("Old.md"),
            fs::read(projects.join("Old.md")).unwrap(),
        ),
        (
            projects.join("New.md"),
            fs::read(projects.join("New.md")).unwrap(),
        ),
    ];
    update_relation_values_incremental(&conn, &vault, &replacement.affected_notes);
    for (path, bytes) in &bytes_after_replacement {
        assert_eq!(fs::read(path).unwrap(), *bytes);
    }
    assert_eq!(
        relation_edges(&conn, tasks_db, task_id, task_relation_id),
        vec![new_project_id]
    );
    assert!(relation_edges(&conn, projects_db, old_project_id, inverse_relation_id).is_empty());
    assert_eq!(
        relation_edges(&conn, projects_db, new_project_id, inverse_relation_id),
        vec![task_id]
    );
    assert_eq!(
        projection_value(&conn, projects_db, old_project_id, task_count_id),
        Some("0".to_owned())
    );
    assert_eq!(
        projection_value(&conn, projects_db, new_project_id, task_count_id),
        Some("1".to_owned())
    );

    let rebuilt_conn = Connection::open_in_memory().unwrap();
    init_schema(&rebuilt_conn).unwrap();
    sync_vault(&rebuilt_conn, &vault).unwrap();
    rebuild_database_projection(&rebuilt_conn, &vault).unwrap();
    assert_eq!(
        relation_edges(&conn, projects_db, old_project_id, inverse_relation_id),
        relation_edges(
            &rebuilt_conn,
            projects_db,
            old_project_id,
            inverse_relation_id
        )
    );
    assert_eq!(
        relation_edges(&conn, projects_db, new_project_id, inverse_relation_id),
        relation_edges(
            &rebuilt_conn,
            projects_db,
            new_project_id,
            inverse_relation_id
        )
    );
    assert_eq!(
        projection_value(&conn, projects_db, new_project_id, task_count_id),
        projection_value(&rebuilt_conn, projects_db, new_project_id, task_count_id)
    );

    let unlink = mutations::update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: tasks_db.to_owned(),
            note_id: task_id.to_owned(),
            property_id: task_relation_id.to_owned(),
            expected_revision: raw_revision(&fs::read(tasks.join("Task.md")).unwrap()),
            target_note_ids: Vec::new(),
        },
        None,
    )
    .unwrap();
    assert_eq!(
        affected_note_pairs(&unlink),
        vec![
            (tasks_db.to_owned(), task_id.to_owned()),
            (projects_db.to_owned(), new_project_id.to_owned()),
        ]
    );
    let bytes_after_unlink = [
        (
            tasks.join("Task.md"),
            fs::read(tasks.join("Task.md")).unwrap(),
        ),
        (
            projects.join("Old.md"),
            fs::read(projects.join("Old.md")).unwrap(),
        ),
        (
            projects.join("New.md"),
            fs::read(projects.join("New.md")).unwrap(),
        ),
    ];
    update_relation_values_incremental(&conn, &vault, &unlink.affected_notes);
    for (path, bytes) in &bytes_after_unlink {
        assert_eq!(fs::read(path).unwrap(), *bytes);
    }
    assert!(relation_edges(&conn, tasks_db, task_id, task_relation_id).is_empty());
    assert!(relation_edges(&conn, projects_db, new_project_id, inverse_relation_id).is_empty());
    assert_eq!(
        projection_value(&conn, projects_db, new_project_id, task_count_id),
        Some("0".to_owned())
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn relation_projection_refreshes_self_inverse_in_one_database() {
    use crate::database::mutations::{self, UpdateDatabaseRelationValueRequest};
    use crate::database::projection::update_relation_values_incremental;
    use crate::watcher::WatcherState;

    let vault = temp_vault("relation-incremental-self");
    let database_id = "01J00000000000000000000070";
    let parent_id = "01J00000000000000000000071";
    let children_id = "01J00000000000000000000072";
    let hours_id = "01J00000000000000000000073";
    let child_count_id = "01J00000000000000000000074";
    let parent_note_id = "01J00000000000000000000075";
    let child_note_id = "01J00000000000000000000076";
    let database = vault.join("Tasks");
    fs::create_dir_all(database.join(".ambd/records")).unwrap();
    fs::write(
        database.join("ambd.json"),
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": database_id,
            "name": "Tasks",
            "locked": false,
            "membership": {"kind": "filesystem-descendants", "recursive": true},
            "properties": [
                {
                    "type": "relation", "id": parent_id, "name": "Parent",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {"targetDatabaseId": database_id, "maxItems": 1, "inversePropertyId": children_id}
                },
                {
                    "type": "relation", "id": children_id, "name": "Children",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {"targetDatabaseId": database_id, "maxItems": null, "inversePropertyId": parent_id}
                },
                {
                    "type": "number", "id": hours_id, "name": "Hours",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {"format": "number", "currency": null}
                },
                {
                    "type": "rollup", "id": child_count_id, "name": "Child Count",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {"relationPropertyId": children_id, "targetPropertyId": hours_id, "aggregation": "count"}
                }
            ],
            "viewOrder": [], "defaultViewId": null, "templateOrder": [],
            "defaultTemplateId": null
        }))
        .unwrap(),
    )
    .unwrap();
    let parent_bytes =
        format!("---\namby-id: {parent_note_id}\nHours: 2\n---\n# Parent\n").into_bytes();
    let child_bytes =
        format!("---\namby-id: {child_note_id}\nHours: 3\n---\n# Child\n").into_bytes();
    fs::write(database.join("Parent.md"), &parent_bytes).unwrap();
    fs::write(database.join("Child.md"), &child_bytes).unwrap();

    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    sync_vault(&conn, &vault).unwrap();
    rebuild_database_projection(&conn, &vault).unwrap();
    let watcher = WatcherState::new();
    let linked = mutations::update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: database_id.to_owned(),
            note_id: parent_note_id.to_owned(),
            property_id: parent_id.to_owned(),
            expected_revision: raw_revision(&fs::read(database.join("Parent.md")).unwrap()),
            target_note_ids: vec![child_note_id.to_owned()],
        },
        None,
    )
    .unwrap();
    assert_eq!(
        affected_note_pairs(&linked),
        vec![
            (database_id.to_owned(), parent_note_id.to_owned()),
            (database_id.to_owned(), child_note_id.to_owned()),
        ]
    );
    let bytes_after_link = [
        (
            database.join("Parent.md"),
            fs::read(database.join("Parent.md")).unwrap(),
        ),
        (
            database.join("Child.md"),
            fs::read(database.join("Child.md")).unwrap(),
        ),
    ];
    let linked_report = update_relation_values_incremental(&conn, &vault, &linked.affected_notes);
    assert_eq!(
        linked_report.projection.as_ref().map(|report| report.seq),
        Some(1)
    );
    for (path, bytes) in &bytes_after_link {
        assert_eq!(fs::read(path).unwrap(), *bytes);
    }
    assert_eq!(
        relation_edges(&conn, database_id, parent_note_id, parent_id),
        vec![child_note_id]
    );
    assert_eq!(
        relation_edges(&conn, database_id, child_note_id, children_id),
        vec![parent_note_id]
    );
    assert_eq!(
        projection_value(&conn, database_id, child_note_id, child_count_id),
        Some("1".to_owned())
    );

    let unlinked = mutations::update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: database_id.to_owned(),
            note_id: parent_note_id.to_owned(),
            property_id: parent_id.to_owned(),
            expected_revision: raw_revision(&fs::read(database.join("Parent.md")).unwrap()),
            target_note_ids: Vec::new(),
        },
        None,
    )
    .unwrap();
    assert_eq!(
        affected_note_pairs(&unlinked),
        vec![
            (database_id.to_owned(), parent_note_id.to_owned()),
            (database_id.to_owned(), child_note_id.to_owned()),
        ]
    );
    let bytes_after_unlink = [
        (
            database.join("Parent.md"),
            fs::read(database.join("Parent.md")).unwrap(),
        ),
        (
            database.join("Child.md"),
            fs::read(database.join("Child.md")).unwrap(),
        ),
    ];
    let unlinked_report =
        update_relation_values_incremental(&conn, &vault, &unlinked.affected_notes);
    assert_eq!(
        unlinked_report.projection.as_ref().map(|report| report.seq),
        Some(2)
    );
    for (path, bytes) in &bytes_after_unlink {
        assert_eq!(fs::read(path).unwrap(), *bytes);
    }
    assert!(relation_edges(&conn, database_id, parent_note_id, parent_id).is_empty());
    assert!(relation_edges(&conn, database_id, child_note_id, children_id).is_empty());
    assert_eq!(
        projection_value(&conn, database_id, child_note_id, child_count_id),
        Some("0".to_owned())
    );
    let _ = fs::remove_dir_all(vault);
}

fn affected_note_pairs(
    result: &crate::database::mutations::UpdateDatabaseRelationValueResult,
) -> Vec<(String, String)> {
    let mut affected = result
        .affected_notes
        .iter()
        .map(|note| (note.database_id.clone(), note.note_id.clone()))
        .collect::<Vec<_>>();
    affected.sort();
    affected.dedup();
    affected
}

fn relation_edges(
    conn: &Connection,
    database_id: &str,
    note_id: &str,
    property_id: &str,
) -> Vec<String> {
    let mut statement = conn
        .prepare(
            "SELECT target_note_id FROM db_relation_edges WHERE source_database_id = ?1 AND source_note_id = ?2 AND property_id = ?3 ORDER BY position",
        )
        .unwrap();
    statement
        .query_map(params![database_id, note_id, property_id], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<String>, _>>()
        .unwrap()
}

#[test]
fn relation_projection_reports_one_bad_group_and_processes_the_next_group() {
    use crate::database::mutations::DatabaseAffectedNote;
    use crate::database::projection::update_relation_values_incremental;

    let vault = temp_vault("relation-incremental-warning");
    let missing_db = "01J00000000000000000000000";
    let healthy_db = "01J00000000000000000000080";
    let broken_db = "01J00000000000000000000090";
    let healthy_note = "01J00000000000000000000081";
    let broken_note = "01J00000000000000000000091";
    let healthy = vault.join("Healthy");
    let broken = vault.join("Broken");
    fs::create_dir_all(healthy.join(".ambd/records")).unwrap();
    fs::create_dir_all(broken.join(".ambd/records")).unwrap();
    for (container, database_id, name, note_id) in [
        (&healthy, healthy_db, "Entry", healthy_note),
        (&broken, broken_db, "Child", broken_note),
    ] {
        fs::write(
            container.join("ambd.json"),
            serde_json::to_vec_pretty(&manifest(database_id, None)).unwrap(),
        )
        .unwrap();
        fs::write(
            container.join(format!("{name}.md")),
            format!("---\namby-id: {note_id}\n---\n# {name}\n"),
        )
        .unwrap();
    }

    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    sync_vault(&conn, &vault).unwrap();
    rebuild_database_projection(&conn, &vault).unwrap();
    let healthy_before = fs::read(healthy.join("Entry.md")).unwrap();
    fs::write(broken.join("ambd.json"), b"{ malformed manifest").unwrap();

    let report = update_relation_values_incremental(
        &conn,
        &vault,
        &[
            DatabaseAffectedNote {
                database_id: broken_db.to_owned(),
                note_id: broken_note.to_owned(),
            },
            DatabaseAffectedNote {
                database_id: healthy_db.to_owned(),
                note_id: healthy_note.to_owned(),
            },
        ],
    );
    assert!(report.projection.is_some());
    assert_eq!(
        report.projection.as_ref().map(|projection| projection.seq),
        Some(1)
    );
    assert_eq!(report.warnings.len(), 1);
    assert!(report.warnings[0].contains(broken_db));
    assert_eq!(fs::read(healthy.join("Entry.md")).unwrap(), healthy_before);

    let report_after_missing_group = update_relation_values_incremental(
        &conn,
        &vault,
        &[
            DatabaseAffectedNote {
                database_id: missing_db.to_owned(),
                note_id: healthy_note.to_owned(),
            },
            DatabaseAffectedNote {
                database_id: healthy_db.to_owned(),
                note_id: healthy_note.to_owned(),
            },
        ],
    );
    assert_eq!(report_after_missing_group.warnings.len(), 1);
    assert!(report_after_missing_group.warnings[0].contains(missing_db));
    assert_eq!(
        report_after_missing_group
            .projection
            .as_ref()
            .map(|projection| projection.seq),
        Some(2)
    );
    assert_eq!(fs::read(healthy.join("Entry.md")).unwrap(), healthy_before);
    let _ = fs::remove_dir_all(vault);
}
