//! The flows of the application against the real server in the process: create an account,
//! sign in on a new device, recover a forgotten password, disconnect (Р5, О1, О3, О8; П11–П19).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::path::Path;

use amby_sync_client::{
    disconnect_device, enroll_prepared, list_devices, prepare_account, recover_account, sign_in,
    validate_username,
};
use amby_sync_conformance::in_process_or_skip;
use amby_sync_conformance::Target;
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use common::{client_of, Canned, FakeServer, PASSWORD};

/// Creates an account on the first device, the way the application does after the person has
/// seen the recovery code.
async fn first_device(target: &Target) -> (String, amby_sync_client::Connected, RecoveryCode) {
    let ticket = target.new_ticket();
    let prepared = prepare_account(&ticket.username, &ticket.enroll_code, PASSWORD)
        .await
        .unwrap();
    let code = prepared.recovery_code().clone();
    let connected = enroll_prepared(&client_of(target), &prepared, "Mac A")
        .await
        .unwrap();
    (ticket.username, connected, code)
}

fn names(devices: &[amby_sync_client::Device]) -> Vec<Option<&str>> {
    devices
        .iter()
        .map(|device| device.name.as_deref())
        .collect()
}

#[test]
fn a_user_name_is_checked_as_the_server_does() {
    // П11
    for good in [
        "a",
        "alice",
        "a.b_c-d",
        "user01",
        "0",
        "a".repeat(64).as_str(),
    ] {
        assert!(validate_username(good), "{good}");
    }
    for bad in [
        "",
        "Alice",
        "-alice",
        "alice-",
        ".a",
        "a.",
        "_a",
        "a b",
        "аня",
        "a@b",
        "a/b",
        "a\0",
        &"a".repeat(65),
    ] {
        assert!(!validate_username(bad), "{bad:?}");
    }
}

#[tokio::test]
async fn an_account_is_made_on_the_device_and_the_first_device_is_named() {
    // Р5, О3, П12, Ф34
    let target = Target::from_env();
    let (_, connected, code) = first_device(&target).await;
    let client = client_of(&target);
    let devices = list_devices(&client, &connected.session.token, &connected.account_key)
        .await
        .unwrap();
    assert_eq!(names(&devices), vec![Some("Mac A")]);
    assert!(devices[0].current);
    assert_eq!(devices[0].device_id, connected.session.device_id);
    // The code is a real code: 14 groups that read back.
    let shown = code.to_display();
    assert_eq!(shown.split('-').count(), 14);
    assert_eq!(RecoveryCode::parse(&shown).unwrap(), code);
}

#[tokio::test]
async fn nothing_is_sent_until_the_prepared_account_is_enrolled() {
    // Р5: the server holds no account whose code nobody has seen
    let server = FakeServer::start(|_| Canned::json(500, "{}")).await;
    let prepared = prepare_account("alice", "AAAA-BBBB-CCCC-DDDD-EEEE", PASSWORD)
        .await
        .unwrap();
    assert_eq!(prepared.username(), "alice");
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn a_user_name_the_server_would_refuse_is_refused_at_once() {
    // П11
    let error = prepare_account("Alice", "AAAA-BBBB-CCCC-DDDD-EEEE", PASSWORD)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_username");
}

#[tokio::test]
async fn the_enroll_code_may_be_typed_the_way_people_type() {
    // П17: capitals and dashes are the server's form; people add spaces and use small letters
    let target = Target::from_env();
    let ticket = target.new_ticket();
    let typed = ticket.enroll_code.to_lowercase().replace('-', " ");
    let prepared = prepare_account(&ticket.username, &format!("  {typed} "), PASSWORD)
        .await
        .unwrap();
    enroll_prepared(&client_of(&target), &prepared, "Mac A")
        .await
        .unwrap();
}

#[tokio::test]
async fn a_wrong_used_or_old_enroll_code_is_told_apart() {
    // П17
    let target = Target::from_env();
    let client = client_of(&target);
    let ticket = target.new_ticket();

    let wrong = prepare_account(&ticket.username, "0000-0000-0000-0000-0000", PASSWORD)
        .await
        .unwrap();
    let error = enroll_prepared(&client, &wrong, "Mac A").await.unwrap_err();
    assert_eq!(error.code(), "invalid_enroll_code");

    let good = prepare_account(&ticket.username, &ticket.enroll_code, PASSWORD)
        .await
        .unwrap();
    enroll_prepared(&client, &good, "Mac A").await.unwrap();
    let again = prepare_account(&ticket.username, &ticket.enroll_code, PASSWORD)
        .await
        .unwrap();
    let error = enroll_prepared(&client, &again, "Mac A").await.unwrap_err();
    assert_eq!(error.code(), "invalid_enroll_code");

    let late = target.new_ticket();
    let control = in_process_or_skip!(target);
    control.advance(std::time::Duration::from_secs(25 * 3600));
    let prepared = prepare_account(&late.username, &late.enroll_code, PASSWORD)
        .await
        .unwrap();
    let error = enroll_prepared(&client, &prepared, "Mac A")
        .await
        .unwrap_err();
    assert_eq!(error.code(), "enroll_code_expired");
}

fn files_under(dir: &Path, found: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files_under(&path, found);
        } else {
            found.push(path);
        }
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

#[tokio::test]
async fn the_server_never_receives_the_password_or_the_keys() {
    // О1, Р5: after enrolment nothing on the server's disk contains the password, AK, the
    // recovery code, or the token in clear (only hashes and wrapped keys)
    let target = Target::from_env();
    let (_, connected, code) = first_device(&target).await;
    let control = in_process_or_skip!(target);
    let mut files = Vec::new();
    files_under(control.data_dir(), &mut files);
    assert!(!files.is_empty());
    let secrets: Vec<(&str, Vec<u8>)> = vec![
        ("password", PASSWORD.as_bytes().to_vec()),
        ("AK", connected.account_key.as_bytes().to_vec()),
        (
            "AK in hex",
            hex::encode(connected.account_key.as_bytes()).into_bytes(),
        ),
        ("recovery code", code.as_bytes().to_vec()),
        (
            "recovery code in hex",
            hex::encode(code.as_bytes()).into_bytes(),
        ),
        ("recovery code as shown", code.to_display().into_bytes()),
        (
            "token",
            connected.session.token.expose().as_bytes().to_vec(),
        ),
        (
            "token bytes",
            hex::decode(connected.session.token.expose()).unwrap(),
        ),
    ];
    for file in files {
        let bytes = std::fs::read(&file).unwrap();
        for (what, secret) in &secrets {
            assert!(
                !contains(&bytes, secret),
                "{what} found in {}",
                file.display()
            );
        }
    }
}

#[tokio::test]
async fn a_second_device_signs_in_with_the_password_and_reads_the_same_key() {
    // Р5, П13, П14: the new device gets AK; both devices are named, no placeholder is left
    let target = Target::from_env();
    let client = client_of(&target);
    let (username, first, _) = first_device(&target).await;
    let second = sign_in(&client, &username, PASSWORD, "Mac B")
        .await
        .unwrap();
    assert_eq!(second.account_key.as_bytes(), first.account_key.as_bytes());
    assert_ne!(second.session.device_id, first.session.device_id);
    let devices = list_devices(&client, &second.session.token, &second.account_key)
        .await
        .unwrap();
    assert_eq!(names(&devices), vec![Some("Mac A"), Some("Mac B")]);
    assert_eq!(devices.iter().filter(|device| device.current).count(), 1);
    assert!(devices[1].current);
    // The first device sees the same list from its side.
    let from_first = list_devices(&client, &first.session.token, &first.account_key)
        .await
        .unwrap();
    assert_eq!(names(&from_first), names(&devices));
    assert!(from_first[0].current);
}

#[tokio::test]
async fn the_password_is_typed_the_same_on_every_system() {
    // Ф6: NFD and NFC give one key
    let target = Target::from_env();
    let client = client_of(&target);
    let ticket = target.new_ticket();
    let composed = "caf\u{e9} au lait 2026 qq";
    let decomposed = "cafe\u{301} au lait 2026 qq";
    let prepared = prepare_account(&ticket.username, &ticket.enroll_code, composed)
        .await
        .unwrap();
    enroll_prepared(&client, &prepared, "Mac A").await.unwrap();
    sign_in(&client, &ticket.username, decomposed, "Mac B")
        .await
        .unwrap();
}

#[tokio::test]
async fn a_wrong_password_and_an_unknown_name_look_the_same() {
    // П13, П14, С12: no way to ask "is there such a user"
    let target = Target::from_env();
    let client = client_of(&target);
    let (username, _, _) = first_device(&target).await;
    let wrong = sign_in(&client, &username, "not the password at all", "x")
        .await
        .unwrap_err();
    let unknown = sign_in(&client, "nobody-here", PASSWORD, "x")
        .await
        .unwrap_err();
    assert_eq!(wrong.code(), "invalid_credentials");
    assert_eq!(unknown.code(), "invalid_credentials");
    assert_eq!(wrong.to_string(), unknown.to_string());
}

#[tokio::test]
async fn after_five_failures_even_the_right_password_waits() {
    // П16: 429 with the time to wait; the person is told how long
    let target = Target::from_env();
    let client = client_of(&target);
    let (username, _, _) = first_device(&target).await;
    for _ in 0..5 {
        let error = sign_in(&client, &username, "not the password at all", "x")
            .await
            .unwrap_err();
        assert_eq!(error.code(), "invalid_credentials");
    }
    let error = sign_in(&client, &username, PASSWORD, "x")
        .await
        .unwrap_err();
    assert_eq!(error.code(), "rate_limited");
    assert!(error.retry_after_secs().unwrap() > 0);
}

#[tokio::test]
async fn a_forgotten_password_is_replaced_with_the_recovery_code() {
    // Р5, О3, П15, П18: the same AK, a new password, the old one no longer works
    let target = Target::from_env();
    let client = client_of(&target);
    let (username, first, code) = first_device(&target).await;
    let new_password = "a brand new password 77";
    let recovered = recover_account(&client, &username, &code, new_password, "Mac C")
        .await
        .unwrap();
    assert_eq!(
        recovered.account_key.as_bytes(),
        first.account_key.as_bytes()
    );

    let old = sign_in(&client, &username, PASSWORD, "x")
        .await
        .unwrap_err();
    assert_eq!(old.code(), "invalid_credentials");
    let fresh = sign_in(&client, &username, new_password, "Mac D")
        .await
        .unwrap();
    assert_eq!(fresh.account_key.as_bytes(), first.account_key.as_bytes());

    // Devices: the first one (its token lives on, Р5), the recovered one, the new sign-in; no placeholder.
    let devices = list_devices(&client, &recovered.session.token, &recovered.account_key)
        .await
        .unwrap();
    assert_eq!(
        names(&devices),
        vec![Some("Mac A"), Some("Mac C"), Some("Mac D")]
    );
    // The recovery code still works after the password changed (it is not replaced).
    recover_account(
        &client,
        &username,
        &code,
        "yet another password 99",
        "Mac E",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_wrong_recovery_code_is_invalid_credentials() {
    // П15: a well-formed but wrong code
    let target = Target::from_env();
    let client = client_of(&target);
    let (username, _, code) = first_device(&target).await;
    let mut bytes = *code.as_bytes();
    bytes[0] ^= 1;
    let other = RecoveryCode::from_bytes(bytes);
    let error = recover_account(&client, &username, &other, "a brand new password 77", "x")
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_credentials");
    // and nothing changed: the old password still works
    sign_in(&client, &username, PASSWORD, "Mac B")
        .await
        .unwrap();
}

#[tokio::test]
async fn a_disconnected_device_loses_access_and_the_others_keep_it() {
    // Р5, П19
    let target = Target::from_env();
    let client = client_of(&target);
    let (username, first, _) = first_device(&target).await;
    let second = sign_in(&client, &username, PASSWORD, "Mac B")
        .await
        .unwrap();
    disconnect_device(&client, &first.session.token, &second.session.device_id)
        .await
        .unwrap();
    let error = list_devices(&client, &second.session.token, &second.account_key)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "token_revoked");
    let devices = list_devices(&client, &first.session.token, &first.account_key)
        .await
        .unwrap();
    assert_eq!(names(&devices), vec![Some("Mac A")]);
}

#[tokio::test]
async fn a_device_can_disconnect_itself() {
    // П19
    let target = Target::from_env();
    let client = client_of(&target);
    let (_, first, _) = first_device(&target).await;
    disconnect_device(&client, &first.session.token, &first.session.device_id)
        .await
        .unwrap();
    let error = list_devices(&client, &first.session.token, &first.account_key)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "token_revoked");
}

#[tokio::test]
async fn a_name_that_cannot_be_read_is_shown_as_unknown() {
    // Ф34: a device made by another program or a damaged name must not break the list
    let target = Target::from_env();
    let client = client_of(&target);
    let (username, first, _) = first_device(&target).await;
    let intruder = amby_sync_conformance::client::Account {
        api: target.api.clone(),
        username: username.clone(),
        password: PASSWORD.to_string(),
        ak: amby_sync_core::crypto::keys::AccountKey::from_bytes([9u8; 32]),
        recovery_code: RecoveryCode::from_bytes([1u8; 32]),
        recovery_auth_key: amby_sync_core::crypto::keys::AuthKey::from_bytes([0u8; 32]),
        salt: [0u8; 16],
        params: amby_sync_core::crypto::account::Argon2Params::V1_DEFAULT,
        token: String::new(),
        device_id: String::new(),
    };
    // Sign in with a name sealed by a different key.
    let _second = intruder.another_device("not readable with the real AK");
    let devices = list_devices(&client, &first.session.token, &first.account_key)
        .await
        .unwrap();
    assert_eq!(devices.len(), 2);
    assert_eq!(devices[0].name.as_deref(), Some("Mac A"));
    assert_eq!(devices[1].name, None);
}

#[tokio::test]
async fn a_name_over_64_bytes_is_refused_before_anything_is_sent() {
    // Ф34: 64 bytes, not 64 characters
    let server = FakeServer::start(|_| Canned::json(500, "{}")).await;
    let prepared = prepare_account("alice", "AAAA-BBBB-CCCC-DDDD-EEEE", PASSWORD)
        .await
        .unwrap();
    for name in ["x".repeat(65), "Ж".repeat(33)] {
        let error = enroll_prepared(&server.client(), &prepared, &name)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "invalid_device_name", "{} bytes", name.len());
        let error = sign_in(&server.client(), "alice", PASSWORD, &name)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "invalid_device_name");
    }
    assert!(server.requests().is_empty(), "{:?}", server.requests());
}

#[tokio::test]
async fn weaker_parameters_from_the_server_are_never_used() {
    // О8, Ф8: a hostile server answers prelogin with one pass of Argon2id; the client stops
    // before it derives anything and before it sends `login`
    let server = FakeServer::start(|path| {
        if path == "/v1/auth/prelogin" {
            Canned::json(
                200,
                &format!(
                    r#"{{"salt":"{}","params":{{"memory_kib":8,"iterations":1,"parallelism":1}}}}"#,
                    "00".repeat(16)
                ),
            )
        } else {
            Canned::json(500, "{}")
        }
    })
    .await;
    let error = sign_in(&server.client(), "alice", PASSWORD, "Mac")
        .await
        .unwrap_err();
    assert_eq!(error.code(), "crypto");
    assert_eq!(
        server.requests(),
        vec!["POST /v1/auth/prelogin".to_string()]
    );
}

#[tokio::test]
async fn a_malformed_answer_of_login_is_bad_response() {
    // Р13: a salt of the wrong size must not panic
    let server = FakeServer::start(|path| {
        if path == "/v1/auth/prelogin" {
            Canned::json(
                200,
                r#"{"salt":"abcd","params":{"memory_kib":65536,"iterations":3,"parallelism":4}}"#,
            )
        } else {
            Canned::json(500, "{}")
        }
    })
    .await;
    let error = sign_in(&server.client(), "alice", PASSWORD, "Mac")
        .await
        .unwrap_err();
    assert_eq!(error.code(), "bad_response");
}

#[tokio::test]
async fn nothing_secret_is_printed_by_debug() {
    // О1: Debug of sessions, tokens and prepared accounts redacts the secrets
    let target = Target::from_env();
    let (_, connected, code) = first_device(&target).await;
    let ticket = target.new_ticket();
    let prepared = prepare_account(&ticket.username, &ticket.enroll_code, PASSWORD)
        .await
        .unwrap();
    let printed = format!(
        "{connected:?} {:?} {prepared:?} {:?}",
        connected.session, connected.session.token
    );
    for secret in [
        connected.session.token.expose().to_string(),
        hex::encode(connected.account_key.as_bytes()),
        hex::encode(code.as_bytes()),
        code.to_display(),
        hex::encode(prepared.recovery_code().as_bytes()),
        prepared.recovery_code().to_display(),
        PASSWORD.to_string(),
    ] {
        assert!(!printed.contains(&secret), "{secret} in {printed}");
    }
}
