//! `instance_id`, restarts and a reset server (С7, Р8, Р10; П10). In-process servers only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{enroll, info, new_item, PASSWORD};
use amby_sync_conformance::{in_process_or_skip, Target};

#[test]
fn a_restart_keeps_the_instance_id_the_data_and_the_tokens() {
    // П10, Р3, Р5: same server, same data: the id stays, tokens work, the feed and bodies are there.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"survives a restart")]);
    let before = info(&target.api)["instance_id"].clone();
    control.restart();
    assert_eq!(info(&target.api)["instance_id"], before);
    let list = account.get("/v1/spaces").expect(200).json();
    assert_eq!(list["spaces"][0]["seq"], 1);
    let change = space.all_changes(0).remove(0);
    assert_eq!(space.fetch_file(&change), b"survives a restart");
    assert_eq!(
        space.commit_ok(&[space.file(&item, 1, "a.md", b"and goes on")]),
        2
    );
}

#[test]
fn a_restart_keeps_what_the_server_remembers_of_commits() {
    // С2, П28: a retry that crosses a restart still gets the first answer.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = enroll(&target, PASSWORD).create_space();
    let batch = [space.folder(&new_item(), 0, "F")];
    let commit_id = amby_sync_conformance::client::random16();
    let first = space.commit_with(&commit_id, &batch).expect(200).json();
    control.restart();
    let again = space.commit_with(&commit_id, &batch).expect(200).json();
    assert_eq!(again["replayed"], true);
    assert_eq!(again["seq"], first["seq"]);
}

#[test]
fn two_servers_have_two_instance_ids() {
    // П10, С7: a fresh data directory is a different server.
    let first = Target::in_process();
    let second = Target::in_process();
    assert_ne!(
        info(&first.api)["instance_id"],
        info(&second.api)["instance_id"]
    );
}

#[test]
fn a_reset_server_announces_itself_with_a_new_instance_id() {
    // С7, Р8, П10: the volume was lost. The id differs, the old token is unknown, the old space
    // is gone — an empty server is not an order to delete anything (that is the client's rule).
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    space.commit_ok(&[space.folder(&new_item(), 0, "F")]);
    let before = info(&target.api)["instance_id"].clone();
    control.restart_fresh();
    let after = info(&target.api)["instance_id"].clone();
    assert_ne!(before, after, "a reset server must be recognisable");
    account.get("/v1/spaces").expect_error(401, "unauthorized");
    // A new user on the reset server starts at seq 0: lower than any seq the old server gave.
    let again = enroll(&target, PASSWORD);
    let new_space = again.create_space();
    assert_eq!(new_space.changes(0, None).expect(200).json()["seq"], 0);
    assert_eq!(
        new_space.changes(5, None).expect(200).json()["seq"],
        0,
        "a device that knew seq 5 sees the head 0"
    );
}

#[test]
fn the_instance_id_is_not_a_secret_but_not_a_counter_either() {
    // П10: 16 random bytes; two resets do not give two similar ids.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let first = info(&target.api)["instance_id"]
        .as_str()
        .unwrap()
        .to_string();
    control.restart_fresh();
    let second = info(&target.api)["instance_id"]
        .as_str()
        .unwrap()
        .to_string();
    control.restart_fresh();
    let third = info(&target.api)["instance_id"]
        .as_str()
        .unwrap()
        .to_string();
    let distance = |a: &str, b: &str| a.chars().zip(b.chars()).filter(|(x, y)| x != y).count();
    assert!(
        distance(&first, &second) > 8 && distance(&second, &third) > 8,
        "{first} {second} {third}"
    );
}
