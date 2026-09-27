use super::*;

fn manifest_json() -> Vec<u8> {
    r###"{
  "format": "amby-database",
  "formatVersion": 1,
  "databaseId": "01J00000000000000000000000",
  "name": "Characters",
  "icon": "📚",
  "cover": null,
  "locked": false,
  "membership": {"kind": "filesystem-descendants", "recursive": true},
  "properties": [{
    "id": "01J00000000000000000000001",
    "name": "Role",
    "type": "select",
    "pageVisibility": "alwaysShow",
    "yamlBinding": null,
    "config": {"options": [{"id": "01J00000000000000000000002", "name": "Hero", "color": "#fff"}]}
  }],
  "viewOrder": [],
  "defaultViewId": null,
  "templateOrder": [],
  "defaultTemplateId": null,
  "futureField": {"preserve": true}
}
"###
    .as_bytes()
    .to_vec()
}

#[test]
fn parses_unknown_fields_and_prepares_them_again() {
    let parsed = parse_manifest(&manifest_json()).unwrap();
    assert!(parsed.is_writable());
    assert_eq!(parsed.value.extra["futureField"]["preserve"], true);
    let mut changed = parsed.value.clone();
    changed.name = "Characters renamed".to_owned();
    let prepared = prepare_json(&parsed, &changed).unwrap();
    let reparsed = parse_manifest(&prepared.bytes).unwrap();
    assert_eq!(reparsed.value.name, "Characters renamed");
    assert_eq!(reparsed.value.extra["futureField"]["preserve"], true);
}

#[test]
fn bom_is_read_only_and_revision_is_raw_bytes() {
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend(manifest_json());
    let parsed = parse_manifest(&bytes).unwrap();
    assert_eq!(parsed.read_only, Some(ReadOnlyReason::Utf8Bom));
    assert_eq!(parsed.revision, raw_revision(&bytes));
    assert!(matches!(
        prepare_json(&parsed, &parsed.value),
        Err(FormatError::ReadOnly(_))
    ));
}

#[test]
fn unsupported_version_never_produces_writer_bytes() {
    let bytes = manifest_json();
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    value["formatVersion"] = Value::from(99);
    let encoded = serde_json::to_vec(&value).unwrap();
    assert!(matches!(
        parse_manifest(&encoded),
        Err(FormatError::UnsupportedFormatVersion { actual: 99 })
    ));
}

#[test]
fn opaque_property_and_filter_entries_round_trip() {
    let property: PropertyDefinition = serde_json::from_value(serde_json::json!({
        "type": "future",
        "id": "01J00000000000000000000003",
        "payload": {"keep": [1, 2, 3]}
    }))
    .unwrap();
    assert!(matches!(property, PropertyDefinition::Opaque(_)));
    assert_eq!(
        serde_json::to_value(property).unwrap()["payload"]["keep"][1],
        2
    );

    let filter: FilterNode =
        serde_json::from_value(serde_json::json!({"kind": "future", "data": true})).unwrap();
    assert!(matches!(filter, FilterNode::Opaque(_)));
    assert_eq!(serde_json::to_value(filter).unwrap()["data"], true);
}

#[test]
fn golden_database_fixtures_parse_and_validate() {
    let manifest = parse_manifest(include_bytes!(
        "../../fixtures/database-format/manifest.json"
    ))
    .unwrap();
    let record =
        parse_record(include_bytes!("../../fixtures/database-format/record.json")).unwrap();
    let view = parse_view(include_bytes!("../../fixtures/database-format/view.json")).unwrap();
    let template = parse_template(include_bytes!(
        "../../fixtures/database-format/template.json"
    ))
    .unwrap();

    assert!(crate::database::validation::validate_manifest(&manifest.value).is_writable());
    assert!(
        crate::database::validation::validate_record(&record.value, Some(&manifest.value))
            .is_valid()
    );
    assert!(
        crate::database::validation::validate_view(&view.value, Some(&manifest.value))
            .is_writable()
    );
    assert!(
        crate::database::validation::validate_template(&template.value, Some(&manifest.value))
            .is_valid()
    );
    assert_eq!(
        manifest.value.extra["futureManifestSetting"]["preserve"],
        true
    );
    assert_eq!(record.value.extra["futureRecordSetting"][0], "preserve");
    assert_eq!(
        template.value.extra["futureTemplateSetting"]["preserve"],
        true
    );
}

#[test]
fn rejects_excessive_json_depth_before_typed_deserialization() {
    let mut bytes = vec![b'['; MAX_JSON_DEPTH + 2];
    bytes.extend(std::iter::repeat_n(b']', MAX_JSON_DEPTH + 2));
    assert!(matches!(
        parse_manifest(&bytes),
        Err(FormatError::TooDeep { .. })
    ));
}

#[test]
fn r2_lossless_conversions_roundtrip() {
    // 1. Decimal precision: 1234567890.123456789 round-trips without f64 precision loss
    let num_val = PropertyValue::Number {
        decimal: "1234567890.123456789".to_string(),
        extra: Default::default(),
    };
    let num_def = PropertyDefinition::Number(PropertyFields {
        id: "prop1".into(),
        name: "Num".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: NumberConfig {
            format: "number".into(),
            currency: None,
            extra: Default::default(),
        },
        extra: Default::default(),
    });
    let yaml = property_value_to_frontmatter_value(&num_val, &num_def).unwrap();
    let back = frontmatter_value_to_property_value(&yaml, &num_def);
    assert_eq!(back, Some(num_val));

    // 2. Date range and time_zone: start, end, and time_zone round-trip without loss
    let date_val = PropertyValue::Date {
        start: "2026-09-20T10:00:00".into(),
        end: Some("2026-09-21T18:00:00".into()),
        time_zone: Some("Europe/Moscow".into()),
        extra: Default::default(),
    };
    let date_def = PropertyDefinition::Date(PropertyFields {
        id: "prop2".into(),
        name: "Due".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: DateConfig {
            include_time: true,
            allow_range: true,
            extra: Default::default(),
        },
        extra: Default::default(),
    });
    let date_yaml = property_value_to_frontmatter_value(&date_val, &date_def).unwrap();
    let date_back = frontmatter_value_to_property_value(&date_yaml, &date_def);
    assert_eq!(date_back, Some(date_val));

    // 3. Files: structured file metadata (assetId, kind, relativePath, name, mimeType, sizeBytes) round-trips without loss
    let files_val = PropertyValue::Files {
        items: vec![FileValue {
            asset_id: "01J00000000000000000000009".into(),
            kind: "asset".into(),
            relative_path: "assets/report.pdf".into(),
            name: "report.pdf".into(),
            mime_type: "application/pdf".into(),
            size_bytes: 4096,
            extra: Default::default(),
        }],
        extra: Default::default(),
    };
    let files_def = PropertyDefinition::Files(PropertyFields {
        id: "prop3".into(),
        name: "Attachments".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: FilesConfig {
            media_only: false,
            max_items: None,
            extra: Default::default(),
        },
        extra: Default::default(),
    });
    let files_yaml = property_value_to_frontmatter_value(&files_val, &files_def).unwrap();
    let files_back = frontmatter_value_to_property_value(&files_yaml, &files_def);
    assert_eq!(files_back, Some(files_val));
}

#[test]
fn st02_property_storage_key_and_deterministic_resolution() {
    let text_def = PropertyDefinition::Text(PropertyFields {
        id: "01JTEXT00000000000000000001".into(),
        name: "Due Date".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: Some(YamlBinding {
            key: "due_date".into(),
            direction: "twoWay".into(),
            extra: Default::default(),
        }),
        config: TextConfig {
            multiline: false,
            extra: Default::default(),
        },
        extra: Default::default(),
    });

    assert_eq!(text_def.storage_key(), Some("due_date"));
    assert_eq!(text_def.name(), Some("Due Date"));
    assert_eq!(text_def.id(), Some("01JTEXT00000000000000000001"));

    // Case 1: exact storage_key wins over name
    let yaml_str = "due_date: \"2026-09-20\"\nDue Date: \"2025-01-01\"\n";
    let mapping: serde_yaml::Mapping = serde_yaml::from_str(yaml_str).unwrap();
    let resolved = resolve_property_yaml_value(&mapping, &text_def);
    assert_eq!(
        resolved,
        Some(&serde_yaml::Value::String("2026-09-20".into()))
    );

    // Case 2: exact property_id wins over fallback name
    let id_def = PropertyDefinition::Text(PropertyFields {
        id: "prop_ulid".into(),
        name: "My Field".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: TextConfig {
            multiline: false,
            extra: Default::default(),
        },
        extra: Default::default(),
    });
    let yaml_str2 = "prop_ulid: \"by-id-val\"\nMy Field: \"by-name-val\"\n";
    let mapping2: serde_yaml::Mapping = serde_yaml::from_str(yaml_str2).unwrap();
    let resolved2 = resolve_property_yaml_value(&mapping2, &id_def);
    assert_eq!(
        resolved2,
        Some(&serde_yaml::Value::String("by-id-val".into()))
    );

    // Case 3: case-insensitive storage_key wins over name
    let yaml_str3 = "DUE_DATE: \"2026-10-10\"\n";
    let mapping3: serde_yaml::Mapping = serde_yaml::from_str(yaml_str3).unwrap();
    let resolved3 = resolve_property_yaml_value(&mapping3, &text_def);
    assert_eq!(
        resolved3,
        Some(&serde_yaml::Value::String("2026-10-10".into()))
    );

    // Case 4: fallback to display name when storage_key is absent
    let yaml_str4 = "Due Date: \"2026-12-31\"\n";
    let mapping4: serde_yaml::Mapping = serde_yaml::from_str(yaml_str4).unwrap();
    let resolved4 = resolve_property_yaml_value(&mapping4, &text_def);
    assert_eq!(
        resolved4,
        Some(&serde_yaml::Value::String("2026-12-31".into()))
    );

    // Protection: amby-id is never matched by a property named "id" or "amby-id"
    let user_id_prop = PropertyDefinition::Text(PropertyFields {
        id: "01JID00000000000000000000001".into(),
        name: "id".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: TextConfig {
            multiline: false,
            extra: Default::default(),
        },
        extra: Default::default(),
    });
    let yaml_str5 = "amby-id: \"01JSECRET00000000000000001\"\nid: \"user-custom-id\"\n";
    let mapping5: serde_yaml::Mapping = serde_yaml::from_str(yaml_str5).unwrap();
    let resolved5 = resolve_property_yaml_value(&mapping5, &user_id_prop);
    assert_eq!(
        resolved5,
        Some(&serde_yaml::Value::String("user-custom-id".into()))
    );

    // And if note has only amby-id, user_id_prop must NOT match it
    let yaml_str6 = "amby-id: \"01JSECRET00000000000000001\"\n";
    let mapping6: serde_yaml::Mapping = serde_yaml::from_str(yaml_str6).unwrap();
    let resolved6 = resolve_property_yaml_value(&mapping6, &user_id_prop);
    assert_eq!(resolved6, None);
}

#[test]
fn st03_select_status_multiselect_rename_resilience() {
    let opt1_id = "01JOPT00000000000000000001";
    let opt2_id = "01JOPT00000000000000000002";
    let select_def = PropertyDefinition::Select(PropertyFields {
        id: "01JSEL000000000000000000001".into(),
        name: "Status".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: SelectConfig {
            options: vec![
                SelectOption {
                    id: opt1_id.into(),
                    name: "In Progress".into(),
                    color: "#3b82f6".into(),
                    aliases: Vec::new(),
                    extra: Default::default(),
                },
                SelectOption {
                    id: opt2_id.into(),
                    name: "Done".into(),
                    color: "#22c55e".into(),
                    aliases: Vec::new(),
                    extra: Default::default(),
                },
            ],
            extra: Default::default(),
        },
        extra: Default::default(),
    });

    // 1. Finding by name (case-insensitive) resolves to option id
    assert_eq!(select_def.find_option_id("in progress"), Some(opt1_id));
    assert_eq!(select_def.find_option_id("Done"), Some(opt2_id));

    // 2. Finding by ID resolves to option id
    assert_eq!(select_def.find_option_id(opt1_id), Some(opt1_id));

    // 3. Serialization to YAML uses option name
    let val = PropertyValue::Select {
        option_id: opt1_id.into(),
        extra: Default::default(),
    };
    let yaml_val = property_value_to_frontmatter_value(&val, &select_def).unwrap();
    assert_eq!(yaml_val, serde_yaml::Value::String("In Progress".into()));

    // 4. Deserialization from YAML with name resolves back to option id
    let parsed = frontmatter_value_to_property_value(&yaml_val, &select_def).unwrap();
    assert_eq!(parsed, val);

    // 5. Deserialization from YAML with raw option ID also resolves to option id
    let id_yaml = serde_yaml::Value::String(opt1_id.into());
    let parsed_id = frontmatter_value_to_property_value(&id_yaml, &select_def).unwrap();
    assert_eq!(parsed_id, val);
}

#[test]
fn st03_empty_and_zero_values_handling() {
    let num_def = PropertyDefinition::Number(PropertyFields {
        id: "prop_num".into(),
        name: "Count".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: NumberConfig {
            format: "number".into(),
            currency: None,
            extra: Default::default(),
        },
        extra: Default::default(),
    });
    let bool_def = PropertyDefinition::Checkbox(PropertyFields {
        id: "prop_bool".into(),
        name: "Active".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: CheckboxConfig {
            extra: Default::default(),
        },
        extra: Default::default(),
    });

    // Zero is preserved and NOT treated as empty
    let zero_val = PropertyValue::Number {
        decimal: "0".into(),
        extra: Default::default(),
    };
    let zero_yaml = property_value_to_frontmatter_value(&zero_val, &num_def).unwrap();
    assert_eq!(zero_yaml, serde_yaml::Value::Number(0.into()));
    let zero_back = frontmatter_value_to_property_value(&zero_yaml, &num_def).unwrap();
    assert_eq!(zero_back, zero_val);

    // False is preserved and NOT treated as empty
    let false_val = PropertyValue::Checkbox {
        checked: false,
        extra: Default::default(),
    };
    let false_yaml = property_value_to_frontmatter_value(&false_val, &bool_def).unwrap();
    assert_eq!(false_yaml, serde_yaml::Value::Bool(false));
    let false_back = frontmatter_value_to_property_value(&false_yaml, &bool_def).unwrap();
    assert_eq!(false_back, false_val);

    // Empty string is None (cleared)
    let empty_num = PropertyValue::Number {
        decimal: "  ".into(),
        extra: Default::default(),
    };
    assert_eq!(
        property_value_to_frontmatter_value(&empty_num, &num_def),
        None
    );
}
#[test]
fn review_persisted_select_survives_option_rename() {
    let opt1_id = "01J00000000000000000000001";
    let opt2_id = "01J00000000000000000000002";
    let mut select_def = PropertyDefinition::Select(PropertyFields {
        id: "01J00000000000000000000003".into(),
        name: "Status".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: SelectConfig {
            options: vec![
                SelectOption {
                    id: opt1_id.into(),
                    name: "In Progress".into(),
                    color: "#3b82f6".into(),
                    aliases: Vec::new(),
                    extra: Default::default(),
                },
                SelectOption {
                    id: opt2_id.into(),
                    name: "Done".into(),
                    color: "#22c55e".into(),
                    aliases: Vec::new(),
                    extra: Default::default(),
                },
            ],
            extra: Default::default(),
        },
        extra: Default::default(),
    });

    // 1. Finding by name (case-insensitive) resolves to option id
    assert_eq!(select_def.find_option_id("in progress"), Some(opt1_id));
    assert_eq!(select_def.find_option_id("Done"), Some(opt2_id));

    // 2. Finding by ID resolves to option id
    assert_eq!(select_def.find_option_id(opt1_id), Some(opt1_id));

    // 3. Serialization to YAML uses option name
    let val = PropertyValue::Select {
        option_id: opt1_id.into(),
        extra: Default::default(),
    };
    let yaml_val = property_value_to_frontmatter_value(&val, &select_def).unwrap();
    assert_eq!(yaml_val, serde_yaml::Value::String("In Progress".into()));

    assert!(select_def.rename_option(opt1_id, "Doing"));

    // 4. Deserialization from YAML with old name resolves back to option id via aliases
    let parsed = frontmatter_value_to_property_value(&yaml_val, &select_def).unwrap();
    assert_eq!(parsed, val);

    // 5. Deserialization from YAML with raw option ID also resolves to option id
    let id_yaml = serde_yaml::Value::String(opt1_id.into());
    let parsed_id = frontmatter_value_to_property_value(&id_yaml, &select_def).unwrap();
    assert_eq!(parsed_id, val);
}

#[test]
fn review2_select_history_is_scoped_to_property() {
    let opt1_id = "01J00000000000000000000001";
    let opt2_id = "01J00000000000000000000002";
    let mut select_def = PropertyDefinition::Select(PropertyFields {
        id: "01J00000000000000000000003".into(),
        name: "Status".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: SelectConfig {
            options: vec![
                SelectOption {
                    id: opt1_id.into(),
                    name: "In Progress".into(),
                    color: "#3b82f6".into(),
                    aliases: Vec::new(),
                    extra: Default::default(),
                },
                SelectOption {
                    id: opt2_id.into(),
                    name: "Done".into(),
                    color: "#22c55e".into(),
                    aliases: Vec::new(),
                    extra: Default::default(),
                },
            ],
            extra: Default::default(),
        },
        extra: Default::default(),
    });

    // 1. Serialization to YAML uses option name
    let val = PropertyValue::Select {
        option_id: opt1_id.into(),
        extra: Default::default(),
    };
    let yaml_val = property_value_to_frontmatter_value(&val, &select_def).unwrap();
    assert_eq!(yaml_val, serde_yaml::Value::String("In Progress".into()));

    // Rename option to "Doing" - records "In Progress" in aliases
    assert!(select_def.rename_option(opt1_id, "Doing"));

    // Another property has an option with the same name "In Progress" but different ID
    let other_opt_id = "01J00000000000000000000099";
    let other_property = PropertyDefinition::Select(PropertyFields {
        id: "01J00000000000000000000098".into(),
        name: "Priority".into(),
        page_visibility: "alwaysShow".into(),
        yaml_binding: None,
        config: SelectConfig {
            options: vec![SelectOption {
                id: other_opt_id.into(),
                name: "In Progress".into(),
                color: "#f59e0b".into(),
                aliases: Vec::new(),
                extra: Default::default(),
            }],
            extra: Default::default(),
        },
        extra: Default::default(),
    });
    let other_val = PropertyValue::Select {
        option_id: other_opt_id.into(),
        extra: Default::default(),
    };
    let other_yaml = property_value_to_frontmatter_value(&other_val, &other_property).unwrap();
    assert_eq!(other_yaml, serde_yaml::Value::String("In Progress".into()));

    // Deserialization with select_def still resolves to opt1_id, not other_opt_id!
    let parsed = frontmatter_value_to_property_value(&yaml_val, &select_def).unwrap();
    assert_eq!(parsed, val);
}
