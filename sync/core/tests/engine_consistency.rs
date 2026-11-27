//! Meaning of the header fields (Э3, Ф14, Д65): the crypto core of stage Э1 checks only the shape
//! of the fields; whether they contradict each other is the engine's business. Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;

use amby_sync_core::crypto::header::{Header, ItemKind};
use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::engine::consistency::{
    check_entry, check_header, check_kind_unchanged, HeaderProblem,
};
use amby_sync_core::engine::ChangeEntry;

fn header(kind: ItemKind, deleted: bool, body: bool, hash: bool, size: u64) -> Header {
    Header {
        format: 1,
        version: 3,
        kind,
        path: "Notes/a.md".into(),
        size,
        mtime_ms: 0,
        content_hash: hash.then_some([9; 32]),
        body_id: body.then(|| BodyId::from_bytes([5; 16])),
        deleted,
        extra: BTreeMap::new(),
    }
}

#[test]
fn the_four_valid_combinations_pass() {
    // Д65, Р2: live file with body and hash; deleted file, folder, deleted folder with neither
    // and size 0.
    assert_eq!(
        check_header(&header(ItemKind::File, false, true, true, 10)),
        Ok(())
    );
    assert_eq!(
        check_header(&header(ItemKind::File, false, true, true, 0)),
        Ok(()),
        "an empty file still has a body"
    );
    assert_eq!(
        check_header(&header(ItemKind::File, true, false, false, 0)),
        Ok(())
    );
    assert_eq!(
        check_header(&header(ItemKind::Folder, false, false, false, 0)),
        Ok(())
    );
    assert_eq!(
        check_header(&header(ItemKind::Folder, true, false, false, 0)),
        Ok(())
    );
}

#[test]
fn a_live_file_needs_a_body_and_a_hash() {
    // Д65.
    assert_eq!(
        check_header(&header(ItemKind::File, false, false, true, 10)),
        Err(HeaderProblem::Body)
    );
    assert_eq!(
        check_header(&header(ItemKind::File, false, true, false, 10)),
        Err(HeaderProblem::Hash)
    );
}

#[test]
fn a_folder_has_no_body_no_hash_and_no_size() {
    // Р2, Д65.
    assert_eq!(
        check_header(&header(ItemKind::Folder, false, true, false, 0)),
        Err(HeaderProblem::Body)
    );
    assert_eq!(
        check_header(&header(ItemKind::Folder, false, false, true, 0)),
        Err(HeaderProblem::Hash)
    );
    assert_eq!(
        check_header(&header(ItemKind::Folder, false, false, false, 5)),
        Err(HeaderProblem::Size)
    );
    assert_eq!(
        check_header(&header(ItemKind::Folder, true, true, false, 0)),
        Err(HeaderProblem::Body)
    );
}

#[test]
fn a_deleted_file_has_no_body_no_hash_and_no_size() {
    // Д65.
    assert_eq!(
        check_header(&header(ItemKind::File, true, true, false, 0)),
        Err(HeaderProblem::Body)
    );
    assert_eq!(
        check_header(&header(ItemKind::File, true, false, true, 0)),
        Err(HeaderProblem::Hash)
    );
    assert_eq!(
        check_header(&header(ItemKind::File, true, false, false, 7)),
        Err(HeaderProblem::Size)
    );
}

#[test]
fn format_and_version_are_checked() {
    // Д65, Ф14: only format 1; versions start at 1.
    let mut h = header(ItemKind::File, false, true, true, 1);
    h.format = 2;
    assert_eq!(check_header(&h), Err(HeaderProblem::Format));
    h.format = 0;
    assert_eq!(check_header(&h), Err(HeaderProblem::Format));
    h.format = 1;
    h.version = 0;
    assert_eq!(check_header(&h), Err(HeaderProblem::Version));
}

#[test]
fn the_kind_of_an_item_never_changes() {
    // Д65.
    let file = header(ItemKind::File, false, true, true, 1);
    let folder = header(ItemKind::Folder, false, false, false, 0);
    assert_eq!(check_kind_unchanged(ItemKind::File, &file), Ok(()));
    assert_eq!(check_kind_unchanged(ItemKind::Folder, &folder), Ok(()));
    assert_eq!(
        check_kind_unchanged(ItemKind::File, &folder),
        Err(HeaderProblem::KindChanged)
    );
    assert_eq!(
        check_kind_unchanged(ItemKind::Folder, &file),
        Err(HeaderProblem::KindChanged)
    );
}

fn entry(blob: Option<[u8; 16]>, blob_size: Option<u64>, deleted: bool) -> ChangeEntry {
    ChangeEntry {
        seq: 4,
        item_id: ItemId::from_bytes([1; 16]),
        version: 3,
        header: vec![],
        blob_id: blob.map(BodyId::from_bytes),
        blob_size,
        deleted,
        device_id: [2; 16],
        committed_ms: 0,
    }
}

#[test]
fn a_feed_entry_must_match_its_header() {
    // Д65, Р6: the body the server names is the body the header names, with the size Padmé gives.
    let h = header(ItemKind::File, false, true, true, 1000);
    let sealed = sealed_body_len(1000).unwrap();
    assert_eq!(
        check_entry(&entry(Some([5; 16]), Some(sealed), false), &h),
        Ok(())
    );
    assert_eq!(
        check_entry(&entry(Some([6; 16]), Some(sealed), false), &h),
        Err(HeaderProblem::EntryBlob)
    );
    assert_eq!(
        check_entry(&entry(None, None, false), &h),
        Err(HeaderProblem::EntryBlob)
    );
    assert_eq!(
        check_entry(&entry(Some([5; 16]), Some(sealed + 1), false), &h),
        Err(HeaderProblem::EntryBlobSize)
    );
    assert_eq!(
        check_entry(&entry(Some([5; 16]), None, false), &h),
        Err(HeaderProblem::EntryBlobSize)
    );
    let folder = header(ItemKind::Folder, false, false, false, 0);
    assert_eq!(check_entry(&entry(None, None, false), &folder), Ok(()));
    assert_eq!(
        check_entry(&entry(Some([5; 16]), Some(48), false), &folder),
        Err(HeaderProblem::EntryBlob)
    );
}

#[test]
fn the_open_deletion_mark_is_not_believed_or_compared() {
    // Р6, Д65: only the header says whether an item is deleted.
    let live = header(ItemKind::File, false, true, true, 1000);
    let sealed = sealed_body_len(1000).unwrap();
    assert_eq!(
        check_entry(&entry(Some([5; 16]), Some(sealed), true), &live),
        Ok(())
    );
    let dead = header(ItemKind::File, true, false, false, 0);
    assert_eq!(check_entry(&entry(None, None, false), &dead), Ok(()));
}
