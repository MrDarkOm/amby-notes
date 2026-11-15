//! CORE-01: a document directly in the vault root is never the main note of a bundle, even when the
//! vault folder has the same name (`~/Notes/Notes.md`). Its "bundle" would be the whole vault, so
//! delete, archive, rename and move would act on every note, attachment and history snapshot.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use std::fs;
use std::path::{Path, PathBuf};

use crate::recycle_bin::{delete_permanently, preview_move_to_trash};

/// A vault whose folder is called `Notes` and holds `Notes.md` at its root, plus a neighbour.
fn vault_named_like_its_root_note(label: &str) -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("amby-core01-{label}-{}", ulid::Ulid::generate()));
    let vault = base.join("Notes");
    fs::create_dir_all(vault.join(".amby/history")).unwrap();
    fs::write(vault.join("Notes.md"), "root note").unwrap();
    fs::write(vault.join("Other.md"), "other").unwrap();
    fs::write(vault.join(".amby/history/kept.txt"), "history").unwrap();
    let vault = vault.canonicalize().unwrap();
    (base, vault)
}

fn assert_vault_intact(vault: &Path) {
    assert!(vault.is_dir(), "the vault folder must still exist");
    assert_eq!(fs::read(vault.join("Other.md")).unwrap(), b"other");
    assert_eq!(
        fs::read(vault.join(".amby/history/kept.txt")).unwrap(),
        b"history"
    );
}

#[test]
fn a_root_note_named_like_the_vault_resolves_to_itself() {
    let (base, vault) = vault_named_like_its_root_note("resolve");
    let note = vault.join("Notes.md");
    assert_eq!(resolve_item_root(&vault, &note), note);
    fs::remove_dir_all(base).ok();
}

#[test]
fn a_real_bundle_still_resolves_to_its_folder() {
    let (base, vault) = vault_named_like_its_root_note("bundle");
    fs::create_dir(vault.join("Proj")).unwrap();
    fs::write(vault.join("Proj/Proj.md"), "bundle").unwrap();
    assert_eq!(
        resolve_item_root(&vault, &vault.join("Proj/Proj.md")),
        vault.join("Proj")
    );
    fs::remove_dir_all(base).ok();
}

#[test]
fn trashing_a_root_note_named_like_the_vault_takes_only_that_note() {
    let (base, vault) = vault_named_like_its_root_note("trash");
    let note = vault.join("Notes.md");
    let preview = preview_move_to_trash(&vault, &note).unwrap();
    assert_eq!(preview.original_path, note);
    assert_eq!(preview.deleted_paths, vec![note.clone()]);
    fs::remove_dir_all(base).ok();
}

#[test]
fn permanently_deleting_a_root_note_named_like_the_vault_keeps_the_vault() {
    let (base, vault) = vault_named_like_its_root_note("permanent");
    let note = vault.join("Notes.md");
    let removed = delete_permanently(&vault, &note).unwrap();
    assert_eq!(removed.deleted_paths.len(), 1);
    assert!(!note.exists());
    assert_vault_intact(&vault);
    fs::remove_dir_all(base).ok();
}

#[test]
fn a_root_manifest_named_like_the_vault_is_deleted_alone() {
    let (base, vault) = vault_named_like_its_root_note("manifest");
    let manifest = vault.join("Notes.json");
    fs::write(&manifest, "{}").unwrap();
    let preview = preview_move_to_trash(&vault, &manifest).unwrap();
    assert_eq!(preview.original_path, manifest);
    fs::remove_dir_all(base).ok();
}

#[test]
fn the_vault_itself_and_its_service_folder_cannot_be_trashed() {
    let (base, vault) = vault_named_like_its_root_note("refuse");
    assert!(preview_move_to_trash(&vault, &vault).is_err());
    assert!(preview_move_to_trash(&vault, &vault.join(".amby")).is_err());
    assert!(preview_move_to_trash(&vault, &vault.join(".amby/history/kept.txt")).is_err());
    assert!(delete_permanently(&vault, &vault).is_err());
    assert_vault_intact(&vault);
    fs::remove_dir_all(base).ok();
}

#[test]
fn renaming_a_root_note_named_like_the_vault_renames_only_the_note() {
    let (base, vault) = vault_named_like_its_root_note("rename");
    let note = vault.join("Notes.md");
    let preview = preview_rename_item(&vault, &note, "Journal").unwrap();
    assert_eq!(
        preview.primary_path,
        Some(path_string(&vault.join("Journal.md")))
    );
    let result = rename_item_impl(&vault, &note, "Journal").unwrap();
    assert_eq!(
        result.primary_path,
        Some(path_string(&vault.join("Journal.md")))
    );
    assert_eq!(fs::read(vault.join("Journal.md")).unwrap(), b"root note");
    assert!(
        !base.join("Journal").exists(),
        "the vault folder must not be renamed"
    );
    assert_vault_intact(&vault);

    rollback_rename_item(&vault, &note, &result).unwrap();
    assert_eq!(fs::read(&note).unwrap(), b"root note");
    assert!(!vault.join("Journal.md").exists());
    assert_vault_intact(&vault);
    fs::remove_dir_all(base).ok();
}

#[test]
fn the_vault_itself_cannot_be_renamed() {
    let (base, vault) = vault_named_like_its_root_note("rename-vault");
    assert!(preview_rename_item(&vault, &vault, "Elsewhere").is_err());
    assert!(rename_item_impl(&vault, &vault, "Elsewhere").is_err());
    assert!(!base.join("Elsewhere").exists());
    assert_vault_intact(&vault);
    fs::remove_dir_all(base).ok();
}

#[test]
fn moving_a_root_note_named_like_the_vault_moves_only_the_note() {
    let (base, vault) = vault_named_like_its_root_note("move");
    fs::create_dir(vault.join("Folder")).unwrap();
    let note = vault.join("Notes.md");
    let target = vault.join("Folder");
    let preview = preview_move_item(&vault, &note, &target).unwrap();
    assert_eq!(
        preview.primary_path,
        Some(path_string(&target.join("Notes.md")))
    );
    let result = move_item_impl(&vault, &note, &target).unwrap();
    assert_eq!(
        result.primary_path,
        Some(path_string(&target.join("Notes.md")))
    );
    assert_eq!(fs::read(target.join("Notes.md")).unwrap(), b"root note");
    assert_vault_intact(&vault);

    rollback_move_item(&vault, &note, &target, &result).unwrap();
    assert_eq!(fs::read(&note).unwrap(), b"root note");
    assert_vault_intact(&vault);
    fs::remove_dir_all(base).ok();
}
