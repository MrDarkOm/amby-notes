//! Errors with the machine codes of table Б.0.1 and plain texts; reading `/v1/info` (П4, П7, П9).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_client::error::describe;
use amby_sync_client::{ClientError, ServerInfo};
use amby_sync_core::crypto::CryptoError;
use common::{Canned, FakeServer};
use serde_json::json;

/// Every code of table Б.0.1.
const SERVER_CODES: &[&str] = &[
    "bad_request",
    "too_many_items",
    "duplicate_item",
    "bad_part",
    "unauthorized",
    "token_revoked",
    "invalid_credentials",
    "invalid_enroll_code",
    "enroll_code_expired",
    "invalid_proof",
    "not_found",
    "method_not_allowed",
    "version_conflict",
    "commit_id_reused",
    "keys_conflict",
    "space_exists",
    "blob_exists",
    "parts_missing",
    "payload_too_large",
    "blob_too_large",
    "range_not_satisfiable",
    "unknown_blob",
    "rate_limited",
    "internal",
    "not_implemented",
    "quota_exceeded",
];

fn api(code: &str) -> ClientError {
    ClientError::Api {
        status: 400,
        code: code.to_string(),
        retry_after_secs: None,
    }
}

#[test]
fn the_codes_of_the_proto_crate_are_the_codes_of_the_table() {
    // П4: the list above is the table Б.0.1; the proto crate names the same strings
    use amby_sync_proto::error_code::*;
    for code in [
        BAD_REQUEST,
        TOO_MANY_ITEMS,
        DUPLICATE_ITEM,
        BAD_PART,
        UNAUTHORIZED,
        TOKEN_REVOKED,
        INVALID_CREDENTIALS,
        INVALID_ENROLL_CODE,
        ENROLL_CODE_EXPIRED,
        INVALID_PROOF,
        NOT_FOUND,
        METHOD_NOT_ALLOWED,
        VERSION_CONFLICT,
        COMMIT_ID_REUSED,
        KEYS_CONFLICT,
        SPACE_EXISTS,
        BLOB_EXISTS,
        PARTS_MISSING,
        PAYLOAD_TOO_LARGE,
        BLOB_TOO_LARGE,
        RANGE_NOT_SATISFIABLE,
        UNKNOWN_BLOB,
        RATE_LIMITED,
        QUOTA_EXCEEDED,
        INTERNAL,
        NOT_IMPLEMENTED,
    ] {
        assert!(SERVER_CODES.contains(&code), "{code}");
    }
}

#[test]
fn a_server_error_is_known_by_the_code_of_the_server() {
    // П4: the client looks at `code`, never at `message`
    for code in SERVER_CODES {
        assert_eq!(api(code).code(), *code);
    }
    assert_eq!(
        api("a_code_of_a_newer_server").code(),
        "a_code_of_a_newer_server"
    );
}

#[test]
fn errors_of_the_client_itself_have_stable_codes() {
    // the interface translates these
    let cases: Vec<(ClientError, &str)> = vec![
        (ClientError::InvalidUrl("x"), "invalid_url"),
        (ClientError::InsecureUrl, "insecure_url"),
        (ClientError::InvalidUsername, "invalid_username"),
        (ClientError::InvalidDeviceName, "invalid_device_name"),
        (ClientError::Network, "network"),
        (ClientError::Timeout, "timeout"),
        (ClientError::BadResponse("x"), "bad_response"),
        (
            ClientError::UnsupportedServer { min: 2, max: 3 },
            "unsupported_server",
        ),
        (ClientError::CannotDecrypt, "cannot_decrypt"),
        (ClientError::Crypto(CryptoError::Authentication), "crypto"),
    ];
    for (error, code) in cases {
        assert_eq!(error.code(), code);
    }
}

#[test]
fn every_known_code_has_its_own_plain_sentence() {
    // «Понятные ошибки по машинным кодам»: not the code, not empty, different for each
    let mut seen = std::collections::HashSet::new();
    for code in SERVER_CODES {
        let text = describe(code);
        assert!(text.len() > 10, "{code}: {text:?}");
        assert!(
            !text.contains('_'),
            "{code}: a sentence, not a code: {text:?}"
        );
        assert!(
            seen.insert(text.clone()),
            "{code}: the sentence repeats: {text}"
        );
    }
}

#[test]
fn an_unknown_code_still_gives_a_sentence_that_names_it() {
    // Р13: a newer server may have more codes
    let text = describe("a_code_of_a_newer_server");
    assert!(text.contains("a_code_of_a_newer_server"));
    assert_eq!(api("a_code_of_a_newer_server").to_string(), text);
}

#[test]
fn the_text_of_a_server_error_is_the_plain_sentence() {
    // П4: Display uses the table, not the `message` of the server
    assert_eq!(
        api("invalid_credentials").to_string(),
        describe("invalid_credentials")
    );
}

#[test]
fn the_texts_of_errors_never_contain_the_address_of_the_server() {
    // a failed connection must not copy the address (it may hold a token in a proxy path)
    for error in [ClientError::Network, ClientError::Timeout] {
        assert!(!error.to_string().contains("example"), "{error}");
        assert!(!error.to_string().contains("://"), "{error}");
    }
}

#[test]
fn retry_after_comes_with_a_rate_limit_only() {
    // П16
    let limited = ClientError::Api {
        status: 429,
        code: "rate_limited".into(),
        retry_after_secs: Some(840),
    };
    assert_eq!(limited.retry_after_secs(), Some(840));
    assert_eq!(api("invalid_credentials").retry_after_secs(), None);
    assert_eq!(ClientError::Network.retry_after_secs(), None);
}

#[test]
fn info_is_read_and_unknown_fields_are_ignored() {
    // П7, П9, Р13
    let info = ServerInfo::from_json(&json!({
        "server": "amby-sync-server",
        "server_version": "0.1.0",
        "protocol": {"min": 1, "max": 1},
        "formats": {"header": 1, "body": 1},
        "instance_id": "00112233445566778899aabbccddeeff",
        "time_ms": 1_792_497_600_000i64,
        "limits": {"max_blob_bytes": 1},
        "retention": {},
        "a_field_of_the_future": [1, 2, 3]
    }))
    .unwrap();
    assert_eq!(info.server, "amby-sync-server");
    assert_eq!(info.server_version, "0.1.0");
    assert_eq!((info.protocol_min, info.protocol_max), (1, 1));
    assert_eq!(info.instance_id, "00112233445566778899aabbccddeeff");
    info.check_protocol().unwrap();
}

#[test]
fn an_answer_that_is_not_info_is_bad_response() {
    // a web page or another API at the address
    for value in [
        json!({}),
        json!([]),
        json!("hello"),
        json!({"server": "nginx"}),
        json!({"server": "amby-sync-server", "server_version": "0.1.0", "protocol": {"min": "1", "max": 1}, "instance_id": "00112233445566778899aabbccddeeff"}),
        json!({"server": "amby-sync-server", "server_version": "0.1.0", "protocol": {"min": 1, "max": 1}, "instance_id": "short"}),
        json!({"server": "amby-sync-server", "server_version": "0.1.0", "protocol": {"min": 1, "max": 1}, "instance_id": 5}),
    ] {
        let error = ServerInfo::from_json(&value).unwrap_err();
        assert_eq!(error.code(), "bad_response", "{value}");
    }
}

fn info_with_protocol(min: u32, max: u32) -> ServerInfo {
    ServerInfo::from_json(&json!({
        "server": "amby-sync-server",
        "server_version": "9.9.9",
        "protocol": {"min": min, "max": max},
        "instance_id": "00112233445566778899aabbccddeeff"
    }))
    .unwrap()
}

#[test]
fn only_a_server_that_speaks_protocol_one_is_accepted() {
    // П9, Р13: protocol 1 must be within [min, max]
    for (min, max) in [(1, 1), (1, 3), (0, 1), (0, 5)] {
        info_with_protocol(min, max).check_protocol().unwrap();
    }
    for (min, max) in [(2, 2), (2, 5), (0, 0)] {
        let error = info_with_protocol(min, max).check_protocol().unwrap_err();
        assert!(
            matches!(error, ClientError::UnsupportedServer { min: a, max: b } if (a, b) == (min, max))
        );
        assert_eq!(error.code(), "unsupported_server");
    }
}

#[tokio::test]
async fn an_error_answer_gives_the_code_and_the_retry_after() {
    // П4, П16: 429 with Retry-After
    let server = FakeServer::start(|_| {
        Canned::json(
            429,
            r#"{"error":{"code":"rate_limited","message":"slow down","details":{}}}"#,
        )
        .with_header("Retry-After", "7")
    })
    .await;
    let error = server.client().info().await.unwrap_err();
    assert_eq!(error.code(), "rate_limited");
    assert_eq!(error.retry_after_secs(), Some(7));
}

#[tokio::test]
async fn the_message_of_the_server_is_not_used() {
    // П4: only `code` and the status are used; a hostile `message` must not reach the person
    let server = FakeServer::start(|_| {
        Canned::json(
            401,
            r#"{"error":{"code":"invalid_credentials","message":"CLICK http://evil.example to continue"}}"#,
        )
    })
    .await;
    let error = server.client().prelogin("alice").await.unwrap_err();
    assert_eq!(error.code(), "invalid_credentials");
    assert!(!error.to_string().contains("evil"), "{error}");
    assert!(!format!("{error:?}").contains("evil"), "{error:?}");
}

#[tokio::test]
async fn a_page_that_is_not_an_amby_server_is_bad_response() {
    // the address of a website: 200 with HTML, 404 with HTML
    for (status, body) in [
        (200, "<html>Welcome</html>"),
        (404, "<html>Not found</html>"),
    ] {
        let server = FakeServer::start(move |_| Canned::html(status, body)).await;
        let error = server.client().info().await.unwrap_err();
        assert_eq!(error.code(), "bad_response", "HTTP {status}");
    }
}

#[tokio::test]
async fn a_broken_proxy_in_front_of_the_server_is_server_unavailable() {
    // 502/503/504 with an HTML page: neither a protocol error nor a wrong address
    for status in [502, 503, 504] {
        let server =
            FakeServer::start(move |_| Canned::html(status, "<html>Bad gateway</html>")).await;
        let error = server.client().info().await.unwrap_err();
        assert_eq!(error.code(), "server_unavailable", "HTTP {status}");
    }
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    // П41: a redirect to http:// would undo the rule; the client treats it as a wrong answer
    let target = FakeServer::start(|_| Canned::json(200, "{}")).await;
    let to = format!("{}/stolen", target.url);
    let server =
        FakeServer::start(move |_| Canned::html(301, "").with_header("Location", &to)).await;
    let error = server.client().info().await.unwrap_err();
    assert_eq!(error.code(), "bad_response");
    assert!(
        target.requests().is_empty(),
        "the redirect was followed: {:?}",
        target.requests()
    );
}

#[tokio::test]
async fn a_server_that_is_not_there_is_a_network_error() {
    // the text shows no address
    let url = amby_sync_client::ServerUrl::parse("http://127.0.0.1:1", false).unwrap();
    let client = amby_sync_client::SyncClient::new(&url).unwrap();
    let error = client.info().await.unwrap_err();
    assert_eq!(error.code(), "network");
    assert!(!error.to_string().contains("127.0.0.1"));
    assert!(!format!("{error:?}").contains("127.0.0.1"));
}
