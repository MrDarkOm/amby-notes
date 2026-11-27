//! The administrator commands of the subscription (appendix Н, Н3). Red tests, written before the
//! code. In-process servers: the clock of the server is controlled, so "inclusive through that
//! UTC day" is checked to the millisecond.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use amby_sync_conformance::client::{enroll, PASSWORD};
use amby_sync_conformance::{in_process_or_skip, Target};
use serde_json::{json, Value};

/// 2026-10-20 12:00:00 UTC, the start of the clock of the suite (`inprocess::START_MS`).
const START_MS: i64 = 1_792_497_600_000;
/// 2026-10-21 00:00:00 UTC: the end of a pin `--until 2026-10-20`.
const END_OF_START_DAY: i64 = 1_792_540_800_000;
/// 2026-10-26 00:00:00 UTC: the end of a pin `--until 2026-10-25`.
const END_OF_OCT_25: i64 = 1_792_972_800_000;
/// 2027-01-01 00:00:00 UTC: the end of a pin `--until 2026-12-31`.
const END_OF_2026: i64 = 1_798_761_600_000;

fn plans_text() -> String {
    json!({
        "default_plan": "free",
        "plans": {
            "free": {"title": "Free", "sync": false},
            "pro": {"title": "Pro", "sync": true}
        }
    })
    .to_string()
}

fn server() -> Target {
    Target::in_process_with_plans(&plans_text(), |_| {})
}

fn show(target: &Target, name: &str) -> Value {
    target
        .cli_ok(&["user", "plan", "show", name, "--json"])
        .json()
}

/// The plan fields may sit at the top of the object or inside `plan`; the plan of the owner
/// (Н3) names the fields `plan_until_ms` and `plan_expired` and not their place.
fn field(shown: &Value, name: &str) -> Value {
    let found = shown
        .get(name)
        .or_else(|| shown["plan"].get(name))
        .unwrap_or_else(|| panic!("`{name}` is missing in {shown}"));
    found.clone()
}

fn set_until(
    target: &Target,
    name: &str,
    plan: &str,
    day: &str,
) -> amby_sync_conformance::AdminOutput {
    target.cli(&["user", "plan", "set", name, plan, "--until", day])
}

// ----- --until: inclusive, UTC -----

#[test]
fn until_is_inclusive_through_that_utc_day_and_ends_at_midnight_after() {
    // Н3: `--until 2026-12-31` → access up to 00:00 UTC of 2027-01-01.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let name = &account.username;
    assert_eq!(set_until(&target, name, "pro", "2026-12-31").code, 0);
    let shown = show(&target, name);
    assert_eq!(field(&shown, "plan_until_ms"), END_OF_2026);
    assert_eq!(field(&shown, "plan_expired"), false);
    assert_eq!(shown["plan"]["name"], "pro");
    assert_eq!(shown["plan"]["pinned"], true);
}

#[test]
fn today_is_a_valid_end_and_the_access_lasts_to_the_last_millisecond_of_the_day() {
    // Н3: a date in the past is refused, today is not; the clock stands at noon of 2026-10-20.
    let target = server();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let name = &account.username;
    assert_eq!(set_until(&target, name, "pro", "2026-10-20").code, 0);
    assert_eq!(
        field(&show(&target, name), "plan_until_ms"),
        END_OF_START_DAY
    );
    control.advance(Duration::from_millis(
        (END_OF_START_DAY - START_MS - 1) as u64,
    ));
    let last = show(&target, name);
    assert_eq!(field(&last, "plan_expired"), false);
    assert_eq!(last["plan"]["name"], "pro");
    control.advance(Duration::from_millis(1));
    let ended = show(&target, name);
    assert_eq!(field(&ended, "plan_expired"), true);
    assert_eq!(ended["plan"]["name"], "free", "the default plan acts (Н2)");
    assert_eq!(ended["plan"]["pinned"], false);
    assert_eq!(
        field(&ended, "plan_until_ms"),
        END_OF_START_DAY,
        "the record of what was given is not rewritten (Н2)"
    );
}

#[test]
fn a_past_date_is_exit_2_and_nothing_changes() {
    // Н3: yesterday is in the past; the pin stays what it was.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let name = &account.username;
    assert_eq!(set_until(&target, name, "pro", "2026-10-25").code, 0);
    let before = show(&target, name);
    let refused = set_until(&target, name, "pro", "2026-10-19");
    assert_eq!(refused.code, 2, "{}", refused.stderr);
    assert!(
        !refused.stderr.trim().is_empty(),
        "the reason is told in words"
    );
    assert_eq!(show(&target, name), before);
    // on a user without a pin it creates no pin either
    let plain = enroll(&target, PASSWORD);
    assert_eq!(
        set_until(&target, &plain.username, "pro", "2020-01-01").code,
        2
    );
    assert_eq!(show(&target, &plain.username)["plan"]["pinned"], false);
}

#[test]
fn a_malformed_date_is_exit_2_and_nothing_changes() {
    // Н3: only `YYYY-MM-DD`; impossible days and other shapes are refused.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let name = &account.username;
    assert_eq!(set_until(&target, name, "pro", "2026-10-25").code, 0);
    let before = show(&target, name);
    for bad in [
        "2026-13-01",
        "2026-02-30",
        "2026-12-32",
        "26-12-31",
        "2026/12/31",
        "31-12-2026",
        "20261231",
        "tomorrow",
        "2026-12-31T00:00:00Z",
        "",
    ] {
        let refused = set_until(&target, name, "pro", bad);
        assert_eq!(refused.code, 2, "`{bad}`: {}", refused.stderr);
        assert_eq!(show(&target, name), before, "`{bad}` must change nothing");
    }
}

// ----- without --until, --default -----

#[test]
fn without_until_the_end_is_removed() {
    // Н3: `plan set <name> <plan>` pins for good.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let name = &account.username;
    assert_eq!(set_until(&target, name, "pro", "2026-10-25").code, 0);
    assert_eq!(field(&show(&target, name), "plan_until_ms"), END_OF_OCT_25);
    target.cli_ok(&["user", "plan", "set", name, "pro"]);
    let shown = show(&target, name);
    assert_eq!(field(&shown, "plan_until_ms"), Value::Null);
    assert_eq!(field(&shown, "plan_expired"), false);
    assert_eq!(shown["plan"]["pinned"], true);
}

#[test]
fn default_removes_the_plan_and_the_end() {
    // Н3: `plan set <name> --default`.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let name = &account.username;
    assert_eq!(set_until(&target, name, "pro", "2026-12-31").code, 0);
    assert_eq!(field(&show(&target, name), "plan_until_ms"), END_OF_2026);
    target.cli_ok(&["user", "plan", "set", name, "--default"]);
    let shown = show(&target, name);
    assert_eq!(shown["plan"]["pinned"], false);
    assert_eq!(shown["plan"]["name"], "free");
    assert_eq!(field(&shown, "plan_until_ms"), Value::Null);
    assert_eq!(field(&shown, "plan_expired"), false);
}

#[test]
fn an_unknown_plan_with_until_is_still_exit_2_and_changes_nothing() {
    // П53, Н3: the old refusals stand with the new option.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let name = &account.username;
    assert_eq!(set_until(&target, name, "pro", "2026-12-31").code, 0);
    let before = show(&target, name);
    assert_eq!(set_until(&target, name, "gold", "2026-12-31").code, 2);
    assert_eq!(show(&target, name), before);
}

// ----- the output -----

#[test]
fn user_plan_show_json_has_the_end_and_the_flag_of_expiry() {
    // Н3: `plan_until_ms` is a number or null, `plan_expired` is a boolean.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let shown = show(&target, &account.username);
    assert_eq!(field(&shown, "plan_until_ms"), Value::Null);
    assert_eq!(field(&shown, "plan_expired"), false);
    assert_eq!(
        set_until(&target, &account.username, "pro", "2026-10-25").code,
        0
    );
    let pinned = show(&target, &account.username);
    assert!(field(&pinned, "plan_until_ms").is_i64());
    assert!(field(&pinned, "plan_expired").is_boolean());
}

#[test]
fn user_list_json_has_the_end_and_the_flag_for_every_user() {
    // Н3: `user list --json` shows both for every user; the flag follows the clock of the server.
    let target = server();
    let control = in_process_or_skip!(target);
    let (limited, forever, plain) = (
        enroll(&target, PASSWORD),
        enroll(&target, PASSWORD),
        enroll(&target, PASSWORD),
    );
    assert_eq!(
        set_until(&target, &limited.username, "pro", "2026-10-25").code,
        0
    );
    target.cli_ok(&["user", "plan", "set", &forever.username, "pro"]);
    let row = |list: &Value, name: &str| -> Value {
        list.as_array()
            .unwrap()
            .iter()
            .find(|user| user["username"] == name)
            .unwrap_or_else(|| panic!("{name} is not in {list}"))
            .clone()
    };
    let list = target.cli_ok(&["user", "list", "--json"]).json();
    assert_eq!(
        field(&row(&list, &limited.username), "plan_until_ms"),
        END_OF_OCT_25
    );
    assert_eq!(field(&row(&list, &limited.username), "plan_expired"), false);
    assert_eq!(
        field(&row(&list, &forever.username), "plan_until_ms"),
        Value::Null
    );
    assert_eq!(field(&row(&list, &forever.username), "plan_expired"), false);
    assert_eq!(
        field(&row(&list, &plain.username), "plan_until_ms"),
        Value::Null
    );
    assert_eq!(field(&row(&list, &plain.username), "plan_expired"), false);
    control.advance(Duration::from_millis((END_OF_OCT_25 - START_MS) as u64));
    let later = target.cli_ok(&["user", "list", "--json"]).json();
    assert_eq!(field(&row(&later, &limited.username), "plan_expired"), true);
    assert_eq!(
        field(&row(&later, &forever.username), "plan_expired"),
        false
    );
}

#[test]
fn the_text_output_of_user_list_still_lists_everybody() {
    // П53, Н3: the plain output does not break with the new columns.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    assert_eq!(
        set_until(&target, &account.username, "pro", "2026-10-25").code,
        0
    );
    let text = target.cli_ok(&["user", "list"]).stdout;
    assert!(text.contains(&account.username), "{text}");
    assert!(
        text.contains("2026-10-25") || text.contains("2026-10-26"),
        "the end is visible to a person in the plain output: {text}"
    );
}
