//! The pre-sync copy lives in Amby's app data, one per vault, and expires 14 days after the
//! first successful sync. Older receipts inside the vault are still honoured.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::backup::{self, restore, Standing, RETENTION_MS};

const DAY: u64 = 24 * 60 * 60 * 1000;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("amby-backup-home-test-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn vault_at(root: &Path, name: &str, note: &[u8]) -> PathBuf {
    let path = root.join(name);
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("n.md"), note).unwrap();
    path.canonicalize().unwrap()
}

fn purge(vault: &Path) {
    let _ = fs::remove_dir_all(backup::key_dir(vault, false).unwrap());
}

fn app_receipt(vault: &Path) -> PathBuf {
    backup::key_dir(vault, false).unwrap().join("receipt.json")
}

fn json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn ulid_dirs(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Rebuilds the layout of an older version: the copy beside the vault and a receipt inside it.
fn make_legacy(vault: &Path) -> PathBuf {
    let root = PathBuf::from(backup::ensure(vault).unwrap());
    let id = root.file_name().unwrap().to_owned();
    let name = vault.file_name().unwrap().to_str().unwrap();
    let container = vault.with_file_name(format!("{name}.amby-backups"));
    fs::create_dir_all(&container).unwrap();
    let moved = container.join(id);
    fs::rename(&root, &moved).unwrap();
    let mut receipt = json(&app_receipt(vault));
    receipt["backup_root"] = Value::String(moved.to_str().unwrap().into());
    for key in ["first_sync_ms", "removed_ms", "superseded"] {
        receipt.as_object_mut().unwrap().remove(key);
    }
    fs::create_dir_all(vault.join(".amby/sync")).unwrap();
    fs::write(
        vault.join(".amby/sync/pre-sync-backup.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    purge(vault);
    moved
}

#[test]
fn a_new_copy_lives_in_app_data_and_nothing_is_created_beside_the_vault() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"original");
    let root = PathBuf::from(backup::ensure(&vault).unwrap());
    assert!(root.starts_with(backup::home().unwrap().canonicalize().unwrap()));
    assert_eq!(fs::read(root.join("vault/n.md")).unwrap(), b"original");
    assert_eq!(ulid_dirs(temp.path()), vec!["Notes".to_string()]);
    assert!(!vault.join(".amby/sync/pre-sync-backup.json").exists());
    assert_eq!(
        json(&app_receipt(&vault))["backup_root"].as_str(),
        root.to_str()
    );
    assert_eq!(backup::read_path(&vault).as_deref(), root.to_str());
    purge(&vault);
}

#[test]
fn there_is_one_copy_per_vault() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"original");
    let first = backup::ensure(&vault).unwrap();
    fs::write(vault.join("n.md"), b"changed later").unwrap();
    let second = backup::ensure(&vault).unwrap();
    assert_eq!(first, second);
    assert_eq!(ulid_dirs(&backup::key_dir(&vault, false).unwrap()).len(), 1);
    purge(&vault);
}

#[test]
fn a_missing_previous_copy_is_not_a_dead_end() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"original");
    let old = PathBuf::from(backup::ensure(&vault).unwrap());
    fs::remove_dir_all(&old).unwrap();
    assert_eq!(backup::standing(&vault), Standing::Lost);
    assert!(backup::read_path(&vault).is_none());
    // Enabling goes on and makes a fresh copy.
    backup::prepare(&vault).unwrap();
    let fresh = backup::read_path(&vault).expect("a new copy");
    assert_ne!(PathBuf::from(&fresh), old);
    assert_eq!(
        fs::read(Path::new(&fresh).join("vault/n.md")).unwrap(),
        b"original"
    );
    assert_eq!(backup::standing(&vault), Standing::Ready(fresh));
    purge(&vault);
}

#[test]
fn a_damaged_copy_is_never_overwritten_the_new_copy_gets_a_new_folder() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"original");
    let old = PathBuf::from(backup::ensure(&vault).unwrap());
    fs::write(old.join("vault/n.md"), b"damaged").unwrap();
    let fresh = PathBuf::from(backup::ensure(&vault).unwrap());
    assert_ne!(fresh, old);
    assert_eq!(fs::read(old.join("vault/n.md")).unwrap(), b"damaged");
    assert_eq!(fs::read(fresh.join("vault/n.md")).unwrap(), b"original");
    let receipt = json(&app_receipt(&vault));
    assert_eq!(receipt["backup_root"].as_str(), fresh.to_str());
    assert_eq!(
        receipt["superseded"][0].as_str(),
        old.file_name().unwrap().to_str()
    );
    purge(&vault);
}

#[test]
fn a_legacy_receipt_inside_the_vault_is_honoured_and_not_superseded() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"original");
    let legacy = make_legacy(&vault);
    assert_eq!(
        backup::read_path(&vault).as_deref(),
        legacy.to_str(),
        "an older copy that still exists stays valid"
    );
    assert_eq!(
        backup::ensure(&vault).unwrap(),
        legacy.to_str().unwrap(),
        "no second copy is made"
    );
    assert!(!app_receipt(&vault).exists());
    purge(&vault);
}

#[test]
fn a_deleted_legacy_sibling_folder_does_not_block_a_new_copy() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"original");
    let legacy = make_legacy(&vault);
    let receipt_bytes = fs::read(vault.join(".amby/sync/pre-sync-backup.json")).unwrap();
    fs::remove_dir_all(legacy.parent().unwrap()).unwrap();
    assert_eq!(backup::standing(&vault), Standing::Lost);
    backup::prepare(&vault).unwrap();
    let fresh = backup::read_path(&vault).expect("a new copy in app data");
    assert!(Path::new(&fresh).starts_with(backup::home().unwrap().canonicalize().unwrap()));
    assert_eq!(
        fs::read(vault.join(".amby/sync/pre-sync-backup.json")).unwrap(),
        receipt_bytes,
        "the old receipt is superseded by the app-data one, not edited or deleted"
    );
    assert!(!vault.with_file_name("Notes.amby-backups").exists());
    purge(&vault);
}

#[test]
fn the_copy_expires_14_days_after_the_first_successful_sync_and_only_then() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"mine");
    let other = vault_at(temp.path(), "Other", b"theirs");
    let root = PathBuf::from(backup::ensure(&vault).unwrap());
    let other_root = PathBuf::from(backup::ensure(&other).unwrap());
    let start = 1_700_000_000_000u64;

    assert!(!backup::cleanup_expired(&vault, start + 100 * DAY).unwrap());
    assert!(root.exists(), "no successful sync yet: the copy stays");

    backup::record_first_sync(&vault, start).unwrap();
    backup::record_first_sync(&vault, start + 5 * DAY).unwrap();
    assert_eq!(json(&app_receipt(&vault))["first_sync_ms"], start);
    assert!(!backup::cleanup_expired(&vault, start + RETENTION_MS - 1).unwrap());
    assert!(root.exists());

    assert!(backup::cleanup_expired(&vault, start + RETENTION_MS).unwrap());
    assert!(!root.exists());
    assert_eq!(fs::read(vault.join("n.md")).unwrap(), b"mine");
    assert!(
        other_root.join("vault/n.md").is_file(),
        "another vault's copy stays"
    );
    assert_eq!(backup::standing(&vault), Standing::Gone);
    assert!(backup::read_path(&vault).is_none());
    // Switching sync off and on again does not copy a synced vault again.
    backup::prepare(&vault).unwrap();
    assert!(ulid_dirs(&backup::key_dir(&vault, false).unwrap()).is_empty());
    assert!(!backup::cleanup_expired(&vault, start + 200 * DAY).unwrap());
    purge(&vault);
    purge(&other);
}

#[test]
fn a_legacy_copy_is_never_removed_automatically() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"mine");
    let legacy = make_legacy(&vault);
    backup::record_first_sync(&vault, 1).unwrap();
    assert!(!backup::cleanup_expired(&vault, 1 + 400 * DAY).unwrap());
    assert!(legacy.join("manifest.json").is_file());
    purge(&vault);
}

#[test]
fn deleting_a_copy_removes_only_that_copy_and_records_it() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"mine");
    let root = PathBuf::from(backup::ensure(&vault).unwrap());
    let id = root.file_name().unwrap().to_str().unwrap().to_owned();
    // Strange ids never reach the file system.
    for bad in ["..", "../x", "", "not-a-ulid", &format!("{id}/vault")] {
        assert!(backup::delete(&vault, bad, 5).is_err(), "{bad}");
    }
    assert!(root.exists());
    backup::record_first_sync(&vault, 1).unwrap();
    backup::delete(&vault, &id, 5).unwrap();
    assert!(!root.exists());
    assert_eq!(fs::read(vault.join("n.md")).unwrap(), b"mine");
    assert_eq!(backup::standing(&vault), Standing::Gone);
    assert!(app_receipt(&vault).is_file());
    purge(&vault);
}

#[test]
fn a_copy_deleted_before_the_first_sync_is_made_again_when_sync_is_switched_on() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"mine");
    let root = PathBuf::from(backup::ensure(&vault).unwrap());
    let id = root.file_name().unwrap().to_str().unwrap().to_owned();
    backup::delete(&vault, &id, 5).unwrap();
    assert_eq!(backup::standing(&vault), Standing::Never);
    backup::prepare(&vault).unwrap();
    assert!(backup::read_path(&vault).is_some());
    purge(&vault);
}

#[test]
fn only_the_legacy_copy_named_by_the_receipt_can_be_deleted() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"mine");
    let legacy = make_legacy(&vault);
    let stranger = legacy
        .parent()
        .unwrap()
        .join(ulid::Ulid::generate().to_string());
    fs::create_dir_all(stranger.join("vault")).unwrap();
    fs::write(stranger.join("vault/keep.md"), b"someone else's").unwrap();
    let stranger_id = stranger.file_name().unwrap().to_str().unwrap().to_owned();
    assert!(backup::delete(&vault, &stranger_id, 5).is_err());
    assert!(stranger.join("vault/keep.md").is_file());

    let id = legacy.file_name().unwrap().to_str().unwrap().to_owned();
    backup::delete(&vault, &id, 5).unwrap();
    assert!(!legacy.exists());
    assert!(stranger.join("vault/keep.md").is_file());
    assert_eq!(fs::read(vault.join("n.md")).unwrap(), b"mine");
    purge(&vault);
}

#[test]
fn the_catalog_lists_the_copy_with_its_origin_and_expiry() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"mine");
    backup::ensure(&vault).unwrap();
    backup::record_first_sync(&vault, 1_000).unwrap();
    let list = restore::list(&vault).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].origin, restore::BackupOrigin::AppData);
    assert!(list[0].deletable);
    assert_eq!(list[0].expires_ms, Some(1_000 + RETENTION_MS));
    purge(&vault);
}

/// An old copy beside the vault that a newer app-data copy has replaced (sync switched on again)
/// is still this vault's own: the receipt inside the vault names it, so it can be shown and
/// deleted. Only it goes; the new copy and the notes stay.
#[test]
fn a_legacy_copy_replaced_by_an_app_data_copy_can_still_be_deleted() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"mine");
    let legacy = make_legacy(&vault);
    let aside = temp.path().join("aside");
    fs::rename(&legacy, &aside).unwrap();
    backup::prepare(&vault).unwrap();
    let fresh = PathBuf::from(backup::read_path(&vault).expect("a new copy in app data"));
    fs::rename(&aside, &legacy).unwrap();

    let id = legacy.file_name().unwrap().to_str().unwrap().to_owned();
    let listed = restore::list(&vault).unwrap();
    let old = listed
        .iter()
        .find(|item| item.id == id)
        .expect("the old copy is listed");
    assert!(old.deletable, "the old copy can be shown and deleted");

    backup::delete(&vault, &id, 5).unwrap();
    assert!(!legacy.exists());
    assert!(
        fresh.join("manifest.json").is_file(),
        "the new copy is untouched"
    );
    assert_eq!(backup::read_path(&vault).as_deref(), fresh.to_str());
    assert_eq!(fs::read(vault.join("n.md")).unwrap(), b"mine");
    purge(&vault);
}

/// Each deletion removes exactly the copy it names (owner report, 2026-11-20): deleting the new
/// app-data copy leaves the old copy beside the vault, deleting a leftover of an interrupted copy
/// leaves the current one, and deleting the old copy leaves both others.
#[test]
fn deleting_one_copy_never_removes_another() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "Notes", b"mine");
    let legacy = make_legacy(&vault);
    let aside = temp.path().join("aside");
    fs::rename(&legacy, &aside).unwrap();
    backup::prepare(&vault).unwrap();
    let fresh = PathBuf::from(backup::read_path(&vault).expect("a new copy in app data"));
    fs::rename(&aside, &legacy).unwrap();
    // A copy that was interrupted: its folder stays with the INCOMPLETE marker.
    let key = backup::key_dir(&vault, false).unwrap();
    let leftover_id = ulid::Ulid::generate().to_string();
    let leftover = key.join(&leftover_id);
    fs::create_dir_all(leftover.join("vault")).unwrap();
    fs::write(
        leftover.join("INCOMPLETE"),
        b"Incomplete backup; do not restore.",
    )
    .unwrap();

    let ids: Vec<String> = restore::list(&vault)
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect();
    assert!(ids.contains(&leftover_id), "the leftover is listed");

    backup::delete(&vault, &leftover_id, 5).unwrap();
    assert!(!leftover.exists());
    assert!(
        fresh.join("manifest.json").is_file(),
        "the current copy stays"
    );
    assert!(legacy.is_dir(), "the old copy stays");
    assert_eq!(backup::read_path(&vault).as_deref(), fresh.to_str());

    let fresh_id = fresh.file_name().unwrap().to_str().unwrap().to_owned();
    backup::delete(&vault, &fresh_id, 6).unwrap();
    assert!(!fresh.exists());
    assert!(legacy.is_dir(), "deleting the new copy leaves the old one");

    let legacy_id = legacy.file_name().unwrap().to_str().unwrap().to_owned();
    backup::delete(&vault, &legacy_id, 7).unwrap();
    assert!(!legacy.exists());
    assert_eq!(fs::read(vault.join("n.md")).unwrap(), b"mine");
    purge(&vault);
}
