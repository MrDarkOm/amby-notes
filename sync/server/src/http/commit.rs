//! The atomic commit (Р2, Р3, П26–П30).

use std::collections::HashSet;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use amby_sync_proto::error_code as code;

use super::spaces::owned_space;
use super::util::{
    authenticate, field_hex, hex, json_response, read_json, sha256, unhex, unhex_array, ApiError,
    ApiResult,
};
use super::{split, Params};
use crate::state::{AppState, HubEvent};

/// The shortest envelope of a header: 1 + 4 + 24 + 256 + 16 (П26, Ф18).
const MIN_HEADER_LEN: usize = 301;

/// One entry of a commit request (П26).
struct Entry {
    item_id: [u8; 16],
    base_version: u64,
    header: Vec<u8>,
    blob_id: Option<[u8; 16]>,
    deleted: bool,
}

fn parse_entry(value: &Value, max_header: usize) -> ApiResult<Entry> {
    let item_id = field_hex::<16>(value, "item_id")?;
    let base_version = value["base_version"]
        .as_u64()
        .ok_or_else(|| ApiError::bad_request("`base_version` is missing or malformed"))?;
    let header = value["header"]
        .as_str()
        .filter(|text| text.len() <= max_header.saturating_mul(2))
        .and_then(unhex)
        .filter(|bytes| (MIN_HEADER_LEN..=max_header).contains(&bytes.len()))
        .ok_or_else(|| ApiError::bad_request("`header` is missing, malformed or the wrong size"))?;
    let blob_id = match value.get("blob_id") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(
            unhex_array::<16>(text)
                .ok_or_else(|| ApiError::bad_request("`blob_id` is malformed"))?,
        ),
        _ => return Err(ApiError::bad_request("`blob_id` is missing or malformed")),
    };
    let deleted = value["deleted"]
        .as_bool()
        .ok_or_else(|| ApiError::bad_request("`deleted` is missing or malformed"))?;
    Ok(Entry {
        item_id,
        base_version,
        header,
        blob_id,
        deleted,
    })
}

/// SHA-256 of the canonical form of the items, to tell a replay from a reused id (П28).
fn digest(entries: &[Entry]) -> [u8; 32] {
    let mut bytes = Vec::new();
    for entry in entries {
        bytes.extend_from_slice(&entry.item_id);
        bytes.extend_from_slice(&entry.base_version.to_be_bytes());
        bytes.extend_from_slice(&(entry.header.len() as u64).to_be_bytes());
        bytes.extend_from_slice(&entry.header);
        match &entry.blob_id {
            Some(blob) => {
                bytes.push(1);
                bytes.extend_from_slice(blob);
            }
            None => bytes.push(0),
        }
        bytes.push(u8::from(entry.deleted));
    }
    sha256(&bytes)
}

/// How a commit ended inside its transaction.
enum Outcome {
    Accepted { response: Value, seq: u64 },
    Replayed(Value),
    Refused(ApiError),
}

/// `POST /v1/spaces/{space_id}/commit` (П26–П30).
pub(crate) async fn commit(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, body) = split(request);
    let auth = authenticate(&state, &parts)?;
    let space_text = params
        .0
        .get("space_id")
        .map_or("", String::as_str)
        .to_string();
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, &space_text))?;
    let request = read_json(&state, &parts, body).await?;
    let commit_id = field_hex::<16>(&request, "commit_id")?;
    let raw = request["items"]
        .as_array()
        .ok_or_else(|| ApiError::bad_request("`items` is missing or malformed"))?;
    if raw.is_empty() {
        return Err(ApiError::bad_request("a commit needs at least one item"));
    }
    if raw.len() > state.config.max_commit_items {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            code::TOO_MANY_ITEMS,
            "too many items in one commit",
        ));
    }
    let entries = raw
        .iter()
        .map(|value| parse_entry(value, state.config.max_header_bytes))
        .collect::<ApiResult<Vec<_>>>()?;
    let mut seen = HashSet::new();
    if !entries.iter().all(|entry| seen.insert(entry.item_id)) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            code::DUPLICATE_ITEM,
            "the same item twice in one commit",
        ));
    }
    let digest = digest(&entries);
    let now = state.clock.now_ms();
    let device_id = auth.device_id;

    // One transaction takes the write lock first: the check of the bases and the write are not
    // separated by another commit (Р3, П27), and a refused commit changes nothing.
    let outcome = state.db.write(|tx| -> rusqlite::Result<Outcome> {
        let known: Option<(Vec<u8>, String)> = tx
            .query_row(
                "SELECT digest, response FROM commits WHERE space = ?1 AND commit_id = ?2",
                params![space.row, commit_id.as_slice()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((stored, response)) = known {
            if stored == digest {
                let mut response: Value =
                    serde_json::from_str(&response).unwrap_or(Value::Null);
                response["replayed"] = json!(true);
                return Ok(Outcome::Replayed(response));
            }
            return Ok(Outcome::Refused(ApiError::new(
                StatusCode::CONFLICT,
                code::COMMIT_ID_REUSED,
                "this commit id was used with other content",
            )));
        }
        // П30 first: every body must be complete and in this space.
        for entry in &entries {
            if let Some(blob) = &entry.blob_id {
                let complete: bool = tx
                    .query_row(
                        "SELECT complete FROM blobs WHERE space = ?1 AND blob_id = ?2",
                        params![space.row, blob.as_slice()],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(false);
                if !complete {
                    return Ok(Outcome::Refused(ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        code::UNKNOWN_BLOB,
                        "a body is unknown or not complete",
                    )));
                }
            }
        }
        // Then the versions, all of them, so the answer lists every conflict (П27).
        let mut conflicts = Vec::new();
        for entry in &entries {
            let current: u64 = tx
                .query_row(
                    "SELECT version FROM versions \
                     WHERE space = ?1 AND item_id = ?2 AND superseded_ms IS NULL",
                    params![space.row, entry.item_id.as_slice()],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if current != entry.base_version {
                conflicts.push(json!({
                    "item_id": hex(&entry.item_id),
                    "base_version": entry.base_version,
                    "current_version": current,
                }));
            }
        }
        if !conflicts.is_empty() {
            return Ok(Outcome::Refused(
                ApiError::new(
                    StatusCode::CONFLICT,
                    code::VERSION_CONFLICT,
                    "a base version did not match; nothing was applied",
                )
                .with_details(json!({ "conflicts": conflicts })),
            ));
        }
        let head: u64 = tx.query_row("SELECT seq FROM spaces WHERE id = ?1", [space.row], |row| {
            row.get(0)
        })?;
        let seq = head + 1;
        let mut results = Vec::with_capacity(entries.len());
        for (ord, entry) in entries.iter().enumerate() {
            if entry.base_version > 0 {
                tx.execute(
                    "UPDATE versions SET superseded_ms = ?4 \
                     WHERE space = ?1 AND item_id = ?2 AND version = ?3",
                    params![space.row, entry.item_id.as_slice(), entry.base_version, now],
                )?;
            }
            let version = entry.base_version + 1;
            tx.execute(
                "INSERT INTO versions (space, item_id, version, seq, ord, header, blob_id, \
                 deleted, device_id, committed_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    space.row,
                    entry.item_id.as_slice(),
                    version,
                    seq,
                    ord as u64,
                    entry.header,
                    entry.blob_id.as_ref().map(<[u8; 16]>::as_slice),
                    entry.deleted,
                    device_id.as_slice(),
                    now
                ],
            )?;
            results.push(json!({ "item_id": hex(&entry.item_id), "version": version }));
        }
        tx.execute("UPDATE spaces SET seq = ?2 WHERE id = ?1", params![space.row, seq])?;
        let response = json!({
            "commit_id": hex(&commit_id),
            "seq": seq,
            "committed_ms": now,
            "replayed": false,
            "items": results,
        });
        tx.execute(
            "INSERT INTO commits (space, commit_id, digest, response, committed_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                space.row,
                commit_id.as_slice(),
                digest.as_slice(),
                response.to_string(),
                now
            ],
        )?;
        Ok(Outcome::Accepted { response, seq })
    })?;

    match outcome {
        Outcome::Accepted { response, seq } => {
            // Nobody may be listening: that is fine (П34).
            let _ = state.hub.send(HubEvent::Commit {
                space_id: space.space_id,
                seq,
                device_id,
                items: entries.len(),
            });
            Ok(json_response(StatusCode::OK, &response))
        }
        Outcome::Replayed(response) => Ok(json_response(StatusCode::OK, &response)),
        Outcome::Refused(error) => Err(error),
    }
}
