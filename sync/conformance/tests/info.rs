//! `/v1/info`, `instance_id`, the shape of errors and the need for a token (П1, П4, П5, П9, П10).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{assert_hex, info};
use amby_sync_conformance::http::Body;
use amby_sync_conformance::Target;

#[test]
fn info_describes_the_server() {
    // П9, Р11, Р13: version, formats, limits, retention; no token needed.
    let target = Target::from_env();
    let body = info(&target.api);
    assert_eq!(body["server"], "amby-sync-server");
    assert!(body["server_version"].is_string(), "server_version: {body}");
    assert!(body["protocol"]["min"].as_u64().unwrap() <= 1);
    assert!(body["protocol"]["max"].as_u64().unwrap() >= 1);
    assert_eq!(body["formats"]["header"], 1);
    assert_eq!(body["formats"]["body"], 1);
    assert_hex(&body["instance_id"], 16, "instance_id");
    assert!(body["time_ms"].as_i64().unwrap() > 0);
    for name in [
        "max_blob_bytes",
        "part_size",
        "max_commit_items",
        "max_header_bytes",
        "max_json_bytes",
        "changes_page_default",
        "changes_page_max",
        "login_max_failures",
        "login_window_secs",
        "sse_keepalive_secs",
        "login_max_failures_per_user",
        "login_window_per_user_secs",
    ] {
        assert!(
            body["limits"][name].as_u64().is_some_and(|n| n > 0),
            "limits.{name} must be a positive integer: {body}"
        );
    }
    for name in ["version_days", "orphan_blob_hours", "enroll_code_hours"] {
        assert!(
            body["retention"][name].as_u64().is_some_and(|n| n > 0),
            "retention.{name} must be a positive integer: {body}"
        );
    }
}

#[test]
fn info_shows_the_values_the_plan_names() {
    // Р11, Р8, О4, П25, П17: 8 MiB parts, 512 MiB files, 24 hours, 30 days.
    let target = Target::from_env();
    let body = info(&target.api);
    assert_eq!(body["limits"]["part_size"], 8 * 1024 * 1024);
    assert_eq!(body["limits"]["max_blob_bytes"], 512 * 1024 * 1024);
    assert_eq!(body["retention"]["version_days"], 30);
    assert_eq!(body["retention"]["orphan_blob_hours"], 24);
    assert_eq!(body["retention"]["enroll_code_hours"], 24);
}

#[test]
fn instance_id_is_the_same_on_every_call() {
    // П10, С7: the id changes only when the server is new.
    let target = Target::from_env();
    let first = info(&target.api);
    let second = info(&target.api);
    assert_eq!(first["instance_id"], second["instance_id"]);
}

#[test]
fn an_unknown_path_is_a_json_404() {
    // П4, П6: errors are JSON with a machine code, never an HTML page.
    let target = Target::from_env();
    let answer = target.api.get("/v1/nothing-here", None);
    assert_eq!(
        answer
            .header("content-type")
            .map(|v| v.starts_with("application/json")),
        Some(true),
        "errors are application/json"
    );
    answer.expect_error(404, "not_found");
}

#[test]
fn a_wrong_method_is_a_json_405() {
    // П4: the path exists, the method does not.
    let target = Target::from_env();
    target
        .api
        .delete("/v1/info", None)
        .expect_error(405, "method_not_allowed");
}

#[test]
fn every_protected_route_refuses_a_missing_token() {
    // П5: only info and the auth routes work without a token.
    let target = Target::from_env();
    let zero = "00".repeat(16);
    let routes = [
        ("GET", "/v1/keys".to_string()),
        ("GET", "/v1/devices".to_string()),
        ("DELETE", format!("/v1/devices/{zero}")),
        ("GET", "/v1/spaces".to_string()),
        ("GET", format!("/v1/spaces/{zero}/changes")),
        ("GET", format!("/v1/spaces/{zero}/events")),
        ("POST", format!("/v1/spaces/{zero}/blobs")),
        ("GET", format!("/v1/spaces/{zero}/blobs/{zero}")),
        ("POST", format!("/v1/spaces/{zero}/commit")),
        ("GET", format!("/v1/spaces/{zero}/items/{zero}/versions")),
    ];
    for (method, path) in routes {
        let answer = target.api.send(method, &path, None, &[], Body::None);
        assert!(
            answer.status == 401 && answer.error_code().as_deref() == Some("unauthorized"),
            "{method} {path} without a token: expected 401 unauthorized, got HTTP {} {}",
            answer.status,
            answer.text()
        );
    }
}

#[test]
fn a_made_up_token_is_unauthorized_not_revoked() {
    // П5: an unknown token is `unauthorized`; `token_revoked` is only for a real revoked one.
    let target = Target::from_env();
    let made_up = "ab".repeat(32);
    target
        .api
        .get("/v1/keys", Some(&made_up))
        .expect_error(401, "unauthorized");
    target
        .api
        .get("/v1/keys", Some("not-even-hex"))
        .expect_error(401, "unauthorized");
}

#[test]
fn json_requests_need_a_json_body() {
    // П1, П4: not JSON, or the wrong content type, is a 400 with a code.
    let target = Target::from_env();
    target
        .api
        .send(
            "POST",
            "/v1/auth/prelogin",
            None,
            &[],
            Body::Raw(b"this is not json".to_vec(), Some("application/json")),
        )
        .expect_error(400, "bad_request");
    target
        .api
        .send(
            "POST",
            "/v1/auth/prelogin",
            None,
            &[],
            Body::Raw(br#"{"username":"alice"}"#.to_vec(), Some("text/plain")),
        )
        .expect_error(400, "bad_request");
}

#[test]
fn unknown_request_fields_are_ignored() {
    // П7, Р13: a newer client must not break an older server.
    let target = Target::from_env();
    target
        .api
        .post(
            "/v1/auth/prelogin",
            None,
            serde_json::json!({ "username": "someone", "field_from_the_future": [1, 2, 3] }),
        )
        .expect(200);
}
