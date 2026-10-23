//! Names on different systems (Р9; appendix В, Д61–Д64) and what is not synchronised (Р4, Д11).
//! The mini-engine has no rules of names, so these run against the real engine only (red now).
//! The devices differ in their file systems: Linux, Windows rules, macOS (case-insensitive,
//! NFC and NFD are one name).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::engine::names::NameProblem;
use amby_sync_core::engine::{NameRules, UnsyncedReason};

fn linux_and(second: Vfs) -> World {
    World::new(
        Engine::boxed,
        WorldOptions::new(2).with_fs(vec![Vfs::linux(), second]),
    )
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

fn p9_names_windows_cannot_hold_stay_on_the_server(_b: EngineBuilder) {
    // Р9, Д62, Д64, С13-like safety: a file whose name Windows cannot create does not appear
    // there, is listed as "not synchronised" with the reason, stays on the server and on the
    // other device, and nothing is renamed silently.
    let w = linux_and(Vfs::windows());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/ok.md", "fine");
    w.save(0, "Notes/a:b.md", "colon");
    w.save(0, "Notes/CON.txt", "device name");
    w.save(0, "Notes/trailing.", "dot");
    w.pass(0);
    let report = w.pass(1);
    let files: Vec<String> = w.dev(1).fs.files().into_keys().collect();
    assert_eq!(
        files,
        vec!["Keep/k.md", "Notes/ok.md"],
        "only the creatable names appear"
    );
    assert_eq!(
        unsynced(&w, 1),
        vec![
            (
                "Notes/CON.txt".to_string(),
                UnsyncedReason::InvalidName(NameProblem::ReservedName("CON.txt".into()))
            ),
            (
                "Notes/a:b.md".to_string(),
                UnsyncedReason::InvalidName(NameProblem::WindowsForbiddenChar(':'))
            ),
            (
                "Notes/trailing.".to_string(),
                UnsyncedReason::InvalidName(NameProblem::TrailingDotOrSpace)
            ),
        ]
    );
    assert_eq!(report.unsynced.len(), 3, "the report shows the list too");
    assert!(
        !w.dev(1)
            .fs
            .events()
            .iter()
            .any(|e| matches!(e, FsEvent::Refused { .. })),
        "the engine must not even try to create such a name"
    );
    assert_eq!(
        w.server_files().len(),
        5,
        "the server and the other device keep all of them"
    );
    assert!(w.dev(0).fs.exists("Notes/a:b.md"));
    // Nothing changes on a second pass, and the list stays.
    let head = w.server_head();
    w.pass(1);
    assert_eq!(w.server_head(), head);
    assert_eq!(unsynced(&w, 1).len(), 3);
    // The user renames it where it can be, and it arrives.
    w.dev(0).fs.user_rename("Notes/a:b.md", "Notes/ab.md");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/ab.md").as_deref(), Some("colon"));
    assert_eq!(unsynced(&w, 1).len(), 2);
}

fn p9_too_long_names_stay_where_they_were_made(_b: EngineBuilder) {
    // Р9, Д62: a segment over 255 bytes cannot be created here.
    let w = linux_and(Vfs::macos());
    let long = format!("Notes/{}.md", "n".repeat(300));
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/short.md", "ok");
    // The linux device may hold it in this simulation only if its rules allow: raise its limit.
    w.dev(0).fs.set_rules(NameRules {
        max_segment_bytes: 400,
        max_path_bytes: 1000,
        ..NameRules::linux()
    });
    w.save(0, &long, "too long for the other system");
    w.pass(0);
    w.pass(1);
    assert!(!w.dev(1).fs.files().contains_key(&long));
    assert_eq!(
        unsynced(&w, 1),
        vec![(
            long,
            UnsyncedReason::InvalidName(NameProblem::SegmentTooLong)
        )]
    );
    assert_eq!(w.read(1, "Notes/short.md").as_deref(), Some("ok"));
}

fn p9_names_that_differ_only_in_case_do_not_share_a_mac(_b: EngineBuilder) {
    // Р9, Д63: `Note.md` came first; `note.md` made later elsewhere is not written on a
    // case-insensitive system, is listed as a collision, and stays on the server untouched.
    let w = linux_and(Vfs::macos());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/Note.md", "capital");
    w.pass(0);
    w.pass(1);
    w.save(0, "Notes/note.md", "small");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/Note.md").as_deref(), Some("capital"));
    assert_eq!(w.dev(1).fs.files().len(), 2, "keep and Note.md only");
    assert_eq!(
        unsynced(&w, 1),
        vec![(
            "Notes/note.md".to_string(),
            UnsyncedReason::CaseCollision {
                with: "Notes/Note.md".into()
            }
        )]
    );
    assert_eq!(w.server_files().len(), 3);
    // The same two names are two files on Linux.
    let w2 = World::new(Engine::boxed, WorldOptions::new(2));
    w2.save(0, "Keep/k.md", "keep");
    w2.save(0, "Notes/Note.md", "capital");
    w2.save(0, "Notes/note.md", "small");
    w2.pass(0);
    w2.pass(1);
    assert_eq!(w2.read(1, "Notes/note.md").as_deref(), Some("small"));
    assert_eq!(w2.read(1, "Notes/Note.md").as_deref(), Some("capital"));
    assert!(unsynced(&w2, 1).is_empty());
}

fn p9_macos_names_in_nfd_are_stored_and_sent_in_nfc(_b: EngineBuilder) {
    // Р9, Д61: macOS gives NFD; the header path is NFC, so the file is one file everywhere, and
    // a later change from the other device lands in the same local file.
    let w = linux_and(Vfs::macos());
    let nfd = "Notes/Cafe\u{301}.md";
    let nfc = "Notes/Caf\u{e9}.md";
    w.save(0, "Keep/k.md", "keep");
    w.dev(1).fs.user_write("Keep/k.md", b"keep");
    w.dev(1).fs.user_write(nfd, b"from the mac");
    w.pass(1);
    assert!(
        w.server_files().contains_key(nfc),
        "the server path is NFC: {:?}",
        w.server_files().keys()
    );
    w.pass(0);
    assert_eq!(w.read(0, nfc).as_deref(), Some("from the mac"));
    w.save(0, nfc, "edited on linux");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.dev(1).fs.stored_name(nfd).as_deref(),
        Some(nfd),
        "the spelling on the mac is not touched"
    );
    assert_eq!(w.dev(1).fs.files().len(), 2, "no second file appeared");
    assert_eq!(w.read(1, nfd).as_deref(), Some("edited on linux"));
    let head = w.server_head();
    w.pass(1);
    assert_eq!(
        w.server_head(),
        head,
        "the NFD spelling is not a new change"
    );
}

fn p4_service_files_stay_out_and_listed_amby_files_go(_b: EngineBuilder) {
    // Р4, Д11: `.git`, `.obsidian`, `.trash`, temporary files and system litter are never
    // synchronised; from `.amby/` only the documented files.
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    for path in [
        "Notes/a.md",
        ".DS_Store",
        "Notes/Thumbs.db",
        "._x",
        ".git/config",
        "sub/.git/HEAD",
        ".obsidian/app.json",
        ".trash/old.md",
        ".amby/notes.db",
        ".amby/history/h.md",
        ".amby/unknown.json",
        ".a.md.amby-tmp-5",
        ".amby/properties.json",
        ".amby/blocks/b.json",
        ".amby/graph-layout.json",
        ".amby/property-backups/p.json",
    ] {
        w.save(0, path, &format!("content of {path}"));
    }
    w.pass(0);
    let mut on_server: Vec<String> = w.server_files().into_keys().collect();
    on_server.sort();
    assert_eq!(
        on_server,
        vec![
            ".amby/blocks/b.json",
            ".amby/graph-layout.json",
            ".amby/properties.json",
            ".amby/property-backups/p.json",
            "Keep/k.md",
            "Notes/a.md",
        ]
    );
    assert!(
        w.dev(0).state.snapshot().unsynced.is_empty(),
        "silent exclusions are not in the list"
    );
    w.pass(1);
    assert!(!w.dev(1).fs.exists(".git/config"));
    assert!(!w.dev(1).fs.exists(".amby/notes.db"));
    assert_eq!(
        w.read(1, ".amby/properties.json").as_deref(),
        Some("content of .amby/properties.json")
    );
}

fn p4_links_and_odd_names_are_listed_not_synchronised(_b: EngineBuilder) {
    // Р4, Д11, Д64: a symbolic link and a name that is not UTF-8 are listed.
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.dev(0).fs.user_symlink("Notes/link");
    w.dev(0).fs.user_not_utf8("Notes/bad-\u{fffd}.md");
    w.pass(0);
    let list = unsynced(&w, 0);
    assert!(
        list.contains(&("Notes/link".to_string(), UnsyncedReason::Symlink)),
        "{list:?}"
    );
    assert!(
        list.iter().any(|(_, r)| *r == UnsyncedReason::NotUtf8),
        "{list:?}"
    );
    assert_eq!(w.server_files().len(), 1);
}

fn p4_a_file_the_server_cannot_take_is_listed(_b: EngineBuilder) {
    // Р4, Д11, П8: a body larger than the limit of the server after encryption.
    let w = World::new(Engine::boxed, WorldOptions::new(2).max_blob_bytes(100_000));
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/huge.bin", &"x".repeat(150_000));
    w.save(0, "Big/fits.bin", &"y".repeat(50_000));
    w.pass(0);
    assert_eq!(
        unsynced(&w, 0),
        vec![("Big/huge.bin".to_string(), UnsyncedReason::TooLarge)]
    );
    let on_server = w.server_files();
    assert!(on_server.contains_key("Big/fits.bin"));
    assert!(!on_server.contains_key("Big/huge.bin"));
}

fn p4_an_excluded_path_from_another_client_is_not_written(_b: EngineBuilder) {
    // Р4, Д11: the rule is ours: a record that arrives with an excluded path is not written to
    // the disk, and is listed.
    let w = pair_with_a(Engine::boxed);
    w.inject_file(
        &amby_sync_core::crypto::keys::ItemId::from_bytes([9; 16]),
        0,
        ".git/config",
        b"[core]",
    );
    w.inject_file(
        &amby_sync_core::crypto::keys::ItemId::from_bytes([8; 16]),
        0,
        "Notes/ordinary.md",
        b"fine",
    );
    w.pass(1);
    assert!(!w.dev(1).fs.exists(".git/config"));
    assert_eq!(w.read(1, "Notes/ordinary.md").as_deref(), Some("fine"));
    assert_eq!(
        unsynced(&w, 1),
        vec![(".git/config".to_string(), UnsyncedReason::ExcludedPath)]
    );
}

fn d49_a_foreign_rename_onto_an_untracked_local_file_keeps_both(_b: EngineBuilder) {
    // Р7, Д49, Д51: the name is taken by a file the server does not know: that file becomes a
    // conflict copy, the renamed file gets the name.
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.pass(0);
    w.save(1, "Notes/b.md", "mine, created here");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("base"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    let copies = w.copies(1, "Notes/b.md");
    assert_eq!(copies.len(), 1, "{:?}", w.texts(1));
    assert_eq!(
        copies.values().next().map(String::as_str),
        Some("mine, created here")
    );
    w.finish(false);
}

fn d49_two_names_swapped_by_the_server_arrive_without_a_collision(_b: EngineBuilder) {
    // Р2, Д49: a swap of two names in one commit is applied in an order that frees each target;
    // no copies, nothing left over.
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "a.md", "AAA");
    w.save(0, "b.md", "BBB");
    w.pass(0);
    w.pass(1);
    let (item_a, va) = w.item_at("a.md");
    let (item_b, vb) = w.item_at("b.md");
    let body_a = w.versions_at("a.md")[0].header.body_id.unwrap();
    let body_b = w.versions_at("b.md")[0].header.body_id.unwrap();
    let space = w.space(0);
    let moved_a = space.file_with_uploaded_body(&item_a, va, "b.md", b"AAA", &body_a);
    let moved_b = space.file_with_uploaded_body(&item_b, vb, "a.md", b"BBB", &body_b);
    space.commit_ok(&[moved_a, moved_b]);
    w.pass(1);
    assert_eq!(w.read(1, "a.md").as_deref(), Some("BBB"));
    assert_eq!(w.read(1, "b.md").as_deref(), Some("AAA"));
    assert_eq!(w.dev(1).fs.files().len(), 3, "no copies");
    assert!(unsynced(&w, 1).is_empty());
    w.finish(false);
}

real_only!(
    p9_names_windows_cannot_hold_stay_on_the_server,
    p9_too_long_names_stay_where_they_were_made,
    p9_names_that_differ_only_in_case_do_not_share_a_mac,
    p9_macos_names_in_nfd_are_stored_and_sent_in_nfc,
    p4_service_files_stay_out_and_listed_amby_files_go,
    p4_links_and_odd_names_are_listed_not_synchronised,
    p4_a_file_the_server_cannot_take_is_listed,
    p4_an_excluded_path_from_another_client_is_not_written,
    d49_a_foreign_rename_onto_an_untracked_local_file_keeps_both,
    d49_two_names_swapped_by_the_server_arrive_without_a_collision,
);
