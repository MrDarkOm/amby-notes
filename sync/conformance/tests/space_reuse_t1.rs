//! Appendix Т, Т1 and Т2 (finding Б3): a write that started before a space was deleted and
//! finished after it must be answered `404`, and it must never write into another user's space
//! that got the same internal database row.
//!
//! The race is made deterministic with a raw TCP request: the headers and half of the body are
//! sent first, then the other requests of the scenario run to the end, then the rest of the body
//! is sent. The server looks the space up when the handler starts and reads the body afterwards,
//! so the only wait is a short pause that lets the handler start (see `START_PAUSE`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use amby_sync_conformance::client::{enroll, hex16, new_body, new_item, Account, Space, PASSWORD};
use amby_sync_conformance::inprocess::InProcess;
use amby_sync_conformance::Target;
use serde_json::json;

/// Time for the server to accept the connection and start the handler, which checks the space
/// before it reads the body. Only the headers and half of the body are sent before it.
const START_PAUSE: Duration = Duration::from_millis(300);

/// A request whose body is sent in two pieces.
struct Inflight {
    stream: TcpStream,
    rest: Vec<u8>,
}

impl Inflight {
    fn start(
        base: &str,
        method: &str,
        path: &str,
        token: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> Inflight {
        let host = base.trim_start_matches("http://");
        let mut stream = TcpStream::connect(host).expect("cannot connect to the server");
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        stream.set_nodelay(true).unwrap();
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let split = (body.len() / 2).max(1);
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(&body[..split]).unwrap();
        stream.flush().unwrap();
        std::thread::sleep(START_PAUSE);
        Inflight {
            stream,
            rest: body[split..].to_vec(),
        }
    }

    /// Sends the rest of the body and returns the status and the text of the answer.
    fn finish(mut self) -> (u16, String) {
        self.stream.write_all(&self.rest).unwrap();
        self.stream.flush().unwrap();
        let mut raw = Vec::new();
        let _ = self.stream.read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or_else(|| panic!("no HTTP answer came back: {text:?}"));
        (status, text)
    }
}

fn space_row(control: &InProcess, space: &Space) -> i64 {
    let id = space.id.as_bytes().to_vec();
    control.sql(|conn| {
        conn.query_row("SELECT id FROM spaces WHERE space_id = ?1", [id], |row| {
            row.get(0)
        })
        .expect("the space has no row")
    })
}

fn files_of(root: &Path) -> Vec<String> {
    fn visit(path: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(&path, out);
            } else {
                out.push(path.display().to_string());
            }
        }
    }
    let mut out = Vec::new();
    visit(root, &mut out);
    out
}

fn delete_space(account: &Account, space: &Space) {
    // Ц1: the deletion carries the proof of the current password.
    account.delete_space_with_proof(&space.id).expect(200);
}

/// A user with a space that has the highest row, so that its row is handed out again.
struct Race {
    target: Target,
    a: Account,
    space_a: Space,
    b: Account,
}

fn race() -> Race {
    let target = Target::in_process();
    let a = enroll(&target, PASSWORD);
    let b = enroll(&target, PASSWORD);
    let space_a = a.create_space_named("space of A");
    Race {
        target,
        a,
        space_a,
        b,
    }
}

/// Deletes A's space and lets B create a new one that takes the same row. The reuse is checked,
/// so that a test cannot pass only because the numbers did not match.
fn reuse_the_row(race: &Race) -> Space {
    let control = race.target.control().unwrap();
    let row_before = space_row(control, &race.space_a);
    delete_space(&race.a, &race.space_a);
    let space_b = race.b.create_space_named("space of B");
    assert_eq!(
        space_row(control, &space_b),
        row_before,
        "the fixture is wrong: the new space must get the row of the deleted one"
    );
    space_b
}

fn commit_body_of_a(race: &Race) -> Vec<u8> {
    let item = new_item();
    let entry = race.space_a.folder(&item, 0, "from-a");
    race.space_a
        .commit_body(&[7u8; 16], &[entry])
        .to_string()
        .into_bytes()
}

fn assert_untouched(space_b: &Space) {
    let page = space_b.changes(0, None).expect(200).json();
    assert_eq!(
        page["changes"].as_array().unwrap().len(),
        0,
        "a record of another user's request got into the new space"
    );
    assert_eq!(page["seq"], 0, "the seq of the new space moved");
}

#[test]
fn a_commit_that_finishes_after_the_space_is_deleted_and_its_row_reused_is_404_and_writes_nothing()
{
    // Т1: the owner is found again by (space_id, user_id) in the writing transaction; the row
    // found before the body was read is not used, so B's space gets nothing.
    let race = race();
    let body = commit_body_of_a(&race);
    let path = race.space_a.path("/commit");
    let inflight = Inflight::start(
        race.a.api.base(),
        "POST",
        &path,
        &race.a.token,
        "application/json",
        body,
    );
    let space_b = reuse_the_row(&race);
    let (status, text) = inflight.finish();
    assert_eq!(status, 404, "expected 404 not_found, got: {text}");
    assert!(text.contains("not_found"), "wrong error code: {text}");
    assert_untouched(&space_b);
}

#[test]
fn a_blob_start_that_finishes_after_the_space_is_deleted_and_its_row_reused_is_404_and_charges_nobody(
) {
    // Т1: the same for POST …/blobs: no body row in B's space, B's quota and A's are untouched.
    let race = race();
    let blob = new_body();
    let body = json!({ "blob_id": hex16(blob.as_bytes()), "size": 1000 })
        .to_string()
        .into_bytes();
    let path = race.space_a.path("/blobs");
    let inflight = Inflight::start(
        race.a.api.base(),
        "POST",
        &path,
        &race.a.token,
        "application/json",
        body,
    );
    let space_b = reuse_the_row(&race);
    let (status, text) = inflight.finish();
    assert_eq!(status, 404, "expected 404 not_found, got: {text}");
    assert!(text.contains("not_found"), "wrong error code: {text}");
    assert_eq!(race.b.overview()["usage"]["pending_bytes"], 0);
    assert_eq!(race.a.overview()["usage"]["pending_bytes"], 0);
    // B's space does not know the body either.
    space_b.complete_blob(&blob).expect_error(404, "not_found");
    assert_untouched(&space_b);
}

#[test]
fn a_part_that_finishes_after_the_space_is_deleted_and_its_row_reused_is_404() {
    // Т1 for PUT …/parts/{n}: the body was started before the deletion, the part ends after it.
    // B starts a body with the same id (ids are chosen by clients), so a write by the stale row
    // would land in B's body.
    let race = race();
    let blob = new_body();
    race.space_a.init_blob(&blob, 200).expect(201);
    let path = race
        .space_a
        .path(&format!("/blobs/{}/parts/0", hex16(blob.as_bytes())));
    let inflight = Inflight::start(
        race.a.api.base(),
        "PUT",
        &path,
        &race.a.token,
        "application/octet-stream",
        vec![0x42; 200],
    );
    let space_b = reuse_the_row(&race);
    space_b.init_blob(&blob, 200).expect(201);
    let (status, text) = inflight.finish();
    assert_eq!(status, 404, "expected 404 not_found, got: {text}");
    // B's body has no part from A.
    let again = space_b.init_blob(&blob, 200).expect(200).json();
    assert_eq!(again["uploaded"], json!([]), "A's part got into B's body");
    assert_eq!(race.b.overview()["usage"]["pending_bytes"], 200);
}

#[test]
fn a_part_written_for_a_deleted_space_is_not_kept_after_the_usual_cleanup() {
    // Т2: the file of the part is removed by the cleanup of leftovers, as after a failure.
    let race = race();
    let control = race.target.control().expect("in-process target");
    let blob = new_body();
    race.space_a.init_blob(&blob, 200).expect(201);
    let path = race
        .space_a
        .path(&format!("/blobs/{}/parts/0", hex16(blob.as_bytes())));
    let inflight = Inflight::start(
        race.a.api.base(),
        "PUT",
        &path,
        &race.a.token,
        "application/octet-stream",
        vec![0x42; 200],
    );
    delete_space(&race.a, &race.space_a);
    let (status, _) = inflight.finish();
    assert_eq!(status, 404);
    control.run_maintenance();
    let id = hex16(blob.as_bytes());
    let left: Vec<String> = files_of(control.data_dir())
        .into_iter()
        .filter(|path| path.contains(&id))
        .collect();
    assert!(
        left.is_empty(),
        "the part of a deleted space stays on disk: {left:?}"
    );
}

#[test]
fn writes_that_finish_after_the_deletion_without_reuse_are_404_not_500() {
    // Т1 (Л4): the space is not the last row, so nobody takes its number; the old answer was 500
    // (a broken foreign key), the rule is 404.
    let race = race();
    // A later space keeps the row of the first one from being handed out again.
    let _keeper = race.a.create_space_named("later space of A");

    let commit = Inflight::start(
        race.a.api.base(),
        "POST",
        &race.space_a.path("/commit"),
        &race.a.token,
        "application/json",
        commit_body_of_a(&race),
    );
    let blob = new_body();
    let init = Inflight::start(
        race.a.api.base(),
        "POST",
        &race.space_a.path("/blobs"),
        &race.a.token,
        "application/json",
        json!({ "blob_id": hex16(blob.as_bytes()), "size": 1000 })
            .to_string()
            .into_bytes(),
    );
    let started = new_body();
    race.space_a.init_blob(&started, 200).expect(201);
    let part = Inflight::start(
        race.a.api.base(),
        "PUT",
        &race
            .space_a
            .path(&format!("/blobs/{}/parts/0", hex16(started.as_bytes()))),
        &race.a.token,
        "application/octet-stream",
        vec![0x42; 200],
    );
    delete_space(&race.a, &race.space_a);
    for (name, inflight) in [("commit", commit), ("blob start", init), ("part", part)] {
        let (status, text) = inflight.finish();
        assert_eq!(status, 404, "{name}: expected 404 not_found, got: {text}");
        assert!(text.contains("not_found"), "{name}: wrong code: {text}");
    }
    assert_eq!(race.a.overview()["usage"]["pending_bytes"], 0);
}

#[test]
fn a_token_revoked_while_the_body_is_in_flight_gets_401_and_nothing_is_written() {
    // Т1: the token is checked again in the writing transaction; a revoked one keeps the old 401.
    let target = Target::from_env();
    let owner = enroll(&target, PASSWORD);
    let space = owner.create_space_named("shared by two devices");
    let second = owner.another_device("second device");
    let on_second = space.with_token(&second.token);

    let item = new_item();
    let entry = space.folder(&item, 0, "from-revoked-device");
    let commit_body = space
        .commit_body(&[9u8; 16], &[entry])
        .to_string()
        .into_bytes();
    let commit = Inflight::start(
        owner.api.base(),
        "POST",
        &on_second.path("/commit"),
        &second.token,
        "application/json",
        commit_body,
    );
    let blob = new_body();
    let init = Inflight::start(
        owner.api.base(),
        "POST",
        &on_second.path("/blobs"),
        &second.token,
        "application/json",
        json!({ "blob_id": hex16(blob.as_bytes()), "size": 1000 })
            .to_string()
            .into_bytes(),
    );
    owner
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    for (name, inflight) in [("commit", commit), ("blob start", init)] {
        let (status, text) = inflight.finish();
        assert_eq!(status, 401, "{name}: expected 401, got: {text}");
    }
    let page = space.changes(0, None).expect(200).json();
    assert_eq!(page["changes"].as_array().unwrap().len(), 0);
    assert_eq!(page["seq"], 0);
    assert_eq!(owner.overview()["usage"]["pending_bytes"], 0);
}
