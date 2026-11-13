//! The flag `sync` of a plan (appendix Н, Н1): parsing and the effective value. Pure functions,
//! no server. Red tests, written before the code.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_server::plans::{EffectiveLimits, Plan, PlansError, PlansFile};
use amby_sync_server::Config;

fn parse(text: &str) -> PlansFile {
    PlansFile::parse(text).unwrap_or_else(|error| panic!("must parse ({error:?}): {text}"))
}

fn sync_of(plan: Option<&Plan>) -> bool {
    EffectiveLimits::for_plan(plan, &Config::default()).sync
}

#[test]
fn sync_true_and_sync_false_are_accepted_and_read() {
    // Н1: both values are valid in a plan.
    let file = parse(r#"{"plans": {"paid": {"sync": true}, "free": {"sync": false}}}"#);
    assert_eq!(file.plans["paid"].sync, Some(true));
    assert_eq!(file.plans["free"].sync, Some(false));
}

#[test]
fn a_plan_without_the_field_has_no_opinion_and_the_old_files_still_parse() {
    // Н1: no field — `true`; the files written before the subscription work as they did.
    let file = parse(
        r#"{"default_plan": "small", "plans": {"small": {"title": "S", "max_spaces": 1,
            "max_total_bytes": 1000, "max_file_bytes": 100, "history_days": 3,
            "max_history_bytes": 500}, "free": {}}}"#,
    );
    assert_eq!(file.plans["small"].sync, None);
    assert_eq!(file.plans["free"].sync, None);
}

#[test]
fn a_plan_that_says_sync_false_has_effective_sync_false() {
    // Н1, Н4: the effective value of the plan.
    let off = parse(r#"{"plans": {"free": {"sync": false, "title": "Free"}}}"#);
    assert!(!sync_of(Some(&off.plans["free"])));
}

#[test]
fn sync_true_a_missing_field_and_no_plan_all_mean_true() {
    // Н1: a server without a file works exactly as before (the virtual plan of П52).
    let on = parse(r#"{"plans": {"paid": {"sync": true}, "old": {"max_spaces": 3}}}"#);
    assert!(sync_of(Some(&on.plans["paid"])));
    assert!(sync_of(Some(&on.plans["old"])), "missing field");
    assert!(sync_of(Some(&Plan::default())), "an empty plan");
    assert!(sync_of(None), "no plan at all");
}

#[test]
fn sync_does_not_change_the_limits_of_the_plan() {
    // П54 and Н1 are independent: the flag changes no number.
    let off =
        parse(r#"{"plans": {"free": {"sync": false, "max_spaces": 2, "max_file_bytes": 4000}}}"#);
    let limits = EffectiveLimits::for_plan(Some(&off.plans["free"]), &Config::default());
    assert_eq!(limits.max_spaces, Some(2));
    assert_eq!(limits.max_file_bytes, Some(4000));
    assert!(!limits.sync);
}

#[test]
fn a_sync_that_is_not_a_boolean_is_an_invalid_file() {
    // Н1, П51: a refusal to start, never a guess. Numbers, text, null, lists, objects.
    // Guard: the refusal is about the type, not about an unknown field.
    parse(r#"{"plans": {"a": {"sync": true}}}"#);
    for bad in [
        r#"{"plans": {"a": {"sync": "yes"}}}"#,
        r#"{"plans": {"a": {"sync": "true"}}}"#,
        r#"{"plans": {"a": {"sync": 1}}}"#,
        r#"{"plans": {"a": {"sync": 0}}}"#,
        r#"{"plans": {"a": {"sync": null}}}"#,
        r#"{"plans": {"a": {"sync": []}}}"#,
        r#"{"plans": {"a": {"sync": {"on": true}}}}"#,
    ] {
        match PlansFile::parse(bad) {
            Err(PlansError::Invalid(_)) => {}
            other => panic!("expected PlansError::Invalid for {bad}, got {other:?}"),
        }
    }
}
