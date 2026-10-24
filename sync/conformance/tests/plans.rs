//! Plans on a running server and `GET /v1/account` (appendix Е: П50–П54, П57, П59–П61).
//! In-process servers only: the plans file lives in the data directory and the clock moves.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use amby_sync_conformance::client::{enroll, hex16, new_body, new_item, Account, Space, PASSWORD};
use amby_sync_conformance::{in_process_or_skip, Target};
use amby_sync_server::AppState;
use serde_json::{json, Value};

/// Small numbers so that a test uploads bytes, not megabytes. Same shape as the owner's file.
fn plans_text() -> String {
    json!({
        "default_plan": "small",
        "plans": {
            "small": {"title": "Small", "max_spaces": 2, "max_total_bytes": 10_000,
                      "max_file_bytes": 4_000, "history_days": 10, "max_history_bytes": 20_000},
            "big": {"title": "Big", "max_spaces": 5, "max_total_bytes": 100_000,
                    "max_file_bytes": 50_000, "history_days": 100},
            "mid": {"title": "Mid", "max_file_bytes": 4_000},
            "free": {"title": "Free"}
        }
    })
    .to_string()
}

fn server() -> Target {
    Target::in_process_with_plans(&plans_text(), |_| {})
}

fn pin(target: &Target, account: &Account, plan: &str) {
    target.cli_ok(&["user", "plan", "set", &account.username, plan]);
}

#[test]
fn a_server_without_a_plans_file_shows_no_plan_and_only_its_ceilings() {
    // П52, П54, П61: no file → `plan.name` is null and the limits are the ceilings of the server.
    let target = Target::in_process_with(|config| {
        config.max_blob_bytes = 7_000;
        config.quota_bytes_per_user = Some(9_000);
        config.retain_version_days = 12;
    });
    let _ = in_process_or_skip!(target);
    let overview = enroll(&target, PASSWORD).overview();
    assert_eq!(
        overview["plan"],
        json!({"name": null, "title": null, "pinned": false})
    );
    let limits = &overview["limits"];
    assert_eq!(limits["max_spaces"], Value::Null);
    assert_eq!(limits["max_total_bytes"], 9_000);
    assert_eq!(limits["max_file_bytes"], 7_000);
    assert_eq!(limits["history_days"], 12);
    assert_eq!(
        overview["usage"],
        json!({"live_bytes": 0, "pending_bytes": 0, "history_bytes": 0, "spaces": 0})
    );
    assert_eq!(overview["spaces"], json!([]));
}

#[test]
fn without_a_file_and_without_ceilings_every_limit_is_null_and_history_is_a_number() {
    // П61: `null` is no limit; `history_days` is always a number.
    let target = Target::in_process();
    let _ = in_process_or_skip!(target);
    let overview = enroll(&target, PASSWORD).overview();
    assert_eq!(overview["limits"]["max_spaces"], Value::Null);
    assert_eq!(overview["limits"]["max_total_bytes"], Value::Null);
    assert_eq!(overview["limits"]["max_file_bytes"], 536_870_912);
    assert_eq!(overview["limits"]["history_days"], 30);
}

#[test]
fn a_user_without_a_pin_gets_the_default_plan_with_its_effective_limits() {
    // П52, П61.
    let target = server();
    let _ = in_process_or_skip!(target);
    let overview = enroll(&target, PASSWORD).overview();
    assert_eq!(
        overview["plan"],
        json!({"name": "small", "title": "Small", "pinned": false})
    );
    let limits = &overview["limits"];
    assert_eq!(limits["max_spaces"], 2);
    assert_eq!(limits["max_total_bytes"], 10_000);
    assert_eq!(limits["max_file_bytes"], 4_000);
    assert_eq!(limits["history_days"], 10);
}

#[test]
fn the_account_also_tells_the_ceiling_of_the_history() {
    // GAP IN П61, found while writing the tests of У2: the line "История 30 дней, до 1 ГБ" needs
    // `max_history_bytes` (П50), and `limits` of П61 does not list it. The tests ask for it as one
    // more key of `limits`; `null` is no ceiling. To be confirmed by the reviewer.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    assert_eq!(account.overview()["limits"]["max_history_bytes"], 20_000);
    target.cli_ok(&["user", "plan", "set", &account.username, "big"]);
    assert_eq!(
        account.overview()["limits"]["max_history_bytes"],
        Value::Null
    );
}

#[test]
fn a_pinned_user_shows_the_pinned_plan_and_a_plan_without_limits_shows_nulls() {
    // П52, П61.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin(&target, &account, "free");
    let overview = account.overview();
    assert_eq!(
        overview["plan"],
        json!({"name": "free", "title": "Free", "pinned": true})
    );
    assert_eq!(overview["limits"]["max_spaces"], Value::Null);
    assert_eq!(overview["limits"]["max_total_bytes"], Value::Null);
    assert_eq!(
        overview["limits"]["max_file_bytes"], 536_870_912,
        "the ceiling of the server"
    );
    assert_eq!(
        overview["limits"]["history_days"], 30,
        "no days in the plan: the setting of the server"
    );
}

#[test]
fn the_ceilings_of_the_server_cut_the_plan_in_the_account() {
    // П54: the smaller of the two, for the file and for the quota.
    let target = Target::in_process_with_plans(&plans_text(), |config| {
        config.max_blob_bytes = 3_000;
        config.quota_bytes_per_user = Some(6_000);
    });
    let _ = in_process_or_skip!(target);
    let limits = enroll(&target, PASSWORD).overview()["limits"].clone();
    assert_eq!(limits["max_file_bytes"], 3_000);
    assert_eq!(limits["max_total_bytes"], 6_000);
    assert_eq!(limits["max_spaces"], 2, "spaces come from the plan only");
}

#[test]
fn changing_the_default_plan_moves_the_unpinned_users_and_leaves_the_pinned() {
    // П52: "by default" means the default plan of the file at this moment.
    let target = server();
    let control = in_process_or_skip!(target);
    let (unpinned, pinned) = (enroll(&target, PASSWORD), enroll(&target, PASSWORD));
    pin(&target, &pinned, "small");
    control
        .write_plans(&plans_text().replace(r#""default_plan":"small""#, r#""default_plan":"big""#));
    control.restart();
    assert_eq!(unpinned.overview()["plan"]["name"], "big");
    assert_eq!(unpinned.overview()["plan"]["pinned"], false);
    assert_eq!(pinned.overview()["plan"]["name"], "small");
    assert_eq!(pinned.overview()["plan"]["pinned"], true);
}

#[test]
fn the_account_needs_a_token() {
    // П5, П61.
    let target = Target::from_env();
    target
        .api
        .get("/v1/account", None)
        .expect_error(401, "unauthorized");
    target
        .api
        .get("/v1/account", Some(&"0".repeat(64)))
        .expect_error(401, "unauthorized");
}

/// One item with a version that was replaced (history) and one that stays.
fn space_with(account: &Account, live: usize, history: usize) -> Space {
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.raw_file(&item, 0, "a.md", history)]);
    space.commit_ok(&[space.raw_file(&item, 1, "a.md", live)]);
    space
}

#[test]
fn the_usage_is_the_sum_of_the_spaces_and_sizes_are_encrypted_sizes() {
    // П55, П61: live, pending and history in bytes; the sizes of the spaces add up to the total;
    // a body nobody committed is pending and belongs to no space row.
    let target = Target::in_process();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let first = space_with(&account, 2_000, 3_000);
    let second = account.create_space();
    second.commit_ok(&[second.raw_file(&new_item(), 0, "b.md", 1_000)]);
    second.init_blob(&new_body(), 500).expect(201);
    let overview = account.overview();
    assert_eq!(
        overview["usage"],
        json!({"live_bytes": 3_000, "pending_bytes": 500, "history_bytes": 3_000, "spaces": 2})
    );
    let rows = overview["spaces"].as_array().unwrap();
    let find = |space: &Space| {
        rows.iter()
            .find(|row| row["space_id"] == hex16(space.id.as_bytes()).as_str())
            .unwrap_or_else(|| panic!("the space is missing in {overview}"))
    };
    assert_eq!(find(&first)["live_bytes"], 2_000);
    assert_eq!(find(&first)["history_bytes"], 3_000);
    assert_eq!(find(&second)["live_bytes"], 1_000);
    assert_eq!(find(&second)["history_bytes"], 0);
    let live_sum: u64 = rows
        .iter()
        .map(|row| row["live_bytes"].as_u64().unwrap())
        .sum();
    let history_sum: u64 = rows
        .iter()
        .map(|row| row["history_bytes"].as_u64().unwrap())
        .sum();
    assert_eq!(live_sum, overview["usage"]["live_bytes"].as_u64().unwrap());
    assert_eq!(
        history_sum,
        overview["usage"]["history_bytes"].as_u64().unwrap()
    );
}

#[test]
fn nobody_sees_the_data_of_another_user_in_the_account() {
    // П6, П61.
    let target = Target::in_process();
    let _ = in_process_or_skip!(target);
    let (mine, other) = (enroll(&target, PASSWORD), enroll(&target, PASSWORD));
    space_with(&other, 4_000, 4_000);
    other.create_space().init_blob(&new_body(), 700).expect(201);
    let overview = mine.overview();
    assert_eq!(
        overview["usage"],
        json!({"live_bytes": 0, "pending_bytes": 0, "history_bytes": 0, "spaces": 0})
    );
    assert_eq!(overview["spaces"], json!([]));
}

#[test]
fn the_same_blob_id_in_two_spaces_is_counted_in_each() {
    // П55: (space, blob_id) is never merged across spaces or users.
    let target = Target::in_process();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let (first, second) = (account.create_space(), account.create_space());
    let body = new_body();
    for space in [&first, &second] {
        space.upload_sealed(&body, &[1u8; 3_000]);
        space.commit_ok(&[space.file_with_uploaded_body(&new_item(), 0, "a.md", b"x", &body)]);
    }
    assert_eq!(account.overview()["usage"]["live_bytes"], 6_000);
}

// ----- the start-up check (П51, П52) -----

fn fresh_state(control: &amby_sync_conformance::inprocess::InProcess) -> AppState {
    AppState::open(
        control.config(),
        control.clock.clone() as Arc<dyn amby_sync_server::Clock>,
    )
}

#[test]
fn a_valid_file_passes_the_start_up_check() {
    // П51.
    let target = server();
    let control = in_process_or_skip!(target);
    fresh_state(control)
        .check_plans()
        .expect("the file of the suite is valid");
}

#[test]
fn a_missing_file_passes_the_start_up_check() {
    // П52: no file, no plans, no limits — the server works exactly as before.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    fresh_state(control).check_plans().expect("no file is fine");
}

#[test]
fn a_broken_file_stops_the_start() {
    // П51: an unknown field, a zero, a `default_plan` without a plan.
    let target = server();
    let control = in_process_or_skip!(target);
    for broken in [
        r#"{"plans": {"a": {"max_file_byte": 5}}}"#,
        r#"{"plans": {"a": {"max_spaces": 0}}}"#,
        r#"{"default_plan": "gold", "plans": {"a": {}}}"#,
        "not json at all",
    ] {
        control.write_plans(broken);
        let error = fresh_state(control)
            .check_plans()
            .expect_err("a broken file must stop the start");
        assert!(!error.to_string().is_empty(), "the reason is told in words");
    }
}

#[test]
fn a_pinned_plan_that_the_file_lost_stops_the_start_and_names_the_users() {
    // П52, Е.10-5: a typo must not silently free or squeeze anybody.
    let target = server();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin(&target, &account, "big");
    let without_big =
        json!({"default_plan": "small", "plans": {"small": {"max_spaces": 2}}}).to_string();
    control.write_plans(&without_big);
    let error = fresh_state(control)
        .check_plans()
        .expect_err("the plan `big` is gone but a user is pinned to it");
    let text = error.to_string();
    assert!(
        text.contains(&account.username) && text.contains("big"),
        "{text}"
    );
}

// ----- the codes (П59) with the plan as the source -----

#[test]
fn a_body_over_the_plan_limit_is_413_with_the_plan_as_the_source() {
    // П59, П60-2.
    let target = server();
    let _ = in_process_or_skip!(target);
    let space = enroll(&target, PASSWORD).create_space();
    space.init_blob(&new_body(), 4_000).expect(201);
    let refused = space
        .init_blob(&new_body(), 4_001)
        .expect_error(413, "blob_too_large");
    assert_eq!(
        refused.details(),
        json!({"size": 4_001, "max_bytes": 4_000, "source": "plan"})
    );
}

#[test]
fn a_body_over_the_ceiling_of_the_server_is_413_with_the_server_as_the_source() {
    // П59, П54: the ceiling is the smaller of the two.
    let target =
        Target::in_process_with_plans(&plans_text(), |config| config.max_blob_bytes = 3_000);
    let _ = in_process_or_skip!(target);
    let space = enroll(&target, PASSWORD).create_space();
    let refused = space
        .init_blob(&new_body(), 3_001)
        .expect_error(413, "blob_too_large");
    assert_eq!(
        refused.details(),
        json!({"size": 3_001, "max_bytes": 3_000, "source": "server"})
    );
}

#[test]
fn a_server_without_a_plan_also_says_where_the_limit_comes_from() {
    // П59: `details` on every 413, plans or not.
    let target = Target::in_process_with(|config| config.max_blob_bytes = 3_000);
    let _ = in_process_or_skip!(target);
    let space = enroll(&target, PASSWORD).create_space();
    let refused = space
        .init_blob(&new_body(), 5_000)
        .expect_error(413, "blob_too_large");
    assert_eq!(
        refused.details(),
        json!({"size": 5_000, "max_bytes": 3_000, "source": "server"})
    );
}

#[test]
fn the_plan_applies_at_once_after_the_command_without_a_restart() {
    // П53: the plan is read from the database at every request.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    space
        .init_blob(&new_body(), 5_000)
        .expect_error(413, "blob_too_large");
    pin(&target, &account, "big");
    space.init_blob(&new_body(), 5_000).expect(201);
    pin(&target, &account, "small");
    space
        .init_blob(&new_body(), 4_001)
        .expect_error(413, "blob_too_large");
}

// ----- lowering a plan (П57): nothing is deleted or squeezed -----

fn count(control: &amby_sync_conformance::inprocess::InProcess, table: &str) -> i64 {
    control.sql(|conn| {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    })
}

#[test]
fn lowering_the_plan_deletes_nothing_on_the_server() {
    // П57: after a smaller plan the rows of `blobs` and `versions` are all there, a cleanup
    // removes nothing that is not yet due, and everything can still be downloaded.
    let target = server();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin(&target, &account, "big");
    let space = account.create_space();
    let (item, other) = (new_item(), new_item());
    let big_file = space.raw_file(&item, 0, "big.bin", 30_000);
    let big_body = big_file.body.unwrap();
    space.commit_ok(&[big_file, space.raw_file(&other, 0, "o.md", 3_000)]);
    let (blobs, versions) = (count(control, "blobs"), count(control, "versions"));
    pin(&target, &account, "small");
    control.run_maintenance();
    assert_eq!(
        (count(control, "blobs"), count(control, "versions")),
        (blobs, versions)
    );
    space.download(&big_body).expect(200);
    assert_eq!(space.all_changes(0).len(), 2);
}

#[test]
fn over_the_new_quota_growing_is_refused_and_shrinking_goes_through() {
    // П56-а, П57-а: the user holds 30 000 bytes, the plan now allows 10 000.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin(&target, &account, "big");
    let space = account.create_space();
    let (large, small) = (new_item(), new_item());
    space.commit_ok(&[space.raw_file(&large, 0, "large.bin", 30_000)]);
    space.commit_ok(&[space.raw_file(&small, 0, "small.md", 1_000)]);
    pin(&target, &account, "small");
    // growth: a new body, and a new file
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
    // the larger version of a file that is already there is growth as well
    space
        .init_blob_replacing(&new_body(), 2_000, &small)
        .expect_error(507, "quota_exceeded");
    // shrinking: a smaller body for the large file, credited by `replaces`
    let smaller = space.raw_file_replacing(&large, 1, "large.bin", 3_000);
    space.commit_ok(&[smaller]);
    // deleting
    space.commit_ok(&[space.deletion(&small, 1, "small.md")]);
}

#[test]
fn a_file_bigger_than_the_new_limit_stays_readable_and_only_its_new_version_is_refused() {
    // П57-в.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin(&target, &account, "big");
    let space = account.create_space();
    let item = new_item();
    let first = space.raw_file(&item, 0, "large.bin", 30_000);
    let body = first.body.unwrap();
    space.commit_ok(&[first]);
    pin(&target, &account, "mid");
    space.download(&body).expect(200);
    space
        .init_blob(&new_body(), 30_000)
        .expect_error(413, "blob_too_large");
    let changes = space.all_changes(0);
    assert_eq!(changes.len(), 1, "the file is still in the feed");
}

#[test]
fn a_commit_that_points_at_an_already_uploaded_big_body_is_413_and_nothing_is_applied() {
    // П60-3: the body was uploaded under the old plan; the commit comes under the new one.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin(&target, &account, "big");
    let space = account.create_space();
    let big = space.raw_file(&new_item(), 0, "big.bin", 30_000);
    let fine = space.raw_file(&new_item(), 0, "fine.md", 1_000);
    pin(&target, &account, "mid");
    let refused = space
        .commit(&[fine.clone(), big.clone()])
        .expect_error(413, "blob_too_large");
    assert_eq!(
        refused.details(),
        json!({"size": 30_000, "max_bytes": 4_000, "source": "plan"})
    );
    assert!(
        space.all_changes(0).is_empty(),
        "the whole commit is refused (П27)"
    );
    space.versions(&fine.item).expect_error(404, "not_found");
    space.download(&big.body.unwrap()).expect(200);
}

#[test]
fn more_spaces_than_the_plan_allows_all_keep_working_and_only_a_new_one_is_refused() {
    // П57-б, П60-1, Д77.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin(&target, &account, "big");
    let spaces: Vec<Space> = (0..3).map(|_| account.create_space()).collect();
    pin(&target, &account, "small");
    let refused = account
        .post("/v1/spaces", account.new_space_request("Another").2)
        .expect_error(403, "space_limit");
    assert_eq!(refused.details(), json!({"max_spaces": 2, "spaces": 3}));
    assert_eq!(
        account.get("/v1/spaces").expect(200).json()["spaces"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    for space in &spaces {
        space.commit_ok(&[space.raw_file(&new_item(), 0, "a.md", 100)]);
        assert_eq!(space.all_changes(0).len(), 1);
    }
}
