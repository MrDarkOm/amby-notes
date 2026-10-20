//! Enrolment, prelogin, login, recovery by code, wrong credentials, throttling (Р5, О3, О8,
//! С12; П11–П17).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use amby_sync_conformance::client::{
    assert_hex, device_json, enroll, enroll_body, enroll_with, limit, login, params_from_json,
    prelogin, recover, unhex, unwrap_ak, Account, PASSWORD,
};
use amby_sync_conformance::http::Body;
use amby_sync_conformance::{in_process_or_skip, Target};
use amby_sync_core::crypto::account::{
    create_account, derive_recovery_keys, unwrap_account_key, Argon2Params,
};
use amby_sync_core::crypto::random::{OsRandom, Random};
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use serde_json::{json, Value};

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    OsRandom.fill(&mut buffer);
    hex::encode(buffer)
}

fn wrong_login(target: &Target, username: &str) -> amby_sync_conformance::Resp {
    target.api.post(
        "/v1/auth/login",
        None,
        json!({
            "username": username,
            "auth_key": random_hex(32),
            "device": { "name_enc": random_hex(105) },
        }),
    )
}

// ---------------------------------------------------------------- enrolment

#[test]
fn enrolment_stores_what_the_device_sent() {
    // Р5, О3, П12, П18: the server keeps both wrapped copies of AK; each opens with its own key
    // and gives the same AK. The first device gets a token and keys_version 1.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let keys = account.get("/v1/keys").expect(200).json();
    assert_eq!(keys["keys_version"], 1);
    assert_eq!(unhex(keys["salt"].as_str().unwrap()), account.salt);
    assert_eq!(params_from_json(&keys["params"]), Argon2Params::V1_DEFAULT);
    let by_password = unwrap_ak(
        PASSWORD,
        &account.salt,
        &account.params,
        keys["wrapped_ak"].as_str().unwrap(),
    );
    assert_eq!(by_password, account.ak);
    let recovery = derive_recovery_keys(&account.recovery_code);
    let by_code = unwrap_account_key(
        &recovery.kek,
        &unhex(keys["wrapped_ak_recovery"].as_str().unwrap()),
    )
    .expect("the recovery copy must open with the recovery key");
    assert_eq!(by_code, account.ak);
}

#[test]
fn enrolment_answers_201_with_the_documented_fields() {
    // П12, П5: device_id (16 bytes), token (32 bytes), keys_version 1.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    let answer = target
        .api
        .post(
            "/v1/auth/enroll",
            None,
            enroll_body(&ticket.username, &ticket.enroll_code, &new, "laptop"),
        )
        .expect(201)
        .json();
    assert_hex(&answer["device_id"], 16, "device_id");
    assert_hex(&answer["token"], 32, "token");
    assert_eq!(answer["keys_version"], 1);
}

#[test]
fn an_enrolment_code_works_once() {
    // П17, Р5: a used code is `invalid_enroll_code`, and the first account stays intact.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let first = enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
    let again = create_account(
        "another long password 99",
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    target
        .api
        .post(
            "/v1/auth/enroll",
            None,
            enroll_body(&ticket.username, &ticket.enroll_code, &again, "thief"),
        )
        .expect_error(401, "invalid_enroll_code");
    // The first device still works and the password is still the first one.
    first.get("/v1/keys").expect(200);
    login(&target.api, &first.username, PASSWORD, &first.ak, "check").expect(200);
}

#[test]
fn a_wrong_or_unknown_enrolment_code_is_refused_the_same_way() {
    // П17: unknown name, wrong code and used code give one answer.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    let wrong_code = target.api.post(
        "/v1/auth/enroll",
        None,
        enroll_body(&ticket.username, "AAAA-AAAA-AAAA-AAAA-AAAA", &new, "d"),
    );
    let unknown_name = target.api.post(
        "/v1/auth/enroll",
        None,
        enroll_body(&target.new_username(), &ticket.enroll_code, &new, "d"),
    );
    wrong_code.clone().expect_error(401, "invalid_enroll_code");
    unknown_name
        .clone()
        .expect_error(401, "invalid_enroll_code");
    assert_eq!(
        wrong_code.json()["error"]["message"],
        unknown_name.json()["error"]["message"]
    );
}

#[test]
fn the_enrolment_code_is_case_and_dash_insensitive() {
    // П17: the code is normalised (upper case, no dashes or spaces) before it is compared.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let typed = ticket.enroll_code.to_lowercase().replace('-', " ");
    enroll_with(&target, &ticket.username, &typed, PASSWORD);
}

#[test]
fn the_enrolment_code_expires_after_24_hours() {
    // П17, П37, Р5: still valid at 23 h 59 min, `enroll_code_expired` at 24 h 01 min.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let early = target.new_ticket();
    let late = target.new_ticket();
    control.advance(Duration::from_secs(24 * 3600 - 60));
    enroll_with(&target, &early.username, &early.enroll_code, PASSWORD);
    control.advance(Duration::from_secs(120));
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    target
        .api
        .post(
            "/v1/auth/enroll",
            None,
            enroll_body(&late.username, &late.enroll_code, &new, "d"),
        )
        .expect_error(401, "enroll_code_expired");
}

#[test]
fn weak_argon2_parameters_are_refused_and_do_not_burn_the_code() {
    // О8, Ф8, П12: parameters below the floor would make guessing the password cheaper.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    for weak in [
        json!({ "memory_kib": 1024, "iterations": 3, "parallelism": 4 }),
        json!({ "memory_kib": 65536, "iterations": 1, "parallelism": 4 }),
        json!({ "memory_kib": 65536, "iterations": 3, "parallelism": 0 }),
        json!({ "memory_kib": 2_000_000, "iterations": 3, "parallelism": 4 }),
    ] {
        let mut body = enroll_body(&ticket.username, &ticket.enroll_code, &new, "d");
        body["params"] = weak;
        target
            .api
            .post("/v1/auth/enroll", None, body)
            .expect_error(400, "bad_request");
    }
    enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
}

#[test]
fn malformed_enrolment_fields_are_refused_and_do_not_burn_the_code() {
    // П2, П12: hex must be lower case and of the right length; the code survives a bad request.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    let good = enroll_body(&ticket.username, &ticket.enroll_code, &new, "d");
    let mut cases: Vec<Value> = Vec::new();
    for (field, value) in [
        ("salt", good["salt"].as_str().unwrap().to_uppercase()),
        ("salt", "ab".repeat(15)),
        ("auth_key", "ab".repeat(31)),
        ("wrapped_ak", "ab".repeat(72)),
        ("wrapped_ak_recovery", "zz".repeat(73)),
        ("recovery_auth_key", "ab".repeat(33)),
    ] {
        let mut body = good.clone();
        body[field] = json!(value);
        cases.push(body);
    }
    let mut no_device = good.clone();
    no_device.as_object_mut().unwrap().remove("device");
    cases.push(no_device);
    for body in cases {
        target
            .api
            .post("/v1/auth/enroll", None, body)
            .expect_error(400, "bad_request");
    }
    enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
}

// ------------------------------------------------------------------ prelogin

#[test]
fn prelogin_returns_the_stored_salt_and_parameters() {
    // П13, Р5: a real user gets the salt and the Argon2id parameters from the enrolment.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = prelogin(&target.api, &account.username).expect(200).json();
    assert_eq!(unhex(answer["salt"].as_str().unwrap()), account.salt);
    assert_eq!(
        params_from_json(&answer["params"]),
        Argon2Params::V1_DEFAULT
    );
}

#[test]
fn prelogin_for_an_unknown_name_gives_a_fake_salt_that_repeats() {
    // П13, Р5: a plausible fake, the same on every call, different for different names.
    let target = Target::from_env();
    let name = target.new_username();
    let first = prelogin(&target.api, &name).expect(200).json();
    let second = prelogin(&target.api, &name).expect(200).json();
    assert_eq!(
        first, second,
        "a repeated question must give the same fake salt"
    );
    assert_hex(&first["salt"], 16, "salt");
    assert_eq!(params_from_json(&first["params"]), Argon2Params::V1_DEFAULT);
    let other = prelogin(&target.api, &target.new_username())
        .expect(200)
        .json();
    assert_ne!(
        first["salt"], other["salt"],
        "different names must get different fakes"
    );
}

#[test]
fn a_fake_salt_looks_like_a_real_one() {
    // П13, О2: same fields, same types, nothing that tells "no such user".
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let real = prelogin(&target.api, &account.username).expect(200).json();
    let fake = prelogin(&target.api, &target.new_username())
        .expect(200)
        .json();
    let keys = |value: &Value| {
        let mut names: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        names.sort();
        names
    };
    assert_eq!(keys(&real), keys(&fake));
    assert_eq!(keys(&real["params"]), keys(&fake["params"]));
    assert_eq!(
        real["salt"].as_str().unwrap().len(),
        fake["salt"].as_str().unwrap().len()
    );
}

#[test]
fn a_fake_salt_survives_a_restart() {
    // П13, П10: the secret behind the fakes is stored, so a restart does not change them.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let name = target.new_username();
    let before = prelogin(&target.api, &name).expect(200).json();
    control.restart();
    let after = prelogin(&target.api, &name).expect(200).json();
    assert_eq!(before, after);
}

#[test]
fn a_user_without_a_password_gets_a_fake_salt_until_enrolment() {
    // П13: no real salt exists before enrolment; the answer is a fake, then the real one.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let before = prelogin(&target.api, &ticket.username).expect(200).json();
    let account = enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
    let after = prelogin(&target.api, &ticket.username).expect(200).json();
    assert_ne!(before["salt"], after["salt"]);
    assert_eq!(unhex(after["salt"].as_str().unwrap()), account.salt);
}

#[test]
fn prelogin_answers_for_any_string_but_refuses_other_types() {
    // П11, П13: an illegal name is just an unknown name; a non-string is a bad request.
    let target = Target::from_env();
    for name in ["Alice", "", "has space", &"x".repeat(200)] {
        prelogin(&target.api, name).expect(200);
    }
    target
        .api
        .post("/v1/auth/prelogin", None, json!({ "username": 5 }))
        .expect_error(400, "bad_request");
    target
        .api
        .post("/v1/auth/prelogin", None, json!({}))
        .expect_error(400, "bad_request");
}

// --------------------------------------------------------------------- login

#[test]
fn the_right_password_gives_a_token_and_the_wrapped_key() {
    // П14, Р5, О3: login → token of a new device → AK opens with the password.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let answer = login(&target.api, &first.username, PASSWORD, &first.ak, "second")
        .expect(200)
        .json();
    assert_hex(&answer["token"], 32, "token");
    assert_hex(&answer["device_id"], 16, "device_id");
    assert_ne!(
        answer["token"].as_str().unwrap(),
        first.token,
        "a new device gets a new token"
    );
    assert_ne!(answer["device_id"].as_str().unwrap(), first.device_id);
    assert_eq!(answer["keys_version"], 1);
    assert_eq!(unhex(answer["salt"].as_str().unwrap()), first.salt);
    let ak = unwrap_ak(
        PASSWORD,
        &first.salt,
        &first.params,
        answer["wrapped_ak"].as_str().unwrap(),
    );
    assert_eq!(ak, first.ak);
}

#[test]
fn a_wrong_password_gives_no_token() {
    // С12, П14, П15: 401 invalid_credentials, no token in the answer, and no device is created.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = login(
        &target.api,
        &account.username,
        "a completely different pass",
        &account.ak,
        "x",
    );
    let answer = answer.expect_error(401, "invalid_credentials");
    assert!(
        !answer.text().contains("token\":\""),
        "no token may be in the answer: {}",
        answer.text()
    );
    assert!(answer.json().get("token").is_none());
    let devices = account.get("/v1/devices").expect(200).json();
    assert_eq!(
        devices["devices"].as_array().unwrap().len(),
        1,
        "a refused login makes no device"
    );
}

#[test]
fn an_unknown_name_looks_exactly_like_a_wrong_password() {
    // П15, О2: same status, code and message; also for a name without a password.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let waiting = target.new_ticket();
    let wrong_password = login(
        &target.api,
        &account.username,
        "wrong wrong wrong 123",
        &account.ak,
        "x",
    );
    let unknown = wrong_login(&target, &target.new_username());
    let no_password = wrong_login(&target, &waiting.username);
    for answer in [&wrong_password, &unknown, &no_password] {
        assert_eq!(answer.status, 401);
        assert_eq!(answer.error_code().as_deref(), Some("invalid_credentials"));
    }
    let message = wrong_password.json()["error"]["message"].clone();
    assert_eq!(unknown.json()["error"]["message"], message);
    assert_eq!(no_password.json()["error"]["message"], message);
    assert_eq!(
        wrong_password.json(),
        unknown.json(),
        "the bodies must be identical"
    );
}

#[test]
fn the_password_key_and_the_recovery_key_are_not_interchangeable() {
    // Р5, Ф10: the recovery key does not log in, and the password key does not recover.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let recovery_key = hex::encode(account.recovery_auth_key.as_bytes());
    let password_key = hex::encode(account.password_auth_key().as_bytes());
    target
        .api
        .post(
            "/v1/auth/login",
            None,
            json!({ "username": account.username, "auth_key": recovery_key,
                    "device": { "name_enc": random_hex(105) } }),
        )
        .expect_error(401, "invalid_credentials");
    target
        .api
        .post(
            "/v1/auth/recover",
            None,
            json!({ "username": account.username, "recovery_auth_key": password_key,
                    "device": { "name_enc": random_hex(105) } }),
        )
        .expect_error(401, "invalid_credentials");
}

// ------------------------------------------------------------------- recover

#[test]
fn the_recovery_code_gives_a_token_and_the_recovery_copy_of_the_key() {
    // П15, О3, Р5: the code alone is enough to get in and to open AK.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let answer = recover(
        &target.api,
        &account.username,
        &account.recovery_code,
        &account.ak,
        "restored",
    )
    .expect(200)
    .json();
    assert_hex(&answer["token"], 32, "token");
    assert_hex(&answer["device_id"], 16, "device_id");
    let recovery = derive_recovery_keys(&account.recovery_code);
    let ak = unwrap_account_key(
        &recovery.kek,
        &unhex(answer["wrapped_ak_recovery"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(ak, account.ak);
}

#[test]
fn a_wrong_recovery_code_gives_no_token() {
    // П15, С12, О3: another code is `invalid_credentials`, no token.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let other = RecoveryCode::generate(&mut OsRandom);
    let answer = recover(&target.api, &account.username, &other, &account.ak, "x")
        .expect_error(401, "invalid_credentials");
    assert!(answer.json().get("token").is_none());
}

// ---------------------------------------------------------------- throttling

#[test]
fn too_many_wrong_passwords_lock_the_name_even_for_the_right_one() {
    // П16, Р11, О8: after N failures the next try is 429 with Retry-After, whoever sends it.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for attempt in 0..max {
        let answer = wrong_login(&target, &account.username);
        assert!(
            answer.status == 401 && answer.error_code().as_deref() == Some("invalid_credentials"),
            "attempt {attempt}: expected 401 invalid_credentials, got HTTP {} {}",
            answer.status,
            answer.text()
        );
    }
    let locked = login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "right password",
    )
    .expect_error(429, "rate_limited");
    let retry: u64 = locked
        .header("retry-after")
        .and_then(|value| value.parse().ok())
        .expect("429 needs a numeric Retry-After");
    assert!(retry > 0 && retry <= limit(&target.api, "login_window_secs"));
}

#[test]
fn unknown_names_are_throttled_exactly_like_real_ones() {
    // П16, П15: a lock must not reveal whether the name exists.
    let target = Target::from_env();
    let name = target.new_username();
    let max = limit(&target.api, "login_max_failures");
    for _ in 0..max {
        wrong_login(&target, &name).expect_error(401, "invalid_credentials");
    }
    wrong_login(&target, &name).expect_error(429, "rate_limited");
}

#[test]
fn the_lock_ends_when_the_window_has_passed() {
    // П16, П37: still locked a little before the window ends, free a little after.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    let window = limit(&target.api, "login_window_secs");
    for _ in 0..max {
        wrong_login(&target, &account.username).expect_error(401, "invalid_credentials");
    }
    control.advance(Duration::from_secs(window - 30));
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "early",
    )
    .expect_error(429, "rate_limited");
    control.advance(Duration::from_secs(60));
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "late",
    )
    .expect(200);
}

#[test]
fn failures_older_than_the_window_are_forgotten() {
    // П16, П37: slow guessing is not locked out.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let name = target.new_username();
    let max = limit(&target.api, "login_max_failures");
    let window = limit(&target.api, "login_window_secs");
    for _ in 0..max - 1 {
        wrong_login(&target, &name).expect_error(401, "invalid_credentials");
    }
    control.advance(Duration::from_secs(window + 60));
    for _ in 0..max - 1 {
        wrong_login(&target, &name).expect_error(401, "invalid_credentials");
    }
}

#[test]
fn a_success_clears_the_count() {
    // П16: N-1 failures, a good login, then N-1 more failures: still not locked.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for _ in 0..max - 1 {
        wrong_login(&target, &account.username).expect_error(401, "invalid_credentials");
    }
    login(&target.api, &account.username, PASSWORD, &account.ak, "ok").expect(200);
    for _ in 0..max - 1 {
        wrong_login(&target, &account.username).expect_error(401, "invalid_credentials");
    }
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "ok again",
    )
    .expect(200);
}

#[test]
fn login_and_recovery_failures_share_one_count() {
    // П16: guessing the recovery code is as limited as guessing the password.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for attempt in 0..max {
        if attempt % 2 == 0 {
            wrong_login(&target, &account.username).expect_error(401, "invalid_credentials");
        } else {
            recover(
                &target.api,
                &account.username,
                &RecoveryCode::generate(&mut OsRandom),
                &account.ak,
                "x",
            )
            .expect_error(401, "invalid_credentials");
        }
    }
    recover(
        &target.api,
        &account.username,
        &account.recovery_code,
        &account.ak,
        "right",
    )
    .expect_error(429, "rate_limited");
}

#[test]
fn wrong_enrolment_codes_are_throttled_too() {
    // П16, П17: the one-time code cannot be guessed at leisure either.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let max = limit(&target.api, "login_max_failures");
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    for _ in 0..max {
        target
            .api
            .post(
                "/v1/auth/enroll",
                None,
                enroll_body(&ticket.username, "AAAA-AAAA-AAAA-AAAA-AAAA", &new, "d"),
            )
            .expect_error(401, "invalid_enroll_code");
    }
    target
        .api
        .post(
            "/v1/auth/enroll",
            None,
            enroll_body(&ticket.username, &ticket.enroll_code, &new, "d"),
        )
        .expect_error(429, "rate_limited");
}

#[test]
fn prelogin_is_not_a_login_attempt() {
    // П13, П16: asking for the salt any number of times locks nothing.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for _ in 0..max * 3 {
        prelogin(&target.api, &account.username).expect(200);
    }
    login(&target.api, &account.username, PASSWORD, &account.ak, "ok").expect(200);
}

// ------------------------------------- two counters: per name and address, per name (П16)

fn from_ip(target: &Target, path: &str, body: Value, ip: &str) -> amby_sync_conformance::Resp {
    target.api.send(
        "POST",
        path,
        None,
        &[("X-Forwarded-For", ip)],
        Body::Json(body),
    )
}

fn wrong_login_from(target: &Target, username: &str, ip: &str) -> amby_sync_conformance::Resp {
    from_ip(
        target,
        "/v1/auth/login",
        json!({ "username": username, "auth_key": random_hex(32),
                "device": { "name_enc": random_hex(105) } }),
        ip,
    )
}

fn right_login_from(target: &Target, account: &Account, ip: &str) -> amby_sync_conformance::Resp {
    from_ip(
        target,
        "/v1/auth/login",
        json!({ "username": account.username,
                "auth_key": hex::encode(account.password_auth_key().as_bytes()),
                "device": device_json(&account.ak, "from elsewhere") }),
        ip,
    )
}

#[test]
fn an_attacker_at_one_address_does_not_lock_the_owner_at_another() {
    // П16, О8: the strict counter is per name and address (with a trusted proxy header).
    let target = Target::in_process_with(|config| config.trust_proxy = true);
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for _ in 0..max {
        wrong_login_from(&target, &account.username, "203.0.113.7")
            .expect_error(401, "invalid_credentials");
    }
    wrong_login_from(&target, &account.username, "203.0.113.7").expect_error(429, "rate_limited");
    right_login_from(&target, &account, "198.51.100.20").expect(200);
}

#[test]
fn the_soft_counter_per_name_works_across_addresses() {
    // П16: guessing from many addresses is still stopped, by the looser counter for the name.
    let target = Target::in_process_with(|config| {
        config.trust_proxy = true;
        config.login_max_failures_per_user = 8;
    });
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    for n in 0..8 {
        let ip = format!("192.0.2.{}", n + 1);
        wrong_login_from(&target, &account.username, &ip).expect_error(401, "invalid_credentials");
    }
    // A fresh address, the right password, and still locked: the name has had enough.
    right_login_from(&target, &account, "192.0.2.200").expect_error(429, "rate_limited");
}

#[test]
fn the_forwarded_header_is_ignored_without_trust_in_the_proxy() {
    // П16: without AMBY_SYNC_TRUST_PROXY every request has the address of the socket, so changing
    // the header does not buy more attempts.
    let target = Target::in_process();
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for n in 0..max {
        wrong_login_from(&target, &account.username, &format!("192.0.2.{}", n + 1))
            .expect_error(401, "invalid_credentials");
    }
    right_login_from(&target, &account, "192.0.2.250").expect_error(429, "rate_limited");
}

#[test]
fn the_last_forwarded_address_counts() {
    // П16: with a trusted proxy the last address of the list is the client's; the ones before it
    // are what the client claimed and are ignored.
    let target = Target::in_process_with(|config| config.trust_proxy = true);
    let _ = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for n in 0..max {
        let claimed = format!("10.9.9.{}, 203.0.113.50", n + 1);
        wrong_login_from(&target, &account.username, &claimed)
            .expect_error(401, "invalid_credentials");
    }
    wrong_login_from(&target, &account.username, "1.2.3.4, 203.0.113.50")
        .expect_error(429, "rate_limited");
}

#[test]
fn a_lock_does_not_touch_devices_that_already_have_a_token() {
    // П16, П5: the lock is about signing in; a connected device keeps working.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let max = limit(&target.api, "login_max_failures");
    for _ in 0..max {
        wrong_login(&target, &account.username).expect_error(401, "invalid_credentials");
    }
    login(&target.api, &account.username, PASSWORD, &account.ak, "x")
        .expect_error(429, "rate_limited");
    account.get("/v1/keys").expect(200);
    account.get("/v1/devices").expect(200);
}

// ------------------------------------------------------ name envelopes of 105 bytes (Ф34)

#[test]
fn name_envelopes_must_be_exactly_105_bytes() {
    // П12, П14, П15, П20, Ф34: a device name that is not 105 bytes is `bad_request`; an enrolment
    // that was refused for it does not burn the code.
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    for bytes in [0usize, 1, 104, 106, 200] {
        let mut body = enroll_body(&ticket.username, &ticket.enroll_code, &new, "d");
        body["device"]["name_enc"] = json!(random_hex(bytes));
        target
            .api
            .post("/v1/auth/enroll", None, body)
            .expect_error(400, "bad_request");
    }
    let account = enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
    for bytes in [104usize, 106] {
        target
            .api
            .post(
                "/v1/auth/login",
                None,
                json!({ "username": account.username,
                        "auth_key": hex::encode(account.password_auth_key().as_bytes()),
                        "device": { "name_enc": random_hex(bytes) } }),
            )
            .expect_error(400, "bad_request");
        target
            .api
            .post(
                "/v1/auth/recover",
                None,
                json!({ "username": account.username,
                        "recovery_auth_key": hex::encode(account.recovery_auth_key.as_bytes()),
                        "device": { "name_enc": random_hex(bytes) } }),
            )
            .expect_error(400, "bad_request");
    }
    // A name of exactly 105 bytes is fine, whatever is inside: the server cannot look.
    target
        .api
        .post(
            "/v1/auth/login",
            None,
            json!({ "username": account.username,
                    "auth_key": hex::encode(account.password_auth_key().as_bytes()),
                    "device": { "name_enc": random_hex(105) } }),
        )
        .expect(200);
}
