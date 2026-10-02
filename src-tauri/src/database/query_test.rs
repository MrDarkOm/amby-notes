use super::*;
use crate::database::model::{DatabaseFilterNode, DatabasePageRequest, DatabaseQuerySpec};
use crate::index::schema::init_schema;
use rusqlite::params;

fn connection() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES ('01J00000000000000000000000', 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            [],
        )
        .unwrap();
    for (id, title) in [
        ("01J00000000000000000000001", "Alpha"),
        ("01J00000000000000000000002", "Beta"),
        ("01J00000000000000000000003", "Gamma"),
    ] {
        conn.execute(
                "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, '', 0, 0, 0)",
                params![id, format!("{title}.md"), title],
            )
            .unwrap();
        conn.execute(
                "INSERT INTO db_members (database_id, note_id, relative_path, category_path, depth, title_sort_key) VALUES ('01J00000000000000000000000', ?1, ?2, '[]', 0, ?3)",
                params![id, format!("{title}.md"), title.to_lowercase().into_bytes()],
            )
            .unwrap();
    }
    conn.execute(
            "INSERT INTO index_metadata (key, value) VALUES ('database_projection_epoch', '01J00000000000000000000009'), ('database_projection_seq', '0')",
            [],
        )
        .unwrap();
    conn
}

fn request(filter: Option<DatabaseFilterNode>, page: DatabasePageRequest) -> DatabaseQueryRequest {
    DatabaseQueryRequest {
        expected_generation: 1,
        database_id: "01J00000000000000000000000".to_owned(),
        source: DatabaseQuerySource::Inline {
            spec: DatabaseQuerySpec {
                filter,
                sorts: Vec::new(),
            },
        },
        page,
        context_page_id: None,
        search: None,
        sorts: None,
        filter: None,
    }
}

#[test]
fn aggregate_count_is_calculated_before_pagination() {
    let conn = connection();
    let result = aggregate_database(
        &conn,
        &DatabaseAggregateRequest {
            expected_generation: 1,
            database_id: "01J00000000000000000000000".to_owned(),
            source: DatabaseQuerySource::Inline {
                spec: DatabaseQuerySpec {
                    filter: None,
                    sorts: Vec::new(),
                },
            },
            category: None,
            measure: None,
            aggregation: "count".to_owned(),
            search: None,
            limit: 1,
            context_page_id: None,
        },
    )
    .unwrap();
    assert_eq!(result.total_count, 3);
    assert_eq!(result.groups.len(), 1);
    assert_eq!(result.groups[0].count, 3);
}

#[test]
fn temporary_filter_is_combined_with_inline_view_filter() {
    let conn = connection();
    let mut request = request(
        Some(DatabaseFilterNode::Condition {
            field: DatabaseFieldRef::System {
                field: "title".to_owned(),
            },
            operator: "startsWith".to_owned(),
            value: Some(serde_json::json!("A").to_string()),
        }),
        DatabasePageRequest {
            limit: 10,
            cursor: None,
        },
    );
    request.filter = Some(DatabaseFilterNode::Condition {
        field: DatabaseFieldRef::System {
            field: "title".to_owned(),
        },
        operator: "equals".to_owned(),
        value: Some(serde_json::json!("Beta").to_string()),
    });

    let result = query_database(&conn, &request).unwrap();

    assert!(result.rows.is_empty());
    assert_eq!(result.total_count, 0);
}

fn property(conn: &Connection, kind: &str, values: &[Option<JsonValue>]) {
    conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES ('01J00000000000000000000000', ?1, 0, ?1, ?1, 'alwaysShow', '{}')",
            [kind],
        ).unwrap();
    for (index, value) in values.iter().enumerate() {
        let Some(value) = value else { continue };
        let decimal = value.get("decimal").and_then(JsonValue::as_str);
        conn.execute(
                "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, text_value, text_sort_key, decimal_value, decimal_sort_key, bool_value, date_start_key, source_revision) VALUES ('01J00000000000000000000000', ?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'record')",
                params![
                    format!("01J0000000000000000000000{}", index + 1), kind,
                    value.to_string(), value.get("value").and_then(JsonValue::as_str),
                    value.get("value").and_then(JsonValue::as_str).map(|value| value.to_lowercase().into_bytes()),
                    decimal, decimal.and_then(decimal_sort_key),
                    value.get("checked").and_then(JsonValue::as_bool).map(i64::from),
                    value.get("dateKey").and_then(JsonValue::as_i64),
                ],
            ).unwrap();
    }
}

fn sorted_request(kind: &str, direction: &str, nulls: &str) -> DatabaseQueryRequest {
    let mut request = request(
        None,
        DatabasePageRequest {
            limit: 1,
            cursor: None,
        },
    );
    request.source = DatabaseQuerySource::Inline {
        spec: DatabaseQuerySpec {
            filter: None,
            sorts: vec![DatabaseSortSpec {
                field: DatabaseFieldRef::Property {
                    property_id: kind.to_owned(),
                },
                direction: direction.to_owned(),
                nulls: nulls.to_owned(),
            }],
        },
    };
    request
}

fn all_pages(conn: &Connection, mut request: DatabaseQueryRequest) -> Vec<String> {
    let mut titles = Vec::new();
    for _ in 0..10 {
        let page = query_database(conn, &request).unwrap();
        titles.extend(page.rows.into_iter().map(|row| row.title));
        request.page.cursor = page.next_cursor;
        if request.page.cursor.is_none() {
            return titles;
        }
    }
    panic!("pagination did not terminate");
}

#[test]
fn typed_pagination_preserves_nulls_and_every_row_in_both_directions() {
    for (kind, low, high) in [
        (
            "number",
            serde_json::json!({"decimal":"-1.23"}),
            serde_json::json!({"decimal":"-1.2"}),
        ),
        (
            "text",
            serde_json::json!({"value":""}),
            serde_json::json!({"value":"z"}),
        ),
        (
            "checkbox",
            serde_json::json!({"checked":false}),
            serde_json::json!({"checked":true}),
        ),
        (
            "date",
            serde_json::json!({"dateKey":-200}),
            serde_json::json!({"dateKey":-100}),
        ),
    ] {
        let conn = connection();
        property(&conn, kind, &[None, Some(high), Some(low)]);
        for (direction, nulls, expected) in [
            ("asc", "first", vec!["Alpha", "Gamma", "Beta"]),
            ("asc", "last", vec!["Gamma", "Beta", "Alpha"]),
            ("desc", "first", vec!["Alpha", "Beta", "Gamma"]),
            ("desc", "last", vec!["Beta", "Gamma", "Alpha"]),
        ] {
            assert_eq!(
                all_pages(&conn, sorted_request(kind, direction, nulls)),
                expected,
                "{kind} {direction} nulls {nulls}"
            );
        }
    }
}

#[test]
fn pagination_applies_secondary_sorts_before_the_note_id_tie_breaker() {
    for values in [vec![], vec![Some(serde_json::json!({"value":"same"})); 3]] {
        let conn = connection();
        property(&conn, "text", &values);
        let mut request = sorted_request("text", "asc", "last");
        let DatabaseQuerySource::Inline { spec } = &mut request.source else {
            unreachable!()
        };
        spec.sorts.push(DatabaseSortSpec {
            field: DatabaseFieldRef::System {
                field: "title".to_owned(),
            },
            direction: "desc".to_owned(),
            nulls: "last".to_owned(),
        });
        assert_eq!(all_pages(&conn, request), ["Gamma", "Beta", "Alpha"]);
    }
}

#[test]
fn number_filters_use_exact_normalized_values() {
    let conn = connection();
    property(
        &conn,
        "number",
        &[
            Some(serde_json::json!({"decimal":"-1.200"})),
            Some(serde_json::json!({"decimal":"-1.23"})),
            Some(serde_json::json!({"decimal":"90071992547409931234567890.125"})),
        ],
    );
    for (operator, operand, expected) in [
        ("equals", "-12e-1", vec!["Alpha"]),
        ("notEquals", "-1.2", vec!["Beta", "Gamma"]),
        ("lessThan", "-1.2", vec!["Beta"]),
        (
            "greaterThan",
            "90071992547409931234567890.12",
            vec!["Gamma"],
        ),
    ] {
        let request = request(
            Some(DatabaseFilterNode::Condition {
                field: DatabaseFieldRef::Property {
                    property_id: "number".to_owned(),
                },
                operator: operator.to_owned(),
                value: Some(serde_json::json!(operand).to_string()),
            }),
            DatabasePageRequest {
                limit: 1,
                cursor: None,
            },
        );
        assert_eq!(all_pages(&conn, request), expected);
    }
    let invalid = request(
        Some(DatabaseFilterNode::Condition {
            field: DatabaseFieldRef::Property {
                property_id: "number".to_owned(),
            },
            operator: "equals".to_owned(),
            value: Some(serde_json::json!("not a number").to_string()),
        }),
        DatabasePageRequest {
            limit: 1,
            cursor: None,
        },
    );
    assert_eq!(
        query_database(&conn, &invalid).unwrap_err().code,
        "invalidOperand"
    );
}

#[test]
fn malformed_cursor_keys_are_rejected_instead_of_silently_truncated() {
    let conn = connection();
    let mut request = request(
        None,
        DatabasePageRequest {
            limit: 1,
            cursor: None,
        },
    );
    let first = query_database(&conn, &request).unwrap();
    let projection = projection_version(&conn).unwrap();
    let DatabaseQuerySource::Inline { spec } = &request.source else {
        unreachable!()
    };
    let hash = query_hash(&request, spec).unwrap();
    let cursor = decode_cursor(&first.next_cursor.unwrap(), &projection, &hash).unwrap();
    for keys in [
        serde_json::json!([]),
        serde_json::json!([{"Blob":[256]}]),
        serde_json::json!([{"Blob":[-1]}]),
    ] {
        let mut value = serde_json::to_value(&cursor).unwrap();
        value["lastSortKeys"] = keys;
        request.page.cursor = Some(
            serde_json::to_vec(&value)
                .unwrap()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        );
        assert_eq!(
            query_database(&conn, &request).unwrap_err().code,
            "staleCursor"
        );
    }
}

#[test]
fn text_filters_treat_like_metacharacters_as_literal_text() {
    let conn = connection();
    property(
        &conn,
        "text",
        &[
            Some(serde_json::json!({"value":"100%_\\done"})),
            Some(serde_json::json!({"value":"100xxdone"})),
        ],
    );
    conn.execute(
        "UPDATE notes SET title = '100%_\\done' WHERE title = 'Alpha'",
        [],
    )
    .unwrap();
    for field in [
        DatabaseFieldRef::System {
            field: "title".to_owned(),
        },
        DatabaseFieldRef::Property {
            property_id: "text".to_owned(),
        },
    ] {
        for (operator, operand) in [("contains", "%_\\"), ("startsWith", "100%_\\")] {
            let page = query_database(
                &conn,
                &request(
                    Some(DatabaseFilterNode::Condition {
                        field: field.clone(),
                        operator: operator.to_owned(),
                        value: Some(serde_json::json!(operand).to_string()),
                    }),
                    DatabasePageRequest {
                        limit: 20,
                        cursor: None,
                    },
                ),
            )
            .unwrap();
            assert_eq!(page.rows.len(), 1);
            assert_eq!(page.rows[0].title, "100%_\\done");
        }
    }
}

#[test]
fn diagnostics_retain_their_source_path_and_message() {
    let conn = connection();
    conn.execute("INSERT INTO db_diagnostics (diagnostic_id, scope_kind, scope_key, code, severity, details_json, first_seen_at, last_seen_at) VALUES ('diagnostic', 'vault', 'Database/ambd.json', 'brokenManifest', 'error', ?1, 0, 0)",
            [serde_json::json!({"path":"Database/ambd.json", "message":"Invalid JSON"}).to_string()]).unwrap();
    let page = query_database(
        &conn,
        &request(
            None,
            DatabasePageRequest {
                limit: 20,
                cursor: None,
            },
        ),
    )
    .unwrap();
    assert_eq!(page.diagnostics[0].path, "Database/ambd.json");
    assert_eq!(page.diagnostics[0].message, "Invalid JSON");
}

#[test]
fn keyset_pagination_has_no_duplicates() {
    let conn = connection();
    let first = query_database(
        &conn,
        &request(
            None,
            DatabasePageRequest {
                limit: 2,
                cursor: None,
            },
        ),
    )
    .unwrap();
    assert_eq!(
        first
            .rows
            .iter()
            .map(|row| row.title.as_str())
            .collect::<Vec<_>>(),
        ["Alpha", "Beta"]
    );
    let second = query_database(
        &conn,
        &request(
            None,
            DatabasePageRequest {
                limit: 2,
                cursor: first.next_cursor,
            },
        ),
    )
    .unwrap();
    assert_eq!(
        second
            .rows
            .iter()
            .map(|row| row.title.as_str())
            .collect::<Vec<_>>(),
        ["Gamma"]
    );
}

#[test]
fn filter_operands_are_bound_and_fts_or_sql_syntax_is_not_executed() {
    let conn = connection();
    let filter = DatabaseFilterNode::Condition {
        field: DatabaseFieldRef::System {
            field: "title".to_owned(),
        },
        operator: "equals".to_owned(),
        value: Some("\"Alpha' OR 1=1 --\"".to_owned()),
    };
    let result = query_database(
        &conn,
        &request(
            Some(filter),
            DatabasePageRequest {
                limit: 20,
                cursor: None,
            },
        ),
    )
    .unwrap();
    assert!(result.rows.is_empty());
}

#[test]
fn cursor_is_invalidated_by_projection_epoch() {
    let conn = connection();
    let first = query_database(
        &conn,
        &request(
            None,
            DatabasePageRequest {
                limit: 1,
                cursor: None,
            },
        ),
    )
    .unwrap();
    conn.execute(
            "UPDATE index_metadata SET value = '01J0000000000000000000000A' WHERE key = 'database_projection_epoch'",
            [],
        )
        .unwrap();
    let error = query_database(
        &conn,
        &request(
            None,
            DatabasePageRequest {
                limit: 1,
                cursor: first.next_cursor,
            },
        ),
    )
    .unwrap_err();
    assert_eq!(error.code, "staleCursor");
}

#[test]
fn st09_date_multiselect_relation_filters() {
    let conn = connection();

    // 1. Test date filters
    let (d1, _) = crate::database::projection::date_key("2026-01-01");
    let (d2, _) = crate::database::projection::date_key("2026-06-01");
    let (d3, _) = crate::database::projection::date_key("2026-12-01");
    property(
        &conn,
        "date",
        &[
            Some(serde_json::json!({ "dateKey": d1.unwrap() })),
            Some(serde_json::json!({ "dateKey": d2.unwrap() })),
            Some(serde_json::json!({ "dateKey": d3.unwrap() })),
        ],
    );

    for (operator, operand, expected) in [
        ("equals", "2026-06-01", vec!["Beta"]),
        ("notEquals", "2026-06-01", vec!["Alpha", "Gamma"]),
        ("greaterThan", "2026-05-01", vec!["Beta", "Gamma"]),
        ("lessThan", "2026-05-01", vec!["Alpha"]),
    ] {
        let req = request(
            Some(DatabaseFilterNode::Condition {
                field: DatabaseFieldRef::Property {
                    property_id: "date".to_owned(),
                },
                operator: operator.to_owned(),
                value: Some(serde_json::json!(operand).to_string()),
            }),
            DatabasePageRequest {
                limit: 10,
                cursor: None,
            },
        );
        assert_eq!(all_pages(&conn, req), expected, "date operator {operator}");
    }

    // 2. Test multiselect filter (contains)
    conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES ('01J00000000000000000000000', 'tags', 1, 'tags', 'multiselect', 'alwaysShow', '{}')",
            [],
        ).unwrap();
    // Alpha: opt_a, opt_b
    // Beta: opt_b, opt_c
    // Gamma: opt_c
    for (note_id, opt_id) in [
        ("01J00000000000000000000001", "opt_a"),
        ("01J00000000000000000000001", "opt_b"),
        ("01J00000000000000000000002", "opt_b"),
        ("01J00000000000000000000002", "opt_c"),
        ("01J00000000000000000000003", "opt_c"),
    ] {
        conn.execute(
                "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, source_revision) VALUES ('01J00000000000000000000000', ?1, 'tags', 'multiselect', '[]', 'record')",
                params![note_id],
            ).ok();
        conn.execute(
                "INSERT INTO db_value_options (database_id, note_id, property_id, option_id, position) VALUES ('01J00000000000000000000000', ?1, 'tags', ?2, 0)",
                params![note_id, opt_id],
            ).unwrap();
    }

    for (operand, expected) in [
        ("opt_a", vec!["Alpha"]),
        ("opt_b", vec!["Alpha", "Beta"]),
        ("opt_c", vec!["Beta", "Gamma"]),
    ] {
        let req = request(
            Some(DatabaseFilterNode::Condition {
                field: DatabaseFieldRef::Property {
                    property_id: "tags".to_owned(),
                },
                operator: "contains".to_owned(),
                value: Some(serde_json::json!(operand).to_string()),
            }),
            DatabasePageRequest {
                limit: 10,
                cursor: None,
            },
        );
        assert_eq!(
            all_pages(&conn, req),
            expected,
            "multiselect contains {operand}"
        );
    }

    // 3. Test relation filter (contains)
    conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES ('01J00000000000000000000000', 'rel', 2, 'rel', 'relation', 'alwaysShow', '{}')",
            [],
        ).unwrap();
    // Alpha -> Beta (01J00000000000000000000002)
    // Gamma -> Beta (01J00000000000000000000002)
    for note_id in ["01J00000000000000000000001", "01J00000000000000000000003"] {
        conn.execute(
                "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, source_revision) VALUES ('01J00000000000000000000000', ?1, 'rel', 'relation', '[]', 'record')",
                params![note_id],
            ).ok();
        conn.execute(
                "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES ('01J00000000000000000000000', ?1, 'rel', '01J00000000000000000000002', 0, 'linked')",
                params![note_id],
            ).unwrap();
    }

    let req = request(
        Some(DatabaseFilterNode::Condition {
            field: DatabaseFieldRef::Property {
                property_id: "rel".to_owned(),
            },
            operator: "contains".to_owned(),
            value: Some(serde_json::json!("01J00000000000000000000002").to_string()),
        }),
        DatabasePageRequest {
            limit: 10,
            cursor: None,
        },
    );
    assert_eq!(
        all_pages(&conn, req),
        vec!["Alpha", "Gamma"],
        "relation contains target"
    );
}
#[test]
fn review_canonical_multi_select_filter_is_accepted() {
    let mut bindings = Vec::new();
    let result = compile_property_condition(
        "multiSelect",
        "p",
        "contains",
        Some(serde_json::json!("option-id")),
        &mut bindings,
    );
    assert!(result.is_ok(), "canonical type rejected: {result:?}");
}
#[test]
fn review_checkbox_filter_sent_by_frontend_is_accepted() {
    let mut bindings = Vec::new();
    let result = compile_property_condition(
        "checkbox",
        "p",
        "equals",
        Some(serde_json::json!("true")),
        &mut bindings,
    );
    assert!(result.is_ok(), "frontend operand rejected: {result:?}");
}
#[test]
fn review_select_filter_sent_by_frontend_is_accepted() {
    let mut bindings = Vec::new();
    let result = compile_property_condition(
        "select",
        "p",
        "contains",
        Some(serde_json::json!("option-id")),
        &mut bindings,
    );
    assert!(result.is_ok(), "frontend operator rejected: {result:?}");
}

#[test]
fn every_registered_operator_compiles_for_its_field_kind() {
    for (kind, operators) in crate::database::filter_operators::REGISTRY {
        if *kind == "system" {
            continue;
        }
        let operand = match *kind {
            "number" => serde_json::json!("1"),
            "date" => serde_json::json!("2026-01-01"),
            "checkbox" => serde_json::json!("true"),
            _ => serde_json::json!("x"),
        };
        for operator in *operators {
            let mut bindings = Vec::new();
            let result = compile_property_condition(
                kind,
                "p",
                operator,
                Some(operand.clone()),
                &mut bindings,
            );
            assert!(result.is_ok(), "{kind} {operator}: {result:?}");
        }
    }
}

#[test]
fn inclusive_bounds_and_is_not_cover_equal_and_empty_rows() {
    let conn = connection();
    property(
        &conn,
        "number",
        &[
            Some(serde_json::json!({"decimal":"1"})),
            Some(serde_json::json!({"decimal":"2"})),
            None,
        ],
    );
    let ask = |operator: &str, operand: &str| {
        all_pages(
            &conn,
            request(
                Some(DatabaseFilterNode::Condition {
                    field: DatabaseFieldRef::Property {
                        property_id: "number".to_owned(),
                    },
                    operator: operator.to_owned(),
                    value: Some(serde_json::json!(operand).to_string()),
                }),
                DatabasePageRequest {
                    limit: 10,
                    cursor: None,
                },
            ),
        )
    };
    assert_eq!(ask("greaterOrEqual", "2"), ["Beta"]);
    assert_eq!(ask("lessOrEqual", "1"), ["Alpha"]);
    // "Is not 1" keeps the row that has no value at all.
    assert_eq!(ask("notEquals", "1"), ["Beta", "Gamma"]);
    // Legacy spellings keep working.
    assert_eq!(ask("gte", "2"), ["Beta"]);
    assert_eq!(ask("isNot", "1"), ["Beta", "Gamma"]);
}

#[test]
fn a_current_page_filter_matches_only_the_given_page_and_never_everything() {
    let conn = connection();
    // Alpha is linked to page ...9 through a relation edge.
    conn.execute(
        "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES ('01J00000000000000000000000', 'rel', 2, 'rel', 'relation', 'alwaysShow', '{}')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES ('01J00000000000000000000000', '01J00000000000000000000001', 'rel', '01J00000000000000000000009', 0, 'linked')",
        [],
    )
    .unwrap();
    let filter = DatabaseFilterNode::Condition {
        field: DatabaseFieldRef::Property {
            property_id: "rel".to_owned(),
        },
        operator: "contains".to_owned(),
        value: Some(serde_json::json!(CURRENT_PAGE_OPERAND).to_string()),
    };
    let mut ask = |context: Option<&str>| {
        let mut req = request(
            Some(filter.clone()),
            DatabasePageRequest {
                limit: 10,
                cursor: None,
            },
        );
        req.context_page_id = context.map(str::to_owned);
        query_database(&conn, &req)
    };
    let page = ask(Some("01J00000000000000000000009")).unwrap();
    assert_eq!(
        page.rows
            .iter()
            .map(|row| row.title.as_str())
            .collect::<Vec<_>>(),
        ["Alpha"]
    );
    // Another page: nothing links to it.
    assert!(ask(Some("01J00000000000000000000008"))
        .unwrap()
        .rows
        .is_empty());
    // No page: an error, not every record.
    assert_eq!(ask(None).unwrap_err().code, "missingPageContext");
    assert_eq!(
        ask(Some("not-an-id")).unwrap_err().code,
        "invalidContextPage"
    );
}
