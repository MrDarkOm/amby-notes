//! The password change of a connected device (Р5, П18) against the real server of `sync/` started
//! inside the test. The system key store is replaced by one in memory.
//!
//! What the application keeps about the keys is only AK and the token of this device (the key
//! store) and the connection record: a password change touches none of them.

use amby_sync_conformance::Target;
use tracing::instrument::WithSubscriber;

use super::connection::{ConnectionRecord, ConnectionStore};
use super::secrets::{SecretStore, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use super::service::{PrepareRequest, RecoverRequest, SignInRequest};
use super::test_support::{endpoint_of, Device, LogCapture};
use super::types::SyncError;

const PASSWORD: &str = "correct horse battery staple 42";
const NEW_PASSWORD: &str = "a brand new password about owls 77";

struct Created {
    username: String,
    recovery_code: String,
}

/// The whole creation of an account on `device`, as the screen does it.
async fn create_account(device: &Device, target: &Target) -> Created {
    let ticket = target.new_ticket();
    let view = device
        .service
        .prepare_account(PrepareRequest {
            endpoint: endpoint_of(target),
            username: ticket.username.clone(),
            enroll_code: ticket.enroll_code,
            password: PASSWORD.to_string(),
            device_name: "Mac A".to_string(),
        })
        .await
        .unwrap();
    let groups: Vec<&str> = view.recovery_code.split('-').collect();
    let typed: Vec<String> = view
        .confirm_groups
        .iter()
        .map(|position| groups[usize::from(*position) - 1].to_string())
        .collect();
    device.service.confirm_recovery_code(&typed).await.unwrap();
    Created {
        username: ticket.username,
        recovery_code: view.recovery_code,
    }
}

fn sign_in_request(target: &Target, username: &str, password: &str) -> SignInRequest {
    SignInRequest {
        endpoint: endpoint_of(target),
        username: username.to_string(),
        password: password.to_string(),
        device_name: "Mac B".to_string(),
    }
}

async fn code_of<T>(result: impl std::future::Future<Output = Result<T, SyncError>>) -> String {
    result.await.err().expect("expected an error").code
}

/// A device that believes it is connected to a server that is not there: whatever is refused
/// before the network is refused with its own code, anything that reaches the network is `network`.
fn device_with_dead_server() -> Device {
    let device = Device::new();
    device
        .secrets
        .set(SECRET_ACCOUNT_KEY, &"ab".repeat(32))
        .unwrap();
    device
        .secrets
        .set(SECRET_DEVICE_TOKEN, &"cd".repeat(32))
        .unwrap();
    device
        .connection
        .save(&ConnectionRecord {
            server_url: "http://127.0.0.1:9".to_string(),
            allow_http: true,
            username: "alice".to_string(),
            device_id: "d1".to_string(),
        })
        .unwrap();
    device
}

#[tokio::test]
async fn a_weak_or_short_new_password_is_refused_before_the_keys_and_the_network() {
    // Р5: the rule of `check_password`, not only the screen
    let device = device_with_dead_server();
    for (password, code) in [
        ("password1234", "weak_password"),
        ("qwertyuiop12", "weak_password"),
        ("short1!", "password_too_short"),
        ("", "password_too_short"),
    ] {
        assert_eq!(
            code_of(device.service.change_password(PASSWORD, password)).await,
            code,
            "{password:?}"
        );
    }
}

#[tokio::test]
async fn a_new_password_equal_to_the_old_one_is_refused_before_the_network() {
    // Р5: nothing to change; told at once, not after a trip to the server
    let device = device_with_dead_server();
    assert_eq!(
        code_of(device.service.change_password(PASSWORD, PASSWORD)).await,
        "password_unchanged"
    );
    // a good, different password does get as far as the (dead) network
    assert_eq!(
        code_of(device.service.change_password(PASSWORD, NEW_PASSWORD)).await,
        "network"
    );
}

#[tokio::test]
async fn a_device_that_is_not_signed_in_cannot_change_the_password() {
    let device = Device::new();
    assert_eq!(
        code_of(device.service.change_password(PASSWORD, NEW_PASSWORD)).await,
        "not_connected"
    );
}

#[tokio::test]
async fn a_changed_password_works_everywhere_and_this_device_keeps_what_it_stored() {
    // Р5: AK and the token of this device are not touched; other devices go on; the old password
    // is gone; the recovery code still opens the account
    let target = Target::from_env();
    let first = Device::new();
    let second = Device::new();
    let created = create_account(&first, &target).await;
    second
        .service
        .sign_in(sign_in_request(&target, &created.username, PASSWORD))
        .await
        .unwrap();
    let before = (
        first.secrets.peek(SECRET_ACCOUNT_KEY),
        first.secrets.peek(SECRET_DEVICE_TOKEN),
        first.connection.load().unwrap(),
    );

    first
        .service
        .change_password(PASSWORD, NEW_PASSWORD)
        .await
        .unwrap();

    // what this device keeps about the keys is exactly what it kept
    assert_eq!(first.secrets.peek(SECRET_ACCOUNT_KEY), before.0);
    assert_eq!(first.secrets.peek(SECRET_DEVICE_TOKEN), before.1);
    assert_eq!(first.connection.load().unwrap(), before.2);
    assert!(first.service.status().unwrap().connected);
    // the other device keeps working
    assert_eq!(second.service.list_devices().await.unwrap().len(), 2);

    // new password in, old password out
    let third = Device::new();
    third
        .service
        .sign_in(sign_in_request(&target, &created.username, NEW_PASSWORD))
        .await
        .unwrap();
    assert_eq!(
        third.secrets.peek(SECRET_ACCOUNT_KEY),
        first.secrets.peek(SECRET_ACCOUNT_KEY)
    );
    let fourth = Device::new();
    assert_eq!(
        code_of(
            fourth
                .service
                .sign_in(sign_in_request(&target, &created.username, PASSWORD))
        )
        .await,
        "invalid_credentials"
    );

    // the recovery code still works
    let fifth = Device::new();
    fifth
        .service
        .recover(RecoverRequest {
            endpoint: endpoint_of(&target),
            username: created.username.clone(),
            recovery_code: created.recovery_code.clone(),
            new_password: "recovered after change 1234".to_string(),
            device_name: "Mac E".to_string(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn a_wrong_old_password_is_told_and_nothing_changes() {
    // Р5: `invalid_proof`; the old password still signs in, the new one does not
    let target = Target::from_env();
    let first = Device::new();
    let created = create_account(&first, &target).await;
    let before = (
        first.secrets.peek(SECRET_ACCOUNT_KEY),
        first.secrets.peek(SECRET_DEVICE_TOKEN),
    );
    assert_eq!(
        code_of(
            first
                .service
                .change_password("not the old password at all 1", NEW_PASSWORD)
        )
        .await,
        "invalid_proof"
    );
    assert_eq!(first.secrets.peek(SECRET_ACCOUNT_KEY), before.0);
    assert_eq!(first.secrets.peek(SECRET_DEVICE_TOKEN), before.1);
    assert!(first.service.status().unwrap().connected);
    Device::new()
        .service
        .sign_in(sign_in_request(&target, &created.username, PASSWORD))
        .await
        .unwrap();
    assert_eq!(
        code_of(Device::new().service.sign_in(sign_in_request(
            &target,
            &created.username,
            NEW_PASSWORD
        )))
        .await,
        "invalid_credentials"
    );
}

#[tokio::test]
async fn a_second_change_after_another_device_changed_the_password_still_works() {
    // П18: the service reads the current version of the keys itself, so a change made from
    // another device in the meantime is not a `keys_conflict` for a person who types the new
    // old password
    let target = Target::from_env();
    let first = Device::new();
    let second = Device::new();
    let created = create_account(&first, &target).await;
    second
        .service
        .sign_in(sign_in_request(&target, &created.username, PASSWORD))
        .await
        .unwrap();
    first
        .service
        .change_password(PASSWORD, NEW_PASSWORD)
        .await
        .unwrap();
    second
        .service
        .change_password(NEW_PASSWORD, "yet another owl password 9")
        .await
        .unwrap();
}

#[tokio::test]
async fn no_password_is_logged_or_put_into_an_error() {
    // О1, Р5: neither the old nor the new password, whatever the libraries print
    let target = Target::from_env();
    let logs = LogCapture::default();
    let device = Device::new();
    let wrong = "not the old password at all 1";
    let (created, failure) = async {
        let created = create_account(&device, &target).await;
        let failure = device
            .service
            .change_password(wrong, NEW_PASSWORD)
            .await
            .expect_err("a wrong old password is refused");
        device
            .service
            .change_password(PASSWORD, NEW_PASSWORD)
            .await
            .unwrap();
        (created, failure)
    }
    .with_subscriber(logs.dispatch())
    .await;
    let printed = logs.text();
    let sent = serde_json::to_string(&failure).unwrap();
    for secret in [
        PASSWORD,
        NEW_PASSWORD,
        wrong,
        created.recovery_code.as_str(),
    ] {
        assert!(!printed.contains(secret), "a secret was logged");
        assert!(!sent.contains(secret), "a secret is in the error");
        assert!(!format!("{failure:?}").contains(secret));
    }
}
