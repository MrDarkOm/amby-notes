//! Д24, Г24: an unchanged conflict-set file deleted locally must not be silently recreated.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::conflict_set::{encode_meta, set_id, set_paths, SetMeta};
use amby_sync_core::engine::ConflictKind;

#[test]
fn an_existing_server_copy_does_not_undo_its_local_deletion_during_a_conflict() {
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    let base_hash = blake3_hash(b"base");
    let other_hash = blake3_hash(b"local");
    let id = set_id(&item, &other_hash, version + 1, Some(&base_hash), 0);
    let paths = set_paths(&id, "Notes/a.md");

    // Users own these ordinary synced files. A restored set can already exist before another
    // edit recreates its deterministic identifier; no internal sync state is fabricated.
    w.dev(0).fs.user_write(&paths.other, b"local");
    w.dev(0).fs.user_write(&paths.base, b"base");
    w.dev(0).fs.user_write(
        &paths.meta,
        &encode_meta(&SetMeta {
            id,
            kind: ConflictKind::BothEdited,
            item_id: item,
            path: "Notes/a.md".into(),
            other: "other.md".into(),
            other_hash,
            other_size: 5,
            base: Some("base.md".into()),
            base_hash: Some(base_hash),
        }),
    );
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(0, &paths.other).as_deref(), Some("local"));

    w.dev(0).fs.user_delete(&paths.other);
    w.save(0, "Notes/a.md", "local");
    w.save(1, "Notes/a.md", "remote");
    w.pass(1);
    let report = w.pass(0);

    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(w.read(0, "Notes/a.md").as_deref(), Some("remote"));
    assert!(!w.dev(0).fs.exists(&paths.other));
    assert!(!w.server_files().contains_key(&paths.other));
    let versions = w.versions_at(&paths.other);
    assert!(versions[0].header.deleted);
    assert!(versions
        .iter()
        .any(|version| version.content.as_deref() == Some(b"local")));
}
