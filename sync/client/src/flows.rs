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

use amby_sync_core::crypto::account::{
    create_account, derive_password_keys, derive_recovery_keys, seal_account_key_for_password,
    unwrap_account_key, Argon2Params, NewAccount,
};
use amby_sync_core::crypto::keys::{AccountKey, AuthKey, Kek};
use amby_sync_core::crypto::name::{open_device_name, seal_device_name, NAME_MAX_BYTES};
use amby_sync_core::crypto::random::{OsRandom, Random};
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use amby_sync_core::crypto::CryptoError;

use crate::api::{DeviceToken, EnrollRequest, ProofKind, ReplaceKeysRequest, Session, SyncClient};
use crate::error::ClientError;

/// Length of a name envelope (Ф34): the server accepts exactly this many bytes.
const NAME_ENVELOPE_LEN: usize = 105;

/// Whether `name` is a user name of the server: ASCII, 1–64 characters of `a-z 0-9 . _ -`, the
/// first and the last a letter or a digit (П11).
pub fn validate_username(name: &str) -> bool {
    let bytes = name.as_bytes();
    let (Some(first), Some(last)) = (bytes.first(), bytes.last()) else {
        return false;
    };
    bytes.len() <= 64
        && first.is_ascii_alphanumeric()
        && last.is_ascii_alphanumeric()
        && !bytes.iter().any(|byte| byte.is_ascii_uppercase())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// A device name the server can take once sealed (Ф34): at most 64 bytes, no zero byte.
fn check_device_name(name: &str) -> Result<(), ClientError> {
    if name.len() > NAME_MAX_BYTES || name.as_bytes().contains(&0) {
        Err(ClientError::InvalidDeviceName)
    } else {
        Ok(())
    }
}

/// The name of a device sealed with AK (Ф34).
fn sealed_name(ak: &AccountKey, name: &str) -> Result<Vec<u8>, ClientError> {
    seal_device_name(ak, name, &mut OsRandom).map_err(|error| match error {
        CryptoError::InvalidParams(_) => ClientError::InvalidDeviceName,
        other => ClientError::Crypto(other),
    })
}

/// What a new device sends as its name before it knows AK: a made-up envelope of the right size.
/// The device is disconnected as soon as the real one exists (see the top of this module).
fn placeholder_name() -> Vec<u8> {
    let mut bytes = vec![0u8; NAME_ENVELOPE_LEN];
    OsRandom.fill(&mut bytes);
    bytes[0] = 1;
    bytes
}

/// Runs heavy key work (Argon2id) on a blocking thread.
async fn blocking<T, F>(work: F) -> Result<T, ClientError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CryptoError> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| ClientError::Crypto(CryptoError::InvalidParams("key derivation stopped")))?
        .map_err(ClientError::from)
}

/// Removes a device that should not stay; a failure is not reported (the person can disconnect
/// it from the list, and the original error is the one worth telling).
async fn drop_device(client: &SyncClient, token: &DeviceToken, device_id: &str) {
    let _ = client.delete_device(token, device_id).await;
}

/// Capitals, no `-` and no spaces: the form the server keeps (П17).
fn clean_enroll_code(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(char::to_uppercase)
        .collect()
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

    /// Replaces the invitation code, keeping the keys and the recovery code (the first one was
    /// refused by the server and the person was already shown the code).
    pub fn set_enroll_code(&mut self, enroll_code: &str) {
        let _ = enroll_code;
        todo!("П17")
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
    if !validate_username(username) {
        return Err(ClientError::InvalidUsername);
    }
    let password = password.to_string();
    let account =
        blocking(move || create_account(&password, &Argon2Params::V1_DEFAULT, &mut OsRandom))
            .await?;
    Ok(PreparedAccount {
        username: username.to_string(),
        enroll_code: clean_enroll_code(enroll_code),
        account,
    })
}

/// Sends a prepared account: the first device with the name `device_name` (П12, Ф34). The
/// password and the code are not sent, only their hashes and the wrapped AK.
pub async fn enroll_prepared(
    client: &SyncClient,
    prepared: &PreparedAccount,
    device_name: &str,
) -> Result<Connected, ClientError> {
    check_device_name(device_name)?;
    let account_key = prepared.account.account_key.clone();
    let name_enc = sealed_name(&account_key, device_name)?;
    let session = client
        .enroll(&EnrollRequest {
            username: &prepared.username,
            enroll_code: &prepared.enroll_code,
            account: &prepared.account,
            device_name_enc: &name_enc,
        })
        .await?;
    Ok(Connected {
        session,
        account_key,
    })
}

/// Signs in on a new device with the password (Р5, П13, П14): prelogin, parameters checked by
/// Ф8, Argon2id, login, AK unwrapped, then the second sign-in under the real name.
pub async fn sign_in(
    client: &SyncClient,
    username: &str,
    password: &str,
    device_name: &str,
) -> Result<Connected, ClientError> {
    check_device_name(device_name)?;
    let pre = client.prelogin(username).await?;
    // Ф8, О8: parameters outside the limits stop us before any work is done or anything is sent.
    pre.params.validate()?;
    let (salt, params, password) = (pre.salt, pre.params, password.to_string());
    let keys = blocking(move || derive_password_keys(&password, &salt, &params)).await?;

    let first = client
        .login(username, &keys.auth_key, &placeholder_name())
        .await?;
    let placeholder = (first.session.device_id.clone(), first.session.token.clone());
    let Some(account_key) = unwrap_ak(&keys.kek, &first.wrapped_ak) else {
        drop_device(client, &placeholder.1, &placeholder.0).await;
        return Err(ClientError::CannotDecrypt);
    };
    let named = match login_named(client, username, &keys.auth_key, &account_key, device_name).await
    {
        Ok(named) => named,
        Err(error) => {
            drop_device(client, &placeholder.1, &placeholder.0).await;
            return Err(error);
        }
    };
    drop_device(client, &named.token, &placeholder.0).await;
    Ok(Connected {
        session: named,
        account_key,
    })
}

fn unwrap_ak(kek: &Kek, wrapped: &[u8]) -> Option<AccountKey> {
    unwrap_account_key(kek, wrapped).ok()
}

/// The second sign-in of a new device, under its real name.
async fn login_named(
    client: &SyncClient,
    username: &str,
    auth_key: &AuthKey,
    account_key: &AccountKey,
    device_name: &str,
) -> Result<Session, ClientError> {
    let name_enc = sealed_name(account_key, device_name)?;
    Ok(client.login(username, auth_key, &name_enc).await?.session)
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
    check_device_name(device_name)?;
    let recovery = derive_recovery_keys(code);
    let first = client
        .recover(username, &recovery.auth_key, &placeholder_name())
        .await?;
    let placeholder = (first.session.device_id.clone(), first.session.token.clone());
    let Some(account_key) = unwrap_ak(&recovery.kek, &first.wrapped_ak_recovery) else {
        drop_device(client, &placeholder.1, &placeholder.0).await;
        return Err(ClientError::CannotDecrypt);
    };

    let result = recover_named(
        client,
        username,
        &recovery.auth_key,
        &account_key,
        new_password,
        device_name,
    )
    .await;
    match result {
        Ok(session) => {
            drop_device(client, &session.token, &placeholder.0).await;
            Ok(Connected {
                session,
                account_key,
            })
        }
        Err(error) => {
            drop_device(client, &placeholder.1, &placeholder.0).await;
            Err(error)
        }
    }
}

/// The second half of a recovery: a named device, then the new password under the proof of the
/// code. When setting the password fails, the named device is disconnected again.
async fn recover_named(
    client: &SyncClient,
    username: &str,
    recovery_auth_key: &AuthKey,
    account_key: &AccountKey,
    new_password: &str,
    device_name: &str,
) -> Result<Session, ClientError> {
    let name_enc = sealed_name(account_key, device_name)?;
    let (ak, password) = (account_key.clone(), new_password.to_string());
    let envelope = blocking(move || {
        seal_account_key_for_password(&password, &ak, &Argon2Params::V1_DEFAULT, &mut OsRandom)
    })
    .await?;
    let named = client
        .recover(username, recovery_auth_key, &name_enc)
        .await?;
    let mut session = named.session;
    let replaced = client
        .replace_keys(
            &session.token,
            &ReplaceKeysRequest {
                base_keys_version: session.keys_version,
                proof_kind: ProofKind::Recovery,
                proof_auth_key: recovery_auth_key,
                envelope: &envelope,
            },
        )
        .await;
    match replaced {
        Ok(version) => {
            session.keys_version = version;
            Ok(session)
        }
        Err(error) => {
            drop_device(client, &session.token, &session.device_id).await;
            Err(error)
        }
    }
}

/// The devices of the account with their names opened by AK (П19, Ф34).
pub async fn list_devices(
    client: &SyncClient,
    token: &DeviceToken,
    account_key: &AccountKey,
) -> Result<Vec<Device>, ClientError> {
    Ok(client
        .devices(token)
        .await?
        .into_iter()
        .map(|entry| Device {
            name: open_device_name(account_key, &entry.name_enc).ok(),
            device_id: entry.device_id,
            created_ms: entry.created_ms,
            last_seen_ms: entry.last_seen_ms,
            current: entry.current,
        })
        .collect())
}

/// Disconnects a device: its token stops working at once (Р5, П19).
pub async fn disconnect_device(
    client: &SyncClient,
    token: &DeviceToken,
    device_id: &str,
) -> Result<(), ClientError> {
    client.delete_device(token, device_id).await
}
