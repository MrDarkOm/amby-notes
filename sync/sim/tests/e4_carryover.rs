//! Carried over from stage Э3 (review of 23.10) into Э4: a file the system will not open stops
//! only itself; a rename to a name this system cannot hold does not upload the file a second
//! time; the copy of the second item on one path (Д71) is in the list of conflicts (Д47).
//! Real engine only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::engine::names::NameProblem;
use amby_sync_core::engine::{ConflictKind, FsError, ItemErrorKind, UnsyncedReason};

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

fn access_a_file_that_cannot_be_read_is_listed_and_the_rest_goes_on(_b: EngineBuilder) {
    // Э4 (from Э3): one unreadable file must not stop the pass; the rest is sent, the file is
    // listed with its reason, and it goes as soon as it can be read.
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/ok.md", "fine");
    w.save(0, "Notes/locked.md", "secret");
    w.dev(0).fs.set_access_denied("Notes/locked.md", true);
    let report = w.pass(0);
    let files = w.server_files();
    assert!(files.contains_key("Keep/k.md"));
    assert!(files.contains_key("Notes/ok.md"));
    assert!(
        !files.contains_key("Notes/locked.md"),
        "not readable, not sent"
    );
    assert_eq!(
        unsynced(&w, 0),
        vec![("Notes/locked.md".to_string(), UnsyncedReason::NoAccess)]
    );
    assert_eq!(report.unsynced.len(), 1, "the report shows the list too");
    assert!(w.dev(0).fs.exists("Notes/locked.md"), "nothing was removed");

    // Still locked: a second pass changes nothing and does not fail.
    let head = w.server_head();
    w.pass(0);
    assert_eq!(w.server_head(), head);

    // Unlocked: it goes, and the list is empty again.
    w.dev(0).fs.set_access_denied("Notes/locked.md", false);
    w.pass(0);
    assert_eq!(
        w.server_files().get("Notes/locked.md").map(|b| text(b)),
        Some("secret".to_string())
    );
    assert!(unsynced(&w, 0).is_empty());
    w.finish(false);
}

fn access_an_incoming_file_the_system_refuses_fails_that_item_only(_b: EngineBuilder) {
    // Э4 (from Э3): a write the system refuses for one path is an error of that item (like a
    // full disk, С4); the other files of the batch are written, the cursor does not pass the
    // failed item, and the next pass delivers it.
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.pass(1);
    w.save(0, "a.md", "AAA");
    w.save(0, "b.md", "BBB");
    w.pass(0);
    w.dev(1).fs.set_access_denied("a.md", true);
    let report = w.dev(1).sync().expect("the pass must not fail as a whole");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(
        w.read(1, "b.md").as_deref(),
        Some("BBB"),
        "the other file arrived"
    );
    assert!(!w.dev(1).fs.exists("a.md"));
    assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
    assert!(
        matches!(
            &report.errors[0].kind,
            ItemErrorKind::Disk(FsError::AccessDenied(_))
        ),
        "{:?}",
        report.errors[0].kind
    );
    w.dev(1).fs.set_access_denied("a.md", false);
    w.pass(1);
    assert_eq!(w.read(1, "a.md").as_deref(), Some("AAA"));
    w.finish(false);
}

fn rename_to_a_name_windows_cannot_hold_does_not_upload_the_file_again(_b: EngineBuilder) {
    // Э4 (from Э3), Р9, Д62: Linux renames `Notes/a.md` to `Notes/a:b.md`. The Windows device
    // cannot create that name, so its file stays where it is; the server must not get a second
    // item for it under the old path, now or on any later pass.
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(2).with_fs(vec![Vfs::linux(), Vfs::windows()]),
    );
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/a:b.md");
    w.pass(0);
    let items = w.server_item_count();
    let head = w.server_head();

    w.pass(1);
    w.pass(1);
    w.pass(1);

    assert_eq!(w.server_head(), head, "nothing was uploaded");
    assert_eq!(
        w.server_item_count(),
        items,
        "no duplicate item on the server"
    );
    assert_eq!(
        w.read(1, "Notes/a.md").as_deref(),
        Some("base"),
        "the file stays where it is, content intact"
    );
    assert_eq!(
        unsynced(&w, 1),
        vec![(
            "Notes/a:b.md".to_string(),
            UnsyncedReason::InvalidName(NameProblem::WindowsForbiddenChar(':'))
        )]
    );
    // The user renames it on Linux to a name Windows can hold; it arrives there.
    w.dev(0).fs.user_rename("Notes/a:b.md", "Notes/ab.md");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/ab.md").as_deref(), Some("base"));
    assert!(unsynced(&w, 1).is_empty());
}

fn rename_to_a_name_windows_cannot_hold_is_not_uploaded_again_after_a_full_reconcile(
    _b: EngineBuilder,
) {
    // Э4 (from Э3), Р9, Р10: after a full reconcile (the answer "resync", or a lost state) the
    // Windows device holds `Notes/a.md` with no record, and the server's item of the same
    // content has the name `Notes/a:b.md`, which Windows cannot hold. The file is that item, not
    // a new one: it is not uploaded under its old path, however many passes follow.
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(2).with_fs(vec![Vfs::linux(), Vfs::windows()]),
    );
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/a:b.md");
    w.pass(0);
    let items = w.server_item_count();
    let head = w.server_head();

    let report = w.pass_with(
        1,
        Approvals {
            resync: true,
            ..Default::default()
        },
    );
    assert_eq!(report.uploaded, 0, "nothing is uploaded");
    w.pass(1);
    w.pass(1);

    assert_eq!(w.server_head(), head, "the server got no commit");
    assert_eq!(
        w.server_item_count(),
        items,
        "no duplicate item on the server"
    );
    assert!(!w.server_files().contains_key("Notes/a.md"));
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    assert_eq!(
        unsynced(&w, 1),
        vec![(
            "Notes/a:b.md".to_string(),
            UnsyncedReason::InvalidName(NameProblem::WindowsForbiddenChar(':'))
        )]
    );
    // Edited here, it is a different content: it goes up as its own file, and nothing is lost.
    w.save(1, "Notes/a.md", "edited on windows");
    w.pass(1);
    assert_eq!(
        w.server_files().get("Notes/a.md").map(|b| text(b)),
        Some("edited on windows".to_string())
    );
    assert_eq!(
        w.server_files().get("Notes/a:b.md").map(|b| text(b)),
        Some("base".to_string())
    );
}

fn d71_the_copy_of_the_second_item_on_one_path_is_in_the_list_of_conflicts(_b: EngineBuilder) {
    // Э4 (from Э3), Д71, Д47, Г20: two live items end up at one path (another device moved one onto
    // the other). The path stays with the item of the smaller id on every device, the other goes
    // into a conflict set (it moves to the `other` file of the set), and that conflict is in the
    // list until the user resolves it.
    let w = two(Engine::boxed);
    let low = ItemId::from_bytes([1; 16]);
    let high = ItemId::from_bytes([2; 16]);
    w.inject_file(&low, 0, "x.md", b"low");
    w.inject_file(&high, 0, "y.md", b"high");
    w.pass(1);
    assert_eq!(w.read(1, "y.md").as_deref(), Some("high"));
    let body = w.versions_at("y.md")[0].header.body_id.unwrap();
    w.inject_rename(&high, 1, "x.md", b"high", &body);

    w.pass(1);
    let texts = w.texts(1);
    assert_eq!(
        texts.get("x.md").map(String::as_str),
        Some("low"),
        "{texts:?}"
    );
    assert!(!texts.contains_key("y.md"), "{texts:?}");
    assert!(w.old_copies(1).is_empty(), "{texts:?}");
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1, "one set: {texts:?}");
    assert_eq!(sets[0].other, b"high");
    assert_eq!(sets[0].path, "x.md");
    assert_eq!(sets[0].kind, "bothCreated");
    let copy_path = &format!(".amby/conflicts/{}/other.md", sets[0].id);
    assert_eq!(texts.get(copy_path).map(String::as_str), Some("high"));

    let conflicts = w.dev(1).state.snapshot().conflicts;
    assert_eq!(conflicts.len(), 1, "{conflicts:?}");
    assert_eq!(conflicts[0].kind, ConflictKind::BothCreated);
    assert_eq!(conflicts[0].original_path, "x.md");
    assert_eq!(&conflicts[0].copy_path, copy_path);
    assert_eq!(conflicts[0].id, sets[0].id);

    // It stays in the list on later passes (no duplicate entry), until it is resolved.
    w.pass(1);
    assert_eq!(w.dev(1).state.snapshot().conflicts.len(), 1);
    let id = conflicts[0].id.clone();
    w.dev(1).resolve_conflict(&id).unwrap();
    assert!(w.dev(1).state.snapshot().conflicts.is_empty());
    w.pass(1);
    assert!(w.dev(1).state.snapshot().conflicts.is_empty());
}

real_only!(
    access_a_file_that_cannot_be_read_is_listed_and_the_rest_goes_on,
    access_an_incoming_file_the_system_refuses_fails_that_item_only,
    rename_to_a_name_windows_cannot_hold_does_not_upload_the_file_again,
    rename_to_a_name_windows_cannot_hold_is_not_uploaded_again_after_a_full_reconcile,
    d71_the_copy_of_the_second_item_on_one_path_is_in_the_list_of_conflicts,
);
