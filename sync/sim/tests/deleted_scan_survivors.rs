//! Д74: deleted bases must not turn an unread oversized file into an access error.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::engine::{LimitSource, UnsyncedReason};
use serde_json::json;

#[test]
fn a_deleted_zero_size_base_does_not_make_a_new_oversized_file_readable() {
    let plans = json!({
        "default_plan": "wide",
        "plans": { "wide": {}, "narrow": {"max_file_bytes": 1} }
    });
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1).plans(&plans.to_string()),
    );
    w.save(0, "Keep.md", "keep");
    w.save(0, "Old.md", "old");
    w.pass(0);
    w.dev(0).fs.user_delete("Old.md");
    w.pass(0);
    w.set_plan("narrow");
    w.dev(0).fs.user_write("New/empty.bin", b"");
    w.dev(0).fs.set_access_denied("New/empty.bin", true);
    let report = w.pass(0);
    assert!(report.errors.is_empty());
    assert_eq!(report.unsynced.len(), 1);
    assert_eq!(report.unsynced[0].path, "New/empty.bin");
    assert_eq!(
        report.unsynced[0].reason,
        UnsyncedReason::TooLarge {
            max_bytes: 1,
            source: LimitSource::Plan,
        }
    );
    assert!(!w.server_files().contains_key("New/empty.bin"));
}
