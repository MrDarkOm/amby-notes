//! Negative D13 case: an existing folder record owns the target of a copied tree.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::header::ItemKind;

fn a_folder_move_does_not_claim_a_target_with_its_own_record(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);

    w.dev(0).fs.user_mkdir("Old");
    w.pass(0);
    w.pass(1);
    let old_folder = w.item_at("Old").0;

    w.save(0, "Old/a.md", "same");
    w.save(0, "Old/b.md", "same");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.item_at("Old").0, old_folder);
    let old_a = w.item_at("Old/a.md").0;
    let old_b = w.item_at("Old/b.md").0;

    // This separately synchronised empty directory already owns its folder identity.
    w.dev(0).fs.user_mkdir("Target");
    w.pass(0);
    w.pass(1);
    let target_folder = w.item_at("Target").0;
    assert_ne!(target_folder, old_folder);

    // The contents now resemble a move, but Target is not a new folder: Old was deleted and
    // copies of its files were placed into an existing, independently identified folder.
    w.dev(0).fs.user_delete("Old");
    w.save(0, "Target/a.md", "same");
    w.save(0, "Target/b.md", "same");
    w.pass(0);

    let target_folder_items: Vec<_> = w
        .server_items(false)
        .into_iter()
        .filter(|item| {
            let latest = &item.versions[0].header;
            latest.path == "Target" && !latest.deleted && latest.kind == ItemKind::Folder
        })
        .map(|item| item.item_id)
        .collect();
    assert_eq!(target_folder_items, vec![target_folder]);
    assert_ne!(w.item_at("Target/a.md").0, old_a);
    assert_ne!(w.item_at("Target/b.md").0, old_b);

    w.pass(1);
    assert!(!w.dev(1).fs.exists("Old"));
    assert_eq!(
        w.dev(1).fs.content("Target/a.md").as_deref(),
        Some("same".as_bytes())
    );
    assert_eq!(
        w.dev(1).fs.content("Target/b.md").as_deref(),
        Some("same".as_bytes())
    );
}

real_only!(a_folder_move_does_not_claim_a_target_with_its_own_record);
