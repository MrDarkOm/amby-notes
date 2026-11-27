//! Regression for Д75: a rename has no quota growth and must pass beside a held new body.
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

fn quota_rename_is_plain_even_when_growth_is_refused() {
    let plans = json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(Some(s(100_000)), Some(200_000)),
            "narrow": plan(Some(s(100_000)), Some(1))
        }
    });
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1).plans(&plans.to_string()),
    );
    w.save(0, "Old.md", "base");
    w.pass(0);
    w.dev(0).fs.user_rename("Old.md", "Renamed.md");
    w.save(0, "A/large.bin", &text(60_000, 'a'));

    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        assert_eq!(admin.run(&["user", "plan", "set", &name, "narrow"]).code, 0);
    });

    let report = w.dev(0).sync().expect("507 is a handled quota outcome");
    assert_eq!(report.outcome, CycleOutcome::Done);

    let server_files = w.server_files();
    assert_eq!(
        server_files.get("Renamed.md").map(Vec::as_slice),
        Some(b"base".as_slice())
    );
    assert!(!server_files.contains_key("Old.md"));
    assert!(!server_files.contains_key("A/large.bin"));
    assert_eq!(w.read(0, "Renamed.md").as_deref(), Some("base"));
    assert_eq!(
        w.read(0, "A/large.bin").as_deref(),
        Some(text(60_000, 'a').as_str())
    );
    assert_eq!(
        report.unsynced,
        vec![amby_sync_core::engine::UnsyncedRecord {
            path: "A/large.bin".to_string(),
            reason: UnsyncedReason::QuotaFull,
        }]
    );
}

#[test]
fn d75_rename_is_sent_while_growth_waits() {
    quota_rename_is_plain_even_when_growth_is_refused();
}

fn quota_shrink_is_plain_even_when_growth_is_refused() {
    let plans = json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(Some(s(100_000)), Some(200_000)),
            "narrow": plan(Some(s(100_000)), Some(1))
        }
    });
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1).plans(&plans.to_string()),
    );
    w.save(0, "A/shrink.bin", &text(30_000, 'a'));
    w.pass(0);
    w.save(0, "A/shrink.bin", &text(20_000, 'b'));
    w.save(0, "B/growth.bin", &text(60_000, 'g'));

    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        assert_eq!(admin.run(&["user", "plan", "set", &name, "narrow"]).code, 0);
    });

    let report = w.dev(0).sync().expect("507 is a handled quota outcome");
    assert_eq!(report.outcome, CycleOutcome::Done);

    let server_files = w.server_files();
    assert_eq!(
        server_files.get("A/shrink.bin").map(Vec::as_slice),
        Some(text(20_000, 'b').as_bytes()),
        "the smaller replacement must pass while growth waits"
    );
    assert!(!server_files.contains_key("B/growth.bin"));
    assert_eq!(
        w.read(0, "A/shrink.bin").as_deref(),
        Some(text(20_000, 'b').as_str())
    );
    assert_eq!(
        w.read(0, "B/growth.bin").as_deref(),
        Some(text(60_000, 'g').as_str())
    );
    assert_eq!(
        report.unsynced,
        vec![amby_sync_core::engine::UnsyncedRecord {
            path: "B/growth.bin".to_string(),
            reason: UnsyncedReason::QuotaFull,
        }]
    );
}

#[test]
fn d75_shrink_is_sent_while_growth_waits() {
    quota_shrink_is_plain_even_when_growth_is_refused();
}
