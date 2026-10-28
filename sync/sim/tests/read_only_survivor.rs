//! Directed report-deduplication check for remembered newer-format records.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::ItemId;
use std::collections::BTreeSet;

fn future_format_entry(w: &World, item: &ItemId, version: u64, path: &str) -> serde_json::Value {
    let future_version = version + 1;
    let envelope = forge_envelope(
        w,
        item,
        future_version,
        &format!(
            r#"{{"body_id":null,"content_hash":null,"deleted":false,"format":2,"kind":"file","mtime_ms":0,"path":"{path}","size":0,"version":{future_version}}}"#
        ),
    );
    commit_entry(item, version, &envelope, None, false)
}

#[test]
fn later_pass_reports_every_remembered_newer_format_item_once() {
    let w = pair_with_a(Engine::boxed);
    let (notes, notes_version) = w.item_at("Notes/a.md");
    let (keep, keep_version) = w.item_at("Keep/k.md");
    w.inject_raw(vec![
        future_format_entry(&w, &notes, notes_version, "Notes/a.md"),
        future_format_entry(&w, &keep, keep_version, "Keep/k.md"),
    ]);

    let first = w.pass(1);
    assert!(first.needs_update);
    assert_eq!(first.read_only.len(), 2);

    // The feed is now empty; these entries come from the durable newer_format flags.
    let later = w.pass(1);
    assert!(later.needs_update);
    assert_eq!(later.read_only.len(), 2);
    let ids: BTreeSet<[u8; 16]> = later
        .read_only
        .iter()
        .map(|record| *record.item_id.as_bytes())
        .collect();
    assert_eq!(ids, BTreeSet::from([*notes.as_bytes(), *keep.as_bytes()]));
    assert!(later
        .read_only
        .iter()
        .any(|record| { record.item_id == notes && record.path.as_deref() == Some("Notes/a.md") }));
    assert!(later
        .read_only
        .iter()
        .any(|record| { record.item_id == keep && record.path.as_deref() == Some("Keep/k.md") }));
}
