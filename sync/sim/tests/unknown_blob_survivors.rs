//! Directed checks that UNKNOWN_BLOB cleanup only drops uploads for the rejected commit.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::engine::Engine;

fn two_changed_items(max_commit_items: usize) -> World {
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1)
            .isolated()
            .max_commit_items(max_commit_items),
    );
    w.save(0, "A/a.md", "base a");
    w.save(0, "B/b.md", "base b");
    w.pass(0);
    w.save(0, "A/a.md", "updated a with a different body");
    w.save(0, "B/b.md", "updated b with a different body");
    w
}

#[test]
fn pending_unknown_blob_preserves_an_unrelated_completed_upload() {
    let w = two_changed_items(1);
    w.dev(0).faults.drop_request_of(RemoteKind::Commit);
    assert!(w.dev(0).sync().is_err(), "the first commit is interrupted");

    let before = w.dev(0).state.snapshot();
    let pending = before.commit.expect("interrupted commit remains pending");
    assert_eq!(before.uploads.len(), 2, "both changed bodies were uploaded");
    let pending_item = pending.items[0].item_id;
    let pending_blob = pending.items[0]
        .blob_id
        .expect("the pending item has a body");
    let unrelated = before
        .uploads
        .values()
        .find(|upload| upload.item_id != pending_item)
        .expect("the second item's upload is unrelated to the pending commit")
        .blob_id;

    assert_eq!(w.space(0).delete_blob(&pending_blob).status, 204);
    w.dev(0).faults.drop_request_of(RemoteKind::BlobStart);
    assert!(
        w.dev(0).sync().is_err(),
        "the missing pending body is noticed, then its replacement start is interrupted"
    );

    let after = w.dev(0).state.snapshot();
    assert!(
        after.uploads.contains_key(unrelated.as_bytes()),
        "UNKNOWN_BLOB cleanup must retain the completed upload for the other item"
    );
    assert_eq!(w.server_files().get("A/a.md"), Some(&b"base a".to_vec()));
    assert_eq!(w.server_files().get("B/b.md"), Some(&b"base b".to_vec()));
}

#[test]
fn commit_unknown_blob_preserves_an_unrelated_completed_upload() {
    let w = two_changed_items(1);
    let state = w.dev(0).state.clone();
    let space = w.space(0);
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        let pending = state
            .snapshot()
            .commit
            .expect("commit is persisted before its request");
        let body = pending.items[0]
            .blob_id
            .expect("the first commit has a body");
        assert_eq!(space.delete_blob(&body).status, 204);
    });

    // Two changed bodies start before the first chunk is committed. The third start is the
    // retry after the first commit discovers its deleted body; interrupt there to inspect state.
    let mut blob_starts = 0;
    w.dev(0).faults.net_rule(move |call| {
        if call.kind == RemoteKind::BlobStart {
            blob_starts += 1;
            if blob_starts == 3 {
                return NetFault::DropRequest;
            }
        }
        NetFault::None
    });
    assert!(
        w.dev(0).sync().is_err(),
        "the retry's replacement upload start is interrupted"
    );

    let state = w.dev(0).state.snapshot();
    let unrelated = state
        .uploads
        .values()
        .find(|upload| upload.item_id != w.item_at("A/a.md").0)
        .expect("the other item's completed upload remains in durable state");
    assert_eq!(unrelated.item_id, w.item_at("B/b.md").0);
    assert_eq!(w.server_files().get("A/a.md"), Some(&b"base a".to_vec()));
    assert_eq!(w.server_files().get("B/b.md"), Some(&b"base b".to_vec()));
}
