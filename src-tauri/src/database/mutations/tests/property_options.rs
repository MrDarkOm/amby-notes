use super::*;

fn options_request(
    created: &CreatedDatabase,
    property: &CreatedDatabaseProperty,
    revision: &str,
    options: Vec<DatabaseOptionInput>,
) -> UpdateDatabasePropertyOptionsRequest {
    UpdateDatabasePropertyOptionsRequest {
        expected_generation: 1,
        database_id: created.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: revision.to_owned(),
        options,
    }
}

fn option_input(id: Option<&str>, name: &str, color: &str) -> DatabaseOptionInput {
    DatabaseOptionInput {
        id: id.map(str::to_owned),
        name: name.to_owned(),
        color: color.to_owned(),
        group: None,
        is_default: false,
    }
}

fn stored_options(created: &CreatedDatabase, property_id: &str) -> Vec<serde_json::Value> {
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let property = parsed
        .value
        .properties
        .iter()
        .find(|property| property.id() == Some(property_id))
        .unwrap();
    serde_json::to_value(property).unwrap()["config"]["options"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn property_options_are_edited_keeping_ids_and_never_touching_values() {
    let (vault, watcher, created, property) = option_fixture("select", &["Todo", "Doing"]);
    let before = stored_options(&created, &property.property_id);
    let todo_id = before[0]["id"].as_str().unwrap().to_owned();

    let updated = update_database_property_options(
        &vault,
        &watcher,
        &options_request(
            &created,
            &property,
            &property.manifest_revision,
            vec![
                // Renamed and recolored; the ID is kept.
                option_input(Some(&todo_id), "  To do ", "#EF4444"),
                // A new option.
                option_input(None, "Done", "#22c55e"),
            ],
        ),
    )
    .unwrap();

    assert_eq!(updated.options.len(), 2);
    assert_eq!(updated.options[0].id, todo_id);
    assert_eq!(updated.options[0].name, "To do");
    assert_eq!(updated.options[0].color, "#ef4444");
    assert_ne!(updated.options[1].id, before[1]["id"].as_str().unwrap());
    let stored = stored_options(&created, &property.property_id);
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[1]["name"], "Done");
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.revision, updated.manifest_revision);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_options_reject_unsafe_lists_without_writing() {
    let (vault, watcher, created, property) = option_fixture("multiSelect", &["A"]);
    let manifest_before = fs::read(&created.manifest_path).unwrap();
    let a_id = stored_options(&created, &property.property_id)[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let revision = property.manifest_revision.clone();
    let cases: Vec<(Vec<DatabaseOptionInput>, &str)> = vec![
        (
            vec![option_input(None, "   ", "#94a3b8")],
            "name is required",
        ),
        (
            vec![
                option_input(None, "Same", "#94a3b8"),
                option_input(None, "same", "#94a3b8"),
            ],
            "already exists",
        ),
        (vec![option_input(None, "Red", "red")], "#rrggbb"),
        (
            vec![option_input(None, "Red", "url(javascript:alert(1))")],
            "#rrggbb",
        ),
        (
            vec![option_input(
                Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
                "Ghost",
                "#94a3b8",
            )],
            "Unknown option",
        ),
        (
            vec![
                option_input(Some(&a_id), "One", "#94a3b8"),
                option_input(Some(&a_id), "Two", "#94a3b8"),
            ],
            "ID is repeated",
        ),
    ];
    for (options, expected) in cases {
        let error = update_database_property_options(
            &vault,
            &watcher,
            &options_request(&created, &property, &revision, options),
        )
        .unwrap_err();
        assert!(
            error.contains(expected),
            "{error} should contain {expected}"
        );
        assert_eq!(fs::read(&created.manifest_path).unwrap(), manifest_before);
    }
    let stale = update_database_property_options(
        &vault,
        &watcher,
        &options_request(&created, &property, "stale", vec![]),
    )
    .unwrap_err();
    assert!(stale.contains("revision conflict"));
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn status_options_keep_groups_and_default_new_ones_to_not_started() {
    let (vault, watcher, created, property) =
        option_fixture("status", &["Backlog", "Active", "Shipped"]);
    let before = stored_options(&created, &property.property_id);
    assert_eq!(before[2]["group"], "done");
    let shipped_id = before[2]["id"].as_str().unwrap().to_owned();

    let updated = update_database_property_options(
        &vault,
        &watcher,
        &options_request(
            &created,
            &property,
            &property.manifest_revision,
            vec![
                option_input(Some(&shipped_id), "Released", "#22c55e"),
                DatabaseOptionInput {
                    group: Some("inProgress".to_owned()),
                    ..option_input(None, "Review", "#f59e0b")
                },
                option_input(None, "Idea", "#94a3b8"),
            ],
        ),
    )
    .unwrap();
    assert_eq!(updated.options[0].group.as_deref(), Some("done"));
    assert_eq!(updated.options[1].group.as_deref(), Some("inProgress"));
    assert_eq!(updated.options[2].group.as_deref(), Some("notStarted"));

    let error = update_database_property_options(
        &vault,
        &watcher,
        &options_request(
            &created,
            &property,
            &updated.manifest_revision,
            vec![DatabaseOptionInput {
                group: Some("later".to_owned()),
                ..option_input(None, "Odd", "#94a3b8")
            }],
        ),
    )
    .unwrap_err();
    assert!(error.contains("status group"));
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_options_refuse_properties_without_options() {
    let (vault, watcher, created, property) = option_fixture("text", &[]);
    let error = update_database_property_options(
        &vault,
        &watcher,
        &options_request(&created, &property, &property.manifest_revision, vec![]),
    )
    .unwrap_err();
    assert!(error.contains("no options"));
    let _ = fs::remove_dir_all(vault);
}

fn resolve_option(created: &CreatedDatabase, property_id: &str, name: &str) -> Option<String> {
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    parsed
        .value
        .properties
        .iter()
        .find(|property| property.id() == Some(property_id))
        .unwrap()
        .find_option_id(name)
        .map(str::to_owned)
}

#[test]
fn renamed_option_keeps_resolving_records_written_with_its_old_name() {
    // Records store the option name in their frontmatter and find it by name or alias.
    let (vault, watcher, created, property) = option_fixture("select", &["Todo", "Doing"]);
    let before = stored_options(&created, &property.property_id);
    let todo_id = before[0]["id"].as_str().unwrap().to_owned();
    let doing_id = before[1]["id"].as_str().unwrap().to_owned();

    let first = update_database_property_options(
        &vault,
        &watcher,
        &options_request(
            &created,
            &property,
            &property.manifest_revision,
            vec![
                option_input(Some(&todo_id), "To do", "#94a3b8"),
                option_input(Some(&doing_id), "Doing", "#94a3b8"),
            ],
        ),
    )
    .unwrap();
    assert_eq!(
        resolve_option(&created, &property.property_id, "Todo").as_deref(),
        Some(todo_id.as_str()),
        "the old name still resolves to the same option"
    );
    assert_eq!(
        resolve_option(&created, &property.property_id, "To do").as_deref(),
        Some(todo_id.as_str())
    );

    // A second rename keeps both earlier names, without repeating them.
    let second = update_database_property_options(
        &vault,
        &watcher,
        &options_request(
            &created,
            &property,
            &first.manifest_revision,
            vec![
                option_input(Some(&todo_id), "Backlog", "#94a3b8"),
                option_input(Some(&doing_id), "Doing", "#94a3b8"),
            ],
        ),
    )
    .unwrap();
    let stored = stored_options(&created, &property.property_id);
    assert_eq!(stored[0]["aliases"], serde_json::json!(["Todo", "To do"]));
    assert!(stored[1].get("aliases").is_none());

    // A name always wins over an alias: a new option called "Todo" takes the
    // name, and the old option stops claiming it.
    update_database_property_options(
        &vault,
        &watcher,
        &options_request(
            &created,
            &property,
            &second.manifest_revision,
            vec![
                option_input(Some(&todo_id), "Backlog", "#94a3b8"),
                option_input(Some(&doing_id), "Doing", "#94a3b8"),
                option_input(None, "Todo", "#94a3b8"),
            ],
        ),
    )
    .unwrap();
    let new_id = resolve_option(&created, &property.property_id, "todo").unwrap();
    assert_ne!(new_id, todo_id);
    assert_eq!(
        resolve_option(&created, &property.property_id, "To do").as_deref(),
        Some(todo_id.as_str())
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn a_default_option_is_stored_limited_to_one_and_given_to_new_rows() {
    let (vault, watcher, created, property) = option_fixture("select", &[]);
    let updated = update_database_property_options(
        &vault,
        &watcher,
        &options_request(
            &created,
            &property,
            &property.manifest_revision,
            vec![
                option_input(None, "Idea", "#94a3b8"),
                DatabaseOptionInput {
                    is_default: true,
                    ..option_input(None, "Backlog", "#f59e0b")
                },
            ],
        ),
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let stored = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(
        stored["config"]["defaultOptionIds"],
        json!([updated.options[1].id.clone()])
    );

    // Two defaults on a Select are refused.
    let error = update_database_property_options(
        &vault,
        &watcher,
        &options_request(
            &created,
            &property,
            &updated.manifest_revision,
            vec![
                DatabaseOptionInput {
                    id: Some(updated.options[0].id.clone()),
                    is_default: true,
                    ..option_input(None, "Idea", "#94a3b8")
                },
                DatabaseOptionInput {
                    id: Some(updated.options[1].id.clone()),
                    is_default: true,
                    ..option_input(None, "Backlog", "#f59e0b")
                },
            ],
        ),
    )
    .unwrap_err();
    assert!(error.contains("default"), "{error}");

    // A new row starts with the default option, stored by its name.
    let row = crate::database::rows::create_database_row(
        &vault,
        &watcher,
        &crate::database::rows::CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            title: "First".to_owned(),
            template: crate::database::rows::DatabaseRowTemplate::Empty,
        },
    )
    .unwrap();
    let note = fs::read_to_string(&row.note_path).unwrap();
    assert!(note.contains("Backlog"), "{note}");
    let _ = fs::remove_dir_all(vault);
}
