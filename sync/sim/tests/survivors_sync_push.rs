//! Tests written for the mutants of `engine/sync.rs`, `engine/push.rs` and `engine/util.rs` that
//! survived the trial run of the gates (docs/Road/sync-gates-survivors-report.md): the state a
//! pass leaves (cursor, head, times, versions), what a pass counts in its report, uploads that
//! nobody will commit, the order of a split commit, the checks that must come first. Real engine
//! only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use std::cell::Cell;
use std::rc::Rc;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::engine::{Direction, LocalFs, UnsyncedReason};

fn text_of(n: usize, c: char) -> String {
    c.to_string().repeat(n)
}

fn base_gets(w: &World, d: usize) -> usize {
    w.dev(d)
        .faults
        .log()
        .iter()
        .filter(|call| call.as_str() == "State.base_get")
        .count()
}

fn mtime_ns_of(w: &World, d: usize, path: &str) -> i64 {
    let mut fs = w.dev(d).fs.clone();
    fs.list()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.path == path)
        .unwrap_or_else(|| panic!("no {path}"))
        .mtime_ns
}

// ----- the state a pass leaves -----

fn sv_a_quiet_pass_writes_nothing_and_the_cursor_is_the_head(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.round();
    w.round();
    let state = w.dev(1).state.snapshot();
    assert_eq!(state.cursor, w.server_head());
    assert_eq!(state.head, w.server_head());
    let transactions = w.dev(1).state.transactions();
    w.pass(1);
    assert_eq!(
        w.dev(1).state.transactions(),
        transactions,
        "a pass with nothing to do writes nothing"
    );
}

fn sv_the_cursor_and_the_head_move_each_by_itself(_b: EngineBuilder) {
    // The head moves while the cursor is held before a record that failed; later the cursor moves
    // alone up to the head.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "x.md", "xxx");
    w.save(0, "y.md", "yyy");
    w.pass(0);
    w.dev(1).fs.set_access_denied("x.md", true);
    let before = w.dev(1).state.snapshot();
    let report = w.pass(1);
    assert_eq!(report.errors.len(), 1);
    let held = w.dev(1).state.snapshot();
    assert_eq!(held.cursor, before.cursor, "held before the failed record");
    assert_eq!(held.head, w.server_head(), "the head moved by itself");
    assert!(held.cursor < held.head);
    w.dev(1).fs.set_access_denied("x.md", false);
    let report = w.pass(1);
    assert!(report.errors.is_empty());
    let done = w.dev(1).state.snapshot();
    assert_eq!(done.head, held.head);
    assert_eq!(done.cursor, done.head, "the cursor moved by itself");
    assert_eq!(w.read(1, "x.md").as_deref(), Some("xxx"));
}

fn sv_a_downloaded_file_gets_its_size_and_time_in_the_state(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.pass(1);
    let ns = mtime_ns_of(&w, 1, "Notes/a.md");
    let record = w
        .dev(1)
        .state
        .snapshot()
        .items
        .values()
        .find(|r| r.path == "Notes/a.md")
        .cloned()
        .unwrap();
    assert_eq!(record.mtime_ns, ns, "the time of the file is remembered");
    assert_eq!(record.size, 4);
}

fn sv_the_time_of_a_file_goes_to_the_server_in_milliseconds(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    let ns = mtime_ns_of(&w, 0, "Notes/a.md");
    let header = &w.versions_at("Notes/a.md")[0].header;
    assert_eq!(header.mtime_ms, ns / 1_000_000);
    assert!(ns / 1_000_000 > 0 && ns % 1_000_000 != 0, "the test is sharp");
}

fn sv_the_report_counts_what_the_pass_did(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "n/one.md", "one");
    w.save(0, "n/two.md", "two");
    w.save(0, "n/three.md", "three");
    let report = w.pass(0);
    assert_eq!(report.uploaded, 3);
    let report = w.pass(1);
    assert_eq!(report.downloaded, 3);
    w.dev(0).fs.user_rename("n/one.md", "n/uno.md");
    w.dev(0).fs.user_delete("n/two.md");
    w.dev(0).fs.user_delete("n/three.md");
    let report = w.pass(0);
    assert_eq!(report.uploaded, 0, "a rename and deletions send no body");
    let report = w.pass(1);
    assert_eq!(report.renamed, 1);
    assert_eq!(report.trashed, 2);
    let mut paths = report.trashed_paths.clone();
    paths.sort();
    assert_eq!(paths, vec!["n/three.md", "n/two.md"]);
    w.finish(false);
}

fn sv_a_deleted_file_is_remembered_with_the_version_the_server_gave(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    let record = w.dev(0).state.snapshot().items[item.as_bytes()].clone();
    assert!(record.deleted);
    assert_eq!(record.version, version + 1);
    assert_eq!(w.versions_at("Notes/a.md")[0].version, version + 1);
    let report = w.pass(1);
    assert!(report.errors.is_empty());
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
}

fn sv_an_empty_folder_deleted_or_renamed_keeps_the_version_the_server_gave(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("Gone");
    w.dev(0).fs.user_mkdir("Old");
    w.pass(0);
    w.pass(1);
    let (gone, v_gone) = w.item_at("Gone");
    let (old, v_old) = w.item_at("Old");
    w.dev(0).fs.user_delete("Gone");
    w.pass(0);
    // Before the next pass reads the commit back from the feed.
    let state = w.dev(0).state.snapshot();
    assert!(state.items[gone.as_bytes()].deleted);
    assert_eq!(state.items[gone.as_bytes()].version, v_gone + 1);
    w.dev(0).fs.user_rename("Old", "New");
    w.pass(0);
    let state = w.dev(0).state.snapshot();
    assert_eq!(state.items[old.as_bytes()].version, v_old + 1);
    assert_eq!(state.items[old.as_bytes()].path, "New");
    let report = w.pass(1);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!w.dev(1).fs.exists("Gone") && !w.dev(1).fs.exists("Old"));
    assert!(w.dev(1).fs.is_dir("New"));
    w.finish(true);
}

fn sv_an_empty_folder_made_again_after_it_was_deleted_is_sent_again(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_mkdir("Again");
    w.pass(0);
    w.dev(0).fs.user_delete("Again");
    w.pass(0);
    w.dev(0).fs.user_mkdir("Again");
    w.pass(0);
    assert!(w.server_folders().contains("Again"));
    w.pass(1);
    assert!(w.dev(1).fs.is_dir("Again"));
    w.finish(true);
}

// ----- uploads (Д6, Д75) -----

fn drop_requests_of(w: &World, d: usize, kind: RemoteKind, nth: u64) {
    let seen = Rc::new(Cell::new(0u64));
    w.dev(d).faults.net_rule(move |call| {
        if call.kind == kind {
            seen.set(seen.get() + 1);
            if seen.get() >= nth {
                return NetFault::DropRequest;
            }
        }
        NetFault::None
    });
}

fn sv_a_begun_upload_nobody_will_commit_is_forgotten_and_given_back(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "c.md", &text_of(5_000, 'c'));
    drop_requests_of(&w, 0, RemoteKind::Complete, 1);
    assert!(w.dev(0).sync().is_err(), "the network failed in the middle");
    assert_eq!(w.dev(0).state.snapshot().uploads.len(), 1);
    // The file is gone; another one is sent.
    w.dev(0).fs.user_delete("c.md");
    w.save(0, "b.md", "another");
    w.pass(0);
    assert!(
        w.dev(0).state.snapshot().uploads.is_empty(),
        "the upload of c.md is forgotten"
    );
    assert_eq!(
        w.remote_calls(0, RemoteKind::BlobDelete),
        1,
        "and its body is given back to the server"
    );
    w.finish(false);
}

fn sv_an_upload_in_the_middle_of_a_pass_does_not_forget_the_uploads_before_it(_b: EngineBuilder) {
    // Two new files: the body of the first is complete, the second starts and the network fails.
    // The first stays in the state (a later pass resumes it).
    let w = pair_with_a(Engine::boxed);
    w.save(0, "a1.md", &text_of(3_000, 'a'));
    w.save(0, "b1.md", &text_of(3_000, 'b'));
    drop_requests_of(&w, 0, RemoteKind::BlobStart, 2);
    assert!(w.dev(0).sync().is_err());
    assert_eq!(w.dev(0).state.snapshot().uploads.len(), 2);
    w.pass(0);
    assert!(w.dev(0).state.snapshot().uploads.is_empty());
    w.pass(1);
    assert_eq!(w.read(1, "a1.md").as_deref(), Some(text_of(3_000, 'a').as_str()));
    w.finish(false);
}

fn sv_the_nonce_prefix_of_a_body_is_the_one_the_state_remembers(_b: EngineBuilder) {
    // Д6: a resumed upload makes the same bytes again, because the random prefix of the nonces is
    // kept; the body on the server starts with that prefix after the preamble.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "p.md", &text_of(4_000, 'p'));
    drop_requests_of(&w, 0, RemoteKind::Complete, 1);
    assert!(w.dev(0).sync().is_err());
    let upload = w
        .dev(0)
        .state
        .snapshot()
        .uploads
        .values()
        .next()
        .cloned()
        .unwrap();
    let distinct: std::collections::BTreeSet<u8> = upload.nonce_prefix.iter().copied().collect();
    assert!(distinct.len() > 4, "the prefix is random bytes");
    w.pass(0);
    let body = w.space(0).download(&upload.blob_id);
    assert_eq!(body.status, 200);
    assert_eq!(&body.body[13..32], &upload.nonce_prefix[..]);
}

fn sv_a_split_commit_sends_the_folders_first(_b: EngineBuilder) {
    // Д50: above the limit of one commit the folder records go first, so that a pass that stops
    // half way leaves the folders where they belong.
    let w = World::new(Engine::boxed, WorldOptions::new(2).max_commit_items(20));
    w.save(0, "Keep/k.md", "keep");
    for i in 0..50 {
        w.save(0, &format!("Proj/f{i:03}.md"), &format!("file {i}"));
    }
    w.dev(0).fs.user_mkdir("Proj/Empty");
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_rename("Proj", "Moved");
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
    assert!(w.dev(0).sync().is_err());
    assert!(
        w.server_folders().contains("Moved/Empty"),
        "the folder went in the first commit"
    );
    w.pass(0);
    w.pass(1);
    assert!(w.dev(1).fs.is_dir("Moved/Empty"));
    w.finish(true);
}

// ----- the checks that come first -----

fn sv_a_reset_server_stops_the_pass_before_a_held_commit_is_sent(_b: EngineBuilder) {
    // Р8, Д56, С2: the commit that may have arrived is not sent to a server that is not the one
    // it was made for.
    let mut w = World::new(Engine::boxed, WorldOptions::new(1).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "Keep/k.md", "keep, edited");
    w.dev(0).faults.net_rule(|call| {
        if call.kind == RemoteKind::Commit {
            NetFault::LoseResponse
        } else {
            NetFault::None
        }
    });
    assert!(w.dev(0).sync().is_err());
    assert!(w.dev(0).state.snapshot().commit.is_some());
    w.reset_server();
    assert!(matches!(w.stop(0), StopReason::ServerReset { .. }));
    assert_eq!(w.server_head(), 0, "nothing was sent to the new server");
    assert_eq!(w.remote_calls(0, RemoteKind::Commit), 0);
    assert_eq!(w.remote_calls(0, RemoteKind::Account), 0);
}

fn sv_a_vault_with_only_deleted_records_is_not_an_empty_vault(_b: EngineBuilder) {
    // Д55: only live files count.
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_delete("Keep");
    w.dev(0).fs.user_delete("Notes");
    let report = w
        .dev(0)
        .sync_with(&CycleRequest {
            approvals: Approvals {
                accept_empty_vault: true,
                mass_change: true,
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
    assert_eq!(report.outcome, CycleOutcome::Done);
    // Nothing but deleted records now, and nothing on disk: that is not a vault that was emptied.
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
}

fn sv_a_vault_with_only_an_empty_folder_is_not_an_empty_vault(_b: EngineBuilder) {
    let w = two(Engine::boxed);
    w.dev(0).fs.user_mkdir("OnlyFolder");
    w.pass(0);
    w.pass(0);
    w.pass(1);
    assert!(w.dev(1).fs.is_dir("OnlyFolder"));
    w.pass(1);
}

fn sv_many_folders_do_not_hide_a_mass_deletion(_b: EngineBuilder) {
    // Д54: the percent is of the files; folder records and deleted records are not files.
    let w = two(Engine::boxed);
    w.scale_mass_threshold(3);
    for i in 0..6 {
        w.save(0, &format!("F/f{i}.md"), &format!("file {i}"));
    }
    for i in 0..40 {
        w.dev(0).fs.user_mkdir(&format!("Folders/e{i:02}"));
    }
    w.pass(0);
    for i in 0..4 {
        w.dev(0).fs.user_delete(&format!("F/f{i}.md"));
    }
    match w.stop(0) {
        StopReason::MassChange { direction, files } => {
            assert_eq!(direction, Direction::Outgoing);
            assert_eq!(files.len(), 4);
        }
        other => panic!("{other:?}"),
    }
}

fn sv_many_deleted_records_do_not_hide_a_mass_deletion(_b: EngineBuilder) {
    let w = two(Engine::boxed);
    w.scale_mass_threshold(3);
    w.save(0, "Keep/k.md", "keep");
    for i in 0..40 {
        w.save(0, &format!("Old/o{i:02}.md"), &format!("old {i}"));
    }
    w.pass(0);
    w.dev(0).fs.user_delete("Old");
    let report = w
        .dev(0)
        .sync_with(&CycleRequest {
            approvals: Approvals {
                mass_change: true,
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
    assert_eq!(report.outcome, CycleOutcome::Done);
    for i in 0..6 {
        w.save(0, &format!("New/n{i}.md"), &format!("new {i}"));
    }
    w.pass(0);
    for i in 0..4 {
        w.dev(0).fs.user_delete(&format!("New/n{i}.md"));
    }
    match w.stop(0) {
        StopReason::MassChange { direction, .. } => assert_eq!(direction, Direction::Outgoing),
        other => panic!("{other:?}"),
    }
}

fn sv_a_gap_does_not_hide_a_local_deletion_of_a_file_the_server_still_has(_b: EngineBuilder) {
    // Д58: after a gap the server's deletions are not believed, our own still go out.
    let w = World::new(Engine::boxed, WorldOptions::new(2).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/x.md", "will be deleted");
    w.save(0, "Notes/y.md", "will be deleted here");
    w.round();
    w.round();
    w.dev(0).fs.user_delete("Notes/x.md");
    w.pass(0);
    w.control()
        .advance(std::time::Duration::from_secs(31 * 24 * 3600));
    w.control().run_maintenance();
    w.dev(1).fs.user_delete("Notes/y.md");
    let report = w.pass(1);
    assert!(report.full_reconcile);
    assert!(
        !w.server_files().contains_key("Notes/y.md"),
        "the deletion of y.md went to the server"
    );
    assert_eq!(
        w.read(1, "Notes/x.md").as_deref(),
        Some("will be deleted"),
        "a deletion of the server is still not believed"
    );
}

// ----- items that cannot be read (Д66) and items that fail -----

fn sv_a_record_of_a_newer_format_stays_in_the_list_of_later_passes(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    let envelope = forge_envelope(
        &w,
        &item,
        version + 1,
        &format!(
            r#"{{"body_id":null,"content_hash":null,"deleted":false,"format":2,"kind":"file","mtime_ms":0,"path":"Notes/a.md","size":0,"version":{}}}"#,
            version + 1
        ),
    );
    w.inject_raw(vec![commit_entry(&item, version, &envelope, None, false)]);
    let first = w.pass(1);
    assert!(first.needs_update);
    assert_eq!(first.read_only.len(), 1);
    let second = w.pass(1);
    assert!(second.needs_update, "still told");
    assert_eq!(second.read_only.len(), 1, "once, with its path");
    assert_eq!(second.read_only[0].item_id, item);
    assert_eq!(second.read_only[0].path.as_deref(), Some("Notes/a.md"));
}

fn sv_every_item_that_fails_is_in_the_report(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "x.md", "xxx");
    w.save(0, "y.md", "yyy");
    w.save(0, "z.md", "zzz");
    w.pass(0);
    w.dev(1).fs.set_access_denied("x.md", true);
    w.dev(1).fs.set_access_denied("y.md", true);
    let report = w.pass(1);
    assert_eq!(report.errors.len(), 2, "{:?}", report.errors);
    assert_ne!(report.errors[0].item_id, report.errors[1].item_id);
    assert_eq!(w.read(1, "z.md").as_deref(), Some("zzz"));
}

fn sv_every_file_that_cannot_be_read_is_in_the_list(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Keep/k2.md", "keep");
    w.save(0, "Keep/l1.md", "one");
    w.save(0, "Keep/l2.md", "two");
    w.dev(0).fs.set_access_denied("Keep/l1.md", true);
    w.dev(0).fs.set_access_denied("Keep/l2.md", true);
    let report = w.pass(0);
    let mut paths: Vec<_> = report
        .unsynced
        .iter()
        .filter(|u| u.reason == UnsyncedReason::NoAccess)
        .map(|u| u.path.clone())
        .collect();
    paths.sort();
    assert_eq!(paths, vec!["Keep/l1.md", "Keep/l2.md"]);
}

// ----- the bases of a merge are read only when a merge may follow (Г6, Г10) -----

fn sv_no_base_is_read_for_a_deletion_that_loses_to_an_edit(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_delete("Notes/a.md");
    w.pass(0);
    w.save(1, "Notes/a.md", "edited here");
    w.pass(1);
    assert_eq!(base_gets(&w, 1), 0, "an edit beats a deletion: no merge");
    w.pass(0);
    assert_eq!(w.read(0, "Notes/a.md").as_deref(), Some("edited here"));
}

fn sv_no_base_is_read_for_a_rename_that_changes_no_content(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/b.md");
    w.pass(0);
    w.save(1, "Notes/a.md", "edited here");
    w.pass(1);
    assert_eq!(base_gets(&w, 1), 0, "only the name changed there: no merge");
    assert_eq!(w.read(1, "Notes/b.md").as_deref(), Some("edited here"));
}

fn sv_a_base_is_read_when_both_sides_edited_a_note(_b: EngineBuilder) {
    // The counterpart of the two above: the merge needs the base.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Notes/a.md", "base\nzero\n");
    w.save(1, "Notes/a.md", "one\nbase\n");
    w.pass(0);
    w.pass(1);
    assert!(base_gets(&w, 1) >= 1);
}

/// The entry of the version `version` of `item`, as the server once gave it.
fn stale_entry(w: &World, item: &ItemId, version: u64) -> amby_sync_core::engine::ChangeEntry {
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

fn lie_with(w: &World, d: usize, entry: amby_sync_core::engine::ChangeEntry) {
    w.dev(d).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        page.changes.retain(|c| c.item_id != entry.item_id);
        page.changes.push(entry.clone());
        page
    }));
}

fn sv_the_same_version_with_another_content_hash_stops(_b: EngineBuilder) {
    // Р6, Д57: only the hash of the content is another.
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    let mut entry = stale_entry(&w, &item, version);
    let mut header = w.versions_at("Notes/a.md")[0].header.clone();
    header.content_hash = Some([0x5a; 32]);
    entry.header = amby_sync_core::crypto::header::seal_header(
        &w.vk,
        &w.space_id,
        &item,
        &header,
        &mut SimRandom(7),
    )
    .unwrap();
    lie_with(&w, 1, entry);
    assert!(matches!(w.stop(1), StopReason::Rollback { .. }));
}

fn sv_the_same_version_with_another_body_stops(_b: EngineBuilder) {
    // Р6, Д57: only the body is another (the same text, uploaded again).
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    let other = amby_sync_core::crypto::keys::BodyId::from_bytes([0x66; 16]);
    let sealed = amby_sync_core::crypto::body::seal_body(
        &w.vk,
        &other,
        b"base",
        &mut amby_sync_core::crypto::random::OsRandom,
    )
    .unwrap();
    w.space(0).upload_sealed(&other, &sealed);
    let mut entry = stale_entry(&w, &item, version);
    let mut header = w.versions_at("Notes/a.md")[0].header.clone();
    header.body_id = Some(other);
    entry.blob_id = Some(other);
    entry.header = amby_sync_core::crypto::header::seal_header(
        &w.vk,
        &w.space_id,
        &item,
        &header,
        &mut SimRandom(7),
    )
    .unwrap();
    lie_with(&w, 1, entry);
    assert!(matches!(w.stop(1), StopReason::Rollback { .. }));
}

real_only!(
    sv_the_same_version_with_another_content_hash_stops,
    sv_the_same_version_with_another_body_stops,
    sv_a_quiet_pass_writes_nothing_and_the_cursor_is_the_head,
    sv_the_cursor_and_the_head_move_each_by_itself,
    sv_a_downloaded_file_gets_its_size_and_time_in_the_state,
    sv_the_time_of_a_file_goes_to_the_server_in_milliseconds,
    sv_the_report_counts_what_the_pass_did,
    sv_a_deleted_file_is_remembered_with_the_version_the_server_gave,
    sv_an_empty_folder_deleted_or_renamed_keeps_the_version_the_server_gave,
    sv_an_empty_folder_made_again_after_it_was_deleted_is_sent_again,
    sv_a_begun_upload_nobody_will_commit_is_forgotten_and_given_back,
    sv_an_upload_in_the_middle_of_a_pass_does_not_forget_the_uploads_before_it,
    sv_the_nonce_prefix_of_a_body_is_the_one_the_state_remembers,
    sv_a_split_commit_sends_the_folders_first,
    sv_a_reset_server_stops_the_pass_before_a_held_commit_is_sent,
    sv_a_vault_with_only_deleted_records_is_not_an_empty_vault,
    sv_a_vault_with_only_an_empty_folder_is_not_an_empty_vault,
    sv_many_folders_do_not_hide_a_mass_deletion,
    sv_many_deleted_records_do_not_hide_a_mass_deletion,
    sv_a_gap_does_not_hide_a_local_deletion_of_a_file_the_server_still_has,
    sv_a_record_of_a_newer_format_stays_in_the_list_of_later_passes,
    sv_every_item_that_fails_is_in_the_report,
    sv_every_file_that_cannot_be_read_is_in_the_list,
    sv_no_base_is_read_for_a_deletion_that_loses_to_an_edit,
    sv_no_base_is_read_for_a_rename_that_changes_no_content,
    sv_a_base_is_read_when_both_sides_edited_a_note,
);
