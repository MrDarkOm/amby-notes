//! The change feed and the history of an item (П31–П33).

use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::Response;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::spaces::owned_space;
use super::util::{authenticate, hex, json_response, unhex_array, ApiError, ApiResult};
use super::{split, Params};
use crate::state::AppState;

/// `changes_page_default` of `/v1/info` (П31).
pub(crate) const PAGE_DEFAULT: u64 = 500;
/// `changes_page_max` of `/v1/info` (П31).
pub(crate) const PAGE_MAX: u64 = 1000;

/// A whole number written in digits and nothing else (no sign, no fraction).
fn digits(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// The last value of the query parameter `name`.
fn query<'a>(parts: &'a Parts, name: &str) -> Option<&'a str> {
    parts
        .uri
        .query()?
        .split('&')
        .filter_map(|pair| pair.split_once('=').or(Some((pair, ""))))
        .filter(|(key, _)| *key == name)
        .map(|(_, value)| value)
        .next_back()
}

/// One entry of the feed or of a history, as the JSON of П31/П33 shows it.
fn version_json(row: &rusqlite::Row<'_>, with_superseded: bool) -> rusqlite::Result<Value> {
    let blob_id: Option<Vec<u8>> = row.get(4)?;
    let blob_size: Option<i64> = row.get(5)?;
    let mut entry = json!({
        "seq": row.get::<_, i64>(0)?,
        "item_id": hex(&row.get::<_, Vec<u8>>(1)?),
        "version": row.get::<_, i64>(2)?,
        "header": hex(&row.get::<_, Vec<u8>>(3)?),
        "blob_id": blob_id.map(|id| hex(&id)),
        "blob_size": blob_size,
        "deleted": row.get::<_, bool>(6)?,
        "device_id": hex(&row.get::<_, Vec<u8>>(7)?),
        "committed_ms": row.get::<_, i64>(8)?,
    });
    if with_superseded {
        entry["superseded_ms"] = json!(row.get::<_, Option<i64>>(9)?);
    }
    Ok(entry)
}

/// `GET /v1/spaces/{space_id}/changes` (П31, П32).
pub(crate) async fn changes(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let space_text = params
        .0
        .get("space_id")
        .map_or("", String::as_str)
        .to_string();
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, &space_text))?;
    let since = match query(&parts, "since") {
        None => 0,
        Some(text) => {
            digits(text).ok_or_else(|| ApiError::bad_request("`since` is not a number"))?
        }
    };
    let limit = match query(&parts, "limit") {
        None => PAGE_DEFAULT,
        Some(text) => digits(text)
            .filter(|limit| *limit >= 1)
            .ok_or_else(|| ApiError::bad_request("`limit` is not a positive number"))?
            .min(PAGE_MAX),
    };
    let answer = state.db.call(|conn| -> rusqlite::Result<Value> {
        let instance_id = crate::db::meta_value(conn, "instance_id")?;
        let (changes, next, more) = page(conn, space.row, since, limit)?;
        Ok(json!({
            "instance_id": hex(&instance_id),
            "seq": space.seq,
            "since": since,
            "next": next,
            "more": more,
            "gap": since < space.purged_seq,
            "changes": changes,
        }))
    })?;
    Ok(json_response(StatusCode::OK, &answer))
}

/// Whole commits, as they are left in the feed, until the sum of the entries would pass `limit`
/// (but at least one commit): a renamed folder arrives together (Р2, П31).
fn page(
    conn: &Connection,
    space: i64,
    since: u64,
    limit: u64,
) -> rusqlite::Result<(Vec<Value>, u64, bool)> {
    let mut statement = conn.prepare_cached(
        "SELECT v.seq, v.item_id, v.version, v.header, v.blob_id, b.size, v.deleted, \
         v.device_id, v.committed_ms FROM versions v \
         LEFT JOIN blobs b ON b.space = v.space AND b.blob_id = v.blob_id \
         WHERE v.space = ?1 AND v.superseded_ms IS NULL AND v.seq > ?2 \
         ORDER BY v.seq, v.ord",
    )?;
    let mut rows = statement.query(params![space, since])?;
    let mut taken: Vec<Value> = Vec::new();
    let mut group: Vec<Value> = Vec::new();
    let mut group_seq = 0u64;
    let mut next = since;
    let mut more = false;
    // A finished commit joins the page when it fits, or when the page is still empty.
    let fits = |taken: &[Value], group: &[Value]| {
        taken.is_empty() || (taken.len() + group.len()) as u64 <= limit
    };
    while let Some(row) = rows.next()? {
        let seq = u64::try_from(row.get::<_, i64>(0)?).unwrap_or(0);
        if seq != group_seq && !group.is_empty() {
            if !fits(&taken, &group) {
                more = true;
                break;
            }
            taken.append(&mut group);
            next = group_seq;
        }
        group_seq = seq;
        group.push(version_json(row, false)?);
    }
    if !more && !group.is_empty() {
        if fits(&taken, &group) {
            taken.append(&mut group);
            next = group_seq;
        } else {
            more = true;
        }
    }
    Ok((taken, next, more))
}

/// `GET /v1/spaces/{space_id}/items/{item_id}/versions` (П33).
pub(crate) async fn versions(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let space_text = params
        .0
        .get("space_id")
        .map_or("", String::as_str)
        .to_string();
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, &space_text))?;
    let item_id = params
        .0
        .get("item_id")
        .and_then(|text| unhex_array::<16>(text))
        .ok_or_else(ApiError::not_found)?;
    let versions = state.db.call(|conn| -> rusqlite::Result<Vec<Value>> {
        let mut statement = conn.prepare_cached(
            "SELECT v.seq, v.item_id, v.version, v.header, v.blob_id, b.size, v.deleted, \
             v.device_id, v.committed_ms, v.superseded_ms FROM versions v \
             LEFT JOIN blobs b ON b.space = v.space AND b.blob_id = v.blob_id \
             WHERE v.space = ?1 AND v.item_id = ?2 ORDER BY v.version DESC",
        )?;
        let rows = statement.query_map(params![space.row, item_id.as_slice()], |row| {
            version_json(row, true)
        })?;
        rows.collect()
    })?;
    if versions.is_empty() {
        return Err(ApiError::not_found());
    }
    Ok(json_response(
        StatusCode::OK,
        &json!({ "item_id": hex(&item_id), "versions": versions }),
    ))
}
