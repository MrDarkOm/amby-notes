//! CORE-03 tails: a note's history follows it when the index sees it under a new path that Amby
//! did not rename itself (a rename that arrived through sync, or one made in Finder). The
//! identity is the `amby-id` the index already holds for the old path.

use super::*;
use crate::history;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use ulid::Ulid;

struct TestVault(PathBuf);

impl TestVault {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("amby-history-follow-{}", Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }

    /// A note with an `amby-id`, indexed, with one saved version.
    fn indexed_note(&self, relative: &str, id: &str) -> rusqlite::Connection {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, source(id, "first")).unwrap();
        let conn = open_connection(&self.0).unwrap();
        load_vault(&conn, &self.0).unwrap();
        history::snapshot_before_write(&self.0, &path, source(id, "second").as_bytes(), "edit")
            .unwrap();
        conn
    }
}

impl Drop for TestVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn source(id: &str, body: &str) -> String {
    format!("---\namby-id: {id}\n---\n{body}")
}

/// The refresh the watcher and the sync apply run: the point update, or the full one.
fn refresh(conn: &rusqlite::Connection, vault: &Path, changed: &[PathBuf]) {
    let changed = changed.iter().cloned().collect::<HashSet<_>>();
    if sync_paths(conn, vault, &changed).unwrap().is_none() {
        sync_vault_with_changes(conn, vault, &changed).unwrap();
    }
}

/// Versions kept for `relative`; a file is put there only to ask when nothing is.
fn versions(vault: &TestVault, relative: &str) -> usize {
    let path = vault.path(relative);
    let existed = path.exists();
    if !existed {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "probe").unwrap();
    }
    let count = history::list_snapshots(&vault.0, &path).unwrap().len();
    if !existed {
        fs::remove_file(&path).unwrap();
    }
    count
}

#[test]
fn a_rename_made_outside_amby_takes_the_history_along() {
    let vault = TestVault::new();
    let id = Ulid::generate().to_string();
    let conn = vault.indexed_note("Ideas.md", &id);
    assert_eq!(versions(&vault, "Ideas.md"), 1);

    fs::rename(vault.path("Ideas.md"), vault.path("Ideas 2026.md")).unwrap();
    // The watcher reports the old path (removed) and the new one (created).
    refresh(
        &conn,
        &vault.0,
        &[vault.path("Ideas.md"), vault.path("Ideas 2026.md")],
    );

    assert_eq!(versions(&vault, "Ideas 2026.md"), 1);
    assert_eq!(versions(&vault, "Ideas.md"), 0);
}

#[test]
fn a_rename_event_that_names_only_the_new_path_takes_the_history_along() {
    let vault = TestVault::new();
    let id = Ulid::generate().to_string();
    let conn = vault.indexed_note("Ideas.md", &id);
    fs::rename(vault.path("Ideas.md"), vault.path("Renamed.md")).unwrap();
    refresh(&conn, &vault.0, &[vault.path("Renamed.md")]);
    assert_eq!(versions(&vault, "Renamed.md"), 1);
    assert_eq!(versions(&vault, "Ideas.md"), 0);
}

#[test]
fn a_rename_that_arrives_through_a_full_scan_takes_the_history_along() {
    let vault = TestVault::new();
    let id = Ulid::generate().to_string();
    let conn = vault.indexed_note("Ideas.md", &id);
    fs::create_dir_all(vault.path("Folder")).unwrap();
    fs::rename(vault.path("Ideas.md"), vault.path("Folder/Ideas.md")).unwrap();
    load_vault(&conn, &vault.0).unwrap();
    assert_eq!(versions(&vault, "Folder/Ideas.md"), 1);
    assert_eq!(versions(&vault, "Ideas.md"), 0);
}

#[test]
fn a_moved_folder_takes_the_history_of_every_note_along() {
    let vault = TestVault::new();
    let (first, second) = (Ulid::generate().to_string(), Ulid::generate().to_string());
    let conn = vault.indexed_note("Folder/a.md", &first);
    fs::write(vault.path("Folder/b.md"), source(&second, "b")).unwrap();
    load_vault(&conn, &vault.0).unwrap();
    history::snapshot_before_write(
        &vault.0,
        &vault.path("Folder/b.md"),
        source(&second, "b2").as_bytes(),
        "edit",
    )
    .unwrap();
    fs::rename(vault.path("Folder"), vault.path("Moved")).unwrap();
    refresh(
        &conn,
        &vault.0,
        &[vault.path("Folder"), vault.path("Moved")],
    );
    assert_eq!(versions(&vault, "Moved/a.md"), 1);
    assert_eq!(versions(&vault, "Moved/b.md"), 1);
    assert_eq!(versions(&vault, "Folder/a.md"), 0);
}

#[test]
fn a_copy_while_the_original_stays_leaves_both_histories_alone() {
    let vault = TestVault::new();
    let id = Ulid::generate().to_string();
    let conn = vault.indexed_note("Ideas.md", &id);
    fs::copy(vault.path("Ideas.md"), vault.path("Copy.md")).unwrap();
    refresh(&conn, &vault.0, &[vault.path("Copy.md")]);
    assert_eq!(versions(&vault, "Ideas.md"), 1);
    assert_eq!(versions(&vault, "Copy.md"), 0);
}

#[test]
fn two_notes_claiming_the_id_of_a_vanished_note_leave_its_history_alone() {
    let vault = TestVault::new();
    let id = Ulid::generate().to_string();
    let conn = vault.indexed_note("Ideas.md", &id);
    let content = fs::read(vault.path("Ideas.md")).unwrap();
    fs::remove_file(vault.path("Ideas.md")).unwrap();
    fs::write(vault.path("One.md"), &content).unwrap();
    fs::write(vault.path("Two.md"), &content).unwrap();
    refresh(
        &conn,
        &vault.0,
        &[
            vault.path("Ideas.md"),
            vault.path("One.md"),
            vault.path("Two.md"),
        ],
    );
    assert_eq!(versions(&vault, "One.md"), 0);
    assert_eq!(versions(&vault, "Two.md"), 0);
    assert_eq!(versions(&vault, "Ideas.md"), 1);
}

#[test]
fn a_destination_that_already_has_history_is_never_mixed_with_the_moved_one() {
    let vault = TestVault::new();
    let id = Ulid::generate().to_string();
    let other = Ulid::generate().to_string();
    let conn = vault.indexed_note("Old.md", &id);
    // Another note once lived at the destination and left a version there.
    let target = vault.path("New.md");
    fs::write(&target, source(&other, "x")).unwrap();
    history::snapshot_before_write(&vault.0, &target, b"y", "edit").unwrap();
    fs::remove_file(&target).unwrap();
    fs::rename(vault.path("Old.md"), &target).unwrap();
    refresh(&conn, &vault.0, &[vault.path("Old.md"), target.clone()]);
    assert_eq!(versions(&vault, "New.md"), 1);
    assert_eq!(versions(&vault, "Old.md"), 1);
}

#[test]
fn swapped_names_do_not_swap_histories() {
    let vault = TestVault::new();
    let (a, b) = (Ulid::generate().to_string(), Ulid::generate().to_string());
    let conn = vault.indexed_note("A.md", &a);
    fs::write(vault.path("B.md"), source(&b, "b")).unwrap();
    load_vault(&conn, &vault.0).unwrap();
    let (a_text, b_text) = (
        fs::read(vault.path("A.md")).unwrap(),
        fs::read(vault.path("B.md")).unwrap(),
    );
    fs::write(vault.path("A.md"), b_text).unwrap();
    fs::write(vault.path("B.md"), a_text).unwrap();
    refresh(&conn, &vault.0, &[vault.path("A.md"), vault.path("B.md")]);
    assert_eq!(versions(&vault, "A.md"), 1);
    assert_eq!(versions(&vault, "B.md"), 0);
}

#[test]
fn a_note_without_an_identity_renamed_outside_amby_keeps_its_history_in_place() {
    // Never indexed, so the index knows nothing of it: its history stays at the old path (a limit).
    let vault = TestVault::new();
    let path = vault.path("Plain.md");
    fs::write(&path, "plain").unwrap();
    history::snapshot_before_write(&vault.0, &path, b"plain 2", "edit").unwrap();
    fs::rename(&path, vault.path("Plain 2.md")).unwrap();
    let conn = open_connection(&vault.0).unwrap();
    load_vault(&conn, &vault.0).unwrap();
    assert_eq!(versions(&vault, "Plain.md"), 1);
    // Only the version the index took of its own id assignment, not the old note's.
    assert_eq!(versions(&vault, "Plain 2.md"), 1);
}

#[test]
fn a_note_stored_under_a_path_key_is_never_relinked() {
    // A broken header has no usable identity: the index keys it by its path.
    let vault = TestVault::new();
    let path = vault.path("Broken.md");
    fs::write(&path, "---\ntitle: [unclosed\n---\nbody").unwrap();
    let conn = open_connection(&vault.0).unwrap();
    load_vault(&conn, &vault.0).unwrap();
    history::snapshot_before_write(&vault.0, &path, b"body 2", "edit").unwrap();
    fs::rename(&path, vault.path("Broken 2.md")).unwrap();
    refresh(&conn, &vault.0, &[path.clone(), vault.path("Broken 2.md")]);
    assert_eq!(versions(&vault, "Broken.md"), 1);
    assert_eq!(versions(&vault, "Broken 2.md"), 0);
}
