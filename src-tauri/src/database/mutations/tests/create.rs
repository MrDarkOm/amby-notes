use super::*;

#[test]
fn standalone_creation_writes_manifest_and_default_view_without_markdown() {
    let vault = temp_vault();
    let result = create_database(
        &vault,
        &WatcherState::new(),
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Projects".to_owned(),
        },
    )
    .unwrap();
    assert!(Path::new(&result.manifest_path).is_file());
    assert!(Path::new(&result.view_path).is_file());
    let manifest =
        crate::database::format::parse_manifest(&fs::read(&result.manifest_path).unwrap()).unwrap();
    assert_eq!(manifest.value.views.len(), 1);
    let view = &manifest.value.views[0];
    let validation = crate::database::validation::validate_view(view, None);
    assert!(
        validation.errors.is_empty(),
        "generated view failed validation: {:?}",
        validation.errors
    );
    assert!(!vault.join("Projects").join("Projects.md").exists());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn attached_creation_preserves_note_bytes() {
    let vault = temp_vault();
    let note = vault.join("Meeting.md");
    let original = b"---\ntitle: Meeting\n---\n\nBody\r\n";
    fs::write(&note, original).unwrap();
    let result = create_database(
        &vault,
        &WatcherState::new(),
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Attached,
            parent_path: None,
            note_path: Some(note.to_string_lossy().to_string()),
            name: "Meeting DB".to_owned(),
        },
    )
    .unwrap();
    let moved_note = vault.join("Meeting").join("Meeting.md");
    assert_eq!(fs::read(moved_note).unwrap(), original);
    assert!(Path::new(&result.manifest_path).is_file());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn database_rename_updates_manifest_with_raw_revision_cas() {
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
    let renamed = rename_database(
        &vault,
        &watcher,
        &RenameDatabaseRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "Roadmap".to_owned(),
        },
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.value.name, "Roadmap");
    assert_eq!(parsed.revision, renamed.manifest_revision);
    assert!(rename_database(
        &vault,
        &watcher,
        &RenameDatabaseRequest {
            expected_generation: 1,
            database_id: created.database_id,
            expected_manifest_revision: created.manifest_revision,
            name: "Stale".to_owned(),
        },
    )
    .is_err());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn creates_standalone_database_with_named_json_file() {
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
            name: "My Tasks".to_owned(),
        },
    )
    .unwrap();

    assert_eq!(created.title, "My Tasks");
    let db_dir = vault.join("My Tasks");
    assert!(db_dir.is_dir());

    // The manifest MUST be named "My Tasks.json"
    let manifest_path = db_dir.join("My Tasks.json");
    assert!(manifest_path.is_file());
    assert!(!db_dir.join("ambd.json").exists());

    // Verify content
    let parsed = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.value.name, "My Tasks");
    assert_eq!(parsed.value.database_id, created.database_id);

    // Add a property
    let prop = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            expected_manifest_revision: parsed.revision.clone(),
            database_id: created.database_id.clone(),
            name: "Priority".to_owned(),
            property_type: "select".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    // Verify property was written to "My Tasks.json"
    let parsed_after = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(parsed_after.revision, prop.manifest_revision);
    assert_eq!(parsed_after.value.properties.len(), 1);

    // Rename the database item via crate::bundle::rename_item_impl
    crate::bundle::rename_item_impl(&db_dir, "All Tasks").unwrap();

    let new_db_dir = vault.join("All Tasks");
    assert!(new_db_dir.is_dir());
    assert!(!db_dir.exists());

    // The manifest file should have been renamed to "All Tasks.json"
    let new_manifest_path = new_db_dir.join("All Tasks.json");
    assert!(new_manifest_path.is_file());
    assert!(!new_db_dir.join("My Tasks.json").exists());

    // The internal "name" should be updated to "All Tasks"
    let parsed_renamed = parse_manifest(&fs::read(&new_manifest_path).unwrap()).unwrap();
    assert_eq!(parsed_renamed.value.name, "All Tasks");

    let _ = fs::remove_dir_all(vault);
}
