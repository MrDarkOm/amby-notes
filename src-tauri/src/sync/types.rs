//! What crosses the IPC border for sync (Specta). Errors are a machine code and nothing else:
//! the interface translates the code, so no text of a server and no platform detail reaches the
//! person or a log (П4, `credentials.rs` does the same for the key store).

use amby_sync_client::ClientError;
use serde::{Deserialize, Serialize};

/// A failed sync command: a stable machine code (the codes of table Б.0.1, the codes of
/// [`ClientError::code`], and the codes of the application below) and, for a rate limit, the
/// seconds to wait.
///
/// Codes of the application: `weak_password`, `password_too_short`, `no_pending_account`,
/// `recovery_confirmation_mismatch`, `invalid_recovery_code`, `not_connected`,
/// `already_connected`, `keychain_unavailable`, `storage_error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    /// The machine code.
    pub code: String,
    /// Seconds to wait before the next try (`rate_limited`).
    pub retry_after_secs: Option<u64>,
}

impl SyncError {
    /// An error of the application with `code` and no waiting time.
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            retry_after_secs: None,
        }
    }
}

impl From<ClientError> for SyncError {
    /// The code of the client error and its `Retry-After` (П4, П16); nothing else is copied.
    fn from(error: ClientError) -> Self {
        Self {
            code: error.code().to_string(),
            retry_after_secs: error.retry_after_secs(),
        }
    }
}

impl core::fmt::Display for SyncError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.code)
    }
}

/// Where a command should go: the address as typed and the "local network" switch (П41).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// The address as the person typed it.
    pub url: String,
    /// Plain `http://` is allowed for any host (explicit choice, with a warning in the UI).
    pub allow_http: bool,
}

/// The state of the connection as the interface needs it. No secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// This device is signed in: the record exists and the key store holds AK and the token.
    pub connected: bool,
    /// A record exists but the key store lost AK or the token (cleared keychain): the person
    /// has to sign in again.
    pub keys_missing: bool,
    /// An account was prepared and waits for the confirmation of the recovery code.
    pub pending: bool,
    /// The address of the server, normalised.
    pub server_url: Option<String>,
    /// The host for "connected to …".
    pub host: Option<String>,
    /// The user name on the server.
    pub username: Option<String>,
    /// The identifier of this device on the server.
    pub device_id: Option<String>,
    /// Whether the server was added with the "local network" switch.
    pub allow_http: bool,
}

/// The answer of "check the server" (`/v1/info`, П9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerCheck {
    /// The normalised address.
    pub url: String,
    /// The host for display.
    pub host: String,
    /// The version of the server program.
    pub server_version: String,
    /// `instance_id` (П10).
    pub instance_id: String,
}

/// The verdict on a password (Р5: 12 characters and a sufficient `zxcvbn` score).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PasswordCheck {
    /// The password is accepted.
    pub ok: bool,
    /// The `zxcvbn` score, 0 (worst) to 4.
    pub score: u8,
    /// The length in characters.
    pub length: u32,
    /// The least length accepted (12).
    pub min_length: u32,
    /// The password is shorter than the least length.
    pub too_short: bool,
    /// A machine name of the main weakness found (`zxcvbn` warning), if any.
    pub warning: Option<String>,
    /// Machine names of the advice of `zxcvbn`.
    pub suggestions: Vec<String>,
}

/// The recovery code of a prepared account and the groups the person has to type back.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAccountView {
    /// The code as printed: 14 groups of four symbols joined by `-` (Ф30). Shown once.
    pub recovery_code: String,
    /// Two different positions, from 1 to 14, in ascending order.
    pub confirm_groups: Vec<u8>,
}

impl core::fmt::Debug for PreparedAccountView {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("PreparedAccountView")
            .field("confirm_groups", &self.confirm_groups)
            .finish_non_exhaustive()
    }
}

/// A device in the list (П19, Ф34).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    /// The identifier on the server.
    pub device_id: String,
    /// The name, or `None` when it cannot be read.
    pub name: Option<String>,
    /// Created, Unix milliseconds.
    pub created_ms: i64,
    /// Last seen by the server, Unix milliseconds.
    pub last_seen_ms: i64,
    /// This device.
    pub current: bool,
}

/// The result of signing out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SignOutResult {
    /// The server was told to disconnect this device. `false` when it could not be reached: the
    /// device is signed out here anyway and can be disconnected from another device.
    pub server_notified: bool,
}
