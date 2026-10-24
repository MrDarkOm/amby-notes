//! Conformance suite of the sync server (docs/sync-plan.md, Э2; protocol: appendix Б).
//!
//! This crate is a library plus test runs (`tests/`) that work against **any** server address:
//! the server of this repository started in the test process, a container, or one day a paid
//! service. The tests speak HTTP only. The environment decides where they go:
//!
//! | Variable               | Meaning                                                               |
//! | ---------------------- | --------------------------------------------------------------------- |
//! | `AMBY_SYNC_URL`        | base address of a running server; without it a server is started here |
//! | `AMBY_SYNC_ADMIN_CMD`  | command that runs the administrator tool, e.g. `docker exec c amby-sync-server` |
//!
//! A user is created through the small trait [`admin::UserAdmin`]: in the process (a direct call)
//! or by command (`docker exec … amby-sync-server user add`). The client side of the suite uses
//! the real cryptography of `sync/core`, so the server receives real encrypted data.
//!
//! Tests that need to move the clock, run the cleanup, restart the server or read its data
//! directory (П37, "the server is blind") start their own server in the process, whatever the
//! environment says: a foreign clock cannot be moved. They run in both modes and cover only the
//! server of this repository.
//!
//! This is test-support code: the names are the documentation, the behaviour is appendix Б.
#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used)]

pub mod admin;
pub mod client;
pub mod http;
pub mod inprocess;
pub mod target;

pub use admin::{AdminFailure, AdminOutput, EnrollTicket, UserAdmin};
pub use http::{Api, Resp, Sse, SseEvent};
pub use target::Target;

/// Unwraps the control of a server in this process (clock, cleanup, restart, the data directory).
/// For a target without one (a foreign address) it prints `SKIP` and returns from the test.
#[macro_export]
macro_rules! in_process_or_skip {
    ($target:expr) => {
        match $target.control() {
            Some(control) => control,
            None => {
                eprintln!("SKIP: needs a server in this process (clock, cleanup or data dir)");
                return;
            }
        }
    };
}
