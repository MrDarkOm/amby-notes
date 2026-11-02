use super::*;

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
fn a_new_status_property_gets_valid_option_groups_and_the_manifest_stays_readable() {
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
            name: "Stages".to_owned(),
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
            name: "Stage".to_owned(),
            property_type: "status".to_owned(),
            before_property_id: None,
            options: vec!["Todo".to_owned(), "Doing".to_owned(), "Done".to_owned()],
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let manifest = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert!(validate_manifest(&manifest.value).errors.is_empty());
    let json = serde_json::to_value(&manifest.value.properties[0]).unwrap();
    let groups: Vec<&str> = json["config"]["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["group"].as_str().unwrap())
        .collect();
    assert_eq!(groups, ["notStarted", "inProgress", "done"]);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn a_manifest_written_by_older_builds_without_status_groups_still_parses() {
    let raw = br##"{
      "format":"amby-database","formatVersion":1,
      "databaseId":"01J00000000000000000000000","name":"Old","locked":false,
      "membership":{"kind":"filesystem-descendants","recursive":true},
      "properties":[{"id":"01J00000000000000000000001","name":"Stage","type":"status","pageVisibility":"alwaysShow","yamlBinding":null,
        "config":{"options":[{"id":"01J00000000000000000000002","name":"Todo","color":"#94a3b8"}]}}],
      "viewOrder":[],"defaultViewId":null,"templateOrder":[],"defaultTemplateId":null
    }"##;
    let manifest = parse_manifest(raw).unwrap();
    assert!(validate_manifest(&manifest.value).errors.is_empty());
}

#[test]
fn a_new_property_named_like_a_kept_key_gets_a_key_of_its_own() {
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
    let phase = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "Phase".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    // "Phase" was once called "Stage": a rename pins the old name as its storage key.
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&created.manifest_path).unwrap()).unwrap();
    manifest["properties"][0]["yamlBinding"] = json!({"direction": "twoWay", "key": "Stage"});
    let mut bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    bytes.push(b'\n');
    fs::write(&created.manifest_path, &bytes).unwrap();
    let revision = parse_manifest(&bytes).unwrap().revision;
    let _ = phase;

    // Any name can be used: "Stage" gets a key of its own instead of sharing the old one.
    let stage = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: revision,
            name: "Stage".to_owned(),
            property_type: "status".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let new_property = manifest["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["id"] == stage.property_id)
        .unwrap();
    assert_eq!(new_property["name"], "Stage");
    assert_eq!(new_property["yamlBinding"]["key"], "Stage 2");
    let _ = fs::remove_dir_all(vault);
}
