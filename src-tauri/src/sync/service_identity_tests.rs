//! Account and device identity changes (Ф34): names are mutable metadata, while the account key,
//! device tokens, spaces and encrypted vault state remain unchanged.

use amby_sync_conformance::Target;

use super::connection::ConnectionStore;
use super::secrets::{SecretStore, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use super::service::{PrepareRequest, SignInRequest};
use super::test_support::{endpoint_of, Device};
use super::types::SyncError;

const PASSWORD: &str = "Correct-Horse-Battery-Staple-42!";

struct Created {
    username: String,
    recovery_code: String,
}

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
    let typed = view
        .confirm_groups
        .iter()
        .map(|position| groups[usize::from(*position) - 1].to_string())
        .collect::<Vec<_>>();
    device.service.confirm_recovery_code(&typed).await.unwrap();
    Created {
        username: ticket.username,
        recovery_code: view.recovery_code,
    }
}

fn sign_in_request(target: &Target, username: &str, device_name: &str) -> SignInRequest {
    SignInRequest {
        endpoint: endpoint_of(target),
        username: username.to_string(),
        password: PASSWORD.to_string(),
        device_name: device_name.to_string(),
    }
}

async fn code_of<T: std::fmt::Debug>(
    result: impl std::future::Future<Output = Result<T, SyncError>>,
) -> String {
    result
        .await
        .expect_err("the identity operation should fail")
        .code
}

fn dead_device() -> Device {
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
        .save(&super::connection::ConnectionRecord {
            server_url: "http://127.0.0.1:9".to_string(),
            allow_http: true,
            username: "alice".to_string(),
            device_id: "d1".to_string(),
        })
        .unwrap();
    device
}

#[tokio::test]
async fn account_rename_changes_only_the_login_name_and_keeps_existing_sessions() {
    let target = Target::from_env();
    let first = Device::new();
    let second = Device::new();
    let created = create_account(&first, &target).await;
    second
        .service
        .sign_in(sign_in_request(&target, &created.username, "Mac B"))
        .await
        .unwrap();
    let account_key = first.secrets.peek(SECRET_ACCOUNT_KEY);
    let device_token = first.secrets.peek(SECRET_DEVICE_TOKEN);
    let device_id = first.connection.load().unwrap().unwrap().device_id;

    let renamed = first.service.rename_account("bob", PASSWORD).await.unwrap();

    assert_eq!(renamed.username.as_deref(), Some("bob"));
    assert_eq!(
        first.service.status().unwrap().username.as_deref(),
        Some("bob")
    );
    assert_eq!(first.secrets.peek(SECRET_ACCOUNT_KEY), account_key);
    assert_eq!(first.secrets.peek(SECRET_DEVICE_TOKEN), device_token);
    assert_eq!(
        first.connection.load().unwrap().unwrap().device_id,
        device_id
    );
    assert!(second.service.list_devices().await.is_ok());
    assert_eq!(
        second.service.status().unwrap().username.as_deref(),
        Some("bob")
    );

    // Existing keys and tokens remain valid; only the login identifier changed.
    let third = Device::new();
    third
        .service
        .sign_in(sign_in_request(&target, "bob", "Mac C"))
        .await
        .unwrap();
    assert_eq!(
        code_of(Device::new().service.sign_in(SignInRequest {
            endpoint: endpoint_of(&target),
            username: created.username,
            password: PASSWORD.to_string(),
            device_name: "Mac D".to_string(),
        }))
        .await,
        "invalid_credentials"
    );
}

#[tokio::test]
async fn wrong_password_does_not_rename_account_or_change_local_state() {
    let target = Target::from_env();
    let device = Device::new();
    let created = create_account(&device, &target).await;
    let before = device.connection.load().unwrap();
    let key = device.secrets.peek(SECRET_ACCOUNT_KEY);
    let token = device.secrets.peek(SECRET_DEVICE_TOKEN);

    assert_eq!(
        code_of(
            device
                .service
                .rename_account("bob", "not the password 123!")
        )
        .await,
        "invalid_proof"
    );
    assert_eq!(device.connection.load().unwrap(), before);
    assert_eq!(device.secrets.peek(SECRET_ACCOUNT_KEY), key);
    assert_eq!(device.secrets.peek(SECRET_DEVICE_TOKEN), token);
    Device::new()
        .service
        .sign_in(sign_in_request(&target, &created.username, "Mac B"))
        .await
        .unwrap();
}

#[tokio::test]
async fn account_rename_validates_before_network_and_rejects_collision() {
    let dead = dead_device();
    for name in ["", "Alice", "bad name", "-bad", "bad-"] {
        assert_eq!(
            code_of(dead.service.rename_account(name, PASSWORD)).await,
            "invalid_username",
            "{name:?}"
        );
    }

    let target = Target::from_env();
    let first = Device::new();
    let second = Device::new();
    let first_account = create_account(&first, &target).await;
    let second_account = create_account(&second, &target).await;
    assert_eq!(
        code_of(
            first
                .service
                .rename_account(&second_account.username, PASSWORD)
        )
        .await,
        "username_taken"
    );
    assert_eq!(
        first.service.status().unwrap().username.as_deref(),
        Some(first_account.username.as_str())
    );
}

#[tokio::test]
async fn device_rename_is_encrypted_metadata_and_keeps_the_token_and_other_devices_working() {
    let target = Target::from_env();
    let first = Device::new();
    let second = Device::new();
    let created = create_account(&first, &target).await;
    second
        .service
        .sign_in(sign_in_request(&target, &created.username, "Windows PC"))
        .await
        .unwrap();
    let token = first.secrets.peek(SECRET_DEVICE_TOKEN);
    let device_id = first.connection.load().unwrap().unwrap().device_id;

    first
        .service
        .rename_device(&device_id, "MacBook дома")
        .await
        .unwrap();

    assert_eq!(first.secrets.peek(SECRET_DEVICE_TOKEN), token);
    assert!(second
        .service
        .list_devices()
        .await
        .unwrap()
        .iter()
        .any(|device| {
            device.device_id == device_id && device.name.as_deref() == Some("MacBook дома")
        }));
    assert!(first
        .service
        .list_devices()
        .await
        .unwrap()
        .iter()
        .any(|device| { device.current && device.name.as_deref() == Some("MacBook дома") }));
}

#[tokio::test]
async fn device_rename_validates_without_network_and_does_not_allow_a_foreign_device() {
    let dead = dead_device();
    for name in ["", "a".repeat(65).as_str(), "bad\0name"] {
        assert_eq!(
            code_of(dead.service.rename_device("d1", name)).await,
            "invalid_device_name",
            "{name:?}"
        );
    }

    let target = Target::from_env();
    let first = Device::new();
    let second = Device::new();
    create_account(&first, &target).await;
    create_account(&second, &target).await;
    let foreign_id = second.connection.load().unwrap().unwrap().device_id;
    assert_eq!(
        code_of(first.service.rename_device(&foreign_id, "Not mine")).await,
        "not_found"
    );
}

#[tokio::test]
async fn recovery_code_still_works_after_account_rename() {
    let target = Target::from_env();
    let device = Device::new();
    let created = create_account(&device, &target).await;
    device
        .service
        .rename_account("bob", PASSWORD)
        .await
        .unwrap();
    let recovery = Device::new();
    recovery
        .service
        .recover(super::service::RecoverRequest {
            endpoint: endpoint_of(&target),
            username: "bob".to_string(),
            recovery_code: created.recovery_code,
            new_password: "Recovered-After-Rename-1234!".to_string(),
            device_name: "Recovery Mac".to_string(),
        })
        .await
        .unwrap();
}
