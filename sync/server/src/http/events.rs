//! Server-Sent Events: "check the feed" (П34).

use std::convert::Infallible;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::stream;
use rusqlite::OptionalExtension;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::MissedTickBehavior;

use super::spaces::owned_space;
use super::util::{authenticate, hex, ApiError, ApiResult, Auth};
use super::{split, Params};
use crate::state::{AppState, HubEvent};

/// Whether the token of the stream is still alive. A revoked device gets nothing more (П19, П34).
fn token_alive(state: &AppState, auth: &Auth) -> bool {
    state
        .db
        .call(|conn| {
            conn.query_row(
                "SELECT 1 FROM devices WHERE token_hash = ?1",
                [auth.token_hash.as_slice()],
                |_| Ok(()),
            )
            .optional()
        })
        .ok()
        .flatten()
        .is_some()
}

struct Running {
    first: Option<String>,
    events: tokio::sync::broadcast::Receiver<HubEvent>,
    ticker: tokio::time::Interval,
    state: AppState,
    auth: Auth,
    space_id: [u8; 16],
}

/// `GET /v1/spaces/{space_id}/events` (П34).
pub(crate) async fn events(
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
    // Listen before reading the head, so that no commit falls between the two.
    let events = state.hub.subscribe();
    let space = state
        .db
        .call(|conn| owned_space(conn, auth.user_id, &space_text))?;
    let instance_id = state
        .db
        .call(|conn| crate::db::meta_value(conn, "instance_id"))
        .map_err(ApiError::internal)?;
    let hello = format!(
        "event: hello\ndata: {}\n\n",
        json!({ "seq": space.seq, "instance_id": hex(&instance_id) })
    );
    let keepalive = Duration::from_secs(state.config.sse_keepalive_secs);
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + keepalive, keepalive);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let running = Running {
        first: Some(hello),
        events,
        ticker,
        state,
        auth,
        space_id: space.space_id,
    };
    let chunks = stream::unfold(running, |mut run| async move {
        if let Some(first) = run.first.take() {
            return Some((Ok::<_, Infallible>(Bytes::from(first)), run));
        }
        loop {
            tokio::select! {
                received = run.events.recv() => match received {
                    Ok(HubEvent::Commit { space_id, seq, device_id, items }) if space_id == run.space_id => {
                        if !token_alive(&run.state, &run.auth) {
                            return None;
                        }
                        let data = json!({ "seq": seq, "device_id": hex(&device_id), "items": items });
                        let text = format!("event: commit\nid: {seq}\ndata: {data}\n\n");
                        return Some((Ok(Bytes::from(text)), run));
                    }
                    Ok(HubEvent::Revoked { device_id }) if device_id == run.auth.device_id => return None,
                    // Another space, another device, or events that were missed: events are
                    // only a nudge, the device reads the feed from its cursor (П34).
                    Ok(_) | Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                },
                _ = run.ticker.tick() => {
                    if !token_alive(&run.state, &run.auth) {
                        return None;
                    }
                    return Some((Ok(Bytes::from_static(b": ping\n\n")), run));
                }
            }
        }
    });
    let mut response = Response::new(Body::from_stream(chunks));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    // Tells nginx-like proxies not to hold the stream back.
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}
