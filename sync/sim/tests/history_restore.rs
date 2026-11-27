//! Appendix И of the plan, in the simulation (И7, И16): a version or a deleted file restored from
//! the server is an ordinary local write; the engine needs no new path for it. The helpers of
//! `amby_sync_sim::restore` do what the application does with the pure functions of the core
//! (`engine::history`), so these scenarios are red until those are written (раздел 6).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

const NOTE: &str = "Notes/n.md";

/// All the text that a device holds for a file: the file itself and the second versions kept in
/// conflict sets (К2). Nothing may drop out of this (Р7, К1).
fn everything_on(w: &World, d: usize, path: &str) -> Vec<String> {
    let mut all: Vec<String> = w.read(d, path).into_iter().collect();
    all.extend(w.others(d, path));
    all.extend(w.copies(d, path).into_values());
    all
}

fn has_text(all: &[String], text: &str) -> bool {
    all.iter().any(|t| t == text)
}

/// Both devices have `Notes/n.md` with `first`, then device 0 saves `second` (server version 2),
/// device 1 takes it.
fn two_versions(b: EngineBuilder, first: &str, second: &str) -> World {
    let w = pair_with_a(b);
    w.save(0, NOTE, first);
    w.pass(0);
    w.pass(1);
    w.save(0, NOTE, second);
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, NOTE).as_deref(), Some(second));
    w
}

// ----- И7: a restored old version, then somebody else's edit -----

fn i7_the_panel_lists_the_old_version_and_not_the_current_one(b: EngineBuilder) {
    // И1–И3 on the server of the simulation: the file now is the newest version and is not listed.
    let w = two_versions(b, "one\n", "two\n");
    let panel = w.history_panel(0, NOTE);
    let texts: Vec<u64> = panel.iter().map(|v| v.size).collect();
    assert!(
        panel.iter().all(|v| v.path == NOTE),
        "the note kept its path: {panel:?}"
    );
    assert!(
        !panel
            .iter()
            .any(|v| v.content_hash == amby_sync_sim::vfs::hash_of(b"two\n")),
        "the current content is not offered again: {texts:?}"
    );
    assert!(
        panel
            .iter()
            .any(|v| v.content_hash == amby_sync_sim::vfs::hash_of(b"one\n")),
        "the previous content is offered"
    );
    w.finish(false);
}

fn i7_a_restore_that_meets_a_foreign_edit_of_another_line_merges(b: EngineBuilder) {
    // И7, Р7, К1: A restores the old text, B has meanwhile edited the last line: both changes are
    // in the result, on both devices.
    let w = two_versions(b, "l1\nl2\nl3\n", "l1 X\nl2\nl3\n");
    w.save(1, NOTE, "l1 X\nl2\nl3 B\n");
    w.pass(1);
    let old = w
        .history_panel(0, NOTE)
        .into_iter()
        .find(|v| v.content_hash == amby_sync_sim::vfs::hash_of(b"l1\nl2\nl3\n"))
        .expect("the older text is in the panel")
        .version;
    w.restore_server_version(0, NOTE, old);
    assert_eq!(w.read(0, NOTE).as_deref(), Some("l1\nl2\nl3\n"));
    w.pass(0);
    assert_eq!(
        w.read(0, NOTE).as_deref(),
        Some("l1\nl2\nl3 B\n"),
        "the restored first line and the foreign third line are both there"
    );
    w.pass(1);
    assert_eq!(w.read(1, NOTE).as_deref(), Some("l1\nl2\nl3 B\n"));
    assert!(w.old_copies(0).is_empty());
    w.finish(false);
}

fn i7_a_restore_that_meets_a_foreign_edit_of_the_same_line_loses_nothing(b: EngineBuilder) {
    // И7, Р7, К1: the same line on both sides is a conflict; neither text is lost.
    let w = two_versions(b, "line\n", "line, second\n");
    w.save(1, NOTE, "line, edited by B\n");
    w.pass(1);
    let old = w
        .history_panel(0, NOTE)
        .into_iter()
        .find(|v| v.content_hash == amby_sync_sim::vfs::hash_of(b"line\n"))
        .expect("the older text is in the panel")
        .version;
    w.restore_server_version(0, NOTE, old);
    w.pass(0);
    let on_a = everything_on(&w, 0, NOTE);
    assert!(
        has_text(&on_a, "line\n"),
        "the restored text survives: {on_a:?}"
    );
    assert!(
        has_text(&on_a, "line, edited by B\n"),
        "the foreign edit survives: {on_a:?}"
    );
    w.finish(false);
}

fn i7_a_restore_nobody_else_touched_goes_up_as_an_ordinary_edit(b: EngineBuilder) {
    // И7, Р3: the restored text becomes the next version on top of the current one.
    let w = two_versions(b, "one\n", "two\n");
    let head = w.server_head();
    let old = w
        .history_panel(0, NOTE)
        .into_iter()
        .find(|v| v.content_hash == amby_sync_sim::vfs::hash_of(b"one\n"))
        .expect("the older text is in the panel")
        .version;
    let before = w.versions_at(NOTE).len();
    w.restore_server_version(0, NOTE, old);
    w.pass(0);
    assert!(w.server_head() > head, "the restore was sent");
    assert_eq!(w.versions_at(NOTE).len(), before + 1, "one new version");
    assert_eq!(
        w.server_files().get(NOTE).map(|b| text(b)).as_deref(),
        Some("one\n")
    );
    w.pass(1);
    assert_eq!(w.read(1, NOTE).as_deref(), Some("one\n"));
    w.finish(false);
}

// ----- И16: a restored deleted file -----

fn i16_a_restored_deleted_file_reaches_the_other_device_and_stays(b: EngineBuilder) {
    // И16: deleted on A, B trashed it; A restores it from the server; B gets it; nobody deletes
    // it again however many rounds follow.
    let w = pair_with_a(b);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.pass(1);
    assert!(!w.dev(1).fs.exists("Notes/a.md"), "B moved it to the trash");

    let rows = w.deleted_on_server(0);
    let row = rows
        .iter()
        .find(|row| row.path == "Notes/a.md")
        .expect("the archive of the server lists the deleted file");
    w.restore_deleted_file(0, &row.item_id);
    assert_eq!(w.read(0, "Notes/a.md").as_deref(), Some("base"));

    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    for _ in 0..3 {
        w.round();
    }
    assert_eq!(w.read(0, "Notes/a.md").as_deref(), Some("base"));
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    assert_eq!(
        w.server_files()
            .get("Notes/a.md")
            .map(|b| text(b))
            .as_deref(),
        Some("base"),
        "the server holds it as a living file"
    );
    w.finish(false);
}

fn i16_a_restored_file_is_not_offered_again_from_the_server(b: EngineBuilder) {
    // И11, И16: once the file lies at its path with its content, the archive of the server does
    // not list it any more.
    let w = pair_with_a(b);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    let item = w
        .deleted_on_server(0)
        .into_iter()
        .find(|row| row.path == "Notes/a.md")
        .expect("listed")
        .item_id;
    w.restore_deleted_file(0, &item);
    assert!(
        w.deleted_on_server(0)
            .iter()
            .all(|row| row.path != "Notes/a.md"),
        "already restored"
    );
    w.finish(false);
}

fn i16_a_restored_file_survives_a_full_reconcile_of_the_other_device(b: EngineBuilder) {
    // И16, Д58, П32: device B was away so long that its cursor is behind the cleanup; it
    // reconciles everything and the restored file stays on both devices.
    let w = World::new(b, WorldOptions::new(2).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/x.md", "will be deleted, then restored");
    w.round();
    w.round();
    w.dev(0).fs.user_delete("Notes/x.md");
    w.pass(0);
    let item = w
        .deleted_on_server(0)
        .into_iter()
        .find(|row| row.path == "Notes/x.md")
        .expect("listed")
        .item_id;
    w.restore_deleted_file(0, &item);
    w.pass(0);
    w.control()
        .advance(std::time::Duration::from_secs(31 * 24 * 3600));
    w.control().run_maintenance();
    let report = w.pass(1);
    assert!(report.full_reconcile, "the feed said there is a gap");
    assert_eq!(
        w.read(1, "Notes/x.md").as_deref(),
        Some("will be deleted, then restored"),
        "nothing is deleted on a gap"
    );
    assert!(w.dev(1).fs.trash().is_empty());
    w.round();
    w.round();
    assert_eq!(
        w.read(0, "Notes/x.md").as_deref(),
        Some("will be deleted, then restored")
    );
    w.finish(false);
}

real_only!(
    i7_the_panel_lists_the_old_version_and_not_the_current_one,
    i7_a_restore_that_meets_a_foreign_edit_of_another_line_merges,
    i7_a_restore_that_meets_a_foreign_edit_of_the_same_line_loses_nothing,
    i7_a_restore_nobody_else_touched_goes_up_as_an_ordinary_edit,
    i16_a_restored_deleted_file_reaches_the_other_device_and_stays,
    i16_a_restored_file_is_not_offered_again_from_the_server,
    i16_a_restored_file_survives_a_full_reconcile_of_the_other_device,
);
