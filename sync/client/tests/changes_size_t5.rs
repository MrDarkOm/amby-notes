//! Appendix Т, Т5 (finding Б2): the answer of the feed may be as large as a commit the server
//! accepts (64 MiB by default, 96 MiB with the fields of the feed); every other answer keeps the
//! old limit of 4 MiB. Fake server: nothing here depends on a real one.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_client::{ClientError, DeviceToken};
use common::{Canned, FakeServer};

const MIB: usize = 1024 * 1024;
const SPACE: [u8; 16] = [0x11; 16];

fn token() -> DeviceToken {
    DeviceToken::new("0".repeat(64))
}

/// A valid answer of `GET …/changes` of about `target` bytes: entries with long headers.
fn feed_of(target: usize) -> (String, usize) {
    let header = "ab".repeat(8 * 1024);
    let mut entries = Vec::new();
    let mut size = 300;
    let mut seq = 0u64;
    while size < target {
        seq += 1;
        let entry = format!(
            r#"{{"seq":1,"item_id":"{item:032x}","version":1,"header":"{header}","blob_id":null,"blob_size":null,"deleted":false,"device_id":"{dev}","committed_ms":1700000000000}}"#,
            item = seq,
            dev = "22".repeat(16)
        );
        size += entry.len() + 1;
        entries.push(entry);
    }
    let count = entries.len();
    let text = format!(
        r#"{{"instance_id":"{}","seq":1,"since":0,"next":1,"more":false,"gap":false,"changes":[{}]}}"#,
        "33".repeat(16),
        entries.join(",")
    );
    (text, count)
}

/// A valid feed answer padded with an extra field up to `target` bytes.
fn padded_feed(target: usize) -> String {
    let head = format!(
        r#"{{"instance_id":"{}","seq":1,"since":0,"next":1,"more":false,"gap":false,"changes":[],"pad":""#,
        "33".repeat(16)
    );
    let tail = r#""}"#;
    let fill = target.saturating_sub(head.len() + tail.len());
    format!("{head}{}{tail}", "x".repeat(fill))
}

fn is_too_large(error: &ClientError) -> bool {
    matches!(error, ClientError::BadResponse(_))
}

#[tokio::test]
async fn a_feed_answer_of_ten_mib_is_read() {
    // Т5: a commit of a few thousand entries is a feed answer of this size; it must be read.
    let (text, count) = feed_of(10 * MIB);
    assert!(text.len() > 9 * MIB && text.len() < 12 * MIB);
    let server = FakeServer::start(move |_| Canned::json(200, &text)).await;
    let page = server
        .client()
        .changes(&token(), &SPACE, 0, None)
        .await
        .expect("a feed answer of 10 MiB must be accepted");
    assert_eq!(page.changes.len(), count);
}

#[tokio::test]
async fn a_feed_answer_near_the_server_json_limit_is_read() {
    // Т5: the server accepts a commit of up to 64 MiB; with the fields of the feed the answer is
    // a little larger. Up to 96 MiB is read.
    let text = padded_feed(70 * MIB);
    let server = FakeServer::start(move |_| Canned::json(200, &text)).await;
    let page = server
        .client()
        .changes(&token(), &SPACE, 0, None)
        .await
        .expect("a feed answer of 70 MiB must be accepted");
    assert!(page.changes.is_empty());
}

#[tokio::test]
async fn a_feed_answer_over_96_mib_is_bad_response_without_a_panic() {
    // Т5: the old error "the answer is too large", and no reading past the limit.
    let text = padded_feed(97 * MIB);
    let server = FakeServer::start(move |_| Canned::json(200, &text)).await;
    let error = server
        .client()
        .changes(&token(), &SPACE, 0, None)
        .await
        .expect_err("an answer over 96 MiB must fail");
    assert!(is_too_large(&error), "expected bad_response, got {error:?}");
    assert_eq!(error.code(), "bad_response");
}

#[tokio::test]
async fn other_answers_over_4_mib_still_fail() {
    // Т5: only the feed got the larger limit (this keeps the old behaviour: passes before the fix).
    let pad = "x".repeat(5 * MIB);
    let spaces = format!(r#"{{"spaces":[],"pad":"{pad}"}}"#);
    let account = format!(r#"{{"pad":"{pad}"}}"#);
    let server = FakeServer::start(move |path| {
        if path.starts_with("/v1/spaces") {
            Canned::json(200, &spaces)
        } else {
            Canned::json(200, &account)
        }
    })
    .await;
    let client = server.client();
    let error = client.list_spaces(&token()).await.unwrap_err();
    assert!(is_too_large(&error), "spaces: {error:?}");
    let error = client.account(&token()).await.unwrap_err();
    assert!(is_too_large(&error), "account: {error:?}");
}

#[tokio::test]
async fn a_non_feed_answer_just_under_4_mib_is_still_read() {
    // Т5: the limit of the other answers is not lowered (passes before the fix).
    let pad = "x".repeat(3 * MIB);
    let spaces = format!(r#"{{"spaces":[],"pad":"{pad}"}}"#);
    let server = FakeServer::start(move |_| Canned::json(200, &spaces)).await;
    let list = server.client().list_spaces(&token()).await.unwrap();
    assert!(list.is_empty());
}
