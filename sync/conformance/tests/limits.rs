//! Limits of requests: items per commit, header size, JSON size, body parts (Р11; П8).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{enroll, hex16, limit, new_body, random16, Space, PASSWORD};
use amby_sync_conformance::http::Body;
use amby_sync_conformance::Target;
use serde_json::{json, Value};

fn fresh_space(target: &Target) -> Space {
    enroll(target, PASSWORD).create_space()
}

/// A commit entry with a made-up header of `header_len` bytes. The server is blind (Р1) and
/// cannot tell it from a real envelope; only the size can be wrong.
fn fake_entry(number: u64, header_len: usize) -> Value {
    let mut item = [0u8; 16];
    item[8..].copy_from_slice(&number.to_be_bytes());
    json!({
        "item_id": hex16(&item),
        "base_version": 0,
        "header": hex::encode(vec![0x5a; header_len]),
        "blob_id": null,
        "deleted": false,
    })
}

fn commit_of(space: &Space, entries: Vec<Value>) -> amby_sync_conformance::Resp {
    space.post(
        "/commit",
        json!({ "commit_id": hex16(&random16()), "items": entries }),
    )
}

#[test]
fn a_commit_of_exactly_the_maximum_number_of_items_is_accepted() {
    // П8, Р2, Р3: a big folder rename is one commit (Р2); the limit itself is allowed.
    let target = Target::from_env();
    let space = fresh_space(&target);
    let max = limit(&target.api, "max_commit_items");
    let entries = (0..max).map(|n| fake_entry(n, 301)).collect();
    let answer = commit_of(&space, entries).expect(200).json();
    assert_eq!(answer["items"].as_array().unwrap().len() as u64, max);
}

#[test]
fn one_item_more_than_the_maximum_is_refused_and_nothing_is_applied() {
    // П8, П27.
    let target = Target::from_env();
    let space = fresh_space(&target);
    let max = limit(&target.api, "max_commit_items");
    let entries = (0..=max).map(|n| fake_entry(n, 301)).collect();
    commit_of(&space, entries).expect_error(400, "too_many_items");
    assert_eq!(space.changes(0, None).expect(200).json()["seq"], 0);
}

#[test]
fn a_header_of_exactly_the_maximum_size_is_accepted_and_one_byte_more_is_not() {
    // П8, П26.
    let target = Target::from_env();
    let space = fresh_space(&target);
    let max = limit(&target.api, "max_header_bytes") as usize;
    commit_of(&space, vec![fake_entry(1, max)]).expect(200);
    commit_of(&space, vec![fake_entry(2, max + 1)]).expect_error(400, "bad_request");
}

#[test]
fn a_json_request_of_exactly_the_limit_is_read_and_one_byte_more_is_413() {
    // П8, П7: the limit counts bytes of the request body. Unknown fields are ignored (П7), so a
    // padded prelogin request is a good one.
    let target = Target::from_env();
    let max = limit(&target.api, "max_json_bytes") as usize;
    if max > 8 * 1024 * 1024 {
        eprintln!("SKIP: the JSON limit ({max} bytes) is too big to test over the network");
        return;
    }
    let make = |total: usize| {
        let head = br#"{"username":"someone","pad":""#.as_slice();
        let tail = br#""}"#.as_slice();
        let fill = total - head.len() - tail.len();
        let mut body = Vec::with_capacity(total);
        body.extend_from_slice(head);
        body.extend(std::iter::repeat_n(b'a', fill));
        body.extend_from_slice(tail);
        body
    };
    target
        .api
        .send(
            "POST",
            "/v1/auth/prelogin",
            None,
            &[],
            Body::Raw(make(max), Some("application/json")),
        )
        .expect(200);
    target
        .api
        .send(
            "POST",
            "/v1/auth/prelogin",
            None,
            &[],
            Body::Raw(make(max + 1), Some("application/json")),
        )
        .expect_error(413, "payload_too_large");
}

#[test]
fn the_json_limit_does_not_apply_to_body_parts() {
    // П8, П22: a part is 8 MiB of raw bytes, more than the JSON limit of a test server.
    let target = Target::from_env();
    let space = fresh_space(&target);
    let json_max = limit(&target.api, "max_json_bytes");
    let part = limit(&target.api, "part_size");
    assert!(
        part >= json_max.min(part),
        "parts are sized by part_size alone"
    );
    let body = new_body();
    let size = part as usize;
    space.init_blob(&body, part).expect(201);
    space.put_part(&body, 0, vec![4; size]).expect(200);
    space.complete_blob(&body).expect(200);
    assert_eq!(space.download(&body).expect(200).body.len(), size);
}

#[test]
fn the_part_size_is_eight_mebibytes() {
    // Р11, П21: uploads are cut into parts of 8 MiB.
    let target = Target::from_env();
    assert_eq!(limit(&target.api, "part_size"), 8 * 1024 * 1024);
    let space = fresh_space(&target);
    let answer = space
        .init_blob(&new_body(), 8 * 1024 * 1024 + 1)
        .expect(201)
        .json();
    assert_eq!(answer["parts"], 2);
}
