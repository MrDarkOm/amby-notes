//! Login and recovery without a device name (appendix М, М1–М3).
//!
//! A new device cannot seal its name before the answer gives it AK, so `device` and
//! `device.name_enc` of `login` and `recover` are optional: the device is created with an empty
//! name and named afterwards with `PUT /v1/devices/{id}`. These tests describe the protocol
//! before its implementation. Guard tests (marked `guard`) pin what must NOT change.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{
    enroll, enroll_body, limit, open_device_name, seal_device_name, Account, NAME_ENVELOPE_LEN,
    PASSWORD,
};
use amby_sync_conformance::{Resp, Target};
use amby_sync_core::crypto::account::{create_account, Argon2Params};
use amby_sync_core::crypto::random::{OsRandom, Random};
use serde_json::{json, Value};

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    OsRandom.fill(&mut buffer);
    hex::encode(buffer)
}

/// A login body with the right password and the given `device` member (absent when `None`).
fn login_body(account: &Account, device: Option<Value>) -> Value {
    let mut body = json!({
        "username": account.username,
        "auth_key": hex::encode(account.password_auth_key().as_bytes()),
    });
    if let Some(device) = device {
        body["device"] = device;
    }
    body
}

/// A recover body with the right code and the given `device` member (absent when `None`).
fn recover_body(account: &Account, device: Option<Value>) -> Value {
    let mut body = json!({
        "username": account.username,
        "recovery_auth_key": hex::encode(account.recovery_auth_key.as_bytes()),
    });
    if let Some(device) = device {
        body["device"] = device;
    }
    body
}

fn post_login(account: &Account, body: Value) -> Resp {
    account.api.post("/v1/auth/login", None, body)
}

fn post_recover(account: &Account, body: Value) -> Resp {
    account.api.post("/v1/auth/recover", None, body)
}

/// A wrong login (random key) with or without `device`.
fn wrong_login(target: &Target, username: &str, named: bool) -> Resp {
    let mut body = json!({ "username": username, "auth_key": random_hex(32) });
    if named {
        body["device"] = json!({ "name_enc": random_hex(NAME_ENVELOPE_LEN) });
    }
    target.api.post("/v1/auth/login", None, body)
}

/// A wrong recovery (random key) with or without `device`.
fn wrong_recover(target: &Target, username: &str, named: bool) -> Resp {
    let mut body = json!({ "username": username, "recovery_auth_key": random_hex(32) });
    if named {
        body["device"] = json!({ "name_enc": random_hex(NAME_ENVELOPE_LEN) });
    }
    target.api.post("/v1/auth/recover", None, body)
}

/// The device the answer of login/recover describes, with its token.
fn device_of(answer: &Resp) -> (String, String) {
    let body = answer.json();
    (
        body["device_id"]
            .as_str()
            .expect("no device_id")
            .to_string(),
        body["token"].as_str().expect("no token").to_string(),
    )
}

/// The entry of a device in `GET /v1/devices`, read with the first device's token.
fn entry_of(account: &Account, device_id: &str) -> Value {
    let list = account.get("/v1/devices").expect(200).json();
    list["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["device_id"] == device_id)
        .unwrap_or_else(|| panic!("device {device_id} is not in the list: {list}"))
        .clone()
}

/// Checks the М3 life of an unnamed device: empty name in the list, then a rename that sticks.
fn check_unnamed_then_renamed(account: &Account, answer: Resp) {
    let answer = answer.expect(200);
    let (device_id, token) = device_of(&answer);
    assert_eq!(device_id.len(), 32);
    assert_eq!(token.len(), 64);
    let entry = entry_of(account, &device_id);
    assert_eq!(
        entry["name_enc"], "",
        "М3: a device made without a name has an empty name_enc"
    );
    // М3: the name is set with the existing rename, by the new device itself.
    account
        .api
        .put(
            &format!("/v1/devices/{device_id}"),
            Some(&token),
            json!({ "name_enc": seal_device_name(&account.ak, "my laptop") }),
        )
        .expect(204);
    let entry = entry_of(account, &device_id);
    assert_eq!(
        open_device_name(&account.ak, entry["name_enc"].as_str().unwrap()),
        "my laptop"
    );
    let list = account.get("/v1/devices").expect(200).json();
    assert_eq!(list["devices"].as_array().unwrap().len(), 2);
}

// ---------------------------------------------------------------- М1: the name is optional

#[test]
fn login_without_device_creates_an_unnamed_device_that_can_be_renamed() {
    // М1, М3, П14, П19: no `device` member at all → 200; empty name in the list; PUT names it.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = post_login(&account, login_body(&account, None));
    let body = answer.clone().expect(200).json();
    for field in ["device_id", "token", "wrapped_ak", "salt", "params"] {
        assert!(
            body.get(field).is_some(),
            "М1: the answer is as before, `{field}` is missing: {body}"
        );
    }
    check_unnamed_then_renamed(&account, answer);
}

#[test]
fn login_with_an_empty_device_object_is_accepted_too() {
    // М1: `device` is present but without `name_enc` → also 200, also an unnamed device.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = post_login(&account, login_body(&account, Some(json!({}))));
    check_unnamed_then_renamed(&account, answer);
}

#[test]
fn recover_without_device_creates_an_unnamed_device_that_can_be_renamed() {
    // М1, М3, П15: the same for the recovery code.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = post_recover(&account, recover_body(&account, None));
    let body = answer.clone().expect(200).json();
    for field in ["device_id", "token", "wrapped_ak_recovery", "keys_version"] {
        assert!(
            body.get(field).is_some(),
            "М1: the answer is as before, `{field}` is missing: {body}"
        );
    }
    check_unnamed_then_renamed(&account, answer);
}

#[test]
fn recover_with_an_empty_device_object_is_accepted_too() {
    // М1: `device: {}` on recover.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = post_recover(&account, recover_body(&account, Some(json!({}))));
    check_unnamed_then_renamed(&account, answer);
}

#[test]
fn an_unnamed_device_has_a_working_token() {
    // М1: nothing else differs from a named device: the token opens the account.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = post_login(&account, login_body(&account, None)).expect(200);
    let (_, token) = device_of(&answer);
    account.api.get("/v1/keys", Some(&token)).expect(200);
    account.api.get("/v1/devices", Some(&token)).expect(200);
}

#[test]
fn an_unnamed_device_cannot_be_given_an_empty_name() {
    // М3: `PUT` still refuses an empty name, so a device cannot go back to being unnamed.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = post_login(&account, login_body(&account, None));
    let answer = answer.expect(200);
    let (device_id, token) = device_of(&answer);
    account
        .api
        .put(
            &format!("/v1/devices/{device_id}"),
            Some(&token),
            json!({ "name_enc": "" }),
        )
        .expect_error(400, "bad_request");
    assert_eq!(entry_of(&account, &device_id)["name_enc"], "");
}

#[test]
fn guard_put_still_refuses_an_empty_name_on_a_named_device() {
    // М3 (guard, expected green): the rename route is not loosened for anybody.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    account
        .put(
            &format!("/v1/devices/{}", account.device_id),
            json!({ "name_enc": "" }),
        )
        .expect_error(400, "bad_request");
}

// ---------------------------------------------------------------- М1: a present name is checked

#[test]
fn guard_a_present_but_malformed_name_is_still_bad_request() {
    // М1, Ф34 (guard, expected green): a present `name_enc` of a wrong form is 400 on login and
    // recover, exactly as before; no device is made by a refused request.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let wrong_forms = [
        json!(""),
        json!(random_hex(104)),
        json!(random_hex(106)),
        json!("zz".repeat(NAME_ENVELOPE_LEN)),
        json!(105),
        json!(null),
    ];
    for name_enc in wrong_forms {
        post_login(
            &account,
            login_body(&account, Some(json!({ "name_enc": name_enc }))),
        )
        .expect_error(400, "bad_request");
        post_recover(
            &account,
            recover_body(&account, Some(json!({ "name_enc": name_enc }))),
        )
        .expect_error(400, "bad_request");
    }
    let list = account.get("/v1/devices").expect(200).json();
    assert_eq!(list["devices"].as_array().unwrap().len(), 1);
}

#[test]
fn guard_enroll_still_requires_a_device_name() {
    // М1 (guard, expected green): `enroll` does not change; no name → 400 and the code is kept.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    let mut no_device = enroll_body(&ticket.username, &ticket.enroll_code, &new, "d");
    no_device.as_object_mut().unwrap().remove("device");
    target
        .api
        .post("/v1/auth/enroll", None, no_device)
        .expect_error(400, "bad_request");
    let mut empty_device = enroll_body(&ticket.username, &ticket.enroll_code, &new, "d");
    empty_device["device"] = json!({});
    target
        .api
        .post("/v1/auth/enroll", None, empty_device)
        .expect_error(400, "bad_request");
    // The refused enrolments did not burn the code (П12).
    target
        .api
        .post(
            "/v1/auth/enroll",
            None,
            enroll_body(&ticket.username, &ticket.enroll_code, &new, "d"),
        )
        .expect(201);
}

// ---------------------------------------------------------------- М2: refusals do not change

#[test]
fn wrong_credentials_without_a_name_are_refused_exactly_like_with_a_name() {
    // М2, П14: status, code, message and the whole body are identical, for a real name, an
    // unknown name and a name that waits for its password.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let waiting = target.new_ticket();
    for username in [
        account.username.clone(),
        target.new_username(),
        waiting.username.clone(),
    ] {
        let with_name = wrong_login(&target, &username, true);
        let without_name = wrong_login(&target, &username, false);
        assert_eq!(with_name.status, 401);
        assert_eq!(
            (without_name.status, without_name.error_code()),
            (401, Some("invalid_credentials".to_string())),
            "М2: login without a name for {username}: {}",
            without_name.text()
        );
        assert_eq!(
            without_name.json(),
            with_name.json(),
            "М2: the bodies must be identical"
        );
    }
}

#[test]
fn a_wrong_password_of_a_real_account_without_a_name_makes_no_device() {
    // М2, С12: a refused unnamed login is 401 and creates nothing.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    wrong_login(&target, &account.username, false).expect_error(401, "invalid_credentials");
    let list = account.get("/v1/devices").expect(200).json();
    assert_eq!(list["devices"].as_array().unwrap().len(), 1);
}

#[test]
fn wrong_recovery_without_a_name_is_refused_exactly_like_with_a_name() {
    // М2, П15: the same for recover.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    for username in [account.username.clone(), target.new_username()] {
        let with_name = wrong_recover(&target, &username, true);
        let without_name = wrong_recover(&target, &username, false);
        assert_eq!(with_name.status, 401);
        assert_eq!(
            (without_name.status, without_name.error_code()),
            (401, Some("invalid_credentials".to_string())),
            "М2: recover without a name for {username}: {}",
            without_name.text()
        );
        assert_eq!(without_name.json(), with_name.json());
    }
}

#[test]
fn failures_without_a_name_count_towards_the_lock_like_the_others() {
    // М2, П16: N unnamed failures lock the name; the right password (named or not) is then 429.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for attempt in 0..max {
        let answer = wrong_login(&target, &account.username, false);
        assert!(
            answer.status == 401 && answer.error_code().as_deref() == Some("invalid_credentials"),
            "attempt {attempt}: expected 401 invalid_credentials, got HTTP {} {}",
            answer.status,
            answer.text()
        );
    }
    post_login(&account, login_body(&account, None)).expect_error(429, "rate_limited");
    post_login(
        &account,
        login_body(
            &account,
            Some(json!({ "name_enc": seal_device_name(&account.ak, "named") })),
        ),
    )
    .expect_error(429, "rate_limited");
}

#[test]
fn failed_recoveries_without_a_name_share_the_count_with_named_logins() {
    // М2, П16: one count for login and recover, named or not.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for attempt in 0..max {
        let answer = if attempt % 2 == 0 {
            wrong_recover(&target, &account.username, false)
        } else {
            wrong_login(&target, &account.username, true)
        };
        assert!(
            answer.status == 401 && answer.error_code().as_deref() == Some("invalid_credentials"),
            "attempt {attempt}: expected 401 invalid_credentials, got HTTP {} {}",
            answer.status,
            answer.text()
        );
    }
    post_recover(&account, recover_body(&account, None)).expect_error(429, "rate_limited");
}
