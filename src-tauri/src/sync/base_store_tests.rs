//! The bases of the merge on disk (docs/sync-plan.md, appendix Г, К1: Г6–Г9, Г10): the port
//! `StateStore::base_put` / `base_get` / `base_prune` of the state in `.amby/sync/`. Red until
//! written: the methods are `todo!()` today.

use std::fs;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::StateStore;

use super::state_db::{state_dir, SqliteStateStore};
use super::test_support::TempVault;

fn item(n: u8) -> ItemId {
    ItemId::from_bytes([n; 16])
}

fn open(vault: &TempVault) -> SqliteStateStore {
    SqliteStateStore::open(&vault.root).unwrap()
}

/// Every file under `.amby/sync/bases/`.
fn base_files(vault: &TempVault) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    for entry in walkdir::WalkDir::new(state_dir(&vault.root).join("bases"))
        .into_iter()
        .flatten()
    {
        if entry.file_type().is_file() {
            found.push(entry.path().to_path_buf());
        }
    }
    found
}

#[test]
fn a_base_is_read_back_by_its_item_and_hash() {
    // Г7
    let vault = TempVault::new("base");
    let mut store = open(&vault);
    let bytes = b"the last common version\n".to_vec();
    let hash = blake3_hash(&bytes);
    assert_eq!(
        store.base_get(&item(1), &hash).unwrap(),
        None,
        "nothing yet"
    );
    store.base_put(&item(1), &hash, &bytes).unwrap();
    assert_eq!(
        store.base_get(&item(1), &hash).unwrap(),
        Some(bytes.clone())
    );
    assert_eq!(
        store.base_get(&item(2), &hash).unwrap(),
        None,
        "another item has no base"
    );
    assert_eq!(
        store.base_get(&item(1), &blake3_hash(b"another")).unwrap(),
        None,
        "another hash has no base"
    );
}

#[test]
fn a_base_is_kept_under_amby_sync_and_survives_a_restart() {
    // Г6, Г7: a file of the device, durable before `base_put` returns
    let vault = TempVault::new("base");
    let bytes = "Привет\r\n\u{feff}mixed\n".as_bytes().to_vec();
    let hash = blake3_hash(&bytes);
    {
        let mut store = open(&vault);
        store.base_put(&item(3), &hash, &bytes).unwrap();
    }
    let files = base_files(&vault);
    assert!(!files.is_empty(), "the base is in .amby/sync/bases/");
    let mut again = open(&vault);
    assert_eq!(again.base_get(&item(3), &hash).unwrap(), Some(bytes));
}

#[test]
fn a_repeat_of_the_same_put_is_harmless() {
    // Г7
    let vault = TempVault::new("base");
    let mut store = open(&vault);
    let hash = blake3_hash(b"x\n");
    store.base_put(&item(1), &hash, b"x\n").unwrap();
    store.base_put(&item(1), &hash, b"x\n").unwrap();
    assert_eq!(
        store.base_get(&item(1), &hash).unwrap(),
        Some(b"x\n".to_vec())
    );
}

#[test]
fn two_versions_of_one_item_can_be_kept_at_once() {
    // Г9: the new base is written before the state refers to it, so for a moment there are two
    let vault = TempVault::new("base");
    let mut store = open(&vault);
    let (old, new) = (b"old\n".to_vec(), b"new\n".to_vec());
    store.base_put(&item(1), &blake3_hash(&old), &old).unwrap();
    store.base_put(&item(1), &blake3_hash(&new), &new).unwrap();
    assert_eq!(
        store.base_get(&item(1), &blake3_hash(&old)).unwrap(),
        Some(old)
    );
    assert_eq!(
        store.base_get(&item(1), &blake3_hash(&new)).unwrap(),
        Some(new)
    );
}

#[test]
fn a_damaged_base_reads_as_no_base() {
    // Г7, Г10: the bytes must hash to the key; anything else is `Ok(None)`, never an error
    let vault = TempVault::new("base");
    let bytes = b"intact\n".to_vec();
    let hash = blake3_hash(&bytes);
    let mut store = open(&vault);
    store.base_put(&item(1), &hash, &bytes).unwrap();
    let files = base_files(&vault);
    assert_eq!(files.len(), 1, "{files:?}");
    fs::write(&files[0], b"intact?\n").unwrap();
    assert_eq!(store.base_get(&item(1), &hash).unwrap(), None);
    fs::write(&files[0], b"").unwrap();
    assert_eq!(store.base_get(&item(1), &hash).unwrap(), None);
    fs::remove_file(&files[0]).unwrap();
    assert_eq!(store.base_get(&item(1), &hash).unwrap(), None);
}

#[test]
fn a_put_whose_bytes_do_not_match_the_hash_is_never_returned() {
    // Г7: the reader checks the hash, so a wrong pair is simply not a base
    let vault = TempVault::new("base");
    let mut store = open(&vault);
    let hash = blake3_hash(b"the claimed content\n");
    let _ = store.base_put(&item(1), &hash, b"something else\n");
    assert_eq!(store.base_get(&item(1), &hash).unwrap(), None);
}

#[test]
fn a_prune_keeps_the_listed_pairs_and_removes_the_rest() {
    // Г9
    let vault = TempVault::new("base");
    let mut store = open(&vault);
    let mut pairs = Vec::new();
    for n in 1..=4u8 {
        let bytes = format!("content {n}\n").into_bytes();
        let hash = blake3_hash(&bytes);
        store.base_put(&item(n), &hash, &bytes).unwrap();
        pairs.push((item(n), hash, bytes));
    }
    // the first item keeps one of two versions
    let extra = b"older content 1\n".to_vec();
    store
        .base_put(&item(1), &blake3_hash(&extra), &extra)
        .unwrap();
    store
        .base_prune(&[(item(1), pairs[0].1), (item(3), pairs[2].1)])
        .unwrap();
    assert_eq!(
        store.base_get(&item(1), &pairs[0].1).unwrap(),
        Some(pairs[0].2.clone())
    );
    assert_eq!(
        store.base_get(&item(1), &blake3_hash(&extra)).unwrap(),
        None
    );
    assert_eq!(store.base_get(&item(2), &pairs[1].1).unwrap(), None);
    assert_eq!(
        store.base_get(&item(3), &pairs[2].1).unwrap(),
        Some(pairs[2].2.clone())
    );
    assert_eq!(store.base_get(&item(4), &pairs[3].1).unwrap(), None);
    // an empty list removes everything, and nothing is left on the disk
    store.base_prune(&[]).unwrap();
    assert_eq!(store.base_get(&item(3), &pairs[2].1).unwrap(), None);
    assert!(base_files(&vault).is_empty(), "{:?}", base_files(&vault));
}

#[test]
fn a_prune_of_an_empty_store_is_fine() {
    // Г9
    let vault = TempVault::new("base");
    let mut store = open(&vault);
    store.base_prune(&[]).unwrap();
    store.base_prune(&[(item(1), [7; 32])]).unwrap();
}

#[test]
fn no_temporary_file_is_left_behind() {
    // Г7: written through a temporary file and a rename
    let vault = TempVault::new("base");
    let mut store = open(&vault);
    for n in 0..5u8 {
        let bytes = vec![n; 1000];
        store
            .base_put(&item(1), &blake3_hash(&bytes), &bytes)
            .unwrap();
    }
    for file in base_files(&vault) {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.contains("tmp") && !name.contains("partial"), "{name}");
    }
}

#[test]
fn the_bases_are_not_in_the_state_database() {
    // Г6: files of the device, not rows: a big base does not grow state.db
    let vault = TempVault::new("base");
    let mut store = open(&vault);
    let before = fs::metadata(state_dir(&vault.root).join("state.db"))
        .unwrap()
        .len();
    let big = vec![b'x'; 900_000];
    store.base_put(&item(1), &blake3_hash(&big), &big).unwrap();
    let after = fs::metadata(state_dir(&vault.root).join("state.db"))
        .unwrap()
        .len();
    assert!(
        after < before + 100_000,
        "state.db grew from {before} to {after}"
    );
    assert!(!base_files(&vault).is_empty());
}
