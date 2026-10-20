//! The router (П1, table Р11). In the stub stage every path, every method and every unknown
//! path answers `501 not_implemented`, so a test cannot pass by accident.

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::json;

use crate::state::AppState;

/// Every route of appendix Б, relative to the server root. Axum 0.8 syntax for parameters.
pub const ROUTES: &[&str] = &[
    "/v1/info",
    "/v1/auth/prelogin",
    "/v1/auth/enroll",
    "/v1/auth/login",
    "/v1/auth/recover",
    "/v1/keys",
    "/v1/devices",
    "/v1/devices/{device_id}",
    "/v1/spaces",
    "/v1/spaces/{space_id}/changes",
    "/v1/spaces/{space_id}/events",
    "/v1/spaces/{space_id}/blobs",
    "/v1/spaces/{space_id}/blobs/{blob_id}",
    "/v1/spaces/{space_id}/blobs/{blob_id}/parts/{n}",
    "/v1/spaces/{space_id}/blobs/{blob_id}/complete",
    "/v1/spaces/{space_id}/commit",
    "/v1/spaces/{space_id}/items/{item_id}/versions",
];

/// The JSON error answer of П4.
pub fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    let body = json!({ "error": { "code": code, "message": message } });
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// The stub of every handler.
async fn not_implemented() -> Response {
    error_response(
        StatusCode::NOT_IMPLEMENTED,
        amby_sync_proto::error_code::NOT_IMPLEMENTED,
        "this handler is not written yet",
    )
}

/// Builds the application: all routes of appendix Б. Every handler is a stub for now.
pub fn build_app(state: AppState) -> Router {
    let mut router = Router::new();
    for route in ROUTES {
        router = router.route(route, any(not_implemented));
    }
    router.fallback(not_implemented).with_state(state)
}
