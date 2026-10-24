//! The engine and the limits of plans (appendix Е: Д73–Д78), against the real server with a
//! plans file. Real engine only: the mini-engine knows no limits. Written before the code.
//!
//! Sizes are chosen far from the edges of the padding (`sealed_body_len` rounds up), and the
//! limits are computed from it, so a test never depends on the exact padding.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::engine::{LimitSource, UnsyncedReason};
use serde_json::{json, Map, Value};

/// The sealed size of `n` bytes of content.
fn s(n: u64) -> u64 {
    sealed_body_len(n).unwrap()
}

fn plan(file: Option<u64>, total: Option<u64>) -> Value {
    let mut map = Map::new();
    if let Some(n) = file {
        map.insert("max_file_bytes".into(), json!(n));
    }
    if let Some(n) = total {
        map.insert("max_total_bytes".into(), json!(n));
    }
    Value::Object(map)
}

/// A file with `tight` (the default plan) and a roomy plan and a free one to move to.
fn plans(tight_file: Option<u64>, tight_total: Option<u64>) -> String {
    json!({
        "default_plan": "tight",
        "plans": {
            "tight": plan(tight_file, tight_total),
            "roomy": plan(Some(s(400_000)), None),
            "free": {}
        }
    })
    .to_string()
}

fn world(devices: usize, plans: &str) -> World {
    World::new(Engine::boxed, WorldOptions::new(devices).plans(plans))
}

fn listed(w: &World, d: usize) -> Vec<(String, UnsyncedReason)> {
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

fn text(n: usize, c: char) -> String {
    c.to_string().repeat(n)
}

// ----- Д74: a file that is too big stays here -----

fn d74_a_file_over_the_plan_limit_stays_on_disk_is_listed_and_the_server_is_untouched(
    _b: EngineBuilder,
) {
    // Д74, П59: not sent, not deleted, in "not synchronised" with the limit and its source; the
    // rest goes; the other device gets nothing of it.
    let w = world(2, &plans(Some(s(30_000)), None));
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/huge.bin", &text(100_000, 'h'));
    w.save(0, "Big/fine.bin", &text(10_000, 'f'));
    let report = w.pass(0);
    assert_eq!(
        listed(&w, 0),
        vec![(
            "Big/huge.bin".to_string(),
            UnsyncedReason::TooLarge {
                max_bytes: s(30_000),
                source: LimitSource::Plan
            }
        )]
    );
    assert_eq!(report.limits.max_file_bytes, s(30_000));
    assert_eq!(report.limits.max_file_source, LimitSource::Plan);
    assert_eq!(
        w.dev(0).fs.content("Big/huge.bin").unwrap(),
        text(100_000, 'h').into_bytes(),
        "the file is as it was"
    );
    assert!(disk_changes(&w, 0)
        .iter()
        .all(|e| !matches!(e, FsEvent::Trash { .. })));
    let on_server = w.server_files();
    assert!(on_server.contains_key("Big/fine.bin"));
    assert!(!on_server.contains_key("Big/huge.bin"));
    w.pass(1);
    assert!(!w.dev(1).fs.exists("Big/huge.bin"));
    assert!(w.dev(1).fs.exists("Big/fine.bin"));
}

fn d74_the_ceiling_of_the_server_is_named_as_the_server(_b: EngineBuilder) {
    // Д74: no plan limit, a ceiling of the server: `source: Server`.
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1)
            .plans(&plans(None, None))
            .max_blob_bytes(s(30_000)),
    );
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/huge.bin", &text(100_000, 'h'));
    w.pass(0);
    assert_eq!(w.remote_calls(0, RemoteKind::Account), 1);
    assert_eq!(
        listed(&w, 0),
        vec![(
            "Big/huge.bin".to_string(),
            UnsyncedReason::TooLarge {
                max_bytes: s(30_000),
                source: LimitSource::Server
            }
        )]
    );
}

fn d74_when_the_limit_grows_the_file_goes_by_itself(_b: EngineBuilder) {
    // Д74, Д73: nothing is kept between passes; the next pass reads the account again.
    let w = world(2, &plans(Some(s(30_000)), None));
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/huge.bin", &text(100_000, 'h'));
    w.pass(0);
    assert!(!w.server_files().contains_key("Big/huge.bin"));
    w.set_plan("roomy");
    w.pass(0);
    assert!(w.server_files().contains_key("Big/huge.bin"));
    assert!(listed(&w, 0).is_empty());
    w.pass(1);
    assert_eq!(
        w.dev(1).fs.content("Big/huge.bin").unwrap(),
        text(100_000, 'h').into_bytes()
    );
}

fn d74_a_file_made_smaller_goes(_b: EngineBuilder) {
    let w = world(2, &plans(Some(s(30_000)), None));
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/huge.bin", &text(100_000, 'h'));
    w.pass(0);
    assert_eq!(listed(&w, 0).len(), 1, "too big at first");
    w.save(0, "Big/huge.bin", &text(10_000, 'h'));
    w.pass(0);
    assert!(w.server_files().contains_key("Big/huge.bin"));
    assert!(listed(&w, 0).is_empty());
}

fn d74_lowering_the_plan_does_not_turn_synchronised_files_into_deletions(_b: EngineBuilder) {
    // Д74, П57: the file is on the server and on both devices; the plan drops under its size;
    // nobody touches the file; nothing happens to it anywhere.
    let w = world(2, &plans(Some(s(30_000)), None));
    w.set_plan("roomy");
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/big.bin", &text(100_000, 'b'));
    w.pass(0);
    w.pass(1);
    let head = w.server_head();
    w.set_plan("free");
    w.set_plan("tight");
    for d in 0..2 {
        let report = w.pass(d);
        assert_eq!(report.outcome, CycleOutcome::Done);
        assert!(listed(&w, d).is_empty(), "an unchanged file is not listed");
        assert!(w.dev(d).fs.exists("Big/big.bin"));
    }
    assert_eq!(w.server_head(), head, "the server saw no commit");
    assert!(w.server_files().contains_key("Big/big.bin"));
}

fn d74_a_changed_file_that_stays_too_big_is_listed_and_the_old_version_remains(_b: EngineBuilder) {
    let w = world(2, &plans(Some(s(30_000)), None));
    w.set_plan("roomy");
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/big.bin", &text(100_000, 'b'));
    w.pass(0);
    w.pass(1);
    w.set_plan("tight");
    w.save(0, "Big/big.bin", &text(120_000, 'c'));
    w.pass(0);
    assert!(matches!(
        listed(&w, 0).as_slice(),
        [(path, UnsyncedReason::TooLarge { .. })] if path == "Big/big.bin"
    ));
    assert_eq!(
        w.server_files()["Big/big.bin"],
        text(100_000, 'b').into_bytes(),
        "the old version on the server is neither changed nor deleted"
    );
    w.pass(1);
    assert_eq!(
        w.dev(1).fs.content("Big/big.bin").unwrap(),
        text(100_000, 'b').into_bytes()
    );
}

fn d74_a_foreign_edit_of_a_file_that_waits_is_a_conflict_and_both_versions_are_kept(
    _b: EngineBuilder,
) {
    // Д74, Р7: the local edit cannot go up; somebody else edits the same item; the rules of the
    // table apply and nothing is lost.
    let w = world(2, &plans(Some(s(30_000)), None));
    w.set_plan("roomy");
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/big.bin", &text(100_000, 'b'));
    w.pass(0);
    w.pass(1);
    let (item, version) = w.item_at("Big/big.bin");
    w.set_plan("free");
    w.inject_file(&item, version, "Big/big.bin", text(5_000, 'x').as_bytes());
    w.set_plan("tight");
    w.save(0, "Big/big.bin", &text(120_000, 'c'));
    let report = w.pass(0);
    let everything: Vec<Vec<u8>> = w.dev(0).fs.files().into_values().collect();
    for wanted in [text(120_000, 'c'), text(5_000, 'x')] {
        assert!(
            everything
                .iter()
                .any(|content| content == wanted.as_bytes()),
            "a version was lost"
        );
    }
    assert!(
        !report.conflicts.is_empty() || !w.dev(0).state.snapshot().conflicts.is_empty(),
        "the conflict is recorded"
    );
}

// ----- Д73, Д76: the account may be missing, the checks are only a forecast -----

fn d73_without_the_account_the_old_behaviour_holds_and_the_pass_goes_on(_b: EngineBuilder) {
    // Д73: a lost `account()` stops nothing; only the ceiling of `info` applies, and the report
    // does not claim a free place.
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(1)
            .plans(&plans(Some(s(30_000)), None))
            .max_blob_bytes(s(200_000)),
    );
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "fine");
    w.dev(0).faults.drop_request_of(RemoteKind::Account);
    let report = w
        .dev(0)
        .sync()
        .expect("a lost account request is not a failure");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(
        w.remote_calls(0, RemoteKind::Account),
        1,
        "the account is asked once per pass"
    );
    assert_eq!(report.limits.free_bytes, None);
    assert!(w.server_files().contains_key("Notes/a.md"));
}

fn d76_a_413_from_the_server_after_a_forecast_of_success_becomes_a_listed_reason(
    _b: EngineBuilder,
) {
    // Д76: the plan shrinks between `account()` and the first upload. The refusal gives the same
    // result as the forecast: the file stays, it is listed, the pass goes on and the next, small
    // file is sent.
    let both = json!({
        "default_plan": "wide",
        "plans": {"wide": plan(Some(s(300_000)), None), "narrow": plan(Some(s(30_000)), None)}
    })
    .to_string();
    let w = world(1, &both);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "A/a-big.bin", &text(100_000, 'a'));
    w.save(0, "B/b-small.md", &text(1_000, 'b'));
    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0)
        .faults
        .before_remote(RemoteKind::BlobStart, move || {
            assert_eq!(admin.run(&["user", "plan", "set", &name, "narrow"]).code, 0);
        });
    let report = w
        .dev(0)
        .sync()
        .expect("a refusal by a limit is not a failure");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(
        matches!(
            listed(&w, 0).as_slice(),
            [(path, UnsyncedReason::TooLarge { .. })] if path == "A/a-big.bin"
        ),
        "{:?}",
        listed(&w, 0)
    );
    assert_eq!(
        w.dev(0).fs.content("A/a-big.bin").unwrap(),
        text(100_000, 'a').into_bytes()
    );
    assert!(w.server_files().contains_key("B/b-small.md"));
}

// ----- Д75: the quota is full -----

/// Sealed size of the 25 000 byte files that fill the quota.
fn filler() -> u64 {
    s(25_000)
}

/// A world with a quota of 100 000 sealed bytes where device 1 has put three 25 000 byte files:
/// less than one more of that size is left.
fn almost_full() -> World {
    let w = world(2, &plans(None, Some(100_000)));
    for (i, name) in ["f1", "f2", "f3"].iter().enumerate() {
        w.save(
            1,
            &format!("Fill/{name}.bin"),
            &text(25_000, (b'a' + i as u8) as char),
        );
    }
    w.save(1, "Keep/k.md", "keep");
    w.pass(1);
    assert!(filler() * 3 <= 100_000 && 100_000 - filler() * 3 < filler());
    w
}

fn d75_a_full_quota_stops_sending_and_keeps_the_file_receiving_goes_on(_b: EngineBuilder) {
    let w = almost_full();
    w.save(0, "New/big.bin", &text(25_000, 'n'));
    w.save(0, "New/small.md", &text(1_000, 's'));
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(
        listed(&w, 0),
        vec![("New/big.bin".to_string(), UnsyncedReason::QuotaFull)]
    );
    assert!(report.limits.quota_full);
    assert!(w.dev(0).fs.exists("New/big.bin"), "nothing is deleted");
    let on_server = w.server_files();
    assert!(on_server.contains_key("New/small.md"));
    assert!(!on_server.contains_key("New/big.bin"));
    // the files of the other device came down as usual
    assert!(w.dev(0).fs.exists("Fill/f1.bin") && w.dev(0).fs.exists("Fill/f3.bin"));
    // and later incoming changes too
    w.save(1, "Fill/new-from-1.md", "from one");
    w.pass(1);
    w.pass(0);
    assert_eq!(w.read(0, "Fill/new-from-1.md").as_deref(), Some("from one"));
}

fn d75_what_waits_goes_up_when_room_appears(_b: EngineBuilder) {
    let w = almost_full();
    w.save(0, "New/big.bin", &text(25_000, 'n'));
    w.pass(0);
    assert!(!w.server_files().contains_key("New/big.bin"));
    w.dev(1).fs.user_delete("Fill/f1.bin");
    w.pass(1);
    w.pass(0);
    assert!(w.server_files().contains_key("New/big.bin"));
    assert!(listed(&w, 0).is_empty());
}

fn d75_deletions_renames_and_folders_go_when_the_quota_is_full(_b: EngineBuilder) {
    // Д75: commits that do not grow the bodies are not held.
    let w = almost_full();
    w.pass(0);
    w.save(0, "New/big.bin", &text(25_000, 'n'));
    w.dev(0).fs.user_delete("Fill/f2.bin");
    w.dev(0).fs.user_rename("Fill/f3.bin", "Moved/f3.bin");
    w.pass(0);
    let on_server = w.server_files();
    assert!(!on_server.contains_key("Fill/f2.bin"));
    assert!(on_server.contains_key("Moved/f3.bin"));
    // the forecast of this pass was made before the deletion: the big file waits one pass
    assert_eq!(
        listed(&w, 0),
        vec![("New/big.bin".to_string(), UnsyncedReason::QuotaFull)]
    );
    w.pass(0);
    assert!(w.server_files().contains_key("New/big.bin"));
    assert!(listed(&w, 0).is_empty());
}

fn d75_free_bytes_are_spent_inside_one_pass(_b: EngineBuilder) {
    // Д75, Е.10: room for one and a half files; the first goes, the others are not even
    // started — the server gets one `blob_start`, not three.
    let one = s(10_000);
    let w = world(1, &plans(None, Some(one + one / 2)));
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    for (name, c) in [("a", 'a'), ("b", 'b'), ("c", 'c')] {
        w.save(0, &format!("Files/{name}.bin"), &text(10_000, c));
    }
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(
        w.remote_calls(0, RemoteKind::BlobStart),
        1,
        "the others do not fit in what is left and are not sent to the server at all"
    );
    let quota_full = listed(&w, 0)
        .iter()
        .filter(|(_, reason)| *reason == UnsyncedReason::QuotaFull)
        .count();
    assert_eq!(quota_full, 2);
    assert_eq!(
        w.server_files()
            .keys()
            .filter(|path| path.starts_with("Files/"))
            .count(),
        1
    );
}

fn d75_a_507_on_one_file_does_not_stop_the_others_and_is_not_repeated(_b: EngineBuilder) {
    // Д75, Д76: the forecast says everything fits; before the first upload another device
    // takes the room. The first file gets 507, the pass goes on, a smaller later file is tried
    // and goes, nothing is requested twice.
    let w = world(2, &plans(None, Some(100_000)));
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "A/a-big.bin", &text(60_000, 'a'));
    w.save(0, "B/b-small.md", &text(1_000, 'b'));
    let space = w.space(1);
    w.dev(0)
        .faults
        .before_remote(RemoteKind::BlobStart, move || {
            space.commit_ok(&[space.raw_file(
                &amby_sync_conformance::client::new_item(),
                0,
                "other.bin",
                70_000,
            )]);
        });
    let report = w.dev(0).sync().expect("a 507 is not a failure of the pass");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(
        listed(&w, 0),
        vec![("A/a-big.bin".to_string(), UnsyncedReason::QuotaFull)]
    );
    assert!(w.server_files().contains_key("B/b-small.md"));
    assert_eq!(w.remote_calls(0, RemoteKind::BlobStart), 2);
}

fn d76_a_commit_refused_with_507_keeps_the_record_and_goes_again_next_pass(_b: EngineBuilder) {
    // Д76, С2, Д7, П56-в: the bodies are up, then the quota shrinks, and the commit is refused as
    // a whole. The file stays, the record of what is being sent stays in the state, and the next
    // pass sends it.
    let both = json!({
        "default_plan": "roomy",
        "plans": {"roomy": plan(None, Some(100_000)), "cramped": plan(None, Some(30_000))}
    })
    .to_string();
    let w = world(1, &both);
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "A/a.bin", &text(60_000, 'a'));
    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        assert_eq!(
            admin.run(&["user", "plan", "set", &name, "cramped"]).code,
            0
        );
    });
    let report = w
        .dev(0)
        .sync()
        .expect("a refused commit is not a failure of the pass");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.dev(0).fs.exists("A/a.bin"));
    assert!(!w.server_files().contains_key("A/a.bin"));
    assert!(
        w.dev(0).state.snapshot().commit.is_some(),
        "the record of what is being sent stays until it succeeds"
    );
    assert!(listed(&w, 0)
        .iter()
        .any(|(p, r)| p == "A/a.bin" && *r == UnsyncedReason::QuotaFull));
    w.set_plan("roomy");
    w.pass(0);
    assert!(w.server_files().contains_key("A/a.bin"));
    assert!(w.dev(0).state.snapshot().commit.is_none());
    assert!(listed(&w, 0).is_empty());
}

fn d75_an_abandoned_upload_is_released_with_blob_delete(_b: EngineBuilder) {
    // Д75, П56-д: the file changed after the upload began; the begun body is dropped.
    let w = world(1, &plans(None, Some(100_000)));
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "A/a.bin", &text(30_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::PutPart(0));
    assert!(w.dev(0).sync().is_err(), "the upload was cut");
    assert!(!w.dev(0).state.snapshot().uploads.is_empty());
    assert!(w.overview()["usage"]["pending_bytes"].as_u64().unwrap() > 0);
    w.save(0, "A/a.bin", &text(31_000, 'b'));
    w.pass(0);
    assert_eq!(w.remote_calls(0, RemoteKind::BlobDelete), 1);
    assert!(w.server_files().contains_key("A/a.bin"));
    assert_eq!(w.overview()["usage"]["pending_bytes"], 0);
}

fn d75_a_failing_blob_delete_is_not_an_error_of_the_pass(_b: EngineBuilder) {
    // Д75: best effort; the cleanup of the server (24 hours) will do it anyway.
    let w = world(1, &plans(None, Some(100_000)));
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "A/a.bin", &text(30_000, 'a'));
    w.dev(0).faults.drop_request_of(RemoteKind::PutPart(0));
    let _ = w.dev(0).sync();
    w.dev(0).fs.user_delete("A/a.bin");
    w.dev(0).faults.drop_request_of(RemoteKind::BlobDelete);
    let report = w
        .dev(0)
        .sync()
        .expect("a failed blob_delete does not fail the pass");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.errors.is_empty());
    assert_eq!(w.remote_calls(0, RemoteKind::BlobDelete), 1);
}

// ----- Д78: interplay -----

fn d78_the_memory_limit_stays_the_first_reason(_b: EngineBuilder) {
    let w = world(1, &plans(Some(s(30_000)), None));
    *w.dev(0).config_tweak.borrow_mut() = Some(Box::new(|c| c.max_file_bytes = 100_000));
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/huge.bin", &text(150_000, 'h'));
    let report = w.pass(0);
    assert_eq!(report.limits.max_file_bytes, s(30_000));
    assert_eq!(
        listed(&w, 0),
        vec![("Big/huge.bin".to_string(), UnsyncedReason::TooBigForMemory)]
    );
}

fn d78_a_merge_result_that_does_not_fit_stays_local_and_the_server_keeps_the_old(
    _b: EngineBuilder,
) {
    // Д78-б: both edited a note; the merged text is over the limit: it stays here, the server
    // keeps the other device's version, nothing is lost.
    let w = world(2, &plans(Some(s(30_000)), None));
    w.set_plan("roomy");
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "line one\nline two\n");
    w.pass(0);
    w.pass(1);
    w.set_plan("tight");
    w.save(0, "Notes/a.md", "line one\nline two\nfrom zero\n");
    w.pass(0);
    let big = format!("line one\nline two\n{}\n", text(100_000, 'z'));
    w.save(1, "Notes/a.md", &big);
    w.pass(1);
    let local = w.read(1, "Notes/a.md").unwrap();
    assert!(local.contains(&text(100_000, 'z')), "the long edit is kept");
    assert!(
        local.contains("from zero"),
        "the other edit is merged in or kept in a set"
    );
    assert!(w
        .server_files()
        .get("Notes/a.md")
        .is_some_and(|content| content == b"line one\nline two\nfrom zero\n"));
    assert!(listed(&w, 1)
        .iter()
        .any(|(p, r)| p == "Notes/a.md" && matches!(r, UnsyncedReason::TooLarge { .. })));
}

fn d78_edits_blocked_by_a_limit_are_not_a_mass_change(_b: EngineBuilder) {
    // Д78-в: twenty-five files become too big for the new plan and are edited here: no stop, no
    // outgoing change, nothing deleted.
    let w = world(1, &plans(Some(s(30_000)), None));
    w.scale_mass_threshold(5);
    w.set_plan("roomy");
    w.save(0, "Keep/k.md", "keep");
    for n in 0..25 {
        w.save(0, &format!("Many/{n:02}.bin"), &text(40_000, 'm'));
    }
    w.pass(0);
    w.set_plan("tight");
    for n in 0..25 {
        w.save(0, &format!("Many/{n:02}.bin"), &text(41_000, 'n'));
    }
    let report = w.dev(0).sync().expect("no failure");
    assert_eq!(report.outcome, CycleOutcome::Done, "a limit is not a stop");
    assert_eq!(listed(&w, 0).len(), 25);
    assert_eq!(
        w.server_files()
            .iter()
            .filter(|(path, content)| path.starts_with("Many/") && content.starts_with(b"m"))
            .count(),
        25
    );
}

fn d78_deleting_a_file_that_never_reached_the_server_sends_nothing(_b: EngineBuilder) {
    let w = world(1, &plans(Some(s(30_000)), None));
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Big/huge.bin", &text(100_000, 'h'));
    w.pass(0);
    let head = w.server_head();
    w.dev(0).fs.user_delete("Big/huge.bin");
    let report = w.pass(0);
    assert_eq!(
        w.server_head(),
        head,
        "no deletion goes for an item the server never had"
    );
    assert!(listed(&w, 0).is_empty());
    assert_eq!(report.outcome, CycleOutcome::Done);
}

real_only!(
    d74_a_file_over_the_plan_limit_stays_on_disk_is_listed_and_the_server_is_untouched,
    d74_the_ceiling_of_the_server_is_named_as_the_server,
    d74_when_the_limit_grows_the_file_goes_by_itself,
    d74_a_file_made_smaller_goes,
    d74_lowering_the_plan_does_not_turn_synchronised_files_into_deletions,
    d74_a_changed_file_that_stays_too_big_is_listed_and_the_old_version_remains,
    d74_a_foreign_edit_of_a_file_that_waits_is_a_conflict_and_both_versions_are_kept,
    d73_without_the_account_the_old_behaviour_holds_and_the_pass_goes_on,
    d76_a_413_from_the_server_after_a_forecast_of_success_becomes_a_listed_reason,
    d75_a_full_quota_stops_sending_and_keeps_the_file_receiving_goes_on,
    d75_what_waits_goes_up_when_room_appears,
    d75_deletions_renames_and_folders_go_when_the_quota_is_full,
    d75_free_bytes_are_spent_inside_one_pass,
    d75_a_507_on_one_file_does_not_stop_the_others_and_is_not_repeated,
    d76_a_commit_refused_with_507_keeps_the_record_and_goes_again_next_pass,
    d75_an_abandoned_upload_is_released_with_blob_delete,
    d75_a_failing_blob_delete_is_not_an_error_of_the_pass,
    d78_the_memory_limit_stays_the_first_reason,
    d78_a_merge_result_that_does_not_fit_stays_local_and_the_server_keeps_the_old,
    d78_edits_blocked_by_a_limit_are_not_a_mass_change,
    d78_deleting_a_file_that_never_reached_the_server_sends_nothing,
);
