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
fn old_live_versions_count_too() {
    // П42: the bodies of all live versions are in the sum, not only the latest.
    let target = with_quota();
    let _ = in_process_or_skip!(target);
    let space = space_of(&target);
    let item = new_item();
    for version in 0..2 {
        let body = new_body();
        space.upload_sealed(&body, &[7u8; 3000]);
        let prepared = space.file_with_uploaded_body(&item, version, "a.md", b"x", &body);
        space.commit_ok(&[prepared]);
    }
    space
        .init_blob(&new_body(), 4001)
        .expect_error(507, "quota_exceeded");
    space.init_blob(&new_body(), 4000).expect(201);
}

#[test]
fn a_deleted_item_counts_until_cleanup() {
    // П42, П36: deletion frees nothing at once; the 30 days of the history are paid for.
    let target = with_quota();
    let control = in_process_or_skip!(target);
    let space = space_of(&target);
    let item = new_item();
    let body = new_body();
    space.upload_sealed(&body, &[1u8; 6000]);
    space.commit_ok(&[space.file_with_uploaded_body(&item, 0, "big.md", b"x", &body)]);
    space.commit_ok(&[space.deletion(&item, 1, "big.md")]);
    space
        .init_blob(&new_body(), 5000)
        .expect_error(507, "quota_exceeded");
    control.advance(Duration::from_secs(31 * 24 * 3600));
    control.run_maintenance();
    space.init_blob(&new_body(), 5000).expect(201);
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
