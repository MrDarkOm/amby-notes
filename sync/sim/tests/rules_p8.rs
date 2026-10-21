//! The rules of Р8 as scenarios (appendix В, Д52–Д60): deletion only of what did not change,
//! always to the trash; a snapshot before every replacement; a stop before a mass change, in both
//! directions; a vault folder that is gone or empty; a server that was reset or restored from an
//! old copy; a server that shows an older version; a gap in the feed; unfinished journals.
//! Each runs against the real engine (red now) and the correct mini-engine (green).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::needless_range_loop)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::engine::{Direction, PlannedKind};
use amby_sync_sim::fault::RemoteKind as Kind;

/// Two devices that hold `Keep/k.md` and `count` files `Bulk/f-NNN.md`, all synchronised.
fn big(b: EngineBuilder, count: usize) -> World {
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    for i in 0..count {
        w.save(
            0,
            &format!("Bulk/f-{i:03}.md"),
            &format!("file {i} version 1"),
        );
    }
    w.pass(0);
    w.pass(1);
    assert_eq!(w.dev(1).fs.files().len(), count + 1);
    w
}

fn delete_files(w: &World, d: usize, n: usize) -> Vec<String> {
    let paths: Vec<String> = (0..n).map(|i| format!("Bulk/f-{i:03}.md")).collect();
    for path in &paths {
        w.dev(d).fs.user_delete(path);
    }
    paths
}

fn edit_files(w: &World, d: usize, n: usize) {
    for i in 0..n {
        w.save(
            d,
            &format!("Bulk/f-{i:03}.md"),
            &format!("file {i} version 2"),
        );
    }
}

// ----- Д52, Д53: deletion and snapshots -----

fn d53_every_replacement_makes_a_snapshot_and_a_new_file_does_not(b: EngineBuilder) {
    // Р8, О4, Д53: each replacement of an existing file goes through a snapshot of the old
    // content; the creation of a new file has nothing to save.
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "v2");
    w.save(0, "Notes/new.md", "brand new");
    w.pass(0);
    w.dev(1).fs.clear_events();
    w.pass(1);
    let publishes: Vec<_> = w
        .dev(1)
        .fs
        .events()
        .into_iter()
        .filter_map(|e| match e {
            FsEvent::Publish {
                path,
                old,
                snapshot,
            } => Some((path, old, snapshot)),
            _ => None,
        })
        .collect();
    assert_eq!(publishes.len(), 2, "{publishes:?}");
    for (path, old, snapshot) in publishes {
        match old {
            Some(_) => assert!(snapshot, "{path} was replaced without a snapshot"),
            None => assert!(!snapshot, "{path} is new, nothing to snapshot"),
        }
    }
    assert_eq!(w.dev(1).fs.history().len(), 1);
    w.finish(false);
}

fn d52_the_trash_keeps_what_was_deleted_elsewhere(b: EngineBuilder) {
    // Р8, О4, Д52: a deletion from another device never destroys: the content is in the trash,
    // can be put back, and the server keeps its versions too.
    let w = pair_with_a(b);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.pass(1);
    let trash = w.dev(1).fs.trash();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].bytes, b"base");
    let versions = w.versions_at("Notes/a.md");
    assert!(
        versions
            .iter()
            .any(|v| v.content.as_deref() == Some(&b"base"[..])),
        "the server keeps the old version (О4)"
    );
    w.finish(false);
}

// ----- Д54: mass changes -----

fn d54_default_threshold_outgoing_twenty_of_two_hundred_goes(b: EngineBuilder) {
    // Р8, О6, Д54: the plan's own numbers: 20 deletions of 200 files are not "more than 10%".
    let w = big(b, 199);
    delete_files(&w, 0, 20);
    let head = w.server_head();
    w.pass(0);
    assert!(w.server_head() > head, "the deletions were sent");
    w.pass(1);
    assert_eq!(w.dev(1).fs.trash().len(), 20);
    w.finish_light();
}

fn d54_default_threshold_outgoing_twenty_one_of_two_hundred_stops(b: EngineBuilder) {
    // Р8, О6, Д54: 21 of 200 is more than 10%: the pass stops before sending anything and shows
    // the list; the approval lets it go once.
    let w = big(b, 199);
    let paths = delete_files(&w, 0, 21);
    let head = w.server_head();
    let state_before = w.dev(0).state.snapshot();
    let StopReason::MassChange { direction, files } = w.stop(0) else {
        panic!("not a mass-change stop");
    };
    assert_eq!(direction, Direction::Outgoing);
    assert_eq!(files.len(), 21);
    assert!(files.iter().all(|f| f.kind == PlannedKind::SendDelete));
    let mut listed: Vec<String> = files.into_iter().map(|f| f.path).collect();
    listed.sort();
    assert_eq!(listed, paths, "the list names exactly the deleted files");
    assert_eq!(w.server_head(), head, "nothing was sent");
    assert_eq!(
        w.dev(0).state.snapshot().items,
        state_before.items,
        "the bases did not change"
    );
    let report = w.pass_with(
        0,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.server_head() > head);
    // The deletions are a mass change for the other device as well (Д54, incoming).
    assert!(matches!(
        w.stop(1),
        StopReason::MassChange {
            direction: Direction::Incoming,
            ..
        }
    ));
    w.pass_with(
        1,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    w.finish_light();
}

fn d54_default_threshold_incoming_twenty_one_of_two_hundred_stops_and_applies_nothing(
    b: EngineBuilder,
) {
    // Р8, О6, Д54: 21 overwrites of 200 files stop the pass before the first one; not even the
    // unrelated change that came with them is applied; the state does not move.
    let w = big(b, 199);
    edit_files(&w, 0, 21);
    w.save(0, "Ideas/unrelated.md", "small change");
    w.pass(0);
    let files = w.dev(1).fs.files();
    let state = w.dev(1).state.snapshot();
    let StopReason::MassChange {
        direction,
        files: listed,
    } = w.stop(1)
    else {
        panic!("not a mass-change stop");
    };
    assert_eq!(direction, Direction::Incoming);
    assert_eq!(listed.len(), 21);
    assert!(listed.iter().all(|f| f.kind == PlannedKind::Overwrite));
    assert_eq!(w.dev(1).fs.files(), files, "nothing was written");
    assert!(w.dev(1).fs.trash().is_empty());
    assert!(w.dev(1).fs.history().is_empty());
    assert_eq!(
        w.dev(1).state.snapshot(),
        state,
        "the state did not move (cursor included)"
    );
    let report = w.pass_with(
        1,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(
        w.read(1, "Bulk/f-020.md").as_deref(),
        Some("file 20 version 2")
    );
    assert_eq!(
        w.read(1, "Ideas/unrelated.md").as_deref(),
        Some("small change")
    );
    w.finish_light();
}

/// A world with `count` bulk files and the keep file, and the threshold "at least 2 files".
fn scaled(b: EngineBuilder, count: usize) -> World {
    let w = big(b, count);
    w.scale_mass_threshold(2);
    w
}

fn d54_outgoing_two_of_twenty_goes(b: EngineBuilder) {
    // Р8, Д54: 2 of 20 is exactly 10%, not "more than 10%" (the threshold is scaled to 2 files).
    let w = scaled(b, 19);
    delete_files(&w, 0, 2);
    assert_eq!(w.pass(0).outcome, CycleOutcome::Done);
    w.finish_light();
}

fn d54_outgoing_three_of_twenty_stops(b: EngineBuilder) {
    // Р8, Д54: 3 of 20 is 15%.
    let w = scaled(b, 19);
    delete_files(&w, 0, 3);
    assert!(matches!(
        w.stop(0),
        StopReason::MassChange {
            direction: Direction::Outgoing,
            ..
        }
    ));
}

fn d54_outgoing_two_of_nineteen_stops(b: EngineBuilder) {
    // Р8, Д54: 2 of 19 is above 10% by a hair.
    let w = scaled(b, 18);
    delete_files(&w, 0, 2);
    assert!(matches!(
        w.stop(0),
        StopReason::MassChange {
            direction: Direction::Outgoing,
            ..
        }
    ));
}

fn d54_outgoing_below_the_minimum_goes(b: EngineBuilder) {
    // Р8, Д54: one file is far above 10% of 5, but fewer than the minimum: no stop.
    let w = scaled(b, 4);
    delete_files(&w, 0, 1);
    assert_eq!(w.pass(0).outcome, CycleOutcome::Done);
    w.finish_light();
}

fn d54_incoming_two_of_twenty_goes(b: EngineBuilder) {
    // Р8, Д54: 2 overwrites of 20 files: exactly 10%.
    let w = scaled(b, 19);
    edit_files(&w, 0, 2);
    w.pass(0);
    assert_eq!(w.pass(1).outcome, CycleOutcome::Done);
    w.finish_light();
}

fn d54_incoming_three_of_twenty_stops(b: EngineBuilder) {
    // Р8, Д54: 3 overwrites of 20.
    let w = scaled(b, 19);
    edit_files(&w, 0, 3);
    w.pass(0);
    assert!(matches!(
        w.stop(1),
        StopReason::MassChange {
            direction: Direction::Incoming,
            ..
        }
    ));
}

fn d54_incoming_two_of_nineteen_stops(b: EngineBuilder) {
    // Р8, Д54: 2 overwrites of 19.
    let w = scaled(b, 18);
    edit_files(&w, 0, 2);
    w.pass(0);
    assert!(matches!(
        w.stop(1),
        StopReason::MassChange {
            direction: Direction::Incoming,
            ..
        }
    ));
}

fn d54_incoming_deletions_count_as_well(b: EngineBuilder) {
    // Р8, О6, Д54: files deleted elsewhere would go to the trash here: the same stop, and the
    // list says "trash" (5 of 40 with the threshold scaled to 2 files).
    let w = scaled(b, 39);
    delete_files(&w, 0, 5);
    w.pass_with(
        0,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    let files = w.dev(1).fs.files();
    let StopReason::MassChange {
        direction,
        files: listed,
    } = w.stop(1)
    else {
        panic!("not a mass-change stop");
    };
    assert_eq!(direction, Direction::Incoming);
    assert!(listed.iter().all(|f| f.kind == PlannedKind::Trash));
    assert_eq!(w.dev(1).fs.files(), files);
    assert!(w.dev(1).fs.trash().is_empty());
}

fn d54_creations_and_renames_do_not_count(b: EngineBuilder) {
    // Р8, Д54: only overwrites and deletions count: 30 new files and then 30 renames go through
    // in single passes.
    let w = pair_with_a(b);
    for i in 0..30 {
        w.save(0, &format!("New/n-{i:02}.md"), &format!("new file {i}"));
    }
    assert_eq!(w.pass(0).outcome, CycleOutcome::Done);
    assert_eq!(w.pass(1).outcome, CycleOutcome::Done);
    for i in 0..30 {
        w.dev(0)
            .fs
            .user_rename(&format!("New/n-{i:02}.md"), &format!("Moved/m-{i:02}.md"));
    }
    assert_eq!(w.pass(0).outcome, CycleOutcome::Done);
    assert_eq!(w.pass(1).outcome, CycleOutcome::Done);
    assert_eq!(w.read(1, "Moved/m-07.md").as_deref(), Some("new file 7"));
    assert!(w.dev(1).fs.trash().is_empty());
    w.finish(false);
}

fn d54_the_approval_lasts_one_pass(b: EngineBuilder) {
    // Р8, Д54, Д60: an approval is spent by the pass it was given to; the next mass change stops
    // again.
    let w = scaled(b, 39);
    edit_files(&w, 0, 5);
    w.pass(0);
    let first = w.pass_with(
        1,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    assert_eq!(first.outcome, CycleOutcome::Done);
    for i in 0..5 {
        w.save(
            0,
            &format!("Bulk/f-{i:03}.md"),
            &format!("file {i} version 3"),
        );
    }
    w.pass_with(
        0,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    assert!(matches!(
        w.stop(1),
        StopReason::MassChange {
            direction: Direction::Incoming,
            ..
        }
    ));
}

// ----- Д55: the vault folder -----

fn d55_a_missing_folder_is_not_a_deletion(b: EngineBuilder) {
    // Р8, С8, Д55: the disk with the vault is gone: the pass stops, sends nothing, even with
    // every approval; when the disk is back nothing was deleted anywhere.
    let w = pair_with_a(b);
    let head = w.server_head();
    w.dev(0).fs.set_root_present(false);
    assert_eq!(w.stop(0), StopReason::VaultMissing);
    let approved = w
        .dev(0)
        .sync_with(&CycleRequest {
            approvals: Approvals {
                mass_change: true,
                accept_empty_vault: true,
                resync: true,
            },
        })
        .unwrap();
    assert_eq!(
        approved.outcome,
        CycleOutcome::Stopped(StopReason::VaultMissing),
        "not approvable"
    );
    assert_eq!(w.server_head(), head);
    w.dev(0).fs.set_root_present(true);
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    assert!(w.dev(1).fs.trash().is_empty());
    w.finish(false);
}

fn d55_an_empty_folder_asks_before_anything_is_deleted(b: EngineBuilder) {
    // Р8, С8, Д55: the folder is there but has nothing in it while the state has files: stop,
    // nothing sent; confirmed, the deletions go (they are under the mass threshold here).
    let w = pair_with_a(b);
    let head = w.server_head();
    for path in w.dev(0).fs.files().keys() {
        w.dev(0).fs.user_delete(path);
    }
    assert_eq!(w.stop(0), StopReason::VaultEmpty);
    assert_eq!(w.server_head(), head);
    let report = w.pass_with(
        0,
        Approvals {
            accept_empty_vault: true,
            ..Default::default()
        },
    );
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.server_head() > head);
    w.pass(1);
    assert!(w.dev(1).fs.files().is_empty());
    assert_eq!(w.dev(1).fs.trash().len(), 2);
}

fn d55_a_new_device_with_an_empty_folder_is_normal(b: EngineBuilder) {
    // Р8, Д55, Р10: nothing in the state, nothing in the folder: that is simply a new device and
    // it downloads.
    let w = pair_with_a(b);
    let third = three(b);
    third.save(0, "Keep/k.md", "keep");
    third.pass(0);
    assert!(w.dev(1).fs.exists("Notes/a.md"));
    third.pass(1);
    assert_eq!(third.read(1, "Keep/k.md").as_deref(), Some("keep"));
}

// ----- Д56: a reset server -----

fn d56_the_first_pass_remembers_the_server(b: EngineBuilder) {
    // Р10, Д56: the first pass stores the `instance_id` and does not stop.
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    assert!(w.dev(0).state.snapshot().instance_id.is_some());
}

fn d56_a_reset_server_stops_the_pass_and_keeps_every_file(b: EngineBuilder) {
    // Р8, С7, Д56, О4: the server lost its data: an empty server is never a command to delete;
    // the pass stops; the user's answer "upload this vault again" uploads, deleting nothing.
    let mut w = World::new(b, WorldOptions::new(2).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.save(0, "Notes/b.md", "second");
    w.round();
    w.round();
    let before: Vec<_> = (0..2).map(|d| w.dev(d).fs.files()).collect();
    w.reset_server();
    for d in 0..2 {
        let StopReason::ServerReset { old, new } = w.stop(d) else {
            panic!("device {d} did not stop on a reset server");
        };
        assert_ne!(old, new);
        assert_eq!(
            w.dev(d).fs.files(),
            before[d],
            "device {d}: local files must stay"
        );
        assert!(w.dev(d).fs.trash().is_empty());
        let state = w.dev(d).state.snapshot();
        assert!(
            matches!(w.stop(d), StopReason::ServerReset { .. }),
            "stopping again is the same"
        );
        assert_eq!(
            w.dev(d).state.snapshot(),
            state,
            "a stop does not touch the state"
        );
    }
    assert_eq!(
        w.server_head(),
        0,
        "the devices wrote nothing to the reset server"
    );
    for d in 0..2 {
        let report = w.dev(d).sync_approved().unwrap();
        assert_eq!(report.outcome, CycleOutcome::Done);
    }
    w.finish(false);
    assert_eq!(w.server_files().len(), 3);
    assert_eq!(w.dev(1).fs.files(), before[1]);
}

fn d56_a_server_restored_from_an_old_copy_stops(b: EngineBuilder) {
    // Р8, С7, Д56: the same instance, but its head is below our cursor: stop, files untouched.
    let mut w = World::new(b, WorldOptions::new(2).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.round();
    w.round();
    let backup = w.backup_server();
    w.save(0, "Notes/later.md", "after the copy");
    w.round();
    w.round();
    let before: Vec<_> = (0..2).map(|d| w.dev(d).fs.files()).collect();
    w.restore_server(&backup);
    for d in 0..2 {
        let reason = w.stop(d);
        assert!(
            matches!(reason, StopReason::ServerBehind { head, cursor } if head < cursor),
            "device {d}: {reason:?}"
        );
        assert_eq!(w.dev(d).fs.files(), before[d]);
    }
    for d in 0..2 {
        w.dev(d).sync_approved().unwrap();
    }
    w.finish(false);
    assert_eq!(
        w.read(0, "Notes/later.md").as_deref(),
        Some("after the copy")
    );
    assert_eq!(
        w.read(1, "Notes/later.md").as_deref(),
        Some("after the copy")
    );
}

// ----- Д57: rollback -----

fn d57_an_older_version_stops_the_pass_and_changes_nothing(b: EngineBuilder) {
    // Р6, Р8, С6, Д57: the server shows version 2 of a file the device already has at version 3:
    // stop, warning, nothing is applied.
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "second");
    w.pass(0);
    w.save(0, "Notes/a.md", "third");
    w.pass(0);
    w.pass(1);
    let (item, version) = w.item_at("Notes/a.md");
    assert_eq!(version, 3);
    let older = stale_entry(&w, &item, 2);
    w.save(
        0,
        "Ideas/other.md",
        "a change that arrives in the same pass",
    );
    w.pass(0);
    let files = w.dev(1).fs.files();
    let state = w.dev(1).state.snapshot();
    w.dev(1).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        page.changes.retain(|c| c.item_id != older.item_id);
        page.changes.push(older.clone());
        page
    }));
    match w.stop(1) {
        StopReason::Rollback {
            item_id,
            known,
            got,
        } => {
            assert_eq!(item_id, item);
            assert_eq!((known, got), (3, 2));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        w.dev(1).fs.files(),
        files,
        "not even the honest change was applied"
    );
    assert_eq!(w.dev(1).state.snapshot(), state);
    w.dev(1).lies.borrow_mut().changes = None;
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("third"));
    assert_eq!(
        w.read(1, "Ideas/other.md").as_deref(),
        Some("a change that arrives in the same pass")
    );
    w.finish(false);
}

fn d57_a_deleted_item_shown_alive_again_stops(b: EngineBuilder) {
    // Р6, С6, Д57, Д3: the tombstone is remembered: an older live version of a deleted item is a
    // rollback too.
    let w = pair_with_a(b);
    let (item, _) = w.item_at("Notes/a.md");
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.pass(1);
    let older = stale_entry(&w, &item, 1);
    w.dev(1).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        page.changes.retain(|c| c.item_id != older.item_id);
        page.changes.push(older.clone());
        page
    }));
    assert!(matches!(w.stop(1), StopReason::Rollback { .. }));
    assert!(
        !w.dev(1).fs.exists("Notes/a.md"),
        "the file did not come back"
    );
}

fn d57_the_same_version_with_other_content_stops(b: EngineBuilder) {
    // Р6, Д57: the same version number, but another path: the server is not telling the truth.
    let w = pair_with_a(b);
    let (item, version) = w.item_at("Notes/a.md");
    let mut entry = stale_entry(&w, &item, version);
    let mut header = w.versions_at("Notes/a.md")[0].header.clone();
    header.path = "Notes/other.md".into();
    entry.header = amby_sync_core::crypto::header::seal_header(
        &w.vk,
        &w.space_id,
        &item,
        &header,
        &mut SimRandom(7),
    )
    .unwrap();
    w.dev(1).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        page.changes.retain(|c| c.item_id != entry.item_id);
        page.changes.push(entry.clone());
        page
    }));
    assert!(matches!(w.stop(1), StopReason::Rollback { .. }));
}

/// The entry of `versions` for version `version` of `item`, as the server once gave it.
fn stale_entry(
    w: &World,
    item: &amby_sync_core::crypto::keys::ItemId,
    version: u64,
) -> amby_sync_core::engine::ChangeEntry {
    let versions = w.space(0).versions(item).expect(200).json();
    let v = versions["versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["version"].as_u64() == Some(version))
        .unwrap_or_else(|| panic!("no version {version}"));
    amby_sync_core::engine::ChangeEntry {
        seq: v["seq"].as_u64().unwrap(),
        item_id: *item,
        version,
        header: hex::decode(v["header"].as_str().unwrap()).unwrap(),
        blob_id: v["blob_id"].as_str().map(|s| {
            amby_sync_core::crypto::keys::BodyId::from_bytes(
                hex::decode(s).unwrap().try_into().unwrap(),
            )
        }),
        blob_size: v["blob_size"].as_u64(),
        deleted: v["deleted"].as_bool().unwrap(),
        device_id: [0; 16],
        committed_ms: 0,
    }
}

// ----- Д58: a gap in the feed -----

fn d58_a_gap_means_a_full_reconcile_without_deletions(b: EngineBuilder) {
    // Р8, Р10, Д58, П32: a device that was away longer than the server keeps deletions did not
    // see a deletion; it reconciles from scratch and deletes nothing: the file it still has
    // stays, goes up as a new item, and comes back everywhere.
    let w = World::new(b, WorldOptions::new(2).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/x.md", "will be deleted");
    w.save(0, "Notes/y.md", "stays");
    w.round();
    w.round();
    w.dev(0).fs.user_delete("Notes/x.md");
    w.pass(0);
    w.control()
        .advance(std::time::Duration::from_secs(31 * 24 * 3600));
    w.control().run_maintenance();
    let report = w.pass(1);
    assert!(report.full_reconcile, "the feed said there is a gap");
    assert_eq!(
        w.read(1, "Notes/x.md").as_deref(),
        Some("will be deleted"),
        "nothing is deleted on a gap"
    );
    assert!(w.dev(1).fs.trash().is_empty());
    w.finish(false);
    assert_eq!(
        w.read(0, "Notes/x.md").as_deref(),
        Some("will be deleted"),
        "it came back everywhere"
    );
}

// ----- Д59, Д17, Д19, Д60 -----

fn d59_an_unfinished_journal_holds_back_what_goes_out(b: EngineBuilder) {
    // Р8, Д59: while a multi-file operation is unfinished, nothing leaves this device; what comes
    // in is applied; afterwards the held changes go.
    let w = pair_with_a(b);
    w.dev(1).fs.set_recovery_pending(true);
    w.save(1, "Notes/half-done.md", "part of an operation");
    w.save(0, "Notes/incoming.md", "from the other device");
    w.pass(0);
    let head = w.server_head();
    let report = w.pass(1);
    assert!(report.outgoing_paused);
    assert_eq!(w.server_head(), head, "nothing was sent");
    assert_eq!(
        w.read(1, "Notes/incoming.md").as_deref(),
        Some("from the other device")
    );
    w.dev(1).fs.set_recovery_pending(false);
    let report = w.pass(1);
    assert!(!report.outgoing_paused);
    assert!(w.server_head() > head);
    w.finish(false);
    assert_eq!(
        w.read(0, "Notes/half-done.md").as_deref(),
        Some("part of an operation")
    );
}

fn d17_incoming_changes_are_applied_inside_one_batch(b: EngineBuilder) {
    // Р8, Д17: watcher events are merged and the index updated once: all writes of the pass lie
    // between one `batch_begin` and one `batch_end`.
    let w = pair_with_a(b);
    for i in 0..3 {
        w.save(0, &format!("Batch/b{i}.md"), &format!("file {i}"));
    }
    w.pass(0);
    w.dev(1).fs.clear_events();
    w.pass(1);
    let events = w.dev(1).fs.events();
    let begins = events.iter().filter(|e| **e == FsEvent::BatchBegin).count();
    let ends = events.iter().filter(|e| **e == FsEvent::BatchEnd).count();
    assert_eq!((begins, ends), (1, 1), "{events:?}");
    let first = events
        .iter()
        .position(|e| *e == FsEvent::BatchBegin)
        .unwrap();
    let last = events.iter().position(|e| *e == FsEvent::BatchEnd).unwrap();
    for (i, e) in events.iter().enumerate() {
        if matches!(e, FsEvent::Publish { .. }) {
            assert!(
                i > first && i < last,
                "a write outside the batch: {events:?}"
            );
        }
    }
    assert_eq!(w.dev(1).fs.batch_state(), (0, 1));
}

fn d19_a_revoked_device_stops_and_downloads_nothing(b: EngineBuilder) {
    // С12, Д19: no valid token: the pass stops with "sign in again" and nothing is written.
    let w = World::new(b, WorldOptions::new(2).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.round();
    w.round();
    w.save(0, "Notes/a.md", "new on the server");
    w.pass(0);
    let device_id = w.accounts[1].device_id.clone();
    w.accounts[1]
        .delete(&format!("/v1/devices/{device_id}"))
        .expect(204);
    let files = w.dev(1).fs.files();
    assert_eq!(w.stop(1), StopReason::AuthRequired);
    assert_eq!(w.dev(1).fs.files(), files, "nothing was downloaded");
    assert!(w.dev(1).fs.history().is_empty());
}

fn d60_stopping_again_does_not_change_anything(b: EngineBuilder) {
    // Р8, Д60: a stopped pass is an `Ok` report, repeated stops are the same, and approvals that
    // do not apply to the stop (a mass-change approval at a missing folder) change nothing.
    let w = pair_with_a(b);
    w.dev(0).fs.set_root_present(false);
    let state = w.dev(0).state.snapshot();
    for _ in 0..3 {
        assert_eq!(w.stop(0), StopReason::VaultMissing);
    }
    let report = w.pass_with(
        0,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    assert_eq!(
        report.outcome,
        CycleOutcome::Stopped(StopReason::VaultMissing)
    );
    assert_eq!(w.dev(0).state.snapshot(), state);
}

both!(
    d53_every_replacement_makes_a_snapshot_and_a_new_file_does_not,
    d52_the_trash_keeps_what_was_deleted_elsewhere,
    d54_default_threshold_outgoing_twenty_of_two_hundred_goes,
    d54_default_threshold_outgoing_twenty_one_of_two_hundred_stops,
    d54_default_threshold_incoming_twenty_one_of_two_hundred_stops_and_applies_nothing,
    d54_outgoing_two_of_twenty_goes,
    d54_outgoing_three_of_twenty_stops,
    d54_outgoing_two_of_nineteen_stops,
    d54_outgoing_below_the_minimum_goes,
    d54_incoming_two_of_twenty_goes,
    d54_incoming_three_of_twenty_stops,
    d54_incoming_two_of_nineteen_stops,
    d54_incoming_deletions_count_as_well,
    d54_creations_and_renames_do_not_count,
    d54_the_approval_lasts_one_pass,
    d55_a_missing_folder_is_not_a_deletion,
    d55_an_empty_folder_asks_before_anything_is_deleted,
    d55_a_new_device_with_an_empty_folder_is_normal,
    d56_the_first_pass_remembers_the_server,
    d56_a_reset_server_stops_the_pass_and_keeps_every_file,
    d56_a_server_restored_from_an_old_copy_stops,
    d57_an_older_version_stops_the_pass_and_changes_nothing,
    d57_a_deleted_item_shown_alive_again_stops,
    d57_the_same_version_with_other_content_stops,
    d58_a_gap_means_a_full_reconcile_without_deletions,
    d59_an_unfinished_journal_holds_back_what_goes_out,
    d17_incoming_changes_are_applied_inside_one_batch,
    d19_a_revoked_device_stops_and_downloads_nothing,
    d60_stopping_again_does_not_change_anything,
);

fn d19_an_incompatible_server_stops(b: EngineBuilder) {
    // Р13, Д60: a server that does not speak protocol 1.
    let w = pair_with_a(b);
    w.dev(1).lies.borrow_mut().info = Some(Box::new(|mut info| {
        info.protocol_min = 2;
        info.protocol_max = 2;
        info
    }));
    assert_eq!(w.stop(1), StopReason::IncompatibleServer);
}

real_only!(d19_an_incompatible_server_stops);

#[allow(dead_code)]
fn unused(_: Kind) {}
