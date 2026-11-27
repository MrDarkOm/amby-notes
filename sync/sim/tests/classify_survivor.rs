//! Regression for whole-folder rename classification with a formerly empty recorded folder.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

fn folder_rename_keeps_ids_when_an_unrelated_empty_folder_is_created(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);

    // Empty folders have their own records. Keep that folder record after it gains files.
    w.dev(0).fs.user_mkdir("Old");
    w.pass(0);
    w.pass(1);
    let old_folder = w.item_at("Old").0;

    // Equal file contents force whole-folder matching; individual hash matching is ambiguous.
    w.save(0, "Old/a.md", "same");
    w.save(0, "Old/b.md", "same");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.item_at("Old").0, old_folder, "the folder record persists");
    let a = w.item_at("Old/a.md").0;
    let b = w.item_at("Old/b.md").0;

    w.dev(0).fs.user_rename("Old", "New");
    w.dev(0).fs.user_mkdir("Other");
    w.pass(0);

    assert_eq!(
        w.item_at("New").0,
        old_folder,
        "folder record remains the same item"
    );
    assert_eq!(
        w.item_at("New/a.md").0,
        a,
        "first file remains the same item"
    );
    assert_eq!(
        w.item_at("New/b.md").0,
        b,
        "second file remains the same item"
    );
    assert_ne!(w.item_at("Other").0, old_folder);

    w.pass(1);
    assert_eq!(
        w.dev(1).fs.content("New/a.md").as_deref(),
        Some("same".as_bytes())
    );
    assert_eq!(
        w.dev(1).fs.content("New/b.md").as_deref(),
        Some("same".as_bytes())
    );
    assert!(w.dev(1).fs.is_dir("Other"));
}

real_only!(folder_rename_keeps_ids_when_an_unrelated_empty_folder_is_created);
