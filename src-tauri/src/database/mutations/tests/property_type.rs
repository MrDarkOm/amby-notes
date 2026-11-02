use super::*;

#[test]
fn property_type_change_updates_an_unused_definition() {
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
            name: "Estimate".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();

    let changed = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: property.property_id.clone(),
            expected_manifest_revision: property.manifest_revision,
            property_type: "number".to_owned(),
            relation_target_database_id: None,
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.revision, changed.manifest_revision);
    assert_eq!(parsed.value.properties[0].kind(), "number");
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(property.property_id.as_str())
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_refuses_to_discard_existing_values() {
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
            name: "Estimate".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let record_path = Path::new(&created.manifest_path)
        .parent()
        .unwrap()
        .join(".ambd/records")
        .join(format!("{note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::write(
        record_path,
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": created.database_id,
            "noteId": note_id,
            "values": {
                property.property_id.clone(): {"type": "text", "value": "keep me"}
            },
            "yamlSyncBases": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let manifest_before = fs::read(&created.manifest_path).unwrap();

    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: property.property_id,
            expected_manifest_revision: property.manifest_revision,
            property_type: "number".to_owned(),
            relation_target_database_id: None,
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(error.contains("existing values"));
    assert_eq!(fs::read(&created.manifest_path).unwrap(), manifest_before);
    let _ = fs::remove_dir_all(vault);
}
