//! Bodies in parts (П21–П25).

use std::io::SeekFrom;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::stream;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use amby_sync_proto::error_code as code;
use amby_sync_proto::PART_SIZE;

use super::spaces::owned_space;
use super::util::{
    authenticate, field_hex, field_u64, hex, json_response, read_json, read_limited, unhex_array,
    ApiError, ApiResult, ReadError,
};
use super::{split, Params};
use crate::state::AppState;
use crate::store::{BlobKey, BlobStore};

/// How many parts a body of `size` bytes has (П21).
fn part_count(size: u64) -> u64 {
    size.div_ceil(PART_SIZE).max(1)
}

/// What the server knows of one body.
struct BlobRow {
    size: u64,
    complete: bool,
}

fn blob_row(
    conn: &rusqlite::Connection,
    space: i64,
    blob_id: &[u8; 16],
) -> rusqlite::Result<Option<BlobRow>> {
    conn.query_row(
        "SELECT size, complete FROM blobs WHERE space = ?1 AND blob_id = ?2",
        params![space, blob_id.as_slice()],
        |row| {
            Ok(BlobRow {
                size: row.get(0)?,
                complete: row.get(1)?,
            })
        },
    )
    .optional()
}

/// The state of a body as `POST /blobs` and `complete` report it (П21, П23).
fn blob_state(state: &AppState, key: &BlobKey, row: &BlobRow) -> ApiResult<Value> {
    let parts = part_count(row.size);
    let uploaded: Vec<u64> = if row.complete {
        (0..parts).collect()
    } else {
        state
            .files
            .list_parts(key)?
            .into_iter()
            .map(u64::from)
            .filter(|part| *part < parts)
            .collect()
    };
    Ok(json!({
        "blob_id": hex(&key.blob_id),
        "size": row.size,
        "part_size": PART_SIZE,
        "parts": parts,
        "uploaded": uploaded,
        "complete": row.complete,
    }))
}

fn blob_id_from(params: &Params) -> ApiResult<[u8; 16]> {
    params
        .0
        .get("blob_id")
        .and_then(|text| unhex_array::<16>(text))
        .ok_or_else(ApiError::not_found)
}

fn space_param(params: &Params) -> &str {
    params.0.get("space_id").map_or("", String::as_str)
}

/// `POST /blobs` (П21, П42).
pub(crate) async fn start(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, body) = split(request);
    let auth = authenticate(&state, &parts)?;
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, space_param(&params)))?;
    let request = read_json(&state, &parts, body).await?;
    let blob_id = field_hex::<16>(&request, "blob_id")?;
    let size = field_u64(&request, "size")?;
    if size == 0 {
        return Err(ApiError::bad_request("`size` must be at least 1"));
    }
    let replaces = match request.get("replaces") {
        None | Some(Value::Null) => None,
        Some(_) => Some(field_hex::<16>(&request, "replaces")?),
    };
    let key = BlobKey {
        space_id: space.space_id,
        blob_id,
    };
    let now = state.clock.now_ms();
    let outcome = state.db.write(|tx| -> ApiResult<(bool, BlobRow)> {
        let plan = crate::quota::resolve_user(&state, tx, auth.user_id)?;
        // Е.4: size (413), then a body that is already there (200/409), then the quota (507).
        if let Some(max) = plan.limits.max_file_bytes {
            if size > max {
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    code::BLOB_TOO_LARGE,
                    "the body is larger than the server accepts",
                )
                .with_details(
                    json!({ "size": size, "max_bytes": max, "source": plan.file_source() }),
                ));
            }
        }
        if let Some(row) = blob_row(tx, space.row, &blob_id)? {
            if row.size != size {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    code::BLOB_EXISTS,
                    "this body was started with another size",
                ));
            }
            return Ok((false, row));
        }
        if let Some(limit) = plan.limits.max_total_bytes {
            let used =
                crate::quota::user_usage(tx, auth.user_id, crate::quota::pending_cutoff(&state))?
                    .counted();
            // П56-б: the hint is checked here, in the space of the caller, and gives a credit
            // only for a live body.
            let credit = match &replaces {
                Some(item) => crate::quota::live_body_of(tx, space.row, item)?,
                None => 0,
            };
            let needed = used.saturating_add(size).saturating_sub(credit);
            if needed > limit && size > credit {
                return Err(ApiError::new(
                    StatusCode::INSUFFICIENT_STORAGE,
                    code::QUOTA_EXCEEDED,
                    "the storage quota would be exceeded",
                )
                .with_details(json!({
                    "used_bytes": used,
                    "limit_bytes": limit,
                    "needed_bytes": needed - limit,
                })));
            }
        }
        tx.execute(
            "INSERT INTO blobs (space, blob_id, size, complete, created_ms, activity_ms) \
             VALUES (?1, ?2, ?3, 0, ?4, ?4)",
            params![space.row, blob_id.as_slice(), size, now],
        )?;
        Ok((
            true,
            BlobRow {
                size,
                complete: false,
            },
        ))
    });
    let (created, row) = outcome?;
    if created {
        state.files.create(&key, size)?;
    }
    let answer = blob_state(&state, &key, &row)?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok(json_response(status, &answer))
}

/// `PUT /blobs/{blob_id}/parts/{n}` (П22).
pub(crate) async fn put_part(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, body) = split(request);
    let auth = authenticate(&state, &parts)?;
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, space_param(&params)))?;
    let blob_id = blob_id_from(&params)?;
    let row = state
        .db
        .call(|conn| blob_row(conn, space.row, &blob_id))?
        .ok_or_else(ApiError::not_found)?;
    if row.complete {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            code::BLOB_EXISTS,
            "the body is already complete",
        ));
    }
    let bad_part = || {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            code::BAD_PART,
            "the part number or length is wrong",
        )
    };
    let number: u64 = params
        .0
        .get("n")
        .and_then(|text| text.parse().ok())
        .ok_or_else(bad_part)?;
    let total = part_count(row.size);
    if number >= total {
        return Err(bad_part());
    }
    let expected = if number + 1 < total {
        PART_SIZE
    } else {
        row.size - number * PART_SIZE
    };
    let data = read_limited(body, usize::try_from(PART_SIZE).unwrap_or(usize::MAX))
        .await
        .map_err(|error| match error {
            ReadError::TooLarge => bad_part(),
            ReadError::Broken => ApiError::bad_request("the request body could not be read"),
        })?;
    if data.len() as u64 != expected {
        return Err(bad_part());
    }
    let key = BlobKey {
        space_id: space.space_id,
        blob_id,
    };
    let length = data.len();
    let files = state.files.clone();
    let number32 = u32::try_from(number).map_err(|_| bad_part())?;
    tokio::task::spawn_blocking(move || files.put_part(&key, number32, &data))
        .await
        .map_err(ApiError::internal)??;
    let now = state.clock.now_ms();
    // The part is on disk before the database hears of it; the activity restarts the 24 hours
    // (П25). A body removed in the meantime is not found any more.
    let touched = state.db.call(|conn| {
        conn.execute(
            "UPDATE blobs SET activity_ms = ?3 WHERE space = ?1 AND blob_id = ?2 AND complete = 0",
            params![space.row, blob_id.as_slice(), now],
        )
    })?;
    if touched == 0 {
        return Err(ApiError::not_found());
    }
    Ok(json_response(
        StatusCode::OK,
        &json!({ "part": number, "size": length }),
    ))
}

/// `POST /blobs/{blob_id}/complete` (П23).
pub(crate) async fn complete(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, space_param(&params)))?;
    let blob_id = blob_id_from(&params)?;
    let row = state
        .db
        .call(|conn| blob_row(conn, space.row, &blob_id))?
        .ok_or_else(ApiError::not_found)?;
    let key = BlobKey {
        space_id: space.space_id,
        blob_id,
    };
    let finished = json!({ "blob_id": hex(&blob_id), "size": row.size, "complete": true });
    if row.complete {
        return Ok(json_response(StatusCode::OK, &finished));
    }
    let total = part_count(row.size);
    let have = state.files.list_parts(&key)?;
    let missing: Vec<u64> = (0..total)
        .filter(|part| !have.contains(&u32::try_from(*part).unwrap_or(u32::MAX)))
        .collect();
    if !missing.is_empty() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            code::PARTS_MISSING,
            "some parts have not arrived",
        )
        .with_details(json!({ "missing": missing })));
    }
    // 1. The joined body is written, synced and renamed into place. 2. The database learns it
    // is complete; from here on a commit may refer to it. 3. The parts are removed. A crash
    // after 1 is repaired by the next `complete`; after 2 it only leaves part files to sweep.
    let files = state.files.clone();
    let total32 = u32::try_from(total).map_err(ApiError::internal)?;
    tokio::task::spawn_blocking(move || files.assemble(&key, total32))
        .await
        .map_err(ApiError::internal)??;
    let now = state.clock.now_ms();
    state.db.call(|conn| {
        conn.execute(
            "UPDATE blobs SET complete = 1, activity_ms = ?3 WHERE space = ?1 AND blob_id = ?2",
            params![space.row, blob_id.as_slice(), now],
        )
    })?;
    // Only a leftover on failure; the cleanup sweeps it.
    let _ = state.files.remove_parts(&key);
    Ok(json_response(StatusCode::OK, &finished))
}

/// A byte range of a body (RFC 9110).
enum RangeRequest {
    /// No `Range` header, or one this server does not understand: the whole body.
    Whole,
    /// First and last byte, inclusive.
    Bytes(u64, u64),
    /// The range lies outside the body.
    Unsatisfiable,
}

fn parse_range(header: Option<&HeaderValue>, size: u64) -> RangeRequest {
    let Some(spec) = header
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().strip_prefix("bytes="))
    else {
        return RangeRequest::Whole;
    };
    // Several ranges are not supported: the whole body is a valid answer to them.
    let Some((start, end)) = spec.trim().split_once('-') else {
        return RangeRequest::Whole;
    };
    let (start, end) = (start.trim(), end.trim());
    if start.is_empty() {
        // The last `n` bytes.
        return match end.parse::<u64>() {
            Ok(0) => RangeRequest::Unsatisfiable,
            Ok(n) => RangeRequest::Bytes(size.saturating_sub(n), size - 1),
            Err(_) => RangeRequest::Whole,
        };
    }
    let Ok(first) = start.parse::<u64>() else {
        return RangeRequest::Whole;
    };
    let last = if end.is_empty() {
        size.saturating_sub(1)
    } else {
        match end.parse::<u64>() {
            Ok(last) => last.min(size.saturating_sub(1)),
            Err(_) => return RangeRequest::Whole,
        }
    };
    if first >= size || last < first {
        RangeRequest::Unsatisfiable
    } else {
        RangeRequest::Bytes(first, last)
    }
}

/// `GET /blobs/{blob_id}` (П24): streamed from the file, never held whole in memory.
pub(crate) async fn download(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, space_param(&params)))?;
    let blob_id = blob_id_from(&params)?;
    let row = state
        .db
        .call(|conn| blob_row(conn, space.row, &blob_id))?
        .filter(|row| row.complete)
        .ok_or_else(ApiError::not_found)?;
    let key = BlobKey {
        space_id: space.space_id,
        blob_id,
    };
    let (status, first, last) = match parse_range(parts.headers.get(header::RANGE), row.size) {
        RangeRequest::Whole => (StatusCode::OK, 0, row.size - 1),
        RangeRequest::Bytes(first, last) => (StatusCode::PARTIAL_CONTENT, first, last),
        RangeRequest::Unsatisfiable => {
            let mut error = ApiError::new(
                StatusCode::RANGE_NOT_SATISFIABLE,
                code::RANGE_NOT_SATISFIABLE,
                "the range is outside the body",
            )
            .into_response_with(|headers| {
                if let Ok(value) = HeaderValue::from_str(&format!("bytes */{}", row.size)) {
                    headers.insert(header::CONTENT_RANGE, value);
                }
            });
            error.headers_mut().remove(header::CONTENT_LENGTH);
            return Ok(error);
        }
    };
    let mut file = tokio::fs::File::open(state.files.body_path(&key))
        .await
        .map_err(|error| {
            // A complete row without a file must never happen; say so loudly in the log.
            ApiError::internal(format!("a complete body has no file: {error}"))
        })?;
    file.seek(SeekFrom::Start(first))
        .await
        .map_err(ApiError::internal)?;
    let length = last - first + 1;
    let chunks = stream::unfold((file, length), |(mut file, left)| async move {
        if left == 0 {
            return None;
        }
        let mut buffer = vec![0u8; usize::try_from(left.min(256 * 1024)).unwrap_or(256 * 1024)];
        match file.read(&mut buffer).await {
            Ok(0) => None,
            Ok(read) => {
                buffer.truncate(read);
                Some((Ok::<_, std::io::Error>(buffer), (file, left - read as u64)))
            }
            Err(error) => Some((Err(error), (file, 0))),
        }
    });
    let mut response = Response::new(Body::from_stream(chunks));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    if status == StatusCode::PARTIAL_CONTENT {
        if let Ok(value) = HeaderValue::from_str(&format!("bytes {first}-{last}/{}", row.size)) {
            headers.insert(header::CONTENT_RANGE, value);
        }
    }
    Ok(response)
}

/// `DELETE /blobs/{blob_id}` (П56-д): drops an own body that no version refers to, the bytes
/// come back at once. A body a version refers to (the latest or a replaced one) is `409`.
pub(crate) async fn delete(
    State(state): State<AppState>,
    params: Params,
    request: Request,
) -> ApiResult<Response> {
    let (parts, _) = split(request);
    let auth = authenticate(&state, &parts)?;
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, space_param(&params)))?;
    let blob_id = blob_id_from(&params)?;
    let key = BlobKey {
        space_id: space.space_id,
        blob_id,
    };
    // The row goes first and the files after, under the lock (as in the cleanup): a body
    // started again under the same id keeps its new files.
    state.db.write_then(
        |tx| -> ApiResult<()> {
            if blob_row(tx, space.row, &blob_id)?.is_none() {
                return Err(ApiError::not_found());
            }
            let used: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM versions WHERE space = ?1 AND blob_id = ?2)",
                params![space.row, blob_id.as_slice()],
                |row| row.get(0),
            )?;
            if used {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    code::BLOB_EXISTS,
                    "a version refers to this body",
                ));
            }
            tx.execute(
                "DELETE FROM blobs WHERE space = ?1 AND blob_id = ?2",
                params![space.row, blob_id.as_slice()],
            )?;
            Ok(())
        },
        |tx, ()| {
            if !crate::maintenance::row_exists(tx, &key)? {
                state.files.delete(&key)?;
            }
            Ok(())
        },
    )?;
    Ok(Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .map_err(ApiError::internal)?)
}
