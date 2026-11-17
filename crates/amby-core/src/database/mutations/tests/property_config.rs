use super::*;

fn config_request(
    created: &CreatedDatabase,
    property: &CreatedDatabaseProperty,
    revision: &str,
) -> UpdateDatabasePropertyConfigRequest {
    UpdateDatabasePropertyConfigRequest {
        expected_generation: 1,
        database_id: created.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: revision.to_owned(),
        ..Default::default()
    }
}

#[test]
fn property_config_edits_text_and_number_and_refuses_what_does_not_apply() {
    let (vault, watcher, created, text) = option_fixture("text", &[]);
    let updated = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            multiline: Some(true),
            ..config_request(&created, &text, &text.manifest_revision)
        },
    )
    .unwrap();
    assert_eq!(
        stored_config(&created, &text.property_id)["multiline"],
        true
    );
    // A date setting on a text property, and an empty request, are mistakes.
    for request in [
        UpdateDatabasePropertyConfigRequest {
            include_time: Some(true),
            ..config_request(&created, &text, &updated.manifest_revision)
        },
        config_request(&created, &text, &updated.manifest_revision),
    ] {
        let error = update_database_property_config(&vault, &watcher, &request).unwrap_err();
        assert!(error.contains("do not apply"), "{error}");
    }
    let _ = fs::remove_dir_all(vault);

    let (vault, watcher, created, number) = option_fixture("number", &[]);
    let currency = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            number_format: Some("currency".to_owned()),
            currency: Some(" usd ".to_owned()),
            ..config_request(&created, &number, &number.manifest_revision)
        },
    )
    .unwrap();
    let config = stored_config(&created, &number.property_id);
    assert_eq!(
        (config["format"].as_str(), config["currency"].as_str()),
        (Some("currency"), Some("USD"))
    );
    for (patch, expected) in [
        (
            UpdateDatabasePropertyConfigRequest {
                number_format: Some("currency".to_owned()),
                currency: Some("US".to_owned()),
                ..config_request(&created, &number, &currency.manifest_revision)
            },
            "three-letter",
        ),
        (
            UpdateDatabasePropertyConfigRequest {
                number_format: Some("hex".to_owned()),
                ..config_request(&created, &number, &currency.manifest_revision)
            },
            "Unknown number format",
        ),
    ] {
        let error = update_database_property_config(&vault, &watcher, &patch).unwrap_err();
        assert!(error.contains(expected), "{error}");
    }
    // Leaving the currency format drops the code, so it cannot linger invisibly.
    update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            number_format: Some("percent".to_owned()),
            ..config_request(&created, &number, &currency.manifest_revision)
        },
    )
    .unwrap();
    let config = stored_config(&created, &number.property_id);
    assert_eq!(
        (config["format"].as_str(), config["currency"].is_null()),
        (Some("percent"), true)
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn date_display_formats_are_free_but_time_and_range_wait_for_the_values_to_go() {
    let (vault, watcher, created, date) = option_fixture("date", &[]);
    let shown = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            date_format: Some("dayMonthYear".to_owned()),
            time_format: Some("12h".to_owned()),
            ..config_request(&created, &date, &date.manifest_revision)
        },
    )
    .unwrap();
    let config = stored_config(&created, &date.property_id);
    assert_eq!(config["dateFormat"], "dayMonthYear");
    assert_eq!(config["timeFormat"], "12h");
    // Defaults are not stored.
    let reset = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            date_format: Some("full".to_owned()),
            time_format: Some("24h".to_owned()),
            ..config_request(&created, &date, &shown.manifest_revision)
        },
    )
    .unwrap();
    let config = stored_config(&created, &date.property_id);
    assert!(config.get("dateFormat").is_none() && config.get("timeFormat").is_none());
    let error = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            date_format: Some("whenever".to_owned()),
            ..config_request(&created, &date, &reset.manifest_revision)
        },
    )
    .unwrap_err();
    assert!(error.contains("Unknown date format"));

    // Without values the time can be switched on and ranges allowed.
    let timed = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            include_time: Some(true),
            allow_range: Some(true),
            ..config_request(&created, &date, &reset.manifest_revision)
        },
    )
    .unwrap();
    // With a value stored, narrowing what a value may look like is refused, and nothing changes.
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
                date.property_id.clone(): {"type": "date", "start": "2026-10-03T09:00:00Z"}
            },
            "yamlSyncBases": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let before = fs::read(&created.manifest_path).unwrap();
    for patch in [
        UpdateDatabasePropertyConfigRequest {
            include_time: Some(false),
            ..config_request(&created, &date, &timed.manifest_revision)
        },
        UpdateDatabasePropertyConfigRequest {
            allow_range: Some(false),
            ..config_request(&created, &date, &timed.manifest_revision)
        },
    ] {
        let error = update_database_property_config(&vault, &watcher, &patch).unwrap_err();
        assert!(error.contains("existing values are cleared"), "{error}");
        assert_eq!(fs::read(&created.manifest_path).unwrap(), before);
    }
    // Display formats still change with values present; allowing ranges only widens.
    update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            date_format: Some("relative".to_owned()),
            allow_range: Some(true),
            ..config_request(&created, &date, &timed.manifest_revision)
        },
    )
    .unwrap();
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn formula_expression_is_validated_and_stale_edits_are_refused() {
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
            name: "Calc".to_owned(),
        },
    )
    .unwrap();
    let formula = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "Total".to_owned(),
            property_type: "formula".to_owned(),
            formula_expression: Some("1 + 1".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();
    let ok = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            formula_expression: Some("  2 * 3 ".to_owned()),
            ..config_request(&created, &formula, &formula.manifest_revision)
        },
    )
    .unwrap();
    assert_eq!(
        stored_config(&created, &formula.property_id)["expression"],
        "2 * 3"
    );
    let before = fs::read(&created.manifest_path).unwrap();
    for (expression, expected) in [("   ", "required"), ("1 +", "Invalid formula")] {
        let error = update_database_property_config(
            &vault,
            &watcher,
            &UpdateDatabasePropertyConfigRequest {
                formula_expression: Some(expression.to_owned()),
                ..config_request(&created, &formula, &ok.manifest_revision)
            },
        )
        .unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert_eq!(fs::read(&created.manifest_path).unwrap(), before);
    }
    let stale = update_database_property_config(
        &vault,
        &watcher,
        &UpdateDatabasePropertyConfigRequest {
            formula_expression: Some("4".to_owned()),
            ..config_request(&created, &formula, "stale")
        },
    )
    .unwrap_err();
    assert!(stale.contains("revision conflict"));
    let _ = fs::remove_dir_all(vault);
}
