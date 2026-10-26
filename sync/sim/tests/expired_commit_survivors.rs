//! Cleanup can purge a deletion after the client reads it but before its undelete commits.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::engine::Engine;
use amby_sync_sim::fault::RemoteKind;
use std::time::Duration;

#[test]
fn an_undelete_survives_cleanup_between_feed_and_commit() {
    let new_body = "new body that must be committed after the tombstone expires".repeat(512);
    let quota = sealed_body_len(new_body.len() as u64).expect("body size can be sealed")
        + sealed_body_len(4).expect("the keep file fits");
    let w = World::new(Engine::boxed, WorldOptions::new(2).quota(quota));
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "A/a.md", "old body");
    w.pass(0);
    w.pass(1);

    w.dev(1).fs.user_delete("A/a.md");
    w.pass(1);
    assert!(!w.server_files().contains_key("A/a.md"));

    // Keep the tombstone just short of retention while the stale device reads it.
    w.control()
        .advance(Duration::from_secs(30 * 24 * 60 * 60 - 1));
    w.control().run_maintenance();
    w.dev(0).fs.user_write("A/a.md", new_body.as_bytes());

    // This runs after the feed and local plan have adopted the tombstone, but immediately before
    // the current commit request. Purging here gives the commit current_version=0 while the local
    // cursor already includes the tombstone sequence, so the retry must use the stale-base arm.
    let clock = w.control().clock.clone();
    let server_state = w.control().state.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        clock.advance(Duration::from_secs(2));
        let state = server_state.read().unwrap().clone();
        let cleanup =
            amby_sync_server::maintenance::run(&state).expect("retention cleanup succeeds");
        assert_eq!(
            cleanup.items, 1,
            "the tombstone was purged in the race window"
        );
    });

    let report = w
        .dev(0)
        .sync()
        .expect("the stale base is rebuilt after cleanup");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(
        report.errors.is_empty(),
        "unexpected sync errors: {report:?}"
    );
    assert_eq!(w.server_files()["A/a.md"], new_body.as_bytes());
    assert_eq!(w.server_files()["Keep/k.md"], b"keep");
}
