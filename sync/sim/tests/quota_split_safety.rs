//! A quota split must keep the plain-side record if shared-body usage still grows.
#![allow(clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::engine::UnsyncedReason;
use serde_json::{json, Map, Value};

fn sealed(n: u64) -> u64 {
    sealed_body_len(n).expect("sealed length")
}

fn plan(max_file: u64, max_total: u64) -> Value {
    let mut map = Map::new();
    map.insert("max_file_bytes".into(), json!(max_file));
    map.insert("max_total_bytes".into(), json!(max_total));
    Value::Object(map)
}

#[test]
fn a_shared_old_body_keeps_the_refused_shrink_in_the_pending_commit() {
    let plans = json!({
        "default_plan": "wide",
        "plans": {
            "wide": plan(sealed(100_000), sealed(200_000)),
            "narrow": plan(sealed(100_000), sealed(30_000))
        }
    });
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1).plans(&plans.to_string()),
    );

    let old = "a".repeat(30_000);
    let a = ItemId::from_bytes([0x50; 16]);
    let b = ItemId::from_bytes([0x51; 16]);
    w.inject_file(&a, 0, "A/a.bin", old.as_bytes());
    let body = w.versions_at("A/a.bin")[0]
        .header
        .body_id
        .expect("the first item has a body");
    let space = w.space(0);
    let second = space.file_with_uploaded_body(&b, 0, "B/b.bin", old.as_bytes(), &body);
    space.commit_ok(&[second]);

    w.pass(0);
    assert_eq!(w.read(0, "A/a.bin").as_deref(), Some(old.as_str()));
    assert_eq!(w.read(0, "B/b.bin").as_deref(), Some(old.as_str()));

    let shrunk = "s".repeat(20_000);
    let growth = "g".repeat(60_000);
    w.save(0, "A/a.bin", &shrunk);
    w.save(0, "Growth/new.bin", &growth);

    let admin = w.target().admin.clone();
    let username = w.accounts[0].username.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        assert_eq!(
            admin
                .run(&["user", "plan", "set", &username, "narrow"])
                .code,
            0
        );
    });

    let report = w.dev(0).sync().expect("quota refusals are handled");
    assert_eq!(report.outcome, CycleOutcome::Done);

    let pending = w
        .dev(0)
        .state
        .snapshot()
        .commit
        .expect("a definitive 507 keeps the rejected commit for replay");
    assert!(
        pending.items.iter().any(|item| item.item_id == a),
        "the shrink {a:?} remains queued; pending items: {:?}",
        pending
            .items
            .iter()
            .map(|item| item.item_id)
            .collect::<Vec<_>>()
    );

    let server = w.server_files();
    assert_eq!(server.get("A/a.bin"), Some(&old.as_bytes().to_vec()));
    assert_eq!(server.get("B/b.bin"), Some(&old.as_bytes().to_vec()));
    assert_eq!(w.versions_at("A/a.bin")[0].version, 1);
    assert_eq!(w.versions_at("B/b.bin")[0].version, 1);
    assert!(!server.contains_key("Growth/new.bin"));
    assert_eq!(w.read(0, "A/a.bin").as_deref(), Some(shrunk.as_str()));
    assert_eq!(w.read(0, "B/b.bin").as_deref(), Some(old.as_str()));
    assert_eq!(
        w.read(0, "Growth/new.bin").as_deref(),
        Some(growth.as_str())
    );
    assert!(report
        .unsynced
        .iter()
        .any(|item| { item.path == "A/a.bin" && item.reason == UnsyncedReason::QuotaFull }));
}
