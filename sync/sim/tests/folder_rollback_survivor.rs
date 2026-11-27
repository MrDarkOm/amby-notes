//! Д57: a contradictory same-version folder deletion is a rollback even without a body.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::header::seal_header;
use amby_sync_core::crypto::random::OsRandom;

#[test]
fn a_same_version_folder_with_changed_deleted_flag_stops_before_writes() {
    let w = two(Engine::boxed);
    w.dev(0).fs.user_mkdir("Empty");
    w.save(0, "Bad.md", "blocked");
    w.pass(0);
    let (folder, version) = w.item_at("Empty");
    w.dev(1).fs.set_access_denied("Bad.md", true);
    let first = w.pass(1);
    assert_eq!(first.errors.len(), 1);
    let state = w.dev(1).state.snapshot();
    assert!(state.items.contains_key(folder.as_bytes()));
    assert!(state.cursor < w.server_head());

    let mut header = w.versions_at("Empty")[0].header.clone();
    header.deleted = true;
    let forged = seal_header(&w.vk, &w.space_id, &folder, &header, &mut OsRandom).unwrap();
    w.dev(1).fs.set_access_denied("Bad.md", false);
    w.dev(1).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        for change in &mut page.changes {
            if change.item_id == folder {
                assert_eq!(change.version, version);
                change.header = forged.clone();
                change.deleted = true;
            }
        }
        page
    }));
    let report = w.dev(1).sync().unwrap();
    assert!(
        matches!(report.outcome, CycleOutcome::Stopped(StopReason::Rollback { item_id, .. }) if item_id == folder)
    );
    assert!(w.dev(1).fs.exists("Empty"));
    assert!(!w.dev(1).fs.exists("Bad.md"));
}
