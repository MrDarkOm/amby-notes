//! Added after the review of Opus (21.10, appendix В.9): after a `resync` the local version stays
//! at the path (Д56, Д57); a hint from the application makes a rename together with an edit one
//! rename (Д13, Д70); a file over the memory limit of the device is listed (Д71); a reset server
//! that forgot the user and the space (Д72).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::engine::{RenameHint, UnsyncedReason};

fn d56_after_a_resync_the_local_version_stays_and_the_servers_becomes_a_copy(b: EngineBuilder) {
    // Р8, С7, Д56, О4, О5: the server went back to an old copy; this device has a newer version
    // of the file. The newer local version stays at the path and goes up, the older version from
    // the server is kept as a conflict copy; nothing is lost either way, but the new content
    // does not end up in the copy.
    let mut w = World::new(b, WorldOptions::new(2).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.round();
    w.round();
    let backup = w.backup_server();
    w.save(0, "Notes/a.md", "newer");
    w.round();
    w.round();
    w.restore_server(&backup);
    assert!(matches!(w.stop(0), StopReason::ServerBehind { .. }));
    w.dev(0).sync_approved().unwrap();
    w.dev(1).sync_approved().unwrap();
    w.finish(false);
    for d in 0..2 {
        assert_eq!(
            w.read(d, "Notes/a.md").as_deref(),
            Some("newer"),
            "device {d}"
        );
        let copies = w.copies(d, "Notes/a.md");
        assert_eq!(
            copies.values().map(String::as_str).collect::<Vec<_>>(),
            vec!["base"],
            "device {d}"
        );
    }
    assert_eq!(
        w.server_files()
            .get("Notes/a.md")
            .map(|b| text(b))
            .as_deref(),
        Some("newer")
    );
}

fn d57_after_a_resync_following_a_rollback_the_local_version_stays(b: EngineBuilder) {
    // Р6, Д57: the server showed an old version, the user approved a new reconcile; this device
    // had an unsent newer edit: it stays at the path, the server's version becomes a copy.
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "second");
    w.pass(0);
    w.save(0, "Notes/a.md", "third");
    w.pass(0);
    w.pass(1);
    let (item, _) = w.item_at("Notes/a.md");
    let versions = w.space(0).versions(&item).expect(200).json();
    let old = versions["versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["version"] == 2)
        .unwrap()
        .clone();
    let stale = amby_sync_core::engine::ChangeEntry {
        seq: old["seq"].as_u64().unwrap(),
        item_id: item,
        version: 2,
        header: hex::decode(old["header"].as_str().unwrap()).unwrap(),
        blob_id: old["blob_id"].as_str().map(|s| {
            amby_sync_core::crypto::keys::BodyId::from_bytes(
                hex::decode(s).unwrap().try_into().unwrap(),
            )
        }),
        blob_size: old["blob_size"].as_u64(),
        deleted: false,
        device_id: [0; 16],
        committed_ms: 0,
    };
    w.save(1, "Notes/a.md", "mine, newer than anything");
    w.dev(1).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        page.changes.retain(|c| c.item_id != stale.item_id);
        page.changes.push(stale.clone());
        page
    }));
    assert!(matches!(w.stop(1), StopReason::Rollback { .. }));
    w.dev(1).lies.borrow_mut().changes = None;
    w.dev(1).sync_approved().unwrap();
    assert_eq!(
        w.read(1, "Notes/a.md").as_deref(),
        Some("mine, newer than anything")
    );
    assert_eq!(
        w.copies(1, "Notes/a.md")
            .values()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["third"]
    );
    w.finish(false);
    assert_eq!(
        w.read(0, "Notes/a.md").as_deref(),
        Some("mine, newer than anything")
    );
}

fn d72_a_reset_server_that_forgot_the_user_stops_and_touches_nothing(b: EngineBuilder) {
    // Р8, С7, С12, Д72, Д56: a really reset server knows neither the user nor the space, and the
    // user is not created again. The device sees another `instance_id` (or a `401`) and stops
    // with a clear state; nothing is deleted, renamed or overwritten locally.
    let w = World::new(b, WorldOptions::new(2).isolated());
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.dev(0).fs.user_mkdir("Empty");
    w.round();
    w.round();
    let files = w.dev(1).fs.files();
    let state = w.dev(1).state.snapshot();
    w.control().restart_fresh();
    w.dev(1).fs.clear_events();
    let reason = w.stop(1);
    assert!(
        matches!(
            reason,
            StopReason::ServerReset { .. } | StopReason::AuthRequired
        ),
        "{reason:?}"
    );
    assert_eq!(w.dev(1).fs.files(), files);
    assert!(w.dev(1).fs.trash().is_empty() && w.dev(1).fs.history().is_empty());
    assert!(
        disk_changes(&w, 1).is_empty(),
        "nothing renamed, written or removed: {:?}",
        disk_changes(&w, 1)
    );
    assert_eq!(
        w.dev(1).state.snapshot().items,
        state.items,
        "the bases did not move"
    );
    assert_eq!(w.dev(1).state.snapshot().cursor, state.cursor);
    // The same on the next pass.
    let again = w.stop(1);
    assert!(matches!(
        again,
        StopReason::ServerReset { .. } | StopReason::AuthRequired
    ));
}

fn d70_a_rename_hint_keeps_a_rename_with_an_edit_one_record(_b: EngineBuilder) {
    // Р2, Д13, Д70: the application says "this was a rename"; the file keeps its record: one
    // item, a new version with the new path and the new content, no deletion, no new item.
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    let items = w.server_item_count();
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/c.md");
    w.save(0, "Notes/c.md", "renamed and edited at once");
    let request = CycleRequest {
        rename_hints: vec![RenameHint {
            from: "Notes/a.md".into(),
            to: "Notes/c.md".into(),
        }],
        ..Default::default()
    };
    let report = w.dev(0).sync_with(&request).unwrap();
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(w.item_at("Notes/c.md"), (item, version + 1));
    assert_eq!(w.server_item_count(), items, "no new record");
    assert!(w
        .versions_at("Notes/c.md")
        .iter()
        .all(|v| !v.header.deleted));
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/c.md").as_deref(),
        Some("renamed and edited at once")
    );
    assert!(!w.dev(1).fs.exists("Notes/a.md"));
    assert!(w.dev(1).fs.trash().is_empty(), "nothing went to the trash");
    w.finish(false);
}

fn d70_a_hint_is_used_once_and_without_a_hint_the_old_rule_holds(_b: EngineBuilder) {
    // Д13, Д70: without a hint a rename with an edit is a deletion and a creation (safe); a hint
    // for a path that is not there changes nothing.
    let w = pair_with_a(Engine::boxed);
    w.dev(0).fs.user_rename("Notes/a.md", "Notes/c.md");
    w.save(0, "Notes/c.md", "renamed and edited");
    let request = CycleRequest {
        rename_hints: vec![RenameHint {
            from: "Nowhere/x.md".into(),
            to: "Nowhere/y.md".into(),
        }],
        ..Default::default()
    };
    w.dev(0).sync_with(&request).unwrap();
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/c.md").as_deref(),
        Some("renamed and edited")
    );
    assert_eq!(
        w.dev(1).fs.trash().len(),
        1,
        "the old file went to the trash, as without a hint"
    );
    w.finish(false);
}

fn d71_a_file_over_the_memory_limit_is_listed_and_not_synchronised(_b: EngineBuilder) {
    // Д6, Д12, Д18, Д71: bodies are handled whole in memory, so each device has a limit; a larger
    // file is listed with its reason, in both directions, and the rest goes on.
    let w = pair_with_a(Engine::boxed);
    for d in 0..2 {
        *w.dev(d).config_tweak.borrow_mut() = Some(Box::new(|c| c.max_file_bytes = 100_000));
    }
    w.save(0, "Big/huge.bin", &"h".repeat(150_000));
    w.save(0, "Big/fine.bin", &"f".repeat(50_000));
    w.pass(0);
    assert_eq!(
        w.dev(0)
            .state
            .snapshot()
            .unsynced
            .iter()
            .map(|u| (u.path.clone(), u.reason.clone()))
            .collect::<Vec<_>>(),
        vec![("Big/huge.bin".to_string(), UnsyncedReason::TooBigForMemory)]
    );
    assert!(w.server_files().contains_key("Big/fine.bin"));
    assert!(!w.server_files().contains_key("Big/huge.bin"));
    // A device with the default limit sends one that the limited device cannot take.
    let other = pair_with_a(Engine::boxed);
    *other.dev(1).config_tweak.borrow_mut() = Some(Box::new(|c| c.max_file_bytes = 100_000));
    other.save(0, "Big/huge.bin", &"h".repeat(150_000));
    other.pass(0);
    other.pass(1);
    assert!(!other.dev(1).fs.exists("Big/huge.bin"));
    assert!(other
        .dev(1)
        .state
        .snapshot()
        .unsynced
        .iter()
        .any(|u| u.reason == UnsyncedReason::TooBigForMemory));
}

both!(
    d56_after_a_resync_the_local_version_stays_and_the_servers_becomes_a_copy,
    d57_after_a_resync_following_a_rollback_the_local_version_stays,
    d72_a_reset_server_that_forgot_the_user_stops_and_touches_nothing,
);

real_only!(
    d70_a_rename_hint_keeps_a_rename_with_an_edit_one_record,
    d70_a_hint_is_used_once_and_without_a_hint_the_old_rule_holds,
    d71_a_file_over_the_memory_limit_is_listed_and_not_synchronised,
);
