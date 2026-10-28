//! Header fields that contradict each other, unknown fields of newer versions, and the fast
//! check of unchanged files (Р2, Р10, Р13; appendix В, Д12, Д65–Д67).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use std::collections::BTreeMap;

use amby_sync_core::crypto::body::seal_body;
use amby_sync_core::crypto::header::{seal_header, ItemKind};
use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::ItemErrorKind;
use serde_json::json;

/// Uploads a body of `content` and returns its id.
fn upload(w: &World, content: &[u8]) -> BodyId {
    let body = BodyId::random(&mut OsRandom);
    let sealed = seal_body(&w.vk, &body, content, &mut OsRandom).unwrap();
    w.space(0).upload_sealed(&body, &sealed);
    body
}

/// Commits one entry whose header says whatever `header` says, with the given body reference.
fn commit_header(
    w: &World,
    item: &ItemId,
    base: u64,
    header: &amby_sync_core::crypto::header::Header,
    blob: Option<&BodyId>,
) {
    let envelope = seal_header(&w.vk, &w.space_id, item, header, &mut OsRandom).unwrap();
    w.inject_raw(vec![commit_entry(
        item,
        base,
        &envelope,
        blob,
        header.deleted,
    )]);
}

/// Dev 1 must skip the broken record, report it, hold the cursor and still apply the honest one.
fn assert_skipped(w: &World, path_must_be_absent: &str) {
    w.save(0, "Notes/honest.md", "honest");
    w.pass(0);
    let report = w.dev(1).sync().unwrap();
    assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
    assert_eq!(report.errors[0].kind, ItemErrorKind::Inconsistent);
    assert!(!w.dev(1).fs.exists(path_must_be_absent));
    assert_eq!(w.read(1, "Notes/honest.md").as_deref(), Some("honest"));
    assert!(
        w.dev(1).state.snapshot().cursor < w.server_head(),
        "the cursor stays before the broken record"
    );
}

fn d65_a_folder_with_a_body_is_refused(_b: EngineBuilder) {
    // Р2, Ф14, Д65: a folder has no body.
    let w = pair_with_a(Engine::boxed);
    let body = upload(&w, b"x");
    let h = w.header(
        1,
        ItemKind::Folder,
        "Bad/folder",
        Some(body),
        None,
        0,
        false,
    );
    commit_header(&w, &ItemId::from_bytes([1; 16]), 0, &h, Some(&body));
    assert_skipped(&w, "Bad/folder");
}

fn d65_a_live_file_without_a_hash_is_refused(_b: EngineBuilder) {
    // Ф14, Д65.
    let w = pair_with_a(Engine::boxed);
    let body = upload(&w, b"x");
    let h = w.header(1, ItemKind::File, "Bad/file.md", Some(body), None, 1, false);
    commit_header(&w, &ItemId::from_bytes([2; 16]), 0, &h, Some(&body));
    assert_skipped(&w, "Bad/file.md");
}

fn d65_a_deleted_file_with_a_body_is_refused(_b: EngineBuilder) {
    // Ф14, Д65.
    let w = pair_with_a(Engine::boxed);
    let body = upload(&w, b"x");
    let h = w.header(
        1,
        ItemKind::File,
        "Bad/deleted.md",
        Some(body),
        None,
        0,
        true,
    );
    commit_header(&w, &ItemId::from_bytes([3; 16]), 0, &h, Some(&body));
    assert_skipped(&w, "Bad/deleted.md");
}

fn d65_a_changed_kind_is_refused(_b: EngineBuilder) {
    // Д65: an existing file item re-sent as a folder.
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    let h = w.header(
        version + 1,
        ItemKind::Folder,
        "Notes/a.md",
        None,
        None,
        0,
        false,
    );
    commit_header(&w, &item, version, &h, None);
    w.save(0, "Notes/honest.md", "honest");
    w.pass(0);
    let report = w.dev(1).sync().unwrap();
    assert_eq!(report.errors.len(), 1);
    assert_eq!(report.errors[0].kind, ItemErrorKind::Inconsistent);
    assert_eq!(
        w.read(1, "Notes/a.md").as_deref(),
        Some("base"),
        "the file stays a file"
    );
}

fn d65_a_feed_entry_that_names_another_body_is_refused(_b: EngineBuilder) {
    // Р6, Д65: the header says one body and the server hands out another.
    let w = pair_with_a(Engine::boxed);
    let right = upload(&w, b"the real content");
    let other = upload(&w, b"something else entirely");
    let h = w.header(
        1,
        ItemKind::File,
        "Bad/swapped.md",
        Some(right),
        Some(blake3_hash(b"the real content")),
        16,
        false,
    );
    commit_header(&w, &ItemId::from_bytes([4; 16]), 0, &h, Some(&other));
    assert_skipped(&w, "Bad/swapped.md");
}

fn d67_unknown_header_fields_survive_a_rename(_b: EngineBuilder) {
    // Р13, Д67: a field from a newer version is kept when this device rewrites the record.
    let w = pair_with_a(_b);
    let item = ItemId::from_bytes([5; 16]);
    let body = upload(&w, b"future file");
    let mut h = w.header(
        1,
        ItemKind::File,
        "Notes/future.md",
        Some(body),
        Some(blake3_hash(b"future file")),
        11,
        false,
    );
    let mut extra = BTreeMap::new();
    extra.insert("x_future".to_string(), json!(7));
    h.extra = extra;
    commit_header(&w, &item, 0, &h, Some(&body));
    w.pass(1);
    assert_eq!(w.read(1, "Notes/future.md").as_deref(), Some("future file"));
    w.dev(1)
        .fs
        .user_rename("Notes/future.md", "Notes/renamed.md");
    w.pass(1);
    let versions = w.versions_at("Notes/renamed.md");
    assert_eq!(versions.len(), 2);
    assert_eq!(
        versions[0].header.extra.get("x_future"),
        Some(&json!(7)),
        "the unknown field is kept"
    );
    w.finish(false);
}

fn d12_an_unchanged_file_is_not_read_again(_b: EngineBuilder) {
    // Р10, Д12: size and modification time equal to the base mean "unchanged" without reading.
    let w = pair_with_a(Engine::boxed);
    w.pass(0);
    let reads = w.dev(0).fs.reads();
    w.pass(0);
    assert_eq!(
        w.dev(0).fs.reads(),
        reads,
        "no file was read for a pass without changes"
    );
}

fn d12_a_touched_file_with_the_same_content_sends_nothing(_b: EngineBuilder) {
    // Р10, Д12: a new modification time makes the engine read the file; the hash decides.
    let w = pair_with_a(_b);
    w.dev(0).fs.touch("Notes/a.md");
    let head = w.server_head();
    w.pass(0);
    assert_eq!(w.server_head(), head);
    w.finish(false);
}

fn d12_a_change_of_one_byte_with_the_same_size_is_found(_b: EngineBuilder) {
    // Р10, Д12: the same size, a later modification time, other content.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", "bast");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("bast"));
    w.finish(false);
}

both!(
    d67_unknown_header_fields_survive_a_rename,
    d12_a_touched_file_with_the_same_content_sends_nothing,
    d12_a_change_of_one_byte_with_the_same_size_is_found,
);

real_only!(
    d65_a_folder_with_a_body_is_refused,
    d65_a_live_file_without_a_hash_is_refused,
    d65_a_deleted_file_with_a_body_is_refused,
    d65_a_changed_kind_is_refused,
    d65_a_feed_entry_that_names_another_body_is_refused,
    d12_an_unchanged_file_is_not_read_again,
);
