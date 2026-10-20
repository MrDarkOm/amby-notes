//! The sign-in flows of the application against the real server of `sync/` started inside the
//! test (Р5, О1, О3, О8; П9–П19). The system key store is replaced by one in memory.

use std::sync::atomic::Ordering;

use amby_sync_client::{sign_in as client_sign_in, ClientError, ServerUrl, SyncClient};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use tracing::instrument::WithSubscriber;

use super::connection::ConnectionStore;
use super::secrets::{SecretStore, KEYRING_SERVICE, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use super::service::{PrepareRequest, RecoverRequest, SignInRequest};
use super::test_support::{endpoint_of, Device, LogCapture};
use super::types::{Endpoint, PreparedAccountView, SyncError};

const PASSWORD: &str = "correct horse battery staple 42";
const NEW_PASSWORD: &str = "a brand new password about owls 77";

fn prepare_request(target: &Target, username: &str, code: &str, device: &str) -> PrepareRequest {
    PrepareRequest {
        endpoint: endpoint_of(target),
        username: username.to_string(),
        enroll_code: code.to_string(),
        password: PASSWORD.to_string(),
        device_name: device.to_string(),
    }
}

fn sign_in_request(target: &Target, username: &str, password: &str, device: &str) -> SignInRequest {
    SignInRequest {
        endpoint: endpoint_of(target),
        username: username.to_string(),
        password: password.to_string(),
        device_name: device.to_string(),
    }
}

/// What a person types back: the groups of the code at the asked positions.
fn typed_groups(view: &PreparedAccountView) -> Vec<String> {
    let groups: Vec<&str> = view.recovery_code.split('-').collect();
    view.confirm_groups
        .iter()
        .map(|position| groups[usize::from(*position) - 1].to_string())
        .collect()
}

struct Created {
    username: String,
    recovery_code: String,
    enroll_code: String,
}

/// The whole creation of an account on `device`, as the screen does it.
async fn create_account(device: &Device, target: &Target, name: &str) -> Created {
    let ticket = target.new_ticket();
    let view = device
        .service
        .prepare_account(prepare_request(
            target,
            &ticket.username,
            &ticket.enroll_code,
            name,
        ))
        .await
        .unwrap();
    device
        .service
        .confirm_recovery_code(&typed_groups(&view))
        .await
        .unwrap();
    Created {
        username: ticket.username,
        recovery_code: view.recovery_code,
        enroll_code: ticket.enroll_code,
    }
}

fn client_of(target: &Target) -> SyncClient {
    SyncClient::new(&ServerUrl::parse(target.api.base(), true).unwrap()).unwrap()
}

async fn code_of<T>(result: impl std::future::Future<Output = Result<T, SyncError>>) -> String {
    result.await.err().expect("expected an error").code
}

#[test]
fn the_key_store_service_is_the_documented_one() {
    // Р5: `com.ambynotes.sync`, next to `com.ambynotes.ai` of the AI keys
    assert_eq!(KEYRING_SERVICE, "com.ambynotes.sync");
    assert_ne!(SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN);
}

#[test]
fn native_key_store_backend_is_configured() {
    // as in `credentials.rs`: without the platform feature keyring silently uses mock storage
    #[cfg(target_os = "macos")]
    assert!(keyring::Entry::new(KEYRING_SERVICE, "backend-type-check")
        .unwrap()
        .get_credential()
        .is::<keyring::macos::MacCredential>());
    #[cfg(target_os = "windows")]
    assert!(keyring::Entry::new(KEYRING_SERVICE, "backend-type-check")
        .unwrap()
        .get_credential()
        .is::<keyring::windows::WinCredential>());
}

#[test]
#[ignore = "writes and removes one uniquely named synthetic entry in the real system key store"]
fn the_system_key_store_round_trip() {
    use super::secrets::KeyringStore;
    let store = KeyringStore;
    let name = format!("synthetic-{}", ulid::Ulid::generate());
    assert_eq!(store.get(&name).unwrap(), None);
    store.set(&name, "synthetic-secret-1234").unwrap();
    assert_eq!(
        store.get(&name).unwrap().as_deref(),
        Some("synthetic-secret-1234")
    );
    store.delete(&name).unwrap();
    assert_eq!(store.get(&name).unwrap(), None);
    store.delete(&name).unwrap();
}

#[test]
fn errors_cross_the_border_as_a_code_and_a_wait() {
    // П4, П16: the interface gets nothing but the code and the seconds
    let limited = SyncError::from(ClientError::Api {
        status: 429,
        code: "rate_limited".into(),
        retry_after_secs: Some(840),
    });
    assert_eq!(
        serde_json::to_string(&limited).unwrap(),
        r#"{"code":"rate_limited","retryAfterSecs":840}"#
    );
    assert_eq!(
        SyncError::from(ClientError::Network),
        SyncError::new("network")
    );
    assert_eq!(
        SyncError::from(ClientError::InsecureUrl).code,
        "insecure_url"
    );
}

#[tokio::test]
async fn a_new_installation_is_not_connected() {
    let device = Device::new();
    let status = device.service.status().unwrap();
    assert!(!status.connected && !status.keys_missing && !status.pending);
    assert_eq!(status.server_url, None);
    assert_eq!(status.username, None);
}

#[tokio::test]
async fn the_server_is_checked_by_its_info() {
    // П9, П10
    let target = Target::from_env();
    let device = Device::new();
    let check = device
        .service
        .check_server(&endpoint_of(&target))
        .await
        .unwrap();
    assert_eq!(check.url, target.api.base());
    assert!(
        check.host.starts_with("127.0.0.1")
            || check.host.starts_with("localhost")
            || !check.host.is_empty()
    );
    assert!(!check.server_version.is_empty());
    assert_eq!(check.instance_id.len(), 32);
}

#[tokio::test]
async fn a_remote_address_without_https_is_refused_before_the_network() {
    // П41
    let device = Device::new();
    let endpoint = Endpoint {
        url: "http://sync.example.com".into(),
        allow_http: false,
    };
    assert_eq!(
        code_of(device.service.check_server(&endpoint)).await,
        "insecure_url"
    );
}

#[tokio::test]
async fn a_server_that_is_not_there_is_a_network_error() {
    let device = Device::new();
    let endpoint = Endpoint {
        url: "http://127.0.0.1:1".into(),
        allow_http: false,
    };
    assert_eq!(
        code_of(device.service.check_server(&endpoint)).await,
        "network"
    );
}

#[tokio::test]
async fn preparing_an_account_shows_the_code_and_sends_nothing() {
    // Р5, О3: the keys exist only in memory; the server has no account yet
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    let view = device
        .service
        .prepare_account(prepare_request(
            &target,
            &ticket.username,
            &ticket.enroll_code,
            "Mac A",
        ))
        .await
        .unwrap();
    assert!(RecoveryCode::parse(&view.recovery_code).is_ok());
    assert_eq!(view.recovery_code.split('-').count(), 14);
    assert_eq!(view.confirm_groups.len(), 2);
    assert!(
        view.confirm_groups[0] < view.confirm_groups[1],
        "{:?}",
        view.confirm_groups
    );
    assert!(view
        .confirm_groups
        .iter()
        .all(|position| (1..=14).contains(position)));

    let status = device.service.status().unwrap();
    assert!(status.pending && !status.connected);
    assert_eq!(device.secrets.len(), 0);
    assert_eq!(device.connection.load().unwrap(), None);
    // the server holds no password for the name yet
    let error = client_sign_in(&client_of(&target), &ticket.username, PASSWORD, "x")
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_credentials");
}

#[tokio::test]
async fn a_weak_or_short_password_does_not_get_as_far_as_the_keys() {
    // Р5: refused by the application, not only by the screen
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    for (password, code) in [
        ("password1234", "weak_password"),
        ("qwertyuiop12", "weak_password"),
        ("short1!", "password_too_short"),
        ("", "password_too_short"),
    ] {
        let mut request = prepare_request(&target, &ticket.username, &ticket.enroll_code, "Mac A");
        request.password = password.to_string();
        assert_eq!(
            code_of(device.service.prepare_account(request)).await,
            code,
            "{password:?}"
        );
        assert!(!device.service.status().unwrap().pending);
    }
}

#[tokio::test]
async fn a_bad_user_name_or_device_name_is_told_at_once() {
    // П11, Ф34
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    let bad_user = prepare_request(&target, "Alice", &ticket.enroll_code, "Mac A");
    assert_eq!(
        code_of(device.service.prepare_account(bad_user)).await,
        "invalid_username"
    );
    let long_name = prepare_request(
        &target,
        &ticket.username,
        &ticket.enroll_code,
        &"x".repeat(65),
    );
    let view = device.service.prepare_account(long_name).await.unwrap();
    // the name is checked when it is sealed, which is at confirmation
    assert_eq!(
        code_of(device.service.confirm_recovery_code(&typed_groups(&view))).await,
        "invalid_device_name"
    );
}

#[tokio::test]
async fn wrong_groups_do_not_connect_and_do_not_lose_the_account() {
    // О3: the person cannot go on without the code; a typo can be corrected
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    let view = device
        .service
        .prepare_account(prepare_request(
            &target,
            &ticket.username,
            &ticket.enroll_code,
            "Mac A",
        ))
        .await
        .unwrap();
    let right = typed_groups(&view);
    for wrong in [
        vec![String::new(), String::new()],
        vec!["ZZZZ".into(), "ZZZZ".into()],
        vec![right[0].clone()],
        vec![right[0].clone(), right[0].clone(), right[0].clone()],
        vec![right[1].clone(), right[0].clone()],
    ] {
        assert_eq!(
            code_of(device.service.confirm_recovery_code(&wrong)).await,
            "recovery_confirmation_mismatch",
            "{wrong:?}"
        );
    }
    let status = device.service.status().unwrap();
    assert!(status.pending && !status.connected);
    assert_eq!(device.secrets.len(), 0);
    // typed the way people type: small letters, spaces around
    let loose: Vec<String> = right
        .iter()
        .map(|group| format!(" {} ", group.to_lowercase()))
        .collect();
    let status = device.service.confirm_recovery_code(&loose).await.unwrap();
    assert!(status.connected && !status.pending);
}

#[tokio::test]
async fn look_alike_symbols_are_read_as_the_code_does() {
    // Ф30: O is 0, I and L are 1
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    let view = device
        .service
        .prepare_account(prepare_request(
            &target,
            &ticket.username,
            &ticket.enroll_code,
            "Mac A",
        ))
        .await
        .unwrap();
    let typed: Vec<String> = typed_groups(&view)
        .iter()
        .map(|group| group.replace('0', "o").replace('1', "l"))
        .collect();
    assert!(
        device
            .service
            .confirm_recovery_code(&typed)
            .await
            .unwrap()
            .connected
    );
}

#[tokio::test]
async fn confirming_without_a_prepared_account_is_an_error() {
    let device = Device::new();
    assert_eq!(
        code_of(
            device
                .service
                .confirm_recovery_code(&["AAAA".into(), "BBBB".into()])
        )
        .await,
        "no_pending_account"
    );
}

#[tokio::test]
async fn a_confirmed_account_connects_the_device_and_stores_the_secrets_in_the_key_store() {
    // Р5, О1: AK and the token in the key store, the address and the name in the record
    let target = Target::from_env();
    let device = Device::new();
    let created = create_account(&device, &target, "Mac A").await;
    let status = device.service.status().unwrap();
    assert!(status.connected && !status.keys_missing && !status.pending);
    assert_eq!(status.username.as_deref(), Some(created.username.as_str()));
    assert_eq!(status.server_url.as_deref(), Some(target.api.base()));
    assert_eq!(status.device_id.as_ref().map(String::len), Some(32));
    assert!(status.allow_http);
    let ak = device.secrets.peek(SECRET_ACCOUNT_KEY).unwrap();
    let token = device.secrets.peek(SECRET_DEVICE_TOKEN).unwrap();
    assert_eq!((ak.len(), token.len()), (64, 64));
    assert!(ak.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(device.secrets.len(), 2);
    let record = device.connection.load().unwrap().unwrap();
    assert_eq!(record.username, created.username);
    assert_eq!(Some(record.device_id), status.device_id);
    // the account really exists: another device signs in with the password
    client_sign_in(&client_of(&target), &created.username, PASSWORD, "x")
        .await
        .unwrap();
}

#[tokio::test]
async fn nothing_secret_is_in_the_record_or_in_what_the_screen_gets() {
    // О1, Р5: not in the settings tier, not in the status, not in Debug
    let target = Target::from_env();
    let device = Device::new();
    let created = create_account(&device, &target, "Mac A").await;
    let ak = device.secrets.peek(SECRET_ACCOUNT_KEY).unwrap();
    let token = device.secrets.peek(SECRET_DEVICE_TOKEN).unwrap();
    let record = serde_json::to_string(&device.connection.load().unwrap().unwrap()).unwrap();
    let status = format!("{:?}", device.service.status().unwrap());
    let compact_code = created.recovery_code.replace('-', "");
    for (what, text) in [("the record", &record), ("the status", &status)] {
        for secret in [
            PASSWORD,
            &ak,
            &token,
            &created.recovery_code,
            &compact_code,
            &created.enroll_code,
        ] {
            assert!(!text.contains(secret), "{what} contains a secret");
        }
    }
    let request = format!("{:?}", prepare_request(&target, "alice", "CODE", "Mac"));
    assert!(!request.contains(PASSWORD) && !request.contains("CODE"));
    let view = PreparedAccountView {
        recovery_code: created.recovery_code.clone(),
        confirm_groups: vec![1, 2],
    };
    assert!(!format!("{view:?}").contains(&created.recovery_code));
}

#[tokio::test]
async fn cancelling_forgets_the_prepared_account() {
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    let view = device
        .service
        .prepare_account(prepare_request(
            &target,
            &ticket.username,
            &ticket.enroll_code,
            "Mac A",
        ))
        .await
        .unwrap();
    device.service.cancel_pending();
    assert!(!device.service.status().unwrap().pending);
    assert_eq!(
        code_of(device.service.confirm_recovery_code(&typed_groups(&view))).await,
        "no_pending_account"
    );
    // the enroll code is not burned: a fresh preparation still works
    let again = device
        .service
        .prepare_account(prepare_request(
            &target,
            &ticket.username,
            &ticket.enroll_code,
            "Mac A",
        ))
        .await
        .unwrap();
    assert!(
        device
            .service
            .confirm_recovery_code(&typed_groups(&again))
            .await
            .unwrap()
            .connected
    );
}

#[tokio::test]
async fn a_second_preparation_replaces_the_first() {
    // the person went back and forth: the code on the screen is the only valid one
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    let request = || prepare_request(&target, &ticket.username, &ticket.enroll_code, "Mac A");
    let first = device.service.prepare_account(request()).await.unwrap();
    let second = device.service.prepare_account(request()).await.unwrap();
    assert_ne!(first.recovery_code, second.recovery_code);
    let old_groups = typed_groups(&PreparedAccountView {
        recovery_code: first.recovery_code.clone(),
        confirm_groups: second.confirm_groups.clone(),
    });
    assert_eq!(
        code_of(device.service.confirm_recovery_code(&old_groups)).await,
        "recovery_confirmation_mismatch"
    );
    assert!(
        device
            .service
            .confirm_recovery_code(&typed_groups(&second))
            .await
            .unwrap()
            .connected
    );
}

#[tokio::test]
async fn a_wrong_enroll_code_is_reported_after_the_confirmation_and_the_screen_can_go_back() {
    // П17
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    let view = device
        .service
        .prepare_account(prepare_request(
            &target,
            &ticket.username,
            "0000-0000-0000-0000-0000",
            "Mac A",
        ))
        .await
        .unwrap();
    assert_eq!(
        code_of(device.service.confirm_recovery_code(&typed_groups(&view))).await,
        "invalid_enroll_code"
    );
    assert_eq!(device.secrets.len(), 0);
    assert_eq!(device.connection.load().unwrap(), None);
    assert!(!device.service.status().unwrap().connected);
    // back, with the right code
    device.service.cancel_pending();
    let again = device
        .service
        .prepare_account(prepare_request(
            &target,
            &ticket.username,
            &ticket.enroll_code,
            "Mac A",
        ))
        .await
        .unwrap();
    assert!(
        device
            .service
            .confirm_recovery_code(&typed_groups(&again))
            .await
            .unwrap()
            .connected
    );
}

#[tokio::test]
async fn a_connected_device_does_not_start_another_connection() {
    let target = Target::from_env();
    let device = Device::new();
    let created = create_account(&device, &target, "Mac A").await;
    let ticket = target.new_ticket();
    assert_eq!(
        code_of(device.service.prepare_account(prepare_request(
            &target,
            &ticket.username,
            &ticket.enroll_code,
            "x"
        )))
        .await,
        "already_connected"
    );
    assert_eq!(
        code_of(
            device
                .service
                .sign_in(sign_in_request(&target, &created.username, PASSWORD, "x"))
        )
        .await,
        "already_connected"
    );
    let recover = RecoverRequest {
        endpoint: endpoint_of(&target),
        username: created.username.clone(),
        recovery_code: created.recovery_code.clone(),
        new_password: NEW_PASSWORD.into(),
        device_name: "x".into(),
    };
    assert_eq!(
        code_of(device.service.recover(recover)).await,
        "already_connected"
    );
}

#[tokio::test]
async fn a_second_device_signs_in_and_both_see_each_other_by_name() {
    // Р5, П13, П14, П19, Ф34
    let target = Target::from_env();
    let first = Device::new();
    let created = create_account(&first, &target, "Mac A").await;
    let second = Device::new();
    let status = second
        .service
        .sign_in(sign_in_request(
            &target,
            &created.username,
            PASSWORD,
            "Mac B",
        ))
        .await
        .unwrap();
    assert!(status.connected);
    assert_eq!(
        second.secrets.peek(SECRET_ACCOUNT_KEY),
        first.secrets.peek(SECRET_ACCOUNT_KEY),
        "the same key of the account on both devices"
    );
    assert_ne!(
        second.secrets.peek(SECRET_DEVICE_TOKEN),
        first.secrets.peek(SECRET_DEVICE_TOKEN)
    );
    for device in [&first, &second] {
        let list = device.service.list_devices().await.unwrap();
        let names: Vec<_> = list.iter().map(|entry| entry.name.as_deref()).collect();
        assert_eq!(names, vec![Some("Mac A"), Some("Mac B")]);
        assert_eq!(list.iter().filter(|entry| entry.current).count(), 1);
    }
    assert!(first.service.list_devices().await.unwrap()[0].current);
    assert!(second.service.list_devices().await.unwrap()[1].current);
}

#[tokio::test]
async fn a_wrong_password_connects_nothing_and_five_failures_make_the_person_wait() {
    // П14, П16, С12
    let target = Target::from_env();
    let first = Device::new();
    let created = create_account(&first, &target, "Mac A").await;
    let second = Device::new();
    for _ in 0..5 {
        let error = second
            .service
            .sign_in(sign_in_request(
                &target,
                &created.username,
                "not the password at all",
                "Mac B",
            ))
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_credentials");
        assert_eq!(error.retry_after_secs, None);
    }
    assert_eq!(second.secrets.len(), 0);
    assert_eq!(second.connection.load().unwrap(), None);
    let error = second
        .service
        .sign_in(sign_in_request(
            &target,
            &created.username,
            PASSWORD,
            "Mac B",
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, "rate_limited");
    assert!(error.retry_after_secs.unwrap() > 0);
}

#[tokio::test]
async fn a_forgotten_password_is_replaced_by_the_recovery_code() {
    // Р5, О3: the same key of the account, the new password works, the old one does not
    let target = Target::from_env();
    let first = Device::new();
    let created = create_account(&first, &target, "Mac A").await;
    let second = Device::new();
    let typed = created.recovery_code.replace('-', " ").to_lowercase();
    let status = second
        .service
        .recover(RecoverRequest {
            endpoint: endpoint_of(&target),
            username: created.username.clone(),
            recovery_code: typed,
            new_password: NEW_PASSWORD.into(),
            device_name: "Mac B".into(),
        })
        .await
        .unwrap();
    assert!(status.connected);
    assert_eq!(
        second.secrets.peek(SECRET_ACCOUNT_KEY),
        first.secrets.peek(SECRET_ACCOUNT_KEY)
    );
    let third = Device::new();
    assert_eq!(
        code_of(third.service.sign_in(sign_in_request(
            &target,
            &created.username,
            PASSWORD,
            "Mac C"
        )))
        .await,
        "invalid_credentials"
    );
    third
        .service
        .sign_in(sign_in_request(
            &target,
            &created.username,
            NEW_PASSWORD,
            "Mac C",
        ))
        .await
        .unwrap();
    assert_eq!(second.service.list_devices().await.unwrap().len(), 3);
}

#[tokio::test]
async fn recovery_refuses_a_bad_code_and_a_weak_new_password() {
    // Ф30, Р5
    let target = Target::from_env();
    let first = Device::new();
    let created = create_account(&first, &target, "Mac A").await;
    let second = Device::new();
    let recover = |code: &str, password: &str| RecoverRequest {
        endpoint: endpoint_of(&target),
        username: created.username.clone(),
        recovery_code: code.to_string(),
        new_password: password.to_string(),
        device_name: "Mac B".into(),
    };
    assert_eq!(
        code_of(second.service.recover(recover("not a code", NEW_PASSWORD))).await,
        "invalid_recovery_code"
    );
    assert_eq!(
        code_of(second.service.recover(recover("", NEW_PASSWORD))).await,
        "invalid_recovery_code"
    );
    assert_eq!(
        code_of(
            second
                .service
                .recover(recover(&created.recovery_code, "password1234"))
        )
        .await,
        "weak_password"
    );
    assert_eq!(
        code_of(
            second
                .service
                .recover(recover(&created.recovery_code, "short1!"))
        )
        .await,
        "password_too_short"
    );
    // a well-formed code that is not ours
    let other = RecoveryCode::from_bytes([7u8; 32]).to_display();
    assert_eq!(
        code_of(second.service.recover(recover(&other, NEW_PASSWORD))).await,
        "invalid_credentials"
    );
    assert_eq!(second.secrets.len(), 0);
    // and nothing changed: the old password still works
    second
        .service
        .sign_in(sign_in_request(
            &target,
            &created.username,
            PASSWORD,
            "Mac B",
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn disconnecting_another_device_cuts_it_off_and_it_notices() {
    // Р5, П19: the disconnected device learns it at its next request and forgets its secrets
    let target = Target::from_env();
    let first = Device::new();
    let created = create_account(&first, &target, "Mac A").await;
    let second = Device::new();
    second
        .service
        .sign_in(sign_in_request(
            &target,
            &created.username,
            PASSWORD,
            "Mac B",
        ))
        .await
        .unwrap();
    let second_id = second.service.status().unwrap().device_id.unwrap();
    first.service.disconnect_device(&second_id).await.unwrap();
    assert_eq!(first.service.list_devices().await.unwrap().len(), 1);

    assert_eq!(
        code_of(second.service.list_devices()).await,
        "token_revoked"
    );
    let status = second.service.status().unwrap();
    assert!(!status.connected);
    assert_eq!(second.secrets.len(), 0);
    assert_eq!(second.connection.load().unwrap(), None);
}

#[tokio::test]
async fn disconnecting_this_device_signs_it_out() {
    let target = Target::from_env();
    let device = Device::new();
    create_account(&device, &target, "Mac A").await;
    let own = device.service.status().unwrap().device_id.unwrap();
    device.service.disconnect_device(&own).await.unwrap();
    assert!(!device.service.status().unwrap().connected);
    assert_eq!(device.secrets.len(), 0);
}

#[tokio::test]
async fn signing_out_tells_the_server_and_empties_the_key_store() {
    // Р5, П19
    let target = Target::from_env();
    let first = Device::new();
    let created = create_account(&first, &target, "Mac A").await;
    let second = Device::new();
    second
        .service
        .sign_in(sign_in_request(
            &target,
            &created.username,
            PASSWORD,
            "Mac B",
        ))
        .await
        .unwrap();
    let result = first.service.sign_out().await.unwrap();
    assert!(result.server_notified);
    assert!(!first.service.status().unwrap().connected);
    assert_eq!(first.secrets.len(), 0);
    assert_eq!(first.connection.load().unwrap(), None);
    let remaining = second.service.list_devices().await.unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].name.as_deref(), Some("Mac B"));
    // signing out twice is harmless
    assert!(first.service.sign_out().await.is_ok());
}

#[tokio::test]
async fn signing_out_works_when_the_server_cannot_be_reached() {
    // the person must be able to leave; the device can be disconnected from another one later
    let target = Target::from_env();
    let device = Device::new();
    create_account(&device, &target, "Mac A").await;
    let mut record = device.connection.load().unwrap().unwrap();
    record.server_url = "http://127.0.0.1:1".into();
    device.connection.save(&record).unwrap();
    let result = device.service.sign_out().await.unwrap();
    assert!(!result.server_notified);
    assert_eq!(device.secrets.len(), 0);
    assert_eq!(device.connection.load().unwrap(), None);
}

#[tokio::test]
async fn a_key_store_that_refuses_leaves_no_half_connection() {
    // Р5: the system key store failed at the last step; nothing stays on this device, and the
    // device that was just made on the server is disconnected again
    let target = Target::from_env();
    let device = Device::new();
    let ticket = target.new_ticket();
    let view = device
        .service
        .prepare_account(prepare_request(
            &target,
            &ticket.username,
            &ticket.enroll_code,
            "Mac A",
        ))
        .await
        .unwrap();
    device.secrets.fail_set.store(true, Ordering::SeqCst);
    assert_eq!(
        code_of(device.service.confirm_recovery_code(&typed_groups(&view))).await,
        "keychain_unavailable"
    );
    device.secrets.fail_set.store(false, Ordering::SeqCst);
    assert_eq!(device.secrets.len(), 0);
    assert_eq!(device.connection.load().unwrap(), None);
    assert!(!device.service.status().unwrap().connected);
    // the account exists (the code was confirmed): a sign-in works and the failed device is gone
    let other = Device::new();
    other
        .service
        .sign_in(sign_in_request(
            &target,
            &ticket.username,
            PASSWORD,
            "Mac B",
        ))
        .await
        .unwrap();
    let list = other.service.list_devices().await.unwrap();
    assert_eq!(
        list.len(),
        1,
        "the half-connected device must not stay in the list"
    );
    assert_eq!(list[0].name.as_deref(), Some("Mac B"));
}

#[tokio::test]
async fn a_record_that_cannot_be_saved_leaves_no_secrets() {
    let target = Target::from_env();
    let first = Device::new();
    let created = create_account(&first, &target, "Mac A").await;
    let second = Device::new();
    second.connection.fail_save.store(true, Ordering::SeqCst);
    assert_eq!(
        code_of(second.service.sign_in(sign_in_request(
            &target,
            &created.username,
            PASSWORD,
            "Mac B"
        )))
        .await,
        "storage_error"
    );
    assert_eq!(second.secrets.len(), 0);
    assert_eq!(first.service.list_devices().await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_cleared_key_store_asks_for_a_new_sign_in() {
    // Р5: the record is there but AK or the token are gone (the person cleared the keychain)
    let target = Target::from_env();
    let device = Device::new();
    create_account(&device, &target, "Mac A").await;
    device.secrets.delete(SECRET_ACCOUNT_KEY).unwrap();
    let status = device.service.status().unwrap();
    assert!(!status.connected && status.keys_missing);
    assert_eq!(
        status.username.as_deref().map(str::is_empty),
        Some(false),
        "the name is kept to prefill the form"
    );
    assert_eq!(
        code_of(device.service.list_devices()).await,
        "not_connected"
    );
}

#[tokio::test]
async fn an_unavailable_key_store_is_reported_not_hidden() {
    // the keychain is locked: neither "connected" nor "not connected" would be true
    let target = Target::from_env();
    let device = Device::new();
    create_account(&device, &target, "Mac A").await;
    device.secrets.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        device.service.status().unwrap_err().code,
        "keychain_unavailable"
    );
}

#[tokio::test]
async fn the_connection_survives_a_restart_of_the_application() {
    let target = Target::from_env();
    let device = Device::new();
    let created = create_account(&device, &target, "Mac A").await;
    let restarted = device.restarted();
    let status = restarted.status().unwrap();
    assert!(status.connected);
    assert_eq!(status.username.as_deref(), Some(created.username.as_str()));
    assert_eq!(restarted.list_devices().await.unwrap().len(), 1);
}

#[tokio::test]
async fn nothing_secret_is_logged() {
    // О1, Р5: whatever the libraries print down to TRACE, no password, key, token, code
    let target = Target::from_env();
    let logs = LogCapture::default();
    let first = Device::new();
    let second = Device::new();
    let third = Device::new();
    let (created, second_secrets) = async {
        let created = create_account(&first, &target, "Mac A").await;
        second
            .service
            .sign_in(sign_in_request(
                &target,
                &created.username,
                PASSWORD,
                "Mac B",
            ))
            .await
            .unwrap();
        third
            .service
            .recover(RecoverRequest {
                endpoint: endpoint_of(&target),
                username: created.username.clone(),
                recovery_code: created.recovery_code.clone(),
                new_password: NEW_PASSWORD.into(),
                device_name: "Mac C".into(),
            })
            .await
            .unwrap();
        let _ = first.service.list_devices().await;
        let _ = first.service.sign_out().await;
        (
            created,
            (
                second.secrets.peek(SECRET_ACCOUNT_KEY),
                second.secrets.peek(SECRET_DEVICE_TOKEN),
            ),
        )
    }
    .with_subscriber(logs.dispatch())
    .await;
    let printed = logs.text();
    let compact = created.recovery_code.replace('-', "");
    let mut secrets = vec![
        PASSWORD.to_string(),
        NEW_PASSWORD.to_string(),
        created.recovery_code.clone(),
        compact,
        created.enroll_code.clone(),
        created.enroll_code.replace('-', ""),
    ];
    secrets.extend(second_secrets.0);
    secrets.extend(second_secrets.1);
    secrets.extend(third.secrets.peek(SECRET_DEVICE_TOKEN));
    for secret in secrets {
        assert!(
            !printed.contains(&secret),
            "a secret was logged ({} bytes of log)",
            printed.len()
        );
    }
}
