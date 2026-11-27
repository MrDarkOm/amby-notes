//! Replacing the keys: password change, recovery by code, compare-and-swap on the keys
//! version (Р5, О3, Р3; П18).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{
    enroll, keys_put_body, login, new_item, recover, unhex, unwrap_ak, PASSWORD,
};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::account::{
    change_password, derive_recovery_keys, reset_password, wrap_account_key, Argon2Params,
};
use amby_sync_core::crypto::random::{OsRandom, Random};
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use serde_json::json;

const NEW_PASSWORD: &str = "the brand new password 2026";

#[test]
fn a_password_change_needs_the_old_password_as_proof() {
    // Р5, П18: with the right proof the new envelope is stored; AK is the same, the old password
    // stops working, the new one works, and the other device keeps its token.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let second = first.another_device("second");
    let keys = first.get("/v1/keys").expect(200).json();
    let (ak, envelope) = change_password(
        PASSWORD,
        &first.salt,
        &first.params,
        &unhex(keys["wrapped_ak"].as_str().unwrap()),
        NEW_PASSWORD,
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    assert_eq!(ak, first.ak);
    let body = keys_put_body(1, "password", &first.password_auth_key(), &envelope);
    let answer = first.put("/v1/keys", body).expect(200).json();
    assert_eq!(answer["keys_version"], 2);
    // The old password is gone, the new one works and still opens the same AK.
    login(&target.api, &first.username, PASSWORD, &first.ak, "old")
        .expect_error(401, "invalid_credentials");
    let fresh = login(&target.api, &first.username, NEW_PASSWORD, &first.ak, "new")
        .expect(200)
        .json();
    assert_eq!(fresh["keys_version"], 2);
    let opened = unwrap_ak(
        NEW_PASSWORD,
        &unhex(fresh["salt"].as_str().unwrap()).try_into().unwrap(),
        &Argon2Params::V1_DEFAULT,
        fresh["wrapped_ak"].as_str().unwrap(),
    );
    assert_eq!(opened, first.ak);
    // Р5: the other devices keep working.
    second.get("/v1/keys").expect(200);
    first.get("/v1/keys").expect(200);
}

#[test]
fn a_password_change_with_a_wrong_proof_is_refused() {
    // П18, П16, Р5: 403 invalid_proof; nothing changed.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let keys = account.get("/v1/keys").expect(200).json();
    let (_, envelope) = change_password(
        PASSWORD,
        &account.salt,
        &account.params,
        &unhex(keys["wrapped_ak"].as_str().unwrap()),
        NEW_PASSWORD,
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    let mut wrong = [0u8; 32];
    OsRandom.fill(&mut wrong);
    let proof = amby_sync_core::crypto::keys::AuthKey::from_bytes(wrong);
    account
        .put("/v1/keys", keys_put_body(1, "password", &proof, &envelope))
        .expect_error(403, "invalid_proof");
    assert_eq!(
        account.get("/v1/keys").expect(200).json()["keys_version"],
        1
    );
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "still the old one",
    )
    .expect(200);
}

#[test]
fn the_recovery_proof_is_not_the_password_proof() {
    // П18, Р5: kind `recovery` must carry the recovery key, and `password` the password key.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let keys = account.get("/v1/keys").expect(200).json();
    let (_, envelope) = reset_password(
        &account.recovery_code,
        &unhex(keys["wrapped_ak_recovery"].as_str().unwrap()),
        NEW_PASSWORD,
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    account
        .put(
            "/v1/keys",
            keys_put_body(1, "password", &account.recovery_auth_key, &envelope),
        )
        .expect_error(403, "invalid_proof");
    account
        .put(
            "/v1/keys",
            keys_put_body(1, "recovery", &account.password_auth_key(), &envelope),
        )
        .expect_error(403, "invalid_proof");
}

#[test]
fn a_stale_keys_version_is_a_conflict() {
    // П18, Р3: two devices start from version 1; the first wins, the second gets keys_conflict
    // and the current version.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let other = account.another_device("other");
    let keys = account.get("/v1/keys").expect(200).json();
    let wrapped = unhex(keys["wrapped_ak_recovery"].as_str().unwrap());
    let make = |password: &str| {
        reset_password(
            &account.recovery_code,
            &wrapped,
            password,
            &Argon2Params::V1_DEFAULT,
            &mut OsRandom,
        )
        .unwrap()
        .1
    };
    let first = keys_put_body(
        1,
        "recovery",
        &account.recovery_auth_key,
        &make("first new password 1"),
    );
    let second = keys_put_body(
        1,
        "recovery",
        &account.recovery_auth_key,
        &make("second new password 2"),
    );
    assert_eq!(
        account.put("/v1/keys", first).expect(200).json()["keys_version"],
        2
    );
    let refused = other
        .put("/v1/keys", second)
        .expect_error(409, "keys_conflict");
    assert_eq!(refused.details()["keys_version"], 2);
    // The winner's password is the one that works.
    login(
        &target.api,
        &account.username,
        "first new password 1",
        &account.ak,
        "x",
    )
    .expect(200);
    login(
        &target.api,
        &account.username,
        "second new password 2",
        &account.ak,
        "x",
    )
    .expect_error(401, "invalid_credentials");
}

#[test]
fn forgetting_the_password_loses_nothing() {
    // О3, Р5, П15, П18: recover by code → new password by compare-and-swap → log in with it →
    // the data written before is still readable with the same AK.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    let content = b"written before the password was lost\r\n";
    let prepared = space.file(&item, 0, "Notes/before.md", content);
    space.commit_ok(&[prepared]);

    let session = recover(
        &target.api,
        &account.username,
        &account.recovery_code,
        &account.ak,
        "restored",
    )
    .expect(200)
    .json();
    let token = session["token"].as_str().unwrap().to_string();
    let keys = target.api.get("/v1/keys", Some(&token)).expect(200).json();
    let (ak, envelope) = reset_password(
        &account.recovery_code,
        &unhex(keys["wrapped_ak_recovery"].as_str().unwrap()),
        NEW_PASSWORD,
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    assert_eq!(ak, account.ak, "the code opens the same account key");
    let body = keys_put_body(
        keys["keys_version"].as_u64().unwrap(),
        "recovery",
        &account.recovery_auth_key,
        &envelope,
    );
    target.api.put("/v1/keys", Some(&token), body).expect(200);

    let login_answer = login(
        &target.api,
        &account.username,
        NEW_PASSWORD,
        &account.ak,
        "new device",
    )
    .expect(200)
    .json();
    let ak_now = unwrap_ak(
        NEW_PASSWORD,
        &unhex(login_answer["salt"].as_str().unwrap())
            .try_into()
            .unwrap(),
        &Argon2Params::V1_DEFAULT,
        login_answer["wrapped_ak"].as_str().unwrap(),
    );
    let device = space.with_token(login_answer["token"].as_str().unwrap());
    let change = device.all_changes(0).remove(0);
    assert_eq!(ak_now, account.ak);
    assert_eq!(device.fetch_file(&change), content);
}

#[test]
fn the_recovery_code_can_be_replaced_together_with_the_password() {
    // П18, О3: a new code replaces the old one; only the new one recovers afterwards.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let keys = account.get("/v1/keys").expect(200).json();
    let (_, envelope) = change_password(
        PASSWORD,
        &account.salt,
        &account.params,
        &unhex(keys["wrapped_ak"].as_str().unwrap()),
        PASSWORD,
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    let new_code = RecoveryCode::generate(&mut OsRandom);
    let new_keys = derive_recovery_keys(&new_code);
    let mut body = keys_put_body(1, "password", &account.password_auth_key(), &envelope);
    body["recovery_auth_key"] = json!(hex::encode(new_keys.auth_key.as_bytes()));
    body["wrapped_ak_recovery"] = json!(hex::encode(wrap_account_key(
        &new_keys.kek,
        &account.ak,
        &mut OsRandom
    )));
    account.put("/v1/keys", body).expect(200);
    recover(
        &target.api,
        &account.username,
        &account.recovery_code,
        &account.ak,
        "old code",
    )
    .expect_error(401, "invalid_credentials");
    recover(
        &target.api,
        &account.username,
        &new_code,
        &account.ak,
        "new code",
    )
    .expect(200);
}

#[test]
fn half_a_recovery_pair_is_refused() {
    // П18: the two recovery fields come together or not at all.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let keys = account.get("/v1/keys").expect(200).json();
    let (_, envelope) = change_password(
        PASSWORD,
        &account.salt,
        &account.params,
        &unhex(keys["wrapped_ak"].as_str().unwrap()),
        PASSWORD,
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    let mut body = keys_put_body(1, "password", &account.password_auth_key(), &envelope);
    body["recovery_auth_key"] = json!(hex::encode([7u8; 32]));
    account
        .put("/v1/keys", body)
        .expect_error(400, "bad_request");
}

#[test]
fn weak_parameters_in_a_key_replacement_are_refused() {
    // О8, Ф8, П18: the same floor as at enrolment.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let keys = account.get("/v1/keys").expect(200).json();
    let (_, envelope) = change_password(
        PASSWORD,
        &account.salt,
        &account.params,
        &unhex(keys["wrapped_ak"].as_str().unwrap()),
        NEW_PASSWORD,
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    let mut body = keys_put_body(1, "password", &account.password_auth_key(), &envelope);
    body["params"] = json!({ "memory_kib": 4096, "iterations": 1, "parallelism": 1 });
    account
        .put("/v1/keys", body)
        .expect_error(400, "bad_request");
}
