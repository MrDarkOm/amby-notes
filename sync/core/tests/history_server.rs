//! Earlier versions and deleted files from the server (docs/sync-plan.md, appendix И, Э5): the pure
//! functions of the core. Every test names the requirement it checks. Red until the functions of
//! `engine::history` are written (раздел 6).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;

use amby_sync_core::crypto::body::seal_body;
use amby_sync_core::crypto::header::{seal_header, Header, ItemKind};
use amby_sync_core::crypto::keys::{BodyId, ItemId, SpaceId, SpaceKey};
use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::history::{
    deleted_files, deleted_files_matched, is_service_path, locate_deleted_file, open_version_body,
    server_history, DeletedFile, HistoryVersion, ItemHistory, OpenedVersion, SkipCode,
    MAX_PREVIEW_BYTES,
};
use amby_sync_core::engine::{ItemRecord, VersionEntry};

fn space() -> SpaceId {
    SpaceId::from_bytes([0x51; 16])
}
fn item() -> ItemId {
    ItemId::from_bytes([0x61; 16])
}
fn vk() -> SpaceKey {
    SpaceKey::from_bytes([0x21; 32], 1)
}
fn other_vk() -> SpaceKey {
    SpaceKey::from_bytes([0x22; 32], 1)
}
fn body_for(version: u64) -> BodyId {
    BodyId::from_bytes([version as u8; 16])
}
fn content_of(version: u64) -> Vec<u8> {
    format!("text of version {version}").into_bytes()
}

/// A live-file header, consistent with `content_of(version)`.
fn live_header(version: u64, path: &str) -> Header {
    let content = content_of(version);
    Header {
        format: 1,
        version,
        kind: ItemKind::File,
        path: path.into(),
        size: content.len() as u64,
        mtime_ms: 0,
        content_hash: Some(blake3_hash(&content)),
        body_id: Some(body_for(version)),
        deleted: false,
        extra: BTreeMap::new(),
    }
}

fn deleted_header(version: u64, path: &str) -> Header {
    Header {
        format: 1,
        version,
        kind: ItemKind::File,
        path: path.into(),
        size: 0,
        mtime_ms: 0,
        content_hash: None,
        body_id: None,
        deleted: true,
        extra: BTreeMap::new(),
    }
}

fn entry_with(
    key: &SpaceKey,
    item: &ItemId,
    header: &Header,
    open_mark: bool,
    seq: u64,
) -> VersionEntry {
    let envelope = seal_header(key, &space(), item, header, &mut OsRandom).unwrap();
    VersionEntry {
        item_id: *item,
        version: header.version,
        seq,
        header: envelope,
        blob_id: header.body_id,
        blob_size: header
            .body_id
            .map(|_| sealed_body_len(header.size).unwrap()),
        deleted: open_mark,
        device_id: [header.version as u8; 16],
        committed_ms: 1_000 * header.version as i64,
        superseded_ms: None,
    }
}

fn live_entry(version: u64, path: &str) -> VersionEntry {
    entry_with(
        &vk(),
        &item(),
        &live_header(version, path),
        false,
        version * 10,
    )
}

fn deleted_entry(version: u64, path: &str) -> VersionEntry {
    entry_with(
        &vk(),
        &item(),
        &deleted_header(version, path),
        true,
        version * 10,
    )
}

fn versions_of(
    entries: &[VersionEntry],
    current: Option<[u8; 32]>,
    snaps: &[[u8; 32]],
) -> Vec<u64> {
    server_history(&space(), &[vk()], entries, current, snaps)
        .versions
        .iter()
        .map(|v| v.version)
        .collect()
}

// ----- И2: which versions -----

#[test]
fn i2_shown_versions_carry_the_fields_the_panel_needs_newest_first() {
    // И1, И2, И18: path, size, hash, body, device and the time of the server; newest first.
    let entries = [live_entry(3, "Notes/a.md"), live_entry(2, "Notes/a.md")];
    let history = server_history(&space(), &[vk()], &entries, None, &[]);
    assert!(history.skipped.is_empty());
    let shown: Vec<&HistoryVersion> = history.versions.iter().collect();
    assert_eq!(shown.len(), 2);
    assert_eq!(shown[0].version, 3);
    assert_eq!(shown[1].version, 2);
    let newest = shown[0];
    assert_eq!(newest.item_id, item());
    assert_eq!(newest.path, "Notes/a.md");
    assert_eq!(newest.size, content_of(3).len() as u64);
    assert_eq!(newest.content_hash, blake3_hash(&content_of(3)));
    assert_eq!(newest.body_id, body_for(3));
    assert_eq!(newest.device_id, [3; 16]);
    assert_eq!(newest.committed_ms, 3_000);
}

#[test]
fn i2_deleted_versions_are_left_out_by_the_header_not_by_the_open_mark() {
    // И2-а, Р6: only the header is believed. The open mark may lie either way.
    let live_but_marked_deleted = entry_with(&vk(), &item(), &live_header(2, "a.md"), true, 20);
    let deleted_but_marked_live = entry_with(&vk(), &item(), &deleted_header(3, "a.md"), false, 30);
    let entries = [
        deleted_but_marked_live,
        live_but_marked_deleted,
        live_entry(1, "a.md"),
    ];
    assert_eq!(versions_of(&entries, None, &[]), vec![2, 1]);
}

#[test]
fn i2_a_version_without_a_body_is_left_out() {
    // И2-б: a live header whose entry has no body cannot be shown, it is not "deleted" either.
    let mut broken = live_entry(2, "a.md");
    broken.blob_id = None;
    broken.blob_size = None;
    let entries = [broken, live_entry(1, "a.md")];
    assert_eq!(versions_of(&entries, None, &[]), vec![1]);
}

#[test]
fn i2_a_folder_version_is_left_out() {
    // И2-б, И8: a folder has no body.
    let folder = Header {
        kind: ItemKind::Folder,
        size: 0,
        content_hash: None,
        body_id: None,
        ..live_header(2, "Notes")
    };
    let entries = [
        entry_with(&vk(), &item(), &folder, false, 20),
        live_entry(1, "Notes"),
    ];
    assert_eq!(versions_of(&entries, None, &[]), vec![1]);
}

#[test]
fn i2_a_header_of_a_foreign_key_is_skipped_and_reported_with_a_code() {
    // И2-в, Ф19, С5: a forged header is not shown; the rest of the list still works.
    let forged = entry_with(&other_vk(), &item(), &live_header(2, "a.md"), false, 20);
    let entries = [forged, live_entry(1, "a.md")];
    let history = server_history(&space(), &[vk()], &entries, None, &[]);
    assert_eq!(history.versions.len(), 1);
    assert_eq!(history.versions[0].version, 1);
    assert_eq!(history.skipped.len(), 1);
    assert_eq!(history.skipped[0].version, 2);
    assert_eq!(history.skipped[0].code, SkipCode::Unreadable);
}

#[test]
fn i2_a_header_sealed_for_another_version_is_skipped() {
    // И2-в, Ф19: the version in the AAD must be the version the server announces.
    let mut shifted = live_entry(2, "a.md");
    shifted.version = 5;
    let entries = [shifted, live_entry(1, "a.md")];
    let history = server_history(&space(), &[vk()], &entries, None, &[]);
    assert_eq!(history.versions.len(), 1);
    assert_eq!(history.versions[0].version, 1);
    assert_eq!(history.skipped.len(), 1);
    assert_eq!(history.skipped[0].version, 5);
}

#[test]
fn i2_a_header_of_another_item_is_skipped() {
    // И2-в, Ф19: a header sealed for another item does not open under this item.
    let stranger = ItemId::from_bytes([0x99; 16]);
    let mut swapped = entry_with(&vk(), &stranger, &live_header(2, "x.md"), false, 20);
    swapped.item_id = item();
    let entries = [swapped, live_entry(1, "a.md")];
    assert_eq!(versions_of(&entries, None, &[]), vec![1]);
}

#[test]
fn i2_a_header_with_contradicting_fields_is_skipped_as_inconsistent() {
    // И2-в, Д65: a live file without a content hash.
    let mut header = live_header(2, "a.md");
    header.content_hash = None;
    let entries = [
        entry_with(&vk(), &item(), &header, false, 20),
        live_entry(1, "a.md"),
    ];
    let history = server_history(&space(), &[vk()], &entries, None, &[]);
    assert_eq!(history.versions.len(), 1);
    assert_eq!(history.skipped.len(), 1);
    assert_eq!(history.skipped[0].code, SkipCode::Inconsistent);
}

#[test]
fn i2_an_entry_whose_blob_differs_from_the_header_is_skipped() {
    // И2-в, Д65: the body the server points to is not the body of the header.
    let mut moved = live_entry(2, "a.md");
    moved.blob_id = Some(BodyId::from_bytes([0xEE; 16]));
    let entries = [moved, live_entry(1, "a.md")];
    let history = server_history(&space(), &[vk()], &entries, None, &[]);
    assert_eq!(history.versions.len(), 1);
    assert_eq!(history.skipped[0].version, 2);
    assert_eq!(history.skipped[0].code, SkipCode::Inconsistent);
}

#[test]
fn i2_a_key_for_every_epoch_opens_the_versions_of_that_epoch() {
    // И2-в, Р14: older versions sealed under an older epoch still show; an epoch with no key is
    // skipped with its own code.
    let vk2 = SpaceKey::from_bytes([0x23; 32], 2);
    let vk3_entry = entry_with(
        &SpaceKey::from_bytes([0x24; 32], 3),
        &item(),
        &live_header(3, "a.md"),
        false,
        30,
    );
    let entries = [
        vk3_entry,
        entry_with(&vk2, &item(), &live_header(2, "a.md"), false, 20),
        live_entry(1, "a.md"),
    ];
    let history = server_history(&space(), &[vk(), vk2], &entries, None, &[]);
    let shown: Vec<u64> = history.versions.iter().map(|v| v.version).collect();
    assert_eq!(shown, vec![2, 1]);
    assert_eq!(history.skipped.len(), 1);
    assert_eq!(history.skipped[0].code, SkipCode::UnknownEpoch);
}

#[test]
fn i2_a_renamed_note_shows_every_version_under_its_own_path() {
    // И2-г: the history of a renamed note is not cut at the rename.
    let entries = [
        live_entry(3, "Notes/new-name.md"),
        live_entry(2, "Notes/new-name.md"),
        live_entry(1, "Notes/old-name.md"),
    ];
    let history = server_history(&space(), &[vk()], &entries, None, &[]);
    let paths: Vec<&str> = history.versions.iter().map(|v| v.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "Notes/new-name.md",
            "Notes/new-name.md",
            "Notes/old-name.md"
        ]
    );
}

#[test]
fn i2_nothing_listed_gives_an_empty_history() {
    // И2: an item with no living versions.
    let history = server_history(&space(), &[vk()], &[], None, &[]);
    assert!(history.versions.is_empty());
    assert!(history.skipped.is_empty());
}

#[test]
fn i2_versions_left_out_quietly_are_not_reported() {
    // И2-а: a deleted version is normal, not a fault for the journal.
    let entries = [deleted_entry(2, "a.md"), live_entry(1, "a.md")];
    let history = server_history(&space(), &[vk()], &entries, None, &[]);
    assert!(history.skipped.is_empty());
}

// ----- И3: no repeats -----

#[test]
fn i3_a_version_equal_to_the_file_on_the_disk_is_not_shown() {
    let entries = [
        live_entry(3, "a.md"),
        live_entry(2, "a.md"),
        live_entry(1, "a.md"),
    ];
    let current = Some(blake3_hash(&content_of(3)));
    assert_eq!(versions_of(&entries, current, &[]), vec![2, 1]);
}

#[test]
fn i3_a_version_equal_to_a_local_snapshot_is_not_shown() {
    // И3: the snapshot is closer and needs no network, so the server version is dropped.
    let entries = [
        live_entry(3, "a.md"),
        live_entry(2, "a.md"),
        live_entry(1, "a.md"),
    ];
    let snaps = [blake3_hash(&content_of(2))];
    assert_eq!(versions_of(&entries, None, &snaps), vec![3, 1]);
}

#[test]
fn i3_every_copy_of_a_repeated_content_is_dropped_and_others_stay() {
    // И3: the same text saved twice on the server (versions 1 and 3) is dropped as a whole.
    let mut again = live_header(3, "a.md");
    again.size = content_of(1).len() as u64;
    again.content_hash = Some(blake3_hash(&content_of(1)));
    let entries = [
        entry_with(&vk(), &item(), &again, false, 30),
        live_entry(2, "a.md"),
        live_entry(1, "a.md"),
    ];
    let snaps = [blake3_hash(&content_of(1))];
    assert_eq!(versions_of(&entries, None, &snaps), vec![2]);
}

#[test]
fn i3_other_hashes_change_nothing() {
    let entries = [live_entry(2, "a.md"), live_entry(1, "a.md")];
    let current = Some(blake3_hash(b"something else"));
    let snaps = [blake3_hash(b"and another")];
    assert_eq!(versions_of(&entries, current, &snaps), vec![2, 1]);
}

// ----- И3а: what the repeats are reported as -----

#[test]
fn i3a_a_version_equal_to_a_snapshot_is_reported_as_covered_not_listed() {
    let entries = [
        live_entry(3, "a.md"),
        live_entry(2, "a.md"),
        live_entry(1, "a.md"),
    ];
    let snaps = [blake3_hash(&content_of(2))];
    let history = server_history(&space(), &[vk()], &entries, None, &snaps);
    let listed: Vec<u64> = history.versions.iter().map(|v| v.version).collect();
    let covered: Vec<u64> = history.covered.iter().map(|v| v.version).collect();
    assert_eq!(listed, vec![3, 1], "no separate row for the match (И3)");
    assert_eq!(covered, vec![2]);
}

#[test]
fn i3a_every_copy_of_a_repeated_content_is_covered_newest_first() {
    let mut again = live_header(3, "a.md");
    again.size = content_of(1).len() as u64;
    again.content_hash = Some(blake3_hash(&content_of(1)));
    let entries = [
        entry_with(&vk(), &item(), &again, false, 30),
        live_entry(2, "a.md"),
        live_entry(1, "a.md"),
    ];
    let snaps = [blake3_hash(&content_of(1))];
    let history = server_history(&space(), &[vk()], &entries, None, &snaps);
    let covered: Vec<u64> = history.covered.iter().map(|v| v.version).collect();
    assert_eq!(covered, vec![3, 1]);
}

#[test]
fn i3a_the_current_file_equal_to_the_latest_version_is_marked() {
    let entries = [live_entry(2, "a.md"), live_entry(1, "a.md")];
    let latest = server_history(
        &space(),
        &[vk()],
        &entries,
        Some(blake3_hash(&content_of(2))),
        &[],
    );
    assert!(latest.current_is_latest);
    let older = server_history(
        &space(),
        &[vk()],
        &entries,
        Some(blake3_hash(&content_of(1))),
        &[],
    );
    assert!(!older.current_is_latest, "equal only to an older version");
    let none = server_history(&space(), &[vk()], &entries, None, &[]);
    assert!(!none.current_is_latest);
    assert!(none.covered.is_empty());
}

// ----- И5: opening a body -----

fn history_version(version: u64) -> HistoryVersion {
    let history = server_history(&space(), &[vk()], &[live_entry(version, "a.md")], None, &[]);
    history.versions.into_iter().next().expect("one version")
}

fn sealed(version: u64, content: &[u8]) -> Vec<u8> {
    seal_body(&vk(), &body_for(version), content, &mut OsRandom).unwrap()
}

#[test]
fn i5_a_good_body_opens_to_the_exact_bytes() {
    let version = history_version(2);
    let opened = open_version_body(&[vk()], &version, &sealed(2, &content_of(2)));
    assert_eq!(opened, OpenedVersion::Content(content_of(2)));
}

#[test]
fn i5_a_body_with_another_content_than_the_header_says_is_damaged_not_text() {
    // И5, Д14: authentic body, wrong BLAKE3.
    let version = history_version(2);
    let wrong = b"text of version X".to_vec();
    assert_eq!(wrong.len(), content_of(2).len(), "same length, other bytes");
    assert_eq!(
        open_version_body(&[vk()], &version, &sealed(2, &wrong)),
        OpenedVersion::Damaged
    );
}

#[test]
fn i5_a_changed_byte_makes_the_version_damaged() {
    let version = history_version(2);
    let mut bytes = sealed(2, &content_of(2));
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    assert_eq!(
        open_version_body(&[vk()], &version, &bytes),
        OpenedVersion::Damaged
    );
}

#[test]
fn i5_a_body_of_another_key_or_nothing_at_all_is_damaged() {
    let version = history_version(2);
    let foreign = seal_body(&other_vk(), &body_for(2), &content_of(2), &mut OsRandom).unwrap();
    assert_eq!(
        open_version_body(&[vk()], &version, &foreign),
        OpenedVersion::Damaged
    );
    assert_eq!(
        open_version_body(&[vk()], &version, &[]),
        OpenedVersion::Damaged
    );
}

#[test]
fn i5_a_body_beyond_the_memory_limit_is_too_large_and_is_not_even_looked_at() {
    // И5, Д71.
    let mut version = history_version(2);
    version.size = MAX_PREVIEW_BYTES + 1;
    assert_eq!(
        open_version_body(&[vk()], &version, &[]),
        OpenedVersion::TooLarge
    );
}

// ----- И10, И11: deleted files -----

fn tombstone(path: &str) -> ItemRecord {
    ItemRecord {
        item_id: item(),
        kind: ItemKind::File,
        path: path.into(),
        content_hash: None,
        size: 0,
        mtime_ns: 0,
        version: 9,
        body_id: None,
        deleted: true,
        newer_format: false,
        extra: BTreeMap::new(),
    }
}

fn answer(entries: Vec<VersionEntry>) -> Vec<ItemHistory> {
    vec![ItemHistory {
        item_id: item(),
        entries: Some(entries),
    }]
}

fn rows(
    tombs: &[ItemRecord],
    histories: &[ItemHistory],
    hidden: &[(String, [u8; 32])],
) -> Vec<DeletedFile> {
    deleted_files(&space(), &[vk()], tombs, histories, hidden)
}

#[test]
fn i10_a_tombstone_with_a_body_before_the_deletion_gives_a_row() {
    let histories = answer(vec![
        deleted_entry(3, "Notes/a.md"),
        live_entry(2, "Notes/a.md"),
    ]);
    let list = rows(&[tombstone("Notes/a.md")], &histories, &[]);
    assert_eq!(list.len(), 1);
    let row = &list[0];
    assert_eq!(row.item_id, item());
    assert_eq!(row.path, "Notes/a.md");
    assert_eq!(row.size, content_of(2).len() as u64);
    assert_eq!(row.version, 2, "the version that holds the body");
    assert_eq!(row.body_id, body_for(2));
    assert_eq!(row.content_hash, blake3_hash(&content_of(2)));
    assert_eq!(
        row.deleted_ms, 3_000,
        "committed_ms of the deleting version"
    );
    assert_eq!(row.deleted_seq, 30);
    assert_eq!(row.deleted_by, [3; 16]);
}

#[test]
fn i10_the_row_describes_the_last_version_with_a_body_under_its_own_path() {
    // И10: renamed, then deleted: the path is the one the file had when it was deleted.
    let histories = answer(vec![
        deleted_entry(4, "Notes/new.md"),
        live_entry(3, "Notes/new.md"),
        live_entry(2, "Notes/new.md"),
        live_entry(1, "Notes/old.md"),
    ]);
    let list = rows(&[tombstone("Notes/new.md")], &histories, &[]);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "Notes/new.md");
    assert_eq!(list[0].version, 3);
}

#[test]
fn i10_a_version_that_does_not_pass_the_checks_is_not_the_one_to_return() {
    // И10, И2: the newest body version is forged; the row falls back to the previous honest one.
    let forged = entry_with(&other_vk(), &item(), &live_header(3, "a.md"), false, 30);
    let histories = answer(vec![
        deleted_entry(4, "a.md"),
        forged,
        live_entry(2, "a.md"),
    ]);
    let list = rows(&[tombstone("a.md")], &histories, &[]);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].version, 2);
}

#[test]
fn i10_a_forged_deletion_does_not_make_a_row() {
    // И10, Р6: the deleting version does not open, so the item is not known to be deleted.
    let forged = entry_with(&other_vk(), &item(), &deleted_header(3, "a.md"), true, 30);
    let histories = answer(vec![forged, live_entry(2, "a.md")]);
    assert!(rows(&[tombstone("a.md")], &histories, &[]).is_empty());
}

#[test]
fn i10_deleted_without_any_body_gives_no_row() {
    let histories = answer(vec![deleted_entry(1, "a.md")]);
    assert!(rows(&[tombstone("a.md")], &histories, &[]).is_empty());
}

#[test]
fn i10_an_item_the_server_no_longer_has_gives_no_row() {
    // И10: 404, removed by the cleanup (П36).
    let histories = vec![ItemHistory {
        item_id: item(),
        entries: None,
    }];
    assert!(rows(&[tombstone("a.md")], &histories, &[]).is_empty());
}

#[test]
fn i10_a_tombstone_without_an_answer_gives_no_row() {
    assert!(rows(&[tombstone("a.md")], &[], &[]).is_empty());
}

#[test]
fn i10_a_folder_tombstone_gives_no_row() {
    // И10: files, not folders.
    let mut folder = tombstone("Notes");
    folder.kind = ItemKind::Folder;
    let histories = answer(vec![deleted_entry(2, "Notes"), live_entry(1, "Notes")]);
    assert!(rows(&[folder], &histories, &[]).is_empty());
}

#[test]
fn i10_an_item_that_lives_again_on_the_server_gives_no_row() {
    // И10: the latest version by the server is not a deletion.
    let histories = answer(vec![
        live_entry(3, "a.md"),
        deleted_entry(2, "a.md"),
        live_entry(1, "a.md"),
    ]);
    assert!(rows(&[tombstone("a.md")], &histories, &[]).is_empty());
}

#[test]
fn i10_a_record_that_is_not_a_tombstone_gives_no_row() {
    let mut live = tombstone("a.md");
    live.deleted = false;
    let histories = answer(vec![deleted_entry(2, "a.md"), live_entry(1, "a.md")]);
    assert!(rows(&[live], &histories, &[]).is_empty());
}

#[test]
fn i10_the_newest_deletion_comes_first() {
    // И10, И13: the order is by the deleting commit, not by the item.
    let first = ItemId::from_bytes([0x01; 16]);
    let second = ItemId::from_bytes([0x02; 16]);
    let mut t1 = tombstone("one.md");
    t1.item_id = first;
    let mut t2 = tombstone("two.md");
    t2.item_id = second;
    let mk = |id: ItemId, path: &str, delete_seq: u64| {
        let live = entry_with(&vk(), &id, &live_header(1, path), false, 5);
        let mut deleted = entry_with(&vk(), &id, &deleted_header(2, path), true, delete_seq);
        deleted.seq = delete_seq;
        ItemHistory {
            item_id: id,
            entries: Some(vec![deleted, live]),
        }
    };
    let histories = vec![mk(first, "one.md", 100), mk(second, "two.md", 200)];
    let list = rows(&[t1, t2], &histories, &[]);
    let paths: Vec<&str> = list.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths, vec!["two.md", "one.md"]);
}

#[test]
fn i11_a_file_with_the_same_path_and_content_is_hidden() {
    // И11: it is in the local trash, or lies at its path again.
    let histories = answer(vec![
        deleted_entry(2, "Notes/a.md"),
        live_entry(1, "Notes/a.md"),
    ]);
    let hidden = [("Notes/a.md".to_string(), blake3_hash(&content_of(1)))];
    assert!(rows(&[tombstone("Notes/a.md")], &histories, &hidden).is_empty());
}

#[test]
fn i11_the_same_path_with_other_content_stays() {
    // И11: the person has another text at this path (or in the trash): the server copy is still
    // the only one of its text.
    let histories = answer(vec![
        deleted_entry(2, "Notes/a.md"),
        live_entry(1, "Notes/a.md"),
    ]);
    let hidden = [("Notes/a.md".to_string(), blake3_hash(b"another text"))];
    assert_eq!(
        rows(&[tombstone("Notes/a.md")], &histories, &hidden).len(),
        1
    );
}

#[test]
fn i11_the_same_content_under_another_path_stays() {
    let histories = answer(vec![
        deleted_entry(2, "Notes/a.md"),
        live_entry(1, "Notes/a.md"),
    ]);
    let hidden = [("Notes/b.md".to_string(), blake3_hash(&content_of(1)))];
    assert_eq!(
        rows(&[tombstone("Notes/a.md")], &histories, &hidden).len(),
        1
    );
}

#[test]
fn i11a_a_hidden_match_is_reported_with_the_index_of_what_hid_it() {
    let histories = answer(vec![
        deleted_entry(3, "Notes/a.md"),
        live_entry(2, "Notes/a.md"),
    ]);
    let hidden = [
        ("Notes/other.md".to_string(), blake3_hash(&content_of(2))),
        ("Notes/a.md".to_string(), blake3_hash(&content_of(2))),
    ];
    let result = deleted_files_matched(
        &space(),
        &[vk()],
        &[tombstone("Notes/a.md")],
        &histories,
        &hidden,
    );
    assert!(result.rows.is_empty(), "still no separate row (И11)");
    assert_eq!(result.matched.len(), 1);
    assert_eq!(result.matched[0].hidden_index, 1);
    assert_eq!(result.matched[0].file.path, "Notes/a.md");
}

#[test]
fn i11a_a_row_that_nothing_hides_has_no_match() {
    let histories = answer(vec![
        deleted_entry(3, "Notes/a.md"),
        live_entry(2, "Notes/a.md"),
    ]);
    let hidden = [("Notes/a.md".to_string(), blake3_hash(b"another text"))];
    let result = deleted_files_matched(
        &space(),
        &[vk()],
        &[tombstone("Notes/a.md")],
        &histories,
        &hidden,
    );
    assert_eq!(result.rows.len(), 1);
    assert!(result.matched.is_empty());
}

// ----- И10а: service files are never shown; И10б: one row per path -----

fn item_n(n: u8) -> ItemId {
    ItemId::from_bytes([n; 16])
}

/// A deleted file of item `n` at `path`: a live version, then a deletion at `delete_seq`.
fn history_of(n: u8, path: &str, delete_seq: u64) -> (ItemRecord, ItemHistory) {
    let id = item_n(n);
    let mut record = tombstone(path);
    record.item_id = id;
    let live = entry_with(&vk(), &id, &live_header(1, path), false, 5);
    let deleted = entry_with(&vk(), &id, &deleted_header(2, path), true, delete_seq);
    (
        record,
        ItemHistory {
            item_id: id,
            entries: Some(vec![deleted, live]),
        },
    )
}

#[test]
fn i10a_a_path_inside_amby_is_a_service_path() {
    for path in [
        ".amby/conflicts/c1/meta.json",
        ".amby/properties/prop_01.jsonl",
        ".amby/layout.json",
        ".amby",
        ".AMBY/conflicts/x",
    ] {
        assert!(is_service_path(path), "{path}");
    }
    for path in [
        "Notes/a.md",
        "Notes/.amby/a.md",
        ".ambyx/a.md",
        "amby/a.md",
        "",
    ] {
        assert!(!is_service_path(path), "{path}");
    }
}

#[test]
fn i10a_service_files_get_no_row() {
    let (t1, h1) = history_of(1, ".amby/conflicts/c1/meta.json", 100);
    let (t2, h2) = history_of(2, ".amby/properties/prop_01.jsonl", 110);
    let (t3, h3) = history_of(3, "Notes/a.md", 120);
    let list = rows(&[t1, t2, t3], &[h1, h2, h3], &[]);
    let paths: Vec<&str> = list.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths, vec!["Notes/a.md"]);
}

#[test]
fn i10a_a_service_file_is_not_a_cloud_match_either() {
    // И3а, И11а: not as a mark on a local trash entry.
    let path = ".amby/conflicts/c1/meta.json";
    let (t1, h1) = history_of(1, path, 100);
    let hidden = [(path.to_string(), blake3_hash(&content_of(1)))];
    let result = deleted_files_matched(&space(), &[vk()], &[t1], &[h1], &hidden);
    assert!(result.rows.is_empty());
    assert!(result.matched.is_empty());
}

#[test]
fn i10a_the_restore_layout_still_finds_the_file_so_that_the_caller_can_refuse_it() {
    let path = ".amby/properties/prop_01.jsonl";
    let (t1, h1) = history_of(1, path, 100);
    let found = locate_deleted_file(&space(), &[vk()], &t1, h1.entries.as_deref().unwrap());
    assert_eq!(found.map(|file| file.path), Some(path.to_string()));
}

#[test]
fn i10b_a_path_deleted_several_times_gives_one_row_for_the_newest_deletion() {
    // И16: each return is a new item, so the same path is deleted again under another item.
    let (t1, h1) = history_of(1, "Notes/a.md", 100);
    let (t2, h2) = history_of(2, "Notes/a.md", 300);
    let (t3, h3) = history_of(3, "Notes/a.md", 200);
    let list = rows(&[t1, t2, t3], &[h1, h2, h3], &[]);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].item_id, item_n(2));
    assert_eq!(list[0].deleted_seq, 300);
}

#[test]
fn i10b_other_paths_keep_their_own_rows_and_the_order() {
    let (t1, h1) = history_of(1, "Notes/a.md", 100);
    let (t2, h2) = history_of(2, "Notes/b.md", 300);
    let (t3, h3) = history_of(3, "Notes/a.md", 200);
    let list = rows(&[t1, t2, t3], &[h1, h2, h3], &[]);
    let seen: Vec<(&str, u64)> = list
        .iter()
        .map(|r| (r.path.as_str(), r.deleted_seq))
        .collect();
    assert_eq!(seen, vec![("Notes/b.md", 300), ("Notes/a.md", 200)]);
}
