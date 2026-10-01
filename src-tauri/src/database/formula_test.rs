use super::*;
use rusqlite::Connection;

#[test]
fn decimal_operations_are_exact_and_division_is_bounded() {
    let mut values = BTreeMap::new();
    values.insert(
        "a".to_owned(),
        FormulaValue::Number(Decimal::parse("0.1").unwrap()),
    );
    values.insert(
        "b".to_owned(),
        FormulaValue::Number(Decimal::parse("0.2").unwrap()),
    );
    assert_eq!(
        evaluate("a + b == 0.3", &values).unwrap(),
        FormulaValue::Boolean(true)
    );
    assert_eq!(
        evaluate("1 / 0.000000000000000001", &values).unwrap(),
        FormulaValue::Number(Decimal::parse("1000000000000000000").unwrap())
    );
    assert_eq!(
        evaluate("1 / 8", &BTreeMap::new()).unwrap(),
        FormulaValue::Number(Decimal::parse("0.125").unwrap())
    );
    assert_eq!(
        evaluate("1 / 0", &BTreeMap::new()).unwrap_err().code,
        "divisionByZero"
    );
}

#[test]
fn decimal_signed_extremes_return_errors_instead_of_panicking() {
    let minimum = Decimal::parse("-170141183460469231731687303715884105728").unwrap();
    let negative_one = Decimal::parse("-1").unwrap();
    let maximum = Decimal::parse("170141183460469231731687303715884105727").unwrap();
    let one = Decimal::from_i64(1);

    assert_eq!(
        minimum.to_string(),
        "-170141183460469231731687303715884105728"
    );
    assert_eq!(
        minimum.div(&negative_one).unwrap_err().code,
        "numberOverflow"
    );
    assert_eq!(minimum.sub(&one).unwrap_err().code, "numberOverflow");
    assert_eq!(maximum.add(&one).unwrap_err().code, "numberOverflow");
    assert_eq!(
        minimum.mul(&negative_one).unwrap_err().code,
        "numberOverflow"
    );

    let mut values = BTreeMap::new();
    values.insert("minimum".to_owned(), FormulaValue::Number(minimum));
    values.insert("negativeOne".to_owned(), FormulaValue::Number(negative_one));
    assert_eq!(
        evaluate("minimum / negativeOne", &values).unwrap_err().code,
        "numberOverflow"
    );
}

#[test]
fn decimal_and_formula_inputs_have_explicit_bounds() {
    assert_eq!(
        Decimal::parse(&"1".repeat(MAX_DECIMAL_DIGITS + 1))
            .unwrap_err()
            .code,
        "invalidNumber"
    );
    assert_eq!(
        parse(&format!("\"{}\"", "x".repeat(MAX_EXPRESSION_BYTES)))
            .unwrap_err()
            .code,
        "inputTooLarge"
    );

    let nested = format!(
        "{}1{}",
        "(".repeat(MAX_DEPTH + 1),
        ")".repeat(MAX_DEPTH + 1)
    );
    assert_eq!(parse(&nested).unwrap_err().code, "formulaTooDeep");
    assert_eq!(
        Decimal::parse("0.111111111111111111")
            .unwrap()
            .mul(&Decimal::parse("1.1").unwrap())
            .unwrap_err()
            .code,
        "numberPrecision"
    );
}

#[test]
fn functions_and_missing_property_are_typed() {
    let mut values = BTreeMap::new();
    values.insert("name".to_owned(), FormulaValue::Text("Alex".to_owned()));
    assert_eq!(
        evaluate("if(contains(name, \"A\"), \"yes\", \"no\")", &values).unwrap(),
        FormulaValue::Text("yes".to_owned())
    );
    assert_eq!(
        evaluate("missing + 1", &values).unwrap_err().code,
        "missingProperty"
    );
}

#[test]
fn parser_rejects_unsupported_access_and_unbounded_input() {
    assert_eq!(parse("foo.bar").unwrap_err().code, "parseError");
    assert_eq!(
        parse(&"1 + ".repeat(5000)).unwrap_err().code,
        "inputTooLarge"
    );
}

#[test]
fn st10_formula_dependency_graph_and_cycle_detection() {
    // Linear dependencies: c depends on b, b depends on a
    let formulas = [
        ("prop_c", "prop_b + 1"),
        ("prop_a", "10"),
        ("prop_b", "prop_a * 2"),
    ];
    let order = topological_formula_order(&formulas, None).unwrap();
    assert_eq!(order, vec!["prop_a", "prop_b", "prop_c"]);

    // Mutual cycle: x depends on y, y depends on x
    let cyclic = [("prop_x", "prop_y + 1"), ("prop_y", "prop_x + 1")];
    let err = topological_formula_order(&cyclic, None).unwrap_err();
    assert_eq!(err.code, "cycleDetected");

    // Self cycle: z depends on z
    let self_cycle = [("prop_z", "prop_z + 1")];
    let err = topological_formula_order(&self_cycle, None).unwrap_err();
    assert_eq!(err.code, "cycleDetected");
}

#[test]
fn review2_named_formula_cycle_is_reported() {
    let mut name_to_id = HashMap::new();
    name_to_id.insert("A".to_owned(), "prop_a".to_owned());
    name_to_id.insert("B".to_owned(), "prop_b".to_owned());
    name_to_id.insert("C".to_owned(), "prop_c".to_owned());

    // Mutual cycle using property names
    let cyclic = [("prop_a", "B + 1"), ("prop_b", "A * 2")];
    let err = topological_formula_order(&cyclic, Some(&name_to_id)).unwrap_err();
    assert_eq!(err.code, "cycleDetected");

    // Self cycle using property name
    let self_cycle = [("prop_c", "C + 1")];
    let err = topological_formula_order(&self_cycle, Some(&name_to_id)).unwrap_err();
    assert_eq!(err.code, "cycleDetected");
}

#[test]
fn st10_formula_evaluation_and_storage() {
    use crate::index::schema::init_schema;
    let mut conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();

    let db_id = "01J00000000000000000000000";
    let note_id = "01J00000000000000000000001";
    conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            params![db_id],
        ).unwrap();

    conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, 'note.md', 'Note', 0, 0, '', 0, 0, 0)",
            params![note_id],
        ).unwrap();
    for (pid, ptype) in [("price", "number"), ("tax", "number"), ("total", "formula")] {
        conn.execute(
                "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
                params![db_id, pid, ptype],
            ).unwrap();
    }

    // Insert input values: price = 100, tax = 20
    conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'price', 'number', '100', '{\"type\":\"number\",\"decimal\":\"100\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();
    conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'tax', 'number', '20', '{\"type\":\"number\",\"decimal\":\"20\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();

    let manifest = format::DatabaseManifest {
        database_id: db_id.to_owned(),
        name: "Database".to_owned(),
        icon: None,
        cover: None,
        locked: false,
        membership: format::Membership {
            kind: "folder".to_owned(),
            recursive: false,
            extra: Default::default(),
        },
        properties: vec![
            format::PropertyDefinition::Number(format::PropertyFields {
                id: "price".to_owned(),
                name: "Price".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::NumberConfig {
                    format: "number".to_owned(),
                    currency: None,
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Number(format::PropertyFields {
                id: "tax".to_owned(),
                name: "Tax".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::NumberConfig {
                    format: "number".to_owned(),
                    currency: None,
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Formula(format::PropertyFields {
                id: "total".to_owned(),
                name: "Total".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::FormulaConfig {
                    version: 1,
                    expression: "price + tax".to_owned(),
                    result_type: Some("number".to_owned()),
                    dependencies: vec!["price".to_owned(), "tax".to_owned()],
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
        ],
        views: Vec::new(),
        view_order: Vec::new(),
        default_view_id: None,
        template_order: Vec::new(),
        default_template_id: None,
        format: "amby-database".to_owned(),
        format_version: 1,
        extra: Default::default(),
    };

    let tx = conn.transaction().unwrap();
    compute_formulas_for_notes(&tx, db_id, &[note_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();

    let (val_type, dec_val): (String, String) = conn.query_row(
            "SELECT value_type, decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'total'",
            params![db_id, note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();

    assert_eq!(val_type, "formula");
    assert_eq!(dec_val, "120");
}

#[test]
fn review2_formula_chain_survives_column_reordering() {
    use crate::index::schema::init_schema;
    let mut conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();

    let db_id = "01J00000000000000000000000";
    let note_id = "01J00000000000000000000001";
    conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            params![db_id],
        ).unwrap();

    conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, 'note.md', 'Note', 0, 0, '', 0, 0, 0)",
            params![note_id],
        ).unwrap();

    for (pid, ptype) in [
        ("price", "number"),
        ("tax", "number"),
        ("doubled", "formula"),
        ("total", "formula"),
    ] {
        conn.execute(
                "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
                params![db_id, pid, ptype],
            ).unwrap();
    }

    // Insert input values: price = 100, tax = 20
    conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'price', 'number', '100', '{\"type\":\"number\",\"decimal\":\"100\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();
    conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'tax', 'number', '20', '{\"type\":\"number\",\"decimal\":\"20\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();

    // Note: 'doubled' appears BEFORE 'total' in properties, but references 'Total' by name
    let manifest = format::DatabaseManifest {
        database_id: db_id.to_owned(),
        name: "Database".to_owned(),
        icon: None,
        cover: None,
        locked: false,
        membership: format::Membership {
            kind: "folder".to_owned(),
            recursive: false,
            extra: Default::default(),
        },
        properties: vec![
            format::PropertyDefinition::Number(format::PropertyFields {
                id: "price".to_owned(),
                name: "Price".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::NumberConfig {
                    format: "number".to_owned(),
                    currency: None,
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Number(format::PropertyFields {
                id: "tax".to_owned(),
                name: "Tax".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::NumberConfig {
                    format: "number".to_owned(),
                    currency: None,
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Formula(format::PropertyFields {
                id: "doubled".to_owned(),
                name: "Doubled".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::FormulaConfig {
                    version: 1,
                    expression: "Total * 2".to_owned(),
                    result_type: Some("number".to_owned()),
                    dependencies: vec!["Total".to_owned()],
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Formula(format::PropertyFields {
                id: "total".to_owned(),
                name: "Total".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::FormulaConfig {
                    version: 1,
                    expression: "Price + Tax".to_owned(),
                    result_type: Some("number".to_owned()),
                    dependencies: vec!["Price".to_owned(), "Tax".to_owned()],
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
        ],
        views: Vec::new(),
        view_order: Vec::new(),
        default_view_id: None,
        template_order: Vec::new(),
        default_template_id: None,
        format: "amby-database".to_owned(),
        format_version: 1,
        extra: Default::default(),
    };

    let tx = conn.transaction().unwrap();
    compute_formulas_for_notes(&tx, db_id, &[note_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();

    let total_val: String = conn.query_row(
            "SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'total'",
            params![db_id, note_id],
            |row| row.get(0),
        ).unwrap();
    assert_eq!(total_val, "120");

    let doubled_val: String = conn.query_row(
            "SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'doubled'",
            params![db_id, note_id],
            |row| row.get(0),
        ).unwrap();
    assert_eq!(doubled_val, "240");
}

#[test]
fn st10_rollup_computation_over_relations() {
    use crate::index::schema::init_schema;
    let mut conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();

    let db_id = "01J00000000000000000000000";
    let project_id = "01J00000000000000000000001";
    let task1_id = "01J00000000000000000000002";
    let task2_id = "01J00000000000000000000003";

    conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            params![db_id],
        ).unwrap();

    for (nid, title) in [
        (project_id, "Project"),
        (task1_id, "Task 1"),
        (task2_id, "Task 2"),
    ] {
        conn.execute(
                "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, '', 0, 0, 0)",
                params![nid, format!("{title}.md"), title],
            ).unwrap();
    }
    for (pid, ptype) in [
        ("tasks", "relation"),
        ("hours", "number"),
        ("total_hours", "rollup"),
        ("task_count", "rollup"),
    ] {
        conn.execute(
                "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
                params![db_id, pid, ptype],
            ).unwrap();
    }

    // Tasks have hours
    conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'hours', 'number', '10', '{\"type\":\"number\",\"decimal\":\"10\"}', 'rec')",
            params![db_id, task1_id],
        ).unwrap();
    conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'hours', 'number', '25', '{\"type\":\"number\",\"decimal\":\"25\"}', 'rec')",
            params![db_id, task2_id],
        ).unwrap();

    // Project links to Task1 and Task2
    conn.execute(
            "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES (?1, ?2, 'tasks', ?3, 0, 'resolved')",
            params![db_id, project_id, task1_id],
        ).unwrap();
    conn.execute(
            "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES (?1, ?2, 'tasks', ?3, 1, 'resolved')",
            params![db_id, project_id, task2_id],
        ).unwrap();

    let manifest = format::DatabaseManifest {
        database_id: db_id.to_owned(),
        name: "Database".to_owned(),
        icon: None,
        cover: None,
        locked: false,
        membership: format::Membership {
            kind: "folder".to_owned(),
            recursive: false,
            extra: Default::default(),
        },
        properties: vec![
            format::PropertyDefinition::Relation(format::PropertyFields {
                id: "tasks".to_owned(),
                name: "Tasks".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::RelationConfig {
                    target_database_id: db_id.to_owned(),
                    max_items: None,
                    inverse_property_id: None,
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Rollup(format::PropertyFields {
                id: "total_hours".to_owned(),
                name: "Total Hours".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::RollupConfig {
                    relation_property_id: "tasks".to_owned(),
                    target_property_id: "hours".to_owned(),
                    aggregation: "sum".to_owned(),
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Rollup(format::PropertyFields {
                id: "task_count".to_owned(),
                name: "Task Count".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::RollupConfig {
                    relation_property_id: "tasks".to_owned(),
                    target_property_id: "hours".to_owned(),
                    aggregation: "count".to_owned(),
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
        ],
        views: Vec::new(),
        view_order: Vec::new(),
        default_view_id: None,
        template_order: Vec::new(),
        default_template_id: None,
        format: "amby-database".to_owned(),
        format_version: 1,
        extra: Default::default(),
    };

    let tx = conn.transaction().unwrap();
    compute_rollups_for_notes(&tx, db_id, &[project_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();

    let (sum_type, sum_val): (String, String) = conn.query_row(
            "SELECT value_type, decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'total_hours'",
            params![db_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
    assert_eq!(sum_type, "rollup");
    assert_eq!(sum_val, "35");

    let (cnt_type, cnt_val): (String, String) = conn.query_row(
            "SELECT value_type, decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'task_count'",
            params![db_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
    assert_eq!(cnt_type, "rollup");
    assert_eq!(cnt_val, "2");
}
#[test]
fn review_numeric_formula_chain() {
    use crate::index::schema::init_schema;
    let mut conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();

    let db_id = "01J00000000000000000000000";
    let note_id = "01J00000000000000000000001";
    conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            params![db_id],
        ).unwrap();

    conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, 'note.md', 'Note', 0, 0, '', 0, 0, 0)",
            params![note_id],
        ).unwrap();
    for (pid, ptype) in [
        ("01J00000000000000000000011", "number"),
        ("01J00000000000000000000012", "number"),
        ("01J00000000000000000000013", "formula"),
    ] {
        conn.execute(
                "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
                params![db_id, pid, ptype],
            ).unwrap();
    }

    // Insert input values: price = 100, tax = 20
    conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, '01J00000000000000000000011', 'number', '100', '{\"type\":\"number\",\"decimal\":\"100\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();
    conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, '01J00000000000000000000012', 'number', '20', '{\"type\":\"number\",\"decimal\":\"20\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();

    let mut manifest = format::DatabaseManifest {
        database_id: db_id.to_owned(),
        name: "Database".to_owned(),
        icon: None,
        cover: None,
        locked: false,
        membership: format::Membership {
            kind: "folder".to_owned(),
            recursive: false,
            extra: Default::default(),
        },
        properties: vec![
            format::PropertyDefinition::Number(format::PropertyFields {
                id: "01J00000000000000000000011".to_owned(),
                name: "Price".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::NumberConfig {
                    format: "number".to_owned(),
                    currency: None,
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Number(format::PropertyFields {
                id: "01J00000000000000000000012".to_owned(),
                name: "Tax".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::NumberConfig {
                    format: "number".to_owned(),
                    currency: None,
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Formula(format::PropertyFields {
                id: "01J00000000000000000000013".to_owned(),
                name: "Total".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::FormulaConfig {
                    version: 1,
                    expression: "Price + Tax".to_owned(),
                    result_type: Some("number".to_owned()),
                    dependencies: vec![
                        "01J00000000000000000000011".to_owned(),
                        "01J00000000000000000000012".to_owned(),
                    ],
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
        ],
        views: Vec::new(),
        view_order: Vec::new(),
        default_view_id: None,
        template_order: Vec::new(),
        default_template_id: None,
        format: "amby-database".to_owned(),
        format_version: 1,
        extra: Default::default(),
    };

    let mut doubled = manifest.properties.last().unwrap().clone();
    if let format::PropertyDefinition::Formula(fields) = &mut doubled {
        fields.id = "01J00000000000000000000014".to_owned();
        fields.name = "Doubled".to_owned();
        fields.config.expression = "Total * 2".to_owned();
        fields.config.dependencies = vec!["01J00000000000000000000013".to_owned()];
    }
    manifest.properties.push(doubled);
    conn.execute("INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, '01J00000000000000000000014', 3, 'Doubled', 'formula', 'alwaysShow', '{}')", params![db_id]).unwrap();
    let tx = conn.transaction().unwrap();
    compute_formulas_for_notes(&tx, db_id, &[note_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();

    let (val_type, dec_val): (String, String) = conn.query_row(
            "SELECT value_type, decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = '01J00000000000000000000013'",
            params![db_id, note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();

    assert_eq!(val_type, "formula");
    assert_eq!(dec_val, "120");
    let doubled: Result<String, _> = conn.query_row("SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = '01J00000000000000000000014'", params![db_id, note_id], |row| row.get(0));
    assert_eq!(doubled.ok().as_deref(), Some("240"));
}

#[test]
fn formula_failure_isolated_to_note_and_cleared_after_fix() {
    use crate::index::schema::init_schema;

    let mut conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let database_id = "01J00000000000000000000020";
    let broken_note_id = "01J00000000000000000000021";
    let healthy_note_id = "01J00000000000000000000022";
    conn.execute(
        "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
        params![database_id],
    )
    .unwrap();
    for note_id in [broken_note_id, healthy_note_id] {
        conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?2, 0, 0, '', 0, 0, 0)",
            params![note_id, format!("{note_id}.md")],
        )
        .unwrap();
    }
    for (property_id, property_type) in [
        ("minimum", "number"),
        ("divisor", "number"),
        ("quotient", "formula"),
    ] {
        conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
            params![database_id, property_id, property_type],
        )
        .unwrap();
    }

    let minimum = "-170141183460469231731687303715884105728";
    insert_formula_number(&conn, database_id, broken_note_id, "minimum", minimum);
    insert_formula_number(&conn, database_id, broken_note_id, "divisor", "-1");
    insert_formula_number(&conn, database_id, healthy_note_id, "minimum", "10");
    insert_formula_number(&conn, database_id, healthy_note_id, "divisor", "-2");
    conn.execute(
        "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, decimal_value, source_revision) VALUES (?1, ?2, 'quotient', 'formula', '{\"type\":\"number\",\"decimal\":\"999\"}', '999', 'formula')",
        params![database_id, broken_note_id],
    )
    .unwrap();

    let manifest = formula_failure_manifest(database_id);
    let note_ids = [broken_note_id.to_owned(), healthy_note_id.to_owned()];
    let tx = conn.transaction().unwrap();
    compute_formulas_for_notes(&tx, database_id, &note_ids, &manifest).unwrap();
    tx.commit().unwrap();

    let stale_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'quotient'",
            params![database_id, broken_note_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stale_rows, 0,
        "failed notes must not retain old derived cells"
    );
    let healthy_value: String = conn
        .query_row(
            "SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'quotient'",
            params![database_id, healthy_note_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(healthy_value, "-5");
    let diagnostic: (String, String) = conn
        .query_row(
            "SELECT code, details_json FROM db_diagnostics WHERE diagnostic_id = ?1",
            [format!("computed:formula:{database_id}:{broken_note_id}")],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(diagnostic.0, "formulaError");
    assert!(diagnostic.1.contains("numberOverflow"));
    assert!(diagnostic.1.contains(broken_note_id));

    conn.execute(
        "UPDATE db_values SET decimal_value = '3', canonical_json = '{\"type\":\"number\",\"decimal\":\"3\"}' WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'minimum'",
        params![database_id, broken_note_id],
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    compute_formulas_for_notes(&tx, database_id, &[broken_note_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();

    let repaired_value: String = conn
        .query_row(
            "SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'quotient'",
            params![database_id, broken_note_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(repaired_value, "-3");
    let diagnostics: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM db_diagnostics WHERE diagnostic_id = ?1",
            [format!("computed:formula:{database_id}:{broken_note_id}")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        diagnostics, 0,
        "a successful recompute clears its old diagnostic"
    );
}

#[test]
fn rollup_overflow_is_diagnostic_without_partial_sum() {
    use crate::index::schema::init_schema;

    let mut conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let database_id = "01J00000000000000000000030";
    let project_id = "01J00000000000000000000031";
    let task1_id = "01J00000000000000000000032";
    let task2_id = "01J00000000000000000000033";
    conn.execute(
        "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
        params![database_id],
    )
    .unwrap();
    for (note_id, title) in [
        (project_id, "Project"),
        (task1_id, "Task 1"),
        (task2_id, "Task 2"),
    ] {
        conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, '', 0, 0, 0)",
            params![note_id, format!("{title}.md"), title],
        )
        .unwrap();
    }
    for (property_id, property_type) in [
        ("tasks", "relation"),
        ("hours", "number"),
        ("total_hours", "rollup"),
    ] {
        conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
            params![database_id, property_id, property_type],
        )
        .unwrap();
    }
    let maximum = "170141183460469231731687303715884105727";
    insert_formula_number(&conn, database_id, task1_id, "hours", maximum);
    insert_formula_number(&conn, database_id, task2_id, "hours", maximum);
    for (position, task_id) in [(0, task1_id), (1, task2_id)] {
        conn.execute(
            "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES (?1, ?2, 'tasks', ?3, ?4, 'resolved')",
            params![database_id, project_id, task_id, position],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, decimal_value, source_revision) VALUES (?1, ?2, 'total_hours', 'rollup', '{\"type\":\"number\",\"decimal\":\"999\"}', '999', 'rollup')",
        params![database_id, project_id],
    )
    .unwrap();

    let manifest = rollup_failure_manifest(database_id);
    let tx = conn.transaction().unwrap();
    compute_rollups_for_notes(&tx, database_id, &[project_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();

    let partial_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'total_hours'",
            params![database_id, project_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        partial_rows, 0,
        "overflow must not publish a partial rollup"
    );
    let diagnostic: (String, String) = conn
        .query_row(
            "SELECT code, details_json FROM db_diagnostics WHERE diagnostic_id = ?1",
            [format!("computed:rollup:{database_id}:{project_id}")],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(diagnostic.0, "rollupError");
    assert!(diagnostic.1.contains("numberOverflow"));

    conn.execute(
        "UPDATE db_values SET decimal_value = '1' WHERE property_id = 'hours'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE db_properties SET property_type = 'formula' WHERE property_id = 'hours'",
        [],
    )
    .unwrap();
    let foreign_diagnostic = format!("computed:formula:other-database:{task1_id}");
    conn.execute("INSERT INTO db_diagnostics VALUES (?1, 'database', 'other-database', 'formulaError', 'error', '{}', 0, 0)", [&foreign_diagnostic]).unwrap();
    let tx = conn.transaction().unwrap();
    compute_rollups_for_notes(&tx, database_id, &[project_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();
    let total: String = conn
        .query_row(
            "SELECT decimal_value FROM db_values WHERE property_id = 'total_hours'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        total, "2",
        "unrelated database diagnostics must not block a rollup"
    );
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM db_diagnostics WHERE code = 'rollupError'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        remaining, 0,
        "correcting input removes the rollup diagnostic"
    );

    let own_diagnostic = format!("computed:formula:{database_id}:{task1_id}");
    conn.execute("INSERT INTO db_diagnostics VALUES (?1, 'database', ?2, 'formulaError', 'error', '{}', 0, 0)", params![own_diagnostic, database_id]).unwrap();
    let tx = conn.transaction().unwrap();
    compute_rollups_for_notes(&tx, database_id, &[project_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM db_values WHERE property_id = 'total_hours'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        rows, 0,
        "a failed formula target must not become a partial sum"
    );

    // A failed formula on the note must not block aggregation of an ordinary number.
    conn.execute(
        "UPDATE db_properties SET property_type = 'number' WHERE property_id = 'hours'",
        [],
    )
    .unwrap();
    let tx = conn.transaction().unwrap();
    compute_rollups_for_notes(&tx, database_id, &[project_id.to_owned()], &manifest).unwrap();
    tx.commit().unwrap();
    let total: String = conn
        .query_row(
            "SELECT decimal_value FROM db_values WHERE property_id = 'total_hours'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(total, "2");
}

fn insert_formula_number(
    conn: &Connection,
    database_id: &str,
    note_id: &str,
    property_id: &str,
    value: &str,
) {
    conn.execute(
        "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, decimal_value, source_revision) VALUES (?1, ?2, ?3, 'number', ?4, ?5, 'record')",
        params![
            database_id,
            note_id,
            property_id,
            format!(r#"{{"type":"number","decimal":"{value}"}}"#),
            value,
        ],
    )
    .unwrap();
}

fn formula_failure_manifest(database_id: &str) -> format::DatabaseManifest {
    format::DatabaseManifest {
        database_id: database_id.to_owned(),
        name: "Database".to_owned(),
        icon: None,
        cover: None,
        locked: false,
        membership: format::Membership {
            kind: "folder".to_owned(),
            recursive: false,
            extra: Default::default(),
        },
        properties: vec![
            formula_number_property("minimum", "Minimum"),
            formula_number_property("divisor", "Divisor"),
            format::PropertyDefinition::Formula(format::PropertyFields {
                id: "quotient".to_owned(),
                name: "Quotient".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::FormulaConfig {
                    version: 1,
                    expression: "minimum / divisor".to_owned(),
                    result_type: Some("number".to_owned()),
                    dependencies: vec!["minimum".to_owned(), "divisor".to_owned()],
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
        ],
        views: Vec::new(),
        view_order: Vec::new(),
        default_view_id: None,
        template_order: Vec::new(),
        default_template_id: None,
        format: "amby-database".to_owned(),
        format_version: 1,
        extra: Default::default(),
    }
}

fn formula_number_property(id: &str, name: &str) -> format::PropertyDefinition {
    format::PropertyDefinition::Number(format::PropertyFields {
        id: id.to_owned(),
        name: name.to_owned(),
        page_visibility: "alwaysShow".to_owned(),
        config: format::NumberConfig {
            format: "number".to_owned(),
            currency: None,
            extra: Default::default(),
        },
        yaml_binding: None,
        extra: Default::default(),
    })
}

fn rollup_failure_manifest(database_id: &str) -> format::DatabaseManifest {
    format::DatabaseManifest {
        database_id: database_id.to_owned(),
        name: "Database".to_owned(),
        icon: None,
        cover: None,
        locked: false,
        membership: format::Membership {
            kind: "folder".to_owned(),
            recursive: false,
            extra: Default::default(),
        },
        properties: vec![
            format::PropertyDefinition::Relation(format::PropertyFields {
                id: "tasks".to_owned(),
                name: "Tasks".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::RelationConfig {
                    target_database_id: database_id.to_owned(),
                    max_items: None,
                    inverse_property_id: None,
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
            format::PropertyDefinition::Rollup(format::PropertyFields {
                id: "total_hours".to_owned(),
                name: "Total Hours".to_owned(),
                page_visibility: "alwaysShow".to_owned(),
                config: format::RollupConfig {
                    relation_property_id: "tasks".to_owned(),
                    target_property_id: "hours".to_owned(),
                    aggregation: "sum".to_owned(),
                    extra: Default::default(),
                },
                yaml_binding: None,
                extra: Default::default(),
            }),
        ],
        views: Vec::new(),
        view_order: Vec::new(),
        default_view_id: None,
        template_order: Vec::new(),
        default_template_id: None,
        format: "amby-database".to_owned(),
        format_version: 1,
        extra: Default::default(),
    }
}

#[test]
fn dependent_rollup_with_unusable_source_manifest_is_cleared_with_diagnostic() {
    use crate::index::schema::init_schema;

    let vault = std::env::temp_dir().join(format!("amby-rollup-stale-{}", ulid::Ulid::generate()));
    let container = vault.join("Database");
    std::fs::create_dir_all(&container).unwrap();
    let manifest_path = container.join("Database.json");

    let mut conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    let database_id = "01J00000000000000000000040";
    let project_id = "01J00000000000000000000041";
    let task_id = "01J00000000000000000000042";
    conn.execute(
        "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
        params![database_id],
    )
    .unwrap();
    for (note_id, title) in [(project_id, "Project"), (task_id, "Task")] {
        conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, '', 0, 0, 0)",
            params![note_id, format!("{title}.md"), title],
        )
        .unwrap();
    }
    for (property_id, property_type) in [
        ("tasks", "relation"),
        ("hours", "number"),
        ("total_hours", "rollup"),
    ] {
        conn.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
            params![database_id, property_id, property_type],
        )
        .unwrap();
    }
    insert_formula_number(&conn, database_id, task_id, "hours", "5");
    conn.execute(
        "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES (?1, ?2, 'tasks', ?3, 0, 'resolved')",
        params![database_id, project_id, task_id],
    )
    .unwrap();

    let manifest = rollup_failure_manifest(database_id);
    let valid = serde_json::to_vec(&manifest).unwrap();
    std::fs::write(&manifest_path, &valid).unwrap();
    let refresh = |conn: &mut Connection| {
        let tx = conn.transaction().unwrap();
        refresh_dependent_rollups(&tx, &vault, &[task_id.to_owned()]).unwrap();
        tx.commit().unwrap();
    };
    let total = |conn: &Connection| -> Option<String> {
        conn.query_row(
            "SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'total_hours'",
            params![database_id, project_id],
            |row| row.get(0),
        )
        .ok()
    };
    let diagnostic = |conn: &Connection| -> Option<(String, String)> {
        conn.query_row(
            "SELECT code, details_json FROM db_diagnostics WHERE diagnostic_id = ?1",
            [format!("computed:rollup:{database_id}:{project_id}")],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()
    };

    refresh(&mut conn);
    assert_eq!(total(&conn).as_deref(), Some("5"));
    assert!(diagnostic(&conn).is_none());

    // A corrupt manifest must not leave the previous sum published as current.
    std::fs::write(&manifest_path, b"{ not json").unwrap();
    conn.execute(
        "UPDATE db_values SET decimal_value = '7' WHERE note_id = ?1 AND property_id = 'hours'",
        [task_id],
    )
    .unwrap();
    refresh(&mut conn);
    assert_eq!(total(&conn), None, "stale rollup must be cleared");
    let (code, details) = diagnostic(&conn).expect("failure must leave a diagnostic");
    assert_eq!(code, "rollupError");
    assert!(details.contains("sourceManifestInvalid"), "{details}");

    // An unreadable (missing) manifest is the same failure boundary.
    std::fs::remove_file(&manifest_path).unwrap();
    refresh(&mut conn);
    assert_eq!(total(&conn), None);
    let (_, details) = diagnostic(&conn).unwrap();
    assert!(details.contains("sourceManifestUnavailable"), "{details}");

    // A manifest that belongs to another database is rejected, not trusted.
    let mut foreign = rollup_failure_manifest("01J00000000000000000000099");
    foreign.name = "Other".to_owned();
    std::fs::write(&manifest_path, serde_json::to_vec(&foreign).unwrap()).unwrap();
    refresh(&mut conn);
    assert_eq!(total(&conn), None);
    assert!(diagnostic(&conn).unwrap().1.contains("identity mismatch"));

    // Repairing the manifest recomputes the rollup and clears the diagnostic.
    std::fs::write(&manifest_path, &valid).unwrap();
    refresh(&mut conn);
    assert_eq!(total(&conn).as_deref(), Some("7"));
    assert!(diagnostic(&conn).is_none());

    // Source data is untouched by every failure.
    assert_eq!(std::fs::read(&manifest_path).unwrap(), valid);
    std::fs::remove_dir_all(&vault).ok();
}
