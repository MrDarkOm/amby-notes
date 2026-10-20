//! One method per request of the sign-in protocol (appendix Б, П9–П19). No flow and no key
//! derivation here: the methods only build the JSON, send it and read the answer.
//!
//! Requests never follow a redirect (a redirect to `http://` would undo the rule of П41), have a
//! time limit, and treat a body that is not what Б says as [`ClientError::BadResponse`].

use core::fmt;

use amby_sync_core::crypto::account::{Argon2Params, NewAccount, PasswordEnvelope};
use amby_sync_core::crypto::keys::AuthKey;
use serde_json::Value;

use crate::error::ClientError;
use crate::url::ServerUrl;

/// The token of a device (П5): 32 random bytes in hex. A secret: never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct DeviceToken(String);

impl DeviceToken {
    /// Wraps the 64 hex characters the server gave.
    pub fn new(hex: String) -> Self {
        Self(hex)
    }

    /// The token as it goes into `Authorization: Bearer`. Handle with care.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for DeviceToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceToken([redacted])")
    }
}

/// A device that the server has just created or recognised (П12, П14, П15).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    /// The identifier of the device (hex, 32 characters).
    pub device_id: String,
    /// Its token.
    pub token: DeviceToken,
    /// The version of the stored keys (П18).
    pub keys_version: u64,
}

/// `GET /v1/info` (П9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    /// `"amby-sync-server"`.
    pub server: String,
    /// The version of the server program, e.g. `0.1.0`.
    pub server_version: String,
    /// Lowest protocol version the server speaks.
    pub protocol_min: u32,
    /// Highest protocol version the server speaks.
    pub protocol_max: u32,
    /// `instance_id`: 32 hex characters (П10).
    pub instance_id: String,
    /// The rest of the answer (limits, retention): shown to the engine later, ignored here (П7).
    pub rest: Value,
}

impl ServerInfo {
    /// Reads the JSON of `/v1/info`. A missing or wrongly typed field is `BadResponse`; unknown
    /// fields are ignored (П7, Р13).
    pub fn from_json(value: &Value) -> Result<Self, ClientError> {
        let _ = value;
        todo!("П9")
    }

    /// Whether protocol 1 is within the range of the server (П9, Р13); otherwise
    /// `UnsupportedServer`.
    pub fn check_protocol(&self) -> Result<(), ClientError> {
        todo!("П9")
    }
}

/// `POST /v1/auth/prelogin` (П13): the salt and the parameters of the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prelogin {
    /// 16 bytes. For a name the server does not know it is a made-up (but stable) salt.
    pub salt: [u8; 16],
    /// The parameters; the caller checks them with `Argon2Params::validate` (Ф8, О8).
    pub params: Argon2Params,
}

/// What `POST /v1/auth/enroll` sends (П12).
#[derive(Debug)]
pub struct EnrollRequest<'a> {
    /// The user name given by the administrator.
    pub username: &'a str,
    /// The one-time code (П17).
    pub enroll_code: &'a str,
    /// The keys made on this device (`create_account`).
    pub account: &'a NewAccount,
    /// The device name sealed by Ф34 (105 bytes).
    pub device_name_enc: &'a [u8],
}

/// `POST /v1/auth/login` answer (П14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginAnswer {
    /// The new device.
    pub session: Session,
    /// The salt of the password.
    pub salt: [u8; 16],
    /// The parameters of the password.
    pub params: Argon2Params,
    /// AK wrapped by the KEK of the password (73 bytes).
    pub wrapped_ak: Vec<u8>,
}

/// `POST /v1/auth/recover` answer (П15).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverAnswer {
    /// The new device.
    pub session: Session,
    /// AK wrapped by the recovery KEK (73 bytes).
    pub wrapped_ak_recovery: Vec<u8>,
}

/// `GET /v1/keys` answer (П18).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeysAnswer {
    /// The current version of the keys.
    pub keys_version: u64,
    /// The salt of the password.
    pub salt: [u8; 16],
    /// The parameters of the password.
    pub params: Argon2Params,
    /// AK wrapped by the KEK of the password.
    pub wrapped_ak: Vec<u8>,
    /// AK wrapped by the recovery KEK.
    pub wrapped_ak_recovery: Vec<u8>,
}

/// What proves the right to replace the keys (П18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofKind {
    /// The old password (its `auth_key`).
    Password,
    /// The recovery code (its `recovery_auth_key`).
    Recovery,
}

/// What `PUT /v1/keys` sends to set a new password (П18). The recovery pair is not replaced.
#[derive(Debug)]
pub struct ReplaceKeysRequest<'a> {
    /// The version the caller read; a stale one is `keys_conflict`.
    pub base_keys_version: u64,
    /// Which secret the proof is made from.
    pub proof_kind: ProofKind,
    /// The `auth_key` or `recovery_auth_key` of the proof.
    pub proof_auth_key: &'a AuthKey,
    /// The new salt, parameters, `auth_key` and wrapped AK.
    pub envelope: &'a PasswordEnvelope,
}

/// One entry of `GET /v1/devices` (П19).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceEntry {
    /// The identifier of the device.
    pub device_id: String,
    /// The name sealed by Ф34 (105 bytes), as the server keeps it.
    pub name_enc: Vec<u8>,
    /// When the device was created, Unix milliseconds.
    pub created_ms: i64,
    /// When the server last saw it, Unix milliseconds.
    pub last_seen_ms: i64,
    /// Whether this is the device that asked.
    pub current: bool,
}

/// The HTTP client of one server.
#[derive(Debug, Clone)]
pub struct SyncClient {
    base: ServerUrl,
}

impl SyncClient {
    /// A client of `base`: no redirects, 10 s to connect, 30 s for a request, a user agent that
    /// names the program (no secrets).
    pub fn new(base: &ServerUrl) -> Result<Self, ClientError> {
        let _ = base;
        todo!("П41")
    }

    /// The address this client talks to.
    pub fn base_url(&self) -> &ServerUrl {
        &self.base
    }

    /// `GET /v1/info` (П9). Does not check the protocol range: call
    /// [`ServerInfo::check_protocol`].
    pub async fn info(&self) -> Result<ServerInfo, ClientError> {
        todo!("П9")
    }

    /// `POST /v1/auth/prelogin` (П13).
    pub async fn prelogin(&self, username: &str) -> Result<Prelogin, ClientError> {
        let _ = username;
        todo!("П13")
    }

    /// `POST /v1/auth/enroll` (П12).
    pub async fn enroll(&self, request: &EnrollRequest<'_>) -> Result<Session, ClientError> {
        let _ = request;
        todo!("П12")
    }

    /// `POST /v1/auth/login` (П14).
    pub async fn login(
        &self,
        username: &str,
        auth_key: &AuthKey,
        device_name_enc: &[u8],
    ) -> Result<LoginAnswer, ClientError> {
        let _ = (username, auth_key, device_name_enc);
        todo!("П14")
    }

    /// `POST /v1/auth/recover` (П15).
    pub async fn recover(
        &self,
        username: &str,
        recovery_auth_key: &AuthKey,
        device_name_enc: &[u8],
    ) -> Result<RecoverAnswer, ClientError> {
        let _ = (username, recovery_auth_key, device_name_enc);
        todo!("П15")
    }

    /// `GET /v1/keys` (П18).
    pub async fn keys(&self, token: &DeviceToken) -> Result<KeysAnswer, ClientError> {
        let _ = token;
        todo!("П18")
    }

    /// `PUT /v1/keys` (П18): returns the new version of the keys.
    pub async fn replace_keys(
        &self,
        token: &DeviceToken,
        request: &ReplaceKeysRequest<'_>,
    ) -> Result<u64, ClientError> {
        let _ = (token, request);
        todo!("П18")
    }

    /// `GET /v1/devices` (П19).
    pub async fn devices(&self, token: &DeviceToken) -> Result<Vec<DeviceEntry>, ClientError> {
        let _ = token;
        todo!("П19")
    }

    /// `DELETE /v1/devices/{id}` (П19).
    pub async fn delete_device(
        &self,
        token: &DeviceToken,
        device_id: &str,
    ) -> Result<(), ClientError> {
        let _ = (token, device_id);
        todo!("П19")
    }
}
