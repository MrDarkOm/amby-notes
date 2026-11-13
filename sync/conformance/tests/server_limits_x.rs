//! Appendix Х: limits of the server (findings Б1, Б4, Б5 of the security review). Red tests,
//! written before the code. In-process servers: the settings change, the server restarts on the
//! same data, and a few tests read the data directory.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use amby_sync_conformance::client::{
    enroll, enroll_body, enroll_with, login, new_body, new_item, Account, Prepared, Space, PASSWORD,
};
use amby_sync_conformance::http::Body;
use amby_sync_conformance::{in_process_or_skip, Resp, Target};
use amby_sync_core::crypto::account::{create_account, Argon2Params};
use amby_sync_core::crypto::random::OsRandom;
use serde_json::{json, Value};

// ----------------------------------------------------------------------------- helpers

fn open_register(target: &Target, username: &str) -> Resp {
    let new = create_account(PASSWORD, &Argon2Params::V1_DEFAULT, &mut OsRandom).unwrap();
    target.api.post(
        "/v1/auth/enroll",
        None,
        enroll_body(username, "", &new, "open device"),
    )
}

/// The answer is the plain error of П4 and tells nothing about the disk (Х1).
fn assert_storage_full(response: Resp) {
    let refused = response.expect_error(507, "server_storage_full");
    let error = &refused.json()["error"];
    assert!(error["message"].is_string(), "П4 shape: {error}");
    let details = &error["details"];
    assert!(
        details.is_null() || details == &json!({}),
        "Х1: no details about the disk: {details}"
    );
}

fn header_len(prepared: &Prepared) -> u64 {
    prepared.json["header"].as_str().unwrap().len() as u64 / 2
}

// ----------------------------------------------------------------------------- Х1

/// Everything the six adding requests need, made before the threshold is raised.
struct Staged {
    account: Account,
    space: Space,
    /// A committed file with a body that can be downloaded and deleted.
    kept: Prepared,
    /// A body that is only started (for `parts` and `DELETE`).
    started: amby_sync_core::crypto::keys::BodyId,
    /// A body with one part uploaded and not completed (for `complete`).
    uploaded: amby_sync_core::crypto::keys::BodyId,
    /// A new file whose body is complete, not yet committed (for the commit).
    prepared: Prepared,
    /// A second space to delete.
    spare: Space,
}

fn staged(target: &Target) -> Staged {
    let account = enroll(target, PASSWORD);
    let space = account.create_space();
    let kept = space.raw_file(&new_item(), 0, "kept.md", 1_000);
    space.commit_ok(std::slice::from_ref(&kept));
    let started = new_body();
    space.init_blob(&started, 100).expect(201);
    let uploaded = new_body();
    space.init_blob(&uploaded, 100).expect(201);
    space.put_part(&uploaded, 0, vec![1u8; 100]).expect(200);
    let prepared = space.raw_file(&new_item(), 0, "new.md", 500);
    let spare = account.create_space_named("spare");
    Staged {
        account,
        space,
        kept,
        started,
        uploaded,
        prepared,
        spare,
    }
}

fn open_server(adjust: impl FnOnce(&mut amby_sync_server::Config)) -> Target {
    Target::in_process_with(|config| {
        config.open_registration = true;
        config.min_free_bytes = 0;
        adjust(config);
    })
}

fn low_space(target: &Target) {
    in_process_or_skip!(target).restart_with(|config| config.min_free_bytes = u64::MAX);
}

#[test]
fn with_too_little_free_space_the_six_adding_requests_answer_507_server_storage_full() {
    // Х1: open registration, POST /v1/spaces, POST …/blobs, PUT …/parts/{n}, POST …/complete and
    // a commit with a non-deletion — each is `507 server_storage_full`, without details of the disk.
    let target = open_server(|_| {});
    let _ = in_process_or_skip!(target);
    let s = staged(&target);
    low_space(&target);

    let name = target.new_username();
    assert_storage_full(open_register(&target, &name));
    let (_, _, new_space) = s.account.new_space_request("Another");
    assert_storage_full(s.account.post("/v1/spaces", new_space));
    assert_storage_full(s.space.init_blob(&new_body(), 10));
    assert_storage_full(s.space.put_part(&s.started, 0, vec![2u8; 100]));
    assert_storage_full(s.space.complete_blob(&s.uploaded));
    assert_storage_full(s.space.commit(std::slice::from_ref(&s.prepared)));
    // a folder is a non-deletion too, though it carries no body
    let folder = s.space.folder(&new_item(), 0, "folder");
    assert_storage_full(s.space.commit(&[folder]));
}

#[test]
fn a_refused_adding_request_changes_nothing() {
    // Х1: the check comes before the write, in the same transaction as the other checks.
    let target = open_server(|_| {});
    let _ = in_process_or_skip!(target);
    let s = staged(&target);
    let feed_before = s.space.all_changes(0);
    let usage_before = s.account.overview()["usage"].clone();
    low_space(&target);
    assert_storage_full(s.space.commit(std::slice::from_ref(&s.prepared)));
    assert_storage_full(s.space.init_blob(&new_body(), 10));
    assert_eq!(s.space.all_changes(0), feed_before);
    assert_eq!(s.account.overview()["usage"], usage_before);
    // the name taken by a refused registration is not reserved
    let name = target.new_username();
    assert_storage_full(open_register(&target, &name));
    in_process_or_skip!(target).restart_with(|config| config.min_free_bytes = 0);
    open_register(&target, &name).expect(201);
}

#[test]
fn with_too_little_free_space_login_reading_download_and_freeing_still_work() {
    // Х1: sign-in, the feed, download, a commit of deletions only, DELETE of a body and of a
    // space work, so that the space on the disk can be freed.
    let target = open_server(|_| {});
    let _ = in_process_or_skip!(target);
    let s = staged(&target);
    low_space(&target);

    // sign-in (prelogin and login) and a second device
    let second = s.account.another_device("second device");
    assert_eq!(second.username, s.account.username);
    login(
        &target.api,
        &s.account.username,
        PASSWORD,
        &s.account.ak,
        "third",
    )
    .expect(200);
    // reading and downloading
    let feed = s.space.all_changes(0);
    assert_eq!(feed.len(), 1);
    s.space.download(s.kept.body.as_ref().unwrap()).expect(200);
    s.account.get("/v1/account").expect(200);
    s.account.get("/v1/spaces").expect(200);
    // freeing: a started body, an item, a space
    s.space.delete_blob(&s.started).expect(204);
    let gone = s.space.deletion(&s.kept.item, 1, "kept.md");
    s.space.commit_ok(&[gone]);
    s.account
        .delete(&format!(
            "/v1/spaces/{}",
            amby_sync_conformance::client::hex16(s.spare.id.as_bytes())
        ))
        .expect(200);
}

#[test]
fn a_zero_threshold_turns_the_check_off() {
    // Х1: `0` switches the check off: what was refused goes through after the restart.
    let target = open_server(|_| {});
    let control = in_process_or_skip!(target);
    let s = staged(&target);
    low_space(&target);
    assert_storage_full(s.space.commit(std::slice::from_ref(&s.prepared)));
    control.restart_with(|config| config.min_free_bytes = 0);

    let name = target.new_username();
    open_register(&target, &name).expect(201);
    let (_, _, new_space) = s.account.new_space_request("Another");
    s.account.post("/v1/spaces", new_space).expect(201);
    s.space.init_blob(&new_body(), 10).expect(201);
    s.space.put_part(&s.started, 0, vec![2u8; 100]).expect(200);
    s.space.complete_blob(&s.started).expect(200);
    s.space.complete_blob(&s.uploaded).expect(200);
    s.space.commit_ok(std::slice::from_ref(&s.prepared));
}

#[test]
fn the_default_settings_pass_the_ordinary_flows() {
    // Х1, guard: the default threshold (1 GiB) does not stop a normal server whose volume has
    // room. Unchanged behaviour: it passes before the code too.
    let target = Target::in_process_with(|config| {
        config.open_registration = true;
        assert_eq!(config.min_free_bytes, 1_073_741_824);
    });
    let name = target.new_username();
    open_register(&target, &name).expect(201);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let file = space.raw_file(&new_item(), 0, "a.md", 1_000);
    space.commit_ok(&[file]);
}

// ----------------------------------------------------------------------------- Х2

fn limited(max: Option<u64>) -> Target {
    Target::in_process_with(|config| {
        config.open_registration = true;
        config.max_users = max;
    })
}

#[test]
fn open_registration_is_refused_when_the_users_reach_the_limit() {
    // Х2, Рег2: two users with a limit of two -> 409 registration_unavailable, nothing created.
    let target = limited(Some(2));
    let control = in_process_or_skip!(target);
    let _first = enroll(&target, PASSWORD);
    let _second = enroll(&target, PASSWORD);
    let name = target.new_username();
    open_register(&target, &name).expect_error(409, "registration_unavailable");
    open_register(&target, &name).expect_error(409, "registration_unavailable");
    // nothing was created and the name is not reserved: with the limit lifted it is free
    control.restart_with(|config| config.max_users = None);
    open_register(&target, &name).expect(201);
}

#[test]
fn the_last_place_of_the_limit_is_given_and_the_next_one_is_refused() {
    // Х2: "already that many or more" refuses; one less than the limit still registers.
    let target = limited(Some(2));
    let _ = in_process_or_skip!(target);
    let _first = enroll(&target, PASSWORD);
    let name = target.new_username();
    open_register(&target, &name).expect(201);
    open_register(&target, &target.new_username()).expect_error(409, "registration_unavailable");
}

#[test]
fn an_invitation_code_still_registers_when_the_limit_is_reached() {
    // Х2: administrator invitations and registration by code are not limited.
    let target = limited(Some(2));
    let _ = in_process_or_skip!(target);
    let _first = enroll(&target, PASSWORD);
    let _second = enroll(&target, PASSWORD);
    open_register(&target, &target.new_username()).expect_error(409, "registration_unavailable");
    let ticket = target.new_ticket();
    let account = enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
    account.get("/v1/keys").expect(200);
}

#[test]
fn without_a_limit_open_registration_works_as_before() {
    // Х2, guard: no AMBY_SYNC_MAX_USERS -> no limit. Passes before the code too.
    let target = limited(None);
    for _ in 0..4 {
        open_register(&target, &target.new_username()).expect(201);
    }
}

// ----------------------------------------------------------------------------- Х3

const AUTH_LIMIT: usize = 64 * 1024;

fn raw_json(target: &Target, path: &str, bytes: Vec<u8>) -> Resp {
    target.api.send(
        "POST",
        path,
        None,
        &[],
        Body::Raw(bytes, Some("application/json")),
    )
}

/// A JSON object padded with an unknown field (П7) up to `total` bytes.
fn padded(fields: Value, total: usize) -> Vec<u8> {
    let mut object = fields.as_object().unwrap().clone();
    object.insert("pad".into(), json!(""));
    let base = serde_json::to_vec(&object).unwrap().len();
    assert!(total >= base);
    object.insert("pad".into(), json!("a".repeat(total - base)));
    let bytes = serde_json::to_vec(&object).unwrap();
    assert_eq!(bytes.len(), total);
    bytes
}

#[test]
fn auth_bodies_over_64_kib_are_413_payload_too_large() {
    // Х3: prelogin, enroll, login and recover, whatever `max_json_bytes` (2 MiB here) says.
    let target = Target::in_process();
    let size = AUTH_LIMIT + 1;
    for (path, fields) in [
        ("/v1/auth/prelogin", json!({ "username": "someone" })),
        (
            "/v1/auth/enroll",
            json!({ "username": "someone", "enroll_code": "AAAA-AAAA-AAAA-AAAA-AAAA" }),
        ),
        (
            "/v1/auth/login",
            json!({ "username": "someone", "auth_key": "00".repeat(32) }),
        ),
        (
            "/v1/auth/recover",
            json!({ "username": "someone", "recovery_auth_key": "00".repeat(32) }),
        ),
    ] {
        let answer = raw_json(&target, path, padded(fields, size));
        assert!(
            answer.status == 413 && answer.error_code().as_deref() == Some("payload_too_large"),
            "{path}: expected 413 payload_too_large, got HTTP {} {}",
            answer.status,
            answer.text()
        );
    }
}

#[test]
fn an_auth_body_of_exactly_64_kib_is_still_read() {
    // Х3: "no more than 64 KiB" — the limit itself is allowed (unknown fields are ignored, П7).
    // The prelogin answers 200 for any name (П15). Passes before the code too.
    let target = Target::in_process();
    raw_json(
        &target,
        "/v1/auth/prelogin",
        padded(json!({ "username": "someone" }), AUTH_LIMIT),
    )
    .expect(200);
    raw_json(
        &target,
        "/v1/auth/prelogin",
        padded(json!({ "username": "someone" }), AUTH_LIMIT + 1),
    )
    .expect_error(413, "payload_too_large");
}

#[test]
fn an_oversize_login_is_not_counted_as_a_failure() {
    // Х3, П16: more oversize attempts than the lock allows; the correct login still works.
    let target = Target::in_process();
    let account = enroll(&target, PASSWORD);
    let max = amby_sync_conformance::client::limit(&target.api, "login_max_failures");
    for _ in 0..max + 3 {
        let body = padded(
            json!({ "username": account.username, "auth_key": "ab".repeat(32) }),
            AUTH_LIMIT + 1,
        );
        raw_json(&target, "/v1/auth/login", body).expect_error(413, "payload_too_large");
    }
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "after the oversize ones",
    )
    .expect(200);
}

#[test]
fn an_oversize_enrolment_creates_nothing_and_leaves_the_invitation_usable() {
    // Х3: nothing is created, the attempt is not counted against the address (П16).
    let target = Target::in_process();
    let ticket = target.new_ticket();
    let max = amby_sync_conformance::client::limit(&target.api, "login_max_failures");
    for _ in 0..max + 1 {
        let body = padded(
            json!({ "username": ticket.username, "enroll_code": ticket.enroll_code }),
            AUTH_LIMIT + 1,
        );
        raw_json(&target, "/v1/auth/enroll", body).expect_error(413, "payload_too_large");
    }
    enroll_with(&target, &ticket.username, &ticket.enroll_code, PASSWORD);
}

#[test]
fn a_normal_login_works() {
    // Х3, guard: ordinary sign-in is far below the limit. Passes before the code too.
    let target = Target::in_process();
    let account = enroll(&target, PASSWORD);
    login(
        &target.api,
        &account.username,
        PASSWORD,
        &account.ak,
        "again",
    )
    .expect(200);
}

// ----------------------------------------------------------------------------- Х4

/// A request whose body is sent only in part; the rest is sent by `finish`.
struct Slow {
    stream: TcpStream,
    rest: usize,
}

const MIB: usize = 1024 * 1024;
/// More than 1 MiB and below the 2 MiB of the suite's `max_json_bytes`.
const LARGE: usize = MIB + 100_000;
/// Time for the server to take the connection and start the handler.
const START_PAUSE: Duration = Duration::from_millis(400);

fn head(base: &str, path: &str, token: &str, length: usize) -> String {
    let host = base.trim_start_matches("http://");
    format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
    )
}

fn connect(base: &str) -> TcpStream {
    let stream = TcpStream::connect(base.trim_start_matches("http://")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    stream.set_nodelay(true).unwrap();
    stream
}

impl Slow {
    fn open(base: &str, path: &str, token: &str, length: usize) -> Slow {
        let mut stream = connect(base);
        let sent = 1000;
        stream
            .write_all(head(base, path, token, length).as_bytes())
            .unwrap();
        stream.write_all(&vec![b' '; sent]).unwrap();
        stream.flush().unwrap();
        std::thread::sleep(START_PAUSE);
        Slow {
            stream,
            rest: length - sent,
        }
    }

    fn finish(mut self) -> (u16, String) {
        let _ = self.stream.write_all(&vec![b' '; self.rest]);
        let _ = self.stream.flush();
        read_answer(self.stream)
    }
}

fn read_answer(mut stream: TcpStream) -> (u16, String) {
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("no HTTP answer came back: {text:?}"));
    (status, text)
}

/// A whole large request on a fresh connection; a write that the server cut short (it answered
/// without reading the body) is not an error here, the answer is what counts.
fn large_request(base: &str, path: &str, token: &str, length: usize) -> (u16, String) {
    let mut stream = connect(base);
    let _ = stream.write_all(head(base, path, token, length).as_bytes());
    let _ = stream.write_all(&vec![b' '; length]);
    let _ = stream.flush();
    read_answer(stream)
}

fn header_of(text: &str, name: &str) -> Option<String> {
    text.split("\r\n\r\n")
        .next()?
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.trim().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().to_string())
}

fn busy_server() -> (Target, Account, Space) {
    let target = Target::in_process_with(|config| config.max_large_bodies = 1);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    (target, account, space)
}

#[test]
fn a_second_large_json_body_is_503_server_busy_with_retry_after_while_one_is_open() {
    // Х4: with AMBY_SYNC_MAX_LARGE_BODIES=1 one slow body over 1 MiB holds the only place; the
    // next large one is refused at once with `503 server_busy` and `Retry-After: 5`.
    let (target, account, space) = busy_server();
    let _ = in_process_or_skip!(target);
    let base = account.api.base().to_string();
    let first = Slow::open(&base, &space.path("/commit"), &account.token, LARGE);

    let (status, text) = large_request(&base, &space.path("/commit"), &account.token, LARGE);
    assert_eq!(status, 503, "expected 503 server_busy, got: {text}");
    assert!(text.contains("server_busy"), "wrong error code: {text}");
    assert_eq!(header_of(&text, "retry-after").as_deref(), Some("5"));
    let _ = first.finish();
}

#[test]
fn small_requests_and_parts_pass_while_the_large_body_place_is_taken() {
    // Х4: bodies up to 1 MiB, parts of bodies and plain reads are not counted.
    let (target, account, space) = busy_server();
    let _ = in_process_or_skip!(target);
    let base = account.api.base().to_string();
    let first = Slow::open(&base, &space.path("/commit"), &account.token, LARGE);
    let (busy, text) = large_request(&base, &space.path("/commit"), &account.token, LARGE);
    assert_eq!(
        busy, 503,
        "the fixture is wrong: the place must be taken: {text}"
    );
    account.get("/v1/account").expect(200);
    let (_, _, new_space) = account.new_space_request("small");
    account.post("/v1/spaces", new_space).expect(201);
    let blob = new_body();
    space.init_blob(&blob, 100).expect(201);
    space.put_part(&blob, 0, vec![3u8; 100]).expect(200);
    // just below 1 MiB is still a small body
    let (status, text) = large_request(&base, &space.path("/commit"), &account.token, MIB - 1000);
    assert_ne!(
        status, 503,
        "a body below 1 MiB must not be counted: {text}"
    );
    let _ = first.finish();
}

#[test]
fn the_place_is_free_again_after_the_large_body_ends() {
    // Х4: after the first body is read to the end, a large one is taken again (the place is
    // given back, also when the body was bad: here it is not JSON and ends in an error).
    let (target, account, space) = busy_server();
    let _ = in_process_or_skip!(target);
    let base = account.api.base().to_string();
    let first = Slow::open(&base, &space.path("/commit"), &account.token, LARGE);
    let (status, _) = large_request(&base, &space.path("/commit"), &account.token, LARGE);
    assert_eq!(status, 503, "the fixture is wrong: the place must be taken");
    let _ = first.finish();
    let (status, text) = large_request(&base, &space.path("/commit"), &account.token, LARGE);
    assert_ne!(status, 503, "the place was not given back: {text}");
    // and once more: the answer to the second one gave its place back as well
    let (status, text) = large_request(&base, &space.path("/commit"), &account.token, LARGE);
    assert_ne!(status, 503, "the place was not given back: {text}");
}

#[test]
fn a_connection_dropped_in_the_middle_of_a_large_body_gives_its_place_back() {
    // Х4: a client that goes away must not keep the place forever.
    let (target, account, space) = busy_server();
    let _ = in_process_or_skip!(target);
    let base = account.api.base().to_string();
    let first = Slow::open(&base, &space.path("/commit"), &account.token, LARGE);
    let (busy, text) = large_request(&base, &space.path("/commit"), &account.token, LARGE);
    assert_eq!(
        busy, 503,
        "the fixture is wrong: the place must be taken: {text}"
    );
    drop(first);
    let mut last = 503;
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        last = large_request(&base, &space.path("/commit"), &account.token, LARGE).0;
        if last != 503 {
            break;
        }
    }
    assert_ne!(last, 503, "the dropped body kept its place");
}

// ----------------------------------------------------------------------------- Х6

const REQUIRED: &str = "subscription_required";

fn plans_text() -> String {
    json!({
        "default_plan": "free",
        "plans": {
            "free": {"title": "Free", "sync": false},
            "pro": {"title": "Pro", "sync": true}
        }
    })
    .to_string()
}

struct Unsubscribed {
    target: Target,
    account: Account,
    space: Space,
    /// A live item at version 2.
    live: Prepared,
    /// A live item at version 1.
    other: Prepared,
    /// An item whose version 2 is a deletion.
    deleted: Prepared,
}

fn unsubscribed() -> Unsubscribed {
    let target = Target::in_process_with_plans(&plans_text(), |_| {});
    assert!(target.control().is_some(), "needs a server in this process");
    let account = enroll(&target, PASSWORD);
    target.cli_ok(&["user", "plan", "set", &account.username, "pro"]);
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.raw_file(&item, 0, "live.md", 400)]);
    let live = space.raw_file(&item, 1, "live.md", 500);
    space.commit_ok(std::slice::from_ref(&live));
    let other = space.raw_file(&new_item(), 0, "other.md", 300);
    space.commit_ok(std::slice::from_ref(&other));
    let dead = new_item();
    space.commit_ok(&[space.raw_file(&dead, 0, "dead.md", 200)]);
    let deleted = space.deletion(&dead, 1, "dead.md");
    space.commit_ok(std::slice::from_ref(&deleted));
    target.cli_ok(&["user", "plan", "set", &account.username, "--default"]);
    // the guard: the plan really has no sync now
    space.init_blob(&new_body(), 10).expect_error(403, REQUIRED);
    Unsubscribed {
        target,
        account,
        space,
        live,
        other,
        deleted,
    }
}

fn assert_refused(response: Resp) {
    let refused = response.expect_error(403, REQUIRED);
    let details = &refused.json()["error"]["details"];
    assert!(
        details.is_null() || details == &json!({}),
        "Н5: no details about the plan: {details}"
    );
}

#[test]
fn without_a_subscription_deleting_an_existing_live_item_is_accepted() {
    // Х6: base_version equals the current version (≥ 1), the current version is not a deletion.
    let u = unsubscribed();
    let gone = u.space.deletion(&u.live.item, 2, "live.md");
    u.space.commit_ok(std::slice::from_ref(&gone));
    let feed = u.space.all_changes(0);
    let entry = feed
        .iter()
        .find(|change| change["item_id"] == u.live.json["item_id"])
        .unwrap();
    assert_eq!(entry["version"], 3);
    assert!(u.space.open_change(entry).deleted);
    let _ = (&u.account, &u.target);
}

#[test]
fn without_a_subscription_deleting_a_new_item_is_403_and_nothing_is_applied() {
    // Х6: base_version 0 is an addition, not a release of space.
    let u = unsubscribed();
    let before = u.space.all_changes(0);
    let fresh = u.space.deletion(&new_item(), 0, "never-existed.md");
    assert_refused(u.space.commit(&[fresh]));
    assert_eq!(u.space.all_changes(0), before);
}

#[test]
fn without_a_subscription_deleting_an_already_deleted_item_is_403() {
    // Х6: the current version is a deletion, so there is nothing to delete.
    let u = unsubscribed();
    let before = u.space.all_changes(0);
    let again = u.space.deletion(&u.deleted.item, 2, "dead.md");
    assert_refused(u.space.commit(&[again]));
    assert_eq!(u.space.all_changes(0), before);
}

#[test]
fn without_a_subscription_deleting_with_a_wrong_version_is_403() {
    // Х6: a version that is not the current one, lower or higher, or 0 for an existing item.
    let u = unsubscribed();
    let before = u.space.all_changes(0);
    for base in [0u64, 1, 3, 9] {
        let wrong = u.space.deletion(&u.live.item, base, "live.md");
        assert_refused(u.space.commit(&[wrong]));
    }
    assert_eq!(u.space.all_changes(0), before);
}

#[test]
fn a_commit_of_a_good_and_a_bad_deletion_is_refused_whole() {
    // Х6: "403 as a whole, nothing is applied": the good deletion is not applied either.
    let u = unsubscribed();
    let before = u.space.all_changes(0);
    let good = u.space.deletion(&u.other.item, 1, "other.md");
    let bad = u.space.deletion(&new_item(), 0, "never-existed.md");
    assert_refused(u.space.commit(&[good.clone(), bad]));
    assert_eq!(u.space.all_changes(0), before);
    // and the good one alone still goes through
    u.space.commit_ok(&[good]);
}

#[test]
fn with_a_subscription_the_old_rules_of_deletion_stay() {
    // Х6: with sync the rules П26–П30 apply unchanged: a deletion of a new item is accepted,
    // a wrong version is a conflict, not 403. Passes before the code too.
    let u = unsubscribed();
    u.target
        .cli_ok(&["user", "plan", "set", &u.account.username, "pro"]);
    let fresh = u.space.deletion(&new_item(), 0, "never-existed.md");
    u.space.commit_ok(&[fresh]);
    let wrong = u.space.deletion(&u.live.item, 1, "live.md");
    let answer = u.space.commit(&[wrong]);
    assert_eq!(answer.status, 409, "{}", answer.text());
}
