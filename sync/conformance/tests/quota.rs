//! The quota of sealed bytes per user (Р11, П42). Own server with a small quota.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use amby_sync_conformance::client::{enroll, new_body, new_item, Space, PASSWORD};
use amby_sync_conformance::{in_process_or_skip, Target};

const QUOTA: u64 = 10_000;

fn with_quota() -> Target {
    Target::in_process_with(|config| config.quota_bytes_per_user = Some(QUOTA))
}

fn space_of(target: &Target) -> Space {
    enroll(target, PASSWORD).create_space()
}

#[test]
fn starting_a_body_over_the_quota_is_507_and_up_to_the_quota_is_fine() {
    // П42, Р11: unfinished uploads count by their declared size; the sum may reach the quota but
    // not pass it.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let space = space_of(&target);
    space.init_blob(&new_body(), 6000).expect(201);
    space
        .init_blob(&new_body(), 4001)
        .expect_error(507, "quota_exceeded");
    space.init_blob(&new_body(), 4000).expect(201);
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
}

#[test]
fn a_replaced_version_does_not_count() {
    // П55 (replaces the rule of П42 "old live versions count too"): only the latest version of
    // an item is in the sum; the replaced one is history and is shown apart.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    for version in 0..2 {
        let body = new_body();
        space.upload_sealed(&body, &[7u8; 3000]);
        let prepared = space.file_with_uploaded_body(&item, version, "a.md", b"x", &body);
        space.commit_ok(&[prepared]);
    }
    space.init_blob(&new_body(), 7000).expect(201);
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
    let usage = account.overview()["usage"].clone();
    assert_eq!(usage["live_bytes"], 3000);
    assert_eq!(
        usage["history_bytes"], 3000,
        "the old body is history, not quota"
    );
}

#[test]
fn a_deleted_item_does_not_count_and_frees_the_place_at_once() {
    // П55 (replaces "a deleted item counts until cleanup"), П56: the 30 days of the history are
    // not paid for from the quota, and a person at the limit can always free space.
    let target = with_quota();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    let body = new_body();
    space.upload_sealed(&body, &[1u8; 6000]);
    space.commit_ok(&[space.file_with_uploaded_body(&item, 0, "big.md", b"x", &body)]);
    space
        .init_blob(&new_body(), 5000)
        .expect_error(507, "quota_exceeded");
    space.commit_ok(&[space.deletion(&item, 1, "big.md")]);
    space.init_blob(&new_body(), 10_000).expect(201);
    let usage = account.overview()["usage"].clone();
    assert_eq!(usage["live_bytes"], 0);
    assert_eq!(
        usage["history_bytes"], 6000,
        "the deleted file waits in the history"
    );
    space.download(&body).expect(200);
    control.advance(Duration::from_secs(31 * 24 * 3600));
    control.run_maintenance();
}

#[test]
fn a_body_shared_by_two_versions_is_counted_once() {
    // П55, П30: a rename reuses the body; (space, blob_id) is counted once, and the replaced
    // version whose body is also the latest one's is not history.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    let body = new_body();
    space.upload_sealed(&body, &[1u8; 3000]);
    space.commit_ok(&[space.file_with_uploaded_body(&item, 0, "a.md", b"x", &body)]);
    space.commit_ok(&[space.file_with_uploaded_body(&item, 1, "b.md", b"x", &body)]);
    space.init_blob(&new_body(), 7000).expect(201);
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
    let usage = account.overview()["usage"].clone();
    assert_eq!(usage["live_bytes"], 3000);
    assert_eq!(usage["history_bytes"], 0);
}

#[test]
fn live_bytes_of_all_spaces_are_summed() {
    // П55, Р11.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let (first, second) = (account.create_space(), account.create_space());
    first.commit_ok(&[first.raw_file(&new_item(), 0, "a.md", 6000)]);
    second
        .init_blob(&new_body(), 4001)
        .expect_error(507, "quota_exceeded");
    second.commit_ok(&[second.raw_file(&new_item(), 0, "b.md", 4000)]);
    first
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
    assert_eq!(account.overview()["usage"]["live_bytes"], 10_000);
}

#[test]
fn the_same_blob_id_of_two_users_is_never_merged() {
    // П55, Е.10: (space, blob_id) is the key, and the sum is per user.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let body = new_body();
    for _ in 0..2 {
        let account = enroll(&target, PASSWORD);
        let space = account.create_space();
        space.upload_sealed(&body, &[1u8; 6000]);
        space.commit_ok(&[space.file_with_uploaded_body(&new_item(), 0, "a.md", b"x", &body)]);
        space.init_blob(&new_body(), 4000).expect(201);
        space
            .init_blob(&new_body(), 1)
            .expect_error(507, "quota_exceeded");
        assert_eq!(account.overview()["usage"]["live_bytes"], 6000);
    }
}

#[test]
fn what_is_already_stored_is_not_touched_by_the_quota() {
    // П42: at the limit, reading, the repeated start of a known body, parts of started bodies and
    // commits of existing bodies all still work.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let space = space_of(&target);
    let kept = new_body();
    space.upload_sealed(&kept, &[2u8; 6000]);
    let started = new_body();
    space.init_blob(&started, 4000).expect(201);
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
    space.download(&kept).expect(200);
    space.init_blob(&kept, 6000).expect(200);
    space.init_blob(&started, 4000).expect(200);
    space.put_part(&started, 0, vec![3u8; 4000]).expect(200);
    space.complete_blob(&started).expect(200);
    space.commit_ok(&[space.file_with_uploaded_body(&new_item(), 0, "a.md", b"x", &kept)]);
}

#[test]
fn the_quota_is_per_user_and_covers_all_their_spaces() {
    // П42, Р11.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let (first, second) = (account.create_space(), account.create_space());
    first.init_blob(&new_body(), 6000).expect(201);
    second
        .init_blob(&new_body(), 5000)
        .expect_error(507, "quota_exceeded");
    space_of(&target).init_blob(&new_body(), 9000).expect(201);
}

#[test]
fn without_a_quota_nothing_is_limited_but_the_size_of_a_body() {
    // П42, Р11: the quota is off by default.
    let target = Target::in_process();
    let _ = in_process_or_skip!(target);
    let space = space_of(&target);
    for _ in 0..3 {
        space.init_blob(&new_body(), 400 * 1024 * 1024).expect(201);
    }
}

// ----- not getting stuck (П56) -----

#[test]
fn at_the_limit_a_deletion_frees_the_place_at_once() {
    // П56-а: live 6000 and a pending body of 4000 make the quota full; deleting the file makes
    // room for 6000 at once, without waiting for any cleanup.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let space = space_of(&target);
    let item = new_item();
    space.commit_ok(&[space.raw_file(&item, 0, "big.md", 6000)]);
    space.init_blob(&new_body(), 4000).expect(201);
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
    space.commit_ok(&[space.deletion(&item, 1, "big.md")]);
    space.init_blob(&new_body(), 6000).expect(201);
}

#[test]
fn replacing_a_file_by_an_equal_or_smaller_one_works_at_the_limit_with_replaces() {
    // П56-б, П56-г: the credit is the size of the current body; without the hint the same
    // request is refused.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let space = space_of(&target);
    let item = new_item();
    space.commit_ok(&[space.raw_file(&item, 0, "a.md", 10_000)]);
    space
        .init_blob(&new_body(), 10_000)
        .expect_error(507, "quota_exceeded");
    let equal = space.raw_file_replacing(&item, 1, "a.md", 10_000);
    space.commit_ok(&[equal]);
    let smaller = space.raw_file_replacing(&item, 2, "a.md", 9_000);
    space.commit_ok(&[smaller]);
    space.init_blob(&new_body(), 1_000).expect(201);
}

#[test]
fn a_bigger_replacement_gets_the_credit_and_pays_only_the_growth() {
    // П56-г: live 4000 + 5000; a new 5000 replacing the first costs 1000 more: 10 000 fits,
    // 10 001 does not.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let space = space_of(&target);
    let (first, second) = (new_item(), new_item());
    space.commit_ok(&[space.raw_file(&first, 0, "a.md", 4000)]);
    space.commit_ok(&[space.raw_file(&second, 0, "b.md", 5000)]);
    space
        .init_blob_replacing(&new_body(), 5001, &first)
        .expect_error(507, "quota_exceeded");
    let grown = space.raw_file_replacing(&first, 1, "a.md", 5000);
    space.commit_ok(&[grown]);
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
}

#[test]
fn a_hint_for_an_item_of_another_user_or_space_or_a_made_up_one_gives_no_credit() {
    // П56-б, Е.10-6: the server does not believe the hint.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let (first, second) = (account.create_space(), account.create_space());
    let (mine, in_other_space) = (new_item(), new_item());
    first.commit_ok(&[first.raw_file(&mine, 0, "a.md", 4000)]);
    second.commit_ok(&[second.raw_file(&in_other_space, 0, "b.md", 4000)]);
    // 8000 are used: 4000 more fit only with the credit of an own item of this space.
    first
        .init_blob_replacing(&new_body(), 4001, &in_other_space)
        .expect_error(507, "quota_exceeded");
    first
        .init_blob_replacing(&new_body(), 4001, &new_item())
        .expect_error(507, "quota_exceeded");
    let stranger = space_of(&target);
    let strangers_item = new_item();
    stranger.commit_ok(&[stranger.raw_file(&strangers_item, 0, "c.md", 3000)]);
    first
        .init_blob_replacing(&new_body(), 4001, &strangers_item)
        .expect_error(507, "quota_exceeded");
    // the hint of a made-up item is not an error where the request fits anyway
    first
        .init_blob_replacing(&new_body(), 2000, &new_item())
        .expect(201);
    first
        .init_blob_replacing(&new_body(), 4000, &mine)
        .expect(201);
}

#[test]
fn a_commit_that_would_grow_the_live_bytes_over_the_quota_is_507_and_changes_nothing() {
    // П56-в, П27: the hint let the body in; the commit decides. The whole commit is refused,
    // the folder beside it is not created, the uploaded body stays (waiting for the cleanup).
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let space = space_of(&target);
    let item = new_item();
    space.commit_ok(&[space.raw_file(&item, 0, "a.md", 9000)]);
    let head = space.changes(0, None).expect(200).json()["seq"]
        .as_u64()
        .unwrap();
    let replacement = space.raw_file_replacing(&item, 1, "a.md", 9000);
    let extra = replacement.body.unwrap();
    // the same body as a NEW item: live would be 18 000
    let new = space.file_with_uploaded_body(&new_item(), 0, "copy.md", b"x", &extra);
    let folder = space.folder(&new_item(), 0, "Docs");
    let refused = space
        .commit(&[folder.clone(), new])
        .expect_error(507, "quota_exceeded");
    assert_eq!(refused.details()["limit_bytes"], 10_000);
    assert_eq!(space.changes(0, None).expect(200).json()["seq"], head);
    assert_eq!(space.all_changes(0).len(), 1);
    space.versions(&folder.item).expect_error(404, "not_found");
    space.download(&extra).expect(200);
    // the honest use of the same body — replacing the item — goes through
    space.commit_ok(&[replacement]);
}

#[test]
fn a_user_over_the_quota_can_still_shrink_rename_and_delete_in_one_commit() {
    // П56-а, П57-а: after the quota is lowered, a commit that does not grow the live bytes
    // always passes; growth does not.
    let target = with_quota();
    let control = in_process_or_skip!(target);
    let space = space_of(&target);
    let (a, b, c) = (new_item(), new_item(), new_item());
    let first = space.raw_file(&a, 0, "a.md", 3000);
    let shared = first.body.unwrap();
    space.commit_ok(&[first]);
    space.commit_ok(&[space.raw_file(&b, 0, "b.md", 3000)]);
    space.commit_ok(&[space.raw_file(&c, 0, "c.md", 2000)]);
    control.restart_with(|config| config.quota_bytes_per_user = Some(5000));
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
    let renamed = space.file_with_uploaded_body(&a, 1, "A/renamed.md", b"x", &shared);
    let deleted = space.deletion(&b, 1, "b.md");
    let smaller = space.raw_file_replacing(&c, 1, "c.md", 1000);
    space.commit_ok(&[renamed, deleted, smaller]);
    // 3000 + 1000 are live now: exactly 1000 more fit under the lowered quota.
    space.init_blob(&new_body(), 1000).expect(201);
    space
        .init_blob(&new_body(), 1)
        .expect_error(507, "quota_exceeded");
}
