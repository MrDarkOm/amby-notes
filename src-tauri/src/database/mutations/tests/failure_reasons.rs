//! The reason a person is told, read from refusals the write paths really raise (no hand-written
//! sentences): a change in a message that drops its reason fails here.

use super::*;
use crate::database::failure::{classify, FailureReason};

fn standalone(vault: &Path, watcher: &WatcherState, name: &str) -> CreatedDatabase {
    create_database(
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
    .unwrap()
}

fn new_property(
    created: &CreatedDatabase,
    revision: &str,
    name: &str,
    property_type: &str,
) -> CreateDatabasePropertyRequest {
    CreateDatabasePropertyRequest {
        expected_generation: 1,
        database_id: created.database_id.clone(),
        expected_manifest_revision: revision.to_owned(),
        name: name.to_owned(),
        property_type: property_type.to_owned(),
        ..Default::default()
    }
}

#[test]
fn a_stale_manifest_revision_is_a_revision_conflict() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let created = standalone(&vault, &watcher, "Projects");
    create_database_property(
        &vault,
        &watcher,
        &new_property(&created, &created.manifest_revision, "A", "text"),
    )
    .unwrap();
    let stale = create_database_property(
        &vault,
        &watcher,
        &new_property(&created, &created.manifest_revision, "B", "text"),
    )
    .unwrap_err();
    assert_eq!(classify(&stale), FailureReason::RevisionConflict, "{stale}");
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn a_repeated_property_name_is_name_taken_and_an_empty_one_is_invalid() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let created = standalone(&vault, &watcher, "Projects");
    let first = create_database_property(
        &vault,
        &watcher,
        &new_property(&created, &created.manifest_revision, "Price", "number"),
    )
    .unwrap();
    let twice = create_database_property(
        &vault,
        &watcher,
        &new_property(&created, &first.manifest_revision, "Price", "number"),
    )
    .unwrap_err();
    assert_eq!(classify(&twice), FailureReason::NameTaken, "{twice}");
    let empty = create_database_property(
        &vault,
        &watcher,
        &new_property(&created, &first.manifest_revision, "  ", "number"),
    )
    .unwrap_err();
    assert_eq!(classify(&empty), FailureReason::InvalidName, "{empty}");
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn a_broken_formula_is_formula_invalid() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let created = standalone(&vault, &watcher, "Calc");
    let formula = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            formula_expression: Some("1 + 1".to_owned()),
            ..new_property(&created, &created.manifest_revision, "Total", "formula")
        },
    )
    .unwrap();
    let error = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: formula.property_id.clone(),
            expected_manifest_revision: formula.manifest_revision.clone(),
            formula_expression: Some("1 +".to_owned()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(classify(&error), FailureReason::FormulaInvalid, "{error}");
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn a_setting_that_does_not_fit_the_property_is_invalid_config() {
    let (vault, watcher, created, text) = option_fixture("text", &[]);
    let error = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: text.property_id.clone(),
            expected_manifest_revision: text.manifest_revision.clone(),
            allow_range: Some(true),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(classify(&error), FailureReason::InvalidConfig, "{error}");
    let _ = fs::remove_dir_all(vault);
}
