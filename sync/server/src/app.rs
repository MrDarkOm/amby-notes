//! The router (table Р11, appendix Б): every route, with JSON answers for unknown paths and
//! wrong methods (П4).

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::Router;
use serde_json::json;

use crate::http::{self, account, blobs, commit, events, feed, spaces};
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

/// Builds the application: all routes of appendix Б.
///
/// For the address of the client (П16) serve it with
/// `into_make_service_with_connect_info::<SocketAddr>()`; without that every client has one
/// address and the strict counter of failed sign-ins becomes the counter per name.
pub fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/v1/info", get(http::info))
        .route("/v1/auth/prelogin", post(account::prelogin))
        .route("/v1/auth/enroll", post(account::enroll))
        .route("/v1/auth/login", post(account::login))
        .route("/v1/auth/recover", post(account::recover))
        .route("/v1/keys", get(account::keys_get).put(account::keys_put))
        .route("/v1/devices", get(account::devices_list))
        .route("/v1/devices/{device_id}", delete(account::device_delete))
        .route("/v1/spaces", get(spaces::list).post(spaces::create))
        .route("/v1/spaces/{space_id}/changes", get(feed::changes))
        .route("/v1/spaces/{space_id}/events", get(events::events))
        .route("/v1/spaces/{space_id}/blobs", post(blobs::start))
        .route(
            "/v1/spaces/{space_id}/blobs/{blob_id}",
            get(blobs::download),
        )
        .route(
            "/v1/spaces/{space_id}/blobs/{blob_id}/parts/{n}",
            put(blobs::put_part),
        )
        .route(
            "/v1/spaces/{space_id}/blobs/{blob_id}/complete",
            post(blobs::complete),
        )
        .route("/v1/spaces/{space_id}/commit", post(commit::commit))
        .route(
            "/v1/spaces/{space_id}/items/{item_id}/versions",
            get(feed::versions),
        )
        .fallback(http::not_found)
        .method_not_allowed_fallback(http::method_not_allowed)
        .with_state(state)
}
