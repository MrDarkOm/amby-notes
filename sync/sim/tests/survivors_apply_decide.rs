//! Tests written for the mutants of `engine/apply.rs` and `engine/decide.rs` that survived the
//! trial run of the gates (docs/Road/sync-gates-survivors-report.md): what a pass does with a file
//! that changed after the decision, renames onto files, folders that the server renamed or
//! changed, the bases of merges, the copies of conflicts and where they are put. Real engine only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::conflict_set::{set_id, set_paths};
use amby_sync_core::engine::{ConflictKind, RenameHint, UnsyncedReason};

fn text_of(n: usize, c: char) -> String {
    c.to_string().repeat(n)
}

fn hinted(w: &World, d: usize, from: &str, to: &str) -> CycleReport {
    w.dev(d)
        .sync_with(&CycleRequest {
            rename_hints: vec![RenameHint {
                from: from.into(),
                to: to.into(),
            }],
            ..Default::default()
        })
        .unwrap()
}

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

/// Runs `action` after the disk was looked at and before the decisions are applied: the user edits
/// a file in the middle of a pass (С9).
fn in_the_middle(w: &World, d: usize, action: impl FnOnce() + 'static) {
    w.dev(d)
        .faults
        .before_remote(RemoteKind::Changes, action);
}

// ----- a file that changed after the decision is never touched (С9) -----

fn sv_a_file_edited_while_the_pass_runs_is_not_trashed(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    let fs = w.dev(1).fs.clone();
    in_the_middle(&w, 1, move || fs.user_write("Notes/a.md", b"edited late"));
    let report = w.pass(1);
    assert_eq!(report.trashed, 0);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("edited late"));
    assert!(w.dev(1).fs.trash().is_empty());
    // The next pass sees an edit against a deletion: the edit wins and goes up.
    w.pass(1);
    assert_eq!(
        w.server_files().get("Notes/a.md").map(|b| text(b)),
        Some("edited late".to_string())
    );
    w.finish(false);
}

fn sv_a_file_edited_while_the_pass_runs_is_not_renamed(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.pass(0);
    let fs = w.dev(1).fs.clone();
    in_the_middle(&w, 1, move || fs.user_write("Notes/a.md", b"edited late"));
    let report = w.pass(1);
    // The decision was made on the file as it had been: the pass drops it and decides again
    // (the push meets the new version of the server), so the feed is read twice.
    assert_eq!(w.remote_calls(1, RemoteKind::Changes), 2);
    assert_eq!(report.renamed, 1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("edited late"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    w.finish(false);
}

fn sv_a_file_edited_while_the_pass_runs_is_not_overwritten(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Notes/a.md", "server");
    w.pass(0);
    let fs = w.dev(1).fs.clone();
    in_the_middle(&w, 1, move || fs.user_write("Notes/a.md", b"edited late"));
    let report = w.pass(1);
    // Both sides changed the note: the late edit is a side of a conflict, not a file replaced
    // by the decision made before it.
    assert_eq!(report.conflicts.len() + report.merged_paths.len(), 1);
    assert!(
        w.others(1, "Notes/a.md").contains(&"edited late".to_string())
            || w.read(1, "Notes/a.md").as_deref() == Some("edited late"),
        "the late edit is kept: {:?}",
        w.texts(1)
    );
    w.finish(false);
}

fn sv_a_file_in_the_way_edited_while_the_pass_runs_is_left_alone(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(1, "Notes/b.md", "mine");
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.pass(0);
    let fs = w.dev(1).fs.clone();
    in_the_middle(&w, 1, move || fs.user_write("Notes/b.md", b"mine, changed"));
    let report = w.pass(1);
    assert_eq!(report.renamed, 0);
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("mine, changed"));
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
}

fn sv_a_rename_onto_a_file_without_a_base_keeps_that_file_as_a_copy(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(1, "Notes/b.md", "mine");
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(report.renamed, 1);
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("base"));
    assert_eq!(w.others(1, "Notes/b.md"), vec!["mine".to_string()]);
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
}

fn sv_two_conflicts_of_one_pass_are_both_in_the_report(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_write("Bin/x.bin", &[1, 2, 3]);
    w.dev(0).fs.user_write("Bin/y.bin", &[4, 5, 6]);
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_write("Bin/x.bin", &[1, 2, 3, 0]);
    w.dev(0).fs.user_write("Bin/y.bin", &[4, 5, 6, 0]);
    w.pass(0);
    w.dev(1).fs.user_write("Bin/x.bin", &[1, 2, 3, 1]);
    w.dev(1).fs.user_write("Bin/y.bin", &[4, 5, 6, 1]);
    let report = w.pass(1);
    assert_eq!(report.conflicts.len(), 2, "{:?}", report.conflicts);
    assert_ne!(report.conflicts[0].id, report.conflicts[1].id);
}

fn sv_a_text_file_that_is_not_a_note_is_never_merged(_b: EngineBuilder) {
    // К1, Г5: only `.md` is merged; the same two edits to a `.txt` are a conflict.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Notes/t.txt", "a\nb\nc\n");
    w.pass(0);
    w.pass(1);
    w.save(0, "Notes/t.txt", "A\nb\nc\n");
    w.pass(0);
    w.save(1, "Notes/t.txt", "a\nb\nC\n");
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(w.read(1, "Notes/t.txt").as_deref(), Some("A\nb\nc\n"));
    assert_eq!(w.others(1, "Notes/t.txt"), vec!["a\nb\nC\n".to_string()]);
}

// ----- the bases of merges (Г6–Г10) -----

fn lines(n: usize) -> String {
    (0..n).map(|i| format!("line {i:05} of a big note\n")).collect()
}

fn sv_a_big_note_keeps_its_base_and_is_merged_in_chunks(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    let big = lines(6_000); // 150 000 bytes: three chunks of 64 KiB
    w.save(0, "Notes/big.md", &big);
    w.pass(0);
    let before = w.dev(1).state.base_count();
    w.pass(1);
    assert_eq!(
        w.dev(1).state.base_count(),
        before + 1,
        "the downloaded note is kept as a base"
    );
    w.save(0, "Notes/big.md", &big.replacen("line 00001 ", "FIRST ", 1));
    w.save(1, "Notes/big.md", &big.replacen("line 05998 ", "LAST ", 1));
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(report.merged_paths, vec!["Notes/big.md".to_string()]);
    assert!(report.conflicts.is_empty());
    let merged = w.read(1, "Notes/big.md").unwrap();
    assert!(merged.contains("FIRST of a big note") && merged.contains("LAST of a big note"));
    let writes = w
        .dev(1)
        .faults
        .log()
        .iter()
        .filter(|call| call.as_str() == "Fs.staged.write")
        .count();
    assert!(
        (3..=6).contains(&writes),
        "150 000 bytes go in pieces of 64 KiB, not in {writes} small ones"
    );
}

fn sv_a_note_made_alike_on_two_computers_has_a_base_and_merges_later(_b: EngineBuilder) {
    // Д15, Г8 в: the same content at the same path on both sides, made apart: the file becomes the
    // base; the later edits of two places merge.
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/m.md", "a\nb\nc\n");
    w.save(1, "Keep/k.md", "keep");
    w.save(1, "Notes/m.md", "a\nb\nc\n");
    w.pass(0);
    w.pass(1);
    assert!(w.dev(1).state.base_count() >= 1, "the base is kept");
    w.save(0, "Notes/m.md", "A\nb\nc\n");
    w.save(1, "Notes/m.md", "a\nb\nC\n");
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(report.merged_paths, vec!["Notes/m.md".to_string()]);
    assert_eq!(w.read(1, "Notes/m.md").as_deref(), Some("A\nb\nC\n"));
    w.finish(false);
}

fn sv_a_file_that_is_not_a_note_made_alike_has_no_base(_b: EngineBuilder) {
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/m.bin", "same bytes");
    w.save(1, "Keep/k.md", "keep");
    w.save(1, "Notes/m.bin", "same bytes");
    w.pass(0);
    let before = w.dev(1).state.base_count();
    w.pass(1);
    // k.md is a note and has a base, m.bin has none.
    assert_eq!(w.dev(1).state.base_count(), before + 1);
}

fn sv_a_file_edited_while_the_pass_runs_is_not_kept_as_a_base(_b: EngineBuilder) {
    // The base is the bytes whose hash the record says (Г7): a file that changed after the
    // decision gives no base.
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/m.md", "a\nb\nc\n");
    w.pass(0);
    w.save(1, "Keep/k.md", "keep");
    w.save(1, "Notes/m.md", "a\nb\nc\n");
    let fs = w.dev(1).fs.clone();
    in_the_middle(&w, 1, move || fs.user_write("Notes/m.md", b"a\nb\nedited\n"));
    w.pass(1);
    let puts = w
        .dev(1)
        .faults
        .log()
        .iter()
        .filter(|call| call.as_str() == "State.base_put")
        .count();
    assert_eq!(
        puts, 2,
        "k.md (the same on both sides) and the edited m.md as it was sent; not the edited bytes under the old hash"
    );
}

// ----- a conflict copy: where it goes -----

fn sv_the_copy_of_a_conflict_goes_to_the_next_name_when_the_first_is_a_folder(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_write("Bin/x.bin", &[1, 2, 3]);
    w.pass(0);
    w.pass(1);
    let (item, _) = w.item_at("Bin/x.bin");
    w.dev(0).fs.user_write("Bin/x.bin", &[1, 2, 3, 0]);
    w.pass(0);
    let (_, version) = w.item_at("Bin/x.bin");
    // The first name of the copy of the local version [1, 2, 3, 1] is a folder here.
    let local = vec![1u8, 2, 3, 1];
    let id = set_id(&item, &blake3_hash(&local), version, None, 0);
    let first = set_paths(&id, "Bin/x.bin").other;
    w.dev(1).fs.user_mkdir(&first);
    w.dev(1).fs.user_write("Bin/x.bin", &local);
    let report = w.pass(1);
    assert_eq!(report.conflicts.len(), 1);
    assert_ne!(report.conflicts[0].copy_path, first);
    assert_eq!(w.dev(1).fs.content("Bin/x.bin").unwrap(), vec![1, 2, 3, 0]);
    assert_eq!(
        w.dev(1).fs.content(&report.conflicts[0].copy_path).unwrap(),
        local
    );
}

fn sv_the_server_version_saved_by_a_resync_is_not_written_twice(_b: EngineBuilder) {
    // Д56: the copy of the server's version is there already (the pass was interrupted before):
    // it is not downloaded and written again.
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    w.save(0, "Notes/a.md", "local only");
    // The copy of the server's text as the resync would make it.
    let id = set_id(&item, &blake3_hash(b"base"), version, None, 0);
    let copy = set_paths(&id, "Notes/a.md");
    w.dev(0).fs.user_write(&copy.other, b"base");
    let report = w.pass_with(
        0,
        Approvals {
            resync: true,
            ..Default::default()
        },
    );
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(w.remote_calls(0, RemoteKind::Download), 0);
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(w.read(0, "Notes/a.md").as_deref(), Some("local only"));
}

// ----- two live items at one path (Д49, Д71) -----

fn sv_the_larger_item_waits_when_another_live_item_keeps_the_path(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.inject_file(&ItemId::from_bytes([0xff; 16]), 0, "Notes/a.md", b"from the larger");
    let report = w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert!(unsynced(&w, 1)
        .iter()
        .any(|(p, r)| p == "Notes/a.md" && *r == UnsyncedReason::PathBusy));
}

fn sv_the_smaller_item_takes_the_path_and_the_other_file_becomes_a_copy(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.inject_file(&ItemId::from_bytes([0x00; 16]), 0, "Notes/a.md", b"from the smaller");
    let report = w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("from the smaller"));
    assert_eq!(report.conflicts.len(), 1, "{:?}", report.conflicts);
    assert_eq!(w.others(1, "Notes/a.md"), vec!["base".to_string()]);
}

fn sv_a_new_item_takes_the_path_that_another_item_leaves_in_the_same_pass(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/q.md");
    w.pass(0);
    w.inject_file(&ItemId::from_bytes([0xff; 16]), 0, "Notes/a.md", b"from the larger");
    let report = w.pass(1);
    assert_eq!(w.read(1, "Notes/q.md").as_deref(), Some("base"));
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("from the larger"));
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert!(unsynced(&w, 1).is_empty(), "{:?}", unsynced(&w, 1));
}

fn sv_the_copy_of_a_conflict_goes_to_the_next_name_when_the_first_is_a_file_that_cannot_be_read(
    _b: EngineBuilder,
) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_write("Bin/x.bin", &[1, 2, 3]);
    w.pass(0);
    w.pass(1);
    let (item, _) = w.item_at("Bin/x.bin");
    w.dev(0).fs.user_write("Bin/x.bin", &[1, 2, 3, 0]);
    w.pass(0);
    let (_, version) = w.item_at("Bin/x.bin");
    let local = vec![1u8, 2, 3, 1];
    let id = set_id(&item, &blake3_hash(&local), version, None, 0);
    let first = set_paths(&id, "Bin/x.bin").other;
    w.dev(1).fs.user_write(&first, b"a file nobody can read");
    w.dev(1).fs.set_access_denied(&first, true);
    w.dev(1).fs.user_write("Bin/x.bin", &local);
    let report = w.pass(1);
    assert_eq!(report.conflicts.len(), 1);
    assert_ne!(report.conflicts[0].copy_path, first);
    assert_eq!(
        w.dev(1).fs.content(&first).unwrap(),
        b"a file nobody can read".to_vec()
    );
}

// ----- decisions on the paths (Д41–Д51) -----

fn sv_a_folder_record_over_a_local_file_waits(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("Docs");
    w.save(1, "Docs", "a file where the other computer has a folder");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, "Docs").as_deref(),
        Some("a file where the other computer has a folder")
    );
    assert!(unsynced(&w, 1)
        .iter()
        .any(|(p, r)| p == "Docs" && *r == UnsyncedReason::PathBusy));
}

fn sv_a_path_with_only_a_deleted_record_is_free_for_a_new_item(_b: EngineBuilder) {
    // d0 deleted Notes/a.md and made a new file at that path; another computer made a different
    // file there too: two files created apart (Д43), not a path held by a live base.
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.pass(1);
    w.save(1, "Notes/a.md", "created by d1");
    w.pass(1);
    w.save(0, "Notes/a.md", "created by d0");
    let report = w.pass(0);
    assert_eq!(report.conflicts.len(), 1, "{:?}", report.conflicts);
    assert_eq!(w.read(0, "Notes/a.md").as_deref(), Some("created by d1"));
    assert_eq!(w.others(0, "Notes/a.md"), vec!["created by d0".to_string()]);
}

fn sv_a_file_the_server_deleted_and_we_deleted_comes_back_only_when_edited_elsewhere(
    _b: EngineBuilder,
) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.save(1, "Notes/a.md", "edited after the deletion");
    w.pass(1);
    let report = w.pass(0);
    assert_eq!(report.restored_paths, vec!["Notes/a.md".to_string()]);
    assert_eq!(
        w.read(0, "Notes/a.md").as_deref(),
        Some("edited after the deletion")
    );
}

fn sv_a_parked_file_that_finds_its_place_is_not_a_restored_one(_b: EngineBuilder) {
    // Д64: the item waits until the name is free; when it is written it is a new file, not one
    // that came back after our deletion.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Notes/n", "a file named n");
    w.save(1, "Notes/n/inner.md", "a folder named n");
    w.pass(0);
    let report = w.pass(1);
    assert!(unsynced(&w, 1)
        .iter()
        .any(|(p, r)| p == "Notes/n" && *r == UnsyncedReason::PathBusy));
    assert!(report.restored_paths.is_empty());
    w.dev(1).fs.user_delete("Notes/n");
    let report = w.pass(1);
    assert_eq!(w.read(1, "Notes/n").as_deref(), Some("a file named n"));
    assert!(report.restored_paths.is_empty(), "{:?}", report.restored_paths);
    assert_eq!(report.downloaded, 1);
}

fn sv_a_file_exactly_as_big_as_the_memory_limit_is_written_and_a_bigger_one_waits(
    _b: EngineBuilder,
) {
    let w = pair_with_a(Engine::boxed);
    *w.dev(1).config_tweak.borrow_mut() = Some(Box::new(|c| c.max_file_bytes = 3_000));
    w.save(0, "Edge/exact.md", &text_of(3_000, 'e'));
    w.save(0, "Edge/over.md", &text_of(3_001, 'o'));
    w.pass(0);
    w.pass(1);
    assert!(w.dev(1).fs.exists("Edge/exact.md"));
    assert!(!w.dev(1).fs.exists("Edge/over.md"));
    assert_eq!(
        unsynced(&w, 1),
        vec![("Edge/over.md".to_string(), UnsyncedReason::TooBigForMemory)]
    );
}

fn sv_a_local_file_too_big_to_compare_holds_the_server_edit_back(_b: EngineBuilder) {
    // Д71: the file is there, but this computer cannot look at it; a newer version from the server
    // is neither written over it nor forgotten: the item is an error and the cursor waits.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Big/x.md", &text_of(2_000, 'x'));
    w.pass(0);
    w.pass(1);
    w.save(0, "Big/x.md", &text_of(500, 'y'));
    w.pass(0);
    *w.dev(1).config_tweak.borrow_mut() = Some(Box::new(|c| c.max_file_bytes = 1_000));
    let before = w.dev(1).state.snapshot().cursor;
    let report = w.pass(1);
    assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
    assert_eq!(w.read(1, "Big/x.md").unwrap().len(), 2_000, "left alone");
    assert_eq!(w.dev(1).state.snapshot().cursor, before, "held");
    *w.dev(1).config_tweak.borrow_mut() = None;
    let report = w.pass(1);
    assert!(report.errors.is_empty());
    assert_eq!(w.read(1, "Big/x.md").unwrap(), text_of(500, 'y'));
}

fn sv_two_names_that_differ_by_case_are_not_both_written_in_one_pass(_b: EngineBuilder) {
    // Д63: the second name of the same key waits, whichever the first is in the feed.
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(2).with_fs(vec![Vfs::linux(), Vfs::macos()]),
    );
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/Case.md", "upper");
    w.save(0, "Notes/case.md", "lower");
    w.pass(0);
    w.pass(1);
    let list = unsynced(&w, 1);
    assert_eq!(list.len(), 1, "{list:?}");
    assert!(matches!(list[0].1, UnsyncedReason::CaseCollision { .. }));
    assert_eq!(
        w.dev(1)
            .fs
            .files()
            .keys()
            .filter(|p| p.starts_with("Notes/"))
            .count(),
        1
    );
}

// ----- the renames of folders (Д17, step 5) -----

fn sv_a_folder_renamed_by_the_server_that_we_deleted_is_made_where_the_server_has_it(
    _b: EngineBuilder,
) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("F");
    w.pass(0);
    w.pass(1);
    w.dev(1).fs.user_rename("F", "G");
    w.pass(1);
    w.dev(0).fs.user_delete("F");
    w.pass(0);
    assert!(w.dev(0).fs.is_dir("G"), "the rename of the other side stands");
    assert!(w.server_folders().contains("G"));
    assert!(!w.server_folders().contains("F"));
    w.finish(true);
}

fn sv_a_folder_changed_by_the_server_without_a_rename_that_we_deleted_stays_deleted(
    _b: EngineBuilder,
) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("F");
    w.pass(0);
    w.pass(1);
    let (item, version) = w.item_at("F");
    w.dev(1).fs.user_delete("F");
    w.inject_folder(&item, version, "F");
    w.pass(1);
    assert!(!w.dev(1).fs.exists("F"), "our deletion is not undone");
    assert!(w.versions_at("F")[0].header.deleted);
}

// ----- renames with edits, told by the application (Д70) -----

fn sv_a_renamed_and_edited_file_that_the_server_has_with_the_same_text_is_not_a_conflict(
    _b: EngineBuilder,
) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Notes/a.md", "X");
    w.pass(0);
    w.dev(1).fs.user_rename("Notes/a.md", "Notes/c.md");
    w.save(1, "Notes/c.md", "X");
    let report = hinted(&w, 1, "Notes/a.md", "Notes/c.md");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert_eq!(report.downloaded, 0);
    assert_eq!(
        w.server_files().get("Notes/c.md").map(|b| text(b)),
        Some("X".to_string()),
        "and the rename goes up"
    );
    w.finish(false);
}

fn sv_a_file_renamed_and_edited_alike_on_both_sides_goes_to_the_name_of_the_server(
    _b: EngineBuilder,
) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/d.md");
    w.save(0, "Notes/d.md", "X");
    hinted(&w, 0, "Notes/a.md", "Notes/d.md");
    assert_eq!(
        w.server_files().get("Notes/d.md").map(|b| text(b)),
        Some("X".to_string())
    );
    w.dev(1).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.save(1, "Notes/b.md", "X");
    let report = hinted(&w, 1, "Notes/a.md", "Notes/b.md");
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert!(w.dev(1).fs.exists("Notes/d.md"), "the name of the server");
    assert!(!w.dev(1).fs.exists("Notes/b.md"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    w.finish(false);
}

#[allow(dead_code)]
fn unused(_: ConflictKind) {}

real_only!(
    sv_the_larger_item_waits_when_another_live_item_keeps_the_path,
    sv_the_smaller_item_takes_the_path_and_the_other_file_becomes_a_copy,
    sv_a_new_item_takes_the_path_that_another_item_leaves_in_the_same_pass,
    sv_the_copy_of_a_conflict_goes_to_the_next_name_when_the_first_is_a_file_that_cannot_be_read,
    sv_a_file_edited_while_the_pass_runs_is_not_trashed,
    sv_a_file_edited_while_the_pass_runs_is_not_renamed,
    sv_a_file_edited_while_the_pass_runs_is_not_overwritten,
    sv_a_file_in_the_way_edited_while_the_pass_runs_is_left_alone,
    sv_a_rename_onto_a_file_without_a_base_keeps_that_file_as_a_copy,
    sv_two_conflicts_of_one_pass_are_both_in_the_report,
    sv_a_text_file_that_is_not_a_note_is_never_merged,
    sv_a_big_note_keeps_its_base_and_is_merged_in_chunks,
    sv_a_note_made_alike_on_two_computers_has_a_base_and_merges_later,
    sv_a_file_that_is_not_a_note_made_alike_has_no_base,
    sv_a_file_edited_while_the_pass_runs_is_not_kept_as_a_base,
    sv_the_copy_of_a_conflict_goes_to_the_next_name_when_the_first_is_a_folder,
    sv_the_server_version_saved_by_a_resync_is_not_written_twice,
    sv_a_folder_record_over_a_local_file_waits,
    sv_a_path_with_only_a_deleted_record_is_free_for_a_new_item,
    sv_a_file_the_server_deleted_and_we_deleted_comes_back_only_when_edited_elsewhere,
    sv_a_parked_file_that_finds_its_place_is_not_a_restored_one,
    sv_a_file_exactly_as_big_as_the_memory_limit_is_written_and_a_bigger_one_waits,
    sv_a_local_file_too_big_to_compare_holds_the_server_edit_back,
    sv_two_names_that_differ_by_case_are_not_both_written_in_one_pass,
    sv_a_folder_renamed_by_the_server_that_we_deleted_is_made_where_the_server_has_it,
    sv_a_folder_changed_by_the_server_without_a_rename_that_we_deleted_stays_deleted,
    sv_a_renamed_and_edited_file_that_the_server_has_with_the_same_text_is_not_a_conflict,
    sv_a_file_renamed_and_edited_alike_on_both_sides_goes_to_the_name_of_the_server,
);

/// A real defect of the engine found while the mutants of `apply_plan` were examined (see
/// docs/Road/sync-gates-survivors-report.md): a swap of two names that arrives together with an
/// independent rename is left half done under a service name. Red on the current engine, so it is
/// ignored until the engine is mended; run it with `--ignored`.
#[test]
#[ignore = "a defect of the engine, not yet mended: see docs/Road/sync-gates-survivors-report.md"]
fn sv_a_swap_of_two_names_with_an_independent_rename_is_finished() {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "S/a.md", "AAA");
    w.save(0, "S/b.md", "BBB");
    w.save(0, "S/c.md", "CCC");
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_rename("S/a.md", "S/tmp.md");
    w.pass(0);
    w.dev(0).fs.user_rename("S/b.md", "S/a.md");
    w.pass(0);
    w.dev(0).fs.user_rename("S/tmp.md", "S/b.md");
    w.dev(0).fs.user_rename("S/c.md", "S/d.md");
    w.pass(0);
    w.pass(1);
    for d in 0..2 {
        let texts = w.texts(d);
        assert_eq!(texts.get("S/a.md").map(String::as_str), Some("BBB"), "device {d}: {texts:?}");
        assert_eq!(texts.get("S/b.md").map(String::as_str), Some("AAA"), "device {d}: {texts:?}");
        assert_eq!(texts.get("S/d.md").map(String::as_str), Some("CCC"), "device {d}: {texts:?}");
        assert!(texts.keys().all(|p| !p.contains("amby-swap")), "{texts:?}");
    }
}
