//! The current commit_chunk UNKNOWN_BLOB path must retain uploads outside its chunk.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::BodyId;
use amby_sync_core::engine::Engine;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

#[test]
fn current_commit_unknown_blob_keeps_other_chunk_upload_during_retry() {
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1).isolated().max_commit_items(1),
    );
    w.save(0, "A/a.md", "base a");
    w.save(0, "B/b.md", "base b");
    w.pass(0);
    let (item_b, _) = w.item_at("B/b.md");
    w.save(0, "A/a.md", "updated a with a different body");
    w.save(0, "B/b.md", "updated b with a different body");

    let state = w.dev(0).state.clone();
    let space = w.space(0);
    let unrelated_blob = Rc::new(RefCell::new(None::<BodyId>));
    let expected_blob = unrelated_blob.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        let snapshot = state.snapshot();
        let pending = snapshot
            .commit
            .expect("a current commit chunk is persisted before send");
        assert_eq!(
            pending.items.len(),
            1,
            "the server item limit splits chunks"
        );
        let missing = pending.items[0]
            .blob_id
            .expect("the first commit item has an upload");
        let other = snapshot
            .uploads
            .values()
            .find(|upload| upload.item_id == item_b)
            .expect("the later chunk was uploaded before this commit");
        *expected_blob.borrow_mut() = Some(other.blob_id);
        assert_eq!(space.delete_blob(&missing).status, 204);
    });

    // Both replacement bodies are uploaded before the first one-item commit. On the third
    // BlobStart, UNKNOWN_BLOB cleanup has run and the first item's replacement is retried.
    let state_during_retry = w.dev(0).state.clone();
    let expected_during_retry = unrelated_blob.clone();
    let saw_retry = Rc::new(Cell::new(false));
    let saw_retry_at_remote = saw_retry.clone();
    let mut blob_starts = 0;
    w.dev(0).faults.net_rule(move |call| {
        if call.kind == RemoteKind::BlobStart {
            blob_starts += 1;
            if blob_starts == 3 {
                let expected = expected_during_retry
                    .borrow()
                    .expect("first commit saved the unrelated blob id");
                assert!(
                    state_during_retry
                        .snapshot()
                        .uploads
                        .contains_key(expected.as_bytes()),
                    "cleanup for the first chunk removed the other chunk's upload"
                );
                saw_retry_at_remote.set(true);
            }
        }
        NetFault::None
    });

    let report = w.dev(0).sync().expect("the missing body is rebuilt");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(saw_retry.get(), "the retry upload start was observed");
    assert_eq!(
        w.server_files()["A/a.md"],
        b"updated a with a different body"
    );
    assert_eq!(
        w.server_files()["B/b.md"],
        b"updated b with a different body"
    );
}
