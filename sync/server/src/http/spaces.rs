//! Spaces (П20) and the lookup every space route starts with (П6).

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use amby_sync_proto::error_code as code;

use super::split;
use super::util::{
    authenticate, field_hex, field_hex_vec, field_u64, hex, json_response, read_json, unhex_array,
    ApiError, ApiResult, NAME_ENVELOPE_LEN, WRAPPED_KEY_LEN,
};
use crate::state::AppState;
use crate::store::BlobStore;

/// `DELETE /v1/spaces/{space_id}` (Л1–Л5): the space of the signed-in user with all its records,
/// versions, bodies and unfinished uploads. Rows go first and files after, under the lock.
pub(crate) async fn remove(
    State(state): State<AppState>,
    params: super::Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    // Sign-in first, then the id (Л2).
    let auth = authenticate(&state, &parts)?;
    let space_text = params
        .0
        .get("space_id")
        .map_or("", String::as_str)
        .to_string();
    let removed = state.db.write_then(
        |tx| -> ApiResult<(OwnedSpace, Vec<crate::store::BlobKey>)> {
            let space = recheck(tx, &auth, &space_text)?;
            let keys: Vec<crate::store::BlobKey> = {
                let mut statement = tx.prepare("SELECT blob_id FROM blobs WHERE space = ?1")?;
                let rows = statement.query_map([space.row], |row| row.get::<_, Vec<u8>>(0))?;
                rows.filter_map(|blob| blob.ok().and_then(|blob| blob.try_into().ok()))
                    .map(|blob_id| crate::store::BlobKey {
                        space_id: space.space_id,
                        blob_id,
                    })
                    .collect()
            };
            tx.execute("DELETE FROM spaces WHERE id = ?1", [space.row])?;
            Ok((space, keys))
        },
        |tx, (_, keys)| {
            for key in keys {
                if !crate::maintenance::row_exists(tx, key)? {
                    state.files.delete(key)?;
                }
            }
            Ok(())
        },
    )?;
    let _ = state.hub.send(crate::state::HubEvent::SpaceRemoved {
        space_id: removed.0.space_id,
    });
    Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
}

/// A space of the signed-in user.
#[derive(Debug, Clone, Copy)]
pub(crate) struct OwnedSpace {
    /// The row number inside the database.
    pub(crate) row: i64,
    pub(crate) space_id: [u8; 16],
    pub(crate) seq: u64,
    pub(crate) purged_seq: u64,
}

/// The check every write repeats inside its own transaction (Т1): the device token still
/// exists and the space is still the user's. The row found before the body was read is never
/// used for writing, because the space may have been removed and its row reused meanwhile.
pub(crate) fn recheck(
    conn: &Connection,
    auth: &super::util::Auth,
    space_id: &str,
) -> ApiResult<OwnedSpace> {
    let alive = conn
        .query_row(
            "SELECT 1 FROM devices WHERE token_hash = ?1",
            [auth.token_hash.as_slice()],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !alive {
        let revoked = conn
            .query_row(
                "SELECT 1 FROM revoked_tokens WHERE token_hash = ?1",
                [auth.token_hash.as_slice()],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        return Err(if revoked {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                code::TOKEN_REVOKED,
                "this device was disconnected",
            )
        } else {
            ApiError::unauthorized()
        });
    }
    owned_space(conn, auth.user_id, space_id)
}

/// Finds the space `space_id` (hex from the path) of the user. A malformed id, an unknown space
/// and somebody else's space all give the same `404` (П6).
pub(crate) fn owned_space(
    conn: &Connection,
    user_id: i64,
    space_id: &str,
) -> ApiResult<OwnedSpace> {
    let space_id = unhex_array::<16>(space_id).ok_or_else(ApiError::not_found)?;
    conn.query_row(
        "SELECT id, seq, purged_seq FROM spaces WHERE space_id = ?1 AND user_id = ?2",
        params![space_id.as_slice(), user_id],
        |row| {
            Ok(OwnedSpace {
                row: row.get(0)?,
                space_id,
                seq: row.get(1)?,
                purged_seq: row.get(2)?,
            })
        },
    )
    .optional()?
    .ok_or_else(ApiError::not_found)
}

/// `POST /v1/spaces` (П20).
pub(crate) async fn create(State(state): State<AppState>, request: Request) -> ApiResult<Response> {
    let (parts, body) = split(request);
    let auth = authenticate(&state, &parts)?;
    let request = read_json(&state, &parts, body).await?;
    let space_id = field_hex::<16>(&request, "space_id")?;
    let name_enc = field_hex_vec(&request, "name_enc", NAME_ENVELOPE_LEN)?;
    if field_u64(&request, "key_epoch")? != 1 {
        return Err(ApiError::bad_request("`key_epoch` must be 1"));
    }
    let wrapped_vk = field_hex_vec(&request, "wrapped_vk", WRAPPED_KEY_LEN)?;
    let now = state.clock.now_ms();
    let exists = state.db.write(|tx| -> ApiResult<bool> {
        // Н4, Н5: a new space needs a subscription; first, in the transaction of the write.
        crate::quota::require_subscription(&state, tx, auth.user_id)?;
        // Х1: no room on the disk, no new space.
        crate::quota::require_free_space(&state)?;
        let taken: bool = tx
            .query_row(
                "SELECT 1 FROM spaces WHERE space_id = ?1",
                [space_id.as_slice()],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if taken {
            return Ok(true);
        }
        // П60: the plan allows so many spaces; an existing space is answered before this.
        if let Some(max) = crate::quota::resolve_user(&state, tx, auth.user_id)?
            .limits
            .max_spaces
        {
            let have: u64 = tx.query_row(
                "SELECT COUNT(*) FROM spaces WHERE user_id = ?1",
                [auth.user_id],
                |row| row.get(0),
            )?;
            if have >= max {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    code::SPACE_LIMIT,
                    "the plan allows no more spaces",
                )
                .with_details(json!({ "max_spaces": max, "spaces": have })));
            }
        }
        tx.execute(
            "INSERT INTO spaces (space_id, user_id, name_enc, key_epoch, wrapped_vk, created_ms) \
             VALUES (?1, ?2, ?3, 1, ?4, ?5)",
            params![space_id.as_slice(), auth.user_id, name_enc, wrapped_vk, now],
        )?;
        Ok(false)
    })?;
    if exists {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            code::SPACE_EXISTS,
            "a space with this id already exists",
        ));
    }
    Ok(json_response(
        StatusCode::CREATED,
        &json!({ "space_id": hex(&space_id), "seq": 0, "created_ms": now }),
    ))
}

/// `GET /v1/spaces` (П20).
pub(crate) async fn list(State(state): State<AppState>, request: Request) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let spaces = state.db.call(|conn| -> rusqlite::Result<Vec<Value>> {
        let mut statement = conn.prepare(
            "SELECT space_id, name_enc, key_epoch, wrapped_vk, seq, created_ms FROM spaces \
             WHERE user_id = ?1 ORDER BY id",
        )?;
        let rows = statement.query_map([auth.user_id], |row| {
            Ok(json!({
                "space_id": hex(&row.get::<_, Vec<u8>>(0)?),
                "name_enc": hex(&row.get::<_, Vec<u8>>(1)?),
                "key_epoch": row.get::<_, i64>(2)?,
                "wrapped_vk": hex(&row.get::<_, Vec<u8>>(3)?),
                "seq": row.get::<_, i64>(4)?,
                "created_ms": row.get::<_, i64>(5)?,
            }))
        })?;
        rows.collect()
    })?;
    Ok(json_response(StatusCode::OK, &json!({ "spaces": spaces })))
}
