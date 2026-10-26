//! Focused public-engine regressions for scan and conflict-name survivor mutants.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::conflict_set::{set_id, set_paths};
use amby_sync_core::engine::{FsError, ItemErrorKind, LimitSource, UnsyncedReason};
use serde_json::json;

fn plans() -> String {
    json!({
        "default_plan": "tight",
        "plans": {
            "tight": { "max_file_bytes": sealed_body_len(10_000).unwrap() },
            "roomy": { "max_file_bytes": sealed_body_len(100_000).unwrap() }
        }
    })
    .to_string()
}

fn limited_world(devices: usize) -> World {
    World::new(Engine::boxed, WorldOptions::new(devices).plans(&plans()))
}

fn listed(w: &World, d: usize) -> Vec<(String, UnsyncedReason)> {
    let mut entries: Vec<_> = w
        .dev(d)
        .state
        .snapshot()
        .unsynced
        .into_iter()
        .map(|entry| (entry.path, entry.reason))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

fn bytes(size: usize, value: u8) -> Vec<u8> {
    vec![value; size]
}

fn scan_does_not_read_a_new_oversized_file_just_because_a_listed_file_has_its_size(
    _b: EngineBuilder,
) {
    let w = limited_world(1);
    w.set_plan("roomy");
    let content = bytes(50_000, b'k');
    w.dev(0).fs.user_write("Base/known.bin", &content);
    w.pass(0);

    w.set_plan("tight");
    w.dev(0).fs.user_write("New/denied.bin", &content);
    w.dev(0).fs.set_access_denied("New/denied.bin", true);
    w.pass(0);

    assert!(matches!(
        listed(&w, 0).as_slice(),
        [(path, UnsyncedReason::TooLarge { max_bytes, source: LimitSource::Plan })]
            if path == "New/denied.bin" && *max_bytes == sealed_body_len(10_000).unwrap()
    ));
}

fn scan_reads_an_oversized_file_when_its_missing_base_may_be_a_rename(_b: EngineBuilder) {
    let w = limited_world(2);
    w.set_plan("roomy");
    let content = bytes(50_000, b'r');
    w.dev(0).fs.user_write("Old/large.bin", &content);
    w.pass(0);
    w.pass(1);
    let (item_before_rename, _) = w.item_at("Old/large.bin");

    w.set_plan("tight");
    w.dev(0).fs.user_rename("Old/large.bin", "New/large.bin");
    let report = w.pass(0);

    // The user rename was already on disk before this pass. `renamed` counts files renamed by
    // this device while applying incoming server changes, so this outgoing rename counts as zero.
    assert_eq!(report.renamed, 0);
    assert!(matches!(
        listed(&w, 0).as_slice(),
        [(path, UnsyncedReason::TooLarge { .. })] if path == "New/large.bin"
    ));
    let server = w.server_files();
    assert_eq!(server.get("Old/large.bin"), Some(&content));
    assert!(!server.contains_key("New/large.bin"));
    assert_eq!(w.item_at("Old/large.bin").0, item_before_rename);
    assert_eq!(w.dev(0).fs.content("New/large.bin"), Some(content.clone()));
    w.pass(1);
    assert_eq!(w.dev(1).fs.content("Old/large.bin"), Some(content.clone()));

    // Once the limit rises, the same item can move without uploading another body.
    w.set_plan("roomy");
    w.pass(0);
    let server = w.server_files();
    assert!(!server.contains_key("Old/large.bin"));
    assert_eq!(server.get("New/large.bin"), Some(&content));
    assert_eq!(w.item_at("New/large.bin").0, item_before_rename);
    w.pass(1);
    assert_eq!(w.dev(1).fs.content("New/large.bin"), Some(content));
    assert!(!w.dev(1).fs.exists("Old/large.bin"));
}

fn decide_reports_when_every_conflict_copy_name_is_unavailable(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    let (local_item, local_version) = w.item_at("Notes/a.md");
    let local_bytes = b"base";
    let local_hash = blake3_hash(local_bytes);

    for attempt in 0..64 {
        let id = set_id(&local_item, &local_hash, local_version, None, attempt);
        let path = set_paths(&id, "Notes/a.md").other;
        w.dev(1)
            .fs
            .user_write(&path, b"occupies the candidate name");
        w.dev(1).fs.set_access_denied(&path, true);
    }

    w.inject_file(
        &ItemId::from_bytes([0; 16]),
        0,
        "Notes/a.md",
        b"incoming smaller item",
    );
    let report = w.pass(1);

    assert!(
        report.errors.iter().any(|error| {
            error.kind
                == ItemErrorKind::Disk(FsError::Io(
                    "no allowed name for the conflict copy".to_string(),
                ))
        }),
        "{:?}",
        report.errors
    );
    assert_eq!(
        w.dev(1).fs.content("Notes/a.md"),
        Some(local_bytes.to_vec())
    );
}

real_only!(
    scan_does_not_read_a_new_oversized_file_just_because_a_listed_file_has_its_size,
    scan_reads_an_oversized_file_when_its_missing_base_may_be_a_rename,
    decide_reports_when_every_conflict_copy_name_is_unavailable,
);
