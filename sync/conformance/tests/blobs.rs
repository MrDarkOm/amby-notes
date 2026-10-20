//! Uploading bodies in parts, resuming, downloading with ranges (С1, О7, Р6, П21–П24).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{enroll, hex16, limit, new_body, pattern, Space, PASSWORD};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::body::{open_body, seal_body};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use serde_json::json;

const MIB: usize = 1024 * 1024;
const PART: usize = 8 * MIB;

fn fresh_space(target: &Target) -> Space {
    enroll(target, PASSWORD).create_space()
}

#[test]
fn a_real_encrypted_body_goes_up_in_three_parts_and_comes_back_byte_for_byte() {
    // Р6, О7, О1, П21, П22, П23, П24: 17 MiB of content → 3 parts → the same bytes down → opens.
    let space = fresh_space(&Target::from_env());
    let content = pattern(17 * MIB + 123);
    let body = new_body();
    let sealed = seal_body(&space.vk, &body, &content, &mut OsRandom).unwrap();
    space.upload_sealed(&body, &sealed);
    let downloaded = space.download(&body).expect(200);
    assert_eq!(downloaded.body.len(), sealed.len());
    assert!(
        downloaded.body == sealed,
        "the server must return the stored bytes unchanged"
    );
    assert_eq!(downloaded.header("accept-ranges"), Some("bytes"));
    let opened = open_body(
        &space.vk,
        &body,
        content.len() as u64,
        &blake3_hash(&content),
        &downloaded.body,
    );
    assert_eq!(opened.unwrap(), content);
}

#[test]
fn starting_a_body_reports_the_parts() {
    // П21: 201, part size 8 MiB, the number of parts, nothing uploaded yet.
    let space = fresh_space(&Target::from_env());
    for (size, parts) in [
        (100usize, 1u64),
        (PART, 1),
        (PART + 1, 2),
        (2 * PART, 2),
        (20 * MIB, 3),
    ] {
        let body = new_body();
        let answer = space.init_blob(&body, size as u64).expect(201).json();
        assert_eq!(answer["blob_id"], hex16(body.as_bytes()).as_str());
        assert_eq!(answer["size"], size);
        assert_eq!(answer["part_size"], PART);
        assert_eq!(answer["parts"], parts, "size {size}");
        assert_eq!(answer["uploaded"], json!([]));
        assert_eq!(answer["complete"], false);
    }
}

#[test]
fn an_upload_resumes_from_the_last_part_after_a_break() {
    // С1, П21, П22: parts 0 and 1 arrived, the connection dropped; asking again says so and the
    // rest is enough.
    let space = fresh_space(&Target::from_env());
    let sealed = pattern(20 * MIB);
    let body = new_body();
    space.init_blob(&body, sealed.len() as u64).expect(201);
    space
        .put_part(&body, 0, sealed[..PART].to_vec())
        .expect(200);
    space
        .put_part(&body, 1, sealed[PART..2 * PART].to_vec())
        .expect(200);
    // … the break; the device asks what the server already has.
    let again = space
        .init_blob(&body, sealed.len() as u64)
        .expect(200)
        .json();
    assert_eq!(again["uploaded"], json!([0, 1]));
    assert_eq!(again["complete"], false);
    space
        .put_part(&body, 2, sealed[2 * PART..].to_vec())
        .expect(200);
    space.complete_blob(&body).expect(200);
    assert!(space.download(&body).expect(200).body == sealed);
}

#[test]
fn parts_may_arrive_in_any_order() {
    // П22, П23: the last part first is fine.
    let space = fresh_space(&Target::from_env());
    let sealed = pattern(PART + 1000);
    let body = new_body();
    space.init_blob(&body, sealed.len() as u64).expect(201);
    space
        .put_part(&body, 1, sealed[PART..].to_vec())
        .expect(200);
    space
        .put_part(&body, 0, sealed[..PART].to_vec())
        .expect(200);
    space.complete_blob(&body).expect(200);
    assert!(space.download(&body).expect(200).body == sealed);
}

#[test]
fn the_same_body_id_with_another_size_is_refused() {
    // П21: `blob_exists`; the first start is untouched.
    let space = fresh_space(&Target::from_env());
    let body = new_body();
    space.init_blob(&body, 1000).expect(201);
    space
        .init_blob(&body, 2000)
        .expect_error(409, "blob_exists");
    assert_eq!(
        space.init_blob(&body, 1000).expect(200).json()["size"],
        1000
    );
}

#[test]
fn completing_without_every_part_names_the_missing_ones() {
    // П23: 409 parts_missing with the list; the body can still be finished.
    let space = fresh_space(&Target::from_env());
    let sealed = pattern(20 * MIB);
    let body = new_body();
    space.init_blob(&body, sealed.len() as u64).expect(201);
    space
        .put_part(&body, 0, sealed[..PART].to_vec())
        .expect(200);
    let refused = space
        .complete_blob(&body)
        .expect_error(409, "parts_missing");
    assert_eq!(refused.details()["missing"], json!([1, 2]));
    space
        .put_part(&body, 1, sealed[PART..2 * PART].to_vec())
        .expect(200);
    space
        .put_part(&body, 2, sealed[2 * PART..].to_vec())
        .expect(200);
    space.complete_blob(&body).expect(200);
}

#[test]
fn a_part_of_the_wrong_length_or_number_is_refused() {
    // П22: every part but the last is exactly 8 MiB, the last is the remainder; no part n ≥ parts.
    let space = fresh_space(&Target::from_env());
    let body = new_body();
    space.init_blob(&body, (20 * MIB) as u64).expect(201);
    space
        .put_part(&body, 0, vec![1; 100])
        .expect_error(400, "bad_part");
    space
        .put_part(&body, 1, vec![1; PART + 1])
        .expect_error(400, "bad_part");
    space
        .put_part(&body, 2, vec![1; PART])
        .expect_error(400, "bad_part");
    space
        .put_part(&body, 2, vec![1; 4 * MIB - 1])
        .expect_error(400, "bad_part");
    space
        .put_part(&body, 3, vec![1; 10])
        .expect_error(400, "bad_part");
    space.put_part(&body, 2, vec![1; 4 * MIB]).expect(200);
}

#[test]
fn a_part_can_be_sent_again_until_the_body_is_complete() {
    // П22, С1: a repeated part replaces the first; the last one sent is what is stored.
    let space = fresh_space(&Target::from_env());
    let body = new_body();
    space.init_blob(&body, 100).expect(201);
    space.put_part(&body, 0, vec![1; 100]).expect(200);
    space.put_part(&body, 0, vec![2; 100]).expect(200);
    space.complete_blob(&body).expect(200);
    assert_eq!(space.download(&body).expect(200).body, vec![2; 100]);
}

#[test]
fn a_complete_body_cannot_change() {
    // П22, П23: a part after `complete` is refused; `complete` twice is fine.
    let space = fresh_space(&Target::from_env());
    let body = new_body();
    space.init_blob(&body, 100).expect(201);
    space.put_part(&body, 0, vec![1; 100]).expect(200);
    space.complete_blob(&body).expect(200);
    space
        .put_part(&body, 0, vec![9; 100])
        .expect_error(409, "blob_exists");
    let again = space.complete_blob(&body).expect(200).json();
    assert_eq!(again["complete"], true);
    assert_eq!(space.download(&body).expect(200).body, vec![1; 100]);
    let restart = space.init_blob(&body, 100).expect(200).json();
    assert_eq!(restart["complete"], true);
}

#[test]
fn parts_of_a_body_that_was_never_started_are_not_found() {
    // П22, П23, П24.
    let space = fresh_space(&Target::from_env());
    let body = new_body();
    space
        .put_part(&body, 0, vec![1; 10])
        .expect_error(404, "not_found");
    space.complete_blob(&body).expect_error(404, "not_found");
    space.download(&body).expect_error(404, "not_found");
}

#[test]
fn an_unfinished_body_cannot_be_downloaded() {
    // П24: before `complete` the body does not exist as a body.
    let space = fresh_space(&Target::from_env());
    let body = new_body();
    space.init_blob(&body, 100).expect(201);
    space.put_part(&body, 0, vec![1; 100]).expect(200);
    space.download(&body).expect_error(404, "not_found");
}

#[test]
fn ranges_return_exactly_the_requested_bytes() {
    // П24: 206 with Content-Range; open-ended and boundary-crossing ranges; 416 outside.
    let space = fresh_space(&Target::from_env());
    let sealed = pattern(PART + 5000);
    let body = new_body();
    space.upload_sealed(&body, &sealed);
    let size = sealed.len();
    let get = |range: &str| {
        space.api.send(
            "GET",
            &space.path(&format!("/blobs/{}", hex16(body.as_bytes()))),
            Some(&space.token),
            &[("Range", range)],
            amby_sync_conformance::http::Body::None,
        )
    };
    let middle = get("bytes=10-19").expect(206);
    assert_eq!(middle.body, sealed[10..20]);
    assert_eq!(
        middle.header("content-range"),
        Some(format!("bytes 10-19/{size}").as_str())
    );
    let tail = get(&format!("bytes={}-", size - 10)).expect(206);
    assert_eq!(tail.body, sealed[size - 10..]);
    // Across the boundary between the first and second part.
    let across = get(&format!("bytes={}-{}", PART - 8, PART + 7)).expect(206);
    assert_eq!(across.body, sealed[PART - 8..PART + 8]);
    get(&format!("bytes={size}-{}", size + 10)).expect_error(416, "range_not_satisfiable");
}

#[test]
fn a_body_over_the_limit_is_refused_at_the_start() {
    // П8, Р11: the size is checked when the body is started, before any bytes are sent; exactly
    // the limit is allowed.
    let target = Target::from_env();
    let space = fresh_space(&target);
    let max = limit(&target.api, "max_blob_bytes");
    space
        .init_blob(&new_body(), max + 1)
        .expect_error(413, "blob_too_large");
    space.init_blob(&new_body(), max).expect(201);
}

#[test]
fn a_body_of_no_bytes_or_with_a_bad_id_is_refused() {
    // П21, П2, П3.
    let space = fresh_space(&Target::from_env());
    space
        .init_blob(&new_body(), 0)
        .expect_error(400, "bad_request");
    space
        .post(
            "/blobs",
            json!({ "blob_id": hex16(new_body().as_bytes()).to_uppercase(), "size": 10 }),
        )
        .expect_error(400, "bad_request");
    space
        .post("/blobs", json!({ "blob_id": "abcd", "size": 10 }))
        .expect_error(400, "bad_request");
    space
        .post(
            "/blobs",
            json!({ "blob_id": hex16(new_body().as_bytes()), "size": -5 }),
        )
        .expect_error(400, "bad_request");
    space
        .post("/blobs", json!({ "blob_id": hex16(new_body().as_bytes()) }))
        .expect_error(400, "bad_request");
}

#[test]
fn a_body_belongs_to_its_space_and_its_owner() {
    // П6, П30, О1: not readable through another space of the same user, nor by another user.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let first = account.create_space();
    let second = account.create_space();
    let stranger = enroll(&target, PASSWORD);
    let body = new_body();
    first.upload_sealed(&body, &[7u8; 100]);
    second.download(&body).expect_error(404, "not_found");
    first
        .with_token(&stranger.token)
        .download(&body)
        .expect_error(404, "not_found");
    assert_eq!(first.download(&body).expect(200).body, vec![7u8; 100]);
}

#[test]
fn the_server_keeps_the_bytes_it_was_given_without_looking() {
    // Р1, О1: it stores whatever sealed bytes arrive (it cannot check them) and returns them.
    let space = fresh_space(&Target::from_env());
    let body = new_body();
    let nonsense = pattern(5000);
    space.upload_sealed(&body, &nonsense);
    assert_eq!(space.download(&body).expect(200).body, nonsense);
}
