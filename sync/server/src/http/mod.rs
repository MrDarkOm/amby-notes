//! The HTTP side: the shapes every handler shares, then one file per group of routes.

pub(crate) mod account;
pub(crate) mod blobs;
pub(crate) mod commit;
pub(crate) mod events;
pub(crate) mod feed;
pub(crate) mod spaces;
pub(crate) mod throttle;
pub(crate) mod util;

use std::collections::HashMap;

use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::state::AppState;

pub(crate) use util::{ApiError, ApiResult};

/// Path parameters by name.
pub(crate) type Params = Path<HashMap<String, String>>;

/// `GET /v1/info` (П9). No token.
pub(crate) async fn info(State(state): State<AppState>) -> ApiResult<Response> {
    let config = &state.config;
    let instance_id = state
        .db
        .call(|conn| crate::db::meta_value(conn, "instance_id"))?;
    let body = json!({
        "server": "amby-sync-server",
        "server_version": env!("CARGO_PKG_VERSION"),
        "protocol": { "min": amby_sync_proto::PROTOCOL_VERSION, "max": amby_sync_proto::PROTOCOL_VERSION },
        "formats": { "header": 1, "body": 1 },
        "instance_id": util::hex(&instance_id),
        "time_ms": state.clock.now_ms(),
        "limits": {
            "max_blob_bytes": config.max_blob_bytes,
            "part_size": amby_sync_proto::PART_SIZE,
            "max_commit_items": config.max_commit_items,
            "max_header_bytes": config.max_header_bytes,
            "max_json_bytes": config.max_json_bytes,
            "changes_page_default": feed::PAGE_DEFAULT,
            "changes_page_max": feed::PAGE_MAX,
            "login_max_failures": config.login_max_failures,
            "login_window_secs": config.login_window_secs,
            "sse_keepalive_secs": config.sse_keepalive_secs,
            "login_max_failures_per_user": config.login_max_failures_per_user,
            "login_window_per_user_secs": config.login_window_per_user_secs,
            "quota_bytes_per_user": config.quota_bytes_per_user,
        },
        "retention": {
            "version_days": config.retain_version_days,
            "orphan_blob_hours": config.orphan_blob_hours,
            "enroll_code_hours": config.enroll_code_hours,
        },
    });
    Ok(util::json_response(StatusCode::OK, &body))
}

/// An unknown path (П4, П6).
pub(crate) async fn not_found() -> Response {
    ApiError::not_found().into_response()
}

/// A known path with a method it does not have (П4).
pub(crate) async fn method_not_allowed() -> Response {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        amby_sync_proto::error_code::METHOD_NOT_ALLOWED,
        "this method is not allowed for this path",
    )
    .into_response()
}

/// Splits a request into the parts the handlers use.
pub(crate) fn split(request: Request) -> (axum::http::request::Parts, axum::body::Body) {
    request.into_parts()
}
