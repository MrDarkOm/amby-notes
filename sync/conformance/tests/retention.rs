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
