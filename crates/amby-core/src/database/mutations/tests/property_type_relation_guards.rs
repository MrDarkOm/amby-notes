use super::*;

#[test]
fn property_type_change_rejects_stale_or_missing_related_manifest_cas_without_writes() {
    for stale in [true, false] {
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
        let source_path = Path::new(&source.manifest_path);
        let target_path = Path::new(&target.manifest_path);
        let source_before = fs::read(source_path).unwrap();
        let target_before = fs::read(target_path).unwrap();
        let expected_related_manifest_revisions = if stale {
            vec![DatabaseManifestRevision {
                database_id: target.database_id.clone(),
                revision: "0".repeat(64),
            }]
        } else {
            Vec::new()
        };
        let error = change_database_property_type(
            &vault,
            &watcher,
            &ChangeDatabasePropertyTypeRequest {
                expected_generation: 1,
                database_id: source.database_id.clone(),
                property_id: property.property_id,
                expected_manifest_revision: raw_revision(&source_before),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(target.database_id.clone()),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some("Tasks".to_owned()),
                operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
                expected_related_manifest_revisions,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(error.to_ascii_lowercase().contains("revision"));
        assert_eq!(fs::read(source_path).unwrap(), source_before);
        assert_eq!(fs::read(target_path).unwrap(), target_before);
        let _ = fs::remove_dir_all(vault);
    }
}

#[test]
fn property_type_change_source_yaml_binding_error_precedes_target_planning() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let mut source_value: serde_json::Value =
        serde_json::from_slice(&fs::read(source_path).unwrap()).unwrap();
    source_value["properties"][0]["yamlBinding"] = json!({
        "key": "Status",
        "direction": "twoWay",
    });
    fs::write(source_path, json_bytes(&source_value).unwrap()).unwrap();
    let source_before = fs::read(source_path).unwrap();
    let target_path = Path::new(&target.manifest_path);
    let target_before = fs::read(target_path).unwrap();
    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: property.property_id,
            expected_manifest_revision: raw_revision(&source_before),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.to_ascii_lowercase().contains("yaml"));
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_formula_dependency_error_precedes_target_planning() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let base = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Base".to_owned(),
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
            database_id: source.database_id.clone(),
            expected_manifest_revision: base.manifest_revision,
            name: "Derived".to_owned(),
            property_type: "formula".to_owned(),
            formula_expression: Some("Base + 1".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(formula.name, "Derived");
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();
    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: base.property_id,
            expected_manifest_revision: raw_revision(&source_before),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("depend")
            || error.to_ascii_lowercase().contains("formula"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_durable_source_values_error_precedes_target_planning() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let record_path = Path::new(&source.manifest_path)
        .parent()
        .unwrap()
        .join(".ambd/records")
        .join(format!("{note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::write(
        &record_path,
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": source.database_id,
            "noteId": note_id,
            "values": {
                property.property_id.clone(): {"type": "text", "value": "keep"}
            },
            "yamlSyncBases": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();
    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: property.property_id,
            expected_manifest_revision: raw_revision(&source_before),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.to_ascii_lowercase().contains("existing values"));
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_rejects_topology_change_with_durable_inverse_values() {
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
    let target_manifest = parse_manifest(&fs::read(&target.manifest_path).unwrap()).unwrap();
    let inverse_id = target_manifest.value.properties[0].id().unwrap().to_owned();
    let target_note_id = ulid::Ulid::generate().to_string();
    let record_path = Path::new(&target.manifest_path)
        .parent()
        .unwrap()
        .join(".ambd/records")
        .join(format!("{target_note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::write(
        &record_path,
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": target.database_id,
            "noteId": target_note_id,
            "values": {
                inverse_id: {"type": "relation", "value": [source.database_id]}
            },
            "yamlSyncBases": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();
    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: property.property_id,
            expected_manifest_revision: raw_revision(&source_before),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(false),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("value")
            || error.to_ascii_lowercase().contains("durable"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_allows_cleared_relation_values_as_empty_sequences() {
    let fixture = relation_fixture();
    let linked = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    )
    .unwrap();
    assert_relation_revisions(&linked, &fixture);

    let unlinked = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fs::read(&fixture.source_note_path).unwrap()),
            Vec::new(),
        ),
        None,
    )
    .unwrap();
    assert_relation_revisions(&unlinked, &fixture);

    // A cleared relation is represented by an empty sequence. Keep the
    // explicit empty form in this fixture even when the lossless value
    // splice removes an empty binding, so schema conversion exercises the
    // empty-value path for both sides of the reciprocal relation.
    for (path, key) in [
        (&fixture.source_note_path, "Related"),
        (&fixture.target_note_path, "Sources"),
    ] {
        let content = fs::read_to_string(path).unwrap();
        let mapping = frontmatter::frontmatter_yaml_mapping(&content)
            .unwrap()
            .unwrap();
        let value = mapping
            .get(serde_yaml::Value::String(key.to_owned()))
            .cloned()
            .unwrap_or(serde_yaml::Value::Sequence(Vec::new()));
        assert!(matches!(
            value,
            serde_yaml::Value::Sequence(ref items) if items.is_empty()
        ));
        if !mapping.contains_key(serde_yaml::Value::String(key.to_owned())) {
            let content = frontmatter::replace_yaml_binding_lossless(
                &content,
                key,
                &serde_yaml::Value::Sequence(Vec::new()),
            )
            .unwrap();
            fs::write(path, content).unwrap();
        }
    }

    let target_before_manifest = parse_manifest(&fixture.target_manifest_bytes).unwrap();
    let target_inverse_id = target_before_manifest.value.properties[0]
        .id()
        .unwrap()
        .to_owned();
    let source_manifest_path = fixture.source_manifest_path.clone();
    let target_manifest_path = fixture.target_manifest_path.clone();
    let changed = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: fixture.source_database_id.clone(),
            property_id: fixture.source_property_id.clone(),
            expected_manifest_revision: raw_revision(&fs::read(&source_manifest_path).unwrap()),
            property_type: "relation".to_owned(),
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
    let source_manifest = parse_manifest(&fs::read(source_manifest_path).unwrap()).unwrap();
    assert!(source_manifest
        .value
        .properties
        .iter()
        .any(|property| property.id() == Some(fixture.source_property_id.as_str())));
    let target_manifest = parse_manifest(&fs::read(target_manifest_path).unwrap()).unwrap();
    assert_eq!(target_manifest.value.properties.len(), 1);
    let target_inverse = serde_json::to_value(&target_manifest.value.properties[0]).unwrap();
    assert_eq!(target_inverse["id"], target_inverse_id);
    assert_eq!(target_inverse["type"], "relation");
    assert_eq!(
        target_inverse["config"]["targetDatabaseId"],
        fixture.source_database_id
    );
    assert!(target_inverse["config"]["inversePropertyId"].is_null());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn property_type_change_rejects_nonempty_case_insensitive_trimmed_relation_key() {
    let fixture = relation_fixture();
    let source_content = format!(
        "---\namby-id: {}\n\" related \" : [\"[[{}]]\"]\n---\n# Source\n",
        fixture.source_note_id, fixture.target_note_id
    );
    fs::write(&fixture.source_note_path, &source_content).unwrap();

    let source_before = fs::read(&fixture.source_note_path).unwrap();
    let source_manifest_before = fs::read(&fixture.source_manifest_path).unwrap();
    let target_note_before = fs::read(&fixture.target_note_path).unwrap();
    let target_before = fs::read(&fixture.target_manifest_path).unwrap();
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let error = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: fixture.source_database_id.clone(),
            property_id: fixture.source_property_id.clone(),
            expected_manifest_revision: raw_revision(&fixture.source_manifest_bytes),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(
                parse_manifest(&fixture.target_manifest_bytes)
                    .unwrap()
                    .value
                    .database_id,
            ),
            relation_two_way: Some(false),
            operation_id: Some(operation_id.clone()),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: parse_manifest(&fixture.target_manifest_bytes)
                    .unwrap()
                    .value
                    .database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("value")
            || error.to_ascii_lowercase().contains("clear"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_before);
    assert_eq!(
        fs::read(&fixture.source_manifest_path).unwrap(),
        source_manifest_before
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        target_note_before
    );
    assert_eq!(
        fs::read(&fixture.target_manifest_path).unwrap(),
        target_before
    );
    assert!(!fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"))
        .exists());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn property_type_change_rejects_legacy_nonempty_alias_next_to_empty_relation_key() {
    let fixture = relation_fixture();
    let source_content = format!(
        "---\namby-id: {}\nRelated: []\nrelated: [\"[[{}]]\"]\n---\n# Source\n",
        fixture.source_note_id, fixture.target_note_id
    );
    fs::write(&fixture.source_note_path, &source_content).unwrap();

    let source_before = fs::read(&fixture.source_note_path).unwrap();
    let source_manifest_before = fs::read(&fixture.source_manifest_path).unwrap();
    let target_note_before = fs::read(&fixture.target_note_path).unwrap();
    let target_before = fs::read(&fixture.target_manifest_path).unwrap();
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let error = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: fixture.source_database_id.clone(),
            property_id: fixture.source_property_id.clone(),
            expected_manifest_revision: raw_revision(&fixture.source_manifest_bytes),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(
                parse_manifest(&fixture.target_manifest_bytes)
                    .unwrap()
                    .value
                    .database_id,
            ),
            relation_two_way: Some(false),
            operation_id: Some(operation_id.clone()),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: parse_manifest(&fixture.target_manifest_bytes)
                    .unwrap()
                    .value
                    .database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("value")
            || error.to_ascii_lowercase().contains("clear"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_before);
    assert_eq!(
        fs::read(&fixture.source_manifest_path).unwrap(),
        source_manifest_before
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        target_note_before
    );
    assert_eq!(
        fs::read(&fixture.target_manifest_path).unwrap(),
        target_before
    );
    assert!(!fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"))
        .exists());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn property_type_change_blocks_malformed_outer_yaml_but_ignores_nested_values() {
    let fixture = relation_fixture();
    let source_container = Path::new(&fixture.source_manifest_path)
        .parent()
        .unwrap()
        .to_path_buf();
    let nested = create_database(
        &fixture.vault,
        &fixture.watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(source_container.to_string_lossy().to_string()),
            note_path: None,
            name: "Nested".to_owned(),
        },
    )
    .unwrap();
    let nested_note_id = ulid::Ulid::generate().to_string();
    let nested_note_path = Path::new(&nested.manifest_path)
        .parent()
        .unwrap()
        .join("Child.md");
    fs::write(
        &nested_note_path,
        format!(
            "---\namby-id: {nested_note_id}\nRelated: [\"[[{}]]\"]\n---\n# Nested\n",
            fixture.target_note_id
        ),
    )
    .unwrap();

    let target_database_id = parse_manifest(&fixture.target_manifest_bytes)
        .unwrap()
        .value
        .database_id;
    let source_manifest_before = fs::read(&fixture.source_manifest_path).unwrap();
    let target_manifest_before = fs::read(&fixture.target_manifest_path).unwrap();
    let source_revision = raw_revision(&source_manifest_before);
    let target_revision = raw_revision(&target_manifest_before);
    let make_request = |operation_id: String| ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: fixture.source_database_id.clone(),
        property_id: fixture.source_property_id.clone(),
        expected_manifest_revision: source_revision.clone(),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target_database_id.clone()),
        relation_two_way: Some(false),
        operation_id: Some(operation_id),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target_database_id.clone(),
            revision: target_revision.clone(),
        }],
        ..Default::default()
    };

    let malformed = format!(
        "---\namby-id: {}\nRelated: [\n---\n# Source\n",
        fixture.source_note_id
    );
    fs::write(&fixture.source_note_path, &malformed).unwrap();
    let malformed_operation = format!("relation-schema-{}", ulid::Ulid::generate());
    let error = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &make_request(malformed_operation.clone()),
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("yaml")
            || error.to_ascii_lowercase().contains("inspect"),
        "unexpected error: {error}"
    );
    assert_eq!(
        fs::read(&fixture.source_manifest_path).unwrap(),
        source_manifest_before
    );
    assert_eq!(
        fs::read(&fixture.target_manifest_path).unwrap(),
        target_manifest_before
    );
    assert!(!fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{malformed_operation}.json"))
        .exists());

    // Once the owned note is safely empty, a nonempty value in the nested
    // database must not be treated as a value belonging to the outer DB.
    let empty = format!(
        "---\namby-id: {}\nRelated: []\n---\n# Source\n",
        fixture.source_note_id
    );
    fs::write(&fixture.source_note_path, empty).unwrap();
    let changed = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &make_request(format!("relation-schema-{}", ulid::Ulid::generate())),
    )
    .unwrap();
    assert_eq!(changed.manifest_revisions.len(), 2);
    let target_after = parse_manifest(&fs::read(&fixture.target_manifest_path).unwrap()).unwrap();
    assert_eq!(target_after.value.properties.len(), 1);
    let target_inverse = serde_json::to_value(&target_after.value.properties[0]).unwrap();
    assert!(target_inverse["config"]["inversePropertyId"].is_null());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn a_relation_limit_can_be_set_and_removed_with_links_and_never_rewrites_them() {
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
    // A record that already links two pages.
    let note_id = ulid::Ulid::generate().to_string();
    let record_path = Path::new(&source.manifest_path)
        .parent()
        .unwrap()
        .join(".ambd/records")
        .join(format!("{note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::write(
        &record_path,
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": source.database_id,
            "noteId": note_id,
            "values": {
                property.property_id.clone(): {
                    "type": "relation",
                    "targetNoteIds": [
                        ulid::Ulid::generate().to_string(),
                        ulid::Ulid::generate().to_string()
                    ]
                }
            },
            "yamlSyncBases": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let record_before = fs::read(&record_path).unwrap();
    let request = |max_items: u8, revision: String| ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: revision,
        property_type: "relation".to_owned(),
        operation_id: Some(format!("schema-limit-{}", ulid::Ulid::generate())),
        relation_target_database_id: Some(target.database_id.clone()),
        relation_two_way: Some(false),
        relation_max_items: Some(max_items),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target.database_id.clone(),
            revision: current_manifest_revision(&target),
        }],
        ..Default::default()
    };
    // A one-page limit is accepted although the record has two links; its links are not touched.
    let limited = change_database_property_type(
        &vault,
        &watcher,
        &request(1, current_manifest_revision(&source)),
    )
    .unwrap();
    assert_eq!(stored_config(&source, &property.property_id)["maxItems"], 1);
    assert_eq!(fs::read(&record_path).unwrap(), record_before);
    // And it can be removed again.
    change_database_property_type(&vault, &watcher, &request(0, limited.manifest_revision))
        .unwrap();
    assert!(stored_config(&source, &property.property_id)["maxItems"].is_null());
    assert_eq!(fs::read(&record_path).unwrap(), record_before);
    let _ = fs::remove_dir_all(vault);
}
