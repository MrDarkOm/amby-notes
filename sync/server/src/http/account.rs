//! Enrolment, sign-in, keys and devices (Р5, П11–П19).

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use hmac::{Hmac, Mac};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::Sha256;

use amby_sync_proto::error_code as code;

use super::throttle;
use super::util::{
    authenticate, client_addr, ct_eq, field_hex, field_hex_vec, field_str, field_u64, hex,
    json_response, random, read_json, sha256, unhex_array, ApiError, ApiResult, NAME_ENVELOPE_LEN,
    WRAPPED_KEY_LEN,
};
use super::{split, Params};
use crate::admin::normalize_code;
use crate::state::{AppState, HubEvent};

/// Argon2id parameters as the server keeps and shows them (Ф7, Ф8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KdfParams {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

/// The defaults of Ф7: also what the fake salts claim.
const DEFAULT_PARAMS: KdfParams = KdfParams {
    memory_kib: 65_536,
    iterations: 3,
    parallelism: 4,
};

impl KdfParams {
    fn to_json(self) -> Value {
        json!({
            "memory_kib": self.memory_kib,
            "iterations": self.iterations,
            "parallelism": self.parallelism,
        })
    }

    /// Ф8: below the floor the server could make a password cheaper to guess, above the ceiling
    /// it could hang a client.
    fn from_json(object: &Value) -> ApiResult<Self> {
        let params = &object["params"];
        let take = |name: &str, low: u64, high: u64| -> ApiResult<u32> {
            params[name]
                .as_u64()
                .filter(|value| (low..=high).contains(value))
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| ApiError::bad_request("`params` are missing or out of range"))
        };
        Ok(Self {
            memory_kib: take("memory_kib", 65_536, 1_048_576)?,
            iterations: take("iterations", 3, 12)?,
            parallelism: take("parallelism", 1, 16)?,
        })
    }
}

/// The name of the device in a sign-in request (П12, Ф34).
fn device_name(request: &Value) -> ApiResult<Vec<u8>> {
    field_hex_vec(&request["device"], "name_enc", NAME_ENVELOPE_LEN)
}

/// A device and its token, made before the transaction so that a failure of the random source
/// cannot leave half a sign-in behind.
struct NewDevice {
    device_id: [u8; 16],
    token: [u8; 32],
}

impl NewDevice {
    fn generate() -> ApiResult<Self> {
        Ok(Self {
            device_id: random::<16>()?,
            token: random::<32>()?,
        })
    }

    fn insert(
        &self,
        tx: &Transaction<'_>,
        now: i64,
        user_id: i64,
        name_enc: &[u8],
    ) -> rusqlite::Result<()> {
        tx.execute(
            "INSERT INTO devices (device_id, user_id, name_enc, token_hash, created_ms, last_seen_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                self.device_id.as_slice(),
                user_id,
                name_enc,
                sha256(&self.token).as_slice(),
                now
            ],
        )?;
        Ok(())
    }
}

// --------------------------------------------------------------------------------- prelogin

/// `POST /v1/auth/prelogin` (П13).
pub(crate) async fn prelogin(
    State(state): State<AppState>,
    request: Request,
) -> ApiResult<Response> {
    let (parts, body) = split(request);
    let request = read_json(&state, &parts, body).await?;
    let username = field_str(&request, "username")?;
    if username.chars().count() > 256 {
        return Err(ApiError::bad_request("`username` is too long"));
    }
    let real = state.db.call(|conn| {
        conn.query_row(
            "SELECT salt, kdf_memory_kib, kdf_iterations, kdf_parallelism FROM users \
             WHERE username = ?1 AND has_password = 1",
            [username],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    KdfParams {
                        memory_kib: row.get(1)?,
                        iterations: row.get(2)?,
                        parallelism: row.get(3)?,
                    },
                ))
            },
        )
        .optional()
    })?;
    let (salt, params) = match real {
        Some(found) => found,
        None => {
            // A salt that looks real and that only the server can make again (П13).
            let secret = state
                .db
                .call(|conn| crate::db::meta_value(conn, "prelogin_secret"))?;
            let mut mac = Hmac::<Sha256>::new_from_slice(&secret).map_err(ApiError::internal)?;
            mac.update(b"amby-sync/prelogin/1");
            mac.update(username.as_bytes());
            (mac.finalize().into_bytes()[..16].to_vec(), DEFAULT_PARAMS)
        }
    };
    Ok(json_response(
        StatusCode::OK,
        &json!({ "salt": hex(&salt), "params": params.to_json() }),
    ))
}

// ----------------------------------------------------------------------------------- enroll

/// `POST /v1/auth/enroll` (П12, П17).
pub(crate) async fn enroll(State(state): State<AppState>, request: Request) -> ApiResult<Response> {
    let (parts, body) = split(request);
    let request = read_json(&state, &parts, body).await?;
    let username = field_str(&request, "username")?.to_string();
    let enroll_code = field_str(&request, "enroll_code")?.to_string();
    let salt = field_hex::<16>(&request, "salt")?;
    let kdf = KdfParams::from_json(&request)?;
    let auth_key = field_hex::<32>(&request, "auth_key")?;
    let wrapped_ak = field_hex_vec(&request, "wrapped_ak", WRAPPED_KEY_LEN)?;
    let recovery_auth_key = field_hex::<32>(&request, "recovery_auth_key")?;
    let wrapped_ak_recovery = field_hex_vec(&request, "wrapped_ak_recovery", WRAPPED_KEY_LEN)?;
    let name_enc = device_name(&request)?;

    let addr = client_addr(&state, &parts);
    let now = state.clock.now_ms();
    let config = state.config.clone();
    let device = NewDevice::generate()?;
    let outcome = state.db.write(|tx| -> rusqlite::Result<ApiResult<()>> {
        if let Some(seconds) = throttle::locked_for(tx, &config, now, &username, &addr)? {
            return Ok(Err(ApiError::rate_limited(seconds)));
        }
        let waiting: Option<(i64, Option<Vec<u8>>, Option<i64>)> = tx
            .query_row(
                "SELECT id, enroll_hash, enroll_expires_ms FROM users WHERE username = ?1",
                [&username],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let wanted = sha256(normalize_code(&enroll_code).as_bytes());
        // An unknown name, a used code and a wrong code take the same path (П17).
        let (user_id, stored, expires) = match &waiting {
            Some((id, Some(hash), Some(expires))) => (Some(*id), hash.clone(), *expires),
            _ => (None, vec![0u8; 32], 0),
        };
        let matches = ct_eq(&stored, &wanted) && user_id.is_some();
        let failure = if !matches {
            Some(ApiError::new(
                StatusCode::UNAUTHORIZED,
                code::INVALID_ENROLL_CODE,
                "the enrolment code is not valid",
            ))
        } else if now > expires {
            Some(ApiError::new(
                StatusCode::UNAUTHORIZED,
                code::ENROLL_CODE_EXPIRED,
                "the enrolment code has expired",
            ))
        } else {
            None
        };
        if let Some(error) = failure {
            throttle::record_failure(tx, now, &username, &addr)?;
            return Ok(Err(error));
        }
        let Some(user_id) = user_id else {
            return Ok(Err(ApiError::internal("enrolment without a user")));
        };
        tx.execute(
            "UPDATE users SET enroll_hash = NULL, enroll_expires_ms = NULL, has_password = 1, \
             salt = ?2, kdf_memory_kib = ?3, kdf_iterations = ?4, kdf_parallelism = ?5, \
             auth_hash = ?6, recovery_hash = ?7, wrapped_ak = ?8, wrapped_ak_recovery = ?9, \
             keys_version = 1 WHERE id = ?1",
            params![
                user_id,
                salt.as_slice(),
                kdf.memory_kib,
                kdf.iterations,
                kdf.parallelism,
                sha256(&auth_key).as_slice(),
                sha256(&recovery_auth_key).as_slice(),
                wrapped_ak,
                wrapped_ak_recovery
            ],
        )?;
        throttle::clear_pair(tx, &username, &addr)?;
        device.insert(tx, now, user_id, &name_enc)?;
        Ok(Ok(()))
    })?;
    outcome?;
    Ok(json_response(
        StatusCode::CREATED,
        &json!({
            "device_id": hex(&device.device_id),
            "token": hex(&device.token),
            "keys_version": 1,
        }),
    ))
}

// ------------------------------------------------------------------------- login, recover

/// Which secret a sign-in compares.
#[derive(Clone, Copy)]
enum Secret {
    Password,
    Recovery,
}

/// The shared body of `login` and `recover` (П14, П15, П16): one answer for every kind of wrong
/// credentials, one comparison of constant time, and the same work for an unknown name.
async fn sign_in(state: AppState, request: Request, secret: Secret) -> ApiResult<Response> {
    let (parts, body) = split(request);
    let request = read_json(&state, &parts, body).await?;
    let username = field_str(&request, "username")?.to_string();
    let key_field = match secret {
        Secret::Password => "auth_key",
        Secret::Recovery => "recovery_auth_key",
    };
    let key = field_hex::<32>(&request, key_field)?;
    let name_enc = device_name(&request)?;

    let addr = client_addr(&state, &parts);
    let now = state.clock.now_ms();
    let config = state.config.clone();
    let device = NewDevice::generate()?;
    let outcome = state.db.write(|tx| -> rusqlite::Result<ApiResult<Value>> {
        if let Some(seconds) = throttle::locked_for(tx, &config, now, &username, &addr)? {
            return Ok(Err(ApiError::rate_limited(seconds)));
        }
        let column = match secret {
            Secret::Password => "auth_hash",
            Secret::Recovery => "recovery_hash",
        };
        let row = tx
            .query_row(
                &format!(
                    "SELECT id, {column}, salt, kdf_memory_kib, kdf_iterations, kdf_parallelism, \
                     wrapped_ak, wrapped_ak_recovery, keys_version FROM users \
                     WHERE username = ?1 AND has_password = 1"
                ),
                [&username],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                        KdfParams {
                            memory_kib: row.get(3)?,
                            iterations: row.get(4)?,
                            parallelism: row.get(5)?,
                        },
                        row.get::<_, Vec<u8>>(6)?,
                        row.get::<_, Vec<u8>>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()?;
        let wanted = sha256(&key);
        let stored = row.as_ref().map_or_else(|| vec![0u8; 32], |r| r.1.clone());
        if !(ct_eq(&stored, &wanted) && row.is_some()) {
            throttle::record_failure(tx, now, &username, &addr)?;
            return Ok(Err(ApiError::invalid_credentials()));
        }
        let Some((user_id, _, salt, kdf, wrapped_ak, wrapped_recovery, keys_version)) = row else {
            return Ok(Err(ApiError::internal("sign-in without a user")));
        };
        throttle::clear_pair(tx, &username, &addr)?;
        device.insert(tx, now, user_id, &name_enc)?;
        let mut answer = json!({
            "device_id": hex(&device.device_id),
            "token": hex(&device.token),
            "keys_version": keys_version,
        });
        match secret {
            Secret::Password => {
                answer["salt"] = json!(hex(&salt));
                answer["params"] = kdf.to_json();
                answer["wrapped_ak"] = json!(hex(&wrapped_ak));
            }
            Secret::Recovery => {
                answer["wrapped_ak_recovery"] = json!(hex(&wrapped_recovery));
            }
        }
        Ok(Ok(answer))
    })?;
    Ok(json_response(StatusCode::OK, &outcome?))
}

/// `POST /v1/auth/login` (П14).
pub(crate) async fn login(State(state): State<AppState>, request: Request) -> ApiResult<Response> {
    sign_in(state, request, Secret::Password).await
}

/// `POST /v1/auth/recover` (П15).
pub(crate) async fn recover(
    State(state): State<AppState>,
    request: Request,
) -> ApiResult<Response> {
    sign_in(state, request, Secret::Recovery).await
}

// ------------------------------------------------------------------------------------ keys

/// `GET /v1/keys` (П18).
pub(crate) async fn keys_get(
    State(state): State<AppState>,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let answer = state.db.call(|conn| {
        conn.query_row(
            "SELECT keys_version, salt, kdf_memory_kib, kdf_iterations, kdf_parallelism, \
             wrapped_ak, wrapped_ak_recovery FROM users WHERE id = ?1",
            [auth.user_id],
            |row| {
                Ok(json!({
                    "keys_version": row.get::<_, i64>(0)?,
                    "salt": hex(&row.get::<_, Vec<u8>>(1)?),
                    "params": KdfParams {
                        memory_kib: row.get(2)?,
                        iterations: row.get(3)?,
                        parallelism: row.get(4)?,
                    }.to_json(),
                    "wrapped_ak": hex(&row.get::<_, Vec<u8>>(5)?),
                    "wrapped_ak_recovery": hex(&row.get::<_, Vec<u8>>(6)?),
                }))
            },
        )
    })?;
    Ok(json_response(StatusCode::OK, &answer))
}

/// `PUT /v1/keys` (П18): token, shape, lock, proof, version, then one transaction.
pub(crate) async fn keys_put(
    State(state): State<AppState>,
    request: Request,
) -> ApiResult<Response> {
    let (parts, body) = split(request);
    let auth = authenticate(&state, &parts)?;
    let request = read_json(&state, &parts, body).await?;
    let base_version = field_u64(&request, "base_keys_version")?;
    let proof_kind = field_str(&request["proof"], "kind")?.to_string();
    if proof_kind != "password" && proof_kind != "recovery" {
        return Err(ApiError::bad_request(
            "`proof.kind` must be password or recovery",
        ));
    }
    let proof = field_hex::<32>(&request["proof"], "auth_key")?;
    let salt = field_hex::<16>(&request, "salt")?;
    let kdf = KdfParams::from_json(&request)?;
    let auth_key = field_hex::<32>(&request, "auth_key")?;
    let wrapped_ak = field_hex_vec(&request, "wrapped_ak", WRAPPED_KEY_LEN)?;
    let new_recovery = match (
        request.get("recovery_auth_key").filter(|v| !v.is_null()),
        request.get("wrapped_ak_recovery").filter(|v| !v.is_null()),
    ) {
        (None, None) => None,
        (Some(_), Some(_)) => Some((
            field_hex::<32>(&request, "recovery_auth_key")?,
            field_hex_vec(&request, "wrapped_ak_recovery", WRAPPED_KEY_LEN)?,
        )),
        _ => {
            return Err(ApiError::bad_request(
                "`recovery_auth_key` and `wrapped_ak_recovery` come together or not at all",
            ))
        }
    };

    let addr = client_addr(&state, &parts);
    let now = state.clock.now_ms();
    let config = state.config.clone();
    let outcome = state.db.write(|tx| -> rusqlite::Result<ApiResult<i64>> {
        if let Some(seconds) = throttle::locked_for(tx, &config, now, &auth.username, &addr)? {
            return Ok(Err(ApiError::rate_limited(seconds)));
        }
        let column = if proof_kind == "password" {
            "auth_hash"
        } else {
            "recovery_hash"
        };
        let (stored, version): (Vec<u8>, i64) = tx.query_row(
            &format!("SELECT {column}, keys_version FROM users WHERE id = ?1"),
            [auth.user_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if !ct_eq(&stored, &sha256(&proof)) {
            throttle::record_failure(tx, now, &auth.username, &addr)?;
            return Ok(Err(ApiError::new(
                StatusCode::FORBIDDEN,
                code::INVALID_PROOF,
                "the proof is not valid",
            )));
        }
        if i64::try_from(base_version).ok() != Some(version) {
            return Ok(Err(ApiError::new(
                StatusCode::CONFLICT,
                code::KEYS_CONFLICT,
                "the keys changed in the meantime",
            )
            .with_details(json!({ "keys_version": version }))));
        }
        tx.execute(
            "UPDATE users SET salt = ?2, kdf_memory_kib = ?3, kdf_iterations = ?4, \
             kdf_parallelism = ?5, auth_hash = ?6, wrapped_ak = ?7, keys_version = keys_version + 1 \
             WHERE id = ?1",
            params![
                auth.user_id,
                salt.as_slice(),
                kdf.memory_kib,
                kdf.iterations,
                kdf.parallelism,
                sha256(&auth_key).as_slice(),
                wrapped_ak
            ],
        )?;
        if let Some((recovery_auth_key, wrapped_recovery)) = &new_recovery {
            tx.execute(
                "UPDATE users SET recovery_hash = ?2, wrapped_ak_recovery = ?3 WHERE id = ?1",
                params![
                    auth.user_id,
                    sha256(recovery_auth_key).as_slice(),
                    wrapped_recovery
                ],
            )?;
        }
        Ok(Ok(version + 1))
    })?;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "keys_version": outcome? }),
    ))
}

// --------------------------------------------------------------------------------- devices

/// `GET /v1/devices` (П19).
pub(crate) async fn devices_list(
    State(state): State<AppState>,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let devices = state.db.call(|conn| -> rusqlite::Result<Vec<Value>> {
        let mut statement = conn.prepare(
            "SELECT device_id, name_enc, created_ms, last_seen_ms FROM devices \
             WHERE user_id = ?1 ORDER BY id",
        )?;
        let rows = statement.query_map([auth.user_id], |row| {
            let device_id: Vec<u8> = row.get(0)?;
            Ok(json!({
                "device_id": hex(&device_id),
                "name_enc": hex(&row.get::<_, Vec<u8>>(1)?),
                "created_ms": row.get::<_, i64>(2)?,
                "last_seen_ms": row.get::<_, i64>(3)?,
                "current": device_id == auth.device_id,
            }))
        })?;
        rows.collect()
    })?;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "devices": devices }),
    ))
}

/// `DELETE /v1/devices/{device_id}` (П19): the token stops working at once, and the open event
/// streams of the device end (П34).
pub(crate) async fn device_delete(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let target = params
        .0
        .get("device_id")
        .and_then(|text| unhex_array::<16>(text))
        .ok_or_else(ApiError::not_found)?;
    let removed = state.db.write(|tx| -> rusqlite::Result<bool> {
        let token_hash: Option<Vec<u8>> = tx
            .query_row(
                "SELECT token_hash FROM devices WHERE device_id = ?1 AND user_id = ?2",
                params![target.as_slice(), auth.user_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(token_hash) = token_hash else {
            return Ok(false);
        };
        tx.execute(
            "INSERT OR IGNORE INTO revoked_tokens (token_hash, user_id) VALUES (?1, ?2)",
            params![token_hash, auth.user_id],
        )?;
        tx.execute(
            "DELETE FROM devices WHERE device_id = ?1",
            [target.as_slice()],
        )?;
        Ok(true)
    })?;
    if !removed {
        return Err(ApiError::not_found());
    }
    // Nobody may be listening: that is fine.
    let _ = state.hub.send(HubEvent::Revoked { device_id: target });
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .map_err(ApiError::internal)
}

/// `GET /v1/account` (П61): the plan, the effective limits, the usage and the spaces with their
/// sizes. STUB of the red-tests step: answers `501 not_implemented`.
pub(crate) async fn overview() -> ApiResult<Response> {
    Err(ApiError::new(
        StatusCode::NOT_IMPLEMENTED,
        code::NOT_IMPLEMENTED,
        "GET /v1/account is not written yet",
    ))
}
