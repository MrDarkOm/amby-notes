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

/// A space of the signed-in user.
#[derive(Debug, Clone, Copy)]
pub(crate) struct OwnedSpace {
    /// The row number inside the database.
    pub(crate) row: i64,
    pub(crate) space_id: [u8; 16],
    pub(crate) seq: u64,
    pub(crate) purged_seq: u64,
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
    let exists = state.db.write(|tx| -> rusqlite::Result<bool> {
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
