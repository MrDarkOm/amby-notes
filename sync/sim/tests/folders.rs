//! Folders (Р2; appendix В, Д13, Д18, Д50): a folder is a record, an empty folder arrives, a
//! rename of a folder is one atomic commit up to the limit of the server and several commits
//! above it, and a receiver survives any order. The mini-engine has no folders: the real engine
//! only (red now).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

fn project(w: &World, d: usize, files: usize) {
    for i in 0..files {
        w.save(d, &format!("Proj/sub/f{i:03}.md"), &format!("file {i}"));
    }
}

fn r2_an_empty_folder_arrives(_b: EngineBuilder) {
    // Р2: folders are records so that empty folders reach other devices.
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("Empty/Inner");
    w.pass(0);
    w.pass(1);
    assert!(w.dev(1).fs.is_dir("Empty/Inner"));
    assert!(w.server_folders().contains("Empty/Inner"));
    w.finish(true);
}

fn r2_a_folder_rename_is_one_atomic_commit(_b: EngineBuilder) {
    // Р2, Д50, Д13: the folder and all its files change paths in one commit; the other device
    // never sees it half renamed; no new records, no trash, no copies.
    let w = pair_with_a(Engine::boxed);
    project(&w, 0, 6);
    w.pass(0);
    w.pass(1);
    let items = w.server_item_count();
    let head = w.server_head();
    w.dev(0).fs.user_rename("Proj", "Archive/Proj");
    w.pass(0);
    assert_eq!(w.server_head(), head + 1, "one commit for the whole folder");
    assert_eq!(w.server_item_count(), items, "renames, not new records");
    w.pass(1);
    for i in 0..6 {
        assert_eq!(
            w.read(1, &format!("Archive/Proj/sub/f{i:03}.md"))
                .as_deref(),
            Some(format!("file {i}").as_str())
        );
    }
    assert!(!w.dev(1).fs.exists("Proj"), "the old folder is gone");
    assert!(w.dev(1).fs.trash().is_empty());
    w.finish(true);
}

fn d13_equal_files_in_a_renamed_folder_are_paired_by_their_paths(_b: EngineBuilder) {
    // Д13: three empty files have one hash; the folder rename still keeps them three records.
    let w = pair_with_a(Engine::boxed);
    for name in ["a", "b", "c"] {
        w.save(0, &format!("Same/{name}.md"), "");
    }
    w.pass(0);
    w.pass(1);
    let items = w.server_item_count();
    w.dev(0).fs.user_rename("Same", "Renamed");
    w.pass(0);
    assert_eq!(w.server_item_count(), items);
    w.pass(1);
    for name in ["a", "b", "c"] {
        assert!(w.dev(1).fs.exists(&format!("Renamed/{name}.md")));
    }
    w.finish(true);
}

fn d13_a_single_file_moved_is_a_rename_but_two_equal_files_are_not(_b: EngineBuilder) {
    // Д13: with two missing and two new files of the same content the pairing is ambiguous: it
    // is two deletions and two creations — safe, nothing is lost.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "x1.md", "twin");
    w.save(0, "x2.md", "twin");
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_rename("x1.md", "y1.md");
    w.dev(0).fs.user_rename("x2.md", "y2.md");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "y1.md").as_deref(), Some("twin"));
    assert_eq!(w.read(1, "y2.md").as_deref(), Some("twin"));
    assert!(!w.dev(1).fs.exists("x1.md") && !w.dev(1).fs.exists("x2.md"));
    w.finish(true);
}

fn d13_a_rename_together_with_an_edit_is_a_deletion_and_a_creation(_b: EngineBuilder) {
    // Д13: the hash changed, so the engine does not guess; the content survives at the new name
    // and the old one goes to the trash of the other device.
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/c.md");
    w.save(0, "Notes/c.md", "renamed and edited");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/c.md").as_deref(),
        Some("renamed and edited")
    );
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert_eq!(w.dev(1).fs.trash().len(), 1);
    w.finish(true);
}

fn r2_a_deleted_folder_takes_its_files_to_the_trash(_b: EngineBuilder) {
    // Р2, Р8, Д52, Д17: files to the trash, then the empty folder is removed.
    let w = pair_with_a(Engine::boxed);
    project(&w, 0, 4);
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_delete("Proj");
    w.pass(0);
    w.pass(1);
    assert!(!w.dev(1).fs.exists("Proj"));
    assert_eq!(w.dev(1).fs.trash().len(), 4);
    w.finish(true);
}

fn d50_a_big_folder_rename_goes_in_several_commits_and_a_receiver_copes(_b: EngineBuilder) {
    // Р2, Д18, Д50: above the limit of the server (40 here) the rename is several commits, the
    // folder record first; a network failure between them leaves a visible half-way state that
    // breaks nothing, and a later pass finishes.
    let w = World::new(Engine::boxed, WorldOptions::new(2).max_commit_items(40));
    w.save(0, "Keep/k.md", "keep");
    project(&w, 0, 100);
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_rename("Proj", "Moved");
    let head = w.server_head();
    let mut commits = 0;
    w.dev(0).faults.net_rule(move |call| {
        if call.kind == RemoteKind::Commit {
            commits += 1;
            if commits == 2 {
                return NetFault::DropRequest;
            }
        }
        NetFault::None
    });
    assert!(w.dev(0).sync().is_err(), "the second commit did not arrive");
    assert_eq!(
        w.server_head(),
        head + 1,
        "only the first commit is on the server"
    );
    // The other device sees the half-way state.
    let report = w.pass(1);
    assert!(report.conflicts.is_empty() && report.errors.is_empty());
    assert!(w.dev(1).fs.files().keys().any(|p| p.starts_with("Moved/")));
    w.pass(0);
    assert!(
        w.server_head() >= head + 3,
        "101 records need at least three commits of 40"
    );
    w.finish(true);
    assert!(!w.dev(1).fs.exists("Proj"));
}

fn d50_local_files_left_in_a_renamed_folder_stay_and_become_new(_b: EngineBuilder) {
    // Д50: a file this device made inside the folder that was renamed elsewhere is not moved
    // and not lost; it becomes a new record at its own path.
    let w = pair_with_a(Engine::boxed);
    project(&w, 0, 3);
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_rename("Proj", "Archive");
    w.pass(0);
    w.save(1, "Proj/sub/extra.md", "made here meanwhile");
    w.pass(1);
    assert_eq!(w.read(1, "Archive/sub/f000.md").as_deref(), Some("file 0"));
    assert_eq!(
        w.read(1, "Proj/sub/extra.md").as_deref(),
        Some("made here meanwhile")
    );
    w.pass(0);
    assert_eq!(
        w.read(0, "Proj/sub/extra.md").as_deref(),
        Some("made here meanwhile")
    );
    w.finish(true);
}

real_only!(
    r2_an_empty_folder_arrives,
    r2_a_folder_rename_is_one_atomic_commit,
    d13_equal_files_in_a_renamed_folder_are_paired_by_their_paths,
    d13_a_single_file_moved_is_a_rename_but_two_equal_files_are_not,
    d13_a_rename_together_with_an_edit_is_a_deletion_and_a_creation,
    r2_a_deleted_folder_takes_its_files_to_the_trash,
    d50_a_big_folder_rename_goes_in_several_commits_and_a_receiver_copes,
    d50_local_files_left_in_a_renamed_folder_stay_and_become_new,
);
