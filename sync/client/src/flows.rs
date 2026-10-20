//! The sign-in flows of the application, built from the requests and the cryptography
//! (Р5, О1, О3, О8): create an account on the first device, sign in on a new device, recover a
//! forgotten password with the code. Passwords and keys exist only inside these functions and in
//! the values they return; nothing is logged.
//!
//! **A new device cannot seal its name yet.** The key of names is derived from AK (Ф34), and a
//! device that is just signing in does not have AK before the server answers. So `sign_in` and
//! `recover_account` sign in with a placeholder name, read AK, sign in again with the real name
//! and disconnect the placeholder device: the list of devices shows every device by the name it
//! chose, and a placeholder never stays in it.

use amby_sync_core::crypto::account::NewAccount;
use amby_sync_core::crypto::keys::AccountKey;
use amby_sync_core::crypto::recovery_code::RecoveryCode;

use crate::api::{DeviceToken, Session, SyncClient};
use crate::error::ClientError;

/// Whether `name` is a user name of the server: ASCII, 1–64 characters of `a-z 0-9 . _ -`, the
/// first and the last a letter or a digit (П11).
pub fn validate_username(name: &str) -> bool {
    let _ = name;
    todo!("П11")
}

/// An account made on this device and not sent yet (Р5, «Первое устройство»). The recovery code
/// is shown to the person first; only when they confirm it, [`enroll_prepared`] sends the
/// encrypted keys, so the server never holds an account whose code nobody saw.
pub struct PreparedAccount {
    username: String,
    enroll_code: String,
    account: NewAccount,
}

impl PreparedAccount {
    /// The user name the account was made for.
    pub fn username(&self) -> &str {
        &self.username
    }

    /// The recovery code to show (О3).
    pub fn recovery_code(&self) -> &RecoveryCode {
        &self.account.recovery_code
    }
}

impl core::fmt::Debug for PreparedAccount {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("PreparedAccount")
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

/// A device that is signed in, with the key of the account.
pub struct Connected {
    /// The device and its token.
    pub session: Session,
    /// AK, to be kept in the system key store only (Р5).
    pub account_key: AccountKey,
}

impl core::fmt::Debug for Connected {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Connected")
            .field("session", &self.session)
            .finish_non_exhaustive()
    }
}

/// A device as the list shows it (П19, Ф34).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// The identifier of the device.
    pub device_id: String,
    /// Its name, or `None` when it cannot be read with this AK.
    pub name: Option<String>,
    /// Created, Unix milliseconds.
    pub created_ms: i64,
    /// Last seen by the server, Unix milliseconds.
    pub last_seen_ms: i64,
    /// Whether it is the device that asked.
    pub current: bool,
}

/// Makes the keys of a new account on this device: the salt, AK, the recovery code and the
/// envelopes (`create_account`, Р5, О1). Nothing is sent. The user name must be a valid name
/// (`InvalidUsername`); the one-time code is cleaned (capitals, no `-` and spaces). Argon2id runs
/// on a blocking thread.
pub async fn prepare_account(
    username: &str,
    enroll_code: &str,
    password: &str,
) -> Result<PreparedAccount, ClientError> {
    let _ = (username, enroll_code, password);
    todo!("Р5")
}

/// Sends a prepared account: the first device with the name `device_name` (П12, Ф34). The
/// password and the code are not sent, only their hashes and the wrapped AK.
pub async fn enroll_prepared(
    client: &SyncClient,
    prepared: &PreparedAccount,
    device_name: &str,
) -> Result<Connected, ClientError> {
    let _ = (client, prepared, device_name);
    todo!("П12")
}

/// Signs in on a new device with the password (Р5, П13, П14): prelogin, parameters checked by
/// Ф8, Argon2id, login, AK unwrapped, then the second sign-in under the real name.
pub async fn sign_in(
    client: &SyncClient,
    username: &str,
    password: &str,
    device_name: &str,
) -> Result<Connected, ClientError> {
    let _ = (client, username, password, device_name);
    todo!("П14")
}

/// Forgotten password (Р5, О3, П15, П18): signs in with the code, unwraps AK, sets
/// `new_password` (AK stays the same, the data on the server stays readable), and leaves the
/// device signed in under `device_name`.
pub async fn recover_account(
    client: &SyncClient,
    username: &str,
    code: &RecoveryCode,
    new_password: &str,
    device_name: &str,
) -> Result<Connected, ClientError> {
    let _ = (client, username, code, new_password, device_name);
    todo!("П15")
}

/// The devices of the account with their names opened by AK (П19, Ф34).
pub async fn list_devices(
    client: &SyncClient,
    token: &DeviceToken,
    account_key: &AccountKey,
) -> Result<Vec<Device>, ClientError> {
    let _ = (client, token, account_key);
    todo!("П19")
}

/// Disconnects a device: its token stops working at once (Р5, П19).
pub async fn disconnect_device(
    client: &SyncClient,
    token: &DeviceToken,
    device_id: &str,
) -> Result<(), ClientError> {
    let _ = (client, token, device_id);
    todo!("П19")
}
