//! Tests written for the mutants of `engine/classify.rs` and `engine/scan.rs` that survived the
//! trial run of the gates (docs/Road/sync-gates-survivors-report.md): how a moved folder is
//! recognised (Д13), a folder that is empty, a file that is too big to look at (Д71), the borders
//! of the limits (Д74), two spellings of one name (Д61), a vault that disappears while it is
//! listed (Д55). Real engine only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::engine::UnsyncedReason;

fn unsynced(w: &World, d: usize) -> Vec<(String, UnsyncedReason)> {
    let mut list: Vec<_> = w
        .dev(d)
        .state
        .snapshot()
        .unsynced
        .into_iter()
        .map(|u| (u.path, u.reason))
        .collect();
    list.sort_by(|a, b| a.0.cmp(&b.0));
    list
}

fn text_of(n: usize) -> String {
    "x".repeat(n)
}

// ----- whole folders that move (Д13) -----

fn sv_d13_a_folder_of_equal_files_moves_as_a_folder_whatever_else_is_in_the_vault(_b: EngineBuilder) {
    // Two files of one content: only the rule of the whole folder can tell them apart. A record
    // that sorts after the folder (present, or gone in the same pass) must not hide the move.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Old/a.md", "dup");
    w.save(0, "Old/b.md", "dup");
    w.save(0, "zzz.md", "after");
    w.save(0, "zzy.md", "after too");
    w.pass(0);
    let (a, _) = w.item_at("Old/a.md");
    let (b, _) = w.item_at("Old/b.md");
    w.dev(0).fs.user_rename("Old", "New");
    w.dev(0).fs.user_delete("zzy.md");
    w.pass(0);
    assert_eq!(w.item_at("New/a.md").0, a, "a rename, not a new record");
    assert_eq!(w.item_at("New/b.md").0, b, "a rename, not a new record");
    w.pass(1);
    assert_eq!(w.read(1, "New/a.md").as_deref(), Some("dup"));
    assert!(!w.dev(1).fs.exists("Old"));
    w.finish(true);
}

fn sv_d13_a_folder_with_a_file_that_stays_is_not_a_moved_folder(_b: EngineBuilder) {
    // "Something under it is still here": a.md left Old, b.md did not; with other equal files
    // missing the pairing by content is ambiguous, and a guess would be a rename of a.md that
    // nobody did. It is a deletion and a creation.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Old/a.md", "dup");
    w.save(0, "Old/b.md", "other");
    w.save(0, "Y.md", "dup");
    w.pass(0);
    let (a, _) = w.item_at("Old/a.md");
    w.dev(0).fs.user_delete("Y.md");
    w.dev(0).fs.user_delete("Old/a.md");
    w.save(0, "New/a.md", "dup");
    w.pass(0);
    assert_ne!(w.item_at("New/a.md").0, a);
    w.pass(1);
    assert_eq!(w.read(1, "New/a.md").as_deref(), Some("dup"));
    assert_eq!(w.read(1, "Old/b.md").as_deref(), Some("other"));
    w.finish(true);
}

fn sv_d13_a_new_short_file_with_the_content_of_a_moved_file_does_not_break_the_search(
    _b: EngineBuilder,
) {
    // A new file whose content equals the probe file of the moved folder, at a path shorter than
    // the probe's name.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Old/a.md", "AAA");
    w.save(0, "Old/b.md", "BBB");
    w.pass(0);
    let (a, _) = w.item_at("Old/a.md");
    w.dev(0).fs.user_rename("Old", "New");
    w.save(0, "q.md", "AAA");
    w.pass(0);
    assert_eq!(w.item_at("New/a.md").0, a);
    w.finish(true);
}

fn sv_d13_a_folder_copied_to_two_places_is_not_guessed_to_be_moved_to_one_of_them(_b: EngineBuilder) {
    // The folder is gone and two copies of it stand: which one is "the" moved folder is not
    // known; nothing is guessed (a deletion and creations, nothing is lost).
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Old/a.md", "AAA");
    w.save(0, "Old/b.md", "BBB");
    w.pass(0);
    let (a, _) = w.item_at("Old/a.md");
    let (b, _) = w.item_at("Old/b.md");
    w.dev(0).fs.user_delete("Old");
    for dir in ["New1", "New2"] {
        w.save(0, &format!("{dir}/a.md"), "AAA");
        w.save(0, &format!("{dir}/b.md"), "BBB");
    }
    w.pass(0);
    for dir in ["New1", "New2"] {
        let ids = [
            w.item_at(&format!("{dir}/a.md")).0,
            w.item_at(&format!("{dir}/b.md")).0,
        ];
        assert!(ids[0] != a && ids[1] != b, "{dir} is new, not a move");
    }
    w.pass(1);
    for dir in ["New1", "New2"] {
        assert_eq!(w.read(1, &format!("{dir}/a.md")).as_deref(), Some("AAA"));
    }
    assert!(!w.dev(1).fs.exists("Old"));
    w.finish(true);
}

// ----- empty folders (Р2) -----

fn sv_r2_an_empty_folder_renamed_is_a_rename(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("Empty1");
    w.pass(0);
    let (id, _) = w.item_at("Empty1");
    w.dev(0).fs.user_rename("Empty1", "Empty2");
    w.pass(0);
    assert_eq!(w.item_at("Empty2").0, id, "the same folder, a new name");
    w.pass(1);
    assert!(w.dev(1).fs.is_dir("Empty2"));
    assert!(!w.dev(1).fs.exists("Empty1"));
    w.finish(true);
}

fn sv_r2_an_empty_folder_renamed_with_a_file_gone_is_not_a_rename(_b: EngineBuilder) {
    // A file is gone in the same pass: nothing pairs the folder with the new one by guess.
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("Empty1");
    w.save(0, "Gone.md", "gone");
    w.pass(0);
    let (id, _) = w.item_at("Empty1");
    w.dev(0).fs.user_rename("Empty1", "Empty2");
    w.dev(0).fs.user_delete("Gone.md");
    w.pass(0);
    assert_ne!(w.item_at("Empty2").0, id);
    w.finish(true);
}

fn sv_r2_a_deleted_empty_folder_next_to_another_empty_folder_is_a_deletion(_b: EngineBuilder) {
    // E1 is gone, E2 stays: E2 is not a new folder that E1 moved to.
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("E1");
    w.dev(0).fs.user_mkdir("E2");
    w.pass(0);
    let (e2, _) = w.item_at("E2");
    w.dev(0).fs.user_delete("E1");
    w.pass(0);
    assert_eq!(w.item_at("E2").0, e2);
    let versions = w.versions_at("E1");
    assert!(versions[0].header.deleted, "E1 is deleted, not moved");
    w.pass(1);
    assert!(!w.dev(1).fs.exists("E1"));
    assert!(w.dev(1).fs.is_dir("E2"));
    w.finish(true);
}

// ----- a file too big to look at (Д71) -----

fn sv_d71_a_synced_file_that_became_too_big_for_memory_is_not_deleted_on_the_server(
    _b: EngineBuilder,
) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Big/x.md", &text_of(2_000));
    w.pass(0);
    assert!(w.server_files().contains_key("Big/x.md"));
    *w.dev(0).config_tweak.borrow_mut() = Some(Box::new(|c| c.max_file_bytes = 1_000));
    let head = w.server_head();
    w.pass(0);
    assert_eq!(w.server_head(), head, "nothing is sent for it");
    assert!(w.server_files().contains_key("Big/x.md"), "not deleted");
    assert!(w.dev(0).fs.exists("Big/x.md"));
    assert_eq!(
        unsynced(&w, 0),
        vec![("Big/x.md".to_string(), UnsyncedReason::TooBigForMemory)]
    );
}

fn sv_d71_the_limit_of_memory_is_a_whole_number_of_bytes(_b: EngineBuilder) {
    // A file of exactly the limit is looked at; one byte more is not.
    let w = pair_with_a(Engine::boxed);
    *w.dev(0).config_tweak.borrow_mut() = Some(Box::new(|c| c.max_file_bytes = 5_000));
    w.save(0, "Edge/exact.md", &text_of(5_000));
    w.save(0, "Edge/over.md", &text_of(5_001));
    w.pass(0);
    let files = w.server_files();
    assert!(files.contains_key("Edge/exact.md"));
    assert!(!files.contains_key("Edge/over.md"));
    assert_eq!(
        unsynced(&w, 0),
        vec![("Edge/over.md".to_string(), UnsyncedReason::TooBigForMemory)]
    );
}

// ----- the limit of the server for a body (Д74) -----

fn sv_d74_a_body_of_exactly_the_limit_is_sent_and_a_larger_one_is_not(_b: EngineBuilder) {
    let sealed = |n: u64| sealed_body_len(n).unwrap();
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1).max_blob_bytes(sealed(10_000)),
    );
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Edge/exact.bin", &text_of(10_000));
    w.save(0, "Edge/over.bin", &text_of(20_000));
    w.pass(0);
    let files = w.server_files();
    assert!(files.contains_key("Edge/exact.bin"), "a body of the limit");
    assert!(!files.contains_key("Edge/over.bin"));
    let list = unsynced(&w, 0);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].0, "Edge/over.bin");
}

// ----- two spellings of one name (Д61) -----

fn sv_d61_the_second_spelling_of_a_name_is_not_synchronised(_b: EngineBuilder) {
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1).with_fs(vec![Vfs::linux()]),
    );
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/\u{e9}.md", "composed");
    w.save(0, "Notes/e\u{301}.md", "decomposed");
    w.pass(0);
    let list = unsynced(&w, 0);
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0].1, UnsyncedReason::NameCollision);
    let files = w.server_files();
    assert_eq!(files.keys().filter(|p| p.starts_with("Notes/")).count(), 1);
    assert!(w.dev(0).fs.exists("Notes/\u{e9}.md") && w.dev(0).fs.exists("Notes/e\u{301}.md"));
}

fn sv_d61_a_second_spelling_of_the_name_of_a_file_that_cannot_be_read_is_not_synchronised(
    _b: EngineBuilder,
) {
    // The first spelling (by bytes) is blocked (the system refuses it); the second must still be a
    // collision.
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1).with_fs(vec![Vfs::linux()]),
    );
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/\u{e9}.md", "composed");
    w.save(0, "Notes/e\u{301}.md", "decomposed");
    w.dev(0).fs.set_access_denied("Notes/e\u{301}.md", true);
    w.pass(0);
    let list = unsynced(&w, 0);
    assert!(
        list.iter().any(|(_, r)| *r == UnsyncedReason::NameCollision),
        "{list:?}"
    );
    assert_eq!(
        w.server_files()
            .keys()
            .filter(|p| p.starts_with("Notes/"))
            .count(),
        0,
        "neither spelling goes up: one is refused, the other is its twin"
    );
}

// ----- the vault goes while it is listed (Д55) -----

fn sv_d55_a_vault_that_disappears_while_it_is_listed_stops_the_pass(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Notes/b.md", "b");
    let fs = w.dev(0).fs.clone();
    w.dev(0)
        .faults
        .before_named("Fs.list", move || fs.set_root_present(false));
    let reason = w.stop(0);
    w.dev(0).fs.set_root_present(true);
    assert_eq!(reason, StopReason::VaultMissing);
}

fn sv_d55_a_failing_listing_is_not_a_missing_vault_while_the_folder_is_there(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.set_list_not_found(true);
    let result = w.dev(0).sync();
    w.dev(0).fs.set_list_not_found(false);
    assert!(
        matches!(result, Err(amby_sync_core::engine::EngineError::Fs(_))),
        "{result:?}"
    );
}

real_only!(
    sv_d55_a_failing_listing_is_not_a_missing_vault_while_the_folder_is_there,
    sv_d13_a_folder_of_equal_files_moves_as_a_folder_whatever_else_is_in_the_vault,
    sv_d13_a_folder_with_a_file_that_stays_is_not_a_moved_folder,
    sv_d13_a_new_short_file_with_the_content_of_a_moved_file_does_not_break_the_search,
    sv_d13_a_folder_copied_to_two_places_is_not_guessed_to_be_moved_to_one_of_them,
    sv_r2_an_empty_folder_renamed_is_a_rename,
    sv_r2_an_empty_folder_renamed_with_a_file_gone_is_not_a_rename,
    sv_r2_a_deleted_empty_folder_next_to_another_empty_folder_is_a_deletion,
    sv_d71_a_synced_file_that_became_too_big_for_memory_is_not_deleted_on_the_server,
    sv_d71_the_limit_of_memory_is_a_whole_number_of_bytes,
    sv_d74_a_body_of_exactly_the_limit_is_sent_and_a_larger_one_is_not,
    sv_d61_the_second_spelling_of_a_name_is_not_synchronised,
    sv_d61_a_second_spelling_of_the_name_of_a_file_that_cannot_be_read_is_not_synchronised,
    sv_d55_a_vault_that_disappears_while_it_is_listed_stops_the_pass,
);
