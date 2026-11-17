use super::*;

#[test]
fn property_type_change_empty_text_to_two_way_cross_creates_inverse_and_replays() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: property.manifest_revision.clone(),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target.database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Tasks".to_owned()),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target.database_id.clone(),
            revision: current_manifest_revision(&target),
        }],
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    let source_after = fs::read(source_path).unwrap();
    let target_after = fs::read(target_path).unwrap();
    assert_eq!(changed.property_id, property.property_id);
    assert_eq!(changed.operation_id, request.operation_id);
    assert!(changed.inverse_property_id.is_some());
    assert_eq!(changed.manifest_revisions.len(), 2);
    let source_manifest = parse_manifest(&source_after).unwrap();
    let target_manifest = parse_manifest(&target_after).unwrap();
    let source_property = source_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
        .unwrap();
    let source_json = serde_json::to_value(source_property).unwrap();
    let inverse_id = source_json["config"]["inversePropertyId"].as_str().unwrap();
    assert_eq!(source_json["type"], "relation");
    assert_eq!(
        source_json["config"]["targetDatabaseId"],
        target.database_id
    );
    let inverse = target_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(inverse_id))
        .unwrap();
    let inverse_json = serde_json::to_value(inverse).unwrap();
    assert_eq!(inverse_json["name"], "Tasks");
    assert_eq!(
        inverse_json["config"]["inversePropertyId"],
        property.property_id
    );

    let operation_id = request.operation_id.clone().unwrap();
    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["status"], "completed");
    assert_eq!(journal["steps"].as_array().unwrap().len(), 2);

    let replay_request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 99,
        ..request.clone()
    };
    let replayed = change_database_property_type(&vault, &watcher, &replay_request).unwrap();
    assert_eq!(replayed, changed);
    assert_eq!(fs::read(source_path).unwrap(), source_after);
    assert_eq!(fs::read(target_path).unwrap(), target_after);

    let mut mismatch = replay_request;
    mismatch.relation_inverse_property_name = Some("Different".to_owned());
    assert!(change_database_property_type(&vault, &watcher, &mismatch).is_err());
    assert_eq!(fs::read(source_path).unwrap(), source_after);
    assert_eq!(fs::read(target_path).unwrap(), target_after);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_empty_text_to_two_way_self_uses_one_manifest_and_reciprocal_ids() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let database = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Tasks".to_owned(),
        },
    )
    .unwrap();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: database.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&database),
            name: "Subtasks".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let manifest_path = Path::new(&database.manifest_path);
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: database.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: property.manifest_revision,
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(database.database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Parent".to_owned()),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.manifest_revisions.len(), 1);
    assert!(changed.inverse_property_id.is_some());
    let manifest = parse_manifest(&fs::read(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest.value.properties.len(), 2);
    let forward = serde_json::to_value(
        manifest
            .value
            .properties
            .iter()
            .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
            .unwrap(),
    )
    .unwrap();
    let inverse_id = forward["config"]["inversePropertyId"].as_str().unwrap();
    let inverse = serde_json::to_value(
        manifest
            .value
            .properties
            .iter()
            .find(|candidate| candidate.id() == Some(inverse_id))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(inverse["config"]["inversePropertyId"], property.property_id);
    assert_eq!(changed.inverse_property_id.as_deref(), Some(inverse_id));
    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{}.json", request.operation_id.clone().unwrap()));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["steps"].as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_existing_one_way_relation_enables_cross_inverse() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: property.manifest_revision,
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target.database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Tasks".to_owned()),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target.database_id.clone(),
            revision: current_manifest_revision(&target),
        }],
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.property_id, property.property_id);
    assert!(changed.inverse_property_id.is_some());
    assert_eq!(changed.manifest_revisions.len(), 2);
    let target_manifest = parse_manifest(&fs::read(&target.manifest_path).unwrap()).unwrap();
    assert_eq!(target_manifest.value.properties.len(), 1);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_disables_cross_inverse_but_preserves_property_and_unknown_metadata() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(current_manifest_revision(&target)),
            ..Default::default()
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    for path in [source_path, target_path] {
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        value["vendorMetadata"] = json!({"preserve": true});
        fs::write(path, json_bytes(&value).unwrap()).unwrap();
    }
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: current_manifest_revision(&source),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target.database_id.clone()),
        relation_two_way: Some(false),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target.database_id.clone(),
            revision: current_manifest_revision(&target),
        }],
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.property_id, property.property_id);
    assert_eq!(changed.inverse_property_id, None);
    assert_eq!(changed.manifest_revisions.len(), 2);
    let source_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(source_path).unwrap()).unwrap();
    let target_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(target_path).unwrap()).unwrap();
    assert_eq!(source_manifest["vendorMetadata"]["preserve"], true);
    assert_eq!(target_manifest["vendorMetadata"]["preserve"], true);
    let source_property = source_manifest["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["id"] == property.property_id)
        .unwrap();
    assert_eq!(source_property["id"], property.property_id);
    assert!(source_property["config"]["inversePropertyId"].is_null());
    let target_properties = target_manifest["properties"].as_array().unwrap();
    assert_eq!(target_properties.len(), 1);
    assert_eq!(
        target_properties[0]["id"],
        property.inverse_property_id.as_deref().unwrap()
    );
    assert_eq!(target_properties[0]["type"], "relation");
    assert_eq!(
        target_properties[0]["config"]["targetDatabaseId"],
        source.database_id
    );
    assert!(target_properties[0]["config"]["inversePropertyId"].is_null());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_retargets_empty_pair_and_disconnects_old_inverse() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let source = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Source".to_owned(),
        },
    )
    .unwrap();
    let old_target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Old".to_owned(),
        },
    )
    .unwrap();
    let new_target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "New".to_owned(),
        },
    )
    .unwrap();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(old_target.database_id.clone()),
            relation_max_items: Some(1),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(current_manifest_revision(&old_target)),
            ..Default::default()
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: current_manifest_revision(&source),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(new_target.database_id.clone()),
        relation_inverse_property_name: Some("Sources".to_owned()),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        expected_related_manifest_revisions: vec![
            DatabaseManifestRevision {
                database_id: old_target.database_id.clone(),
                revision: current_manifest_revision(&old_target),
            },
            DatabaseManifestRevision {
                database_id: new_target.database_id.clone(),
                revision: current_manifest_revision(&new_target),
            },
        ],
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.manifest_revisions.len(), 3);
    assert_eq!(changed.property_id, property.property_id);
    let source_manifest = parse_manifest(&fs::read(source_path).unwrap()).unwrap();
    let source_json = serde_json::to_value(
        source_manifest
            .value
            .properties
            .iter()
            .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        source_json["config"]["targetDatabaseId"],
        new_target.database_id
    );
    assert_eq!(source_json["config"]["maxItems"], 1);
    assert!(source_json["config"]["inversePropertyId"].is_string());
    let old_manifest = parse_manifest(&fs::read(&old_target.manifest_path).unwrap()).unwrap();
    let new_manifest = parse_manifest(&fs::read(&new_target.manifest_path).unwrap()).unwrap();
    assert_eq!(old_manifest.value.properties.len(), 1);
    let old_inverse = serde_json::to_value(&old_manifest.value.properties[0]).unwrap();
    assert_eq!(
        old_inverse["id"],
        property.inverse_property_id.as_deref().unwrap()
    );
    assert_eq!(old_inverse["type"], "relation");
    assert_eq!(
        old_inverse["config"]["targetDatabaseId"],
        source.database_id
    );
    assert!(old_inverse["config"]["inversePropertyId"].is_null());
    assert_eq!(new_manifest.value.properties.len(), 1);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_one_way_cross_relation_records_readonly_target_revision() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let target_path = Path::new(&target.manifest_path);
    let target_before = fs::read(target_path).unwrap();
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let changed = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_max_items: Some(1),
            relation_two_way: Some(false),
            operation_id: Some(operation_id.clone()),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id.clone(),
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(changed.manifest_revisions.len(), 1);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["steps"].as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_empty_reciprocal_relation_to_text_preserves_inverse_and_unknown_config() {
    let fixture = relation_fixture();
    let source_manifest_path = fixture.source_manifest_path.clone();
    let target_manifest_path = fixture.target_manifest_path.clone();
    let mut source_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&source_manifest_path).unwrap()).unwrap();
    source_value["vendorRoot"] = json!({"keep": "source"});
    let unknown_property_id = ulid::Ulid::generate().to_string();
    source_value["properties"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "type": "futureProperty",
            "id": unknown_property_id,
            "payload": {"keep": [1, 2, 3]}
        }));
    let source_property = source_value["properties"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|property| property["id"] == fixture.source_property_id)
        .unwrap();
    source_property["config"]["vendorMetadata"] = json!({"keep": "relation"});
    fs::write(&source_manifest_path, json_bytes(&source_value).unwrap()).unwrap();

    let mut target_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&target_manifest_path).unwrap()).unwrap();
    let inverse_id = target_value["properties"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    target_value["vendorRoot"] = json!({"keep": "target"});
    target_value["properties"][0]["config"]["vendorMetadata"] = json!({"keep": "inverse"});
    fs::write(&target_manifest_path, json_bytes(&target_value).unwrap()).unwrap();

    let changed = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: fixture.source_database_id.clone(),
            property_id: fixture.source_property_id.clone(),
            expected_manifest_revision: raw_revision(&fs::read(&source_manifest_path).unwrap()),
            property_type: "text".to_owned(),
            relation_target_database_id: Some(
                parse_manifest(&fs::read(&target_manifest_path).unwrap())
                    .unwrap()
                    .value
                    .database_id,
            ),
            relation_two_way: Some(false),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: parse_manifest(&fs::read(&target_manifest_path).unwrap())
                    .unwrap()
                    .value
                    .database_id,
                revision: raw_revision(&fs::read(&target_manifest_path).unwrap()),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(changed.property_id, fixture.source_property_id);
    assert!(changed.inverse_property_id.is_none());

    let source_after =
        serde_json::from_slice::<serde_json::Value>(&fs::read(&source_manifest_path).unwrap())
            .unwrap();
    assert_eq!(source_after["vendorRoot"], json!({"keep": "source"}));
    let source_property_after = source_after["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["id"] == fixture.source_property_id)
        .unwrap();
    assert_eq!(source_property_after["type"], "text");
    assert_eq!(
        source_property_after["config"]["vendorMetadata"],
        json!({"keep": "relation"})
    );
    let unknown_property_after = source_after["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["id"] == unknown_property_id)
        .unwrap();
    assert_eq!(
        unknown_property_after["payload"],
        json!({"keep": [1, 2, 3]})
    );

    let target_after =
        serde_json::from_slice::<serde_json::Value>(&fs::read(&target_manifest_path).unwrap())
            .unwrap();
    assert_eq!(target_after["vendorRoot"], json!({"keep": "target"}));
    let inverse_after = target_after["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["id"] == inverse_id)
        .unwrap();
    assert_eq!(inverse_after["type"], "relation");
    assert_eq!(
        inverse_after["config"]["targetDatabaseId"],
        fixture.source_database_id
    );
    assert!(inverse_after["config"]["inversePropertyId"].is_null());
    assert_eq!(
        inverse_after["config"]["vendorMetadata"],
        json!({"keep": "inverse"})
    );
    let _ = fs::remove_dir_all(fixture.vault);
}
