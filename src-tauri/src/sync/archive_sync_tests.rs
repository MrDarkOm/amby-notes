//! The application side of appendix К in the synchronisation: К1 (the archive folder is walked
//! like a synchronised folder) and К3 (a deletion that came from another device goes to the
//! system trash, and on its refusal to `.amby/trash/`, never to nothing). Written before the code
//! (section 6): red until `vault_fs.rs` is changed. The system trash is a fake port, so no test
//! touches the real trash.

use std::path::PathBuf;
use std::sync::Arc;

use amby_sync_core::engine::rules::is_excluded_path;
use amby_sync_core::engine::{FsError, LocalFs, TrashReason};

use super::vault_fs::{is_not_entered, VaultFs};
use crate::archive::test_support::{FakeTrash, Vault};
use crate::recycle_bin;

fn fs_with(vault: &Vault, trash: &Arc<FakeTrash>) -> VaultFs {
    VaultFs::with_system_trash(vault.root.clone(), trash.clone())
}

// ----- К1: the archive is a synchronised folder of `.amby/` -----

#[test]
fn k1_the_walk_enters_the_archive_and_its_records() {
    // К1, К8: `.amby/archive/` and `.amby/archive/.meta/` are synchronised like ordinary files, so
    // the walk of the application must list them (6 Nov 2026: a folder the walk skipped never left
    // the computer).
    let vault = Vault::new();
    vault.put(".amby/archive/Notes/a.md", b"archived");
    vault.put(
        ".amby/archive/.meta/rec.json",
        br#"{"path":"Notes/a.md","archivedAtMs":1}"#,
    );
    vault.put(".amby/trash/01/x.md", b"service");
    let listing = VaultFs::new(vault.root.clone()).list().unwrap();
    let paths: Vec<&str> = listing.entries.iter().map(|e| e.path.as_str()).collect();
    for kept in [
        ".amby/archive",
        ".amby/archive/Notes",
        ".amby/archive/Notes/a.md",
        ".amby/archive/.meta",
        ".amby/archive/.meta/rec.json",
    ] {
        assert!(paths.contains(&kept), "{kept} missing from {paths:?}");
    }
    assert!(
        !paths.contains(&".amby/trash/01/x.md"),
        "К5: the service trash is still not synchronised"
    );
}

#[test]
fn k1_the_walk_and_the_rules_of_the_core_agree_about_the_archive() {
    // Р4 (the guard of `vault_fs_tests`): a kept folder that is not entered is a silent loss.
    assert!(!is_excluded_path(".amby/archive/Notes/a.md"));
    assert!(!is_not_entered(".amby", "archive"));
    assert!(is_excluded_path(".amby/trash/x.md"));
    assert!(is_not_entered(".amby", "trash"));
}

// ----- К3: a deletion from another device -----

#[test]
fn k3_a_remote_deletion_goes_to_the_system_trash_and_not_to_the_vault_trash() {
    let vault = Vault::new();
    vault.put("Notes/a.md", b"deleted elsewhere");
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    fs.move_to_trash("Notes/a.md", TrashReason::RemoteDeletion)
        .unwrap();
    assert_eq!(trash.asked(), vec![vault.path("Notes/a.md")]);
    assert!(!vault.exists("Notes/a.md"));
    assert_eq!(
        trash.held().values().next().map(Vec::as_slice),
        Some(&b"deleted elsewhere"[..])
    );
    assert!(
        recycle_bin::list(&vault.root).is_empty(),
        "К3: not `.amby/trash/`"
    );
    assert!(!vault.exists(".amby/trash"));
}

#[test]
fn k3_exactly_the_named_file_goes_not_its_bundle() {
    // Р8 stays: the engine deletes what the server deleted.
    let vault = Vault::new();
    vault.put("Proj/Proj.md", b"main");
    vault.put("Proj/other.md", b"other");
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    fs.move_to_trash("Proj/Proj.md", TrashReason::RemoteDeletion)
        .unwrap();
    assert_eq!(trash.asked(), vec![vault.path("Proj/Proj.md")]);
    assert_eq!(vault.read("Proj/other.md").as_deref(), Some(&b"other"[..]));
}

#[test]
fn k3_a_deleted_folder_goes_to_the_system_trash_as_a_folder() {
    let vault = Vault::new();
    vault.put("Old/a.md", b"a");
    vault.put("Old/sub/b.md", b"b");
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    fs.move_to_trash("Old", TrashReason::RemoteDeletion)
        .unwrap();
    assert_eq!(trash.asked(), vec![vault.path("Old")]);
    assert!(!vault.exists("Old"));
    assert!(recycle_bin::list(&vault.root).is_empty());
}

#[test]
fn k3_a_refusing_system_trash_falls_back_to_the_service_trash_and_destroys_nothing() {
    // К3: "никогда не стирается насовсем": the copy goes to `.amby/trash/` and can be restored.
    let vault = Vault::new();
    vault.put("Notes/a.md", b"must survive");
    let trash = Arc::new(FakeTrash::refusing());
    let mut fs = fs_with(&vault, &trash);
    fs.move_to_trash("Notes/a.md", TrashReason::RemoteDeletion)
        .unwrap();
    assert_eq!(
        trash.asked(),
        vec![vault.path("Notes/a.md")],
        "the system trash is tried first"
    );
    assert!(!vault.exists("Notes/a.md"));
    let entries = recycle_bin::list(&vault.root);
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].original_path, "Notes/a.md");
    recycle_bin::restore(&vault.root, &entries[0].id).unwrap();
    assert_eq!(
        vault.read("Notes/a.md").as_deref(),
        Some(&b"must survive"[..])
    );
}

#[test]
fn k3_the_fallback_is_decided_for_each_item() {
    // A refusal for one file does not send the next one to the service trash.
    struct RefuseFirst {
        inner: FakeTrash,
        calls: std::sync::atomic::AtomicUsize,
    }
    impl crate::system_recycle_bin::SystemTrash for RefuseFirst {
        fn trash(&self, path: &std::path::Path) -> Result<(), String> {
            if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return Err("refused once".into());
            }
            self.inner.trash(path)
        }
    }
    let vault = Vault::new();
    vault.put("a.md", b"first");
    vault.put("b.md", b"second");
    let port = Arc::new(RefuseFirst {
        inner: FakeTrash::taking(),
        calls: Default::default(),
    });
    let mut fs = VaultFs::with_system_trash(vault.root.clone(), port.clone());
    fs.move_to_trash("a.md", TrashReason::RemoteDeletion)
        .unwrap();
    fs.move_to_trash("b.md", TrashReason::RemoteDeletion)
        .unwrap();
    let in_service: Vec<String> = recycle_bin::list(&vault.root)
        .into_iter()
        .map(|e| e.original_path)
        .collect();
    assert_eq!(in_service, vec!["a.md"]);
    assert_eq!(
        port.inner.held().values().next().map(Vec::as_slice),
        Some(&b"second"[..])
    );
}

#[test]
fn k3_a_missing_file_is_not_found_and_the_system_trash_is_not_asked() {
    let vault = Vault::new();
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    assert!(matches!(
        fs.move_to_trash("ghost.md", TrashReason::RemoteDeletion),
        Err(FsError::NotFound(_))
    ));
    assert!(trash.asked().is_empty());
}

#[test]
fn k3_a_path_that_leads_out_of_the_vault_is_refused_before_any_trash_is_asked() {
    let vault = Vault::new();
    let outside: PathBuf = vault.root.parent().unwrap().join("amby-k3-outside.md");
    std::fs::write(&outside, b"not in the vault").unwrap();
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    assert!(fs
        .move_to_trash("../amby-k3-outside.md", TrashReason::RemoteDeletion)
        .is_err());
    assert!(trash.asked().is_empty());
    assert!(outside.exists());
    std::fs::remove_file(outside).unwrap();
}

#[test]
fn k11b_a_remote_deletion_of_a_service_path_goes_to_the_service_trash_not_the_system_trash() {
    // К11 (б): К3 is for the files of the person; `.amby/…` stays in `.amby/trash/`.
    let vault = Vault::new();
    vault.put(".amby/properties/prop_1.jsonl", b"{}");
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    fs.move_to_trash(".amby/properties/prop_1.jsonl", TrashReason::RemoteDeletion)
        .unwrap();
    assert!(trash.asked().is_empty(), "the system trash is not asked");
    assert!(!vault.exists(".amby/properties/prop_1.jsonl"));
    let entries = recycle_bin::list(&vault.root);
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].original_path, ".amby/properties/prop_1.jsonl");
}

// ----- К3а: a whole super note goes to the trash as one folder -----

fn super_note(vault: &Vault) -> Vec<String> {
    let files = [
        "Note/Note.md",
        "Note/Note.canvas",
        "Note/ambd.json",
        "Note/.ambd/views/01M2D4.json",
    ];
    for file in files {
        vault.put(file, file.as_bytes());
    }
    files.iter().map(|file| (*file).to_string()).collect()
}

#[test]
fn k3a_a_folder_of_exactly_the_deleted_files_goes_to_the_system_trash_as_one_item() {
    let vault = Vault::new();
    let files = super_note(&vault);
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    let moved = fs
        .move_dir_to_trash("Note", &files, TrashReason::RemoteDeletion)
        .unwrap();
    assert!(moved);
    assert_eq!(
        trash.asked(),
        vec![vault.path("Note")],
        "the folder, not each file"
    );
    assert!(!vault.exists("Note"));
    assert!(
        recycle_bin::list(&vault.root).is_empty(),
        "К3: not `.amby/trash/`"
    );
}

#[test]
fn k3a_a_folder_that_holds_anything_else_is_not_moved() {
    let vault = Vault::new();
    let files = super_note(&vault);
    vault.put("Note/mine.md", b"my own text");
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    let moved = fs
        .move_dir_to_trash("Note", &files, TrashReason::RemoteDeletion)
        .unwrap();
    assert!(!moved, "the caller goes on per file");
    assert!(trash.asked().is_empty());
    for file in &files {
        assert!(vault.exists(file), "{file} is untouched");
    }
    assert_eq!(
        vault.read("Note/mine.md").as_deref(),
        Some(&b"my own text"[..])
    );
}

#[test]
fn k3a_a_hidden_file_of_the_system_in_the_folder_is_not_moved_with_it() {
    let vault = Vault::new();
    let files = super_note(&vault);
    vault.put("Note/.DS_Store", b"finder");
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    let moved = fs
        .move_dir_to_trash("Note", &files, TrashReason::RemoteDeletion)
        .unwrap();
    assert!(!moved);
    assert!(trash.asked().is_empty());
}

#[test]
fn k3a_a_refusing_system_trash_puts_the_whole_folder_into_the_service_trash() {
    let vault = Vault::new();
    let files = super_note(&vault);
    let trash = Arc::new(FakeTrash::refusing());
    let mut fs = fs_with(&vault, &trash);
    let moved = fs
        .move_dir_to_trash("Note", &files, TrashReason::RemoteDeletion)
        .unwrap();
    assert!(moved);
    assert_eq!(trash.asked(), vec![vault.path("Note")]);
    assert!(!vault.exists("Note"));
    let entries = recycle_bin::list(&vault.root);
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].original_path, "Note");
    recycle_bin::restore(&vault.root, &entries[0].id).unwrap();
    for file in &files {
        assert_eq!(
            vault.read(file).as_deref(),
            Some(file.as_bytes()),
            "{file} came back"
        );
    }
}

#[test]
fn k3a_a_path_outside_the_vault_or_a_service_folder_is_refused_without_moving_anything() {
    let vault = Vault::new();
    vault.put(".amby/archive/a.md", b"service");
    let trash = Arc::new(FakeTrash::taking());
    let mut fs = fs_with(&vault, &trash);
    assert!(fs
        .move_dir_to_trash("../outside", &[], TrashReason::RemoteDeletion)
        .is_err());
    let moved = fs
        .move_dir_to_trash(
            ".amby/archive",
            &[".amby/archive/a.md".to_string()],
            TrashReason::RemoteDeletion,
        )
        .unwrap();
    assert!(!moved, "a service folder is never grouped");
    assert!(vault.exists(".amby/archive/a.md"));
}
