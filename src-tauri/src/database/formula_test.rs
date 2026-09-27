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
