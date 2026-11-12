//! Account and device identity changes (Ф34, П11, П19).
//!
//! The account name is the login name, while the device name is sealed with AK. Renaming either
//! value must preserve the account key, spaces, tokens and every other authenticated session.
//! These tests describe the protocol before its implementation; a server that does not expose
//! the identity routes fails here with a useful 404.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{
    enroll, login, open_device_name, seal_device_name, Account, NAME_ENVELOPE_LEN, PASSWORD,
};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::random::{OsRandom, Random};
use serde_json::{json, Value};

fn rename_body(username: &str, base_username: &str, auth_key: &str) -> Value {
    json!({
        "username": username,
        "base_username": base_username,
        "auth_key": auth_key,
    })
}

fn device_rename_body(account: &Account, name: &str) -> Value {
    json!({ "name_enc": seal_device_name(&account.ak, name) })
}

#[test]
fn account_name_change_keeps_keys_spaces_devices_and_tokens() {
    // Ф34, П11: the authenticated account can rename its login without rotating AK, keys, spaces,
    // quotas, devices or tokens. The old login stops working and the new one opens the same AK.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let second = account.another_device("second device");
    let space = account.create_space_named("identity space");
    let before_keys = account.get("/v1/keys").expect(200).json();
    let before_account = account.get("/v1/account").expect(200).json();
    let before_devices = account.get("/v1/devices").expect(200).json();
    assert_eq!(
        account.get("/v1/account/username").expect(200).json()["username"],
        account.username
    );
    let new_name = target.new_username();

    account
        .put(
            "/v1/account/username",
            rename_body(
                &new_name,
                &account.username,
                &hex::encode(account.password_auth_key().as_bytes()),
            ),
        )
        .expect(204);

    assert_eq!(account.get("/v1/keys").expect(200).json(), before_keys);
    assert_eq!(
        account.get("/v1/account").expect(200).json(),
        before_account
    );
    assert_eq!(
        account.get("/v1/devices").expect(200).json(),
        before_devices
    );
    assert_eq!(
        account.get("/v1/account/username").expect(200).json()["username"],
        new_name
    );
    assert_eq!(
        second.get("/v1/account/username").expect(200).json()["username"],
        new_name
    );
    second.get("/v1/keys").expect(200);
    space.changes(0, None).expect(200);
    login(&target.api, &account.username, PASSWORD, &account.ak, "old")
        .expect_error(401, "invalid_credentials");
    let fresh = login(&target.api, &new_name, PASSWORD, &account.ak, "fresh").expect(200);
    assert_eq!(fresh.json()["keys_version"], before_keys["keys_version"]);
}

#[test]
fn account_name_change_checks_current_name_password_and_uniqueness() {
    // П11, П18: names are canonical and unique; the proof is the current password auth key, with
    // the same invalid-proof response as a keys update. A stale base name is a conflict.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let other = enroll(&target, PASSWORD);
    let desired = target.new_username();
    account
        .put(
            "/v1/account/username",
            rename_body(
                &desired,
                &account.username,
                &hex::encode(account.password_auth_key().as_bytes()),
            ),
        )
        .expect(204);

    account
        .put(
            "/v1/account/username",
            rename_body(
                &target.new_username(),
                "stale-base",
                &hex::encode(account.password_auth_key().as_bytes()),
            ),
        )
        .expect_error(409, "username_conflict");
    account
        .put(
            "/v1/account/username",
            rename_body(&target.new_username(), &desired, &hex::encode([7u8; 32])),
        )
        .expect_error(403, "invalid_proof");
    account
        .put(
            "/v1/account/username",
            rename_body(
                &other.username,
                &desired,
                &hex::encode(account.password_auth_key().as_bytes()),
            ),
        )
        .expect_error(409, "username_taken");
    account
        .put(
            "/v1/account/username",
            rename_body(
                &desired,
                &desired,
                &hex::encode(account.password_auth_key().as_bytes()),
            ),
        )
        .expect(204);
}

#[test]
fn account_name_change_rejects_invalid_names_and_unauthenticated_requests() {
    // П11, П15: the endpoint uses the same username grammar as enrollment and never exposes an
    // account mutation without a valid device token.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    for invalid in ["", "has space", "-leading", "trailing-", &"x".repeat(65)] {
        account
            .put(
                "/v1/account/username",
                rename_body(
                    invalid,
                    &account.username,
                    &hex::encode(account.password_auth_key().as_bytes()),
                ),
            )
            .expect_error(400, "bad_request");
    }
    target
        .api
        .get("/v1/account/username", None)
        .expect_error(401, "unauthorized");
    target
        .api
        .put(
            "/v1/account/username",
            None,
            rename_body(
                &target.new_username(),
                &account.username,
                &hex::encode(account.password_auth_key().as_bytes()),
            ),
        )
        .expect_error(401, "unauthorized");
}

#[test]
fn device_name_change_is_sealed_and_preserves_device_identity() {
    // Ф34, П19: only the owning account can replace the fixed-size sealed name; the device id,
    // creation time and token remain unchanged and the returned list decrypts with AK.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let other = enroll(&target, PASSWORD);
    let before = account.get("/v1/devices").expect(200).json();
    let device_path = format!("/v1/devices/{}", account.device_id);
    let renamed = "Paul's MacBook";
    account
        .put(&device_path, device_rename_body(&account, renamed))
        .expect(204);
    let after = account.get("/v1/devices").expect(200).json();
    assert_eq!(
        after["devices"].as_array().unwrap().len(),
        before["devices"].as_array().unwrap().len()
    );
    let current = after["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|device| device["device_id"] == account.device_id)
        .unwrap();
    assert_eq!(current["device_id"], account.device_id);
    assert_eq!(current["created_ms"], before["devices"][0]["created_ms"]);
    assert_eq!(
        open_device_name(&account.ak, current["name_enc"].as_str().unwrap()),
        renamed
    );
    assert_eq!(
        current["name_enc"].as_str().unwrap().len(),
        NAME_ENVELOPE_LEN * 2
    );
    other
        .put(&device_path, device_rename_body(&other, "stolen name"))
        .expect_error(404, "not_found");
    account
        .put(
            &device_path,
            json!({ "name_enc": hex::encode([0u8; NAME_ENVELOPE_LEN - 1]) }),
        )
        .expect_error(400, "bad_request");
    account
        .put(
            &device_path,
            json!({ "name_enc": hex::encode([0u8; NAME_ENVELOPE_LEN]) }),
        )
        .expect_error(400, "bad_request");
    target
        .api
        .put(&device_path, None, device_rename_body(&account, "no token"))
        .expect_error(401, "unauthorized");
}

#[test]
fn device_name_change_rejects_unknown_device_without_leaking_ownership() {
    // П19: a random device id is indistinguishable from another account's device to an
    // authenticated caller; malformed paths and bodies never change any device row.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let mut unknown = [0u8; 16];
    OsRandom.fill(&mut unknown);
    let path = format!("/v1/devices/{}", hex::encode(unknown));
    account
        .put(&path, device_rename_body(&account, "ghost"))
        .expect_error(404, "not_found");
    account
        .put(&path, json!({ "name_enc": "not-hex" }))
        .expect_error(404, "not_found");
}
