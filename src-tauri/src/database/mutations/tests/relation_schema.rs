use super::*;

#[test]
fn two_way_relation_creates_property_in_target_database_and_links_reciprocals() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let tasks_db = create_database(
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
    let projects_db = create_database(
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

    let tasks_rel = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: tasks_db.database_id.clone(),
            expected_manifest_revision: tasks_db.manifest_revision.clone(),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(projects_db.database_id.clone()),
            relation_max_items: Some(1),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(
                &fs::read(&projects_db.manifest_path).unwrap(),
            )),
            ..Default::default()
        },
    )
    .unwrap();

    let tasks_manifest = parse_manifest(&fs::read(&tasks_db.manifest_path).unwrap()).unwrap();
    let tasks_prop_val = serde_json::to_value(&tasks_manifest.value.properties[0]).unwrap();
    assert_eq!(tasks_prop_val["name"], "Project");
    assert_eq!(
        tasks_prop_val["config"]["targetDatabaseId"],
        projects_db.database_id
    );
    assert_eq!(tasks_prop_val["config"]["maxItems"], 1);
    let inverse_id = tasks_prop_val["config"]["inversePropertyId"]
        .as_str()
        .unwrap()
        .to_string();

    let projects_manifest = parse_manifest(&fs::read(&projects_db.manifest_path).unwrap()).unwrap();
    let projects_prop_val = serde_json::to_value(&projects_manifest.value.properties[0]).unwrap();
    assert_eq!(projects_prop_val["name"], "Tasks");
    assert_eq!(projects_prop_val["id"], inverse_id);
    assert_eq!(
        projects_prop_val["config"]["targetDatabaseId"],
        tasks_db.database_id
    );
    assert_eq!(
        projects_prop_val["config"]["inversePropertyId"],
        tasks_rel.property_id
    );

    // Now test update_database_relation_value syncs reciprocal records
    let task_note_id = ulid::Ulid::generate().to_string();
    let project_note_id = ulid::Ulid::generate().to_string();

    let tasks_dir = Path::new(&tasks_db.manifest_path).parent().unwrap();
    let task_note_path = tasks_dir.join("Task.md");
    fs::write(
        &task_note_path,
        format!("---\namby-id: {task_note_id}\n---\n# Task\n"),
    )
    .unwrap();

    let projects_dir = Path::new(&projects_db.manifest_path).parent().unwrap();
    let project_note_path = projects_dir.join("Project.md");
    fs::write(
        &project_note_path,
        format!("---\namby-id: {project_note_id}\n---\n# Project\n"),
    )
    .unwrap();

    update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: tasks_db.database_id.clone(),
            note_id: task_note_id.clone(),
            property_id: tasks_rel.property_id.clone(),
            expected_revision: raw_revision(&fs::read(&task_note_path).unwrap()),
            target_note_ids: vec![project_note_id.clone()],
        },
        None,
    )
    .unwrap();

    // Check task note frontmatter
    let task_content = fs::read_to_string(&task_note_path).unwrap();
    let task_mapping = frontmatter::frontmatter_yaml_mapping(&task_content)
        .unwrap()
        .unwrap();
    let task_rel_val = task_mapping
        .get(serde_yaml::Value::String("Project".to_string()))
        .expect("Task frontmatter must contain Project relation");
    let task_prop_def = &tasks_manifest.value.properties[0];
    let task_prop_val =
        crate::database::format::frontmatter_value_to_property_value(task_rel_val, task_prop_def)
            .expect("Valid relation value in Task");
    match task_prop_val {
        PropertyValue::Relation {
            target_note_ids, ..
        } => {
            assert_eq!(target_note_ids, std::slice::from_ref(&project_note_id));
        }
        other => panic!("expected relation value, got {other:?}"),
    }

    // Check project note frontmatter was reciprocally updated!
    let project_content = fs::read_to_string(&project_note_path).unwrap();
    let project_mapping = frontmatter::frontmatter_yaml_mapping(&project_content)
        .unwrap()
        .unwrap();
    let project_rel_val = project_mapping
        .get(serde_yaml::Value::String("Tasks".to_string()))
        .expect("Project frontmatter must contain Tasks reciprocal relation");
    let project_prop_def = &projects_manifest.value.properties[0];
    let project_prop_val = crate::database::format::frontmatter_value_to_property_value(
        project_rel_val,
        project_prop_def,
    )
    .expect("Valid relation value in Project");
    match project_prop_val {
        PropertyValue::Relation {
            target_note_ids, ..
        } => {
            assert_eq!(target_note_ids, std::slice::from_ref(&task_note_id));
        }
        other => panic!("expected inverse relation value on project, got {other:?}"),
    }

    // Now unlink
    update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: tasks_db.database_id.clone(),
            note_id: task_note_id.clone(),
            property_id: tasks_rel.property_id.clone(),
            expected_revision: raw_revision(&fs::read(&task_note_path).unwrap()),
            target_note_ids: vec![],
        },
        None,
    )
    .unwrap();

    let project_content_after = fs::read_to_string(&project_note_path).unwrap();
    let project_mapping_after = frontmatter::frontmatter_yaml_mapping(&project_content_after)
        .unwrap()
        .unwrap();
    if let Some(val) = project_mapping_after.get(serde_yaml::Value::String("Tasks".to_string())) {
        let prop_val =
            crate::database::format::frontmatter_value_to_property_value(val, project_prop_def)
                .unwrap_or(PropertyValue::Relation {
                    target_note_ids: vec![],
                    extra: Default::default(),
                });
        match prop_val {
            PropertyValue::Relation {
                target_note_ids, ..
            } => {
                assert!(target_note_ids.is_empty());
            }
            other => panic!("expected empty inverse relation, got {other:?}"),
        }
    }

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_rejects_inverse_yaml_binding_alias_without_writing() {
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
    let target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Target".to_owned(),
        },
    )
    .unwrap();
    let existing = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: target.database_id.clone(),
            expected_manifest_revision: target.manifest_revision,
            name: "Legacy".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let target_manifest_path = Path::new(&target.manifest_path);
    let mut target_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(target_manifest_path).unwrap()).unwrap();
    let existing_json = target_manifest["properties"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|property| property["id"] == existing.property_id)
        .unwrap();
    existing_json["yamlBinding"] = json!({"key": "Sources", "direction": "twoWay"});
    fs::write(target_manifest_path, json_bytes(&target_manifest).unwrap()).unwrap();

    let source_manifest_path = Path::new(&source.manifest_path);
    let source_before = fs::read(source_manifest_path).unwrap();
    let target_before = fs::read(target_manifest_path).unwrap();
    let error = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: raw_revision(&source_before),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(&target_before)),
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(
        error.to_ascii_lowercase().contains("yaml")
            || error.to_ascii_lowercase().contains("binding")
            || error.to_ascii_lowercase().contains("name"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_manifest_path).unwrap(), source_before);
    assert_eq!(fs::read(target_manifest_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_rejects_bom_target_manifest_without_writing() {
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
    let target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Target".to_owned(),
        },
    )
    .unwrap();
    let source_manifest_path = Path::new(&source.manifest_path);
    let target_manifest_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_manifest_path).unwrap();
    let mut target_before = fs::read(target_manifest_path).unwrap();
    let mut bom_target = vec![0xef, 0xbb, 0xbf];
    bom_target.append(&mut target_before);
    fs::write(target_manifest_path, &bom_target).unwrap();

    let error = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: raw_revision(&source_before),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(&bom_target)),
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(!error.is_empty());
    assert_eq!(fs::read(source_manifest_path).unwrap(), source_before);
    assert_eq!(fs::read(target_manifest_path).unwrap(), bom_target);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_invalid_source_insert_does_not_write_inverse_manifest() {
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
    let target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Target".to_owned(),
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();

    let error = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: raw_revision(&source_before),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            before_property_id: Some(ulid::Ulid::generate().to_string()),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(&target_before)),
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(
        error.contains("Insert position property"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_source_property_limit_does_not_write_inverse_manifest() {
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
    let target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Target".to_owned(),
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let mut source_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(source_path).unwrap()).unwrap();
    let properties = source_manifest["properties"].as_array_mut().unwrap();
    for index in 0..crate::database::validation::MAX_PROPERTIES {
        properties.push(json!({
            "type": "text",
            "id": ulid::Ulid::generate().to_string(),
            "name": format!("Filler {index}"),
            "pageVisibility": "alwaysShow",
            "yamlBinding": null,
            "config": {"multiline": false}
        }));
    }
    fs::write(source_path, json_bytes(&source_manifest).unwrap()).unwrap();
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();

    let error = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: raw_revision(&source_before),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(&target_before)),
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(
        error.contains("at most") || error.contains("invalid"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_stale_or_missing_target_revision_does_not_write() {
    for expected_target_manifest_revision in [Some("0".repeat(64)), None] {
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
        let target = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Target".to_owned(),
            },
        )
        .unwrap();
        let source_path = Path::new(&source.manifest_path);
        let target_path = Path::new(&target.manifest_path);
        let source_before = fs::read(source_path).unwrap();
        let target_before = fs::read(target_path).unwrap();
        let error = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: source.database_id.clone(),
                expected_manifest_revision: raw_revision(&source_before),
                name: "Related".to_owned(),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(target.database_id.clone()),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some("Sources".to_owned()),
                operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
                expected_target_manifest_revision,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_ascii_lowercase().contains("revision"),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(source_path).unwrap(), source_before);
        assert_eq!(fs::read(target_path).unwrap(), target_before);
        let _ = fs::remove_dir_all(vault);
    }
}

#[test]
fn self_two_way_relation_rejects_forward_and_existing_inverse_names() {
    for (forward_name, inverse_name, add_existing) in
        [("Parent", "Parent", false), ("Forward", "Existing", true)]
    {
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
        let manifest_path = Path::new(&database.manifest_path);
        if add_existing {
            create_database_property(
                &vault,
                &watcher,
                &CreateDatabasePropertyRequest {
                    expected_generation: 1,
                    database_id: database.database_id.clone(),
                    expected_manifest_revision: database.manifest_revision.clone(),
                    name: "Existing".to_owned(),
                    property_type: "text".to_owned(),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let before = fs::read(manifest_path).unwrap();
        let error = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: database.database_id.clone(),
                expected_manifest_revision: raw_revision(&before),
                name: forward_name.to_owned(),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(database.database_id.clone()),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some(inverse_name.to_owned()),
                operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            error.contains("already") || error.contains("name") || error.contains("YAML"),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(manifest_path).unwrap(), before);
        let _ = fs::remove_dir_all(vault);
    }
}

#[test]
fn self_two_way_relation_persists_one_step_and_replays_completed_result() {
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
    let manifest_path = Path::new(&database.manifest_path);
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let request = CreateDatabasePropertyRequest {
        expected_generation: 1,
        database_id: database.database_id.clone(),
        expected_manifest_revision: raw_revision(&fs::read(manifest_path).unwrap()),
        name: "Subtasks".to_owned(),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(database.database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Parent".to_owned()),
        operation_id: Some(operation_id.clone()),
        ..Default::default()
    };
    let created = create_database_property(&vault, &watcher, &request).unwrap();
    let after_create = fs::read(manifest_path).unwrap();
    assert_eq!(created.manifest_revisions.len(), 1);
    assert_eq!(created.operation_id.as_deref(), Some(operation_id.as_str()));
    let manifest = parse_manifest(&after_create).unwrap();
    assert_eq!(manifest.value.properties.len(), 2);
    let forward = serde_json::to_value(&manifest.value.properties[0]).unwrap();
    let inverse = serde_json::to_value(&manifest.value.properties[1]).unwrap();
    assert_eq!(forward["name"], "Subtasks");
    assert_eq!(inverse["name"], "Parent");
    assert_eq!(forward["config"]["inversePropertyId"], inverse["id"]);
    assert_eq!(inverse["config"]["inversePropertyId"], forward["id"]);
    assert_eq!(
        created.inverse_property_id.as_deref(),
        inverse["id"].as_str()
    );

    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["status"], "completed");
    assert_eq!(journal["steps"].as_array().unwrap().len(), 1);

    let replay_request = CreateDatabasePropertyRequest {
        expected_generation: 99,
        ..request.clone()
    };
    let replayed = create_database_property(&vault, &watcher, &replay_request).unwrap();
    assert_eq!(replayed, created);
    assert_eq!(fs::read(manifest_path).unwrap(), after_create);

    let mut mismatch = replay_request.clone();
    mismatch.name = "Different".to_owned();
    assert!(create_database_property(&vault, &watcher, &mismatch).is_err());
    assert_eq!(fs::read(manifest_path).unwrap(), after_create);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn relation_configuration_noop_does_not_claim_or_consume_a_durable_operation_id() {
    let (vault, watcher, source, _) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let before = fs::read(&source.manifest_path).unwrap();
    let operation_id = format!("schema-noop-{}", ulid::Ulid::generate());
    let mut request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id,
        expected_manifest_revision: property.manifest_revision,
        property_type: "relation".to_owned(),
        operation_id: Some(operation_id.clone()),
        relation_two_way: Some(false),
        relation_max_items: Some(0),
        ..Default::default()
    };
    let unchanged = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert!(unchanged.operation_id.is_none());
    assert_eq!(fs::read(&source.manifest_path).unwrap(), before);
    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"));
    assert!(!journal_path.exists());

    request.relation_max_items = Some(1);
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.operation_id.as_deref(), Some(operation_id.as_str()));
    assert!(journal_path.exists());
    let _ = fs::remove_dir_all(vault);
}
