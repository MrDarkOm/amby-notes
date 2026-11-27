//! The state of the device in SQLite (docs/sync-plan.md, Р10, Д3, Д4, Д9, С14).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use amby_sync_core::crypto::header::ItemKind;
use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::engine::names::NameProblem;
use amby_sync_core::engine::CommitItem;
use amby_sync_core::engine::{
    ConflictKind, ConflictRecord, ItemRecord, PendingCommit, PendingUpload, StateError, StateOp,
    StateStore, SyncState, UnsyncedReason, UnsyncedRecord,
};
use serde_json::json;

use super::state_db::{
    state_path, SqliteStateStore, META_DEVICE_ID, META_SPACE_ID, META_TEST_VAULT, SCHEMA_VERSION,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Dir(PathBuf);

impl Dir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "amby-statedb-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn id(n: u8) -> ItemId {
    ItemId::from_bytes([n; 16])
}

fn record(n: u8, path: &str) -> ItemRecord {
    let mut extra = BTreeMap::new();
    extra.insert(
        "from-the-future".to_string(),
        json!({"a": [1, 2, {"b": null}]}),
    );
    ItemRecord {
        item_id: id(n),
        kind: ItemKind::File,
        path: path.to_string(),
        content_hash: Some([n; 32]),
        size: 1000 + u64::from(n),
        mtime_ns: 1_760_000_000_000_000_000 + i64::from(n),
        version: u64::from(n) + 1,
        body_id: Some(BodyId::from_bytes([n.wrapping_add(100); 16])),
        deleted: false,
        newer_format: n.is_multiple_of(2),
        extra,
    }
}

fn folder(n: u8, path: &str) -> ItemRecord {
    ItemRecord {
        item_id: id(n),
        kind: ItemKind::Folder,
        path: path.to_string(),
        content_hash: None,
        size: 0,
        mtime_ns: i64::MIN,
        version: 3,
        body_id: None,
        deleted: false,
        newer_format: false,
        extra: BTreeMap::new(),
    }
}

fn open(dir: &Dir) -> SqliteStateStore {
    SqliteStateStore::open_file(&dir.0.join("state.db")).unwrap()
}

#[test]
fn a_new_device_has_an_empty_state() {
    // Д8
    let dir = Dir::new();
    let mut store = open(&dir);
    assert_eq!(store.load().unwrap(), SyncState::default());
}

#[test]
fn the_state_of_a_vault_lives_in_amby_sync() {
    // Р10: `.amby/sync/state.db`, made with its folders
    let dir = Dir::new();
    let mut store = SqliteStateStore::open(&dir.0).unwrap();
    assert_eq!(state_path(&dir.0), dir.0.join(".amby/sync/state.db"));
    assert!(state_path(&dir.0).is_file());
    store
        .apply(&vec![StateOp::SetCursor { cursor: 4, head: 9 }])
        .unwrap();
    drop(store);
    let mut again = SqliteStateStore::open(&dir.0).unwrap();
    assert_eq!(again.load().unwrap().cursor, 4);
}

#[test]
fn every_operation_is_stored_and_read_back_exactly() {
    // Д3, Д4: the whole state round-trips through the file
    let dir = Dir::new();
    let mut store = open(&dir);
    let commit = PendingCommit {
        commit_id: [9; 16],
        items: vec![CommitItem {
            item_id: id(1),
            base_version: 2,
            header: vec![1, 2, 3, 4, 5],
            blob_id: Some(BodyId::from_bytes([7; 16])),
            deleted: false,
        }],
        after: vec![record(1, "after.md")],
    };
    let upload = PendingUpload {
        blob_id: BodyId::from_bytes([5; 16]),
        item_id: id(3),
        content_hash: [6; 32],
        size: 12_345,
        nonce_prefix: [8; 19],
    };
    let conflict = ConflictRecord {
        id: "0123456789ab".to_string(),
        kind: ConflictKind::BothEdited,
        original_path: "Notes/a.md".to_string(),
        copy_path: "Notes/a.0123456789ab-conflict.md".to_string(),
        created_ms: 1_760_000_000_123,
    };
    let unsynced = vec![
        UnsyncedRecord {
            path: "a:b.md".to_string(),
            reason: UnsyncedReason::InvalidName(NameProblem::WindowsForbiddenChar(':')),
        },
        UnsyncedRecord {
            path: "link".to_string(),
            reason: UnsyncedReason::Symlink,
        },
        UnsyncedRecord {
            path: "Big.bin".to_string(),
            reason: UnsyncedReason::TooBigForMemory,
        },
        UnsyncedRecord {
            path: "Note.md".to_string(),
            reason: UnsyncedReason::CaseCollision {
                with: "note.md".to_string(),
            },
        },
        UnsyncedRecord {
            path: "x".to_string(),
            reason: UnsyncedReason::NoAccess,
        },
    ];
    store
        .apply(&vec![
            StateOp::SetInstance([0xAB; 16]),
            StateOp::SetCursor {
                cursor: 7,
                head: 11,
            },
            StateOp::PutItem(record(1, "Notes/a.md")),
            StateOp::PutItem(record(2, "Notes/b.md")),
            StateOp::PutItem(folder(3, "Empty")),
            StateOp::PutUpload(upload.clone()),
            StateOp::SetCommit(Some(commit.clone())),
            StateOp::AddConflict(conflict.clone()),
            StateOp::SetUnsynced(unsynced.clone()),
        ])
        .unwrap();
    let state = store.load().unwrap();
    assert_eq!(state.instance_id, Some([0xAB; 16]));
    assert_eq!((state.cursor, state.head), (7, 11));
    assert_eq!(state.items.len(), 3);
    assert_eq!(state.items[&[1u8; 16]], record(1, "Notes/a.md"));
    assert_eq!(state.items[&[2u8; 16]], record(2, "Notes/b.md"));
    assert_eq!(state.items[&[3u8; 16]], folder(3, "Empty"));
    assert_eq!(state.uploads[&[5u8; 16]], upload);
    assert_eq!(state.commit, Some(commit));
    assert_eq!(state.conflicts, vec![conflict]);
    assert_eq!(state.unsynced, unsynced);
}

#[test]
fn the_state_survives_closing_the_file() {
    // Д4: after a crash the next pass continues from here
    let dir = Dir::new();
    let first = {
        let mut store = open(&dir);
        store
            .apply(&vec![
                StateOp::SetCursor { cursor: 3, head: 3 },
                StateOp::PutItem(record(4, "x.md")),
            ])
            .unwrap();
        store.load().unwrap()
    };
    assert_eq!(open(&dir).load().unwrap(), first);
}

#[test]
fn operations_replace_remove_and_reset_as_the_engine_means() {
    let dir = Dir::new();
    let mut store = open(&dir);
    let conflict = |n: u8| ConflictRecord {
        id: format!("{n:012x}"),
        kind: ConflictKind::BothCreated,
        original_path: "o.md".to_string(),
        copy_path: format!("o.{n:012x}-conflict.md"),
        created_ms: 1,
    };
    store
        .apply(&vec![
            StateOp::PutItem(record(1, "old.md")),
            StateOp::PutItem(record(2, "two.md")),
            StateOp::PutUpload(PendingUpload {
                blob_id: BodyId::from_bytes([1; 16]),
                item_id: id(1),
                content_hash: [0; 32],
                size: 1,
                nonce_prefix: [0; 19],
            }),
            StateOp::AddConflict(conflict(1)),
            StateOp::AddConflict(conflict(2)),
            StateOp::SetUnsynced(vec![UnsyncedRecord {
                path: "u".into(),
                reason: UnsyncedReason::PathBusy,
            }]),
            StateOp::SetCursor { cursor: 5, head: 5 },
            StateOp::SetInstance([1; 16]),
        ])
        .unwrap();
    // PutItem replaces; RemoveItem forgets; RemoveUpload forgets; RemoveConflict by id.
    store
        .apply(&vec![
            StateOp::PutItem(record(1, "renamed.md")),
            StateOp::RemoveItem(id(2)),
            StateOp::RemoveUpload(BodyId::from_bytes([1; 16])),
            StateOp::RemoveConflict(conflict(1).id),
            StateOp::SetUnsynced(vec![]),
        ])
        .unwrap();
    let state = store.load().unwrap();
    assert_eq!(state.items.len(), 1);
    assert_eq!(state.items[&[1u8; 16]].path, "renamed.md");
    assert!(state.uploads.is_empty());
    assert_eq!(state.conflicts, vec![conflict(2)]);
    assert!(state.unsynced.is_empty());
    // SetCommit(None) clears.
    store.apply(&vec![StateOp::SetCommit(None)]).unwrap();
    assert!(store.load().unwrap().commit.is_none());
    // ResetServerLink forgets the link and keeps the conflicts and the list (Д56).
    store
        .apply(&vec![StateOp::SetUnsynced(vec![UnsyncedRecord {
            path: "u".into(),
            reason: UnsyncedReason::PathBusy,
        }])])
        .unwrap();
    store.apply(&vec![StateOp::ResetServerLink]).unwrap();
    let state = store.load().unwrap();
    assert!(state.items.is_empty() && state.uploads.is_empty() && state.commit.is_none());
    assert_eq!((state.cursor, state.head), (0, 0));
    assert_eq!(state.conflicts, vec![conflict(2)]);
    assert_eq!(state.unsynced.len(), 1);
}

#[test]
fn a_transaction_is_all_or_nothing() {
    // Д4: checked from outside — a trigger makes the third operation fail
    let dir = Dir::new();
    let mut store = open(&dir);
    store
        .apply(&vec![StateOp::SetCursor { cursor: 1, head: 1 }])
        .unwrap();
    {
        let side = rusqlite::Connection::open(dir.0.join("state.db")).unwrap();
        side.execute_batch(
            "CREATE TRIGGER poison BEFORE INSERT ON items WHEN NEW.path = 'poison' \
             BEGIN SELECT RAISE(ABORT, 'poisoned'); END;",
        )
        .unwrap();
    }
    let result = store.apply(&vec![
        StateOp::SetCursor {
            cursor: 99,
            head: 99,
        },
        StateOp::PutItem(record(1, "fine.md")),
        StateOp::PutItem(record(2, "poison")),
    ]);
    assert!(
        result.is_err(),
        "the poisoned operation must fail the whole transaction"
    );
    let state = store.load().unwrap();
    assert_eq!(state.cursor, 1, "the cursor did not move");
    assert!(state.items.is_empty(), "the first item was not kept");
}

#[test]
fn the_schema_number_is_written_and_a_newer_file_is_left_alone() {
    // Р10: a file of a newer schema is a newer Amby's; never touch it
    let dir = Dir::new();
    drop(open(&dir));
    let path = dir.0.join("state.db");
    let version: u32 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);

    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1))
        .unwrap();
    let before = fs::read(&path).unwrap();
    let error = SqliteStateStore::open_file(&path)
        .err()
        .expect("must refuse");
    match error {
        StateError::Io(text) => assert_eq!(text, "state_newer"),
        other => panic!("{other:?}"),
    }
    assert_eq!(fs::read(&path).unwrap(), before, "the file is untouched");
    let siblings: Vec<_> = fs::read_dir(&dir.0).unwrap().flatten().collect();
    assert_eq!(siblings.len(), 1, "nothing was moved aside");
}

#[test]
fn a_damaged_file_is_moved_aside_and_a_new_one_is_made() {
    // Р10: "if the file is lost, the device reconciles everything again"; the evidence stays
    let dir = Dir::new();
    let path = dir.0.join("state.db");
    fs::write(&path, b"this is not a database at all, just bytes").unwrap();
    let mut store = open(&dir);
    assert_eq!(store.load().unwrap(), SyncState::default());
    let aside: Vec<String> = fs::read_dir(&dir.0)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("state.db.broken-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert_eq!(
        fs::read(dir.0.join(&aside[0])).unwrap(),
        b"this is not a database at all, just bytes"
    );
}

#[test]
fn the_lock_is_exclusive_and_released_when_dropped() {
    // Д9, С14
    let dir = Dir::new();
    let mut first = open(&dir);
    let mut second = open(&dir);
    let held = first.lock().unwrap();
    match second.lock() {
        Err(StateError::Locked) => {}
        Err(other) => panic!("{other:?}"),
        Ok(_) => panic!("two processes would synchronise one vault"),
    }
    drop(held);
    assert!(second.lock().is_ok(), "released with the guard");
}

#[test]
fn small_values_are_kept_in_meta_and_can_be_removed() {
    // Р10: the identity of the device, the space, the test mark
    let dir = Dir::new();
    let mut store = open(&dir);
    assert_eq!(store.meta(META_DEVICE_ID).unwrap(), None);
    store.set_meta(META_DEVICE_ID, "abcd").unwrap();
    store.set_meta(META_SPACE_ID, "0011").unwrap();
    store.set_meta(META_TEST_VAULT, "1").unwrap();
    store.set_meta(META_DEVICE_ID, "ef01").unwrap();
    drop(store);
    let mut store = open(&dir);
    assert_eq!(store.meta(META_DEVICE_ID).unwrap().as_deref(), Some("ef01"));
    assert_eq!(store.meta(META_SPACE_ID).unwrap().as_deref(), Some("0011"));
    store.remove_meta(META_SPACE_ID).unwrap();
    assert_eq!(store.meta(META_SPACE_ID).unwrap(), None);
    assert_eq!(store.meta(META_TEST_VAULT).unwrap().as_deref(), Some("1"));
}

#[test]
fn clearing_the_link_keeps_the_meta() {
    let dir = Dir::new();
    let mut store = open(&dir);
    store.set_meta(META_SPACE_ID, "0011").unwrap();
    store
        .apply(&vec![
            StateOp::SetCursor { cursor: 8, head: 8 },
            StateOp::SetInstance([2; 16]),
            StateOp::PutItem(record(1, "a.md")),
            StateOp::AddConflict(ConflictRecord {
                id: "000000000001".into(),
                kind: ConflictKind::BothEdited,
                original_path: "a.md".into(),
                copy_path: "b.md".into(),
                created_ms: 1,
            }),
        ])
        .unwrap();
    store.clear_sync_state().unwrap();
    let state = store.load().unwrap();
    assert_eq!(state, SyncState::default());
    assert_eq!(store.meta(META_SPACE_ID).unwrap().as_deref(), Some("0011"));
}

#[test]
fn a_big_state_is_written_in_one_transaction_and_read_fast() {
    // 20 000 files is a big vault; the pass loads the whole state every time
    let dir = Dir::new();
    let mut store = open(&dir);
    let tx: Vec<StateOp> = (0..20_000u32)
        .map(|n| {
            let mut r = record((n % 250) as u8, &format!("Notes/{n}.md"));
            r.item_id = ItemId::from_bytes({
                let mut bytes = [0u8; 16];
                bytes[..4].copy_from_slice(&n.to_be_bytes());
                bytes
            });
            StateOp::PutItem(r)
        })
        .collect();
    let started = std::time::Instant::now();
    store.apply(&tx).unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded.items.len(), 20_000);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(20),
        "took {:?}",
        started.elapsed()
    );
}
