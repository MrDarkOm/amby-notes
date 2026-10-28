//! Amby sync server (docs/sync-plan.md, Р11; protocol: appendix Б).
//!
//! A blind store: it keeps encrypted records and numbers, never keys or plain text (Р1, О1).
//! The requests are answered by [`build_app`]; the administrator commands are in [`admin`] and
//! the cleanup of old data in [`maintenance`].

pub mod admin;
pub mod app;
pub mod clock;
pub mod config;
mod db;
mod http;
pub mod maintenance;
pub mod plans;
mod quota;
pub mod state;
pub mod store;

pub use app::build_app;
pub use clock::{Clock, ManualClock, SystemClock};
pub use config::{Config, ConfigError};
pub use db::{DbError, DB_FILE};
pub use state::AppState;

/// The version of this crate, shown by `GET /v1/info` as `server_version` (П62).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
