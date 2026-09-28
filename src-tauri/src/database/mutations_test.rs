use super::*;

fn temp_vault() -> PathBuf {
    let path = std::env::temp_dir().join(format!("amby-db-create-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&path).unwrap();
    path
}

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
        super::super::format::parse_manifest(&fs::read(&result.manifest_path).unwrap()).unwrap();
    assert_eq!(manifest.value.views.len(), 1);
    let view = &manifest.value.views[0];
    let validation = super::super::validation::validate_view(view, None);
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
fn property_creation_updates_manifest_with_raw_revision_cas() {
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
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "Priority".to_owned(),
            property_type: "number".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let bytes = fs::read(&created.manifest_path).unwrap();
    let parsed = parse_manifest(&bytes).unwrap();
    assert_eq!(parsed.revision, property.manifest_revision);
    assert_eq!(parsed.value.properties.len(), 1);
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(property.property_id.as_str())
    );
    assert!(create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            expected_manifest_revision: created.manifest_revision,
            name: "Stale".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .is_err());
    assert_eq!(fs::read(&created.manifest_path).unwrap(), bytes);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn select_property_creation_preserves_unique_non_empty_options() {
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
    create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            expected_manifest_revision: created.manifest_revision,
            name: "Status".to_owned(),
            property_type: "select".to_owned(),
            before_property_id: None,
            options: vec!["Todo".to_owned(), " todo ".to_owned(), "".to_owned()],
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    let options = value["config"]["options"].as_array().unwrap();
    assert_eq!(options.len(), 1);
    assert_eq!(options[0]["name"], "Todo");
    assert!(ulid::Ulid::from_string(options[0]["id"].as_str().unwrap()).is_ok());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn formula_property_creation_stores_the_validated_expression() {
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
    create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            expected_manifest_revision: created.manifest_revision,
            name: "Score".to_owned(),
            property_type: "formula".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: Some("1 + 2".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(value["type"], "formula");
    assert_eq!(value["config"]["expression"], "1 + 2");
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn relation_property_creation_defaults_to_the_current_database() {
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
    create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Related projects".to_owned(),
            property_type: "relation".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(value["type"], "relation");
    assert_eq!(value["config"]["targetDatabaseId"], created.database_id);
    assert!(value["config"]["maxItems"].is_null());
    assert!(value["config"]["inversePropertyId"].is_null());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn relation_property_creation_can_target_another_database() {
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
            name: "Characters".to_owned(),
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
            name: "Locations".to_owned(),
        },
    )
    .unwrap();
    create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: source.manifest_revision,
            name: "Location".to_owned(),
            property_type: "relation".to_owned(),
            before_property_id: None,
            options: vec![target.database_id.clone()],
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&source.manifest_path).unwrap()).unwrap();
    let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(value["config"]["targetDatabaseId"], target.database_id);
    let _ = fs::remove_dir_all(vault);
}

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

#[test]
fn property_rename_updates_manifest_and_preserves_property_id() {
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
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "Priority".to_owned(),
            property_type: "number".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let renamed = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: property.manifest_revision.clone(),
            name: "Importance".to_owned(),
        },
    )
    .unwrap();
    let bytes = fs::read(&created.manifest_path).unwrap();
    let parsed = parse_manifest(&bytes).unwrap();
    assert_eq!(parsed.revision, renamed.manifest_revision);
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(property.property_id.as_str())
    );
    let serialized = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(
        serialized.get("name").and_then(|value| value.as_str()),
        Some("Importance")
    );
    assert!(rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: property.property_id,
            expected_manifest_revision: property.manifest_revision,
            name: "Stale".to_owned(),
        },
    )
    .is_err());
    assert_eq!(fs::read(&created.manifest_path).unwrap(), bytes);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_insert_and_delete_update_schema_order() {
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
    let right = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Right".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let left = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: right.manifest_revision,
            name: "Left".to_owned(),
            property_type: "number".to_owned(),
            before_property_id: Some(right.property_id.clone()),
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(left.property_id.as_str())
    );
    assert_eq!(
        parsed.value.properties[1].id(),
        Some(right.property_id.as_str())
    );

    let reordered = reorder_database_properties(
        &vault,
        &watcher,
        &ReorderDatabasePropertiesRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: left.manifest_revision,
            property_ids: vec![right.property_id.clone(), left.property_id.clone()],
        },
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(right.property_id.as_str())
    );
    assert_eq!(
        parsed.value.properties[1].id(),
        Some(left.property_id.as_str())
    );

    let deleted = delete_database_property(
        &vault,
        &watcher,
        &DeleteDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: left.property_id,
            expected_manifest_revision: reordered.manifest_revision,
        },
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.revision, deleted.manifest_revision);
    assert_eq!(parsed.value.properties.len(), 1);
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(right.property_id.as_str())
    );
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
fn value_batch_validates_every_cell_before_publishing_any_record() {
    let vault = temp_vault();
    let created = create_database(
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
    let property_id = ulid::Ulid::generate().to_string();
    let note_id = ulid::Ulid::generate().to_string();
    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    manifest["properties"] = json!([{
        "id": property_id.clone(),
        "name": "Status",
        "type": "text",
        "pageVisibility": "alwaysShow",
        "yamlBinding": null,
        "config": {"multiline": false}
    }]);
    fs::write(manifest_path, json_bytes(&manifest).unwrap()).unwrap();
    let record_path = vault
        .join("Projects/.ambd/records")
        .join(format!("{note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    let original = json_bytes(&json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": created.database_id.clone(),
        "noteId": note_id.clone(),
        "values": {}
    }))
    .unwrap();
    fs::write(&record_path, &original).unwrap();
    let result = apply_value_batch(
        &vault,
        &WatcherState::new(),
        &DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: created.database_id,
            operation_id: ulid::Ulid::generate().to_string(),
            cells: vec![
                DatabaseValueMutation {
                    note_id: note_id.clone(),
                    property_id,
                    value_json: Some(r#"{"kind":"text","value":"done"}"#.to_owned()),
                    expected_revision: raw_revision(&original),
                },
                DatabaseValueMutation {
                    note_id,
                    property_id: ulid::Ulid::generate().to_string(),
                    value_json: None,
                    expected_revision: raw_revision(&original),
                },
            ],
        },
        None,
    );
    assert!(result.is_err());
    assert_eq!(fs::read(record_path).unwrap(), original);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn value_batch_writes_a_durable_completed_journal_and_replays_idempotently() {
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
    let row = crate::database::rows::create_database_row(
        &vault,
        &watcher,
        &crate::database::rows::CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            title: "First".to_owned(),
            template: crate::database::rows::DatabaseRowTemplate::Default,
        },
    )
    .unwrap();
    let manifest_path =
        crate::database::discovery::manifest_path_for_container(&vault.join("Projects"));
    let mut locked_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    locked_manifest["locked"] = serde_json::Value::Bool(true);
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&locked_manifest).unwrap(),
    )
    .unwrap();
    let request = DatabaseValueBatchRequest {
        expected_generation: 1,
        database_id: created.database_id,
        operation_id: format!("test-{}", ulid::Ulid::generate()),
        cells: vec![DatabaseValueMutation {
            note_id: row.note_id,
            property_id: property.property_id,
            value_json: Some(r#"{"type":"text","value":"done"}"#.to_owned()),
            expected_revision: row.record_revision,
        }],
    };
    let first = apply_value_batch(&vault, &watcher, &request, None).unwrap();
    let replay = apply_value_batch(&vault, &watcher, &request, None).unwrap();
    assert_eq!(first, replay);
    let note_content = fs::read_to_string(&row.note_path).unwrap();
    assert!(note_content.contains("done"));
    assert!(!vault.join("Projects/.ambd/records").exists());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn recovery_rollback_restores_only_the_exact_batch_revision() {
    let container = temp_vault();
    let note_id = ulid::Ulid::generate().to_string();
    let operation_id = format!("test-{}", ulid::Ulid::generate());
    let record_path = container
        .join(".ambd/records")
        .join(format!("{note_id}.json"));
    let backup_path = container
        .join(".ambd/recovery")
        .join(&operation_id)
        .join(format!("{note_id}.json"));
    let journal_path = container
        .join(".ambd/recovery")
        .join(format!("{operation_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
    let original = br#"{"values":{}}"#;
    let target = br#"{"values":{"changed":true}}"#;
    fs::write(&record_path, target).unwrap();
    fs::write(&backup_path, original).unwrap();
    let journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: operation_id.clone(),
        database_id: ulid::Ulid::generate().to_string(),
        request_revision: "request".to_owned(),
        status: "inProgress".to_owned(),
        steps: vec![BatchRecoveryStep {
            record_path: format!(".ambd/records/{note_id}.json"),
            backup_path: format!(".ambd/recovery/{operation_id}/{note_id}.json"),
            original_revision: raw_revision(original),
            target_revision: raw_revision(target),
            status: "written".to_owned(),
        }],
        result: None,
    };
    write_new(&journal_path, &journal_bytes(&journal).unwrap()).unwrap();
    rollback_batch_journal(&container, &journal_path, journal).unwrap();
    assert_eq!(fs::read(record_path).unwrap(), original);
    assert_eq!(
        read_batch_journal(&journal_path).unwrap().status,
        "rolledBack"
    );
    let _ = fs::remove_dir_all(container);
}

#[test]
fn recovery_rejects_paths_not_derived_from_the_operation_and_note_ids() {
    let container = temp_vault();
    let step = BatchRecoveryStep {
        record_path: ".ambd/records/../../outside.json".to_owned(),
        backup_path: ".ambd/recovery/safe/../../outside.json".to_owned(),
        original_revision: "original".to_owned(),
        target_revision: "target".to_owned(),
        status: "written".to_owned(),
    };
    assert!(recovery_step_paths(&container, "safe", &step).is_err());
    let _ = fs::remove_dir_all(container);
}

#[test]
fn test_recover_pending_batches_restores_interrupted_batch_on_startup() {
    let vault = temp_vault();
    let note_path = vault.join("Task.md");
    let original = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Todo\n---\nInitial body";
    let target = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Done\n---\nInitial body";

    // Note was written with target content before process crashed
    fs::write(&note_path, target).unwrap();

    let op_id = "test-crash-op-1";
    let recovery_batches_dir = vault
        .join(".amby")
        .join("recovery")
        .join("database_batches");
    let op_backup_dir = recovery_batches_dir.join(op_id);
    fs::create_dir_all(&op_backup_dir).unwrap();

    let backup_file = op_backup_dir.join("01HZY1234567890ABCDEFGH001.md");
    fs::write(&backup_file, original).unwrap();

    let journal_path = recovery_batches_dir.join(format!("{op_id}.json"));
    let journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: op_id.to_owned(),
        database_id: ulid::Ulid::generate().to_string(),
        request_revision: "test-rev".to_owned(),
        status: "inProgress".to_owned(),
        steps: vec![BatchRecoveryStep {
            record_path: "Task.md".to_owned(),
            backup_path: format!(
                ".amby/recovery/database_batches/{op_id}/01HZY1234567890ABCDEFGH001.md"
            ),
            original_revision: raw_revision(original),
            target_revision: raw_revision(target),
            status: "planned".to_owned(),
        }],
        result: None,
    };
    fs::write(&journal_path, journal_bytes(&journal).unwrap()).unwrap();

    // Run recovery as would occur during vault activation
    let recovered = recover_pending_batches(&vault).unwrap();
    assert_eq!(recovered, 1);

    // Note content must be restored back to original
    assert_eq!(fs::read(&note_path).unwrap(), original);

    // Journal must now be marked as rolledBack
    let updated_journal = read_batch_journal(&journal_path).unwrap();
    assert_eq!(updated_journal.status, "rolledBack");

    // Idempotent: subsequent recovery run finds 0 pending batches
    let second_run = recover_pending_batches(&vault).unwrap();
    assert_eq!(second_run, 0);

    let _ = fs::remove_dir_all(vault);
}

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
            database_id: tasks_db.database_id.clone(),
            note_id: task_note_id.clone(),
            property_id: tasks_rel.property_id.clone(),
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
        .get(&serde_yaml::Value::String("Project".to_string()))
        .expect("Task frontmatter must contain Project relation");
    let task_prop_def = &tasks_manifest.value.properties[0];
    let task_prop_val =
        crate::database::format::frontmatter_value_to_property_value(task_rel_val, task_prop_def)
            .expect("Valid relation value in Task");
    match task_prop_val {
        PropertyValue::Relation {
            target_note_ids, ..
        } => {
            assert_eq!(target_note_ids, &[project_note_id.clone()]);
        }
        other => panic!("expected relation value, got {other:?}"),
    }

    // Check project note frontmatter was reciprocally updated!
    let project_content = fs::read_to_string(&project_note_path).unwrap();
    let project_mapping = frontmatter::frontmatter_yaml_mapping(&project_content)
        .unwrap()
        .unwrap();
    let project_rel_val = project_mapping
        .get(&serde_yaml::Value::String("Tasks".to_string()))
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
            assert_eq!(target_note_ids, &[task_note_id.clone()]);
        }
        other => panic!("expected inverse relation value on project, got {other:?}"),
    }

    // Now unlink
    update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            database_id: tasks_db.database_id.clone(),
            note_id: task_note_id.clone(),
            property_id: tasks_rel.property_id.clone(),
            target_note_ids: vec![],
        },
        None,
    )
    .unwrap();

    let project_content_after = fs::read_to_string(&project_note_path).unwrap();
    let project_mapping_after = frontmatter::frontmatter_yaml_mapping(&project_content_after)
        .unwrap()
        .unwrap();
    if let Some(val) = project_mapping_after.get(&serde_yaml::Value::String("Tasks".to_string())) {
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

#[test]
fn st04_batch_write_failure_rolls_back_first_file() {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;

    let vault = temp_vault();
    let watcher = WatcherState::new();

    let db = create_database(
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

    let prop = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            expected_manifest_revision: db.manifest_revision.clone(),
            database_id: db.database_id.clone(),
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let note1_id = ulid::Ulid::generate().to_string();
    let note1_path = vault.join("Tasks").join("Note1.md");
    let note1_orig = format!("---\namby-id: {note1_id}\nStatus: Old1\n---\n\nBody 1\n");
    fs::write(&note1_path, &note1_orig).unwrap();

    let note2_id = ulid::Ulid::generate().to_string();
    let sub_dir = vault.join("Tasks").join("locked_sub");
    fs::create_dir_all(&sub_dir).unwrap();
    let note2_path = sub_dir.join("Note2.md");
    let note2_orig = format!("---\namby-id: {note2_id}\nStatus: Old2\n---\n\nBody 2\n");
    fs::write(&note2_path, &note2_orig).unwrap();

    // Unix denies creation of the replacement file. Windows permits reads
    // but denies replacing an open file without FILE_SHARE_DELETE.
    #[cfg(unix)]
    let orig_perms = fs::metadata(&sub_dir).unwrap().permissions();
    #[cfg(unix)]
    fs::set_permissions(&sub_dir, fs::Permissions::from_mode(0o555)).unwrap();
    #[cfg(windows)]
    let locked_note = fs::OpenOptions::new()
        .read(true)
        .share_mode(1) // FILE_SHARE_READ
        .open(&note2_path)
        .unwrap();

    let batch_req = DatabaseValueBatchRequest {
        expected_generation: 1,
        database_id: db.database_id.clone(),
        operation_id: "op-test-rollback".to_owned(),
        cells: vec![
            DatabaseValueMutation {
                note_id: note1_id.clone(),
                property_id: prop.property_id.clone(),
                value_json: Some(
                    serde_json::to_string(&PropertyValue::Text {
                        value: "New1".to_owned(),
                        extra: Default::default(),
                    })
                    .unwrap(),
                ),
                expected_revision: String::new(),
            },
            DatabaseValueMutation {
                note_id: note2_id.clone(),
                property_id: prop.property_id.clone(),
                value_json: Some(
                    serde_json::to_string(&PropertyValue::Text {
                        value: "New2".to_owned(),
                        extra: Default::default(),
                    })
                    .unwrap(),
                ),
                expected_revision: String::new(),
            },
        ],
    };

    let result = apply_value_batch(&vault, &watcher, &batch_req, None);
    assert!(
        result.is_err(),
        "Batch write should fail because note2 cannot be written"
    );

    // Verify that note1 was rolled back to original bytes!
    let note1_after = fs::read_to_string(&note1_path).unwrap();
    assert_eq!(
        note1_after, note1_orig,
        "Note 1 must be rolled back to original content after batch failure"
    );
    assert_eq!(fs::read_to_string(&note2_path).unwrap(), note2_orig);

    // Restore permissions for cleanup
    #[cfg(unix)]
    fs::set_permissions(&sub_dir, orig_perms).unwrap();
    #[cfg(windows)]
    drop(locked_note);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn st04_two_way_relation_target_locked_or_missing_fails_cleanly() {
    let vault = temp_vault();
    let watcher = WatcherState::new();

    let db_a = create_database(
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

    let db_b = create_database(
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

    let projects_manifest_path = vault.join("Projects").join("Projects.json");
    let projects_bytes = fs::read(&projects_manifest_path).unwrap();
    let projects_manifest = parse_manifest(&projects_bytes).unwrap();

    let a_prop = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            expected_manifest_revision: projects_manifest.revision.clone(),
            database_id: db_a.database_id.clone(),
            name: "Tasks".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(db_b.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Project".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();

    let proj_note_id = ulid::Ulid::generate().to_string();
    let proj_note_path = vault.join("Projects").join("Project 1.md");
    let proj_orig = format!("---\namby-id: {proj_note_id}\n---\n\nProject content\n");
    fs::write(&proj_note_path, &proj_orig).unwrap();

    // 1. Target note is missing
    let missing_note_id = ulid::Ulid::generate().to_string();
    let rel_req = UpdateDatabaseRelationValueRequest {
        expected_generation: 1,
        database_id: db_a.database_id.clone(),
        note_id: proj_note_id.clone(),
        property_id: a_prop.property_id.clone(),
        target_note_ids: vec![missing_note_id.clone()],
    };
    let res = update_database_relation_value(&vault, &watcher, &rel_req, None);
    assert!(res.is_err(), "Must fail when target note is missing");
    assert_eq!(
        fs::read_to_string(&proj_note_path).unwrap(),
        proj_orig,
        "Source note must not be modified if target note is missing"
    );

    // 2. Target database is locked
    let task_note_id = ulid::Ulid::generate().to_string();
    let task_note_path = vault.join("Tasks").join("Task 1.md");
    let task_orig = format!("---\namby-id: {task_note_id}\n---\n\nTask content\n");
    fs::write(&task_note_path, &task_orig).unwrap();

    // Lock target database
    let tasks_manifest_path = vault.join("Tasks").join("Tasks.json");
    let mut target_m = parse_manifest(&fs::read(&tasks_manifest_path).unwrap()).unwrap();
    target_m.value.locked = true;
    fs::write(
        &tasks_manifest_path,
        serde_json::to_vec_pretty(&target_m.value).unwrap(),
    )
    .unwrap();

    let rel_req2 = UpdateDatabaseRelationValueRequest {
        expected_generation: 1,
        database_id: db_a.database_id.clone(),
        note_id: proj_note_id.clone(),
        property_id: a_prop.property_id.clone(),
        target_note_ids: vec![task_note_id.clone()],
    };
    let res2 = update_database_relation_value(&vault, &watcher, &rel_req2, None);
    assert!(res2.is_err(), "Must fail when target database is locked");
    assert_eq!(
        fs::read_to_string(&proj_note_path).unwrap(),
        proj_orig,
        "Source note must not be modified if target database is locked"
    );

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn st04_self_relation_updates_single_file_without_conflict() {
    let vault = temp_vault();
    let watcher = WatcherState::new();

    let db = create_database(
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

    let manifest_path = vault.join("Tasks").join("Tasks.json");
    let manifest = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();

    let subtask_prop = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            expected_manifest_revision: manifest.revision.clone(),
            database_id: db.database_id.clone(),
            name: "Subtasks".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(db.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Parent".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();

    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Tasks").join("RecursiveTask.md");
    let note_orig = format!("---\namby-id: {note_id}\n---\n\nSelf-referencing task\n");
    fs::write(&note_path, &note_orig).unwrap();

    let rel_req = UpdateDatabaseRelationValueRequest {
        expected_generation: 1,
        database_id: db.database_id.clone(),
        note_id: note_id.clone(),
        property_id: subtask_prop.property_id.clone(),
        target_note_ids: vec![note_id.clone()],
    };

    let res = update_database_relation_value(&vault, &watcher, &rel_req, None);
    assert!(
        res.is_ok(),
        "Self-relation update must succeed: {:?}",
        res.err()
    );

    let content_after = fs::read_to_string(&note_path).unwrap();
    let mapping = frontmatter::frontmatter_yaml_mapping(&content_after)
        .unwrap()
        .unwrap();

    let sub_val = mapping
        .get(&serde_yaml::Value::String("Subtasks".to_string()))
        .unwrap();
    let par_val = mapping
        .get(&serde_yaml::Value::String("Parent".to_string()))
        .unwrap();

    assert_eq!(
        sub_val,
        &serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(note_id.clone())])
    );
    assert_eq!(
        par_val,
        &serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(note_id.clone())])
    );

    let _ = fs::remove_dir_all(vault);
}
#[test]
fn review_future_manifest_prevents_batch_write() {
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
    let row = crate::database::rows::create_database_row(
        &vault,
        &watcher,
        &crate::database::rows::CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            title: "First".to_owned(),
            template: crate::database::rows::DatabaseRowTemplate::Default,
        },
    )
    .unwrap();
    let manifest_path =
        crate::database::discovery::manifest_path_for_container(&vault.join("Projects"));
    let mut locked_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    locked_manifest["formatVersion"] = serde_json::json!(999);
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&locked_manifest).unwrap(),
    )
    .unwrap();
    let request = DatabaseValueBatchRequest {
        expected_generation: 1,
        database_id: created.database_id,
        operation_id: format!("test-{}", ulid::Ulid::generate()),
        cells: vec![DatabaseValueMutation {
            note_id: row.note_id,
            property_id: property.property_id,
            value_json: Some(r#"{"type":"text","value":"done"}"#.to_owned()),
            expected_revision: row.record_revision,
        }],
    };
    let before = fs::read(&row.note_path).unwrap();
    let result = apply_value_batch(&vault, &watcher, &request, None);
    assert_eq!(
        fs::read(&row.note_path).unwrap(),
        before,
        "future-format database was changed: {result:?}"
    );
    assert!(result.is_err());
    let _ = fs::remove_dir_all(vault);
}
