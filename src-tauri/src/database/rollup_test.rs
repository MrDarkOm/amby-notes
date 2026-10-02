use super::*;

fn num(value: &str) -> Option<TargetValue> {
    Some(TargetValue {
        decimal: Some(value.to_owned()),
        ..Default::default()
    })
}

fn checked(value: bool) -> Option<TargetValue> {
    Some(TargetValue {
        boolean: Some(i64::from(value)),
        ..Default::default()
    })
}

fn option(id: &str) -> Option<TargetValue> {
    Some(TargetValue {
        option_id: Some(id.to_owned()),
        ..Default::default()
    })
}

fn date(value: &str) -> Option<TargetValue> {
    Some(TargetValue {
        date: Some(value.to_owned()),
        ..Default::default()
    })
}

fn run(aggregation: &str, values: &[Option<TargetValue>]) -> RollupOutcome {
    aggregate(aggregation, values, &HashSet::from(["done".to_owned()])).unwrap()
}

#[test]
fn counts_all_related_pages_and_only_those_with_a_value() {
    let values = [num("1"), None, num("1")];
    assert_eq!(run("count", &values), RollupOutcome::Number("3".into()));
    assert_eq!(
        run("countNonEmpty", &values),
        RollupOutcome::Number("2".into())
    );
    assert_eq!(run("unique", &values), RollupOutcome::Number("1".into()));
    assert_eq!(run("count", &[]), RollupOutcome::Number("0".into()));
}

#[test]
fn sum_of_nothing_is_zero_but_average_min_max_of_nothing_are_empty() {
    assert_eq!(run("sum", &[]), RollupOutcome::Number("0".into()));
    assert_eq!(run("sum", &[None]), RollupOutcome::Number("0".into()));
    for aggregation in ["average", "min", "max"] {
        assert_eq!(
            run(aggregation, &[None]),
            RollupOutcome::Empty,
            "{aggregation}"
        );
    }
}

#[test]
fn numeric_aggregates_are_exact() {
    let values = [num("0.1"), num("0.2"), num("-1.5")];
    assert_eq!(run("sum", &values), RollupOutcome::Number("-1.2".into()));
    assert_eq!(run("min", &values), RollupOutcome::Number("-1.5".into()));
    assert_eq!(run("max", &values), RollupOutcome::Number("0.2".into()));
    assert_eq!(
        run("average", &[num("1"), num("2")]),
        RollupOutcome::Number("1.5".into())
    );
}

#[test]
fn percent_checked_counts_checkboxes_and_done_options_over_all_related_pages() {
    assert_eq!(
        run(
            "percentChecked",
            &[checked(true), checked(false), None, checked(true)]
        ),
        RollupOutcome::Number("50.00".into())
    );
    assert_eq!(
        run(
            "percentChecked",
            &[option("done"), option("doing"), option("todo")]
        ),
        RollupOutcome::Number("33.33".into())
    );
    assert_eq!(run("percentChecked", &[]), RollupOutcome::Empty);
    assert_eq!(
        run("percentChecked", &[option("done")]),
        RollupOutcome::Number("100.00".into())
    );
}

#[test]
fn earliest_and_latest_compare_dates_not_text() {
    let values = [
        date("2026-10-20"),
        date("2026-09-30"),
        None,
        date("2027-01-01"),
    ];
    assert_eq!(
        run("earliest", &values),
        RollupOutcome::Date("2026-09-30".into())
    );
    assert_eq!(
        run("latest", &values),
        RollupOutcome::Date("2027-01-01".into())
    );
    assert_eq!(run("latest", &[None]), RollupOutcome::Empty);
}

#[test]
fn legacy_names_and_unknown_aggregations() {
    assert_eq!(canonical("avg"), Some("average"));
    assert_eq!(canonical("countUnique"), Some("unique"));
    assert_eq!(canonical("median"), None);
    assert!(aggregate("median", &[], &HashSet::new()).is_err());
}

#[test]
fn compatibility_follows_the_registry() {
    assert!(allowed("number", "sum"));
    assert!(allowed("number", "avg"));
    assert!(!allowed("text", "sum"));
    assert!(allowed("status", "percentChecked"));
    assert!(!allowed("select", "percentChecked"));
    assert!(allowed("date", "latest"));
    assert!(!allowed("number", "latest"));
    assert!(allowed("formula", "sum"));
    assert!(!allowed("unknown", "count"));
}

/// `rollup-aggregations.json` is what the wizard offers. It must be exactly the registry.
#[test]
fn the_shared_json_registry_matches_the_rust_registry() {
    let json: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/components/workspace/database/rollup-aggregations.json"
    ))
    .unwrap();
    let object = json.as_object().unwrap();
    assert_eq!(object.len(), REGISTRY.len());
    for (kind, aggregations) in REGISTRY {
        let listed: Vec<&str> = object[*kind]
            .as_array()
            .unwrap_or_else(|| panic!("missing kind {kind}"))
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(&listed, aggregations, "aggregations of {kind}");
    }
}
