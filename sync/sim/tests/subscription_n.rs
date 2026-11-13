//! The engine and the subscription (appendix Н: Н9), against the real server with a plans file.
//! Real engine only: the mini-engine knows no plans. Written before the code.
//!
//! `sub` is the default plan and has sync; `nosub` has none. The tests move the one account
//! between them with the administrator command, as the owner of the server would.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::engine::UnsyncedReason;
use serde_json::json;

fn plans() -> String {
    json!({
        "default_plan": "sub",
        "plans": {
            "sub": {"title": "Subscription", "sync": true},
            "nosub": {"title": "No subscription", "sync": false}
        }
    })
    .to_string()
}

fn world(devices: usize) -> World {
    World::new(Engine::boxed, WorldOptions::new(devices).plans(&plans()))
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

fn waiting(paths: &[&str]) -> Vec<(String, UnsyncedReason)> {
    let mut list: Vec<_> = paths
        .iter()
        .map(|p| (p.to_string(), UnsyncedReason::SubscriptionRequired))
        .collect();
    list.sort_by(|a, b| a.0.cmp(&b.0));
    list
}

fn text(n: usize, c: char) -> String {
    c.to_string().repeat(n)
}

/// A vault with something already on the server (so the first pass is an ordinary one), then
/// the subscription is taken away.
fn without_subscription(devices: usize) -> World {
    let w = world(devices);
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.set_plan("nosub");
    w
}

// ----- Н9: nothing is sent, everything waiting is listed -----

fn n9_without_sync_nothing_is_sent_and_every_waiting_file_has_the_reason(_b: EngineBuilder) {
    // Н9: the account says `sync: false` before sending: no body, no commit (no deletions here); every waiting file is
    // "not synchronised" with `SubscriptionRequired`; the files stay; the pass is a normal one.
    let w = without_subscription(1);
    w.save(0, "New/a.md", "alpha");
    w.save(0, "New/b.md", &text(5_000, 'b'));
    w.save(0, "Other/c.bin", &text(20_000, 'c'));
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(
        listed(&w, 0),
        waiting(&["New/a.md", "New/b.md", "Other/c.bin"])
    );
    assert_eq!(w.remote_calls(0, RemoteKind::BlobStart), 0);
    assert_eq!(w.remote_calls(0, RemoteKind::Commit), 0);
    let on_server = w.server_files();
    assert_eq!(
        on_server.len(),
        1,
        "only what was there before: {on_server:?}"
    );
    assert!(on_server.contains_key("Keep/k.md"));
    assert_eq!(w.read(0, "New/a.md").as_deref(), Some("alpha"));
    assert_eq!(w.read(0, "New/b.md"), Some(text(5_000, 'b')));
    // asking again changes nothing: still done, still nothing sent, no failure
    let again = w.pass(0);
    assert_eq!(again.outcome, CycleOutcome::Done);
    assert!(again.errors.is_empty());
    assert_eq!(w.remote_calls(0, RemoteKind::BlobStart), 0);
    assert_eq!(w.remote_calls(0, RemoteKind::Commit), 0);
    assert_eq!(
        listed(&w, 0),
        waiting(&["New/a.md", "New/b.md", "Other/c.bin"])
    );
}

fn n9_receiving_goes_on_without_a_subscription(_b: EngineBuilder) {
    // Н9, Д75: what the other device sent before comes down as usual; the local file waits.
    let w = world(2);
    w.save(1, "From/one.md", "from one");
    w.save(1, "From/two.md", "from two");
    w.pass(1);
    w.set_plan("nosub");
    w.save(0, "Mine/m.md", "mine");
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(w.read(0, "From/one.md").as_deref(), Some("from one"));
    assert_eq!(w.read(0, "From/two.md").as_deref(), Some("from two"));
    assert_eq!(listed(&w, 0), waiting(&["Mine/m.md"]));
    assert!(!w.server_files().contains_key("Mine/m.md"));
    // a later change made on the other device while it still could send also comes down
    w.set_plan("sub");
    w.save(1, "From/three.md", "three");
    w.pass(1);
    w.set_plan("nosub");
    w.pass(0);
    assert_eq!(w.read(0, "From/three.md").as_deref(), Some("three"));
    assert_eq!(listed(&w, 0), waiting(&["Mine/m.md"]));
}

fn n9_a_deletion_is_sent_without_a_subscription_while_a_new_file_waits(_b: EngineBuilder) {
    // Н9, Н4, О4: deletions go in a commit of their own; the new file of the same pass waits with
    // the reason; the other device moves the deleted file to the vault trash as usual.
    let w = world(2);
    w.save(0, "Docs/x.md", "x");
    w.save(0, "Docs/y.md", "y");
    w.pass(0);
    w.pass(1);
    w.set_plan("nosub");
    w.dev(0).fs.user_delete("Docs/x.md");
    w.save(0, "Docs/z.md", "z");
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let on_server = w.server_files();
    assert!(!on_server.contains_key("Docs/x.md"), "the deletion went");
    assert!(on_server.contains_key("Docs/y.md"));
    assert!(!on_server.contains_key("Docs/z.md"), "the new file did not");
    assert_eq!(listed(&w, 0), waiting(&["Docs/z.md"]));
    assert_eq!(w.read(0, "Docs/z.md").as_deref(), Some("z"));
    assert!(
        !w.dev(0).fs.exists("Docs/x.md"),
        "and the file is not restored"
    );
    w.pass(1);
    assert!(!w.dev(1).fs.exists("Docs/x.md"));
    assert!(
        disk_changes(&w, 1)
            .iter()
            .any(|e| matches!(e, FsEvent::Trash { .. })),
        "the other device moved it to the trash"
    );
    assert!(w.dev(1).fs.exists("Docs/y.md") && !w.dev(1).fs.exists("Docs/z.md"));
    // the subscription is back: the waiting file goes
    w.set_plan("sub");
    w.pass(0);
    assert_eq!(w.server_files().get("Docs/z.md"), Some(&b"z".to_vec()));
    assert!(listed(&w, 0).is_empty());
}

// ----- Н9: a 403 during sending -----

fn n9_a_403_on_the_first_body_is_not_a_failed_pass_and_stops_the_sending(_b: EngineBuilder) {
    // Н9: the account said "allowed", then the subscription went before the first body: the
    // answer `403 subscription_required` is a result, not an error; no repeats inside the pass;
    // every file waits with the reason; nothing is lost.
    let w = world(1);
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "A/a.md", &text(3_000, 'a'));
    w.save(0, "B/b.md", &text(4_000, 'b'));
    w.save(0, "C/c.md", &text(5_000, 'c'));
    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0)
        .faults
        .before_remote(RemoteKind::BlobStart, move || {
            assert_eq!(admin.run(&["user", "plan", "set", &name, "nosub"]).code, 0);
        });
    let report = w
        .dev(0)
        .sync()
        .expect("a 403 subscription_required is not a failure of the pass");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(listed(&w, 0), waiting(&["A/a.md", "B/b.md", "C/c.md"]));
    assert_eq!(
        w.remote_calls(0, RemoteKind::BlobStart),
        1,
        "the answer holds for the whole account: the other files are not tried"
    );
    assert_eq!(w.remote_calls(0, RemoteKind::Commit), 0);
    for (path, c, n) in [
        ("A/a.md", 'a', 3_000),
        ("B/b.md", 'b', 4_000),
        ("C/c.md", 'c', 5_000),
    ] {
        assert_eq!(w.read(0, path), Some(text(n, c)), "{path} stays on disk");
    }
    assert_eq!(w.server_files().len(), 1);
    // the next pass finds the subscription still missing and does not send
    let next = w.pass(0);
    assert_eq!(next.outcome, CycleOutcome::Done);
    assert_eq!(w.remote_calls(0, RemoteKind::BlobStart), 0);
    // the subscription is back: everything goes
    w.set_plan("sub");
    w.pass(0);
    let on_server = w.server_files();
    assert_eq!(
        on_server.get("A/a.md"),
        Some(&text(3_000, 'a').into_bytes())
    );
    assert_eq!(
        on_server.get("B/b.md"),
        Some(&text(4_000, 'b').into_bytes())
    );
    assert_eq!(
        on_server.get("C/c.md"),
        Some(&text(5_000, 'c').into_bytes())
    );
    assert!(listed(&w, 0).is_empty());
}

fn n9_a_403_on_the_commit_keeps_the_file_and_the_next_pass_sends_it(_b: EngineBuilder) {
    // Н9, Д76-like: the bodies are up, the subscription goes, the commit is refused as a whole.
    // The file stays, is listed with the reason, and goes after the subscription is given.
    let w = world(1);
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.save(0, "A/a.md", &text(3_000, 'a'));
    w.save(0, "B/b.md", &text(4_000, 'b'));
    let admin = w.target().admin.clone();
    let name = w.accounts[0].username.clone();
    w.dev(0).faults.before_remote(RemoteKind::Commit, move || {
        assert_eq!(admin.run(&["user", "plan", "set", &name, "nosub"]).code, 0);
    });
    let report = w
        .dev(0)
        .sync()
        .expect("a refused commit is not a failure of the pass");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(w.dev(0).fs.exists("A/a.md") && w.dev(0).fs.exists("B/b.md"));
    let on_server = w.server_files();
    assert!(!on_server.contains_key("A/a.md") && !on_server.contains_key("B/b.md"));
    assert_eq!(listed(&w, 0), waiting(&["A/a.md", "B/b.md"]));
    w.set_plan("sub");
    w.pass(0);
    let on_server = w.server_files();
    assert_eq!(
        on_server.get("A/a.md"),
        Some(&text(3_000, 'a').into_bytes())
    );
    assert_eq!(
        on_server.get("B/b.md"),
        Some(&text(4_000, 'b').into_bytes())
    );
    assert!(listed(&w, 0).is_empty());
}

// ----- Н9: a subscription given later sends everything accumulated -----

fn n9_after_the_subscription_the_next_pass_sends_everything_accumulated(_b: EngineBuilder) {
    // Н9: new files, edits of files that waited, an edit of a file that was synchronised before,
    // and a second device: after several passes without a subscription one pass with it sends
    // the latest content of everything, with no loss.
    let w = world(2);
    w.save(0, "Notes/old.md", "old v1");
    w.pass(0);
    w.pass(1);
    w.set_plan("nosub");
    w.save(0, "Notes/new.md", "new v1");
    w.pass(0);
    w.save(0, "Notes/new.md", "new v2");
    w.save(0, "Notes/old.md", "old v2");
    w.save(0, "Notes/third.md", &text(8_000, 't'));
    w.pass(0);
    w.pass(0);
    assert_eq!(
        listed(&w, 0),
        waiting(&["Notes/new.md", "Notes/old.md", "Notes/third.md"])
    );
    assert_eq!(
        w.server_files().get("Notes/old.md"),
        Some(&b"old v1".to_vec()),
        "the server still has what it had"
    );
    w.set_plan("sub");
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(listed(&w, 0).is_empty());
    let on_server = w.server_files();
    assert_eq!(on_server.get("Notes/new.md"), Some(&b"new v2".to_vec()));
    assert_eq!(on_server.get("Notes/old.md"), Some(&b"old v2".to_vec()));
    assert_eq!(
        on_server.get("Notes/third.md"),
        Some(&text(8_000, 't').into_bytes())
    );
    // the other device gets all of it, and nothing was turned into a conflict on the way
    let other = w.pass(1);
    assert!(other.conflicts.is_empty(), "{:?}", other.conflicts);
    assert_eq!(w.read(1, "Notes/new.md").as_deref(), Some("new v2"));
    assert_eq!(w.read(1, "Notes/old.md").as_deref(), Some("old v2"));
    assert_eq!(w.read(1, "Notes/third.md"), Some(text(8_000, 't')));
}

fn n9_a_subscription_that_was_never_missing_changes_nothing(_b: EngineBuilder) {
    // Н9: `sync_allowed == true` is the old behaviour, step for step. (Passes on the old code:
    // it guards against a fix that sends nothing, or lists files, with a good plan.)
    let w = world(2);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "New/a.md", "alpha");
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(listed(&w, 0).is_empty());
    assert!(w.server_files().contains_key("New/a.md"));
    w.pass(1);
    assert_eq!(w.read(1, "New/a.md").as_deref(), Some("alpha"));
}

real_only!(
    n9_without_sync_nothing_is_sent_and_every_waiting_file_has_the_reason,
    n9_receiving_goes_on_without_a_subscription,
    n9_a_deletion_is_sent_without_a_subscription_while_a_new_file_waits,
    n9_a_403_on_the_first_body_is_not_a_failed_pass_and_stops_the_sending,
    n9_a_403_on_the_commit_keeps_the_file_and_the_next_pass_sends_it,
    n9_after_the_subscription_the_next_pass_sends_everything_accumulated,
    n9_a_subscription_that_was_never_missing_changes_nothing,
);
