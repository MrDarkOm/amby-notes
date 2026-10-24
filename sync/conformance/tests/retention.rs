//! Keeping old versions for 30 days, deleted items, bodies without a commit for 24 hours,
//! cleanup with a clock the test moves (О4, Р8, С1; П25, П35–П37). In-process servers only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use amby_sync_conformance::client::{enroll, new_body, new_item, Space, PASSWORD};
use amby_sync_conformance::inprocess::InProcess;
use amby_sync_conformance::{in_process_or_skip, Target};
use serde_json::{json, Value};

const DAY: u64 = 24 * 3600;
const HOUR: u64 = 3600;

fn fresh(target: &Target) -> Space {
    enroll(target, PASSWORD).create_space()
}

fn days(control: &InProcess, count: u64) {
    control.advance(Duration::from_secs(count * DAY));
}

fn version_numbers(space: &Space, item: &amby_sync_core::crypto::keys::ItemId) -> Vec<u64> {
    let answer = space.versions(item).expect(200).json();
    answer["versions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["version"].as_u64().unwrap())
        .collect()
}

#[test]
fn an_old_version_lives_30_days_after_it_was_replaced_not_after_it_was_written() {
    // О4, Р8, П35, П37: version 1 is 39 days old but was replaced only 29 days ago → kept; two
    // days later it was replaced 31 days ago → gone, with its body.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let item = new_item();
    let first = space.file(&item, 0, "a.md", b"old text");
    let old_body = first.body.unwrap();
    space.commit_ok(&[first]);
    days(control, 10);
    let second = space.file(&item, 1, "a.md", b"new text");
    let new_body = second.body.unwrap();
    space.commit_ok(&[second]);
    days(control, 29);
    control.run_maintenance();
    assert_eq!(
        version_numbers(&space, &item),
        vec![2, 1],
        "replaced 29 days ago: still kept"
    );
    space.download(&old_body).expect(200);
    days(control, 2);
    control.run_maintenance();
    assert_eq!(
        version_numbers(&space, &item),
        vec![2],
        "replaced 31 days ago: gone"
    );
    space.download(&old_body).expect_error(404, "not_found");
    space.download(&new_body).expect(200);
    let feed = space.all_changes(0);
    assert_eq!(feed.len(), 1, "the removed version leaves the feed");
    assert_eq!(feed[0]["version"], 2);
}

#[test]
fn the_latest_version_is_never_removed() {
    // П35: a year-old file nobody touched is still there with its body.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let item = new_item();
    let first = space.file(&item, 0, "ancient.md", b"still here");
    let body = first.body.unwrap();
    space.commit_ok(&[first]);
    days(control, 400);
    control.run_maintenance();
    assert_eq!(version_numbers(&space, &item), vec![1]);
    let feed = space.all_changes(0);
    assert_eq!(space.fetch_file(&feed[0]), b"still here");
    space.download(&body).expect(200);
}

#[test]
fn a_deleted_item_can_be_restored_for_30_days_and_then_disappears() {
    // О4, Р8, П36: 29 days after the deletion the old content is still on the server; at 31 days
    // the whole item and its bodies are gone.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let item = new_item();
    let first = space.file(&item, 0, "precious.md", b"restore me");
    let body = first.body.unwrap();
    space.commit_ok(&[first]);
    space.commit_ok(&[space.deletion(&item, 1, "precious.md")]);
    days(control, 29);
    control.run_maintenance();
    let history = space.versions(&item).expect(200).json();
    let versions = history["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(space.fetch_file(&versions[1]), b"restore me");
    days(control, 2);
    control.run_maintenance();
    space.versions(&item).expect_error(404, "not_found");
    space.download(&body).expect_error(404, "not_found");
    assert!(space.all_changes(0).is_empty());
}

#[test]
fn a_body_stays_while_a_live_version_still_uses_it() {
    // П30, П35: a rename reuses the body; when the first version ages out, the body must stay
    // because the live version refers to it.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let item = new_item();
    let first = space.file(&item, 0, "before.md", b"shared bytes");
    let body = first.body.unwrap();
    space.commit_ok(&[first]);
    space.commit_ok(&[space.file_with_uploaded_body(&item, 1, "after.md", b"shared bytes", &body)]);
    days(control, 40);
    control.run_maintenance();
    assert_eq!(version_numbers(&space, &item), vec![2]);
    space.download(&body).expect(200);
    let change = space.all_changes(0).remove(0);
    assert_eq!(space.fetch_file(&change), b"shared bytes");
}

#[test]
fn removed_old_versions_leave_no_gap_because_the_feed_never_showed_them() {
    // П32, П31, П35: the feed holds only the latest version of an item; dropping the old ones
    // changes nothing in it, so a device that is behind is not told to resync.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"1")]);
    space.commit_ok(&[space.file(&item, 1, "a.md", b"2")]);
    space.commit_ok(&[space.file(&item, 2, "a.md", b"3")]);
    let before = space.changes(0, None).expect(200).json();
    days(control, 31);
    control.run_maintenance();
    assert_eq!(version_numbers(&space, &item), vec![3]);
    let after = space.changes(0, None).expect(200).json();
    assert_eq!(after["gap"], false);
    assert_eq!(
        after["changes"], before["changes"],
        "the feed did not change"
    );
}

#[test]
fn a_gap_appears_only_after_a_whole_deleted_item_is_removed() {
    // П32, П36: a device that has not seen the deletion is told so; one that is past it is not.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let (gone, kept) = (new_item(), new_item());
    space.commit_ok(&[space.file(&gone, 0, "gone.md", b"1")]); // seq 1
    space.commit_ok(&[space.deletion(&gone, 1, "gone.md")]); // seq 2
    space.commit_ok(&[space.file(&kept, 0, "kept.md", b"k")]); // seq 3
    days(control, 20);
    control.run_maintenance();
    assert_eq!(
        space.changes(0, None).expect(200).json()["gap"],
        false,
        "not yet removed"
    );
    days(control, 11);
    control.run_maintenance();
    space.versions(&gone).expect_error(404, "not_found");
    assert_eq!(space.changes(0, None).expect(200).json()["gap"], true);
    assert_eq!(space.changes(1, None).expect(200).json()["gap"], true);
    assert_eq!(
        space.changes(2, None).expect(200).json()["gap"],
        false,
        "seq 2 was the deletion itself"
    );
    assert_eq!(space.changes(3, None).expect(200).json()["gap"], false);
}

#[test]
fn a_body_without_a_commit_is_removed_after_24_hours() {
    // С1, П25, П37: finished or not, a body nobody committed goes after a day; before that it
    // stays and an upload can resume.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let finished = new_body();
    space.upload_sealed(&finished, &[1u8; 200]);
    let started = new_body();
    space.init_blob(&started, 300).expect(201);
    space.put_part(&started, 0, vec![2; 300]).expect(200);
    control.advance(Duration::from_secs(23 * HOUR));
    control.run_maintenance();
    space.download(&finished).expect(200);
    assert_eq!(
        space.init_blob(&started, 300).expect(200).json()["uploaded"],
        json!([0])
    );
    control.advance(Duration::from_secs(2 * HOUR));
    control.run_maintenance();
    space.download(&finished).expect_error(404, "not_found");
    space
        .put_part(&started, 0, vec![2; 300])
        .expect_error(404, "not_found");
    // The id is free again.
    space.init_blob(&started, 300).expect(201);
}

#[test]
fn activity_restarts_the_24_hours() {
    // П25: the clock counts from the last action, so a slow big upload is not cut in half.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let body = new_body();
    space.init_blob(&body, 20_000_000).expect(201);
    control.advance(Duration::from_secs(20 * HOUR));
    space
        .put_part(&body, 0, vec![1; 8 * 1024 * 1024])
        .expect(200);
    control.advance(Duration::from_secs(20 * HOUR));
    control.run_maintenance();
    let state = space.init_blob(&body, 20_000_000).expect(200).json();
    assert_eq!(
        state["uploaded"],
        json!([0]),
        "40 hours since the start, 20 since the last part"
    );
    control.advance(Duration::from_secs(5 * HOUR));
    control.run_maintenance();
    space.init_blob(&body, 20_000_000).expect(201);
}

#[test]
fn a_committed_body_is_not_an_orphan() {
    // П25: once a commit refers to it, the 24 hours no longer apply.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let prepared = space.file(&new_item(), 0, "kept.md", b"kept");
    let body = prepared.body.unwrap();
    space.commit_ok(&[prepared]);
    control.advance(Duration::from_secs(72 * HOUR));
    control.run_maintenance();
    space.download(&body).expect(200);
}

#[test]
fn cleanup_does_nothing_to_what_is_not_due() {
    // П37: idempotent and careful — two runs in a row on fresh data change nothing.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"1")]);
    space.commit_ok(&[space.file(&item, 1, "a.md", b"2")]);
    let before: Value = space.changes(0, None).expect(200).json();
    control.run_maintenance();
    control.run_maintenance();
    let after: Value = space.changes(0, None).expect(200).json();
    assert_eq!(before, after);
    assert_eq!(version_numbers(&space, &item), vec![2, 1]);
}

#[test]
fn the_retention_follows_the_setting() {
    // П35, П40: with 2 days configured, a version replaced 3 days ago is gone.
    let target = Target::in_process_with(|config| config.retain_version_days = 2);
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"1")]);
    space.commit_ok(&[space.file(&item, 1, "a.md", b"2")]);
    days(control, 1);
    control.run_maintenance();
    assert_eq!(version_numbers(&space, &item), vec![2, 1]);
    days(control, 2);
    control.run_maintenance();
    assert_eq!(version_numbers(&space, &item), vec![2]);
}

#[test]
fn the_orphan_time_follows_the_setting() {
    // П25, П40: with 1 hour configured, a body without a commit goes after 90 minutes.
    let target = Target::in_process_with(|config| config.orphan_blob_hours = 1);
    let control = in_process_or_skip!(target);
    let space = fresh(&target);
    let body = new_body();
    space.upload_sealed(&body, &[9u8; 50]);
    control.advance(Duration::from_secs(30 * 60));
    control.run_maintenance();
    space.download(&body).expect(200);
    control.advance(Duration::from_secs(60 * 60));
    control.run_maintenance();
    space.download(&body).expect_error(404, "not_found");
}

#[test]
fn old_attempt_counters_do_not_survive_cleanup_as_a_lock() {
    // П16, П37: a name locked an hour ago is free after cleanup too.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let max = amby_sync_conformance::client::limit(&target.api, "login_max_failures");
    for _ in 0..max {
        target
            .api
            .post(
                "/v1/auth/login",
                None,
                json!({ "username": account.username, "auth_key": "00".repeat(32),
                        "device": { "name_enc": "ab".repeat(105) } }),
            )
            .expect_error(401, "invalid_credentials");
    }
    control.advance(Duration::from_secs(2 * HOUR));
    control.run_maintenance();
    amby_sync_conformance::client::login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "later",
    )
    .expect(200);
}

// ----- the term fixed at the replacement and the history ceiling (appendix Е: П57-г, П57-д) -----

mod plans {
    use super::*;
    use amby_sync_conformance::client::Account;
    use amby_sync_core::crypto::keys::ItemId;
    use serde_json::json;

    fn text() -> String {
        json!({
            "default_plan": "long",
            "plans": {
                "long": {"history_days": 100},
                "short": {"history_days": 10},
                "five": {"history_days": 5},
                "nodays": {"max_total_bytes": 1_000_000},
                "capped": {"history_days": 30, "max_history_bytes": 5_000},
                "uncapped": {"history_days": 30}
            }
        })
        .to_string()
    }

    fn server() -> Target {
        Target::in_process_with_plans(&text(), |_| {})
    }

    fn pin(target: &Target, account: &Account, plan: &str) {
        target.cli_ok(&["user", "plan", "set", &account.username, plan]);
    }

    fn replace(
        space: &Space,
        item: &ItemId,
        from: u64,
        len: usize,
    ) -> amby_sync_core::crypto::keys::BodyId {
        let next = space.raw_file(item, from, "a.md", len);
        let body = next.body.unwrap();
        space.commit_ok(&[next]);
        body
    }

    #[test]
    fn a_replaced_version_keeps_the_term_of_the_plan_of_the_day_it_was_replaced() {
        // П57-г: v1 was replaced under `long` (100 days); the plan drops to 10 days; v1 still
        // lives its 100 days, and v2, replaced under the new plan, lives 10.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let space = account.create_space();
        let item = new_item();
        let first = space.raw_file(&item, 0, "a.md", 100);
        let v1 = first.body.unwrap();
        space.commit_ok(&[first]);
        replace(&space, &item, 1, 100); // v1 replaced at day 0: kept until day 100
        pin(&target, &account, "short");
        days(control, 50);
        control.run_maintenance();
        assert_eq!(
            version_numbers(&space, &item),
            vec![2, 1],
            "day 50: v1 is promised until day 100"
        );
        replace(&space, &item, 2, 100); // v2 replaced at day 50 under `short`: kept until day 60
        days(control, 11);
        control.run_maintenance();
        assert_eq!(
            version_numbers(&space, &item),
            vec![3, 1],
            "day 61: v2 is gone, v1 is not"
        );
        space.download(&v1).expect(200);
        days(control, 40);
        control.run_maintenance();
        assert_eq!(
            version_numbers(&space, &item),
            vec![3],
            "day 101: the promise to v1 is kept and over"
        );
        space.download(&v1).expect_error(404, "not_found");
    }

    #[test]
    fn raising_the_plan_does_not_prolong_versions_that_are_already_replaced() {
        // П57-г: a larger plan lengthens the future only.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, "short");
        let space = account.create_space();
        let item = new_item();
        space.commit_ok(&[space.raw_file(&item, 0, "a.md", 100)]);
        replace(&space, &item, 1, 100); // v1: until day 10
        pin(&target, &account, "long");
        days(control, 11);
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &item), vec![2]);
    }

    #[test]
    fn a_deleted_item_waits_the_term_of_the_plan_of_the_day_of_the_deletion() {
        // П57-г, П36: the deletion commit fixes the term.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let space = account.create_space();
        let item = new_item();
        let first = space.raw_file(&item, 0, "a.md", 100);
        let body = first.body.unwrap();
        space.commit_ok(&[first]);
        space.commit_ok(&[space.deletion(&item, 1, "a.md")]); // under `long`: until day 100
        pin(&target, &account, "short");
        days(control, 50);
        control.run_maintenance();
        assert_eq!(
            version_numbers(&space, &item),
            vec![2, 1],
            "day 50: still restorable"
        );
        space.download(&body).expect(200);
        days(control, 51);
        control.run_maintenance();
        space.versions(&item).expect_error(404, "not_found");
        space.download(&body).expect_error(404, "not_found");
    }

    #[test]
    fn a_plan_without_days_falls_back_to_the_setting_of_the_server() {
        // П50, П54: `nodays` has no `history_days`: the 30 days of the server; `five` has 5.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let space = account.create_space();
        let (a, b) = (new_item(), new_item());
        pin(&target, &account, "five");
        space.commit_ok(&[space.raw_file(&a, 0, "a.md", 100)]);
        replace(&space, &a, 1, 100);
        pin(&target, &account, "nodays");
        space.commit_ok(&[space.raw_file(&b, 0, "b.md", 100)]);
        replace(&space, &b, 1, 100);
        days(control, 6);
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &a), vec![2], "five days are over");
        assert_eq!(
            version_numbers(&space, &b),
            vec![2, 1],
            "the server's 30 days are not"
        );
        days(control, 25);
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &b), vec![2]);
    }

    #[test]
    fn a_row_without_keep_until_ms_is_cleaned_by_the_old_rule() {
        // П57-г, П58: rows from before the migration have no term: `superseded_ms` plus the
        // setting of the server (30 days), whatever the plan says now.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, "short");
        let space = account.create_space();
        let (fixed, old) = (new_item(), new_item());
        for item in [&fixed, &old] {
            space.commit_ok(&[space.raw_file(item, 0, "a.md", 100)]);
            replace(&space, item, 1, 100);
        }
        control.sql_write(|conn| {
            let touched = conn
                .execute(
                    "UPDATE versions SET keep_until_ms = NULL WHERE item_id = ?1",
                    [old.as_bytes().as_slice()],
                )
                .expect("the column `versions.keep_until_ms` must exist");
            assert!(touched >= 1);
        });
        days(control, 11);
        control.run_maintenance();
        assert_eq!(
            version_numbers(&space, &fixed),
            vec![2],
            "the fixed term of 10 days is over"
        );
        assert_eq!(
            version_numbers(&space, &old),
            vec![2, 1],
            "no term: the old 30 days apply"
        );
        days(control, 20);
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &old), vec![2]);
    }

    #[test]
    fn the_ceiling_of_the_history_removes_the_oldest_replaced_versions_first() {
        // П57-д: history 9000 > 5000: v1 (6000 left) and v2 (3000 left) go, v3 and the latest v4
        // stay, long before the 30 days.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, "capped");
        let space = account.create_space();
        let item = new_item();
        let mut bodies = Vec::new();
        let first = space.raw_file(&item, 0, "a.md", 3000);
        bodies.push(first.body.unwrap());
        space.commit_ok(&[first]);
        for from in 1..4 {
            days(control, 1);
            bodies.push(replace(&space, &item, from, 3000));
        }
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &item), vec![4, 3]);
        space.download(&bodies[0]).expect_error(404, "not_found");
        space.download(&bodies[1]).expect_error(404, "not_found");
        space.download(&bodies[2]).expect(200);
        space.download(&bodies[3]).expect(200);
        assert_eq!(account.overview()["usage"]["history_bytes"], 3000);
    }

    #[test]
    fn across_items_the_order_is_the_time_of_the_replacement_or_the_deletion() {
        // П57-д: P replaced on day 1, Q on day 2, D deleted on day 3 (3000 bytes each). History
        // 9000 > 5000: P's and Q's old versions go, the deleted item D stays.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, "capped");
        let space = account.create_space();
        let (p, q, d) = (new_item(), new_item(), new_item());
        for item in [&p, &q, &d] {
            space.commit_ok(&[space.raw_file(item, 0, "a.md", 3000)]);
        }
        days(control, 1);
        replace(&space, &p, 1, 100);
        days(control, 1);
        replace(&space, &q, 1, 100);
        days(control, 1);
        space.commit_ok(&[space.deletion(&d, 1, "a.md")]);
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &p), vec![2]);
        assert_eq!(version_numbers(&space, &q), vec![2]);
        assert_eq!(
            version_numbers(&space, &d),
            vec![2, 1],
            "the newest history stays"
        );
    }

    #[test]
    fn a_history_at_or_under_the_ceiling_is_left_alone() {
        // П57-д: nothing early below the ceiling.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, "capped");
        let space = account.create_space();
        let item = new_item();
        space.commit_ok(&[space.raw_file(&item, 0, "a.md", 2500)]);
        replace(&space, &item, 1, 2500); // history 2500
        replace(&space, &item, 2, 100); // history 5000: exactly the ceiling
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &item), vec![3, 2, 1]);
        assert_eq!(account.overview()["usage"]["history_bytes"], 5000);
    }

    #[test]
    fn without_a_ceiling_the_history_is_cleaned_by_days_only() {
        // П50, П57-д: no `max_history_bytes` — as before.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, "uncapped");
        let space = account.create_space();
        let item = new_item();
        space.commit_ok(&[space.raw_file(&item, 0, "a.md", 9000)]);
        for from in 1..4 {
            replace(&space, &item, from, 9000);
        }
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &item), vec![4, 3, 2, 1]);
        days(control, 31);
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &item), vec![4]);
    }

    #[test]
    fn the_latest_version_is_never_removed_by_the_ceiling_even_when_it_alone_exceeds_it() {
        // П57-д: the latest versions are never touched.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, "capped");
        let space = account.create_space();
        let (item, other) = (new_item(), new_item());
        space.commit_ok(&[space.raw_file(&item, 0, "a.md", 6000)]);
        let latest = replace(&space, &item, 1, 9000);
        space.commit_ok(&[space.raw_file(&other, 0, "o.md", 9000)]);
        control.run_maintenance();
        assert_eq!(version_numbers(&space, &item), vec![2]);
        space.download(&latest).expect(200);
        assert_eq!(version_numbers(&space, &other), vec![1]);
        let live = account.overview()["usage"]["live_bytes"].clone();
        assert_eq!(live, 18_000);
    }

    #[test]
    fn a_body_that_the_latest_version_needs_survives_the_removal_of_older_rows() {
        // П57-д: item X was renamed (its old version shares the body with the latest one);
        // item Z has real history of 6000 bytes, over the ceiling of 5000. Z's old body goes, X's
        // shared body stays.
        let target = server();
        let control = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        pin(&target, &account, "capped");
        let space = account.create_space();
        let (x, z) = (new_item(), new_item());
        let first = space.raw_file(&x, 0, "x.md", 2000);
        let shared = first.body.unwrap();
        space.commit_ok(&[first]);
        space.commit_ok(&[space.file_with_uploaded_body(&x, 1, "renamed.md", b"x", &shared)]);
        let z1 = space.raw_file(&z, 0, "z.md", 6000);
        let z_old = z1.body.unwrap();
        space.commit_ok(&[z1]);
        replace(&space, &z, 1, 100);
        control.run_maintenance();
        space.download(&z_old).expect_error(404, "not_found");
        space.download(&shared).expect(200);
        let feed = space.all_changes(0);
        let renamed = feed
            .iter()
            .find(|c| c["item_id"] == hex16_of(&x).as_str())
            .unwrap();
        assert_eq!(space.fetch_file(renamed), b"x");
    }

    fn hex16_of(item: &ItemId) -> String {
        amby_sync_conformance::client::hex16(item.as_bytes())
    }
}
