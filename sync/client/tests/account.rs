//! The requests of appendix Е in the client (П56, П61) against the real server in the process.
//! Red until the client and the server have them.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_client::{ClientError, DeviceToken};
use amby_sync_conformance::client::{enroll, new_body, new_item, open_space_name, PASSWORD};
use amby_sync_conformance::Target;
use common::client_of;

fn token_of(account: &amby_sync_conformance::client::Account) -> DeviceToken {
    DeviceToken::new(account.token.clone())
}

#[tokio::test]
async fn the_account_has_the_plan_the_limits_the_usage_and_the_spaces_with_sizes() {
    // П61: a server with a plans file; the client parses everything the app needs.
    let target = Target::in_process_with_plans(
        r#"{"default_plan": "small", "plans": {"small": {"title": "Small", "max_spaces": 2,
            "max_total_bytes": 10000, "max_file_bytes": 4000, "history_days": 10,
            "max_history_bytes": 8000}}}"#,
        |_| {},
    );
    let account = enroll(&target, PASSWORD);
    let space = account.create_space_named("Заметки");
    space.commit_ok(&[space.raw_file(&new_item(), 0, "a.md", 1_500)]);
    let view = client_of(&target)
        .account(&token_of(&account))
        .await
        .unwrap();
    assert_eq!(view.plan.name.as_deref(), Some("small"));
    assert_eq!(view.plan.title.as_deref(), Some("Small"));
    assert!(!view.plan.pinned);
    assert_eq!(view.limits.max_spaces, Some(2));
    assert_eq!(view.limits.max_total_bytes, Some(10_000));
    assert_eq!(view.limits.max_file_bytes, Some(4_000));
    assert_eq!(view.limits.history_days, 10);
    assert_eq!(view.limits.max_history_bytes, Some(8_000));
    assert_eq!(view.usage.live_bytes, 1_500);
    assert_eq!(view.usage.spaces, 1);
    assert_eq!(view.spaces.len(), 1);
    assert_eq!(view.spaces[0].live_bytes, 1_500);
    assert_eq!(view.spaces[0].entry.space_id, *space.id.as_bytes());
    assert_eq!(
        open_space_name(
            &account.ak,
            &view.spaces[0].entry.space_id,
            &hex::encode(&view.spaces[0].entry.name_enc)
        ),
        "Заметки"
    );
}

#[tokio::test]
async fn an_account_without_a_token_is_unauthorized() {
    let target = Target::in_process();
    let result = client_of(&target)
        .account(&DeviceToken::new("0".repeat(64)))
        .await;
    match result {
        Err(ClientError::Api {
            status: 401, code, ..
        }) => assert_eq!(code, "unauthorized"),
        other => panic!("expected 401 unauthorized, got {other:?}"),
    }
}

#[tokio::test]
async fn a_started_body_can_be_deleted_and_a_replaces_hint_is_sent() {
    // П56-б, П56-д.
    let target = Target::in_process_with(|config| config.quota_bytes_per_user = Some(10_000));
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.raw_file(&item, 0, "a.md", 10_000)]);
    let client = client_of(&target);
    let token = token_of(&account);
    // the quota is full: only the credit of `replaces` lets a body of the same size in
    let credited = new_body();
    client
        .blob_start_replacing(&token, space.id.as_bytes(), &credited, 10_000, &item)
        .await
        .expect("the credit of the replaced body lets it in");
    client
        .blob_delete(&token, space.id.as_bytes(), &credited)
        .await
        .expect("an abandoned body can be dropped");
    space.download(&credited).expect_error(404, "not_found");
    let again = client
        .blob_delete(&token, space.id.as_bytes(), &credited)
        .await;
    assert!(again.is_err(), "a body that is gone is 404");
}
