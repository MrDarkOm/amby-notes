//! The shadow check must stay quiet for a correct patch, name a corrupted one, and never write
//! to the vault.

use super::enabled::{apply_patch, check_once_for_tests, diff_against_full};
use crate::commands::mutations::rename_item_inner;
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::vault::tree::TreeItem;
use crate::vault::tree_patch::{TreePatch, TreePatchOp};
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;
use std::fs;
use std::path::{Path, PathBuf};
use ulid::Ulid;

struct Vault(PathBuf);

impl Vault {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("amby-shadow-{}", Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn note(&self, relative: &str, body: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            format!("---\namby-id: {}\n---\n{body}", Ulid::generate()),
        )
        .unwrap();
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> Vault {
    let vault = Vault::new();
    vault.note("Projects/Alpha.md", "alpha [[Beta]] #one");
    vault.note("Projects/Beta.md", "beta [[Alpha]]");
    vault.note("Folder/Loose.md", "loose");
    vault
}

/// The mirror after renaming one note through the real command code.
fn renamed(vault: &Vault) -> (VaultContext, Vec<TreeItem>, TreePatch) {
    let context = VaultContext::new();
    context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    let mut mirror = context
        .with_active(|active| active.refresh().map(|loaded| loaded.tree))
        .unwrap();
    let outcome = rename_item_inner(
        &context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_: &Path, _: &[crate::model::PathChange]| {},
        vault
            .0
            .join("Projects/Alpha.md")
            .to_string_lossy()
            .to_string(),
        "Renamed".to_string(),
    )
    .unwrap();
    let patch = outcome
        .mutation
        .tree_patch
        .expect("a rename reports a patch");
    apply_patch(&mut mirror, &vault.0, &patch).unwrap();
    (context, mirror, patch)
}

#[test]
fn a_correct_patch_gives_no_difference() {
    let vault = fixture();
    let (_context, mirror, _) = renamed(&vault);
    assert_eq!(
        diff_against_full(&vault.0, &mirror).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn a_corrupted_patch_is_named() {
    let vault = fixture();
    let (_context, _mirror, patch) = renamed(&vault);
    // The tree as it was before, with the old entry still listed; the patch forgets to remove it.
    let mut mirror = fixture_tree_with_old_entry(&vault);
    let broken = TreePatch {
        ops: patch
            .ops
            .into_iter()
            .filter(|op| !matches!(op, TreePatchOp::Remove { .. }))
            .collect(),
    };
    apply_patch(&mut mirror, &vault.0, &broken).unwrap();
    let lines = diff_against_full(&vault.0, &mirror).unwrap();
    assert!(
        lines.iter().any(|line| line.starts_with("tree:")),
        "{lines:#?}"
    );
}

/// The tree as it was before the rename: the old entry is still listed.
fn fixture_tree_with_old_entry(vault: &Vault) -> Vec<TreeItem> {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::index::init_schema(&conn).unwrap();
    // The index of this vault already knows the renamed note; list it under its old name.
    let mut tree = crate::index::load_vault(&conn, &vault.0).unwrap().tree;
    let projects = tree
        .iter_mut()
        .find(|item| item.name == "Projects")
        .and_then(|item| item.children.as_mut())
        .unwrap();
    let mut ghost = projects[0].clone();
    ghost.path = vault
        .0
        .join("Projects/Alpha.md")
        .to_string_lossy()
        .to_string();
    ghost.name = "Alpha".to_string();
    projects.insert(0, ghost);
    tree
}

#[test]
fn an_index_that_lost_a_tag_is_named() {
    let vault = fixture();
    let (context, mirror, _) = renamed(&vault);
    context
        .with_active(|active| {
            active
                .execute("DELETE FROM tags", [])
                .map_err(|error| error.to_string())
        })
        .unwrap();
    let lines = diff_against_full(&vault.0, &mirror).unwrap();
    assert!(
        lines.iter().any(|line| line.starts_with("tags:")),
        "{lines:#?}"
    );
}

#[test]
fn a_note_without_an_id_is_skipped_and_left_untouched() {
    let vault = fixture();
    let (_context, mirror, _) = renamed(&vault);
    let bare = vault.0.join("Folder/No id.md");
    fs::write(&bare, "no id yet").unwrap();
    assert!(diff_against_full(&vault.0, &mirror).is_err());
    assert_eq!(
        fs::read_to_string(&bare).unwrap(),
        "no id yet",
        "the check must not write an identity"
    );
}

#[test]
fn a_mismatch_is_written_to_the_report_and_a_match_is_not() {
    let vault = fixture();
    let report = vault
        .0
        .parent()
        .unwrap()
        .join(format!("shadow-{}.log", Ulid::generate()));
    let (_context, mirror, _patch) = renamed(&vault);
    check_once_for_tests(&vault.0, &mirror, "rename", 2, &report);
    assert!(!report.exists(), "a matching tree writes nothing");

    // A mirror that lost everything.
    let mut broken = mirror.clone();
    broken.clear();
    check_once_for_tests(&vault.0, &broken, "rename", 2, &report);
    let text = fs::read_to_string(&report).unwrap();
    assert!(
        text.contains("tree_patch.shadow_mismatch action=rename touched=2"),
        "{text}"
    );
    assert!(text.contains("tree: only in the full read"), "{text}");
    assert!(
        !text.contains("alpha [[Beta]]"),
        "the report carries no note text"
    );
    let _ = fs::remove_file(report);
}
