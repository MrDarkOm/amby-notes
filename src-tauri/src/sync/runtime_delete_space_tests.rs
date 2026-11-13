//! Server-space deletion from the application (docs/sync-plan.md, appendix Л, Л6–Л9).
//!
//! These tests deliberately exercise only the public runtime boundary. They are written before
//! the delete implementation: the current `todo!()` (and the server's 501 stub) must make this
//! module red for the intended reason.

use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use amby_sync_conformance::client::Account;
use serde_json::{json, Value};

use super::connection::{ConnectionRecord, ConnectionStore};
use super::runtime::SyncRuntime;
use super::secrets::{SecretStore, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use super::session::Schedule;
use super::state_db::{state_path, SqliteStateStore, META_ENABLED, META_SPACE_ID};
use super::test_support::{Env, MemoryConnection, MemorySecrets, Recorder, TempVault};
use super::vault_types::{SpaceTarget, SyncPhase, VaultSyncStatus};

struct Computer {
    runtime: SyncRuntime,
    secrets: Arc<MemorySecrets>,
    connection: Arc<MemoryConnection>,
    recorder: Arc<Recorder>,
}

impl Drop for Computer {
    fn drop(&mut self) {
        // Keep a red todo!() run from leaving a background session behind while the test Env's
        // Tokio runtime is being dropped. This is test cleanup only; the assertions still fail at
        // the delete call for the intended reason.
        self.runtime.deactivate_vault();
    }
}

fn computer(env: &Env, account: &Account) -> Computer {
    computer_at(env, account, env.target.api.base())
}

fn computer_at(env: &Env, account: &Account, server_url: &str) -> Computer {
    let secrets = Arc::new(MemorySecrets::default());
    let connection = Arc::new(MemoryConnection::default());
    secrets
        .set(SECRET_ACCOUNT_KEY, &hex::encode(account.ak.as_bytes()))
        .unwrap();
    secrets.set(SECRET_DEVICE_TOKEN, &account.token).unwrap();
    connection
        .save(&ConnectionRecord {
            server_url: server_url.to_string(),
            allow_http: true,
            username: account.username.clone(),
            device_id: account.device_id.clone(),
        })
        .unwrap();
    let recorder = Arc::new(Recorder::default());
    Computer {
        runtime: SyncRuntime::new(
            secrets.clone(),
            connection.clone(),
            env.runtime.handle().clone(),
            Schedule::fast(),
            recorder.clone(),
        ),
        secrets,
        connection,
        recorder,
    }
}

fn run<T>(env: &Env, future: impl std::future::Future<Output = T>) -> T {
    env.runtime.block_on(future)
}

fn wait_until(label: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(Instant::now() < deadline, "timed out: {label}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn latest_status(recorder: &Recorder) -> Option<VaultSyncStatus> {
    recorder.statuses.lock().unwrap().last().cloned()
}

fn wait_for_completed_pass_after(computer: &Computer, previous_passes: usize) {
    wait_until("a new completed sync pass", || {
        computer.recorder.passes_started() > previous_passes
            && latest_status(&computer.recorder)
                .is_some_and(|status| status.phase == SyncPhase::Idle && status.last.is_some())
    });
}

fn wait_for_terminal_pass_after(computer: &Computer, previous_passes: usize) {
    wait_until("the other device handles the deleted space", || {
        computer.recorder.passes_started() > previous_passes
            && latest_status(&computer.recorder).is_some_and(|status| {
                status.phase == SyncPhase::Off
                    || (status.phase == SyncPhase::Waiting && status.error_code.is_some())
                    || status.error_code.is_some()
            })
    });
}

fn server_has_space(env: &Env, space_id: &str) -> bool {
    env.account.get("/v1/spaces").expect(200).json()["spaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|space| space["space_id"].as_str() == Some(space_id))
}

fn enable_new(env: &Env, computer: &Computer, vault: &TempVault, name: &str) -> String {
    run(
        env,
        computer.runtime.enable(
            &vault.root,
            SpaceTarget::New {
                name: name.to_string(),
            },
            true,
        ),
    )
    .unwrap()
    .space_id
    .expect("a new space has an id")
}

/// User-owned files and durable `.amby/` data. The sync state database is intentionally absent:
/// it is local connection metadata that may change when the link is stopped or forgotten.
fn seed_local_files(vault: &TempVault) -> Vec<String> {
    let files = [
        (
            "Notes/bom-crlf.md",
            b"\xEF\xBB\xBFfirst\r\nsecond\r\n".as_slice(),
        ),
        ("attachments/photo.bin", &[0, 1, 2, 255][..]),
        (
            ".amby/properties.json",
            br#"{"groups":{"work":{"color":"blue"}}}"#,
        ),
        (
            ".amby/history/entry.md",
            b"history: original\r\n".as_slice(),
        ),
        (
            ".amby/recovery/open-note.json",
            br#"{"draft":"not saved yet"}"#,
        ),
        (
            ".amby/conflicts/second-version.md",
            b"the other version\n".as_slice(),
        ),
        (
            ".amby/archive/old-note.md",
            b"archived bytes\r\n".as_slice(),
        ),
    ];
    for (path, bytes) in files {
        vault.put(path, bytes);
    }
    files.iter().map(|(path, _)| (*path).to_string()).collect()
}

fn snapshot(vault: &TempVault, paths: &[String]) -> BTreeMap<String, Vec<u8>> {
    paths
        .iter()
        .map(|path| {
            (
                path.clone(),
                vault.bytes(path).expect("fixture file exists"),
            )
        })
        .collect()
}

fn assert_snapshot(vault: &TempVault, expected: &BTreeMap<String, Vec<u8>>) {
    let actual = expected
        .keys()
        .map(|path| {
            (
                path.clone(),
                vault
                    .bytes(path)
                    .expect("delete must not remove local data"),
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(actual, *expected);
}

/// A legacy server: DELETE is rejected, while listing still proves the space exists. The
/// application must not turn the old-server response into a confirmed deletion (Л5).
type RequestLog = Arc<Mutex<Vec<String>>>;

/// The keys of the test account as the server gives them: the deletion reads them first to prove the
/// password on this device (appendix Ц, Ц2).
fn env_keys(env: &Env) -> Value {
    env.account.get("/v1/keys").expect(200).json()
}

fn old_server(
    keys: Value,
    listing: String,
    delete_status: u16,
) -> (String, RequestLog, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen_requests = requests.clone();
    let reason = match delete_status {
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let body = format!(
        r#"{{"error":{{"code":"{}","message":"old server"}}}}"#,
        if delete_status == 405 {
            "method_not_allowed"
        } else {
            "not_found"
        }
    );
    let handle = std::thread::spawn(move || {
        // The password is proved first (Ц2): Argon2 takes a second or two in a debug build.
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            let mut stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(_) => return,
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
            let mut buffer = [0u8; 16 * 1024];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let head = String::from_utf8_lossy(&buffer[..read]);
            seen_requests
                .lock()
                .unwrap()
                .push(head.lines().next().unwrap_or_default().to_string());
            let (status, response_body) = if head.starts_with("GET /v1/keys ") {
                ("200 OK".to_string(), keys.to_string())
            } else if head.starts_with("DELETE /v1/spaces/") {
                (format!("{delete_status} {reason}"), body.clone())
            } else if head.starts_with("GET /v1/spaces ") {
                ("200 OK".to_string(), listing.clone())
            } else {
                (
                    "404 Not Found".to_string(),
                    r#"{"error":{"code":"not_found","message":"old server"}}"#.to_string(),
                )
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
        }
    });
    (address, requests, handle)
}

#[derive(Clone)]
struct HeldDeleteControl {
    requests: RequestLog,
    spaces: Arc<Mutex<Vec<Value>>>,
    info: Value,
    keys: Value,
    changes_started: Arc<AtomicBool>,
    hold_changes: Arc<AtomicBool>,
    release_changes: Arc<AtomicBool>,
    delete_started: Arc<AtomicBool>,
    release_delete: Arc<AtomicBool>,
    drop_delete: Arc<AtomicBool>,
    delete_status: Arc<Mutex<u16>>,
    enabled_at_delete: Arc<Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
}

struct HeldDeleteServer {
    url: String,
    control: HeldDeleteControl,
    accept_thread: Option<std::thread::JoinHandle<()>>,
}

impl HeldDeleteServer {
    fn new(
        vault_root: Option<PathBuf>,
        hold_delete: bool,
        drop_delete: bool,
        info: Value,
        keys: Value,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let control = HeldDeleteControl {
            requests: Arc::new(Mutex::new(Vec::new())),
            spaces: Arc::new(Mutex::new(Vec::new())),
            info,
            keys,
            changes_started: Arc::new(AtomicBool::new(false)),
            hold_changes: Arc::new(AtomicBool::new(false)),
            release_changes: Arc::new(AtomicBool::new(true)),
            delete_started: Arc::new(AtomicBool::new(false)),
            release_delete: Arc::new(AtomicBool::new(!hold_delete)),
            drop_delete: Arc::new(AtomicBool::new(drop_delete)),
            delete_status: Arc::new(Mutex::new(200)),
            enabled_at_delete: Arc::new(Mutex::new(None)),
            stop: Arc::new(AtomicBool::new(false)),
        };
        let accept_control = control.clone();
        let accept_thread = thread::spawn(move || {
            // Ends by `stop`; the deadline is only a guard. Proving the password (Ц2) runs Argon2,
            // which is slow when several tests do it at once.
            let deadline = Instant::now() + Duration::from_secs(60);
            while !accept_control.stop.load(Ordering::SeqCst) && Instant::now() < deadline {
                let (stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => return,
                };
                let connection_control = accept_control.clone();
                let connection_root = vault_root.clone();
                thread::spawn(move || {
                    serve_held_request(stream, connection_control, connection_root);
                });
            }
        });
        Self {
            url,
            control,
            accept_thread: Some(accept_thread),
        }
    }
}

fn serve_held_request(
    mut stream: std::net::TcpStream,
    control: HeldDeleteControl,
    vault_root: Option<PathBuf>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let mut buffer = [0u8; 16 * 1024];
    let mut read = stream.read(&mut buffer).unwrap_or(0);
    if let Some(header_end) = buffer[..read]
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
    {
        let content_length = String::from_utf8_lossy(&buffer[..header_end])
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        let required = header_end.saturating_add(content_length);
        while read < required && read < buffer.len() {
            let count = stream.read(&mut buffer[read..]).unwrap_or(0);
            if count == 0 {
                break;
            }
            read += count;
        }
    }
    let head = String::from_utf8_lossy(&buffer[..read]);
    let request_line = head.lines().next().unwrap_or_default().to_string();
    control.requests.lock().unwrap().push(request_line.clone());
    let (status, body) = if request_line.starts_with("POST /v1/spaces ") {
        if let Some(raw_body) = head.split("\r\n\r\n").nth(1) {
            if let Ok(mut space) = serde_json::from_str::<Value>(raw_body) {
                space["seq"] = json!(0);
                space["created_ms"] = json!(1);
                control.spaces.lock().unwrap().push(space);
            }
        }
        ("201 Created", "{}".to_string())
    } else if request_line.starts_with("DELETE /v1/spaces/") {
        control.delete_started.store(true, Ordering::SeqCst);
        if let Some(root) = vault_root.as_deref() {
            let state = SqliteStateStore::open(root)
                .ok()
                .and_then(|store| store.meta(META_ENABLED).ok().flatten())
                .unwrap_or_else(|| "state_read_failed".to_string());
            *control.enabled_at_delete.lock().unwrap() = Some(state);
        }
        while !control.release_delete.load(Ordering::SeqCst) && !control.stop.load(Ordering::SeqCst)
        {
            thread::sleep(Duration::from_millis(5));
        }
        if let Some(space_id) = request_line
            .strip_prefix("DELETE /v1/spaces/")
            .and_then(|path| path.split_whitespace().next())
        {
            control
                .spaces
                .lock()
                .unwrap()
                .retain(|space| space["space_id"].as_str() != Some(space_id));
        }
        if control.drop_delete.load(Ordering::SeqCst) {
            return;
        }
        let status_code = *control.delete_status.lock().unwrap();
        if status_code == 200 {
            ("200 OK", r#"{"ok":true}"#.to_string())
        } else {
            (
                "404 Not Found",
                r#"{"error":{"code":"not_found","message":"gone"}}"#.to_string(),
            )
        }
    } else if request_line.starts_with("GET /v1/keys ") {
        ("200 OK", control.keys.to_string())
    } else if request_line.starts_with("GET /v1/info ") {
        ("200 OK", control.info.clone().to_string())
    } else if request_line.starts_with("GET /v1/spaces/") && request_line.contains("/changes?") {
        control.changes_started.store(true, Ordering::SeqCst);
        while control.hold_changes.load(Ordering::SeqCst)
            && !control.release_changes.load(Ordering::SeqCst)
            && !control.stop.load(Ordering::SeqCst)
        {
            thread::sleep(Duration::from_millis(5));
        }
        let instance_id = control.info["instance_id"]
            .as_str()
            .unwrap_or("00000000000000000000000000000000");
        (
            "200 OK",
            json!({
                "instance_id": instance_id,
                "seq": 0,
                "since": 0,
                "next": 0,
                "more": false,
                "gap": false,
                "changes": []
            })
            .to_string(),
        )
    } else if request_line.starts_with("GET /v1/spaces ") {
        let spaces = control.spaces.lock().unwrap().clone();
        ("200 OK", json!({"spaces": spaces}).to_string())
    } else {
        ("200 OK", "{}".to_string())
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

impl Drop for HeldDeleteServer {
    fn drop(&mut self) {
        self.control.release_changes.store(true, Ordering::SeqCst);
        self.control.release_delete.store(true, Ordering::SeqCst);
        self.control.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.accept_thread.take() {
            let _ = thread.join();
        }
    }
}

/// The password of `Env::account` (`test_support`): the deletion proves it (appendix Ц, Ц4).
const ACCOUNT_PASSWORD: &str = "a long enough password for tests";

#[test]
fn deleting_the_current_space_stops_sync_forgets_the_link_and_keeps_local_bytes() {
    // Л6, Л7, Л8: stop before DELETE; preserve notes (BOM/CRLF), attachments and durable data;
    // forget only the local connection metadata after confirmed server deletion.
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("Delete current"));
    let vault = TempVault::new("delete-current");
    let paths = seed_local_files(&vault);
    let expected = snapshot(&vault, &paths);
    let space_id = enable_new(&env, &pc, &vault, "Delete me");

    let result = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD));
    assert!(
        result.is_ok(),
        "confirmed deletion must succeed: {result:?}"
    );

    let status = pc.runtime.status();
    assert_eq!(status.phase, SyncPhase::Off, "the session is stopped");
    assert!(!status.enabled, "the vault remains switched off");
    assert!(!status.linked, "the deleted link is forgotten");
    assert_eq!(status.space_id, None);
    assert_eq!(
        SqliteStateStore::open(&vault.root)
            .unwrap()
            .meta(META_SPACE_ID)
            .unwrap(),
        None
    );
    assert_eq!(
        SqliteStateStore::open(&vault.root)
            .unwrap()
            .meta(META_ENABLED)
            .unwrap()
            .as_deref(),
        Some("0")
    );
    assert!(!server_has_space(&env, &space_id));
    assert_snapshot(&vault, &expected);
}

#[test]
fn the_stopped_state_is_persisted_before_the_delete_request() {
    // Л6: this fake endpoint is configured before enablement. It reads META_ENABLED at the exact
    // DELETE boundary, proving that the local stop is durable before the server is contacted.
    let env = Env::new();
    let vault = TempVault::new("delete-order");
    let paths = seed_local_files(&vault);
    let expected = snapshot(&vault, &paths);
    let info = env.account.get("/v1/info").expect(200).json();
    let server =
        HeldDeleteServer::new(Some(vault.root.clone()), false, false, info, env_keys(&env));
    let pc = computer_at(&env, &env.account, &server.url);
    let space_id = enable_new(&env, &pc, &vault, "Order");

    let result = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD));
    assert!(
        result.is_ok(),
        "confirmed deletion must succeed: {result:?}"
    );

    let requests = server.control.requests.lock().unwrap().clone();
    assert!(
        requests
            .iter()
            .any(|request| request.starts_with("DELETE /v1/spaces/")),
        "spy saw no DELETE: {requests:?}"
    );
    assert_eq!(
        server.control.enabled_at_delete.lock().unwrap().as_deref(),
        Some("0"),
        "the stopped state was not durable before DELETE"
    );
    assert_eq!(pc.runtime.status().phase, SyncPhase::Off);
    assert_snapshot(&vault, &expected);
}

#[test]
fn delete_waits_for_an_active_pass_before_sending_the_request() {
    // Л6: a multi-connection fake holds GET changes while accepting DELETE on another socket.
    // DELETE must not overtake the held pass; releasing the pass lets the request finish.
    let env = Env::new();
    let vault = TempVault::new("delete-active-pass");
    let info = env.account.get("/v1/info").expect(200).json();
    let server =
        HeldDeleteServer::new(Some(vault.root.clone()), false, false, info, env_keys(&env));
    let pc = computer_at(&env, &env.account, &server.url);
    let space_id = enable_new(&env, &pc, &vault, "Active pass");
    let before = pc.recorder.passes_started();
    pc.runtime.sync_now().unwrap();
    wait_for_completed_pass_after(&pc, before);

    server
        .control
        .changes_started
        .store(false, Ordering::SeqCst);
    server
        .control
        .release_changes
        .store(false, Ordering::SeqCst);
    server.control.hold_changes.store(true, Ordering::SeqCst);
    pc.runtime.sync_now().unwrap();
    wait_until("the active pass reaches GET changes", || {
        server.control.changes_started.load(Ordering::SeqCst)
    });

    let (started_tx, started_rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let delete_thread = scope.spawn(|| {
            started_tx.send(()).unwrap();
            run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD))
        });
        started_rx.recv().unwrap();
        thread::sleep(Duration::from_millis(150));
        let overtook_pass = server.control.delete_started.load(Ordering::SeqCst);
        server.control.release_changes.store(true, Ordering::SeqCst);
        let result = match delete_thread.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };
        assert!(!overtook_pass, "DELETE overtook the active sync pass");
        assert!(
            result.is_ok(),
            "confirmed deletion must succeed: {result:?}"
        );
    });
    assert_eq!(
        server.control.enabled_at_delete.lock().unwrap().as_deref(),
        Some("0")
    );
}

#[test]
fn a_stale_delete_response_cannot_disable_a_new_current_vault() {
    // Л9: while the old DELETE is held, switch this runtime to another linked vault. Releasing
    // the old response must not apply its stop/forget result to the new current link.
    let env = Env::new();
    let info = env.account.get("/v1/info").expect(200).json();
    let server = HeldDeleteServer::new(None, true, false, info, env_keys(&env));
    let old = computer_at(&env, &env.account, &server.url);
    let old_vault = TempVault::new("delete-stale-old");
    let old_id = enable_new(&env, &old, &old_vault, "Old current");

    let setup = computer_at(&env, &env.account, &server.url);
    let new_vault = TempVault::new("delete-stale-new");
    let new_id = enable_new(&env, &setup, &new_vault, "New current");
    setup.runtime.disable().unwrap();
    setup.runtime.deactivate_vault();

    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let env_ref = &env;
    let old_runtime = &old.runtime;
    let old_id_ref = &old_id;
    std::thread::scope(|scope| {
        let delete_thread = scope.spawn(move || {
            started_tx.send(()).unwrap();
            run(
                env_ref,
                old_runtime.delete_space(old_id_ref, ACCOUNT_PASSWORD),
            )
        });
        started_rx.recv().unwrap();
        wait_until("the old DELETE reaches the stale-response server", || {
            server.control.delete_started.load(Ordering::SeqCst) || delete_thread.is_finished()
        });
        if !server.control.delete_started.load(Ordering::SeqCst) {
            server.control.release_delete.store(true, Ordering::SeqCst);
            match delete_thread.join() {
                Ok(_) => panic!("delete finished without sending a request"),
                Err(panic) => std::panic::resume_unwind(panic),
            }
        }

        let (switch_tx, switch_rx) = std::sync::mpsc::channel();
        let switch_env = &env;
        let switch_runtime = &old.runtime;
        let switch_vault = &new_vault.root;
        let switch_thread = scope.spawn(move || {
            let result = run(
                switch_env,
                switch_runtime.enable(
                    switch_vault,
                    SpaceTarget::New {
                        name: "ignored".to_string(),
                    },
                    true,
                ),
            );
            switch_tx.send(result).unwrap();
        });
        let switched = switch_rx.recv_timeout(Duration::from_millis(500)).ok();
        server.control.release_delete.store(true, Ordering::SeqCst);
        let switch_result = switched
            .unwrap_or_else(|| panic!("switching the current vault waited for stale DELETE"));
        switch_thread.join().unwrap();
        let _delete_result = match delete_thread.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };
        let _switch_result = switch_result;
    });

    let status = old.runtime.status();
    assert!(status.enabled, "the new vault remains enabled");
    assert_eq!(status.space_id.as_deref(), Some(new_id.as_str()));
    assert_eq!(
        SqliteStateStore::open(&new_vault.root)
            .unwrap()
            .meta(META_SPACE_ID)
            .unwrap()
            .as_deref(),
        Some(new_id.as_str())
    );
    assert_eq!(
        SqliteStateStore::open(&new_vault.root)
            .unwrap()
            .meta(META_ENABLED)
            .unwrap()
            .as_deref(),
        Some("1")
    );
    assert!(!server.control.requests.lock().unwrap().is_empty());
}

#[test]
fn a_stale_delete_response_cannot_replace_switched_account_credentials() {
    // Л9: an in-flight request from the old account must not clear or overwrite credentials after
    // the connection record and key store have moved to a different account.
    let env = Env::new();
    let info = env.account.get("/v1/info").expect(200).json();
    let server = HeldDeleteServer::new(None, true, false, info, env_keys(&env));
    let pc = computer_at(&env, &env.account, &server.url);
    let vault = TempVault::new("delete-stale-account");
    let old_id = enable_new(&env, &pc, &vault, "Old account");
    let new_account = amby_sync_conformance::client::enroll(
        &env.target,
        "another long enough password for tests",
    );

    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let env_ref = &env;
    let pc_runtime = &pc.runtime;
    let old_id_ref = &old_id;
    std::thread::scope(|scope| {
        let delete_thread = scope.spawn(move || {
            started_tx.send(()).unwrap();
            run(
                env_ref,
                pc_runtime.delete_space(old_id_ref, ACCOUNT_PASSWORD),
            )
        });
        started_rx.recv().unwrap();
        wait_until("the old account DELETE reaches the server", || {
            server.control.delete_started.load(Ordering::SeqCst) || delete_thread.is_finished()
        });
        if !server.control.delete_started.load(Ordering::SeqCst) {
            server.control.release_delete.store(true, Ordering::SeqCst);
            match delete_thread.join() {
                Ok(_) => panic!("delete finished without sending a request"),
                Err(panic) => std::panic::resume_unwind(panic),
            }
        }

        pc.connection
            .save(&ConnectionRecord {
                server_url: server.url.clone(),
                allow_http: true,
                username: new_account.username.clone(),
                device_id: new_account.device_id.clone(),
            })
            .unwrap();
        pc.secrets
            .set(SECRET_ACCOUNT_KEY, &hex::encode(new_account.ak.as_bytes()))
            .unwrap();
        pc.secrets
            .set(SECRET_DEVICE_TOKEN, &new_account.token)
            .unwrap();
        server.control.release_delete.store(true, Ordering::SeqCst);

        let _result = match delete_thread.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        };
    });

    let connection = pc.connection.load().unwrap().unwrap();
    assert_eq!(connection.username, new_account.username);
    assert_eq!(connection.device_id, new_account.device_id);
    let new_key = hex::encode(new_account.ak.as_bytes());
    assert_eq!(
        pc.secrets.peek(SECRET_ACCOUNT_KEY).as_deref(),
        Some(new_key.as_str())
    );
    assert_eq!(
        pc.secrets.peek(SECRET_DEVICE_TOKEN),
        Some(new_account.token)
    );
    assert_eq!(
        SqliteStateStore::open(&vault.root)
            .unwrap()
            .meta(META_SPACE_ID)
            .unwrap()
            .as_deref(),
        Some(old_id.as_str())
    );
}

#[test]
fn reactivating_after_deletion_does_not_recreate_the_server_space() {
    // Л8: after success, activation is an explicit new/existing-space choice and never revives
    // the old server copy.
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("Delete then activate"));
    let vault = TempVault::new("delete-reactivate");
    let space_id = enable_new(&env, &pc, &vault, "Do not revive");

    let result = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD));
    assert!(
        result.is_ok(),
        "confirmed deletion must succeed: {result:?}"
    );

    let status = run(&env, pc.runtime.activate_vault(&vault.root)).unwrap();
    assert!(!status.enabled);
    assert!(!status.linked);
    assert_eq!(status.phase, SyncPhase::Off);
    assert_eq!(status.space_id, None);
    assert!(!server_has_space(&env, &space_id));
}

#[test]
fn deleting_another_space_leaves_the_current_vault_running() {
    // Л6, Л8, Л9: deleting a non-current account space must not stop or relink the open vault.
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("Keep current"));
    let vault = TempVault::new("keep-current");
    let current_id = enable_new(&env, &pc, &vault, "Current");
    let other = env.account.create_space_named("Other");
    let other_id = hex::encode(other.id.as_bytes());

    let result = run(&env, pc.runtime.delete_space(&other_id, ACCOUNT_PASSWORD));
    assert!(
        result.is_ok(),
        "deleting another space must succeed: {result:?}"
    );

    let status = pc.runtime.status();
    assert!(status.enabled, "the current vault stays enabled");
    assert!(status.linked);
    assert_ne!(status.phase, SyncPhase::Off);
    assert_eq!(status.space_id.as_deref(), Some(current_id.as_str()));
    assert!(server_has_space(&env, &current_id));
    assert!(!server_has_space(&env, &other_id));
}

#[test]
fn a_server_refusal_keeps_local_files_and_is_not_reported_as_success() {
    // Л6, Л7, Л8, Ц2: inject an authorization refusal after a real link was made. The application
    // must surface the refusal, keep the local link for retry, and preserve bytes. Since Ц2 the
    // token is refused already when the password is proved, before sync is stopped, so the vault
    // keeps syncing as it was.
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("Refused delete"));
    let vault = TempVault::new("delete-refused");
    let paths = seed_local_files(&vault);
    let expected = snapshot(&vault, &paths);
    let space_id = enable_new(&env, &pc, &vault, "Refused");
    pc.secrets
        .set(SECRET_DEVICE_TOKEN, &"00".repeat(32))
        .unwrap();

    let error = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD)).unwrap_err();
    assert_eq!(error.code, "unauthorized");

    let status = pc.runtime.status();
    assert!(
        status.enabled,
        "nothing was stopped before the refusal (Ц2)"
    );
    assert!(status.linked, "the link remains retryable after refusal");
    assert_eq!(status.space_id.as_deref(), Some(space_id.as_str()));
    assert_eq!(
        SqliteStateStore::open(&vault.root)
            .unwrap()
            .meta(META_ENABLED)
            .unwrap()
            .as_deref(),
        Some("1")
    );
    assert!(server_has_space(&env, &space_id));
    assert_snapshot(&vault, &expected);
}

#[test]
fn a_lost_delete_response_keeps_the_link_disabled_and_can_be_retried() {
    // Л5, Л7, Л8: a dropped DELETE response is unknown, never success; local data and the
    // disabled link remain, while a retry is accepted only after GET proves the id absent.
    let env = Env::new();
    let info = env.account.get("/v1/info").expect(200).json();
    let server = HeldDeleteServer::new(None, false, false, info, env_keys(&env));
    let pc = computer_at(&env, &env.account, &server.url);
    let vault = TempVault::new("delete-lost-response");
    let space_id = enable_new(&env, &pc, &vault, "Lost response");
    let paths = seed_local_files(&vault);
    let expected = snapshot(&vault, &paths);
    server.control.drop_delete.store(true, Ordering::SeqCst);

    let error = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD)).unwrap_err();
    assert!(!error.code.is_empty());
    assert!(!pc.runtime.status().enabled);
    assert!(pc.runtime.status().linked);
    assert_eq!(
        SqliteStateStore::open(&vault.root)
            .unwrap()
            .meta(META_ENABLED)
            .unwrap()
            .as_deref(),
        Some("0")
    );
    assert_eq!(
        SqliteStateStore::open(&vault.root)
            .unwrap()
            .meta(META_SPACE_ID)
            .unwrap()
            .as_deref(),
        Some(space_id.as_str())
    );
    assert_snapshot(&vault, &expected);

    server.control.drop_delete.store(false, Ordering::SeqCst);
    *server.control.delete_status.lock().unwrap() = 404;
    server.control.spaces.lock().unwrap().clear();
    let retry = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD));
    assert!(
        retry.is_ok(),
        "absence confirmed by GET should succeed: {retry:?}"
    );
    assert_snapshot(&vault, &expected);
}

#[test]
fn an_old_server_404_or_405_is_not_reported_as_a_confirmed_deletion() {
    // Л5: a legacy server that rejects DELETE but still lists the space is not success. The
    // runtime may expose the stable `unsupported_server` code or the original protocol code.
    let env = Env::new();
    let space_id = hex::encode(env.space_id);
    let listing = env.account.get("/v1/spaces").expect(200).text();
    for delete_status in [404, 405] {
        let (server_url, requests, server_thread) =
            old_server(env_keys(&env), listing.clone(), delete_status);
        let pc = computer_at(&env, &env.account, &server_url);
        let error = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD)).unwrap_err();
        assert!(
            matches!(
                error.code.as_str(),
                "unsupported_server" | "not_found" | "method_not_allowed"
            ),
            "old server must remain an error, got {:?} for {delete_status}",
            error.code
        );
        server_thread.join().unwrap();
        let requests = requests.lock().unwrap().clone();
        assert!(
            requests
                .iter()
                .any(|request| request.starts_with("DELETE /v1/spaces/")),
            "legacy script saw no DELETE: {requests:?}"
        );
        assert!(
            requests
                .iter()
                .any(|request| request.starts_with("GET /v1/spaces ")),
            "legacy script saw no follow-up space listing: {requests:?}"
        );
    }
}

#[test]
fn a_repeat_delete_accepts_absence_only_after_the_space_list_is_empty() {
    // Л5: a lost response is safe to retry only when the follow-up list proves this id absent.
    let env = Env::new();
    let space_id = hex::encode(env.space_id);
    let (server_url, requests, server_thread) =
        old_server(env_keys(&env), r#"{"spaces":[]}"#.to_string(), 404);
    let pc = computer_at(&env, &env.account, &server_url);

    let result = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD));
    assert!(
        result.is_ok(),
        "absence confirmed by GET should be success: {result:?}"
    );

    server_thread.join().unwrap();
    let requests = requests.lock().unwrap().clone();
    assert!(
        requests
            .iter()
            .any(|request| request.starts_with("DELETE /v1/spaces/")),
        "repeat-delete script saw no DELETE: {requests:?}"
    );
    assert!(
        requests
            .iter()
            .any(|request| request.starts_with("GET /v1/spaces ")),
        "repeat-delete script saw no follow-up listing: {requests:?}"
    );
}

#[test]
fn an_invalid_space_id_is_rejected_without_touching_the_open_vault() {
    // Л9: the application validates the id at its boundary and must not send a malformed DELETE.
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("Invalid id"));
    let vault = TempVault::new("delete-invalid");
    let paths = seed_local_files(&vault);
    let expected = snapshot(&vault, &paths);
    let current_id = enable_new(&env, &pc, &vault, "Valid current");

    let listing = env.account.get("/v1/spaces").expect(200).text();
    let (spy_url, requests, spy_thread) = old_server(env_keys(&env), listing, 404);
    let spy = computer_at(&env, &env.account, &spy_url);
    let error = run(
        &env,
        spy.runtime
            .delete_space("not-a-16-byte-hex-id", ACCOUNT_PASSWORD),
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_space");
    spy_thread.join().unwrap();
    let requests = requests.lock().unwrap().clone();
    assert!(
        requests.is_empty(),
        "invalid id sent a request: {requests:?}"
    );

    let error = run(
        &env,
        pc.runtime
            .delete_space("not-a-16-byte-hex-id", ACCOUNT_PASSWORD),
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_space");

    let status = pc.runtime.status();
    assert!(status.enabled);
    assert!(status.linked);
    assert_ne!(status.phase, SyncPhase::Off);
    assert_eq!(status.space_id.as_deref(), Some(current_id.as_str()));
    assert!(server_has_space(&env, &current_id));
    assert_snapshot(&vault, &expected);
}

#[test]
fn an_unwritable_sync_state_prevents_the_delete_request() {
    // Л6, Л7: if the application cannot safely persist the stopped state, it must not send a
    // server DELETE. A newer state schema is the public storage failure boundary used here.
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("State write refusal"));
    let vault = TempVault::new("delete-state-refused");
    let paths = seed_local_files(&vault);
    let expected = snapshot(&vault, &paths);
    let space_id = enable_new(&env, &pc, &vault, "State refusal");

    let state = rusqlite::Connection::open(state_path(&vault.root)).unwrap();
    state.pragma_update(None, "user_version", 999u32).unwrap();
    drop(state);

    let error = run(&env, pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD)).unwrap_err();
    assert_eq!(error.code, "state_newer");
    assert!(server_has_space(&env, &space_id), "DELETE was not sent");
    assert_snapshot(&vault, &expected);
}

#[test]
fn another_device_keeps_all_local_files_after_the_space_is_deleted() {
    // Л7, Л8: another device preserves its own notes, attachments and durable local data when
    // the shared server copy disappears.
    let env = Env::new();
    let first = computer(&env, &env.account);
    let first_vault = TempVault::new("delete-other-device-a");
    let space_id = enable_new(&env, &first, &first_vault, "Two devices");

    let second = computer(&env, &env.another_computer("Other device"));
    let second_vault = TempVault::new("delete-other-device-b");
    run(
        &env,
        second.runtime.enable(
            &second_vault.root,
            SpaceTarget::Existing {
                space_id: space_id.clone(),
            },
            true,
        ),
    )
    .unwrap();
    let paths = seed_local_files(&second_vault);
    let expected = snapshot(&second_vault, &paths);
    let before_baseline = second.recorder.passes_started();
    second.runtime.sync_now().unwrap();
    wait_for_completed_pass_after(&second, before_baseline);
    let baseline_passes = second.recorder.passes_started();

    let result = run(
        &env,
        first.runtime.delete_space(&space_id, ACCOUNT_PASSWORD),
    );
    assert!(
        result.is_ok(),
        "confirmed deletion must succeed: {result:?}"
    );

    // Trigger the other device's next pass; a missing server space is not permission to remove
    // or rewrite local files.
    second.runtime.sync_now().unwrap();
    wait_for_terminal_pass_after(&second, baseline_passes);
    assert_snapshot(&second_vault, &expected);
    assert!(!second.runtime.status().enabled);
    assert_eq!(
        SqliteStateStore::open(&second_vault.root)
            .unwrap()
            .meta(META_ENABLED)
            .unwrap()
            .as_deref(),
        Some("0")
    );

    second.runtime.deactivate_vault();
    let restarted = computer(&env, &env.another_computer("Other device restart"));
    let status = run(&env, restarted.runtime.activate_vault(&second_vault.root)).unwrap();
    assert!(!status.enabled);
    assert_eq!(status.phase, SyncPhase::Off);
    assert!(!server_has_space(&env, &space_id));
    assert_snapshot(&second_vault, &expected);
}
