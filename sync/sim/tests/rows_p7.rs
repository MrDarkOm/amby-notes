//! Every row of the table Р7 as a rule of the engine (appendix В, Д21–Д47): two devices, a file
//! `Notes/a.md` that both have, and what happens when each side changes it differently. Each
//! scenario runs against the real engine (red until it is written) and against the correct
//! mini-engine (green: the scenario can be satisfied). After every scenario the invariants of
//! раздел 7 are checked: convergence, nothing lost, the server is blind, no silent replacement.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::engine::ConflictKind;
use amby_sync_core::engine::SnapshotReason;

fn live_paths_on_server(w: &World) -> Vec<String> {
    w.server_files().into_keys().collect()
}

// ----- the table, in the order of appendix В -----

fn d21_nothing_changed(b: EngineBuilder) {
    // Р7, Д21, Р10: nothing changed on either side, so nothing is written, sent or moved.
    let w = pair_with_a(b);
    let head = w.server_head();
    w.dev(0).fs.clear_events();
    w.dev(1).fs.clear_events();
    for d in 0..2 {
        let report = w.pass(d);
        assert_eq!(
            report.downloaded + report.uploaded + report.renamed + report.trashed,
            0,
            "device {d} did something although nothing changed"
        );
        assert!(
            disk_changes(&w, d).is_empty(),
            "device {d}: {:?}",
            disk_changes(&w, d)
        );
    }
    assert_eq!(
        w.server_head(),
        head,
        "a pass without changes committed something"
    );
    w.finish(false);
}

fn d22_own_edit_goes_up(b: EngineBuilder) {
    // Р7, Д22, О7: an edit on one device arrives on the other byte for byte, as a new version of
    // the same item (not a new item).
    let w = pair_with_a(b);
    let (item, version) = w.item_at("Notes/a.md");
    w.save(0, "Notes/a.md", "version two");
    w.pass(0);
    assert_eq!(
        w.item_at("Notes/a.md"),
        (item, version + 1),
        "an edit is the next version of the same item"
    );
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("version two"));
    assert!(w.copies(1, "Notes/a.md").is_empty(), "no conflict, no copy");
    w.finish(false);
}

fn d23_own_rename_goes_up_without_the_body(b: EngineBuilder) {
    // Р7, Д23, Д48: a rename is a new version of the same item with the same body and hash; the
    // content is not uploaded again.
    let w = pair_with_a(b);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.pass(0);
    let versions = w.versions_at("Notes/b.md");
    assert_eq!(versions.len(), 2, "one item with two versions");
    assert_eq!(versions[0].header.path, "Notes/b.md");
    assert_eq!(versions[1].header.path, "Notes/a.md");
    assert_eq!(
        versions[0].header.body_id, versions[1].header.body_id,
        "the body is reused (П30)"
    );
    assert_eq!(
        versions[0].header.content_hash,
        versions[1].header.content_hash
    );
    w.pass(1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("base"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert!(w.dev(1).fs.trash().is_empty(), "a rename is not a deletion");
    w.finish(false);
}

fn d24_own_deletion_goes_up_and_lands_in_the_trash(b: EngineBuilder) {
    // Р7, Д24, Д52, О4: a deletion arrives on another device as a move to the trash.
    let w = pair_with_a(b);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.pass(1);
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    let trash = w.dev(1).fs.trash();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].bytes, b"base");
    w.finish(false);
}

fn d25_foreign_edit_replaces_the_file_with_a_snapshot(b: EngineBuilder) {
    // Р7, Д25, Д53, О4: the file is replaced by the new version and the old content stays in the
    // history with the reason `sync-overwrite`.
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "from the other device");
    w.pass(0);
    let head = w.server_head();
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/a.md").as_deref(),
        Some("from the other device")
    );
    let history = w.dev(1).fs.history();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].bytes, b"base");
    assert_eq!(history[0].reason, SnapshotReason::SyncOverwrite);
    assert_eq!(w.server_head(), head, "the receiving device sends nothing");
    w.finish(false);
}

fn d26_foreign_rename_moves_the_file(b: EngineBuilder) {
    // Р7, Д26: a rename elsewhere moves the file here, into a new folder if needed.
    let w = pair_with_a(b);
    w.dev(0).fs.user_rename("Notes/a.md", "Archive/2026/b.md");
    w.pass(0);
    let head = w.server_head();
    w.pass(1);
    assert_eq!(w.read(1, "Archive/2026/b.md").as_deref(), Some("base"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert!(w.dev(1).fs.trash().is_empty());
    assert_eq!(w.server_head(), head);
    w.finish(false);
}

fn d27_foreign_rename_and_edit(b: EngineBuilder) {
    // Р7, Д27: the server version has a new name and new content: both arrive.
    let w = pair_with_a(b);
    let (item, version) = w.item_at("Notes/a.md");
    w.inject_file(
        &item,
        version,
        "Notes/b.md",
        b"renamed and edited elsewhere",
    );
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/b.md").as_deref(),
        Some("renamed and edited elsewhere")
    );
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert_eq!(
        w.dev(1).fs.history().len(),
        1,
        "the old content is in the history"
    );
    w.finish(false);
}

fn d28_foreign_deletion_unchanged_file_goes_to_the_trash(b: EngineBuilder) {
    // Р7, Д28, Р8, Д52: an unchanged file deleted elsewhere goes to the trash of this vault.
    let w = pair_with_a(b);
    let (item, version) = w.item_at("Notes/a.md");
    w.inject_delete(&item, version, "Notes/a.md");
    w.pass(1);
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert_eq!(w.dev(1).fs.trash()[0].bytes, b"base");
    w.finish(false);
}

fn d29_both_edited_the_same_place_keeps_the_second_version_in_a_set(b: EngineBuilder) {
    // Р7 строка 1, Д29, Д47, Г2, Г20–Г22, О5: the path stays with whoever reached the server
    // first; the other version lies in `.amby/conflicts/<id>/` (not beside the file), together
    // with the common base; both exist on all devices.
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "zero");
    w.save(1, "Notes/a.md", "one");
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(
        w.read(1, "Notes/a.md").as_deref(),
        Some("zero"),
        "the first to reach the server keeps the path"
    );
    assert!(
        w.old_copies(1).is_empty(),
        "no copy beside the file (Г20): {:?}",
        w.texts(1)
    );
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1, "exactly one set: {:?}", w.texts(1));
    let set = &sets[0];
    assert_eq!(set.kind, "bothEdited");
    assert_eq!(set.path, "Notes/a.md");
    assert_eq!(set.other, b"one");
    assert_eq!(
        set.base.as_deref(),
        Some(&b"base"[..]),
        "the common base (Г21)"
    );
    assert_eq!(report.conflicts.len(), 1);
    let conflict = &report.conflicts[0];
    assert_eq!(conflict.kind, ConflictKind::BothEdited);
    assert_eq!(conflict.original_path, "Notes/a.md");
    assert_eq!(conflict.id.len(), 12, "the id of the set");
    assert_eq!(conflict.id, set.id);
    assert_eq!(
        conflict.copy_path,
        format!(".amby/conflicts/{}/other.md", set.id),
        "the record points at the file with the second version (Г25)"
    );
    assert!(report.merged_paths.is_empty(), "a conflict is not a merge");
    let history = w.dev(1).fs.history();
    assert!(history
        .iter()
        .any(|h| h.bytes == b"one" && h.reason == SnapshotReason::SyncOverwrite));
    w.pass(0);
    assert_eq!(w.sets(0).len(), 1, "the other device gets the set too");
    assert_eq!(w.others(0, "Notes/a.md"), vec!["one".to_string()]);
    assert_eq!(
        w.server_item_count(),
        5,
        "keep, a.md and the three files of the set"
    );
    w.finish(false);
}

fn d29_same_edit_on_both_is_no_conflict(b: EngineBuilder) {
    // Р7, Д29, Д15: both made the same change: the versions are linked, no copy.
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "identical");
    w.save(1, "Notes/a.md", "identical");
    w.pass(0);
    w.dev(1).fs.clear_events();
    let report = w.pass(1);
    assert!(report.conflicts.is_empty());
    assert!(w.copies(1, "Notes/a.md").is_empty());
    assert!(
        disk_changes(&w, 1).is_empty(),
        "nothing is written for identical content"
    );
    w.finish(false);
}

fn d30_foreign_rename_and_own_edit_merge(b: EngineBuilder) {
    // Р7 строка 2, Д30: one renamed, the other edited: both survive, new name and new content,
    // no copy, one item.
    let w = pair_with_a(b);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.pass(0);
    w.save(1, "Notes/a.md", "edited here");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("edited here"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert!(w.copies(1, "Notes/b.md").is_empty());
    assert_eq!(
        w.server_files()
            .get("Notes/b.md")
            .map(|b| text(b))
            .as_deref(),
        Some("edited here")
    );
    assert_eq!(
        w.versions_at("Notes/b.md").len(),
        3,
        "one item: created, renamed, edited"
    );
    w.pass(0);
    assert_eq!(w.read(0, "Notes/b.md").as_deref(), Some("edited here"));
    w.finish(false);
}

fn d31_foreign_rename_and_edit_against_own_edit(b: EngineBuilder) {
    // Р7, Д31, Д46, Г20: the server renamed and changed, this device changed: the server version is
    // at the server's path, the own version in a set that names that path.
    let w = pair_with_a(b);
    let (item, version) = w.item_at("Notes/a.md");
    w.inject_file(&item, version, "Notes/b.md", b"server side");
    w.save(1, "Notes/a.md", "local side");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("server side"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert!(w.old_copies(1).is_empty(), "{:?}", w.texts(1));
    assert_eq!(w.others(1, "Notes/b.md"), vec!["local side".to_string()]);
    assert_eq!(w.sets(1)[0].kind, "bothEdited");
    w.finish(false);
}

fn d32_edit_beats_deletion(b: EngineBuilder) {
    // Р7 строка 4, Д32, О5: deleted on one device, edited on the other: the edit wins, the file
    // comes back on every device as the same item.
    let w = pair_with_a(b);
    let (item, _) = w.item_at("Notes/a.md");
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.save(1, "Notes/a.md", "still needed");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("still needed"));
    assert!(
        w.dev(1).fs.trash().is_empty(),
        "an edited file never goes to the trash"
    );
    assert_eq!(
        w.item_at("Notes/a.md").0,
        item,
        "the same item is undeleted"
    );
    w.pass(0);
    assert_eq!(w.read(0, "Notes/a.md").as_deref(), Some("still needed"));
    w.finish(false);
}

fn d33_own_rename_and_foreign_edit_merge(b: EngineBuilder) {
    // Р7 строка 2, Д33: the other way round: the name is ours, the content is the server's.
    let w = pair_with_a(b);
    w.dev(1).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.save(0, "Notes/a.md", "edited there");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("edited there"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert!(w.copies(1, "Notes/b.md").is_empty());
    assert_eq!(
        w.server_files()
            .get("Notes/b.md")
            .map(|b| text(b))
            .as_deref(),
        Some("edited there")
    );
    assert_eq!(w.versions_at("Notes/b.md").len(), 3);
    w.pass(0);
    assert_eq!(w.read(0, "Notes/b.md").as_deref(), Some("edited there"));
    w.finish(false);
}

fn d34_both_renamed_differently_the_server_name_stays(b: EngineBuilder) {
    // Р7 строка 3, Д34: two names for one file: the name from the server stays, the content is
    // the same, nothing is lost.
    let w = pair_with_a(b);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/x.md");
    w.dev(1).fs.user_rename("Notes/a.md", "Notes/y.md");
    w.pass(0);
    let head = w.server_head();
    w.pass(1);
    assert_eq!(w.read(1, "Notes/x.md").as_deref(), Some("base"));
    assert!(!w.dev(1).fs.exists("Notes/y.md"));
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert_eq!(w.server_head(), head, "the losing name is not sent");
    w.finish(false);
}

fn d34_both_renamed_the_same_way_is_one_name(b: EngineBuilder) {
    // Р7, Д34, Д15: the same new name on both: linked, nothing happens.
    let w = pair_with_a(b);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/x.md");
    w.dev(1).fs.user_rename("Notes/a.md", "Notes/x.md");
    w.pass(0);
    let head = w.server_head();
    w.pass(1);
    assert_eq!(w.read(1, "Notes/x.md").as_deref(), Some("base"));
    assert_eq!(w.server_head(), head);
    w.finish(false);
}

fn d35_own_rename_against_foreign_rename_and_edit(b: EngineBuilder) {
    // Р7, Д35: the server's name and the server's content win together.
    let w = pair_with_a(b);
    let (item, version) = w.item_at("Notes/a.md");
    w.inject_file(&item, version, "Notes/x.md", b"new content");
    w.dev(1).fs.user_rename("Notes/a.md", "Notes/y.md");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/x.md").as_deref(), Some("new content"));
    assert!(!w.dev(1).fs.exists("Notes/y.md"));
    assert!(w.dev(1).fs.history().iter().any(|h| h.bytes == b"base"));
    w.finish(false);
}

fn d36_rename_counts_as_a_change_against_deletion(b: EngineBuilder) {
    // Р7, Р8, Д36, Д52: deleted on one device, renamed on the other: the rename is a change, so
    // the file is not deleted; it comes back under the new name with a fresh body.
    let w = pair_with_a(b);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.dev(1).fs.user_rename("Notes/a.md", "Notes/y.md");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/y.md").as_deref(), Some("base"));
    assert!(w.dev(1).fs.trash().is_empty());
    let versions = w.versions_at("Notes/y.md");
    assert_eq!(versions.len(), 3, "created, deleted, restored");
    assert!(!versions[0].header.deleted);
    assert_ne!(
        versions[0].header.body_id, versions[2].header.body_id,
        "a fresh body (Д36)"
    );
    w.pass(0);
    assert_eq!(w.read(0, "Notes/y.md").as_deref(), Some("base"));
    w.finish(false);
}

fn d37_foreign_edit_beats_own_deletion(b: EngineBuilder) {
    // Р7 строка 4, Д37: deleted here, edited elsewhere: the file is created again from the
    // server version and the deletion is not sent.
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "edited there");
    w.pass(0);
    w.dev(1).fs.user_delete("Notes/a.md");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("edited there"));
    assert!(
        w.versions_at("Notes/a.md")
            .iter()
            .all(|v| !v.header.deleted),
        "the server never saw a deletion"
    );
    w.finish(false);
}

fn d38_foreign_rename_beats_own_deletion(b: EngineBuilder) {
    // Р7, Д38: deleted here, renamed elsewhere: the file comes back under the server's name.
    let w = pair_with_a(b);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.pass(0);
    w.dev(1).fs.user_delete("Notes/a.md");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("base"));
    assert!(w
        .versions_at("Notes/b.md")
        .iter()
        .all(|v| !v.header.deleted));
    w.finish(false);
}

fn d39_foreign_rename_and_edit_beat_own_deletion(b: EngineBuilder) {
    // Р7, Д39: as Д38, with a changed content too.
    let w = pair_with_a(b);
    let (item, version) = w.item_at("Notes/a.md");
    w.inject_file(&item, version, "Notes/b.md", b"both changed");
    w.dev(1).fs.user_delete("Notes/a.md");
    w.pass(1);
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("both changed"));
    w.finish(false);
}

fn d40_both_deleted(b: EngineBuilder) {
    // Р7, Д40: deleted on both: nothing to do, nothing is sent, nothing lands in the trash.
    let w = pair_with_a(b);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.dev(1).fs.user_delete("Notes/a.md");
    let head = w.server_head();
    w.pass(1);
    assert_eq!(w.server_head(), head);
    assert!(w.dev(1).fs.trash().is_empty());
    assert!(!live_paths_on_server(&w).contains(&"Notes/a.md".to_string()));
    w.finish(false);
}

fn d41_new_foreign_file_is_created_without_a_snapshot(b: EngineBuilder) {
    // Р7, Д41, Д53: a file that did not exist here is created; there is nothing to snapshot.
    let w = pair_with_a(b);
    w.save(0, "Ideas/new.md", "fresh");
    w.pass(0);
    w.dev(1).fs.clear_events();
    w.pass(1);
    assert_eq!(w.read(1, "Ideas/new.md").as_deref(), Some("fresh"));
    assert!(
        w.dev(1).fs.history().is_empty(),
        "creating a file makes no snapshot"
    );
    w.finish(false);
}

fn d42_same_file_created_twice_is_one_file(b: EngineBuilder) {
    // Р7, Д42, Д15, Р10: the same content at the same path on two devices: linked, no copy, no
    // second item.
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "c.md", "same");
    w.save(1, "Keep/k.md", "keep");
    w.save(1, "c.md", "same");
    w.pass(0);
    w.dev(1).fs.clear_events();
    let report = w.pass(1);
    assert!(report.conflicts.is_empty());
    assert!(w.copies(1, "c.md").is_empty());
    assert!(disk_changes(&w, 1).is_empty());
    assert_eq!(w.server_item_count(), 2);
    w.finish(false);
}

fn d43_created_twice_the_second_goes_into_a_set_without_a_base(b: EngineBuilder) {
    // Р7 строка 5, Д43, Д46, Г10, Г20, О5: two different files created at one path: the one that
    // reached the server first keeps the name, the other goes into a set; there is no common
    // version, so the set has no base; both are everywhere.
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "c.md", "zero");
    w.save(1, "Keep/k.md", "keep");
    w.save(1, "c.md", "one");
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(w.read(1, "c.md").as_deref(), Some("zero"));
    assert!(w.old_copies(1).is_empty(), "{:?}", w.texts(1));
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1, "{:?}", w.texts(1));
    assert_eq!(sets[0].other, b"one");
    assert_eq!(sets[0].kind, "bothCreated");
    assert_eq!(sets[0].path, "c.md");
    assert!(sets[0].base.is_none(), "nothing was common (Г21)");
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].kind, ConflictKind::BothCreated);
    assert!(
        report.merged_paths.is_empty(),
        "two new files are never merged (Г4)"
    );
    assert!(w.dev(1).fs.history().iter().any(|h| h.bytes == b"one"));
    w.pass(0);
    assert_eq!(w.others(0, "c.md"), vec!["one".to_string()]);
    w.finish(false);
}

fn d44_deleted_record_without_base(b: EngineBuilder) {
    // Р7, Д44: a server record that was deleted before this device ever saw it: nothing is
    // created, nothing lands in the trash, and an unrelated local file at that path stays and is
    // uploaded as a new item.
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "d.md", "short-lived");
    w.pass(0);
    w.dev(0).fs.user_delete("d.md");
    w.pass(0);
    w.save(1, "d.md", "new life");
    w.pass(1);
    assert_eq!(w.read(1, "d.md").as_deref(), Some("new life"));
    assert!(w.dev(1).fs.trash().is_empty());
    assert_eq!(
        w.server_files().get("d.md").map(|b| text(b)).as_deref(),
        Some("new life")
    );
    assert_eq!(
        w.server_item_count(),
        3,
        "keep, the deleted item and the new one"
    );
    w.pass(0);
    assert_eq!(w.read(0, "d.md").as_deref(), Some("new life"));
    w.finish(false);
}

fn d44_deleted_record_alone_creates_nothing(b: EngineBuilder) {
    // Р7, Д44: a device that comes later sees only a tombstone: no file appears.
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "d.md", "short-lived");
    w.pass(0);
    w.dev(0).fs.user_delete("d.md");
    w.pass(0);
    w.pass(1);
    assert!(!w.dev(1).fs.exists("d.md"));
    assert!(w.dev(1).fs.trash().is_empty());
    assert_eq!(w.read(1, "Keep/k.md").as_deref(), Some("keep"));
    w.finish(false);
}

fn d45_new_local_file_becomes_a_new_item(b: EngineBuilder) {
    // Р7, Д45: a new local file is a new item at version 1; the other device gets it byte for byte.
    let w = pair_with_a(b);
    let before = w.server_item_count();
    let content = "x".repeat(70_000);
    w.save(0, "Deep/er/new.md", &content);
    w.pass(0);
    assert_eq!(w.server_item_count(), before + 1);
    assert_eq!(w.versions_at("Deep/er/new.md").len(), 1);
    w.pass(1);
    assert_eq!(
        w.read(1, "Deep/er/new.md"),
        Some(content),
        "a body over one chunk arrives intact (О7)"
    );
    w.finish(false);
}

fn d47_a_conflict_stays_in_the_list_until_resolved(b: EngineBuilder) {
    // Р7, Д47: every conflict stays in the list until the user resolves it.
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "zero");
    w.save(1, "Notes/a.md", "one");
    w.pass(0);
    w.pass(1);
    let conflicts = w.dev(1).state.snapshot().conflicts;
    assert_eq!(conflicts.len(), 1);
    w.pass(1);
    w.pass(1);
    assert_eq!(
        w.dev(1).state.snapshot().conflicts.len(),
        1,
        "later passes do not drop it"
    );
    w.dev(1)
        .resolve_conflict(&conflicts[0].id)
        .expect("resolve");
    assert!(w.dev(1).state.snapshot().conflicts.is_empty());
    assert_eq!(
        w.sets(1).len(),
        1,
        "resolving the entry does not delete the files of the set"
    );
    w.finish(false);
}

fn d46_a_repeat_after_a_crash_makes_the_same_set(b: EngineBuilder) {
    // Р7, Д46, Д4, С3, Г22, Г23: the process dies while a conflict is being made; the repeat makes
    // the same set (its name is deterministic) and no second one.
    let reference = {
        let w = pair_with_a(b);
        w.save(0, "Notes/a.md", "zero");
        w.save(1, "Notes/a.md", "one");
        w.pass(0);
        w.pass(1);
        w.sets(1)[0].id.clone()
    };
    for crash_at in 1..200 {
        let w = pair_with_a(b);
        w.save(0, "Notes/a.md", "zero");
        w.save(1, "Notes/a.md", "one");
        w.pass(0);
        w.dev(1).faults.crash_at(crash_at);
        let _ = w.dev(1).sync();
        let calls_made = w.dev(1).faults.calls();
        w.finish(false);
        let sets = w.sets(1);
        assert_eq!(
            sets.len(),
            1,
            "a crash at call {crash_at} left {:?}",
            w.texts(1)
        );
        assert_eq!(
            sets[0].id, reference,
            "the same name after a crash at {crash_at}"
        );
        assert_eq!(sets[0].other, b"one");
        assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("zero"));
        assert!(w.old_copies(1).is_empty());
        if calls_made < crash_at {
            break; // the pass ended before the crash point: every point was visited
        }
    }
}

both!(
    d21_nothing_changed,
    d22_own_edit_goes_up,
    d23_own_rename_goes_up_without_the_body,
    d24_own_deletion_goes_up_and_lands_in_the_trash,
    d25_foreign_edit_replaces_the_file_with_a_snapshot,
    d26_foreign_rename_moves_the_file,
    d27_foreign_rename_and_edit,
    d28_foreign_deletion_unchanged_file_goes_to_the_trash,
    d29_both_edited_the_same_place_keeps_the_second_version_in_a_set,
    d29_same_edit_on_both_is_no_conflict,
    d30_foreign_rename_and_own_edit_merge,
    d31_foreign_rename_and_edit_against_own_edit,
    d32_edit_beats_deletion,
    d33_own_rename_and_foreign_edit_merge,
    d34_both_renamed_differently_the_server_name_stays,
    d34_both_renamed_the_same_way_is_one_name,
    d35_own_rename_against_foreign_rename_and_edit,
    d36_rename_counts_as_a_change_against_deletion,
    d37_foreign_edit_beats_own_deletion,
    d38_foreign_rename_beats_own_deletion,
    d39_foreign_rename_and_edit_beat_own_deletion,
    d40_both_deleted,
    d41_new_foreign_file_is_created_without_a_snapshot,
    d42_same_file_created_twice_is_one_file,
    d43_created_twice_the_second_goes_into_a_set_without_a_base,
    d44_deleted_record_without_base,
    d44_deleted_record_alone_creates_nothing,
    d45_new_local_file_becomes_a_new_item,
    d47_a_conflict_stays_in_the_list_until_resolved,
    d46_a_repeat_after_a_crash_makes_the_same_set,
);
