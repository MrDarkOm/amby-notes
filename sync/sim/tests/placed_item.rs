//! Д71, the other direction (found while fixing seed 1207): an item of the larger id arrives by a
//! rename onto a path that the file of a smaller item holds on this device. The device puts the
//! larger item's file at a conflict copy name. The server must then end up with one live item per
//! path, and each item must keep its own content: before the fix the moved file looked like an
//! edit of its item (the winner's file stood at the path) and the server got the winner's text
//! as a new version of the loser. Real engine only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::ItemId;

fn a_larger_item_renamed_onto_a_held_path_keeps_its_own_content(_b: EngineBuilder) {
    let w = two(Engine::boxed);
    let low = ItemId::from_bytes([1; 16]);
    let high = ItemId::from_bytes([2; 16]);
    w.inject_file(&low, 0, "x.md", b"low");
    w.inject_file(&high, 0, "y.md", b"high");
    w.pass(1);
    let body = w.versions_at("y.md")[0].header.body_id.unwrap();
    w.inject_rename(&high, 1, "x.md", b"high", &body);
    for _ in 0..4 {
        w.pass(1);
        w.pass(0);
    }
    let mut live_paths = Vec::new();
    for item in w.server_items(true) {
        let latest = &item.versions[0];
        if latest.header.deleted {
            continue;
        }
        live_paths.push(latest.header.path.clone());
        if item.item_id == high {
            assert_eq!(
                latest.content.as_deref(),
                Some(&b"high"[..]),
                "the server holds another text as the latest version of the larger item"
            );
        }
        if item.item_id == low {
            assert_eq!(latest.content.as_deref(), Some(&b"low"[..]));
        }
    }
    let mut unique = live_paths.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        unique,
        {
            let mut all = live_paths.clone();
            all.sort();
            all
        },
        "two live items on one path on the server: {live_paths:?}"
    );
    w.finish(false);
}

real_only!(a_larger_item_renamed_onto_a_held_path_keeps_its_own_content);
