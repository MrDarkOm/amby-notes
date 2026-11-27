//! The subscription in the client (appendix Н, Н8): the fields of the plan in `account()`, an old
//! server without them, and the code `subscription_required`. Red tests, written before the code.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_client::{ClientError, DeviceToken};
use amby_sync_conformance::client::{enroll, new_body, PASSWORD};
use amby_sync_conformance::Target;
use common::{client_of, Canned, FakeServer};

const CODE: &str = "subscription_required";

fn token_of(account: &amby_sync_conformance::client::Account) -> DeviceToken {
    DeviceToken::new(account.token.clone())
}

fn plans(extra: &str) -> String {
    format!(
        r#"{{"default_plan": "free", "plans": {{
            "free": {{"title": "Free", "sync": false}},
            "pro": {{"title": "Pro", "sync": true}}{extra}
        }}}}"#
    )
}

/// What an old server (before the subscription) answers to `GET /v1/account`: no `sync`, no
/// `until_ms` in `plan`.
const OLD_ACCOUNT: &str = r#"{
    "plan": {"name": "small", "title": "Small", "pinned": false},
    "limits": {"max_spaces": 2, "max_total_bytes": 10000, "max_file_bytes": 4000,
               "history_days": 10, "max_history_bytes": null},
    "usage": {"live_bytes": 0, "pending_bytes": 0, "history_bytes": 0, "spaces": 0},
    "spaces": []
}"#;

#[tokio::test]
async fn account_reads_sync_false_and_no_end_from_a_plan_without_a_subscription() {
    // Н8, Н6: `plan.sync` is the effective plan; `plan.until_ms` is null without a pin.
    let target = Target::in_process_with_plans(&plans(""), |_| {});
    let account = enroll(&target, PASSWORD);
    let view = client_of(&target)
        .account(&token_of(&account))
        .await
        .unwrap();
    assert_eq!(view.plan.name.as_deref(), Some("free"));
    assert!(!view.plan.sync);
    assert_eq!(view.plan.until_ms, None);
}

#[tokio::test]
async fn account_reads_sync_true_and_the_end_of_a_pinned_plan() {
    // Н8, Н3, Н6: a pin through 2026-12-31 ends at 00:00 UTC of 2027-01-01.
    let target = Target::in_process_with_plans(&plans(""), |_| {});
    let account = enroll(&target, PASSWORD);
    target.cli_ok(&[
        "user",
        "plan",
        "set",
        &account.username,
        "pro",
        "--until",
        "2026-12-31",
    ]);
    let view = client_of(&target)
        .account(&token_of(&account))
        .await
        .unwrap();
    assert_eq!(view.plan.name.as_deref(), Some("pro"));
    assert!(view.plan.pinned);
    assert!(view.plan.sync);
    assert_eq!(view.plan.until_ms, Some(1_798_761_600_000));
}

#[tokio::test]
async fn a_pin_without_an_end_has_no_until_ms() {
    // Н8, Н6: `null` is "no end".
    let target = Target::in_process_with_plans(&plans(""), |_| {});
    let account = enroll(&target, PASSWORD);
    target.cli_ok(&["user", "plan", "set", &account.username, "pro"]);
    let view = client_of(&target)
        .account(&token_of(&account))
        .await
        .unwrap();
    assert!(view.plan.sync);
    assert_eq!(view.plan.until_ms, None);
}

#[tokio::test]
async fn an_old_server_without_the_fields_means_sync_true_and_no_end() {
    // Н8, Р13: an old server must not turn into "no subscription". This guards the default of
    // the client; it fails if the client reads a missing `sync` as `false`.
    let server = FakeServer::start(|_| Canned::json(200, OLD_ACCOUNT)).await;
    let view = server
        .client()
        .account(&DeviceToken::new("0".repeat(64)))
        .await
        .unwrap();
    assert_eq!(view.plan.name.as_deref(), Some("small"));
    assert!(view.plan.sync);
    assert_eq!(view.plan.until_ms, None);
}

#[tokio::test]
async fn a_new_answer_with_explicit_fields_is_read_as_they_say() {
    // Н8: the same fake server, the fields present: the client reads the values and does not
    // keep its default.
    let body = OLD_ACCOUNT.replace(
        r#""pinned": false}"#,
        r#""pinned": true, "sync": false, "until_ms": 1798761600000}"#,
    );
    let server = FakeServer::start(move |_| Canned::json(200, &body)).await;
    let view = server
        .client()
        .account(&DeviceToken::new("0".repeat(64)))
        .await
        .unwrap();
    assert!(!view.plan.sync);
    assert_eq!(view.plan.until_ms, Some(1_798_761_600_000));
}

#[tokio::test]
async fn the_protocol_names_the_code() {
    // Н8: `error_code::SUBSCRIPTION_REQUIRED` is the machine code.
    assert_eq!(amby_sync_proto::error_code::SUBSCRIPTION_REQUIRED, CODE);
}

#[tokio::test]
async fn a_403_subscription_required_surfaces_as_that_code() {
    // Н4, Н8: against the real server: a user on a plan without sync starts a body.
    let target = Target::in_process_with_plans(&plans(""), |_| {});
    let account = enroll(&target, PASSWORD);
    target.cli_ok(&["user", "plan", "set", &account.username, "pro"]);
    let space = account.create_space();
    target.cli_ok(&["user", "plan", "set", &account.username, "--default"]);
    let result = client_of(&target)
        .blob_start(&token_of(&account), space.id.as_bytes(), &new_body(), 10)
        .await;
    match result {
        Err(ClientError::Api {
            status: 403, code, ..
        }) => assert_eq!(code, amby_sync_proto::error_code::SUBSCRIPTION_REQUIRED),
        other => panic!("expected 403 subscription_required, got {other:?}"),
    }
}

#[tokio::test]
async fn a_fake_403_subscription_required_is_the_api_error_with_that_code() {
    // Н8, П4: the error shape of the protocol; the code is kept as it is, no retry-after.
    let server = FakeServer::start(|_| {
        Canned::json(
            403,
            r#"{"error": {"code": "subscription_required", "message": "no subscription"}}"#,
        )
    })
    .await;
    let result = server
        .client()
        .blob_start(
            &DeviceToken::new("0".repeat(64)),
            &[1u8; 16],
            &new_body(),
            10,
        )
        .await;
    match result {
        Err(error @ ClientError::Api { .. }) => {
            match &error {
                ClientError::Api {
                    status,
                    code,
                    retry_after_secs,
                } => {
                    assert_eq!(*status, 403);
                    assert_eq!(code, CODE);
                    assert_eq!(*retry_after_secs, None);
                }
                _ => unreachable!(),
            }
            assert!(
                !error.to_string().is_empty(),
                "the error has words for a person"
            );
        }
        other => panic!("expected the Api error, got {other:?}"),
    }
}
