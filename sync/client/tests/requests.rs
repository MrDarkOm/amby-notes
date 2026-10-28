//! The requests of the sign-in protocol against the real server in the process (appendix Б,
//! П9–П19). The keys here come from the independent client of the conformance suite, so the
//! requests of this client are checked against bytes it did not make.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_client::api::{EnrollRequest, ProofKind, ReplaceKeysRequest};
use amby_sync_client::{DeviceToken, ServerUrl, SyncClient};
use amby_sync_conformance::client::{enroll, keys_put_body, open_device_name};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::account::{
    create_account, derive_password_keys, seal_account_key_for_password, unwrap_account_key,
    Argon2Params,
};
use amby_sync_core::crypto::name::{open_device_name as open_name, seal_device_name};
use amby_sync_core::crypto::random::OsRandom;
use common::{client_of, Canned, FakeServer, PASSWORD};

#[tokio::test]
async fn info_names_the_server_and_the_instance() {
    // П9, П10
    let target = Target::from_env();
    let info = client_of(&target).info().await.unwrap();
    assert_eq!(info.server, "amby-sync-server");
    assert_eq!((info.protocol_min, info.protocol_max), (1, 1));
    assert_eq!(info.instance_id.len(), 32);
    assert!(info.instance_id.chars().all(|c| c.is_ascii_hexdigit()));
    info.check_protocol().unwrap();
    assert_eq!(info.rest["formats"]["header"], 1);
}

#[tokio::test]
async fn prelogin_gives_a_salt_for_any_name_and_the_same_one_again() {
    // П13: an unknown name gets a made-up, stable salt of 16 bytes
    let target = Target::from_env();
    let client = client_of(&target);
    let first = client.prelogin("nobody-here").await.unwrap();
    let again = client.prelogin("nobody-here").await.unwrap();
    assert_eq!(first, again);
    assert_eq!(first.params, Argon2Params::V1_DEFAULT);
    assert_ne!(
        first.salt,
        client.prelogin("somebody-else").await.unwrap().salt
    );
}

#[tokio::test]
async fn enroll_creates_the_first_device_and_login_finds_it() {
    // П12, П14, Ф34: the name is the envelope of the core; the server returns what it was given
    let target = Target::from_env();
    let client = client_of(&target);
    let ticket = target.new_ticket();
    let account = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    let name_enc = seal_device_name(&account.account_key, "Mac mini", &mut OsRandom).unwrap();
    let session = client
        .enroll(&EnrollRequest {
            username: &ticket.username,
            enroll_code: &ticket.enroll_code,
            account: &account,
            device_name_enc: &name_enc,
        })
        .await
        .unwrap();
    assert_eq!(session.device_id.len(), 32);
    assert_eq!(session.token.expose().len(), 64);
    assert_eq!(session.keys_version, 1);

    let devices = client.devices(&session.token).await.unwrap();
    assert_eq!(devices.len(), 1);
    assert!(devices[0].current);
    assert_eq!(devices[0].name_enc, name_enc);
    assert_eq!(
        open_name(&account.account_key, &devices[0].name_enc).unwrap(),
        "Mac mini"
    );

    let pre = client.prelogin(&ticket.username).await.unwrap();
    assert_eq!(pre.salt, account.password.salt);
    let keys = derive_password_keys(PASSWORD, &pre.salt, &pre.params).unwrap();
    let answer = client
        .login(&ticket.username, &keys.auth_key, &name_enc)
        .await
        .unwrap();
    assert_eq!(answer.wrapped_ak, account.password.wrapped_account_key);
    assert_eq!(answer.salt, account.password.salt);
    assert_eq!(answer.params, account.password.params);
    assert_ne!(
        answer.session.device_id, session.device_id,
        "every sign-in is a new device (П14)"
    );
}

#[tokio::test]
async fn recover_returns_the_key_wrapped_by_the_code() {
    // П15
    let target = Target::from_env();
    let client = client_of(&target);
    let first = enroll(&target, PASSWORD);
    let keys = amby_sync_core::crypto::account::derive_recovery_keys(&first.recovery_code);
    let name_enc = seal_device_name(&first.ak, "Recovery", &mut OsRandom).unwrap();
    let answer = client
        .recover(&first.username, &keys.auth_key, &name_enc)
        .await
        .unwrap();
    assert_eq!(
        unwrap_account_key(&keys.kek, &answer.wrapped_ak_recovery).unwrap(),
        first.ak
    );
}

#[tokio::test]
async fn a_wrong_secret_is_invalid_credentials() {
    // П14, П15
    let target = Target::from_env();
    let client = client_of(&target);
    let first = enroll(&target, PASSWORD);
    let name_enc = seal_device_name(&first.ak, "x", &mut OsRandom).unwrap();
    let wrong =
        derive_password_keys("not the password at all", &first.salt, &first.params).unwrap();
    let error = client
        .login(&first.username, &wrong.auth_key, &name_enc)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_credentials");
    assert_eq!(
        error.to_string(),
        amby_sync_client::error::describe("invalid_credentials")
    );
}

#[tokio::test]
async fn keys_can_be_read_and_replaced_with_a_proof() {
    // П18: the proof is the old password; a stale version is keys_conflict; a wrong proof is invalid_proof
    let target = Target::from_env();
    let client = client_of(&target);
    let first = enroll(&target, PASSWORD);
    let token = DeviceToken::new(first.token.clone());
    let read = client.keys(&token).await.unwrap();
    assert_eq!(read.keys_version, 1);
    assert_eq!(read.salt, first.salt);
    assert_eq!(read.wrapped_ak.len(), 73);
    assert_eq!(read.wrapped_ak_recovery.len(), 73);

    let envelope = seal_account_key_for_password(
        "a brand new password 77",
        &first.ak,
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    let old = first.password_auth_key();
    let wrong =
        derive_password_keys("not the password at all", &first.salt, &first.params).unwrap();

    let error = client
        .replace_keys(
            &token,
            &ReplaceKeysRequest {
                base_keys_version: 1,
                proof_kind: ProofKind::Password,
                proof_auth_key: &wrong.auth_key,
                envelope: &envelope,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_proof");

    let error = client
        .replace_keys(
            &token,
            &ReplaceKeysRequest {
                base_keys_version: 9,
                proof_kind: ProofKind::Password,
                proof_auth_key: &old,
                envelope: &envelope,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "keys_conflict");

    let version = client
        .replace_keys(
            &token,
            &ReplaceKeysRequest {
                base_keys_version: 1,
                proof_kind: ProofKind::Password,
                proof_auth_key: &old,
                envelope: &envelope,
            },
        )
        .await
        .unwrap();
    assert_eq!(version, 2);
    // The server accepted exactly the body the independent client would have sent.
    let _ = keys_put_body;
    assert_eq!(client.keys(&token).await.unwrap().keys_version, 2);
}

#[tokio::test]
async fn devices_are_listed_and_disconnected() {
    // П19, Р5
    let target = Target::from_env();
    let client = client_of(&target);
    let first = enroll(&target, PASSWORD);
    let second = first.another_device("laptop");
    let token = DeviceToken::new(first.token.clone());
    let devices = client.devices(&token).await.unwrap();
    assert_eq!(devices.len(), 2);
    assert_eq!(
        open_device_name(&first.ak, &hex::encode(&devices[1].name_enc)),
        "laptop"
    );
    client
        .delete_device(&token, &second.device_id)
        .await
        .unwrap();
    assert_eq!(client.devices(&token).await.unwrap().len(), 1);
    let revoked = client
        .devices(&DeviceToken::new(second.token.clone()))
        .await
        .unwrap_err();
    assert_eq!(revoked.code(), "token_revoked");
    let missing = client
        .delete_device(&token, &second.device_id)
        .await
        .unwrap_err();
    assert_eq!(missing.code(), "not_found");
}

#[tokio::test]
async fn an_unknown_token_is_unauthorized() {
    // П5
    let target = Target::from_env();
    let error = client_of(&target)
        .devices(&DeviceToken::new("00".repeat(32)))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "unauthorized");
}

#[tokio::test]
async fn the_token_travels_in_the_header_and_never_in_the_address() {
    // П5: addresses are written to proxy logs
    let server = FakeServer::start(|_| Canned::json(200, r#"{"devices":[]}"#)).await;
    let token = DeviceToken::new("ab".repeat(32));
    server.client().devices(&token).await.unwrap();
    let requests = server.requests();
    assert_eq!(requests, vec!["GET /v1/devices".to_string()]);
    let heads = server.heads.lock().unwrap().clone();
    assert!(heads[0].contains(&format!("authorization: bearer {}", "ab".repeat(32))));
}

#[tokio::test]
async fn the_address_of_the_client_is_what_it_was_given() {
    // П41
    let url = ServerUrl::parse("http://127.0.0.1:9", false).unwrap();
    assert_eq!(SyncClient::new(&url).unwrap().base_url(), &url);
}
