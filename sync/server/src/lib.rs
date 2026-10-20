//! Amby sync server (docs/sync-plan.md, Р11; protocol: appendix Б).
//!
//! A blind store: it keeps encrypted records and numbers, never keys or plain text (Р1, О1).
//! Stage Э2, step 1: the interface only. Every handler answers `501 not_implemented`, the
//! administrator commands and the maintenance run are stubs, the stores are stubs. The tests of
//! `sync/conformance` are written against this interface and must fail on it for that reason.

pub mod admin;
pub mod app;
pub mod clock;
pub mod config;
pub mod maintenance;
pub mod state;
pub mod store;

pub use app::build_app;
pub use clock::{Clock, ManualClock, SystemClock};
pub use config::{Config, ConfigError};
pub use state::AppState;
