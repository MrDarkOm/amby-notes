//! Deleting a server space needs the current password (appendix Ц, Ц1; П6, П16).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{enroll, hex16, limit, Account, PASSWORD};
use amby_sync_conformance::{Resp, Target};
use serde_json::{json, Value};

fn path_of(space: &amby_sync_conformance::client::Space) -> String {
    format!("/v1/spaces/{}", hex16(space.id.as_bytes()))
}

fn good_key(account: &Account) -> String {
    hex::encode(account.password_auth_key().as_bytes())
}

fn wrong_key() -> String {
    hex::encode([0x5au8; 32])
}

fn has_space(account: &Account, space: &amby_sync_conformance::client::Space) -> bool {
    account.get("/v1/spaces").expect(200).json()["spaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["space_id"] == hex16(space.id.as_bytes()))
}

fn delete_with(account: &Account, space: &amby_sync_conformance::client::Space, key: &str) -> Resp {
    account.delete_json(&path_of(space), json!({ "auth_key": key }))
}

#[test]
fn a_missing_or_malformed_proof_is_400_and_the_space_stays() {
    // Ц1: no body, or a body whose `auth_key` is not 64 hex, is `400 bad_request`.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    account
        .delete(&path_of(&space))
        .expect_error(400, "bad_request");
    let bad_bodies: [Value; 6] = [
        json!({}),
        json!({ "auth_key": null }),
        json!({ "auth_key": 7 }),
        json!({ "auth_key": "abcd" }),
        json!({ "auth_key": "zz".repeat(32) }),
        json!({ "auth_key": format!("{}00", good_key(&account)) }),
    ];
    for body in bad_bodies {
        account
            .delete_json(&path_of(&space), body.clone())
            .expect_error(400, "bad_request");
    }
    assert!(has_space(&account, &space));
}

#[test]
fn a_wrong_key_is_403_invalid_proof_and_the_space_stays() {
    // Ц1: a well-formed but wrong key is `403 invalid_proof`; nothing is deleted.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    delete_with(&account, &space, &wrong_key()).expect_error(403, "invalid_proof");
    assert!(has_space(&account, &space));
    // The recovery key is not the password either.
    delete_with(
        &account,
        &space,
        &hex::encode(account.recovery_auth_key.as_bytes()),
    )
    .expect_error(403, "invalid_proof");
    assert!(has_space(&account, &space));
}

#[test]
fn the_right_key_deletes_the_space() {
    // Ц1: the right key is `200 {"ok":true}` and the space is gone.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let answer = delete_with(&account, &space, &good_key(&account)).expect(200);
    assert_eq!(answer.json(), json!({"ok": true}));
    assert!(!has_space(&account, &space));
}

#[test]
fn wrong_keys_are_counted_and_lock_even_the_right_key() {
    // Ц1, П16: each wrong key counts; after `login_max_failures` the answer is 429 with
    // Retry-After, even for the right key, and the space stays.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let max = limit(&target.api, "login_max_failures");
    for attempt in 0..max {
        let answer = delete_with(&account, &space, &wrong_key());
        assert!(
            answer.status == 403 && answer.error_code().as_deref() == Some("invalid_proof"),
            "attempt {attempt}: expected 403 invalid_proof, got HTTP {} {}",
            answer.status,
            answer.text()
        );
    }
    let locked =
        delete_with(&account, &space, &good_key(&account)).expect_error(429, "rate_limited");
    let retry: u64 = locked
        .header("retry-after")
        .and_then(|value| value.parse().ok())
        .expect("429 needs a numeric Retry-After");
    assert!(retry > 0 && retry <= limit(&target.api, "login_window_secs"));
    assert!(has_space(&account, &space));
}

#[test]
fn a_foreign_space_is_404_even_with_the_right_key() {
    // Ц1, П6: ownership is checked before the proof; somebody else's space is `404 not_found`
    // and a wrong key on it is not counted against the strict limit.
    let target = Target::from_env();
    let owner = enroll(&target, PASSWORD);
    let other = enroll(&target, PASSWORD);
    let foreign = other.create_space();
    delete_with(&owner, &foreign, &good_key(&owner)).expect_error(404, "not_found");
    assert!(has_space(&other, &foreign));

    let own = owner.create_space();
    let max = limit(&target.api, "login_max_failures");
    for _ in 0..max + 1 {
        delete_with(&owner, &foreign, &wrong_key()).expect_error(404, "not_found");
    }
    delete_with(&owner, &own, &good_key(&owner)).expect(200);
}

#[test]
fn the_order_is_token_space_body_limit_proof() {
    // Ц1: 401 → 404 → 400 → 429 → 403.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let other = enroll(&target, PASSWORD);
    let space = account.create_space();
    let foreign = other.create_space();
    let path = path_of(&space);
    let body = json!({ "auth_key": wrong_key() });
    let send = |token: Option<&str>, path: &str, body: Option<&Value>| {
        use amby_sync_conformance::http::Body;
        target.api.send(
            "DELETE",
            path,
            token,
            &[],
            body.map_or(Body::None, |value| Body::Json(value.clone())),
        )
    };

    // 401 before everything: no token, bad body, foreign space.
    send(None, &path_of(&foreign), None).expect_error(401, "unauthorized");
    send(None, &path, Some(&body)).expect_error(401, "unauthorized");
    // 404 before the body is looked at.
    send(Some(&account.token), &path_of(&foreign), None).expect_error(404, "not_found");
    // 400 before the proof is counted: lots of bodiless requests do not lock anything.
    let max = limit(&target.api, "login_max_failures");
    for _ in 0..max + 1 {
        send(Some(&account.token), &path, None).expect_error(400, "bad_request");
    }
    delete_with(&account, &space, &wrong_key()).expect_error(403, "invalid_proof");
    // 429 before the proof is compared, but after the body is read as a body.
    for _ in 1..max {
        delete_with(&account, &space, &wrong_key()).expect_error(403, "invalid_proof");
    }
    send(Some(&account.token), &path, Some(&json!({}))).expect_error(400, "bad_request");
    send(Some(&account.token), &path, Some(&body)).expect_error(429, "rate_limited");
    // And a locked pair still does not unlock a foreign id or a missing token.
    send(Some(&account.token), &path_of(&foreign), None).expect_error(404, "not_found");
    send(None, &path, Some(&body)).expect_error(401, "unauthorized");
    assert!(has_space(&account, &space));
}

#[test]
fn a_success_clears_the_strict_counter() {
    // Ц1: like a sign-in, a right key clears the failures of the pair.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let first = account.create_space();
    let second = account.create_space();
    let max = limit(&target.api, "login_max_failures");
    assert!(max >= 2, "the test needs at least two tries");
    for _ in 0..max - 1 {
        delete_with(&account, &first, &wrong_key()).expect_error(403, "invalid_proof");
    }
    delete_with(&account, &first, &good_key(&account)).expect(200);
    // Without the clearing these `max - 1` would reach the limit together with the earlier ones.
    for _ in 0..max - 1 {
        delete_with(&account, &second, &wrong_key()).expect_error(403, "invalid_proof");
    }
    delete_with(&account, &second, &good_key(&account)).expect(200);
}
