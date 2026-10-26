//! Directed checks for survivors in the tariff and pending-commit branches of the real engine.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::engine::{Engine, UnsyncedReason};
use amby_sync_sim::fault::RemoteKind;
use amby_sync_sim::world::{World, WorldOptions};
use serde_json::{json, Map, Value};

fn s(n: u64) -> u64 {
    sealed_body_len(n).unwrap()
}

fn text(n: usize, c: char) -> String {
    c.to_string().repeat(n)
}

fn plan(file: Option<u64>, total: Option<u64>) -> Value {
    let mut map = Map::new();
    if let Some(value) = file {
        map.insert("max_file_bytes".into(), json!(value));
    }
    if let Some(value) = total {
        map.insert("max_total_bytes".into(), json!(value));
    }
    Value::Object(map)
}

fn world(plans: Value) -> World {
    World::new(
        Engine::boxed,
        WorldOptions::new(1).plans(&plans.to_string()),
    )
}

fn unsynced(w: &World) -> Vec<(String, UnsyncedReason)> {
    let mut entries: Vec<_> = w
        .dev(0)
        .state
        .snapshot()
        .unsynced
        .into_iter()
        .map(|entry| (entry.path, entry.reason))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

fn ls_a_pending_commit_rechecks_a_tightened_file_limit(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(Some(s(150_000)), Some(250_000)),
            "narrow": plan(Some(s(30_000)), Some(250_000))
        }
    }));
    w.save(0, "A/large.bin", &text(100_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::Commit);
    assert!(w.dev(0).sync().is_err(), "commit did not reach the server");
    assert!(w.dev(0).state.snapshot().commit.is_some());

    w.set_plan("narrow");
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.dev(0).state.snapshot().commit.is_none());
    assert!(!w.server_files().contains_key("A/large.bin"));
    assert!(matches!(
        unsynced(&w).as_slice(),
        [(path, UnsyncedReason::TooLarge { max_bytes, .. })]
            if path == "A/large.bin" && *max_bytes == s(30_000)
    ));
}

fn ls_a_pending_commit_keeps_507_and_reports_only_files(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(Some(s(100_000)), Some(200_000)),
            "narrow": plan(Some(s(100_000)), Some(1))
        }
    }));
    w.dev(0).fs.user_mkdir("Empty");
    w.save(0, "A/large.bin", &text(60_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::Commit);
    assert!(w.dev(0).sync().is_err(), "commit did not reach the server");
    assert!(w.dev(0).state.snapshot().commit.is_some());

    w.set_plan("narrow");
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.limits.quota_full);
    assert!(w.dev(0).state.snapshot().commit.is_some());
    assert_eq!(
        unsynced(&w),
        vec![("A/large.bin".to_string(), UnsyncedReason::QuotaFull)]
    );
}

fn ls_a_pending_commit_with_a_missing_body_is_rebuilt(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "wide",
        "plans": {"wide": plan(None, None)}
    }));
    w.save(0, "A/a.bin", &text(20_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::Commit);
    assert!(w.dev(0).sync().is_err(), "commit did not reach the server");
    let pending = w.dev(0).state.snapshot().commit.unwrap();
    let body = pending.items[0]
        .blob_id
        .expect("the pending commit has a body");
    assert_eq!(w.space(0).delete_blob(&body).status, 204);

    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.dev(0).state.snapshot().commit.is_none());
    assert!(w.dev(0).state.snapshot().uploads.is_empty());
    assert_eq!(
        w.read(0, "A/a.bin").as_deref(),
        Some(text(20_000, 'a').as_str())
    );
    assert_eq!(w.server_files()["A/a.bin"], text(20_000, 'a').into_bytes());
}

fn ls_resuming_an_exact_pending_upload_works_with_no_free_quota(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "tight",
        "plans": {"tight": plan(None, Some(s(4) + s(30_000)))}
    }));
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "A/a.bin", &text(30_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::PutPart(0));
    assert!(
        w.dev(0).sync().is_err(),
        "the first body part did not reach server"
    );
    assert_eq!(w.dev(0).state.snapshot().uploads.len(), 1);

    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.server_files().contains_key("A/a.bin"));
    assert!(w.dev(0).state.snapshot().uploads.is_empty());
    assert!(unsynced(&w).is_empty());
}

fn ls_changed_content_waits_for_pending_quota_without_a_new_upload(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "tight",
        "plans": {"tight": plan(None, Some(s(30_000)))}
    }));
    w.save(0, "A/a.bin", &text(30_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::PutPart(0));
    assert!(w.dev(0).sync().is_err());
    assert_eq!(w.dev(0).state.snapshot().uploads.len(), 1);

    w.save(0, "A/a.bin", &text(30_000, 'b'));
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(w.remote_calls(0, RemoteKind::BlobStart), 0);
    assert_eq!(w.remote_calls(0, RemoteKind::BlobDelete), 1);
    assert_eq!(
        unsynced(&w),
        vec![("A/a.bin".to_string(), UnsyncedReason::QuotaFull)]
    );
}

fn ls_changed_content_does_not_reuse_an_upload_nonce_prefix(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "free",
        "plans": {"free": plan(None, None)}
    }));
    w.save(0, "A/a.bin", &text(30_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::PutPart(0));
    assert!(w.dev(0).sync().is_err());
    let first_blob = w
        .dev(0)
        .faults
        .remote_log()
        .into_iter()
        .find(|call| call.kind == RemoteKind::BlobStart)
        .expect("blob_start was attempted")
        .blob
        .expect("blob_start has an id");

    w.save(0, "A/a.bin", &text(30_000, 'b'));
    w.pass(0);
    let second_blob = w
        .dev(0)
        .faults
        .remote_log()
        .into_iter()
        .find(|call| call.kind == RemoteKind::BlobStart)
        .expect("blob_start was attempted")
        .blob
        .expect("blob_start has an id");
    assert_ne!(
        first_blob, second_blob,
        "changed content needs a new body id"
    );
    assert_eq!(w.server_files()["A/a.bin"], text(30_000, 'b').into_bytes());
}

fn ls_exactly_filling_free_quota_is_allowed(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "tight",
        "plans": {"tight": plan(None, Some(s(4) + s(1_000)))}
    }));
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "A/exact.bin", &text(1_000, 'x'));

    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.server_files().contains_key("A/exact.bin"));
    assert!(unsynced(&w).is_empty());
}

fn ls_replacing_a_body_credits_its_current_sealed_size(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "tight",
        "plans": {"tight": plan(None, Some(s(30_000)))}
    }));
    w.save(0, "A/a.bin", &text(30_000, 'a'));
    w.pass(0);
    w.save(0, "A/a.bin", &text(20_000, 'b'));

    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(w.server_files()["A/a.bin"], text(20_000, 'b').into_bytes());
    assert!(unsynced(&w).is_empty());
}

fn ls_a_507_mixed_commit_sends_folder_and_holds_body(_b: EngineBuilder) {
    let plans = json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(Some(s(100_000)), Some(200_000)),
            "narrow": plan(Some(s(100_000)), Some(1))
        }
    });
    let w = world(plans);
    w.dev(0).fs.user_mkdir("Empty");
    w.save(0, "A/large.bin", &text(60_000, 'a'));
    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        assert_eq!(admin.run(&["user", "plan", "set", &name, "narrow"]).code, 0);
    });

    let report = w.dev(0).sync().expect("the quota refusal is handled");
    assert_eq!(report.outcome, CycleOutcome::Done);
    let files = w.server_files();
    assert!(!files.contains_key("A/large.bin"));
    assert!(w.server_folders().contains("Empty"), "report={report:?}");
    assert_eq!(
        unsynced(&w),
        vec![("A/large.bin".to_string(), UnsyncedReason::QuotaFull)]
    );
}

fn ls_a_commit_413_report_marks_only_bodies_over_the_new_limit(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(Some(s(300_000)), None),
            "narrow": plan(Some(s(30_000)), None)
        }
    }));
    w.save(0, "A/big.bin", &text(100_000, 'b'));
    w.save(0, "B/exact.bin", &text(30_000, 'e'));
    w.save(0, "B/small.md", &text(1_000, 's'));
    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        assert_eq!(admin.run(&["user", "plan", "set", &name, "narrow"]).code, 0);
    });

    let report = w.dev(0).sync().expect("a commit 413 is a limit outcome");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(
        report.unsynced,
        vec![amby_sync_core::engine::UnsyncedRecord {
            path: "A/big.bin".to_string(),
            reason: UnsyncedReason::TooLarge {
                max_bytes: s(30_000),
                source: amby_sync_core::engine::LimitSource::Plan,
            },
        }]
    );
    assert!(!w.server_files().contains_key("A/big.bin"));
    assert!(!w.server_files().contains_key("B/exact.bin"));
    assert!(!w.server_files().contains_key("B/small.md"));
}

fn ls_a_blob_start_413_does_not_set_quota_full(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(Some(s(150_000)), Some(250_000)),
            "narrow": plan(Some(s(30_000)), Some(250_000))
        }
    }));
    w.save(0, "A/big.bin", &text(100_000, 'b'));
    w.save(0, "B/small.md", &text(1_000, 's'));
    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0)
        .faults
        .before_remote(RemoteKind::BlobStart, move || {
            assert_eq!(admin.run(&["user", "plan", "set", &name, "narrow"]).code, 0);
        });

    let report = w.dev(0).sync().expect("blob_start 413 is a limit outcome");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(!report.limits.quota_full);
    assert!(w.server_files().contains_key("B/small.md"));
    assert!(matches!(
        unsynced(&w).as_slice(),
        [(path, UnsyncedReason::TooLarge { .. })] if path == "A/big.bin"
    ));
}

fn ls_a_413_does_not_mark_a_folder_as_too_large(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(Some(s(100_000)), None),
            "narrow": plan(Some(1), None)
        }
    }));
    w.dev(0).fs.user_mkdir("Empty");
    w.save(0, "A/a.bin", &text(20_000, 'a'));
    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        assert_eq!(admin.run(&["user", "plan", "set", &name, "narrow"]).code, 0);
    });

    let report = w.dev(0).sync().expect("commit 413 is a limit outcome");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(
        report.unsynced,
        vec![amby_sync_core::engine::UnsyncedRecord {
            path: "A/a.bin".to_string(),
            reason: UnsyncedReason::TooLarge {
                max_bytes: 1,
                source: amby_sync_core::engine::LimitSource::Plan,
            },
        }]
    );
}

fn ls_a_commit_with_a_missing_body_is_rebuilt(_b: EngineBuilder) {
    let w = world(json!({
        "default_plan": "free",
        "plans": {"free": plan(None, None)}
    }));
    w.save(0, "A/a.bin", &text(20_000, 'a'));
    let state = w.dev(0).state.clone();
    let space = w.space(0);
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        let pending = state
            .snapshot()
            .commit
            .expect("commit is persisted before send");
        let body = pending.items[0].blob_id.expect("file commit has a body");
        assert_eq!(space.delete_blob(&body).status, 204);
    });

    let report = w.dev(0).sync().expect("unknown_blob is retried from disk");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(w.remote_calls(0, RemoteKind::BlobStart), 2);
    assert!(w.dev(0).state.snapshot().commit.is_none());
    assert!(w.dev(0).state.snapshot().uploads.is_empty());
    assert_eq!(w.server_files()["A/a.bin"], text(20_000, 'a').into_bytes());
}

real_only!(
    ls_a_pending_commit_rechecks_a_tightened_file_limit,
    ls_a_pending_commit_keeps_507_and_reports_only_files,
    ls_a_pending_commit_with_a_missing_body_is_rebuilt,
    ls_resuming_an_exact_pending_upload_works_with_no_free_quota,
    ls_changed_content_waits_for_pending_quota_without_a_new_upload,
    ls_changed_content_does_not_reuse_an_upload_nonce_prefix,
    ls_exactly_filling_free_quota_is_allowed,
    ls_replacing_a_body_credits_its_current_sealed_size,
    ls_a_507_mixed_commit_sends_folder_and_holds_body,
    ls_a_commit_413_report_marks_only_bodies_over_the_new_limit,
    ls_a_blob_start_413_does_not_set_quota_full,
    ls_a_413_does_not_mark_a_folder_as_too_large,
    ls_a_commit_with_a_missing_body_is_rebuilt,
);
