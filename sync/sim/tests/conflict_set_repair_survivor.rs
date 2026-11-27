//! Г21, Д4: retrying a partially published set repairs its base and final metadata.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::conflict_set::{encode_meta, set_id, set_paths, SetMeta};
use amby_sync_core::engine::ConflictKind;

#[test]
fn a_matching_other_file_does_not_hide_a_damaged_base_or_metadata() {
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    let base_hash = blake3_hash(b"base");
    let other_hash = blake3_hash(b"local");
    let id = set_id(&item, &other_hash, version + 1, Some(&base_hash), 0);
    let paths = set_paths(&id, "Notes/a.md");
    let expected_meta = encode_meta(&SetMeta {
        id,
        kind: ConflictKind::BothEdited,
        item_id: item,
        path: "Notes/a.md".into(),
        other: "other.md".into(),
        other_hash,
        other_size: 5,
        base: Some("base.md".into()),
        base_hash: Some(base_hash),
    });
    // A partially restored/published set can have its correct other file and damaged sidecars.
    w.dev(0).fs.user_write(&paths.other, b"local");
    w.dev(0).fs.user_write(&paths.base, b"damaged base");
    w.dev(0).fs.user_write(&paths.meta, b"{cut off");
    w.save(0, "Notes/a.md", "local");
    w.save(1, "Notes/a.md", "remote");
    w.pass(1);
    let report = w.pass(0);
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(
        w.dev(0).fs.content(&paths.other).as_deref(),
        Some(b"local".as_slice())
    );
    assert_eq!(
        w.dev(0).fs.content(&paths.base).as_deref(),
        Some(b"base".as_slice())
    );
    assert_eq!(w.dev(0).fs.content(&paths.meta), Some(expected_meta));
}
