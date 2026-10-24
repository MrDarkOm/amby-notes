//! The plans file and the effective limits (appendix Е: П50–П54). Pure functions, no server:
//! the red tests of the step "tests first", written before the code.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::path::PathBuf;

use amby_sync_server::plans::{valid_plan_name, EffectiveLimits, Plan, PlansError, PlansFile};
use amby_sync_server::Config;

/// The example of the owner (П51): three plans, decimal units.
const OWNER_FILE: &str = r#"{
  "default_plan": "standard",
  "plans": {
    "standard": {"title": "Стандарт", "max_spaces": 1, "max_total_bytes": 1000000000,
                 "max_file_bytes": 20000000, "history_days": 30, "max_history_bytes": 1000000000},
    "plus": {"title": "Плюс", "max_spaces": 10, "max_total_bytes": 10000000000,
             "max_file_bytes": 200000000, "history_days": 365, "max_history_bytes": 10000000000},
    "unlimited": {"title": "Без ограничений"}
  }
}"#;

fn parse_err(text: &str) -> PlansError {
    match PlansFile::parse(text) {
        Ok(file) => panic!("the file must be refused, got {file:?}: {text}"),
        Err(error) => error,
    }
}

#[test]
fn the_owner_file_is_read_with_decimal_numbers() {
    // П50, П51, Е.0-4: 1 GB is 1 000 000 000, 20 MB is 20 000 000.
    let file = PlansFile::parse(OWNER_FILE).expect("the example of П51 must parse");
    assert_eq!(file.default_plan.as_deref(), Some("standard"));
    assert_eq!(file.plans.len(), 3);
    let standard = &file.plans["standard"];
    assert_eq!(standard.title.as_deref(), Some("Стандарт"));
    assert_eq!(standard.max_spaces, Some(1));
    assert_eq!(standard.max_total_bytes, Some(1_000_000_000));
    assert_eq!(standard.max_file_bytes, Some(20_000_000));
    assert_eq!(standard.history_days, Some(30));
    assert_eq!(standard.max_history_bytes, Some(1_000_000_000));
    let plus = &file.plans["plus"];
    assert_eq!(plus.max_spaces, Some(10));
    assert_eq!(plus.max_total_bytes, Some(10_000_000_000));
    assert_eq!(plus.max_file_bytes, Some(200_000_000));
    assert_eq!(plus.history_days, Some(365));
    assert_eq!(
        file.plans["unlimited"],
        Plan {
            title: Some("Без ограничений".into()),
            ..Plan::default()
        }
    );
}

#[test]
fn a_file_without_a_default_plan_and_a_plan_without_limits_are_valid() {
    // П50, П52: every limit is optional; `default_plan` is optional too.
    let file = PlansFile::parse(r#"{"plans": {"free": {}}}"#).unwrap();
    assert_eq!(file.default_plan, None);
    assert_eq!(file.plans["free"], Plan::default());
    let empty = PlansFile::parse(r#"{"plans": {}}"#).unwrap();
    assert!(empty.plans.is_empty());
}

#[test]
fn unknown_fields_are_refused_at_both_levels() {
    // П51: a typo in a limit must not silently remove the limit.
    for text in [
        r#"{"plans": {"a": {"max_file_byte": 5}}}"#,
        r#"{"plans": {"a": {"max_file_bytes": 5, "colour": "red"}}}"#,
        r#"{"default_plan": "a", "plans": {"a": {}}, "version": 1}"#,
    ] {
        assert!(matches!(parse_err(text), PlansError::Invalid(_)), "{text}");
    }
}

#[test]
fn zero_negative_fractional_and_text_numbers_are_refused() {
    // П50, П51: whole numbers of at least 1 (every limit, `history_days` included).
    for field in [
        "max_spaces",
        "max_total_bytes",
        "max_file_bytes",
        "history_days",
        "max_history_bytes",
    ] {
        for value in ["0", "-1", "1.5", "\"20MB\"", "true", "1e3"] {
            let text = format!(r#"{{"plans": {{"a": {{"{field}": {value}}}}}}}"#);
            assert!(
                matches!(parse_err(&text), PlansError::Invalid(_)),
                "`{field}: {value}` must be refused"
            );
        }
    }
    let title = r#"{"plans": {"a": {"title": 5}}}"#;
    assert!(matches!(parse_err(title), PlansError::Invalid(_)));
}

#[test]
fn a_repeated_plan_name_is_refused() {
    // П51: JSON allows it, the file does not.
    let text = r#"{"plans": {"a": {"max_spaces": 1}, "a": {"max_spaces": 2}}}"#;
    assert!(matches!(parse_err(text), PlansError::Invalid(_)));
}

#[test]
fn a_default_plan_that_is_not_in_the_file_is_refused() {
    // П51.
    let text = r#"{"default_plan": "gold", "plans": {"a": {}}}"#;
    assert!(matches!(parse_err(text), PlansError::Invalid(_)));
}

#[test]
fn plan_names_follow_the_rule_of_the_table() {
    // П50: [a-z0-9_-]{1,32}.
    let long_ok = "a".repeat(32);
    let long_bad = "a".repeat(33);
    for name in ["standard", "a", "plus-2_x", "0", long_ok.as_str()] {
        assert!(valid_plan_name(name), "`{name}` is a valid name");
        assert!(
            PlansFile::parse(&format!(r#"{{"plans": {{"{name}": {{}}}}}}"#)).is_ok(),
            "`{name}` is accepted in a file"
        );
    }
    for name in ["", "Plus", "a b", "а", "a.b", long_bad.as_str(), "a/b"] {
        assert!(!valid_plan_name(name), "`{name}` is not a valid name");
        let text = serde_json::json!({ "plans": { name: {} } }).to_string();
        assert!(
            matches!(parse_err(&text), PlansError::Invalid(_)),
            "`{name}` is refused in a file"
        );
    }
}

#[test]
fn text_that_is_not_json_or_not_an_object_is_refused() {
    for text in [
        "",
        "plans",
        "[]",
        "{",
        r#"{"plans": []}"#,
        r#"{"plans": 5}"#,
        "null",
    ] {
        assert!(
            matches!(parse_err(text), PlansError::Invalid(_)),
            "`{text}` must be refused"
        );
    }
}

#[test]
fn no_file_means_no_plans_and_a_broken_file_is_an_error() {
    // П52: no file, no plans. П51: a file that is there must be right.
    let dir = tempfile::tempdir().unwrap();
    let missing = PlansFile::load(&dir.path().join("plans.json")).unwrap();
    assert_eq!(missing, PlansFile::default());
    let path = dir.path().join("plans.json");
    std::fs::write(&path, OWNER_FILE).unwrap();
    assert_eq!(PlansFile::load(&path).unwrap().plans.len(), 3);
    std::fs::write(&path, "{ broken").unwrap();
    assert!(matches!(
        PlansFile::load(&path),
        Err(PlansError::Invalid(_))
    ));
}

#[test]
fn a_pinned_plan_wins_otherwise_the_default_plan_is_used() {
    // П52: empty is "by default": the default plan of the file at this moment.
    let file = PlansFile::parse(OWNER_FILE).unwrap();
    assert_eq!(file.resolve(None).map(|(name, _)| name), Some("standard"));
    assert_eq!(
        file.resolve(Some("plus")).map(|(name, _)| name),
        Some("plus")
    );
    assert_eq!(
        file.resolve(Some("plus")).map(|(_, plan)| plan.max_spaces),
        Some(Some(10))
    );
    assert_eq!(
        file.resolve(Some("gold")),
        None,
        "a pinned plan that is not in the file"
    );
}

#[test]
fn changing_the_default_plan_moves_the_unpinned_and_not_the_pinned() {
    // П52.
    let before = PlansFile::parse(OWNER_FILE).unwrap();
    let after = PlansFile::parse(
        &OWNER_FILE.replace(r#""default_plan": "standard""#, r#""default_plan": "plus""#),
    )
    .unwrap();
    assert_eq!(before.resolve(None).map(|(name, _)| name), Some("standard"));
    assert_eq!(after.resolve(None).map(|(name, _)| name), Some("plus"));
    assert_eq!(
        before.resolve(Some("unlimited")).map(|(n, _)| n),
        Some("unlimited")
    );
    assert_eq!(
        after.resolve(Some("unlimited")).map(|(n, _)| n),
        Some("unlimited")
    );
}

#[test]
fn without_a_file_and_a_default_there_is_no_plan() {
    // П52: the virtual plan without limits; `resolve` says "none".
    assert_eq!(PlansFile::default().resolve(None), None);
    let no_default = PlansFile::parse(r#"{"plans": {"a": {}}}"#).unwrap();
    assert_eq!(no_default.resolve(None), None);
}

#[test]
fn pinned_users_whose_plan_is_missing_are_named() {
    // П52: refuse to start, and `plans check` lists them.
    let file = PlansFile::parse(OWNER_FILE).unwrap();
    let pinned = vec![
        ("ann".to_string(), "plus".to_string()),
        ("bob".to_string(), "gold".to_string()),
        ("cid".to_string(), "silver".to_string()),
    ];
    match file.check_pinned(&pinned) {
        Err(PlansError::MissingPinned(text)) => {
            assert!(text.contains("bob") && text.contains("gold"), "{text}");
            assert!(text.contains("cid") && text.contains("silver"), "{text}");
            assert!(!text.contains("ann"), "ann's plan exists: {text}");
        }
        other => panic!("expected MissingPinned, got {other:?}"),
    }
    file.check_pinned(&pinned[..1]).expect("all plans exist");
}

fn config_with(max_blob: u64, quota: Option<u64>, retain_days: u64) -> Config {
    Config {
        max_blob_bytes: max_blob,
        quota_bytes_per_user: quota,
        retain_version_days: retain_days,
        ..Config::default()
    }
}

#[test]
fn the_file_limit_is_the_smaller_of_the_plan_and_the_server_ceiling() {
    // П54.
    let plan = Plan {
        max_file_bytes: Some(4000),
        ..Plan::default()
    };
    assert_eq!(
        EffectiveLimits::for_plan(Some(&plan), &config_with(3000, None, 30)).max_file_bytes,
        Some(3000)
    );
    assert_eq!(
        EffectiveLimits::for_plan(Some(&plan), &config_with(9000, None, 30)).max_file_bytes,
        Some(4000)
    );
    assert_eq!(
        EffectiveLimits::for_plan(None, &config_with(9000, None, 30)).max_file_bytes,
        Some(9000),
        "no plan: the ceiling of the server alone"
    );
    assert_eq!(
        EffectiveLimits::for_plan(Some(&Plan::default()), &config_with(9000, None, 30))
            .max_file_bytes,
        Some(9000),
        "a plan without the limit: the ceiling of the server"
    );
}

#[test]
fn the_quota_is_the_smaller_of_the_plan_and_the_server_quota_and_empty_means_the_other() {
    // П54.
    let plan = Plan {
        max_total_bytes: Some(10_000),
        ..Plan::default()
    };
    let limits = |plan: Option<&Plan>, quota| {
        EffectiveLimits::for_plan(plan, &config_with(1 << 29, quota, 30)).max_total_bytes
    };
    assert_eq!(limits(Some(&plan), Some(6000)), Some(6000));
    assert_eq!(limits(Some(&plan), Some(60_000)), Some(10_000));
    assert_eq!(limits(Some(&plan), None), Some(10_000));
    assert_eq!(limits(None, Some(6000)), Some(6000));
    assert_eq!(limits(None, None), None);
    assert_eq!(limits(Some(&Plan::default()), None), None);
}

#[test]
fn spaces_and_the_history_ceiling_come_from_the_plan_only() {
    // П54.
    let plan = Plan {
        max_spaces: Some(2),
        max_history_bytes: Some(7000),
        ..Plan::default()
    };
    let limits = EffectiveLimits::for_plan(Some(&plan), &config_with(1 << 29, Some(5), 30));
    assert_eq!(limits.max_spaces, Some(2));
    assert_eq!(limits.max_history_bytes, Some(7000));
    let none = EffectiveLimits::for_plan(None, &config_with(1 << 29, Some(5), 30));
    assert_eq!(none.max_spaces, None);
    assert_eq!(none.max_history_bytes, None);
}

#[test]
fn history_days_come_from_the_plan_and_without_it_from_the_server_setting() {
    // П50, П54: the days are always a number.
    let with = Plan {
        history_days: Some(365),
        ..Plan::default()
    };
    assert_eq!(
        EffectiveLimits::for_plan(Some(&with), &config_with(1 << 29, None, 30)).history_days,
        365
    );
    assert_eq!(
        EffectiveLimits::for_plan(Some(&Plan::default()), &config_with(1 << 29, None, 12))
            .history_days,
        12
    );
    assert_eq!(
        EffectiveLimits::for_plan(None, &config_with(1 << 29, None, 7)).history_days,
        7
    );
}

#[test]
fn the_plans_file_setting_is_read_from_the_environment() {
    // П51: AMBY_SYNC_PLANS_FILE; by default there is none (the file is `<data_dir>/plans.json`).
    assert_eq!(Config::default().plans_file, None);
    let vars: HashMap<String, String> = [(
        "AMBY_SYNC_PLANS_FILE".to_string(),
        "/etc/amby/plans.json".to_string(),
    )]
    .into();
    let config = Config::from_map(&vars).unwrap();
    assert_eq!(
        config.plans_file,
        Some(PathBuf::from("/etc/amby/plans.json"))
    );
    let empty: HashMap<String, String> =
        [("AMBY_SYNC_PLANS_FILE".to_string(), "  ".to_string())].into();
    assert!(
        Config::from_map(&empty).is_err(),
        "an empty path is a mistake (П40)"
    );
}
