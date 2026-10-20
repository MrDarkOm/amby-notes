//! Errors, strict hex, reading bodies, authentication.

use std::fmt::Write as _;

use axum::body::Body;
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use amby_sync_proto::error_code as code;

use crate::state::AppState;

/// A failed request, ready to be sent (П4).
#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    details: Option<Value>,
    retry_after: Option<u64>,
}

/// The result of a handler.
pub(crate) type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: &str) -> Self {
        Self {
            status,
            code,
            message: message.to_string(),
            details: None,
            retry_after: None,
        }
    }

    pub(crate) fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub(crate) fn with_retry_after(mut self, seconds: u64) -> Self {
        self.retry_after = Some(seconds);
        self
    }

    /// A bad request. The message never names the value that was wrong (П2).
    pub(crate) fn bad_request(message: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code::BAD_REQUEST, message)
    }

    pub(crate) fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, code::NOT_FOUND, "not found")
    }

    pub(crate) fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            code::UNAUTHORIZED,
            "a valid device token is required",
        )
    }

    /// 401 with one text for every kind of wrong credentials (П15).
    pub(crate) fn invalid_credentials() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            code::INVALID_CREDENTIALS,
            "invalid credentials",
        )
    }

    pub(crate) fn rate_limited(retry_after: u64) -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            code::RATE_LIMITED,
            "too many failed attempts; try again later",
        )
        .with_retry_after(retry_after)
    }

    /// A server fault. The cause goes to the log (no request data in it, П39); the client gets nothing
    /// that helps an attacker.
    pub(crate) fn internal(cause: impl std::fmt::Display) -> Self {
        eprintln!("internal error: {cause}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            "internal server error",
        )
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error)
    }
}

impl From<crate::store::StoreError> for ApiError {
    fn from(error: crate::store::StoreError) -> Self {
        Self::internal(error)
    }
}

impl ApiError {
    /// The answer, with a chance to add headers of its own.
    pub(crate) fn into_response_with(
        self,
        extra: impl FnOnce(&mut axum::http::HeaderMap),
    ) -> Response {
        let mut response = self.into_response();
        extra(response.headers_mut());
        response
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(details) = self.details {
            error["details"] = details;
        }
        let mut response = json_response(self.status, &json!({ "error": error }));
        if let Some(seconds) = self.retry_after {
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
        }
        response
    }
}

/// A JSON answer.
pub(crate) fn json_response(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// Lower-case hex of `bytes` (П2).
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// Strict hex (П2): lower case only, even length. `None` for anything else.
pub(crate) fn unhex(text: &str) -> Option<Vec<u8>> {
    let digits = text.as_bytes();
    if digits.len() % 2 != 0 {
        return None;
    }
    let value = |digit: u8| match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        _ => None,
    };
    digits
        .chunks(2)
        .map(|pair| Some(value(pair[0])? << 4 | value(pair[1])?))
        .collect()
}

/// Strict hex of exactly `N` bytes.
pub(crate) fn unhex_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    unhex(text)?.try_into().ok()
}

/// SHA-256.
pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Equal in constant time (the hashes of tokens and keys, П15).
pub(crate) fn ct_eq(left: &[u8], right: &[u8]) -> bool {
    left.ct_eq(right).into()
}

/// Random bytes from the system.
pub(crate) fn random<const N: usize>() -> ApiResult<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
    Ok(bytes)
}

// ------------------------------------------------------------------- fields of a JSON object

/// A hex field of exactly `N` bytes.
pub(crate) fn field_hex<const N: usize>(object: &Value, name: &str) -> ApiResult<[u8; N]> {
    object[name]
        .as_str()
        .and_then(unhex_array::<N>)
        .ok_or_else(|| ApiError::bad_request(&format!("`{name}` is missing or malformed")))
}

/// A hex field of exactly `bytes` bytes, as a vector.
pub(crate) fn field_hex_vec(object: &Value, name: &str, bytes: usize) -> ApiResult<Vec<u8>> {
    object[name]
        .as_str()
        .and_then(unhex)
        .filter(|decoded| decoded.len() == bytes)
        .ok_or_else(|| ApiError::bad_request(&format!("`{name}` is missing or malformed")))
}

/// A whole number from zero up.
pub(crate) fn field_u64(object: &Value, name: &str) -> ApiResult<u64> {
    object[name]
        .as_u64()
        .ok_or_else(|| ApiError::bad_request(&format!("`{name}` is missing or malformed")))
}

pub(crate) fn field_str<'a>(object: &'a Value, name: &str) -> ApiResult<&'a str> {
    object[name]
        .as_str()
        .ok_or_else(|| ApiError::bad_request(&format!("`{name}` is missing or malformed")))
}

/// The name of a device or a space, sealed by the device (Ф34): exactly 105 bytes.
pub(crate) const NAME_ENVELOPE_LEN: usize = 105;
/// A wrapped key (AK or VK): 73 bytes.
pub(crate) const WRAPPED_KEY_LEN: usize = 73;

// ------------------------------------------------------------------------- reading a body

/// Why a body could not be read.
pub(crate) enum ReadError {
    /// More than the limit.
    TooLarge,
    /// The connection broke.
    Broken,
}

/// How much of an over-long body is read and thrown away so that the client can finish
/// sending and read the error instead of meeting a closed connection.
const DRAIN_LIMIT: usize = 32 * 1024 * 1024;

/// Reads at most `limit` bytes. A longer body is drained (up to [`DRAIN_LIMIT`]) and refused.
pub(crate) async fn read_limited(body: Body, limit: usize) -> Result<Vec<u8>, ReadError> {
    let mut stream = body.into_data_stream();
    let mut data = Vec::new();
    let mut seen = 0usize;
    let mut too_large = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ReadError::Broken)?;
        seen += chunk.len();
        if !too_large {
            if seen > limit {
                too_large = true;
                data = Vec::new();
            } else {
                data.extend_from_slice(&chunk);
            }
        }
        if seen > limit + DRAIN_LIMIT {
            break;
        }
    }
    if too_large {
        Err(ReadError::TooLarge)
    } else {
        Ok(data)
    }
}

/// The JSON object of a request (П1, П7, П8).
pub(crate) async fn read_json(state: &AppState, parts: &Parts, body: Body) -> ApiResult<Value> {
    let is_json = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let value = value.trim().to_ascii_lowercase();
            value == "application/json" || value.starts_with("application/json;")
        });
    if !is_json {
        return Err(ApiError::bad_request(
            "the content type must be application/json",
        ));
    }
    let bytes = read_limited(body, state.config.max_json_bytes)
        .await
        .map_err(|error| match error {
            ReadError::TooLarge => ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                code::PAYLOAD_TOO_LARGE,
                "the request is too large",
            ),
            ReadError::Broken => ApiError::bad_request("the request body could not be read"),
        })?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("not valid JSON"))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(ApiError::bad_request("the request must be a JSON object"))
    }
}

// ------------------------------------------------------------------------ authentication

/// A device that proved its token (П5).
#[derive(Debug, Clone)]
pub(crate) struct Auth {
    pub(crate) user_id: i64,
    pub(crate) username: String,
    pub(crate) device_id: [u8; 16],
    pub(crate) token_hash: [u8; 32],
}

/// How often `last_seen_ms` is written: a write per request would make every read a write.
const LAST_SEEN_STEP_MS: i64 = 60_000;

/// Checks `Authorization: Bearer <token>` (П5).
pub(crate) fn authenticate(state: &AppState, parts: &Parts) -> ApiResult<Auth> {
    let token = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .and_then(unhex_array::<32>)
        .ok_or_else(ApiError::unauthorized)?;
    let hash = sha256(&token);
    let now = state.clock.now_ms();
    let found = state
        .db
        .call(|conn| -> rusqlite::Result<Result<Auth, bool>> {
            let device = conn
            .query_row(
                "SELECT d.id, d.device_id, d.user_id, u.username, d.token_hash, d.last_seen_ms \
                 FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?1",
                [hash.as_slice()],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .optional()?;
            if let Some((row_id, device_id, user_id, username, stored, last_seen)) = device {
                // The index found it by the hash; the comparison that decides is still constant time.
                if let Ok(device_id) = <[u8; 16]>::try_from(device_id) {
                    if ct_eq(&stored, &hash) {
                        if now - last_seen >= LAST_SEEN_STEP_MS {
                            conn.execute(
                                "UPDATE devices SET last_seen_ms = ?2 WHERE id = ?1",
                                rusqlite::params![row_id, now],
                            )?;
                        }
                        return Ok(Ok(Auth {
                            user_id,
                            username,
                            device_id,
                            token_hash: hash,
                        }));
                    }
                }
            }
            let revoked: bool = conn
                .query_row(
                    "SELECT 1 FROM revoked_tokens WHERE token_hash = ?1",
                    [hash.as_slice()],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            Ok(Err(revoked))
        })?;
    match found {
        Ok(auth) => Ok(auth),
        Err(true) => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            code::TOKEN_REVOKED,
            "this device was disconnected",
        )),
        Err(false) => Err(ApiError::unauthorized()),
    }
}

/// The address a failed sign-in is counted against (П16): the socket address, or with
/// `AMBY_SYNC_TRUST_PROXY=1` the last address of `X-Forwarded-For`.
pub(crate) fn client_addr(state: &AppState, parts: &Parts) -> String {
    if state.config.trust_proxy {
        if let Some(last) = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                value
                    .rsplit(',')
                    .map(str::trim)
                    .find(|part| !part.is_empty())
            })
        {
            return last.chars().take(64).collect();
        }
    }
    parts
        .extensions
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map_or_else(|| "-".to_string(), |info| info.0.ip().to_string())
}
