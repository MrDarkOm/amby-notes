//! The administrator commands as the suite sees them: `user add` (П38, П17, П11).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{enroll, enroll_with, info, PASSWORD};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::account::{create_account, Argon2Params};
use amby_sync_core::crypto::random::OsRandom;

#[test]
fn user_add_gives_a_one_time_code_for_24_hours() {
    // П38, П17, Р5: a code in Crockford base32, 20 symbols in groups of 4, valid for 24 hours.
    let target = Target::from_env();
    let now = info(&target.api)["time_ms"].as_i64().unwrap();
    let ticket = target.new_ticket();
    assert_eq!(
        ticket.username.len(),
        13,
        "the name is the one that was asked for"
    );
    let groups: Vec<&str> = ticket.enroll_code.split('-').collect();
    assert_eq!(
        groups.len(),
        5,
        "XXXX-XXXX-XXXX-XXXX-XXXX: {}",
        ticket.enroll_code
    );
    for group in groups {
        assert_eq!(group.len(), 4);
        assert!(
            group
                .chars()
                .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c)),
            "the code uses the Crockford alphabet: {}",
            ticket.enroll_code
        );
    }
    let day_ms = 24 * 60 * 60 * 1000;
    let lifetime = ticket.expires_ms - now;
    assert!(
        (day_ms - 120_000..=day_ms + 120_000).contains(&lifetime),
        "the code lives 24 hours, got {lifetime} ms"
    );
}

#[test]
fn two_codes_are_different() {
    // П17: 100 random bits; a repeated code would be a broken generator.
    let target = Target::from_env();
    let first = target.new_ticket();
    let second = target.new_ticket();
    assert_ne!(first.enroll_code, second.enroll_code);
}

#[test]
fn user_add_rejects_bad_names_with_exit_code_2() {
    // П11, П38: ASCII lower case, digits, dot, underscore, dash; 1–64 characters; letter or
    // digit at both ends.
    let target = Target::from_env();
    let too_long = "a".repeat(65);
    for name in [
        "Alice",
        "",
        "a b",
        too_long.as_str(),
        "-a",
        "a-",
        "é",
        ".a",
        "a/b",
    ] {
        match target.try_user_add(name) {
            Err(failure) => assert_eq!(
                failure.exit_code,
                Some(2),
                "`{name}` must be refused with exit code 2: {}",
                failure.message
            ),
            Ok(_) => panic!("the name `{name}` must be refused"),
        }
    }
}

#[test]
fn user_add_accepts_the_edge_names() {
    // П11: the shortest and the longest legal names.
    let target = Target::from_env();
    let mut tail = [0u8; 4];
    amby_sync_core::crypto::random::Random::fill(&mut OsRandom, &mut tail);
    let longest = format!("{}{}", "a".repeat(56), hex::encode(tail));
    assert_eq!(longest.len(), 64);
    let dotted = format!("a.b_c-{}", hex::encode(tail));
    for name in [longest, dotted] {
        target
            .try_user_add(&name)
            .unwrap_or_else(|failure| panic!("`{name}` must be accepted: {}", failure.message));
    }
}

#[test]
fn a_second_user_add_burns_the_first_code() {
    // П17, П38: for a name without a password a new code replaces the old one.
    let target = Target::from_env();
    let first = target.new_ticket();
    let second = target
        .try_user_add(&first.username)
        .expect("a new code for a waiting user");
    assert_ne!(first.enroll_code, second.enroll_code);
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    let body = amby_sync_conformance::client::enroll_body(
        &first.username,
        &first.enroll_code,
        &new,
        "device",
    );
    target
        .api
        .post("/v1/auth/enroll", None, body)
        .expect_error(401, "invalid_enroll_code");
    enroll_with(&target, &second.username, &second.enroll_code, PASSWORD);
}

#[test]
fn user_add_for_a_user_with_a_password_fails_with_exit_code_3() {
    // П17, П38: the account exists; its owner has a password.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    match target.try_user_add(&account.username) {
        Err(failure) => assert_eq!(failure.exit_code, Some(3), "{}", failure.message),
        Ok(_) => panic!("a user with a password must not get a new code"),
    }
}

#[test]
fn a_removed_user_loses_the_tokens_and_the_name_can_be_made_again() {
    // П38, П6, Р5: old tokens are `unauthorized` (they no longer exist), sign-in looks like an
    // unknown name, and `user add` for the same name makes a new, empty user.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    space.commit_ok(&[space.folder(&amby_sync_conformance::client::new_item(), 0, "Docs")]);
    target
        .admin
        .user_remove(&account.username)
        .unwrap_or_else(|failure| panic!("user remove failed: {}", failure.message));
    account.get("/v1/keys").expect_error(401, "unauthorized");
    account.get("/v1/spaces").expect_error(401, "unauthorized");
    amby_sync_conformance::client::login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "x",
    )
    .expect_error(401, "invalid_credentials");

    let ticket = target
        .try_user_add(&account.username)
        .expect("the name can be made again");
    let again = enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
    assert!(again.get("/v1/spaces").expect(200).json()["spaces"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_ne!(again.token, account.token);
    account.get("/v1/keys").expect_error(401, "unauthorized");
}
