//! A cell edit finds its notes through the SQLite index, verified by reading the one file, and
//! falls back to the full walk only when the index disagrees with the disk (DB-01).

use super::*;
use crate::database::discovery::test_seam::DISCOVER_VAULT_CALLS;
use crate::database::rows::{
    create_database_row, CreateDatabaseRowRequest, CreatedDatabaseRow, DatabaseRowTemplate,
};
use crate::index::{open_connection, sync_vault};

struct Fixture {
    vault: PathBuf,
    watcher: WatcherState,
    database_id: String,
    property_id: String,
    rows: Vec<CreatedDatabaseRow>,
}

fn fixture(row_count: usize, loose_notes: usize) -> Fixture {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let created = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Projects".to_owned(),
        },
    )
    .unwrap();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Summary".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let rows = (0..row_count)
        .map(|index| {
            create_database_row(
                &vault,
                &watcher,
                &CreateDatabaseRowRequest {
                    expected_generation: 1,
                    database_id: created.database_id.clone(),
                    title: format!("Row {index}"),
                    template: DatabaseRowTemplate::Default,
                },
            )
            .unwrap()
        })
        .collect();
    fs::create_dir_all(vault.join("Loose")).unwrap();
    for index in 0..loose_notes {
        fs::write(
            vault.join("Loose").join(format!("Note {index}.md")),
            format!(
                "---\namby-id: {}\n---\n# Note {index}\n",
                ulid::Ulid::generate()
            ),
        )
        .unwrap();
    }
    let conn = open_connection(&vault).unwrap();
    sync_vault(&conn, &vault).unwrap();
    crate::database::projection::rebuild_database_projection(&conn, &vault).unwrap();
    Fixture {
        vault,
        watcher,
        database_id: created.database_id,
        property_id: property.property_id,
        rows,
    }
}

fn edit(
    fixture: &Fixture,
    row: &CreatedDatabaseRow,
    text: &str,
    expected_revision: String,
) -> Result<DatabaseValueBatchResult, ValueBatchError> {
    apply_value_batch_typed(
        &fixture.vault,
        &fixture.watcher,
        &DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: fixture.database_id.clone(),
            operation_id: format!("test-{}", ulid::Ulid::generate()),
            cells: vec![DatabaseValueMutation {
                note_id: row.note_id.clone(),
                property_id: fixture.property_id.clone(),
                value_json: Some(format!(r#"{{"type":"text","value":"{text}"}}"#)),
                expected_revision,
            }],
        },
        None,
    )
}

fn reset_counters() {
    DISCOVER_VAULT_CALLS.with(|calls| calls.set(0));
    container_walk_seam::CONTAINER_WALKS.with(|walks| walks.set(0));
}

/// (vault scans, container walks)
fn counters() -> (usize, usize) {
    (
        DISCOVER_VAULT_CALLS.with(|calls| calls.get()),
        container_walk_seam::CONTAINER_WALKS.with(|walks| walks.get()),
    )
}

#[test]
fn cell_edit_with_a_current_index_scans_neither_the_vault_nor_the_container() {
    let fixture = fixture(3, 25);
    let row = &fixture.rows[1];
    reset_counters();
    edit(&fixture, row, "done", row.record_revision.clone()).unwrap();
    assert_eq!(counters(), (0, 0), "(vault scans, container walks)");
    assert!(fs::read_to_string(&row.note_path).unwrap().contains("done"));
    let _ = fs::remove_dir_all(&fixture.vault);
}

#[test]
fn cell_edit_with_a_current_index_still_catches_a_revision_conflict() {
    let fixture = fixture(2, 0);
    let row = &fixture.rows[0];
    let before = fs::read(&row.note_path).unwrap();
    let error = edit(&fixture, row, "done", "stale-revision".to_owned()).unwrap_err();
    assert!(matches!(error, ValueBatchError::RevisionConflict { .. }));
    assert_eq!(fs::read(&row.note_path).unwrap(), before);
    let _ = fs::remove_dir_all(&fixture.vault);
}

#[test]
fn stale_index_after_a_note_moved_inside_the_database_edits_the_moved_file() {
    let fixture = fixture(2, 0);
    let row = &fixture.rows[0];
    let moved_dir = fixture.vault.join("Projects/Sub");
    fs::create_dir_all(&moved_dir).unwrap();
    let moved = moved_dir.join("Moved.md");
    fs::rename(&row.note_path, &moved).unwrap();
    let revision = raw_revision(&fs::read(&moved).unwrap());
    edit(&fixture, row, "done", revision).unwrap();
    assert!(fs::read_to_string(&moved).unwrap().contains("done"));
    assert!(!Path::new(&row.note_path).exists());
    let _ = fs::remove_dir_all(&fixture.vault);
}

#[test]
fn stale_index_pointing_at_another_note_never_writes_to_that_file() {
    let fixture = fixture(2, 0);
    let row = &fixture.rows[0];
    let moved = fixture.vault.join("Projects/Moved.md");
    fs::rename(&row.note_path, &moved).unwrap();
    let impostor = format!("---\namby-id: {}\n---\n# Other\n", ulid::Ulid::generate());
    fs::write(&row.note_path, &impostor).unwrap();
    let revision = raw_revision(&fs::read(&moved).unwrap());
    edit(&fixture, row, "done", revision).unwrap();
    assert_eq!(fs::read_to_string(&row.note_path).unwrap(), impostor);
    assert!(fs::read_to_string(&moved).unwrap().contains("done"));
    let _ = fs::remove_dir_all(&fixture.vault);
}

#[test]
fn stale_index_after_a_note_left_the_database_refuses_and_changes_nothing() {
    let fixture = fixture(2, 0);
    let row = &fixture.rows[0];
    let outside = fixture.vault.join("Loose/Left.md");
    fs::rename(&row.note_path, &outside).unwrap();
    let before = fs::read(&outside).unwrap();
    assert!(edit(&fixture, row, "done", String::new()).is_err());
    assert_eq!(fs::read(&outside).unwrap(), before);
    let _ = fs::remove_dir_all(&fixture.vault);
}

#[test]
fn stale_index_after_the_database_folder_moved_falls_back_to_the_vault_scan() {
    let fixture = fixture(2, 0);
    let row = &fixture.rows[0];
    let file_name = Path::new(&row.note_path).file_name().unwrap().to_owned();
    fs::create_dir_all(fixture.vault.join("Archive")).unwrap();
    fs::rename(
        fixture.vault.join("Projects"),
        fixture.vault.join("Archive/Projects"),
    )
    .unwrap();
    let note = fixture.vault.join("Archive/Projects").join(file_name);
    reset_counters();
    edit(&fixture, row, "done", row.record_revision.clone()).unwrap();
    assert_eq!(counters().0, 1, "one vault scan to find the moved database");
    assert!(fs::read_to_string(note).unwrap().contains("done"));
    let _ = fs::remove_dir_all(&fixture.vault);
}

#[test]
fn incremental_projection_after_a_cell_edit_does_not_walk_the_container() {
    let fixture = fixture(3, 10);
    let row = &fixture.rows[2];
    edit(&fixture, row, "done", row.record_revision.clone()).unwrap();
    let conn = open_connection(&fixture.vault).unwrap();
    reset_counters();
    crate::database::projection::update_database_values_incremental(
        &conn,
        &fixture.vault,
        &fixture.database_id,
        std::slice::from_ref(&row.note_id),
    )
    .unwrap();
    assert_eq!(counters(), (0, 0), "(vault scans, container walks)");
    let _ = fs::remove_dir_all(&fixture.vault);
}

fn reindex(fixture: &Fixture) {
    let conn = open_connection(&fixture.vault).unwrap();
    sync_vault(&conn, &fixture.vault).unwrap();
    crate::database::projection::rebuild_database_projection(&conn, &fixture.vault).unwrap();
}

#[test]
fn two_notes_with_one_id_in_a_database_refuse_the_edit_and_change_neither() {
    let fixture = fixture(2, 0);
    let row = &fixture.rows[0];
    let twin = fixture.vault.join("Projects/Twin.md");
    fs::copy(&row.note_path, &twin).unwrap();
    reindex(&fixture);
    let first = fs::read(&row.note_path).unwrap();
    let second = fs::read(&twin).unwrap();
    let error = edit(&fixture, row, "done", String::new()).unwrap_err();
    assert!(error.to_string().contains("Ambiguous note ID"), "{error}");
    assert_eq!(fs::read(&row.note_path).unwrap(), first);
    assert_eq!(fs::read(&twin).unwrap(), second);
    let _ = fs::remove_dir_all(&fixture.vault);
}

#[test]
fn two_manifests_with_one_database_id_take_the_scanning_path() {
    let fixture = fixture(1, 0);
    let copy = fixture.vault.join("Copy");
    fs::create_dir_all(&copy).unwrap();
    let manifest =
        crate::database::discovery::manifest_path_for_container(&fixture.vault.join("Projects"));
    fs::copy(&manifest, copy.join("ambd.json")).unwrap();
    reindex(&fixture);
    reset_counters();
    let row = &fixture.rows[0];
    let _ = edit(&fixture, row, "done", row.record_revision.clone());
    assert_eq!(
        counters().0,
        1,
        "a duplicate database ID forces the vault scan"
    );
    let _ = fs::remove_dir_all(&fixture.vault);
}
