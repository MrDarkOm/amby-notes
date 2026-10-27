//! Frozen tests-first contract for the full external backup required before first sync.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use super::backup;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let unique = ulid::Ulid::generate();
        let path = std::env::temp_dir().join(format!("amby-sync-backup-test-{unique}"));
        fs::create_dir_all(&path).unwrap();
        Self(path)
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

fn vault_at(root: &Path, name: &str) -> PathBuf {
    let path = root.join(name);
    fs::create_dir_all(&path).unwrap();
    path
}

fn receipt_path(vault: &Path) -> PathBuf {
    vault.join(".amby/sync/pre-sync-backup.json")
}

fn json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn backup_copies_notes_attachments_empty_directories_and_durable_unknown_amby_data() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "My vault");
    fs::create_dir_all(vault.join("Notes/Empty")).unwrap();
    fs::write(
        vault.join("Notes/hello.md"),
        b"\xef\xbb\xbf# note\r\nbody\r\n",
    )
    .unwrap();
    fs::create_dir_all(vault.join("assets")).unwrap();
    fs::write(vault.join("assets/image.bin"), [0, 1, 255, 17]).unwrap();
    fs::create_dir_all(vault.join(".amby/custom/durable")).unwrap();
    fs::write(
        vault.join(".amby/custom/durable/opaque.bin"),
        b"keep unknown sidecars",
    )
    .unwrap();
    fs::write(vault.join(".amby/properties.json"), b"{\"v\":1}").unwrap();

    let backup_root = backup::ensure(&vault).unwrap();
    let backup_root = PathBuf::from(backup_root);
    let copy = backup_root.join("vault");

    assert_eq!(
        fs::read(copy.join("Notes/hello.md")).unwrap(),
        b"\xef\xbb\xbf# note\r\nbody\r\n"
    );
    assert_eq!(
        fs::read(copy.join("assets/image.bin")).unwrap(),
        [0, 1, 255, 17]
    );
    assert!(
        copy.join("Notes/Empty").is_dir(),
        "empty directories are part of the copy"
    );
    assert_eq!(
        fs::read(copy.join(".amby/custom/durable/opaque.bin")).unwrap(),
        b"keep unknown sidecars"
    );
    assert_eq!(
        fs::read(copy.join(".amby/properties.json")).unwrap(),
        b"{\"v\":1}"
    );
    assert!(!copy.join(".amby/sync/pre-sync-backup.json").exists());

    let manifest = json(&backup_root.join("manifest.json"));
    assert_eq!(
        manifest.get("complete").and_then(Value::as_bool),
        Some(true)
    );
    assert!(!backup_root.join("INCOMPLETE").exists());
    assert!(backup_root.join("RESTORE.txt").is_file());
    assert_eq!(
        backup::read_path(&vault).as_deref(),
        Some(backup_root.to_str().unwrap())
    );
}

#[test]
fn online_sqlite_backup_keeps_committed_wal_data_for_both_known_databases() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "wal-vault");
    fs::create_dir_all(vault.join(".amby/sync")).unwrap();

    let db_paths = [
        vault.join(".amby/notes.db"),
        vault.join(".amby/sync/state.db"),
    ];
    let mut live_connections = Vec::new();
    for (index, path) in db_paths.iter().enumerate() {
        let connection = Connection::open(path).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        connection
            .execute_batch("CREATE TABLE durable (value TEXT NOT NULL);")
            .unwrap();
        connection
            .execute(
                "INSERT INTO durable(value) VALUES (?1)",
                [format!("logical-{index}")],
            )
            .unwrap();
        live_connections.push(connection);
    }
    assert!(db_paths
        .iter()
        .all(|path| path.with_extension("db-wal").is_file()));

    let backup_root = PathBuf::from(backup::ensure(&vault).unwrap());
    for (index, source) in db_paths.iter().enumerate() {
        let copied = Connection::open(
            backup_root
                .join("vault")
                .join(source.strip_prefix(&vault).unwrap()),
        )
        .unwrap();
        let value: String = copied
            .query_row("SELECT value FROM durable", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, format!("logical-{index}"));
    }
    drop(live_connections);
}

#[test]
fn symlinked_or_special_source_entries_fail_without_publishing_receipt_or_backup() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "unsafe-vault");
    fs::write(vault.join("note.md"), b"note").unwrap();
    let outside = temp.path().join("outside.bin");
    fs::write(&outside, b"outside user data").unwrap();

    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, vault.join("linked.bin")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&outside, vault.join("linked.bin")).unwrap();

    let result = backup::ensure(&vault);
    assert_eq!(result.unwrap_err().code, "backup_unsafe_entry");
    assert!(
        !receipt_path(&vault).exists(),
        "a partial copy has no receipt"
    );
    assert!(backup::read_path(&vault).is_none());
    let backup_container = temp.path().join("unsafe-vault.amby-backups");
    assert!(
        !backup_container.exists() || fs::read_dir(backup_container).unwrap().next().is_none(),
        "failed preflight must not publish a backup directory"
    );
}

#[cfg(unix)]
#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "APFS rejects non-UTF-8 names before the backup can inspect them (EILSEQ)"
)]
fn non_utf8_source_names_fail_closed_without_receipt() {
    use std::os::unix::ffi::OsStrExt;

    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "non-utf8-vault");
    let invalid_name = std::ffi::OsStr::from_bytes(b"invalid-\xff.md");
    if let Err(error) = fs::write(vault.join(invalid_name), b"user data") {
        // Some sandboxed filesystems reject non-UTF-8 paths at creation time.
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            return;
        }
        panic!("could not create the non-UTF-8 fixture: {error}");
    }

    assert_eq!(
        backup::ensure(&vault).unwrap_err().code,
        "backup_unsafe_entry"
    );
    assert!(!receipt_path(&vault).exists());
}

#[test]
fn repeated_ensure_reuses_a_valid_backup_and_preserves_its_bytes() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "reuse-vault");
    fs::write(vault.join("n.md"), b"original").unwrap();

    let first = backup::ensure(&vault).unwrap();
    fs::write(vault.join("n.md"), b"changed after backup").unwrap();
    let second = backup::ensure(&vault).unwrap();

    assert_eq!(first, second);
    assert_eq!(
        fs::read(PathBuf::from(first).join("vault/n.md")).unwrap(),
        b"original"
    );
}

#[test]
fn a_missing_or_corrupt_published_copy_is_rejected_without_replacing_its_receipt() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "damaged-vault");
    fs::write(vault.join("n.md"), b"original").unwrap();

    let backup_root = PathBuf::from(backup::ensure(&vault).unwrap());
    let receipt_before = fs::read(receipt_path(&vault)).unwrap();
    fs::write(backup_root.join("vault/n.md"), b"corrupt").unwrap();
    assert!(
        backup::ensure(&vault).is_err(),
        "do not bless a damaged backup as complete"
    );
    assert_eq!(fs::read(receipt_path(&vault)).unwrap(), receipt_before);

    fs::remove_dir_all(&backup_root).unwrap();
    assert!(
        backup::ensure(&vault).is_err(),
        "do not silently replace a missing backup"
    );
    assert_eq!(fs::read(receipt_path(&vault)).unwrap(), receipt_before);
}

#[test]
fn copied_vault_with_a_different_canonical_path_gets_its_own_backup() {
    let temp = TestDir::new();
    let original = vault_at(temp.path(), "original-vault");
    fs::write(original.join("n.md"), b"same content").unwrap();
    let first = backup::ensure(&original).unwrap();

    let copied = vault_at(temp.path(), "copied-vault");
    fs::create_dir_all(copied.join(".amby/sync")).unwrap();
    fs::write(copied.join("n.md"), b"same content").unwrap();
    fs::copy(receipt_path(&original), receipt_path(&copied)).unwrap();

    let second = backup::ensure(&copied).unwrap();
    assert_ne!(first, second);
    assert_eq!(
        fs::read(PathBuf::from(second).join("vault/n.md")).unwrap(),
        b"same content"
    );
}

#[test]
fn destination_overlap_and_existing_non_directory_fail_without_overwrite() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "overlap-vault");
    fs::write(vault.join("n.md"), b"note").unwrap();

    assert_eq!(
        backup::create_at(&vault, &vault).unwrap_err().code,
        "backup_invalid"
    );
    assert!(!receipt_path(&vault).exists());

    let blocked_parent = temp.path().join("parent-file");
    fs::write(&blocked_parent, b"do not replace").unwrap();
    let untouched = fs::read(&blocked_parent).unwrap();
    assert!(backup::create_at(&vault, &blocked_parent).is_err());
    assert_eq!(fs::read(&blocked_parent).unwrap(), untouched);
    fs::remove_file(blocked_parent).unwrap();

    #[cfg(unix)]
    {
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let backup_container = temp.path().join("overlap-vault.amby-backups");
        std::os::unix::fs::symlink(&outside, &backup_container).unwrap();
        assert!(backup::create_at(&vault, temp.path()).is_err());
        assert!(fs::read_dir(outside).unwrap().next().is_none());
    }
}

#[test]
fn a_failed_creation_does_not_leave_a_complete_marker_or_receipt() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "unwritable-vault");
    fs::write(vault.join("n.md"), b"note").unwrap();

    let blocked_parent = temp.path().join("occupied-parent");
    fs::write(&blocked_parent, b"occupied").unwrap();
    let result = backup::create_at(&vault, &blocked_parent);
    assert_eq!(result.unwrap_err().code, "backup_failed");
    assert!(!receipt_path(&vault).exists());
    let partials = walkdir::WalkDir::new(temp.path())
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".incomplete-"))
        .count();
    assert_eq!(
        partials, 0,
        "a failed create must not leave a reusable staging directory"
    );
    fs::remove_file(blocked_parent).unwrap();
}

#[test]
fn receipt_path_is_returned_only_when_receipt_points_to_complete_backup() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "receipt-vault");
    fs::write(vault.join("n.md"), b"note").unwrap();
    assert!(backup::read_path(&vault).is_none());

    let backup_root = PathBuf::from(backup::ensure(&vault).unwrap());
    let receipt = json(&receipt_path(&vault));
    assert_eq!(receipt.get("version").and_then(Value::as_u64), Some(1));
    assert_eq!(
        receipt.get("source_canonical").and_then(Value::as_str),
        Some(vault.canonicalize().unwrap().to_str().unwrap())
    );
    assert_eq!(
        receipt.get("backup_root").and_then(Value::as_str),
        Some(backup_root.to_str().unwrap())
    );
    assert!(backup_root.join("manifest.json").is_file());
    assert_eq!(
        backup::read_path(&vault).as_deref(),
        Some(backup_root.to_str().unwrap())
    );

    fs::remove_file(backup_root.join("manifest.json")).unwrap();
    assert!(
        backup::read_path(&vault).is_none(),
        "malformed/incomplete receipt targets are hidden"
    );
}

#[test]
fn changing_a_source_during_copy_never_publishes_a_complete_backup() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "changing");
    fs::write(vault.join("n.md"), b"before").unwrap();
    let result = backup::create_with_hook(&vault, temp.path(), || {
        fs::write(vault.join("n.md"), b"after").unwrap();
        Ok(())
    });
    assert_eq!(result.unwrap_err().code, "backup_changed");
    assert!(!receipt_path(&vault).exists());
    assert_eq!(fs::read(vault.join("n.md")).unwrap(), b"after");
    assert!(backup::read_path(&vault).is_none());
}

#[test]
fn a_mid_copy_failure_preserves_the_source_and_a_retry_can_finish() {
    let temp = TestDir::new();
    let vault = vault_at(temp.path(), "interrupted");
    fs::write(vault.join("n.md"), b"original").unwrap();
    let result = backup::create_with_hook(&vault, temp.path(), || {
        Err(super::types::SyncError::new("backup_failed"))
    });
    assert_eq!(result.unwrap_err().code, "backup_failed");
    assert!(!receipt_path(&vault).exists());
    assert_eq!(fs::read(vault.join("n.md")).unwrap(), b"original");
    assert_eq!(
        walkdir::WalkDir::new(temp.path())
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_name() == "manifest.json")
            .count(),
        0
    );
    let root = backup::ensure(&vault).unwrap();
    assert_eq!(
        fs::read(PathBuf::from(root).join("vault/n.md")).unwrap(),
        b"original"
    );
}
