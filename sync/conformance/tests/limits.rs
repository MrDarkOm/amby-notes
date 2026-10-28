//! Limits of requests: items per commit, header size, JSON size, body parts (Р11; П8).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{enroll, hex16, limit, new_body, random16, Space, PASSWORD};
use amby_sync_conformance::http::Body;
use amby_sync_conformance::{in_process_or_skip, Target};
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

/// A server of the suite with a low item limit: the real default is 10 000 (П8, Р2), and a test
/// of the edge must not send thousands of headers.
const LOW_ITEM_LIMIT: usize = 40;

#[test]
fn a_commit_of_exactly_the_maximum_number_of_items_is_accepted() {
    // П8, Р2, Р3: a big folder rename is one commit (Р2); the limit itself is allowed.
    let target = Target::in_process_with(|config| config.max_commit_items = LOW_ITEM_LIMIT);
    let _ = in_process_or_skip!(target);
    let space = fresh_space(&target);
    let max = limit(&target.api, "max_commit_items");
    assert_eq!(
        max, LOW_ITEM_LIMIT as u64,
        "/v1/info shows the limit in force"
    );
    let entries = (0..max).map(|n| fake_entry(n, 301)).collect();
    let answer = commit_of(&space, entries).expect(200).json();
    assert_eq!(answer["items"].as_array().unwrap().len() as u64, max);
}

#[test]
fn one_item_more_than_the_maximum_is_refused_and_nothing_is_applied() {
    // П8, П27.
    let target = Target::in_process_with(|config| config.max_commit_items = LOW_ITEM_LIMIT);
    let _ = in_process_or_skip!(target);
    let space = fresh_space(&target);
    let max = limit(&target.api, "max_commit_items");
    let entries = (0..=max).map(|n| fake_entry(n, 301)).collect();
    commit_of(&space, entries).expect_error(400, "too_many_items");
    assert_eq!(space.changes(0, None).expect(200).json()["seq"], 0);
}

#[test]
fn the_default_allows_ten_thousand_items_so_a_big_rename_stays_atomic() {
    // Р2, П8: until 10 000 files a folder rename is one commit; /v1/info says so.
    let target = Target::in_process_with(|_| {});
    let _ = in_process_or_skip!(target);
    assert_eq!(limit(&target.api, "max_commit_items"), 10_000);
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

// ----- the codes and their order at `POST …/blobs` (appendix Е: П59, Е.4) -----

mod blob_checks {
    use super::*;
    use amby_sync_conformance::client::new_item;
    use serde_json::json;

    fn small_quota(config: &mut amby_sync_server::Config) {
        config.quota_bytes_per_user = Some(10_000);
        config.max_blob_bytes = 8_000;
    }

    #[test]
    fn the_413_of_the_server_ceiling_names_size_limit_and_source() {
        // П59.
        let target = Target::in_process_with(small_quota);
        let _ = in_process_or_skip!(target);
        let space = fresh_space(&target);
        let refused = space
            .init_blob(&new_body(), 8_001)
            .expect_error(413, "blob_too_large");
        assert_eq!(
            refused.details(),
            json!({"size": 8_001, "max_bytes": 8_000, "source": "server"})
        );
    }

    #[test]
    fn the_507_names_what_is_used_the_limit_and_what_is_missing() {
        // П59: used = live + pending; needed = what is missing, with the credit counted.
        let target = Target::in_process_with(small_quota);
        let _ = in_process_or_skip!(target);
        let space = fresh_space(&target);
        let item = new_item();
        space.commit_ok(&[space.raw_file(&item, 0, "a.md", 4_000)]);
        space.init_blob(&new_body(), 3_000).expect(201);
        let refused = space
            .init_blob(&new_body(), 4_000)
            .expect_error(507, "quota_exceeded");
        assert_eq!(
            refused.details(),
            json!({"used_bytes": 7_000, "limit_bytes": 10_000, "needed_bytes": 1_000})
        );
        let with_credit = space
            .init_blob_replacing(&new_body(), 8_000, &item)
            .expect_error(507, "quota_exceeded");
        assert_eq!(
            with_credit.details(),
            json!({"used_bytes": 7_000, "limit_bytes": 10_000, "needed_bytes": 1_000}),
            "needed = used + size - credit - limit = 7000 + 8000 - 4000 - 10 000"
        );
    }

    #[test]
    fn the_size_is_checked_before_the_known_body_and_the_known_body_before_the_quota() {
        // Е.4: token → fields → size (413) → body exists (200/409) → quota (507).
        let target = Target::in_process_with(small_quota);
        let _ = in_process_or_skip!(target);
        let space = fresh_space(&target);
        // a body of the right size is known; the quota is then full by another one
        let known = new_body();
        space.init_blob(&known, 5_000).expect(201);
        space.init_blob(&new_body(), 5_000).expect(201);
        space
            .init_blob(&new_body(), 1)
            .expect_error(507, "quota_exceeded");
        space.init_blob(&known, 5_000).expect(200); // known before quota
        space
            .init_blob(&known, 5_001)
            .expect_error(409, "blob_exists"); // another size: 409 before quota
                                               // size before everything: a body over the ceiling is 413 even when it would be "known"
        space
            .init_blob(&new_body(), 8_001)
            .expect_error(413, "blob_too_large");
        // fields before size
        space
            .post("/blobs", json!({"blob_id": "zz", "size": 8_001}))
            .expect_error(400, "bad_request");
    }

    #[test]
    fn a_zero_size_is_still_a_bad_request_and_never_a_quota_question() {
        let target = Target::in_process_with(small_quota);
        let _ = in_process_or_skip!(target);
        let space = fresh_space(&target);
        space.init_blob(&new_body(), 8_000).expect(201);
        space.init_blob(&new_body(), 2_000).expect(201);
        space
            .init_blob(&new_body(), 0)
            .expect_error(400, "bad_request");
    }
}
