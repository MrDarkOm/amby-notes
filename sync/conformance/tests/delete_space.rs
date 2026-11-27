//! Deleting a server space (appendix Л, Л1–Л5).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::sync::Barrier;
use std::time::{Duration, Instant};

use amby_sync_conformance::client::{enroll, hex16, new_body, new_item, PASSWORD};
use amby_sync_conformance::{Sse, Target};
use serde_json::json;

fn delete_path(space_id: &[u8; 16]) -> String {
    format!("/v1/spaces/{}", hex16(space_id))
}

fn has_space(list: &serde_json::Value, space_id: &[u8; 16]) -> bool {
    list["spaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|space| space["space_id"] == hex16(space_id))
}

fn file_paths(root: &Path) -> Vec<String> {
    fn visit(root: &Path, path: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, out);
            } else {
                out.push(path.strip_prefix(root).unwrap().display().to_string());
            }
        }
    }

    let mut out = Vec::new();
    visit(root, root, &mut out);
    out
}

fn has_body_file(paths: &[String], body: &amby_sync_core::crypto::keys::BodyId) -> bool {
    let id = hex16(body.as_bytes());
    paths.iter().any(|path| path.contains(&id))
}

#[test]
fn an_owner_deletes_a_space_with_an_empty_200_ok_answer() {
    // Л1: only the owner's device token and opaque space id are sent; success is exactly 200 ok.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space_named("Only the client can decrypt this name");

    let answer = account.delete_space_with_proof(&space.id).expect(200);
    assert_eq!(answer.json(), json!({"ok": true}));
}

#[test]
fn access_failures_are_indistinguishable_and_do_not_change_any_space() {
    // Л2: authentication is checked before the id; foreign, unknown, malformed and already
    // deleted ids all have the same 404 once a token is valid.
    let target = Target::from_env();
    let owner = enroll(&target, PASSWORD);
    let probe = owner.create_space();
    // Ensure this test meets the DELETE endpoint before an assertion that could pass on a missing
    // route: the current tests-first server stub must fail this 200 expectation.
    owner.delete_space_with_proof(&probe.id).expect(200);

    let owned = owner.create_space_named("owned");
    let other = enroll(&target, PASSWORD);
    let foreign = other.create_space_named("foreign");
    let revoked = owner.another_device("revoked");
    let unknown = [0xcdu8; 16];
    let malformed = "/v1/spaces/not-a-16-byte-id";

    target
        .api
        .delete(&delete_path(owned.id.as_bytes()), None)
        .expect_error(401, "unauthorized");
    target
        .api
        .delete(&delete_path(owned.id.as_bytes()), Some(&"00".repeat(32)))
        .expect_error(401, "unauthorized");
    owner
        .delete(&delete_path(foreign.id.as_bytes()))
        .expect_error(404, "not_found");
    owner
        .delete(&delete_path(&unknown))
        .expect_error(404, "not_found");
    owner
        .delete(&format!(
            "/v1/spaces/{}",
            hex16(owned.id.as_bytes()).to_uppercase()
        ))
        .expect_error(404, "not_found");
    owner
        .delete(&delete_path(probe.id.as_bytes()))
        .expect_error(404, "not_found");
    owner.delete(malformed).expect_error(404, "not_found");
    target
        .api
        .delete(malformed, None)
        .expect_error(401, "unauthorized");
    owner
        .delete(&format!("/v1/devices/{}", revoked.device_id))
        .expect(204);
    target
        .api
        .delete(&delete_path(owned.id.as_bytes()), Some(&revoked.token))
        .expect_error(401, "token_revoked");

    assert!(has_space(
        &owner.get("/v1/spaces").expect(200).json(),
        owned.id.as_bytes()
    ));
    assert!(has_space(
        &other.get("/v1/spaces").expect(200).json(),
        foreign.id.as_bytes()
    ));
}

#[test]
fn deletion_removes_all_versions_bodies_parts_and_quota_only_for_that_space() {
    // Л3: current and historical versions, replay records, finished and unfinished bodies (and
    // their parts) disappear together; other spaces/accounts and the account remain.
    let target = Target::in_process_with_plans(
        r#"{"default_plan":"delete","plans":{"delete":{"max_spaces":2,"max_total_bytes":2000,"max_file_bytes":4000,"history_days":30,"max_history_bytes":4000}}}"#,
        |_| {},
    );
    let owner = enroll(&target, PASSWORD);
    let doomed = owner.create_space_named("to delete");
    let survivor = owner.create_space_named("survivor");
    let another_account = enroll(&target, PASSWORD);
    let foreign = another_account.create_space_named("foreign");

    let item = new_item();
    let first = doomed.raw_file(&item, 0, "notes.md", 800);
    doomed.commit_ok(std::slice::from_ref(&first));
    let second = doomed.raw_file(&item, 1, "notes.md", 700);
    let commit_id = [0x55u8; 16];
    doomed
        .commit_with(&commit_id, std::slice::from_ref(&second))
        .expect(200);

    let orphan = new_body();
    doomed.upload_sealed(&orphan, &[0x7a; 100]);
    let pending = new_body();
    doomed.init_blob(&pending, 200).expect(201);
    doomed.put_part(&pending, 0, vec![0x42; 200]).expect(200);

    let survivor_item = new_item();
    let survivor_file = survivor.raw_file(&survivor_item, 0, "keep.md", 500);
    let survivor_body = survivor_file.body.unwrap();
    survivor.commit_ok(&[survivor_file]);
    let foreign_item = new_item();
    let foreign_file = foreign.raw_file(&foreign_item, 0, "foreign.md", 300);
    let foreign_body = foreign_file.body.unwrap();
    foreign.commit_ok(&[foreign_file]);

    let control = target.control().unwrap();
    let before_files = file_paths(control.data_dir());
    for body in [first.body.unwrap(), second.body.unwrap(), orphan, pending] {
        assert!(
            has_body_file(&before_files, &body),
            "the test fixture did not create a physical file for {}",
            hex16(body.as_bytes())
        );
    }
    assert!(has_body_file(&before_files, &survivor_body));
    assert!(has_body_file(&before_files, &foreign_body));

    let before = owner.overview();
    assert_eq!(before["usage"]["spaces"], 2);
    assert_eq!(before["usage"]["live_bytes"], 1_200);

    // This is the first DELETE in the test and must be 200, not the 501 stub.
    owner.delete_space_with_proof(&doomed.id).expect(200);

    let listing = owner.get("/v1/spaces").expect(200).json();
    assert!(!has_space(&listing, doomed.id.as_bytes()));
    assert!(has_space(&listing, survivor.id.as_bytes()));
    let after = owner.overview();
    assert_eq!(after["usage"]["spaces"], 1);
    assert_eq!(after["usage"]["live_bytes"], 500);
    assert_eq!(after["usage"]["pending_bytes"], 0);
    assert_eq!(after["usage"]["history_bytes"], 0);
    assert!(!has_space(&after, doomed.id.as_bytes()));
    assert!(has_space(&after, survivor.id.as_bytes()));

    let after_files = file_paths(control.data_dir());
    for body in [first.body.unwrap(), second.body.unwrap(), orphan, pending] {
        assert!(
            !has_body_file(&after_files, &body),
            "physical body/part {} survived deletion",
            hex16(body.as_bytes())
        );
    }
    assert!(has_body_file(&after_files, &survivor_body));
    assert!(has_body_file(&after_files, &foreign_body));

    doomed.changes(0, None).expect_error(404, "not_found");
    doomed.versions(&item).expect_error(404, "not_found");
    doomed
        .download(&first.body.unwrap())
        .expect_error(404, "not_found");
    doomed
        .download(&second.body.unwrap())
        .expect_error(404, "not_found");
    doomed.download(&orphan).expect_error(404, "not_found");
    doomed
        .init_blob(&pending, 200)
        .expect_error(404, "not_found");
    doomed
        .put_part(&pending, 0, vec![0x42; 200])
        .expect_error(404, "not_found");
    doomed
        .complete_blob(&pending)
        .expect_error(404, "not_found");
    doomed
        .commit_with(&commit_id, std::slice::from_ref(&second))
        .expect_error(404, "not_found");

    assert_eq!(survivor.all_changes(0).len(), 1);
    assert_eq!(foreign.all_changes(0).len(), 1);
    assert_eq!(another_account.overview()["usage"]["spaces"], 1);

    // Both the freed space slot and its live-byte credit are immediately reusable.
    let replacement = owner.create_space_named("replacement");
    let replacement_item = new_item();
    replacement.commit_ok(&[replacement.raw_file(&replacement_item, 0, "new.md", 1_000)]);
    assert_eq!(owner.overview()["usage"]["spaces"], 2);
    assert_eq!(owner.overview()["usage"]["live_bytes"], 1_500);
}

#[test]
fn deletion_is_serialized_with_a_commit_and_an_upload() {
    // Л4: whichever request wins, a successful deletion leaves no record or body of this space.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let probe = account.create_space();
    // Hit the tests-first DELETE stub before starting the race itself.
    account.delete_space_with_proof(&probe.id).expect(200);
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "before.md", b"before")]);
    let next = space.file(&item, 1, "after.md", b"after");
    let next_body = next.body.unwrap();
    let pending = new_body();
    let barrier = Barrier::new(3);
    let path = delete_path(space.id.as_bytes());

    let (delete_answer, commit_answer, upload_answer) = std::thread::scope(|scope| {
        let delete_barrier = &barrier;
        let delete_api = account.api.clone();
        let delete_token = account.token.clone();
        let delete_path = path.clone();
        // Ц1: the proof of the current password rides in the body of every deletion.
        let proof = json!({"auth_key": hex::encode(account.password_auth_key().as_bytes())});
        let deleted = scope.spawn(move || {
            delete_barrier.wait();
            delete_api.send(
                "DELETE",
                &delete_path,
                Some(&delete_token),
                &[],
                amby_sync_conformance::http::Body::Json(proof),
            )
        });

        let commit_barrier = &barrier;
        let commit_space = space.clone();
        let committed = scope.spawn(move || {
            commit_barrier.wait();
            commit_space.commit(std::slice::from_ref(&next))
        });

        let upload_barrier = &barrier;
        let upload_space = space.clone();
        let uploaded = scope.spawn(move || {
            upload_barrier.wait();
            upload_space.init_blob(&pending, 200)
        });

        (
            deleted.join().unwrap(),
            committed.join().unwrap(),
            uploaded.join().unwrap(),
        )
    });

    delete_answer.expect(200);
    assert!(
        commit_answer.status == 200 || commit_answer.status == 404,
        "commit raced with deletion: HTTP {} {}",
        commit_answer.status,
        commit_answer.text()
    );
    assert!(
        upload_answer.status == 201 || upload_answer.status == 200 || upload_answer.status == 404,
        "upload raced with deletion: HTTP {} {}",
        upload_answer.status,
        upload_answer.text()
    );
    space.changes(0, None).expect_error(404, "not_found");
    space.download(&next_body).expect_error(404, "not_found");
    space.download(&pending).expect_error(404, "not_found");
}

#[test]
fn deleting_one_space_closes_only_its_sse_and_survives_restart() {
    // Л4: the deleted stream closes, another space's stream continues, and the row stays gone
    // after a restart.
    let target = Target::in_process();
    let control = amby_sync_conformance::in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let probe = account.create_space();
    // Hit the tests-first DELETE stub before opening streams or doing restart work.
    account.delete_space_with_proof(&probe.id).expect(200);
    let doomed = account.create_space();
    let survivor = account.create_space();

    let keepalive = amby_sync_conformance::client::limit(&target.api, "sse_keepalive_secs");
    let mut deleted_stream = open_stream(&doomed, keepalive + 10);
    let mut survivor_stream = open_stream(&survivor, keepalive + 10);
    assert_eq!(deleted_stream.next_real_event().unwrap().name, "hello");
    assert_eq!(survivor_stream.next_real_event().unwrap().name, "hello");

    // The first DELETE must hit the real contract, not pass on the 501 stub.
    account.delete_space_with_proof(&doomed.id).expect(200);

    let started = Instant::now();
    loop {
        match deleted_stream.next_event() {
            None => break,
            Some(event) if event.name == ":comment" => {}
            Some(event) => panic!("deleted space emitted an event after removal: {event:?}"),
        }
        assert!(
            started.elapsed() < Duration::from_secs(keepalive + 5),
            "the deleted-space SSE stream is still open"
        );
    }
    assert!(started.elapsed() < Duration::from_secs(keepalive + 5));

    survivor.commit_ok(&[survivor.folder(&new_item(), 0, "still-alive")]);
    let event = survivor_stream
        .next_real_event()
        .expect("the other space's stream was closed")
        .json();
    assert_eq!(event["seq"], 1);
    drop(survivor_stream);

    control.restart();
    assert!(!has_space(
        &account.get("/v1/spaces").expect(200).json(),
        doomed.id.as_bytes()
    ));
    survivor.changes(0, None).expect(200);
    doomed.changes(0, None).expect_error(404, "not_found");
}

#[test]
fn repeating_delete_is_not_a_success_and_has_no_side_effects() {
    // Л5: the retry of a lost 200 is a harmless 404; no other space or account is touched.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let doomed = account.create_space();
    let survivor = account.create_space();
    let other = enroll(&target, PASSWORD);
    let foreign = other.create_space();

    // The first DELETE is intentionally before the repeat assertion, so the stub is red.
    account.delete_space_with_proof(&doomed.id).expect(200);
    account
        .delete_space_with_proof(&doomed.id)
        .expect_error(404, "not_found");

    assert!(has_space(
        &account.get("/v1/spaces").expect(200).json(),
        survivor.id.as_bytes()
    ));
    assert!(has_space(
        &other.get("/v1/spaces").expect(200).json(),
        foreign.id.as_bytes()
    ));
}

fn open_stream(space: &amby_sync_conformance::client::Space, wait_secs: u64) -> Sse {
    space
        .api
        .open_events(
            &space.path("/events"),
            Some(&space.token),
            Duration::from_secs(wait_secs),
        )
        .unwrap_or_else(|answer| {
            panic!(
                "the stream did not open: HTTP {} {}",
                answer.status,
                answer.text()
            )
        })
}
