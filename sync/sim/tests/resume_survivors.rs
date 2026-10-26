//! Resumption checks where an interrupted upload belongs to an already-synchronised item.
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

fn world_with_total(total: Option<u64>) -> World {
    let mut limits = Map::new();
    if let Some(value) = total {
        limits.insert("max_total_bytes".into(), json!(value));
    }
    let plans = json!({
        "default_plan": "test",
        "plans": {"test": Value::Object(limits)}
    });
    World::new(
        Engine::boxed,
        WorldOptions::new(1).plans(&plans.to_string()),
    )
}

fn blob_start_id(w: &World) -> [u8; 16] {
    w.dev(0)
        .faults
        .remote_log()
        .into_iter()
        .find(|call| call.kind == RemoteKind::BlobStart)
        .and_then(|call| call.blob)
        .expect("a blob_start was sent")
}

#[test]
fn changed_content_of_an_existing_item_gets_a_new_pending_body() {
    let w = world_with_total(None);
    w.save(0, "A/a.bin", &text(10_000, 'x'));
    w.pass(0);
    let (item, _) = w.item_at("A/a.bin");

    w.save(0, "A/a.bin", &text(30_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::PutPart(0));
    assert!(w.dev(0).sync().is_err(), "the first part is interrupted");
    let first_blob = blob_start_id(&w);
    assert!(w
        .dev(0)
        .state
        .snapshot()
        .uploads
        .values()
        .any(|upload| upload.item_id == item));

    w.save(0, "A/a.bin", &text(30_000, 'b'));
    w.pass(0);
    let second_blob = blob_start_id(&w);

    assert_ne!(
        first_blob, second_blob,
        "different bytes need a different body id"
    );
    assert_eq!(
        w.item_at("A/a.bin").0,
        item,
        "the existing item stays the same"
    );
    assert_eq!(w.server_files()["A/a.bin"], text(30_000, 'b').into_bytes());
}

#[test]
fn changed_content_does_not_bypass_the_quota_resume_forecast() {
    let w = world_with_total(Some(s(10_000) + s(30_000)));
    w.save(0, "A/a.bin", &text(10_000, 'x'));
    w.pass(0);
    let (item, _) = w.item_at("A/a.bin");

    w.save(0, "A/a.bin", &text(30_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::PutPart(0));
    assert!(w.dev(0).sync().is_err(), "the first part is interrupted");
    assert!(w
        .dev(0)
        .state
        .snapshot()
        .uploads
        .values()
        .any(|upload| upload.item_id == item));
    assert_eq!(w.overview()["usage"]["pending_bytes"], s(30_000));

    w.save(0, "A/a.bin", &text(30_000, 'b'));
    let report = w.pass(0);

    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(w.remote_calls(0, RemoteKind::BlobStart), 0);
    assert_eq!(w.remote_calls(0, RemoteKind::BlobDelete), 1);
    assert_eq!(
        w.read(0, "A/a.bin").as_deref(),
        Some(text(30_000, 'b').as_str())
    );
    assert_eq!(
        w.server_files()["A/a.bin"],
        text(10_000, 'x').into_bytes(),
        "a changed file still waiting for room does not replace the old server version"
    );
    assert_eq!(w.item_at("A/a.bin").0, item);
    assert_eq!(
        w.dev(0).state.snapshot().unsynced,
        vec![amby_sync_core::engine::UnsyncedRecord {
            path: "A/a.bin".to_string(),
            reason: UnsyncedReason::QuotaFull,
        }]
    );
}
