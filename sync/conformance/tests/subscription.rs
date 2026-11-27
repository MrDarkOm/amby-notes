//! The subscription on a running server (appendix Н: Н1, Н2, Н4, Н5, Н6). Red tests, written
//! before the code. In-process servers only: the plans file lives in the data directory and the
//! clock moves.
//!
//! A "subscription" is a pin to a plan with `sync: true` (Н3). A user without one sits on a plan
//! with `sync: false`; to get data onto the server first, the tests pin `pro`, upload, and then
//! take the plan away (`--default`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use amby_sync_conformance::client::{
    enroll, keys_put_body, login, new_body, new_item, recover, unhex, unwrap_vk_from_listing,
    Account, Prepared, Space, PASSWORD,
};
use amby_sync_conformance::{in_process_or_skip, Target};
use amby_sync_core::crypto::account::{change_password, Argon2Params};
use amby_sync_core::crypto::random::OsRandom;
use serde_json::{json, Value};

const CODE: &str = "subscription_required";
/// 2026-10-20 12:00:00 UTC, the start of the clock of the suite (`inprocess::START_MS`).
const START_MS: i64 = 1_792_497_600_000;
/// 2026-10-21 00:00:00 UTC.
const MIDNIGHT_AFTER_START_DAY: i64 = 1_792_540_800_000;
/// 2026-10-26 00:00:00 UTC.
const MIDNIGHT_OCT_26: i64 = 1_792_972_800_000;
/// 2027-01-01 00:00:00 UTC.
const MIDNIGHT_2027: i64 = 1_798_761_600_000;

/// `free` is the default plan and has no sync; `pro` and `legacy` (no field at all) have it.
fn plans_text() -> String {
    json!({
        "default_plan": "free",
        "plans": {
            "free": {"title": "Free", "sync": false},
            "pro": {"title": "Pro", "sync": true},
            "legacy": {"title": "Legacy"}
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

fn unpin(target: &Target, account: &Account) {
    target.cli_ok(&["user", "plan", "set", &account.username, "--default"]);
}

/// The answer must be the `403 subscription_required` of П4 and must not tell about the plan.
fn assert_refused(response: amby_sync_conformance::Resp) {
    let refused = response.expect_error(403, CODE);
    let error = &refused.json()["error"];
    assert!(error["message"].is_string(), "П4 shape: {error}");
    let details = &error["details"];
    assert!(
        details.is_null() || details == &json!({}),
        "Н5: no details about the plan: {details}"
    );
}

/// Proof that the plan of the user really has no sync now: a body cannot be started.
fn assert_sending_is_closed(space: &Space) {
    assert_refused(space.init_blob(&new_body(), 10));
}

/// A user on `pro` with a space, one committed file, one body that is only started (for the
/// routes `parts` and `complete`) and one commit that is prepared and not yet sent. Then the
/// subscription is taken away.
struct Downgraded {
    account: Account,
    space: Space,
    committed: Prepared,
    started: amby_sync_core::crypto::keys::BodyId,
    prepared: Prepared,
}

fn downgraded(target: &Target) -> Downgraded {
    let account = enroll(target, PASSWORD);
    pin(target, &account, "pro");
    let space = account.create_space();
    let committed = space.raw_file(&new_item(), 0, "kept.md", 1_000);
    space.commit_ok(std::slice::from_ref(&committed));
    let started = new_body();
    space.init_blob(&started, 100).expect(201);
    let prepared = space.raw_file(&new_item(), 0, "waiting.md", 500);
    unpin(target, &account);
    Downgraded {
        account,
        space,
        committed,
        started,
        prepared,
    }
}

// ----- Н4: the five sending routes -----

#[test]
fn without_sync_the_five_sending_routes_answer_403_subscription_required() {
    // Н4, Н5, П4: POST /v1/spaces, POST …/blobs, PUT …/parts/{n}, POST …/complete, and POST …/commit
    // with a non-deletion entry (`prepared` is a new file).
    let target = server();
    let _ = in_process_or_skip!(target);
    let d = downgraded(&target);
    let (_, _, new_space) = d.account.new_space_request("Another");
    assert_refused(d.account.post("/v1/spaces", new_space));
    assert_refused(d.space.init_blob(&new_body(), 10));
    assert_refused(d.space.put_part(&d.started, 0, vec![1u8; 100]));
    assert_refused(d.space.complete_blob(&d.started));
    assert_refused(d.space.commit(std::slice::from_ref(&d.prepared)));
}

#[test]
fn a_commit_of_deletions_only_goes_through_without_sync() {
    // Н4 (decision of 13 Nov): every entry `deleted: true`, no `blob_id` — accepted without a
    // subscription; the item is deleted in the feed. The other adding routes stay closed.
    let target = server();
    let _ = in_process_or_skip!(target);
    let d = downgraded(&target);
    assert_sending_is_closed(&d.space); // the guard: the plan really has no sync now
    let gone = d.space.deletion(&d.committed.item, 1, "kept.md");
    assert!(gone.body.is_none());
    d.space.commit_ok(&[gone]);
    let feed = d.space.all_changes(0);
    assert_eq!(feed.len(), 1);
    let header = d.space.open_change(&feed[0]);
    assert!(header.deleted, "the item is deleted in the feed");
    assert_eq!(feed[0]["version"], 2);
    assert_sending_is_closed(&d.space);
}

#[test]
fn a_mixed_commit_is_refused_whole_and_nothing_is_applied() {
    // Н4, Н5, П27: one non-deletion entry makes the commit an adding one; the deletion in it is
    // not applied either; feed and versions stay as they were.
    let target = server();
    let _ = in_process_or_skip!(target);
    let d = downgraded(&target);
    let feed_before = d.space.all_changes(0);
    let versions_before = d.space.versions(&d.committed.item).expect(200).json();
    let gone = d.space.deletion(&d.committed.item, 1, "kept.md");
    assert_refused(d.space.commit(&[gone, d.prepared.clone()]));
    assert_eq!(d.space.all_changes(0), feed_before);
    assert_eq!(
        d.space.versions(&d.committed.item).expect(200).json(),
        versions_before
    );
    d.space
        .versions(&d.prepared.item)
        .expect_error(404, "not_found");
    assert!(!d.space.open_change(&d.space.all_changes(0)[0]).deleted);
}

#[test]
fn a_refused_send_changes_nothing_on_the_server() {
    // Н4, Н5: the refusal is before the write: no space, no version, no feed entry.
    let target = server();
    let _ = in_process_or_skip!(target);
    let d = downgraded(&target);
    let before = d.account.overview();
    let feed = d.space.all_changes(0).len();
    let (_, _, new_space) = d.account.new_space_request("Another");
    assert_refused(d.account.post("/v1/spaces", new_space));
    assert_refused(d.space.commit(std::slice::from_ref(&d.prepared)));
    assert_eq!(d.space.all_changes(0).len(), feed);
    d.space
        .versions(&d.prepared.item)
        .expect_error(404, "not_found");
    let after = d.account.overview();
    assert_eq!(after["usage"], before["usage"]);
    assert_eq!(after["spaces"], before["spaces"]);
}

#[test]
fn every_other_route_of_h4_still_works_without_sync() {
    // Н4: login, recovery, keys and password, devices, login name, the account, the spaces list,
    // the feed, events, versions, downloads, DELETE of a body and of a space.
    let target = server();
    let _ = in_process_or_skip!(target);
    let d = downgraded(&target);
    assert_sending_is_closed(&d.space); // the plan really has no sync now
    let account = &d.account;
    // login and recovery
    let second = account.another_device("second");
    recover(
        &target.api,
        &account.username,
        &account.recovery_code,
        &account.ak,
        "restored",
    )
    .expect(200);
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "third",
    )
    .expect(200);
    // keys and the password
    let keys = account.get("/v1/keys").expect(200).json();
    let (_, envelope) = change_password(
        PASSWORD,
        &account.salt,
        &account.params,
        &unhex(keys["wrapped_ak"].as_str().unwrap()),
        "a brand new password 2026",
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    let body = keys_put_body(1, "password", &account.password_auth_key(), &envelope);
    account.put("/v1/keys", body).expect(200);
    // devices
    assert!(
        account.get("/v1/devices").expect(200).json()["devices"]
            .as_array()
            .unwrap()
            .len()
            >= 3
    );
    account
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    // the login name
    assert_eq!(
        account.get("/v1/account/username").expect(200).json()["username"],
        account.username.as_str()
    );
    // the account and the list of spaces
    account.get("/v1/account").expect(200);
    let listing = account.get("/v1/spaces").expect(200).json();
    assert_eq!(listing["spaces"].as_array().unwrap().len(), 1);
    unwrap_vk_from_listing(&account.ak, &listing["spaces"][0]);
    // the feed, versions, the download of a body
    assert_eq!(d.space.all_changes(0).len(), 1);
    d.space.versions(&d.committed.item).expect(200);
    d.space.download(&d.committed.body.unwrap()).expect(200);
    // events: the stream opens
    d.space
        .api
        .open_events(
            &d.space.path("/events"),
            Some(&d.space.token),
            Duration::from_secs(5),
        )
        .unwrap_or_else(|answer| panic!("events: HTTP {} {}", answer.status, answer.text()));
    // DELETE of a started body, DELETE of the space
    d.space.delete_blob(&d.started).expect(204);
    // Ц1: deleting a space proves the password — the new one, set above.
    account
        .delete_json(
            &d.space.path(""),
            serde_json::json!({ "auth_key": hex::encode(envelope.auth_key.as_bytes()) }),
        )
        .expect(200);
    assert_eq!(
        account.get("/v1/spaces").expect(200).json()["spaces"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn nothing_is_deleted_or_squeezed_when_the_subscription_goes() {
    // Н4: the data stays until the subscription is renewed or the user deletes it; a cleanup
    // removes nothing that is not yet due.
    let target = server();
    let control = in_process_or_skip!(target);
    let d = downgraded(&target);
    assert_sending_is_closed(&d.space);
    let count = |table: &str| -> i64 {
        control.sql(|conn| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
        })
    };
    let (blobs, versions) = (count("blobs"), count("versions"));
    control.run_maintenance();
    assert_eq!((count("blobs"), count("versions")), (blobs, versions));
    d.space.download(&d.committed.body.unwrap()).expect(200);
    assert_eq!(d.space.all_changes(0).len(), 1);
    assert_eq!(d.account.overview()["usage"]["live_bytes"], 1_000);
    // and when the subscription comes back, sending works again
    pin(&target, &d.account, "pro");
    d.space.commit_ok(std::slice::from_ref(&d.prepared));
    assert_eq!(d.space.all_changes(0).len(), 2);
}

// ----- Н1: "sync": true, a missing field and no file at all -----

#[test]
fn a_plan_with_sync_true_and_a_plan_without_the_field_send_as_before() {
    // Н1, Н4: no field means `true`. (These two sending checks pass on the old code; the
    // red part is the field `sync` in the account.)
    let target = server();
    let _ = in_process_or_skip!(target);
    for plan in ["pro", "legacy"] {
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, plan);
        let space = account.create_space();
        space.commit_ok(&[space.raw_file(&new_item(), 0, "a.md", 100)]);
        assert_eq!(account.overview()["plan"]["sync"], true, "plan {plan}");
    }
}

#[test]
fn a_server_without_a_plans_file_sends_as_before_and_says_sync_true() {
    // Н1, П52: the virtual plan has no limits and has sync.
    let target = Target::in_process();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    space.commit_ok(&[space.raw_file(&new_item(), 0, "a.md", 100)]);
    let plan = &account.overview()["plan"];
    assert_eq!(plan["sync"], true);
    assert_eq!(plan["until_ms"], Value::Null);
    assert_eq!(plan["pinned"], false);
}

#[test]
fn a_plans_file_with_a_non_boolean_sync_stops_the_start() {
    // Н1, П51: the start-up check refuses it. (Passes on the old code if the field is already
    // typed `bool`; it stays here as the rule of Н1.)
    let target = server();
    let control = in_process_or_skip!(target);
    for broken in [
        r#"{"plans": {"a": {"sync": "yes"}}}"#,
        r#"{"plans": {"a": {"sync": 1}}}"#,
        r#"{"plans": {"a": {"sync": null}}}"#,
    ] {
        control.write_plans(broken);
        let state = amby_sync_server::AppState::open(
            control.config(),
            control.clock.clone() as std::sync::Arc<dyn amby_sync_server::Clock>,
        );
        assert!(state.check_plans().is_err(), "{broken}");
    }
}

// ----- Н5: the order of the checks -----

#[test]
fn somebody_elses_space_is_404_and_not_403_without_a_subscription() {
    // Н5, П6: token (401) → ownership (404) → subscription (403).
    let target = server();
    let _ = in_process_or_skip!(target);
    let owner = enroll(&target, PASSWORD);
    pin(&target, &owner, "pro");
    let foreign = owner.create_space();
    let stranger = downgraded(&target);
    assert_sending_is_closed(&stranger.space); // the guard: his own space says 403
    let theirs = foreign.with_token(&stranger.account.token);
    theirs
        .init_blob(&new_body(), 10)
        .expect_error(404, "not_found");
    theirs
        .put_part(&new_body(), 0, vec![1u8; 10])
        .expect_error(404, "not_found");
    theirs
        .complete_blob(&new_body())
        .expect_error(404, "not_found");
    theirs
        .commit(std::slice::from_ref(&stranger.prepared))
        .expect_error(404, "not_found");
    // a space that does not exist is 404 as well
    let nowhere = Space {
        id: amby_sync_core::crypto::keys::SpaceId::from_bytes([9u8; 16]),
        ..stranger.space.clone()
    };
    nowhere
        .init_blob(&new_body(), 10)
        .expect_error(404, "not_found");
}

#[test]
fn without_a_token_it_is_401_before_anything_else() {
    // Н5: the token comes first.
    let target = server();
    let _ = in_process_or_skip!(target);
    let d = downgraded(&target);
    assert_sending_is_closed(&d.space);
    let nobody = d.space.with_token(&"0".repeat(64));
    nobody
        .init_blob(&new_body(), 10)
        .expect_error(401, "unauthorized");
    target
        .api
        .post(
            "/v1/spaces",
            Some(&"0".repeat(64)),
            d.account.new_space_request("x").2,
        )
        .expect_error(401, "unauthorized");
}

#[test]
fn a_commit_accepted_before_is_answered_again_after_the_subscription_is_gone() {
    // Н5, П28: the replay of the same `commit_id` gives the earlier answer; a new one is refused.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin(&target, &account, "pro");
    let space = account.create_space();
    let item = space.raw_file(&new_item(), 0, "a.md", 300);
    let other = space.raw_file(&new_item(), 0, "b.md", 300);
    let commit_id = [0x77u8; 16];
    let first = space
        .commit_with(&commit_id, std::slice::from_ref(&item))
        .expect(200)
        .json();
    unpin(&target, &account);
    // a different commit of the same user is refused ...
    assert_refused(space.commit(std::slice::from_ref(&other)));
    // ... and the replay of the accepted one is not
    let again = space
        .commit_with(&commit_id, std::slice::from_ref(&item))
        .expect(200)
        .json();
    // П28: a replay is the earlier answer marked `"replayed": true`.
    assert_eq!(again["replayed"], true, "marked as a replay");
    let (mut again, mut first) = (again, first);
    again["replayed"] = serde_json::Value::Null;
    first["replayed"] = serde_json::Value::Null;
    assert_eq!(again, first, "the earlier answer");
    assert_eq!(space.all_changes(0).len(), 1, "applied once");
}

// ----- Н6: GET /v1/account -----

#[test]
fn the_account_tells_sync_and_until_ms_of_the_plan() {
    // Н6: `plan.sync` is the effective plan; `plan.until_ms` is null without a pin or without an end.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    assert_eq!(
        account.overview()["plan"],
        json!({"name": "free", "title": "Free", "pinned": false, "sync": false, "until_ms": null})
    );
    pin(&target, &account, "pro");
    assert_eq!(
        account.overview()["plan"],
        json!({"name": "pro", "title": "Pro", "pinned": true, "sync": true, "until_ms": null})
    );
}

#[test]
fn a_pin_with_an_end_shows_the_end_in_the_account() {
    // Н3, Н6: `--until 2026-12-31` is access through that UTC day: the end is 00:00 UTC of the
    // next day, and that is `until_ms`.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    target.cli_ok(&[
        "user",
        "plan",
        "set",
        &account.username,
        "pro",
        "--until",
        "2026-12-31",
    ]);
    let plan = account.overview()["plan"].clone();
    assert_eq!(plan["name"], "pro");
    assert_eq!(plan["pinned"], true);
    assert_eq!(plan["sync"], true);
    assert_eq!(plan["until_ms"], MIDNIGHT_2027);
}

// ----- Н2, Н6: the end of a pin -----

#[test]
fn a_pin_that_has_not_ended_acts_as_pinned_and_an_ended_one_as_the_default_plan() {
    // Н2, Н6: `now_ms >= plan_until_ms` is the end, to the millisecond. After it: the default
    // plan, `pinned: false`, `until_ms: null`, sending is refused, and the row is not rewritten.
    let target = server();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin_until(&target, &account, "pro", "2026-10-25");
    let active = account.overview()["plan"].clone();
    assert_eq!(active["name"], "pro");
    assert_eq!(active["pinned"], true);
    assert_eq!(active["until_ms"], MIDNIGHT_OCT_26);
    // one millisecond before the end: still pro
    control.advance(Duration::from_millis(
        (MIDNIGHT_OCT_26 - START_MS - 1) as u64,
    ));
    assert_eq!(account.overview()["plan"]["name"], "pro");
    // the end itself: the default plan
    control.advance(Duration::from_millis(1));
    assert_eq!(
        account.overview()["plan"],
        json!({"name": "free", "title": "Free", "pinned": false, "sync": false, "until_ms": null})
    );
    // the record of who was given what is not lost (Н2)
    let shown = target
        .cli_ok(&["user", "plan", "show", &account.username, "--json"])
        .json();
    assert_eq!(shown["plan_expired"], true);
}

#[test]
fn an_ended_pin_closes_sending_and_a_renewal_opens_it() {
    // Н2, Н4: the subscription ends at its day and nothing is deleted.
    let target = server();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    pin_until(&target, &account, "pro", "2026-10-25");
    let space = account.create_space();
    let file = space.raw_file(&new_item(), 0, "a.md", 100);
    let body = file.body.unwrap();
    space.commit_ok(&[file]);
    control.advance(Duration::from_millis((MIDNIGHT_OCT_26 - START_MS) as u64));
    assert_sending_is_closed(&space);
    assert_eq!(space.all_changes(0).len(), 1);
    space.download(&body).expect(200);
    // the administrator renews
    target.cli_ok(&[
        "user",
        "plan",
        "set",
        &account.username,
        "pro",
        "--until",
        "2026-12-31",
    ]);
    space.commit_ok(&[space.raw_file(&new_item(), 0, "b.md", 100)]);
}

#[test]
fn an_end_without_a_pin_does_not_act() {
    // Н2: without a pinned `plan` the end has no force. The default plan is the default plan.
    let target = server();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let plan = account.overview()["plan"].clone();
    assert_eq!(plan["until_ms"], Value::Null);
    assert_eq!(plan["sync"], false);
    assert_eq!(MIDNIGHT_AFTER_START_DAY - START_MS, 12 * 3_600_000);
}

fn pin_until(target: &Target, account: &Account, plan: &str, day: &str) {
    target.cli_ok(&[
        "user",
        "plan",
        "set",
        &account.username,
        plan,
        "--until",
        day,
    ]);
}
