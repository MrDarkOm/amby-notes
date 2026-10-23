//! One method per request of the sign-in protocol (appendix Б, П9–П19). No flow and no key
//! derivation here: the methods only build the JSON, send it and read the answer.
//!
//! Requests never follow a redirect (a redirect to `http://` would undo the rule of П41), have a
//! time limit, and treat a body that is not what Б says as [`ClientError::BadResponse`].

use core::fmt;
use std::time::Duration;

use amby_sync_core::crypto::account::{Argon2Params, NewAccount, PasswordEnvelope};
use amby_sync_core::crypto::keys::AuthKey;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

use crate::error::ClientError;
use crate::url::ServerUrl;

/// The biggest answer the client reads (the answers of this part of the protocol are small; a
/// hostile server must not be able to fill the memory).
pub(crate) const MAX_ANSWER_BYTES: usize = 4 * 1024 * 1024;
/// Time to connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Time for a whole request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a connection may stay silent while a body is being read or an event stream is open:
/// the server pings a stream every 15 seconds (П34), so silence for this long is a dead line.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) fn bad(reason: &'static str) -> ClientError {
    ClientError::BadResponse(reason)
}

/// A string field of a JSON object.
pub(crate) fn string_field<'a>(
    value: &'a Value,
    name: &'static str,
) -> Result<&'a str, ClientError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| bad("a text field is missing"))
}

/// A whole number field of a JSON object.
pub(crate) fn number_field(value: &Value, name: &'static str) -> Result<u64, ClientError> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| bad("a number field is missing"))
}

/// A signed whole number field.
pub(crate) fn signed_field(value: &Value, name: &'static str) -> Result<i64, ClientError> {
    value
        .get(name)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad("a number field is missing"))
}

/// A hex field of exactly `N` bytes.
pub(crate) fn hex_array<const N: usize>(
    value: &Value,
    name: &'static str,
) -> Result<[u8; N], ClientError> {
    let bytes =
        hex::decode(string_field(value, name)?).map_err(|_| bad("a hex field is not hex"))?;
    bytes
        .try_into()
        .map_err(|_| bad("a hex field has the wrong size"))
}

/// A hex field of any size.
pub(crate) fn hex_bytes(value: &Value, name: &'static str) -> Result<Vec<u8>, ClientError> {
    hex::decode(string_field(value, name)?).map_err(|_| bad("a hex field is not hex"))
}

/// `{"memory_kib", "iterations", "parallelism"}` (Ф7).
fn params_from(value: &Value) -> Result<Argon2Params, ClientError> {
    let params = value
        .get("params")
        .ok_or_else(|| bad("the parameters are missing"))?;
    let part = |name: &'static str| {
        number_field(params, name)
            .and_then(|number| u32::try_from(number).map_err(|_| bad("a parameter is too large")))
    };
    Ok(Argon2Params {
        memory_kib: part("memory_kib")?,
        iterations: part("iterations")?,
        parallelism: part("parallelism")?,
    })
}

fn params_to(params: &Argon2Params) -> Value {
    json!({
        "memory_kib": params.memory_kib,
        "iterations": params.iterations,
        "parallelism": params.parallelism,
    })
}

/// A device and its token from the answer of enroll, login or recover.
fn session_from(value: &Value) -> Result<Session, ClientError> {
    let token = string_field(value, "token")?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(bad("the token has the wrong form"));
    }
    let device_id = string_field(value, "device_id")?;
    if device_id.len() != 32 || !device_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(bad("the device identifier has the wrong form"));
    }
    Ok(Session {
        device_id: device_id.to_string(),
        token: DeviceToken::new(token.to_string()),
        keys_version: number_field(value, "keys_version")?,
    })
}

/// Only the characters of the codes in table Б.0.1 are accepted from a server: a code is shown to
/// the person when this client does not know it.
pub(crate) fn clean_code(code: &str) -> Option<&str> {
    let well_formed = !code.is_empty()
        && code.len() <= 64
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    well_formed.then_some(code)
}

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
        let protocol = value
            .get("protocol")
            .ok_or_else(|| bad("the protocol range is missing"))?;
        let version = |name: &'static str| {
            number_field(protocol, name)
                .and_then(|number| u32::try_from(number).map_err(|_| bad("a version is too large")))
        };
        let instance_id = string_field(value, "instance_id")?;
        if instance_id.len() != 32 || !instance_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(bad("the instance identifier has the wrong form"));
        }
        Ok(Self {
            server: string_field(value, "server")?.to_string(),
            server_version: string_field(value, "server_version")?.to_string(),
            protocol_min: version("min")?,
            protocol_max: version("max")?,
            instance_id: instance_id.to_string(),
            rest: value.clone(),
        })
    }

    /// Whether protocol 1 is within the range of the server (П9, Р13); otherwise
    /// `UnsupportedServer`.
    pub fn check_protocol(&self) -> Result<(), ClientError> {
        if self.protocol_min <= 1 && 1 <= self.protocol_max {
            Ok(())
        } else {
            Err(ClientError::UnsupportedServer {
                min: self.protocol_min,
                max: self.protocol_max,
            })
        }
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
    http: reqwest::Client,
}

pub(crate) fn transport_error(error: &reqwest::Error) -> ClientError {
    if error.is_timeout() {
        ClientError::Timeout
    } else {
        // The text of the library may hold the address: it is dropped on purpose.
        ClientError::Network
    }
}

/// `Retry-After` in whole seconds (the form the server sends, П16).
pub(crate) fn retry_after(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Reads the body of an answer, at most [`MAX_ANSWER_BYTES`].
pub(crate) async fn read_body(mut response: reqwest::Response) -> Result<Vec<u8>, ClientError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_error(&error))?
    {
        if body.len() + chunk.len() > MAX_ANSWER_BYTES {
            return Err(bad("the answer is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The error of an answer that is not a success: the code of a JSON error answer (П4),
/// `server_unavailable` for a `5xx` without one (a proxy in front of a stopped server), otherwise
/// `BadResponse`.
pub(crate) fn error_from(status: u16, wait: Option<u64>, bytes: &[u8]) -> ClientError {
    let code = serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| {
            value["error"]["code"]
                .as_str()
                .and_then(clean_code)
                .map(str::to_string)
        });
    match code {
        Some(code) => ClientError::Api {
            status,
            code,
            retry_after_secs: wait,
        },
        None if status >= 500 => ClientError::Api {
            status,
            code: "server_unavailable".to_string(),
            retry_after_secs: wait,
        },
        None => bad("the answer is not an error of the protocol"),
    }
}

impl SyncClient {
    /// A client of `base`: no redirects, 10 s to connect, 30 s for a request, a user agent that
    /// names the program (no secrets).
    pub fn new(base: &ServerUrl) -> Result<Self, ClientError> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("amby-sync-client/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ClientError::Network)?;
        Ok(Self {
            base: base.clone(),
            http,
        })
    }

    /// The address this client talks to.
    pub fn base_url(&self) -> &ServerUrl {
        &self.base
    }

    /// One request. Returns the JSON of a `2xx` answer (`null` for `204`); anything else is an
    /// error: the code of a JSON error answer (П4), `server_unavailable` for a `5xx` without one
    /// (a proxy in front of a stopped server), otherwise `BadResponse`.
    pub(crate) async fn send(
        &self,
        method: Method,
        path: &str,
        token: Option<&DeviceToken>,
        body: Option<Value>,
    ) -> Result<Value, ClientError> {
        let mut request = self.http.request(method, self.base.endpoint(path));
        if let Some(token) = token {
            request = request.bearer_auth(token.expose());
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        let status = response.status();
        let wait = retry_after(&response);
        let bytes = read_body(response).await?;
        if status.is_success() {
            if status == StatusCode::NO_CONTENT {
                return Ok(Value::Null);
            }
            return serde_json::from_slice(&bytes).map_err(|_| bad("the answer is not JSON"));
        }
        Err(error_from(status.as_u16(), wait, &bytes))
    }

    /// The address of a path of the server and a request with the token (if any); the caller adds
    /// the body, the timeout and sends it. For the requests of [`crate::spaces`].
    pub(crate) fn builder(
        &self,
        method: Method,
        path: &str,
        token: Option<&DeviceToken>,
    ) -> reqwest::RequestBuilder {
        let mut request = self.http.request(method, self.base.endpoint(path));
        if let Some(token) = token {
            request = request.bearer_auth(token.expose());
        }
        request
    }

    /// `GET /v1/info` (П9). Does not check the protocol range: call
    /// [`ServerInfo::check_protocol`].
    pub async fn info(&self) -> Result<ServerInfo, ClientError> {
        let value = self.send(Method::GET, "/v1/info", None, None).await?;
        ServerInfo::from_json(&value)
    }

    /// `POST /v1/auth/prelogin` (П13).
    pub async fn prelogin(&self, username: &str) -> Result<Prelogin, ClientError> {
        let value = self
            .send(
                Method::POST,
                "/v1/auth/prelogin",
                None,
                Some(json!({ "username": username })),
            )
            .await?;
        Ok(Prelogin {
            salt: hex_array(&value, "salt")?,
            params: params_from(&value)?,
        })
    }

    /// `POST /v1/auth/enroll` (П12).
    pub async fn enroll(&self, request: &EnrollRequest<'_>) -> Result<Session, ClientError> {
        let account = request.account;
        let body = json!({
            "username": request.username,
            "enroll_code": request.enroll_code,
            "salt": hex::encode(account.password.salt),
            "params": params_to(&account.password.params),
            "auth_key": hex::encode(account.password.auth_key.as_bytes()),
            "wrapped_ak": hex::encode(&account.password.wrapped_account_key),
            "recovery_auth_key": hex::encode(account.recovery_auth_key.as_bytes()),
            "wrapped_ak_recovery": hex::encode(&account.wrapped_account_key_recovery),
            "device": { "name_enc": hex::encode(request.device_name_enc) },
        });
        let value = self
            .send(Method::POST, "/v1/auth/enroll", None, Some(body))
            .await?;
        session_from(&value)
    }

    /// `POST /v1/auth/login` (П14).
    pub async fn login(
        &self,
        username: &str,
        auth_key: &AuthKey,
        device_name_enc: &[u8],
    ) -> Result<LoginAnswer, ClientError> {
        let body = json!({
            "username": username,
            "auth_key": hex::encode(auth_key.as_bytes()),
            "device": { "name_enc": hex::encode(device_name_enc) },
        });
        let value = self
            .send(Method::POST, "/v1/auth/login", None, Some(body))
            .await?;
        Ok(LoginAnswer {
            session: session_from(&value)?,
            salt: hex_array(&value, "salt")?,
            params: params_from(&value)?,
            wrapped_ak: hex_bytes(&value, "wrapped_ak")?,
        })
    }

    /// `POST /v1/auth/recover` (П15).
    pub async fn recover(
        &self,
        username: &str,
        recovery_auth_key: &AuthKey,
        device_name_enc: &[u8],
    ) -> Result<RecoverAnswer, ClientError> {
        let body = json!({
            "username": username,
            "recovery_auth_key": hex::encode(recovery_auth_key.as_bytes()),
            "device": { "name_enc": hex::encode(device_name_enc) },
        });
        let value = self
            .send(Method::POST, "/v1/auth/recover", None, Some(body))
            .await?;
        Ok(RecoverAnswer {
            session: session_from(&value)?,
            wrapped_ak_recovery: hex_bytes(&value, "wrapped_ak_recovery")?,
        })
    }

    /// `GET /v1/keys` (П18).
    pub async fn keys(&self, token: &DeviceToken) -> Result<KeysAnswer, ClientError> {
        let value = self
            .send(Method::GET, "/v1/keys", Some(token), None)
            .await?;
        Ok(KeysAnswer {
            keys_version: number_field(&value, "keys_version")?,
            salt: hex_array(&value, "salt")?,
            params: params_from(&value)?,
            wrapped_ak: hex_bytes(&value, "wrapped_ak")?,
            wrapped_ak_recovery: hex_bytes(&value, "wrapped_ak_recovery")?,
        })
    }

    /// `PUT /v1/keys` (П18): returns the new version of the keys.
    pub async fn replace_keys(
        &self,
        token: &DeviceToken,
        request: &ReplaceKeysRequest<'_>,
    ) -> Result<u64, ClientError> {
        let kind = match request.proof_kind {
            ProofKind::Password => "password",
            ProofKind::Recovery => "recovery",
        };
        let envelope = request.envelope;
        let body = json!({
            "base_keys_version": request.base_keys_version,
            "proof": { "kind": kind, "auth_key": hex::encode(request.proof_auth_key.as_bytes()) },
            "salt": hex::encode(envelope.salt),
            "params": params_to(&envelope.params),
            "auth_key": hex::encode(envelope.auth_key.as_bytes()),
            "wrapped_ak": hex::encode(&envelope.wrapped_account_key),
        });
        let value = self
            .send(Method::PUT, "/v1/keys", Some(token), Some(body))
            .await?;
        number_field(&value, "keys_version")
    }

    /// `GET /v1/devices` (П19).
    pub async fn devices(&self, token: &DeviceToken) -> Result<Vec<DeviceEntry>, ClientError> {
        let value = self
            .send(Method::GET, "/v1/devices", Some(token), None)
            .await?;
        let list = value
            .get("devices")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("the list of devices is missing"))?;
        list.iter()
            .map(|entry| {
                Ok(DeviceEntry {
                    device_id: string_field(entry, "device_id")?.to_string(),
                    name_enc: hex_bytes(entry, "name_enc")?,
                    created_ms: signed_field(entry, "created_ms")?,
                    last_seen_ms: signed_field(entry, "last_seen_ms")?,
                    current: entry
                        .get("current")
                        .and_then(Value::as_bool)
                        .ok_or_else(|| bad("a flag is missing"))?,
                })
            })
            .collect()
    }

    /// `DELETE /v1/devices/{id}` (П19).
    pub async fn delete_device(
        &self,
        token: &DeviceToken,
        device_id: &str,
    ) -> Result<(), ClientError> {
        // The identifier goes into the path: only the form of a device identifier is allowed, so
        // nothing can change the path (`../`) or add a query.
        if device_id.len() != 32 || !device_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ClientError::Api {
                status: 404,
                code: "not_found".to_string(),
                retry_after_secs: None,
            });
        }
        self.send(
            Method::DELETE,
            &format!("/v1/devices/{device_id}"),
            Some(token),
            None,
        )
        .await?;
        Ok(())
    }
}
