use super::*;

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
fn property_rename_preserves_notes_and_explicit_binding_across_nested_database() {
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
            name: "Priority".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let explicit_binding = json!({
        "key": "priority_key",
        "direction": "twoWay",
        "vendorMetadata": "keep"
    });
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    manifest["properties"][0]["yamlBinding"] = explicit_binding.clone();
    let manifest_bytes = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_bytes).unwrap();

    let nested = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.join("Projects").to_string_lossy().to_string()),
            note_path: None,
            name: "Nested".to_owned(),
        },
    )
    .unwrap();
    let nested_property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: nested.database_id.clone(),
            expected_manifest_revision: nested.manifest_revision,
            name: "Priority".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let root_note_id = ulid::Ulid::generate().to_string();
    let root_note_path = vault.join("Projects").join("Root.md");
    let root_note = format!(
        "\u{feff}---\r\namby-id: {root_note_id}\r\n# user comment\r\npriority_key: old\r\nunknown: [one, two]\r\n---\r\n# Root\r\n"
    )
    .into_bytes();
    fs::write(&root_note_path, &root_note).unwrap();

    let nested_note_id = ulid::Ulid::generate().to_string();
    let nested_note_path = vault.join("Projects/Nested").join("Child.md");
    let nested_note = format!(
        "\u{feff}---\r\namby-id: {nested_note_id}\r\nPriority: nested\r\nunknown: {{keep: true}}\r\n---\r\nNested body\r\n"
    )
    .into_bytes();
    fs::write(&nested_note_path, &nested_note).unwrap();
    let nested_manifest_before = fs::read(&nested.manifest_path).unwrap();

    let renamed = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: raw_revision(&manifest_bytes),
            name: "Importance".to_owned(),
        },
    )
    .unwrap();

    let renamed_manifest = parse_manifest(&fs::read(manifest_path).unwrap()).unwrap();
    let renamed_property = renamed_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
        .unwrap();
    let renamed_json = serde_json::to_value(renamed_property).unwrap();
    assert_eq!(renamed_json["name"], "Importance");
    assert_eq!(renamed_json["yamlBinding"], explicit_binding);
    assert_eq!(renamed_manifest.revision, renamed.manifest_revision);
    assert_eq!(fs::read(&root_note_path).unwrap(), root_note);
    assert_eq!(fs::read(&nested_note_path).unwrap(), nested_note);
    assert_eq!(
        fs::read(&nested.manifest_path).unwrap(),
        nested_manifest_before
    );
    assert_eq!(nested_property.name, "Priority");

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn legacy_property_rename_pins_storage_key_for_repeated_renames_and_edits() {
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
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Legacy.md");
    let original = format!(
        "\u{feff}---\r\namby-id: {note_id}\r\n# keep this comment\r\nStatus: old\r\nunknown: {{keep: true}}\r\n---\r\nBody\r\n"
    )
    .into_bytes();
    fs::write(&note_path, &original).unwrap();

    let first = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: property.manifest_revision,
            name: "State".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(fs::read(&note_path).unwrap(), original);

    let first_manifest = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let first_property = first_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
        .unwrap();
    let first_json = serde_json::to_value(first_property).unwrap();
    assert_eq!(first_json["name"], "State");
    assert_eq!(first_json["yamlBinding"]["key"], "Status");
    assert_eq!(first_json["yamlBinding"]["direction"], "twoWay");

    let second = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: first.manifest_revision,
            name: "Phase".to_owned(),
        },
    )
    .unwrap();
    let second_manifest = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let second_property = second_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
        .unwrap();
    let second_json = serde_json::to_value(second_property).unwrap();
    assert_eq!(second_json["name"], "Phase");
    assert_eq!(second_json["yamlBinding"]["key"], "Status");
    assert_eq!(second_json["yamlBinding"]["direction"], "twoWay");

    let edit = apply_value_batch(
        &vault,
        &watcher,
        &DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: created.database_id,
            operation_id: "legacy-rename-edit".to_owned(),
            cells: vec![DatabaseValueMutation {
                note_id,
                property_id: property.property_id,
                value_json: Some(r#"{"type":"text","value":"new"}"#.to_owned()),
                expected_revision: raw_revision(&original),
            }],
        },
        None,
    )
    .unwrap();
    assert_eq!(edit.revisions.len(), 1);
    let updated = fs::read(&note_path).unwrap();
    assert!(updated
        .windows(b"Status: new\r\n".len())
        .any(|window| { window == b"Status: new\r\n" }));
    assert!(!updated
        .windows(b"State:".len())
        .any(|window| window == b"State:"));
    assert!(!updated
        .windows(b"Phase:".len())
        .any(|window| window == b"Phase:"));
    assert!(updated.starts_with(b"\xef\xbb\xbf---\r\n"));
    assert!(updated
        .windows(b"# keep this comment\r\n".len())
        .any(|window| { window == b"# keep this comment\r\n" }));
    assert_eq!(second.manifest_revision, second_manifest.revision);

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn computed_property_rename_does_not_create_yaml_bindings() {
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
    let formula = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Score".to_owned(),
            property_type: "formula".to_owned(),
            formula_expression: Some("1 + 2".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let rollup_id = ulid::Ulid::generate().to_string();
    manifest["properties"].as_array_mut().unwrap().push(json!({
        "type": "rollup",
        "id": rollup_id,
        "name": "Total",
        "pageVisibility": "alwaysShow",
        "yamlBinding": null,
        "config": {
            "relationPropertyId": ulid::Ulid::generate().to_string(),
            "targetPropertyId": formula.property_id,
            "aggregation": "sum"
        }
    }));
    let manifest_bytes = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_bytes).unwrap();
    let parsed = parse_manifest(&manifest_bytes).unwrap();
    let rollup_id = parsed.value.properties[1].id().unwrap().to_owned();

    let renamed_formula = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: formula.property_id.clone(),
            expected_manifest_revision: parsed.revision,
            name: "Calculated".to_owned(),
        },
    )
    .unwrap();
    let after_formula = parse_manifest(&fs::read(manifest_path).unwrap()).unwrap();
    let formula_json = serde_json::to_value(
        after_formula
            .value
            .properties
            .iter()
            .find(|property| property.id() == Some(formula.property_id.as_str()))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(formula_json["name"], "Calculated");
    assert!(formula_json["yamlBinding"].is_null());

    let renamed_rollup = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: rollup_id.clone(),
            expected_manifest_revision: renamed_formula.manifest_revision,
            name: "Aggregated".to_owned(),
        },
    )
    .unwrap();
    let after_rollup = parse_manifest(&fs::read(manifest_path).unwrap()).unwrap();
    let rollup_json = serde_json::to_value(
        after_rollup
            .value
            .properties
            .iter()
            .find(|property| property.id() == Some(rollup_id.as_str()))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(rollup_json["name"], "Aggregated");
    assert!(rollup_json["yamlBinding"].is_null());
    assert_eq!(after_rollup.revision, renamed_rollup.manifest_revision);

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn explicit_binding_rename_rejects_legacy_display_value_without_writing() {
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
            name: "Priority".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    manifest["properties"][0]["yamlBinding"] = json!({
        "key": "priority_key",
        "direction": "twoWay"
    });
    let manifest_before = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_before).unwrap();

    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Legacy.md");
    let note_before = format!(
        "\u{feff}---\r\namby-id: {note_id}\r\n# keep this comment\r\nPriority: legacy\r\nunknown: {{keep: true}}\r\n---\r\nBody\r\n"
    )
    .into_bytes();
    fs::write(&note_path, &note_before).unwrap();

    let error = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: property.property_id,
            expected_manifest_revision: raw_revision(&manifest_before),
            name: "Importance".to_owned(),
        },
    )
    .unwrap_err();

    assert!(
        error.contains("legacy YAML value"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn legacy_binding_pin_rejects_case_insensitive_yaml_binding_collision() {
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
    let target = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let other = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: target.manifest_revision,
            name: "Other".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let other_json = manifest["properties"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|property| property["id"] == other.property_id)
        .unwrap();
    other_json["yamlBinding"] = json!({
        "key": " status ",
        "direction": "twoWay"
    });
    let manifest_before = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_before).unwrap();

    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Status.md");
    let note_before = format!("---\namby-id: {note_id}\nStatus: old\n---\nBody\n").into_bytes();
    fs::write(&note_path, &note_before).unwrap();

    let error = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: target.property_id,
            expected_manifest_revision: raw_revision(&manifest_before),
            name: "State".to_owned(),
        },
    )
    .unwrap_err();

    assert!(
        error.contains("ambiguous YAML binding"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn legacy_binding_pin_rejects_collision_with_foreign_property_id() {
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
    let foreign = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Foreign".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let target = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: foreign.manifest_revision,
            name: foreign.property_id.clone(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let foreign_json = manifest["properties"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|property| property["id"] == foreign.property_id)
        .unwrap();
    foreign_json["yamlBinding"] = json!({
        "key": "foreign_value",
        "direction": "twoWay"
    });
    let manifest_before = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_before).unwrap();

    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("ForeignId.md");
    let note_before = format!(
        "\u{feff}---\r\namby-id: {note_id}\r\n{}: legacy\r\nforeign_value: current\r\n---\r\nBody\r\n",
        foreign.property_id
    )
    .into_bytes();
    fs::write(&note_path, &note_before).unwrap();

    let error = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: target.property_id,
            expected_manifest_revision: raw_revision(&manifest_before),
            name: "Renamed".to_owned(),
        },
    )
    .unwrap_err();

    assert!(
        error.contains("ambiguous YAML binding"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_rename_rejects_name_based_formula_dependency_without_writing() {
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
    let price = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Price".to_owned(),
            property_type: "number".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let tax = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: price.manifest_revision,
            name: "Tax".to_owned(),
            property_type: "number".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let formula = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: tax.manifest_revision,
            name: "Total".to_owned(),
            property_type: "formula".to_owned(),
            formula_expression: Some("Price + Tax".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let manifest_before = fs::read(manifest_path).unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Invoice.md");
    let note_before =
        format!("---\namby-id: {note_id}\nPrice: 10\nTax: 2\n---\nBody\n").into_bytes();
    fs::write(&note_path, &note_before).unwrap();

    let error = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: price.property_id,
            expected_manifest_revision: raw_revision(&manifest_before),
            name: "Cost".to_owned(),
        },
    )
    .unwrap_err();

    assert!(
        error.contains("break formula dependencies"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    assert_eq!(formula.name, "Total");
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
