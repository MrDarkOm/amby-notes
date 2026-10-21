//! The flows of the connect screen (Р5, О1, О3, О8; П11–П19), without Tauri so that they are
//! tested against a real server in the process.
//!
//! **The recovery code comes before the account.** `prepare_account` makes the keys on this
//! device and keeps them in memory only; `confirm_recovery_code` sends them after the person has
//! typed back some groups of the code. So the server never holds an account whose code nobody has
//! seen, and the one-time code of the administrator is not burned by a person who gave up.

use std::sync::{Arc, Mutex, MutexGuard};

use amby_sync_client::{
    disconnect_device, enroll_prepared, list_devices, prepare_account, recover_account, sign_in,
    validate_username, ClientError, Connected, DeviceToken, PreparedAccount, ServerUrl, SyncClient,
};
use amby_sync_core::crypto::keys::AccountKey;
use amby_sync_core::crypto::random::{OsRandom, Random};
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use zeroize::Zeroizing;

use crate::sync::connection::{ConnectionError, ConnectionRecord, ConnectionStore};
use crate::sync::password::check_password;
use crate::sync::secrets::{SecretError, SecretStore, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use crate::sync::types::{
    DeviceView, Endpoint, PreparedAccountView, ServerCheck, SignOutResult, SyncError, SyncStatus,
};

/// The name of the program in `/v1/info` (П9).
const SERVER_NAME: &str = "amby-sync-server";
/// How many groups the recovery code has (Ф30) and how many of them the person types back.
const CODE_GROUPS: u8 = 14;
const CONFIRM_GROUPS: usize = 2;
/// The longest device name, in bytes (Ф34); checked early so the person hears about it before
/// copying a code.
const DEVICE_NAME_MAX_BYTES: usize = 64;

/// What the person typed to create an account.
#[derive(Clone)]
pub struct PrepareRequest {
    /// The server.
    pub endpoint: Endpoint,
    /// The user name given by the administrator (П11).
    pub username: String,
    /// The one-time code of the administrator (П17).
    pub enroll_code: String,
    /// The new password.
    pub password: String,
    /// The name of this device (at most 64 bytes, Ф34).
    pub device_name: String,
}

/// What the person typed to sign in on a new device.
#[derive(Clone)]
pub struct SignInRequest {
    /// The server.
    pub endpoint: Endpoint,
    /// The user name.
    pub username: String,
    /// The password.
    pub password: String,
    /// The name of this device.
    pub device_name: String,
}

/// What the person typed to recover a forgotten password.
#[derive(Clone)]
pub struct RecoverRequest {
    /// The server.
    pub endpoint: Endpoint,
    /// The user name.
    pub username: String,
    /// The recovery code as typed (Ф30 accepts small letters, spaces and look-alikes).
    pub recovery_code: String,
    /// The new password.
    pub new_password: String,
    /// The name of this device.
    pub device_name: String,
}

macro_rules! redacted_debug {
    ($name:ident) => {
        impl core::fmt::Debug for $name {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.debug_struct(stringify!($name)).finish_non_exhaustive()
            }
        }
    };
}
redacted_debug!(PrepareRequest);
redacted_debug!(SignInRequest);
redacted_debug!(RecoverRequest);

/// An account that is waiting for the confirmation of its recovery code.
struct Pending {
    url: ServerUrl,
    allow_http: bool,
    device_name: String,
    prepared: PreparedAccount,
    /// The 1-based positions of the groups the person has to type back.
    positions: Vec<u8>,
    /// The groups at those positions, as they are printed.
    expected: Vec<Zeroizing<String>>,
}

/// The sign-in flows with their state.
pub struct SyncService {
    secrets: Arc<dyn SecretStore>,
    connection: Arc<dyn ConnectionStore>,
    pending: Mutex<Option<Arc<Pending>>>,
}

impl From<SecretError> for SyncError {
    fn from(_: SecretError) -> Self {
        SyncError::new("keychain_unavailable")
    }
}

impl From<ConnectionError> for SyncError {
    fn from(_: ConnectionError) -> Self {
        SyncError::new("storage_error")
    }
}

fn to_hex(bytes: &[u8]) -> Zeroizing<String> {
    let mut text = Zeroizing::new(String::with_capacity(bytes.len() * 2));
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

fn from_hex_32(text: &str) -> Option<Zeroizing<[u8; 32]>> {
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    for (index, pair) in text.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(pair).ok()?;
        bytes[index] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(bytes)
}

/// A group as the code reads it: capitals, `O` is `0`, `I` and `L` are `1` (Ф30).
fn canonical_group(group: &str) -> String {
    group
        .trim()
        .chars()
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect()
}

/// Two different positions from 1 to 14, in ascending order.
fn pick_positions() -> Vec<u8> {
    let mut rng = OsRandom;
    let mut positions: Vec<u8> = Vec::new();
    while positions.len() < CONFIRM_GROUPS {
        let mut byte = [0u8; 1];
        rng.fill(&mut byte);
        // 252 is the greatest multiple of 14 that fits a byte: no position is likelier.
        if byte[0] >= 252 {
            continue;
        }
        let position = byte[0] % CODE_GROUPS + 1;
        if !positions.contains(&position) {
            positions.push(position);
        }
    }
    positions.sort_unstable();
    positions
}

/// What the key store and the record say about this device.
struct Session {
    record: ConnectionRecord,
    account_key: AccountKey,
    token: DeviceToken,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while the lock was held does not make the state unusable: it is only a prepared
    // account in memory.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl SyncService {
    /// A service over a place for secrets and a place for the connection record.
    pub fn new(secrets: Arc<dyn SecretStore>, connection: Arc<dyn ConnectionStore>) -> Self {
        Self {
            secrets,
            connection,
            pending: Mutex::new(None),
        }
    }

    fn url_of(endpoint: &Endpoint) -> Result<ServerUrl, SyncError> {
        Ok(ServerUrl::parse(&endpoint.url, endpoint.allow_http)?)
    }

    fn client_of(url: &ServerUrl) -> Result<SyncClient, SyncError> {
        Ok(SyncClient::new(url)?)
    }

    /// The state of the connection; reads the record and checks that the key store still holds
    /// AK and the token. Does not touch the network.
    pub fn status(&self) -> Result<SyncStatus, SyncError> {
        let pending = lock(&self.pending).is_some();
        let Some(record) = self.connection.load()? else {
            return Ok(SyncStatus {
                connected: false,
                keys_missing: false,
                pending,
                server_url: None,
                host: None,
                username: None,
                device_id: None,
                allow_http: false,
            });
        };
        let has_keys = self.secrets.get(SECRET_ACCOUNT_KEY)?.is_some()
            && self.secrets.get(SECRET_DEVICE_TOKEN)?.is_some();
        let host = ServerUrl::parse(&record.server_url, record.allow_http)
            .ok()
            .map(|url| url.host_display());
        Ok(SyncStatus {
            connected: has_keys,
            keys_missing: !has_keys,
            pending,
            server_url: Some(record.server_url),
            host,
            username: Some(record.username),
            device_id: Some(record.device_id),
            allow_http: record.allow_http,
        })
    }

    /// `/v1/info` of the server (П9): the address is checked by the `https://` rule (П41) and the
    /// protocol range is compared (Р13).
    pub async fn check_server(&self, endpoint: &Endpoint) -> Result<ServerCheck, SyncError> {
        let url = Self::url_of(endpoint)?;
        let info = Self::client_of(&url)?.info().await?;
        if info.server != SERVER_NAME {
            return Err(ClientError::BadResponse("this is not an Amby sync server").into());
        }
        info.check_protocol()?;
        Ok(ServerCheck {
            url: url.as_str().to_string(),
            host: url.host_display(),
            server_version: info.server_version,
            instance_id: info.instance_id,
        })
    }

    /// Fails with `already_connected` while this device is signed in.
    fn require_not_connected(&self) -> Result<(), SyncError> {
        if self.status()?.connected {
            return Err(SyncError::new("already_connected"));
        }
        Ok(())
    }

    /// Fails with `password_too_short` or `weak_password` (Р5).
    fn require_good_password(password: &str, username: &str) -> Result<(), SyncError> {
        let verdict = check_password(password, &[username]);
        if verdict.too_short {
            return Err(SyncError::new("password_too_short"));
        }
        if !verdict.ok {
            return Err(SyncError::new("weak_password"));
        }
        Ok(())
    }

    fn require_device_name(name: &str) -> Result<(), SyncError> {
        if name.len() > DEVICE_NAME_MAX_BYTES || name.contains('\0') {
            return Err(SyncError::new("invalid_device_name"));
        }
        Ok(())
    }

    /// Makes the keys of a new account and keeps them in memory (`weak_password` /
    /// `password_too_short` before any work; `already_connected` while signed in). Replaces an
    /// earlier prepared account. Nothing is sent and nothing is stored.
    pub async fn prepare_account(
        &self,
        request: PrepareRequest,
    ) -> Result<PreparedAccountView, SyncError> {
        self.require_not_connected()?;
        if !validate_username(&request.username) {
            return Err(SyncError::new("invalid_username"));
        }
        Self::require_device_name(&request.device_name)?;
        Self::require_good_password(&request.password, &request.username)?;
        let url = Self::url_of(&request.endpoint)?;
        let prepared =
            prepare_account(&request.username, &request.enroll_code, &request.password).await?;

        let shown = Zeroizing::new(prepared.recovery_code().to_display());
        let groups: Vec<&str> = shown.split('-').collect();
        let positions = pick_positions();
        let expected = positions
            .iter()
            .map(|position| Zeroizing::new(groups[usize::from(*position) - 1].to_string()))
            .collect();
        let view = PreparedAccountView {
            recovery_code: shown.to_string(),
            confirm_groups: positions.clone(),
        };
        *lock(&self.pending) = Some(Arc::new(Pending {
            url,
            allow_http: request.endpoint.allow_http,
            device_name: request.device_name,
            prepared,
            positions,
            expected,
        }));
        tracing::info!(event = "sync_account_prepared");
        Ok(view)
    }

    /// The person typed back `groups` (the groups asked by `prepare_account`, in that order).
    /// Right: the account is sent to the server, AK and the token go to the key store and the
    /// record to the connection store. Wrong: `recovery_confirmation_mismatch` and the prepared
    /// account stays. No prepared account: `no_pending_account`.
    pub async fn confirm_recovery_code(&self, groups: &[String]) -> Result<SyncStatus, SyncError> {
        let pending = lock(&self.pending)
            .clone()
            .ok_or_else(|| SyncError::new("no_pending_account"))?;
        let matches = groups.len() == pending.expected.len()
            && groups
                .iter()
                .zip(&pending.expected)
                .all(|(typed, expected)| canonical_group(typed) == expected.as_str());
        if !matches {
            return Err(SyncError::new("recovery_confirmation_mismatch"));
        }
        debug_assert_eq!(pending.positions.len(), CONFIRM_GROUPS);

        let client = Self::client_of(&pending.url)?;
        let connected = enroll_prepared(&client, &pending.prepared, &pending.device_name).await?;
        // The account exists on the server now and its one-time code is used: whatever happens
        // next, a prepared account is of no further use.
        self.clear_pending_if(&pending);
        self.finish_connect(
            &client,
            &pending.url,
            pending.allow_http,
            pending.prepared.username(),
            connected,
        )
        .await
    }

    fn clear_pending_if(&self, pending: &Arc<Pending>) {
        let mut slot = lock(&self.pending);
        if slot.as_ref().is_some_and(|held| Arc::ptr_eq(held, pending)) {
            *slot = None;
        }
    }

    /// Replaces the invitation code of the prepared account; the keys and the recovery code stay.
    /// `no_pending_account` when there is none.
    pub fn set_enroll_code(&self, enroll_code: &str) -> Result<(), SyncError> {
        let _ = enroll_code;
        todo!("П17")
    }

    /// Forgets the prepared account.
    pub fn cancel_pending(&self) {
        *lock(&self.pending) = None;
    }

    /// Stores AK and the token in the key store and the record in the connection store. When any
    /// step fails nothing stays on this device and the device that was just made on the server is
    /// disconnected again.
    async fn finish_connect(
        &self,
        client: &SyncClient,
        url: &ServerUrl,
        allow_http: bool,
        username: &str,
        connected: Connected,
    ) -> Result<SyncStatus, SyncError> {
        let Connected {
            session,
            account_key,
        } = connected;
        let stored = self
            .secrets
            .set(SECRET_ACCOUNT_KEY, &to_hex(account_key.as_bytes()))
            .and_then(|()| {
                self.secrets
                    .set(SECRET_DEVICE_TOKEN, session.token.expose())
            });
        let failure = match stored {
            Err(error) => Some(SyncError::from(error)),
            Ok(()) => self
                .connection
                .save(&ConnectionRecord {
                    server_url: url.as_str().to_string(),
                    allow_http,
                    username: username.to_string(),
                    device_id: session.device_id.clone(),
                })
                .err()
                .map(SyncError::from),
        };
        if let Some(error) = failure {
            let _ = self.secrets.delete(SECRET_ACCOUNT_KEY);
            let _ = self.secrets.delete(SECRET_DEVICE_TOKEN);
            let _ = self.connection.clear();
            let _ = disconnect_device(client, &session.token, &session.device_id).await;
            return Err(error);
        }
        tracing::info!(event = "sync_connected", host = %url.host_display());
        self.status()
    }

    /// Signs in on this device with the password (Р5).
    pub async fn sign_in(&self, request: SignInRequest) -> Result<SyncStatus, SyncError> {
        self.require_not_connected()?;
        Self::require_device_name(&request.device_name)?;
        let url = Self::url_of(&request.endpoint)?;
        let client = Self::client_of(&url)?;
        let connected = sign_in(
            &client,
            &request.username,
            &request.password,
            &request.device_name,
        )
        .await?;
        self.finish_connect(
            &client,
            &url,
            request.endpoint.allow_http,
            &request.username,
            connected,
        )
        .await
    }

    /// Replaces a forgotten password with the recovery code and signs in (Р5, О3).
    pub async fn recover(&self, request: RecoverRequest) -> Result<SyncStatus, SyncError> {
        self.require_not_connected()?;
        Self::require_device_name(&request.device_name)?;
        let code = RecoveryCode::parse(&request.recovery_code)
            .map_err(|_| SyncError::new("invalid_recovery_code"))?;
        Self::require_good_password(&request.new_password, &request.username)?;
        let url = Self::url_of(&request.endpoint)?;
        let client = Self::client_of(&url)?;
        let connected = recover_account(
            &client,
            &request.username,
            &code,
            &request.new_password,
            &request.device_name,
        )
        .await?;
        self.finish_connect(
            &client,
            &url,
            request.endpoint.allow_http,
            &request.username,
            connected,
        )
        .await
    }

    /// The record and the secrets of this device, or `not_connected`.
    fn session(&self) -> Result<Session, SyncError> {
        let record = self
            .connection
            .load()?
            .ok_or_else(|| SyncError::new("not_connected"))?;
        let account_key = self
            .secrets
            .get(SECRET_ACCOUNT_KEY)?
            .and_then(|text| from_hex_32(&text))
            .ok_or_else(|| SyncError::new("not_connected"))?;
        let token = self
            .secrets
            .get(SECRET_DEVICE_TOKEN)?
            .ok_or_else(|| SyncError::new("not_connected"))?;
        Ok(Session {
            record,
            account_key: AccountKey::from_bytes(*account_key),
            token: DeviceToken::new(token),
        })
    }

    fn client_of_record(record: &ConnectionRecord) -> Result<SyncClient, SyncError> {
        let url = ServerUrl::parse(&record.server_url, record.allow_http)?;
        Self::client_of(&url)
    }

    /// Removes AK, the token and the record from this device. The secrets go first: a record
    /// without secrets is the "sign in again" state, secrets without a record would be invisible.
    fn forget_local(&self) -> Result<(), SyncError> {
        self.secrets.delete(SECRET_ACCOUNT_KEY)?;
        self.secrets.delete(SECRET_DEVICE_TOKEN)?;
        self.connection.clear()?;
        Ok(())
    }

    /// When the server says this device is not welcome any more, forget it here as well.
    fn forget_if_revoked(&self, error: &ClientError) {
        if matches!(error.code(), "token_revoked" | "unauthorized") {
            tracing::info!(event = "sync_device_revoked");
            let _ = self.forget_local();
        }
    }

    /// The devices of the account (П19). A revoked token (`token_revoked`) signs this device out
    /// locally and is reported as such.
    pub async fn list_devices(&self) -> Result<Vec<DeviceView>, SyncError> {
        let session = self.session()?;
        let client = Self::client_of_record(&session.record)?;
        match list_devices(&client, &session.token, &session.account_key).await {
            Ok(devices) => Ok(devices
                .into_iter()
                .map(|device| DeviceView {
                    device_id: device.device_id,
                    name: device.name,
                    created_ms: device.created_ms,
                    last_seen_ms: device.last_seen_ms,
                    current: device.current,
                })
                .collect()),
            Err(error) => {
                self.forget_if_revoked(&error);
                Err(error.into())
            }
        }
    }

    /// Disconnects another device (П19, Р5); the current device is signed out instead.
    pub async fn disconnect_device(&self, device_id: &str) -> Result<(), SyncError> {
        let session = self.session()?;
        if session.record.device_id == device_id {
            self.sign_out().await?;
            return Ok(());
        }
        let client = Self::client_of_record(&session.record)?;
        match disconnect_device(&client, &session.token, device_id).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.forget_if_revoked(&error);
                Err(error.into())
            }
        }
    }

    /// Signs this device out: the server is told (best effort), AK, the token and the record are
    /// removed here in every case.
    pub async fn sign_out(&self) -> Result<SignOutResult, SyncError> {
        let session = match self.session() {
            Ok(session) => Some(session),
            Err(error) if error.code == "not_connected" => None,
            Err(error) => return Err(error),
        };
        let mut server_notified = true;
        if let Some(session) = &session {
            server_notified = match Self::client_of_record(&session.record) {
                Ok(client) => {
                    match disconnect_device(&client, &session.token, &session.record.device_id)
                        .await
                    {
                        Ok(()) => true,
                        // Already gone from the server: nothing is left to tell.
                        Err(error) => {
                            matches!(error.code(), "token_revoked" | "unauthorized" | "not_found")
                        }
                    }
                }
                Err(_) => false,
            };
        }
        self.forget_local()?;
        tracing::info!(event = "sync_signed_out", server_notified);
        Ok(SignOutResult { server_notified })
    }
}
