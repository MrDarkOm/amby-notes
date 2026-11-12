//! ASCII case folding for account usernames (П11, П13–П17, Рег2).
//!
//! Usernames remain ASCII-only and use the existing grammar. Before validation and lookup, ASCII
//! uppercase letters are folded to lowercase; Unicode case folding is intentionally not involved.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{
    enroll, enroll_body, enroll_with, limit, login, prelogin, recover, PASSWORD,
};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::account::{create_account, Argon2Params};
use amby_sync_core::crypto::random::OsRandom;
use serde_json::{json, Value};

fn fold_some_ascii(name: &str) -> String {
    name.chars()
        .enumerate()
        .map(|(index, character)| {
            if index % 2 == 0 {
                character.to_ascii_uppercase()
            } else {
                character
            }
        })
        .collect()
}

fn open_enroll_body(username: &str, new: &amby_sync_core::crypto::account::NewAccount) -> Value {
    enroll_body(username, "", new, "first device")
}

#[test]
fn mixed_case_login_and_prelogin_use_the_same_canonical_account() {
    // П11, П13–П14: mixed-case and lowercase prelogin return the same salt and parameters, and
    // both spellings authenticate to the same account key.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let mixed = fold_some_ascii(&account.username);
    let lower = prelogin(&target.api, &account.username).expect(200).json();
    let folded = prelogin(&target.api, &mixed).expect(200).json();
    assert_eq!(folded["salt"], lower["salt"]);
    assert_eq!(folded["params"], lower["params"]);
    login(&target.api, &mixed, PASSWORD, &account.ak, "mixed case").expect(200);
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "lower case",
    )
    .expect(200);
}

#[test]
fn mixed_case_recovery_uses_the_same_account_key() {
    // П15: recovery accepts the same case variants and returns a device for the existing AK.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let mixed = fold_some_ascii(&account.username);
    let recovered = recover(
        &target.api,
        &mixed,
        &account.recovery_code,
        &account.ak,
        "recovered mixed case",
    )
    .expect(200)
    .json();
    target
        .api
        .get(
            "/v1/keys",
            Some(recovered["token"].as_str().expect("recovery token")),
        )
        .expect(200);
}

#[test]
fn failed_logins_share_a_throttle_bucket_across_ascii_case() {
    // П16: casing is normalization, not an account or throttle-bucket distinction.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let mixed = fold_some_ascii(&account.username);
    let max = limit(&target.api, "login_max_failures");
    for _ in 0..max {
        target
            .api
            .post(
                "/v1/auth/login",
                None,
                json!({
                    "username": mixed.clone(),
                    "auth_key": hex::encode([7u8; 32]),
                    "device": { "name_enc": hex::encode([0u8; 105]) },
                }),
            )
            .expect_error(401, "invalid_credentials");
    }
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "after failures",
    )
    .expect_error(429, "rate_limited");
}

#[test]
fn open_registration_folds_mixed_case_and_reserves_the_lowercase_variant() {
    // Э2б, П11–П12: public registration stores the canonical lowercase name; a second request
    // using the case variant is the ordinary reserved-name conflict.
    let target = Target::in_process_with(|config| config.open_registration = true);
    let mixed = "MiXeD-Case";
    let first = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    let answer = target
        .api
        .post("/v1/auth/enroll", None, open_enroll_body(mixed, &first))
        .expect(201)
        .json();
    let token = answer["token"].as_str().expect("registration token");
    target.api.get("/v1/keys", Some(token)).expect(200);
    let duplicate = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    target
        .api
        .post(
            "/v1/auth/enroll",
            None,
            open_enroll_body("mixed-case", &duplicate),
        )
        .expect_error(409, "registration_unavailable");
    let account = login(
        &target.api,
        "MIXED-CASE",
        PASSWORD,
        &first.account_key,
        "case login",
    )
    .expect(200)
    .json();
    target
        .api
        .get("/v1/keys", Some(account["token"].as_str().unwrap()))
        .expect(200);
}

#[test]
fn invitation_registration_folds_mixed_case_before_reserved_name_lookup() {
    // Рег2, П17: an invitation created for a lowercase name can be redeemed with mixed ASCII
    // case, and the resulting account is still reachable by the lowercase spelling.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let mixed = fold_some_ascii(&ticket.username);
    let account = enroll_with(&target, &mixed, &ticket.enroll_code, PASSWORD);
    login(
        &target.api,
        &ticket.username,
        PASSWORD,
        &account.ak,
        "lower after invite",
    )
    .expect(200);
}

#[test]
fn rename_folds_target_and_base_and_rejects_case_collisions() {
    // Identity endpoint contract: mixed target/base names are canonicalized before CAS and
    // uniqueness checks; a second account cannot claim a case variant.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let other = enroll(&target, PASSWORD);
    let old = account.username.clone();
    let mixed_target = fold_some_ascii(&target.new_username());
    account
        .put(
            "/v1/account/username",
            json!({
                "username": mixed_target,
                "base_username": fold_some_ascii(&old),
                "auth_key": hex::encode(account.password_auth_key().as_bytes()),
            }),
        )
        .expect(204);
    assert_eq!(
        account.get("/v1/account/username").expect(200).json()["username"],
        mixed_target.to_ascii_lowercase()
    );
    account
        .put(
            "/v1/account/username",
            json!({
                "username": fold_some_ascii(&other.username),
                "base_username": mixed_target.to_ascii_uppercase(),
                "auth_key": hex::encode(account.password_auth_key().as_bytes()),
            }),
        )
        .expect_error(409, "username_taken");
}
