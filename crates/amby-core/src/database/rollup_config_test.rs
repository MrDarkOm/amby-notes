use super::*;
use crate::database::mutations::{
    create_database, create_database_property, CreateDatabasePropertyRequest,
    CreateDatabaseRequest, DatabaseCreateMode,
};

struct Fixture {
    vault: std::path::PathBuf,
    watcher: WatcherState,
    projects: String,
    tasks: String,
    projects_revision: String,
    tasks_revision: String,
}

fn database(vault: &Path, watcher: &WatcherState, name: &str) -> (String, String) {
    let created = create_database(
        vault,
        watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: name.to_owned(),
        },
    )
    .unwrap();
    (created.database_id, created.manifest_revision)
}

fn property(
    vault: &Path,
    watcher: &WatcherState,
    database_id: &str,
    revision: &str,
    request: CreateDatabasePropertyRequest,
) -> Result<(String, String), String> {
    let created = create_database_property(
        vault,
        watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: database_id.to_owned(),
            expected_manifest_revision: revision.to_owned(),
            ..request
        },
    )?;
    Ok((created.property_id, created.manifest_revision))
}

fn fixture() -> (Fixture, String, String, String) {
    let vault = std::env::temp_dir().join(format!("amby-rollup-{}", ulid::Ulid::generate()));
    std::fs::create_dir_all(&vault).unwrap();
    let watcher = WatcherState::new();
    let (projects, projects_revision) = database(&vault, &watcher, "Projects");
    let (tasks, tasks_revision) = database(&vault, &watcher, "Tasks");
    // Tasks: Hours (number), Done (checkbox), Title-like Notes (text).
    let (hours, rev) = property(
        &vault,
        &watcher,
        &tasks,
        &tasks_revision,
        CreateDatabasePropertyRequest {
            name: "Hours".to_owned(),
            property_type: "number".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let (done, tasks_revision) = property(
        &vault,
        &watcher,
        &tasks,
        &rev,
        CreateDatabasePropertyRequest {
            name: "Done".to_owned(),
            property_type: "checkbox".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    // Projects: Tasks relation to the Tasks database.
    let (relation, projects_revision) = property(
        &vault,
        &watcher,
        &projects,
        &projects_revision,
        CreateDatabasePropertyRequest {
            name: "Tasks".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(tasks.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    (
        Fixture {
            vault,
            watcher,
            projects,
            tasks,
            projects_revision,
            tasks_revision,
        },
        relation,
        hours,
        done,
    )
}

fn rollup(
    fixture: &Fixture,
    relation: &str,
    target: &str,
    aggregation: &str,
    name: &str,
) -> Result<(String, String), String> {
    property(
        &fixture.vault,
        &fixture.watcher,
        &fixture.projects,
        &fixture.projects_revision,
        CreateDatabasePropertyRequest {
            name: name.to_owned(),
            property_type: "rollup".to_owned(),
            rollup_relation_property_id: Some(relation.to_owned()),
            rollup_target_property_id: Some(target.to_owned()),
            rollup_aggregation: Some(aggregation.to_owned()),
            ..Default::default()
        },
    )
}

#[test]
fn creates_a_rollup_with_a_compatible_aggregation_stored_canonically() {
    let (fixture, relation, hours, done) = fixture();
    let (property_id, _) = rollup(&fixture, &relation, &hours, "avg", "Average hours").unwrap();
    let manifest_path = crate::database::discovery::manifest_path_for_container(
        &crate::database::mutations::find_database_container(&fixture.vault, &fixture.projects)
            .unwrap(),
    );
    let manifest = parse_manifest(&std::fs::read(manifest_path).unwrap()).unwrap();
    let stored = manifest
        .value
        .properties
        .iter()
        .find_map(|property| match property {
            PropertyDefinition::Rollup(fields) if fields.id == property_id => Some(fields),
            _ => None,
        })
        .unwrap();
    // The legacy spelling is normalized, and the manifest validates.
    assert_eq!(stored.config.aggregation, "average");
    assert!(validate_manifest(&manifest.value).errors.is_empty());
    assert!(done != hours);
    let _ = std::fs::remove_dir_all(&fixture.vault);
}

#[test]
fn refuses_incompatible_or_unknown_choices_and_leaves_the_manifest_alone() {
    let (fixture, relation, hours, done) = fixture();
    let before = std::fs::read(crate::database::discovery::manifest_path_for_container(
        &crate::database::mutations::find_database_container(&fixture.vault, &fixture.projects)
            .unwrap(),
    ))
    .unwrap();
    // Sum of a checkbox, percent of a number, unknown aggregation, missing fields.
    assert!(rollup(&fixture, &relation, &done, "sum", "A")
        .unwrap_err()
        .contains("does not apply"));
    assert!(rollup(&fixture, &relation, &hours, "percentChecked", "B").is_err());
    assert!(rollup(&fixture, &relation, &hours, "median", "C")
        .unwrap_err()
        .contains("Unknown"));
    assert!(rollup(&fixture, "01J00000000000000000000099", &hours, "sum", "D").is_err());
    assert!(rollup(
        &fixture,
        &relation,
        "01J00000000000000000000099",
        "sum",
        "E"
    )
    .is_err());
    let missing = property(
        &fixture.vault,
        &fixture.watcher,
        &fixture.projects,
        &fixture.projects_revision,
        CreateDatabasePropertyRequest {
            name: "F".to_owned(),
            property_type: "rollup".to_owned(),
            ..Default::default()
        },
    );
    assert!(missing.is_err());
    let after = std::fs::read(crate::database::discovery::manifest_path_for_container(
        &crate::database::mutations::find_database_container(&fixture.vault, &fixture.projects)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(before, after);
    let _ = std::fs::remove_dir_all(&fixture.vault);
}

#[test]
fn configure_changes_a_rollup_in_place_with_the_same_checks() {
    let (fixture, relation, hours, done) = fixture();
    let (rollup_id, revision) = rollup(&fixture, &relation, &hours, "sum", "Hours").unwrap();
    let request =
        |target: &str, aggregation: &str, revision: &str| ConfigureDatabaseRollupRequest {
            expected_generation: 1,
            database_id: fixture.projects.clone(),
            property_id: rollup_id.clone(),
            expected_manifest_revision: revision.to_owned(),
            relation_property_id: relation.clone(),
            target_property_id: target.to_owned(),
            aggregation: aggregation.to_owned(),
        };
    // Incompatible: rejected, nothing written.
    assert!(configure_database_rollup(
        &fixture.vault,
        &fixture.watcher,
        &request(&done, "sum", &revision)
    )
    .is_err());
    // A stale revision is a conflict.
    assert!(configure_database_rollup(
        &fixture.vault,
        &fixture.watcher,
        &request(&hours, "max", "stale")
    )
    .unwrap_err()
    .contains("conflict"));
    let changed = configure_database_rollup(
        &fixture.vault,
        &fixture.watcher,
        &request(&done, "percentChecked", &revision),
    )
    .unwrap();
    assert_eq!(changed.aggregation, "percentChecked");
    // Not a rollup: refuse to repurpose another property.
    assert!(configure_database_rollup(
        &fixture.vault,
        &fixture.watcher,
        &ConfigureDatabaseRollupRequest {
            property_id: relation.clone(),
            ..request(&hours, "sum", &changed.manifest_revision)
        }
    )
    .is_err());
    assert!(fixture.tasks != fixture.projects && !fixture.tasks_revision.is_empty());
    let _ = std::fs::remove_dir_all(&fixture.vault);
}
