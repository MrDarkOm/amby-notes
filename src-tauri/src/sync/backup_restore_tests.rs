use super::*;
struct TestDir(PathBuf);
impl TestDir {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn tempdir() -> Result<TestDir, std::io::Error> {
    let path = std::env::temp_dir().join(format!("amby-restore-test-{}", ulid::Ulid::generate()));
    fs::create_dir(&path)?;
    Ok(TestDir(path.canonicalize()?))
}
fn setup() -> (TestDir, PathBuf, String) {
    let temp = tempdir().unwrap();
    let vault = temp.path().join("Notes");
    fs::create_dir_all(vault.join(".amby/sync")).unwrap();
    fs::create_dir_all(vault.join("empty")).unwrap();
    fs::write(
        vault.join("note.md"),
        b"\xef\xbb\xbf---\r\nother-app: keep\r\n---\r\nText\r\n",
    )
    .unwrap();
    fs::write(vault.join(".amby/sync/unknown.json"), b"durable sync state").unwrap();
    fs::write(vault.join(".amby/properties.json"), b"unknown sidecar").unwrap();
    let root = super::super::ensure(&vault).unwrap();
    let key = Path::new(&root)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    (temp, vault.canonicalize().unwrap(), key)
}
#[test]
fn lists_metadata_then_verifies_and_detects_damage_without_changing_the_backup() {
    let (_t, vault, key) = setup();
    let items = list(&vault).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, BackupCondition::Unchecked);
    assert_eq!(items[0].files, 3);
    assert!(items[0].bytes > 0);
    assert_eq!(
        verify(&vault, &key).unwrap().status,
        BackupCondition::Verified
    );
    let root = root_for(&vault, &key).unwrap();
    fs::write(root.join("vault/note.md"), b"corrupt").unwrap();
    assert!(verify(&vault, &key).is_err());
    assert_eq!(fs::read(root.join("vault/note.md")).unwrap(), b"corrupt");
}
#[test]
fn restores_bytes_and_unknown_sidecars_but_cannot_resume_old_sync() {
    let (t, vault, key) = setup();
    let original = inventory(&vault, false).unwrap();
    let backup = inventory(&root_for(&vault, &key).unwrap().join("vault"), false).unwrap();
    let op = ulid::Ulid::generate().to_string();
    let result = restore(&vault, &key, t.path(), &op).unwrap();
    let output = Path::new(&result.path);
    assert_eq!(
        fs::read(output.join("note.md")).unwrap(),
        fs::read(vault.join("note.md")).unwrap()
    );
    assert_eq!(
        fs::read(output.join(".amby/properties.json")).unwrap(),
        b"unknown sidecar"
    );
    assert!(output.join("empty").is_dir());
    assert!(!output.join(".amby/sync").exists());
    let preserved = fs::read_dir(output.join(".amby"))
        .unwrap()
        .flatten()
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("sync-before-restore-")
        })
        .unwrap();
    assert_eq!(
        fs::read(preserved.path().join("unknown.json")).unwrap(),
        b"durable sync state"
    );
    assert_eq!(inventory(&vault, false).unwrap(), original);
    assert_eq!(
        inventory(&root_for(&vault, &key).unwrap().join("vault"), false).unwrap(),
        backup
    );
    assert_eq!(
        restore(&vault, &key, t.path(), &op).unwrap().path,
        result.path
    );
    fs::write(output.join("note.md"), b"edited after restore").unwrap();
    assert_eq!(
        restore(&vault, &key, t.path(), &op).unwrap_err().code,
        "backup_restore_changed"
    );
    assert_eq!(
        fs::read(output.join("note.md")).unwrap(),
        b"edited after restore"
    );
}
#[test]
fn refuses_corrupt_copy_existing_destinations_and_path_traversal() {
    let (t, vault, key) = setup();
    assert!(verify(&vault, "../Notes").is_err());
    assert!(restore(&vault, &key, &vault, &ulid::Ulid::generate().to_string()).is_err());
    let op = ulid::Ulid::generate().to_string();
    let collision = t.path().join(format!("Notes-restored-{op}"));
    fs::create_dir(&collision).unwrap();
    fs::write(collision.join("keep"), b"mine").unwrap();
    assert!(restore(&vault, &key, t.path(), &op).is_err());
    assert_eq!(fs::read(collision.join("keep")).unwrap(), b"mine");
    let root = root_for(&vault, &key).unwrap();
    fs::write(root.join("vault/note.md"), b"broken").unwrap();
    assert!(restore(&vault, &key, t.path(), &ulid::Ulid::generate().to_string()).is_err());
}
#[test]
fn a_failure_keeps_a_versioned_incomplete_journal_and_never_reports_success() {
    let (t, vault, key) = setup();
    let op = ulid::Ulid::generate().to_string();
    assert!(restore_with_hook(&vault, &key, t.path(), &op, || Err(err("backup_failed"))).is_err());
    let root = t.path().join(format!("Notes-restored-{op}"));
    assert!(root.join("INCOMPLETE").exists());
    let journal: RestoreJournal =
        serde_json::from_slice(&fs::read(root.join("operation.json")).unwrap()).unwrap();
    assert_eq!(journal.version, 1);
    assert_eq!(journal.phase, "failed");
    assert_eq!(
        restore(&vault, &key, t.path(), &op).unwrap_err().code,
        "backup_restore_incomplete"
    );
    assert!(vault.join("note.md").is_file());
}
#[cfg(unix)]
#[test]
fn rejects_symlinks_in_backups_and_destinations() {
    use std::os::unix::fs::symlink;
    let (t, vault, key) = setup();
    let parent_link = t.path().join("link");
    symlink(t.path(), &parent_link).unwrap();
    assert!(restore(
        &vault,
        &key,
        &parent_link,
        &ulid::Ulid::generate().to_string()
    )
    .is_err());
    let root = root_for(&vault, &key).unwrap();
    fs::remove_file(root.join("vault/note.md")).unwrap();
    symlink(vault.join("note.md"), root.join("vault/note.md")).unwrap();
    assert!(verify(&vault, &key).is_err());
}

#[test]
fn missing_and_incomplete_copies_are_visible_but_not_restorable() {
    let (_t, vault, key) = setup();
    let root = root_for(&vault, &key).unwrap();
    fs::write(root.join("INCOMPLETE"), b"unfinished").unwrap();
    assert_eq!(list(&vault).unwrap()[0].status, BackupCondition::Incomplete);
    assert!(verify(&vault, &key).is_err());
    fs::remove_dir_all(&root).unwrap();
    assert_eq!(list(&vault).unwrap()[0].status, BackupCondition::Missing);
}
#[test]
fn a_backup_changed_during_copy_cannot_be_completed() {
    let (t, vault, key) = setup();
    let root = root_for(&vault, &key).unwrap();
    let op = ulid::Ulid::generate().to_string();
    assert!(restore_with_hook(&vault, &key, t.path(), &op, || {
        fs::write(root.join("vault/note.md"), b"changed").unwrap();
        Ok(())
    })
    .is_err());
    assert!(t
        .path()
        .join(format!("Notes-restored-{op}/INCOMPLETE"))
        .exists());
    assert_ne!(fs::read(vault.join("note.md")).unwrap(), b"changed");
}
#[test]
fn a_tampered_completion_journal_cannot_bless_changed_files() {
    let (t, vault, key) = setup();
    let op = ulid::Ulid::generate().to_string();
    let restored = restore(&vault, &key, t.path(), &op).unwrap();
    let output = Path::new(&restored.path);
    fs::write(output.join("note.md"), b"changed").unwrap();
    let journal_path = output.parent().unwrap().join("operation.json");
    let mut journal: RestoreJournal =
        serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    journal.entries = inventory(output, false).unwrap();
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    assert_eq!(
        restore(&vault, &key, t.path(), &op).unwrap_err().code,
        "backup_invalid"
    );
    assert_eq!(fs::read(output.join("note.md")).unwrap(), b"changed");
}
#[test]
fn refuses_manifests_from_another_vault_or_with_traversal_paths() {
    let (t, vault, key) = setup();
    let root = root_for(&vault, &key).unwrap();
    // Remove only the test receipt to exercise manifest validation independently of its hash.
    fs::remove_file(vault.join(super::super::RECEIPT)).unwrap();
    let manifest_path = root.join("manifest.json");
    let original = fs::read(&manifest_path).unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(&original).unwrap();
    manifest["source_canonical"] = serde_json::json!("/another-vault");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(verify(&vault, &key).is_err());
    let mut manifest: serde_json::Value = serde_json::from_slice(&original).unwrap();
    manifest["entries"][0]["path"] = serde_json::json!("../outside");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(restore(&vault, &key, t.path(), &ulid::Ulid::generate().to_string()).is_err());
    assert!(!t.path().join("outside").exists());
}
