//! Hints about renames (Д70): the renames and moves of Amby become pairs of relative NFC paths
//! for the next pass, each used once.

use std::fs;
use std::path::PathBuf;

use amby_sync_core::engine::RenameHint;

use super::hints::RenameHints;
use crate::model::PathChange;

fn vault() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "amby-hints-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn change(root: &std::path::Path, old: &str, new: &str) -> PathChange {
    PathChange {
        old_path: root.join(old).to_string_lossy().into_owned(),
        new_path: root.join(new).to_string_lossy().into_owned(),
    }
}

fn hint(from: &str, to: &str) -> RenameHint {
    RenameHint {
        from: from.to_string(),
        to: to.to_string(),
    }
}

#[test]
fn a_rename_becomes_a_pair_of_relative_paths() {
    // Д70
    let root = vault();
    let hints = RenameHints::new();
    hints.record(&root, &[change(&root, "Notes/a.md", "Notes/b.md")]);
    assert_eq!(hints.take(), vec![hint("Notes/a.md", "Notes/b.md")]);
}

#[test]
fn a_hint_is_used_once() {
    // Д70: "a hint is used once"
    let root = vault();
    let hints = RenameHints::new();
    hints.record(&root, &[change(&root, "a.md", "b.md")]);
    assert_eq!(hints.len(), 1);
    assert_eq!(hints.take().len(), 1);
    assert!(hints.is_empty());
    assert!(hints.take().is_empty());
}

#[test]
fn a_folder_rename_gives_a_hint_for_every_change_it_reports() {
    // Д70, Д13
    let root = vault();
    let hints = RenameHints::new();
    hints.record(
        &root,
        &[
            change(&root, "Old", "New"),
            change(&root, "Old/x.md", "New/x.md"),
            change(&root, "Old/y.md", "New/y.md"),
        ],
    );
    assert_eq!(
        hints.take(),
        vec![
            hint("Old", "New"),
            hint("Old/x.md", "New/x.md"),
            hint("Old/y.md", "New/y.md"),
        ]
    );
}

#[test]
fn names_are_nfc_whatever_the_system_gave() {
    // Р9, Д61: macOS hands out NFD
    let root = vault();
    let hints = RenameHints::new();
    hints.record(&root, &[change(&root, "Cafe\u{301}.md", "Cafe\u{301}2.md")]);
    assert_eq!(hints.take(), vec![hint("Caf\u{e9}.md", "Caf\u{e9}2.md")]);
}

#[test]
fn a_change_outside_the_vault_is_dropped() {
    // The commands guard paths, but a hint for a foreign path must never reach the engine.
    let root = vault();
    let other = vault();
    let hints = RenameHints::new();
    hints.record(
        &root,
        &[
            change(&other, "a.md", "b.md"),
            PathChange {
                old_path: root.join("in.md").to_string_lossy().into_owned(),
                new_path: other.join("out.md").to_string_lossy().into_owned(),
            },
        ],
    );
    assert!(hints.is_empty());
}

#[test]
fn an_identical_pair_and_a_repeated_pair_are_dropped() {
    let root = vault();
    let hints = RenameHints::new();
    hints.record(
        &root,
        &[
            change(&root, "same.md", "same.md"),
            change(&root, "a.md", "b.md"),
            change(&root, "a.md", "b.md"),
        ],
    );
    hints.record(&root, &[change(&root, "a.md", "b.md")]);
    assert_eq!(hints.take(), vec![hint("a.md", "b.md")]);
}

#[test]
fn restored_hints_go_before_newer_ones() {
    // A pass that did not run must not lose its hints.
    let root = vault();
    let hints = RenameHints::new();
    hints.record(&root, &[change(&root, "a.md", "b.md")]);
    let taken = hints.take();
    hints.record(&root, &[change(&root, "c.md", "d.md")]);
    hints.restore(taken);
    assert_eq!(
        hints.take(),
        vec![hint("a.md", "b.md"), hint("c.md", "d.md")]
    );
}

#[test]
fn the_real_previews_of_rename_and_move_feed_the_hints() {
    // Д70: the commands of Amby take `path_changes` from the same previews that tests use here
    let root = vault();
    fs::create_dir_all(root.join("Folder")).unwrap();
    fs::write(root.join("Folder/a.md"), "# a").unwrap();
    fs::write(root.join("note.md"), "# note").unwrap();
    let hints = RenameHints::new();

    let renamed = crate::bundle::preview_rename_item(&root.join("note.md"), "renamed.md").unwrap();
    hints.record(&root, &renamed.path_changes);
    assert_eq!(hints.take(), vec![hint("note.md", "renamed.md")]);

    let moved =
        crate::bundle::preview_move_item(&root.join("renamed.md"), &root.join("Folder")).unwrap();
    hints.record(&root, &moved.path_changes);
    assert_eq!(hints.take(), vec![hint("renamed.md", "Folder/renamed.md")]);
}
