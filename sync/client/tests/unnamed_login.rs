//! The first sign-in without a temporary device name (appendix М, М4–М7).
//!
//! The happy paths run through a recording proxy in front of the real in-process server, so the
//! request log (method, path, body) and the final state of the account are both checked with
//! real cryptography. The failure paths make the proxy answer instead of the server.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::sync::{Arc, Mutex};

use amby_sync_client::ServerUrl;
use amby_sync_client::{
    enroll_prepared, list_devices, prepare_account, recover_account, sign_in, ClientError,
    Connected, SyncClient,
};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::account::{
    derive_password_keys, derive_recovery_keys, unwrap_account_key,
};
use amby_sync_core::crypto::name::open_device_name;
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use common::{client_of, Canned, PASSWORD};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const NEW_PASSWORD: &str = "another long pass phrase 7";

// ---------------------------------------------------------------- the recording proxy

/// What the proxy saw and what it answered, in order.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    target: String,
    bearer: Option<String>,
    body: Value,
    status: u16,
    answer: Value,
}

impl Seen {
    fn call(&self) -> String {
        format!("{} {}", self.method, self.target)
    }

    /// Whether the request carries no device name at all (М1).
    fn has_no_name(&self) -> bool {
        self.body
            .get("device")
            .is_none_or(|device| device.get("name_enc").is_none())
    }

    /// The sealed name of the request, bytes.
    fn name_enc(&self) -> Vec<u8> {
        hex::decode(
            self.body["device"]["name_enc"]
                .as_str()
                .expect("no name_enc"),
        )
        .unwrap()
    }
}

/// What the proxy does with a request.
enum Action {
    /// Send it to the real server and relay the answer.
    Forward,
    /// Answer instead of the server (nothing reaches it).
    Reply(Canned),
    /// Forward, and let `fn` change the JSON of a successful answer.
    Tamper(fn(&mut Value)),
}

struct Proxy {
    url: String,
    log: Arc<Mutex<Vec<Seen>>>,
}

type Rule = dyn Fn(&Seen) -> Action + Send + Sync;

impl Proxy {
    async fn start(
        target: &Target,
        rule: impl Fn(&Seen) -> Action + Send + Sync + 'static,
    ) -> Self {
        let upstream = target.api.base().to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let rule: Arc<Rule> = Arc::new(rule);
        let (saved, http) = (log.clone(), reqwest::Client::new());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let (saved, http, rule, upstream) =
                    (saved.clone(), http.clone(), rule.clone(), upstream.clone());
                tokio::spawn(async move {
                    serve(stream, &upstream, &http, &*rule, &saved).await;
                });
            }
        });
        Self { url, log }
    }

    fn client(&self) -> SyncClient {
        SyncClient::new(&ServerUrl::parse(&self.url, true).unwrap()).unwrap()
    }

    fn seen(&self) -> Vec<Seen> {
        self.log.lock().unwrap().clone()
    }

    fn calls(&self) -> Vec<String> {
        self.seen().iter().map(Seen::call).collect()
    }

    /// The requests whose `METHOD path` is exactly `call`.
    fn of(&self, call: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|seen| seen.call() == call)
            .collect()
    }
}

async fn serve(
    mut stream: TcpStream,
    upstream: &str,
    http: &reqwest::Client,
    rule: &Rule,
    log: &Mutex<Vec<Seen>>,
) {
    let (method, target, bearer, raw_body) = read_request(&mut stream).await;
    let body = serde_json::from_slice(&raw_body).unwrap_or(Value::Null);
    let mut seen = Seen {
        method: method.clone(),
        target: target.clone(),
        bearer: bearer.clone(),
        body,
        status: 0,
        answer: Value::Null,
    };
    let (status, text, headers) = match rule(&seen) {
        Action::Reply(canned) => (canned.status, canned.body, canned.headers),
        action => {
            let mut request = http.request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{upstream}{target}"),
            );
            if let Some(token) = &bearer {
                request = request.bearer_auth(token);
            }
            if !raw_body.is_empty() {
                request = request
                    .header("content-type", "application/json")
                    .body(raw_body);
            }
            let response = request
                .send()
                .await
                .expect("the real server is unreachable");
            let status = response.status().as_u16();
            let mut text = response.text().await.unwrap();
            if let (Action::Tamper(change), true) = (action, status < 300) {
                let mut value: Value = serde_json::from_str(&text).unwrap();
                change(&mut value);
                text = value.to_string();
            }
            (
                status,
                text,
                vec![("Content-Type", "application/json".to_string())],
            )
        }
    };
    seen.status = status;
    seen.answer = serde_json::from_str(&text).unwrap_or(Value::Null);
    log.lock().unwrap().push(seen);
    let mut response = format!(
        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
        text.len()
    );
    for (name, value) in &headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(&text);
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Method, target, bearer token and body of one request.
async fn read_request(stream: &mut TcpStream) -> (String, String, Option<String>, Vec<u8>) {
    let mut bytes = Vec::new();
    let head_end = loop {
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk).await.unwrap();
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(at) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break at + 4;
        }
        assert!(count > 0, "the connection closed inside a request head");
    };
    let head = String::from_utf8_lossy(&bytes[..head_end - 4]).into_owned();
    let declared = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < head_end + declared {
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk).await.unwrap();
        assert!(count > 0, "the connection closed inside a request body");
        bytes.extend_from_slice(&chunk[..count]);
    }
    let mut first = head.lines().next().unwrap_or_default().split_whitespace();
    let method = first.next().unwrap_or_default().to_string();
    let target = first.next().unwrap_or_default().to_string();
    let bearer = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then(|| value.trim().strip_prefix("Bearer ").map(str::to_string))
            .flatten()
    });
    (
        method,
        target,
        bearer,
        bytes[head_end..head_end + declared].to_vec(),
    )
}

// ---------------------------------------------------------------- helpers

/// An account with its first device "Mac A", made the way the application does it.
async fn first_device(target: &Target) -> (String, Connected, RecoveryCode) {
    let ticket = target.new_ticket();
    let prepared = prepare_account(&ticket.username, &ticket.enroll_code, PASSWORD)
        .await
        .unwrap();
    let code = prepared.recovery_code().clone();
    let connected = enroll_prepared(&client_of(target), &prepared, "Mac A")
        .await
        .unwrap();
    (ticket.username, connected, code)
}

/// The names of the devices of the account, in the order of the list, read from the real server.
async fn names_on_server(target: &Target, owner: &Connected) -> Vec<Option<String>> {
    list_devices(&client_of(target), &owner.session.token, &owner.account_key)
        .await
        .unwrap()
        .into_iter()
        .map(|device| device.name)
        .collect()
}

fn some(names: &[&str]) -> Vec<Option<String>> {
    names.iter().map(|name| Some(name.to_string())).collect()
}

fn device_path(id: &str) -> String {
    format!("/v1/devices/{id}")
}

fn api_error(error: &ClientError) -> (u16, &str) {
    match error {
        ClientError::Api { status, code, .. } => (*status, code.as_str()),
        other => panic!("expected an API error, got {other:?}"),
    }
}

fn is_unnamed_login(seen: &Seen) -> bool {
    seen.call() == "POST /v1/auth/login" && seen.has_no_name()
}

fn is_unnamed_recover(seen: &Seen) -> bool {
    seen.call() == "POST /v1/auth/recover" && seen.has_no_name()
}

fn is_old_server(seen: &Seen, path: &str) -> bool {
    seen.call() == format!("POST {path}") && seen.has_no_name()
}

fn old_server_answer() -> Canned {
    Canned::json(
        400,
        r#"{"error":{"code":"bad_request","message":"`name_enc` is missing or malformed","details":{}}}"#,
    )
}

fn broken_wrapped_ak(value: &mut Value) {
    for field in ["wrapped_ak", "wrapped_ak_recovery"] {
        if let Some(text) = value.get(field).and_then(Value::as_str) {
            let flipped = if text.starts_with('0') { "1" } else { "0" };
            value[field] = Value::String(format!("{flipped}{}", &text[1..]));
        }
    }
}

// ---------------------------------------------------------------- М4: sign_in

#[tokio::test]
async fn sign_in_makes_one_unnamed_login_then_one_rename_and_no_delete() {
    // М4: exactly one login without a name, then PUT of the real name to this device, no DELETE.
    let target = Target::from_env();
    let (username, owner, _) = first_device(&target).await;
    let proxy = Proxy::start(&target, |_| Action::Forward).await;

    let laptop = sign_in(&proxy.client(), &username, PASSWORD, "Laptop")
        .await
        .unwrap();

    let id = laptop.session.device_id.clone();
    assert_eq!(
        proxy.calls(),
        vec![
            "POST /v1/auth/prelogin".to_string(),
            "POST /v1/auth/login".to_string(),
            format!("PUT {}", device_path(&id)),
        ],
        "М4: one login, one rename, nothing else (no second login, no DELETE)"
    );
    let login = &proxy.of("POST /v1/auth/login")[0];
    assert!(
        login.has_no_name(),
        "М4: the login carries no name: {}",
        login.body
    );
    assert_eq!(login.answer["device_id"], id.as_str());
    let rename = &proxy.of(&format!("PUT {}", device_path(&id)))[0];
    assert_eq!(rename.status, 204);
    assert_eq!(
        rename.bearer.as_deref(),
        Some(login.answer["token"].as_str().unwrap()),
        "М4: the rename is made by the new device with its own token"
    );
    assert_eq!(
        open_device_name(&laptop.account_key, &rename.name_enc()).unwrap(),
        "Laptop"
    );
    // The account keeps exactly the first device and the new one, under the real name.
    assert_eq!(
        names_on_server(&target, &owner).await,
        some(&["Mac A", "Laptop"])
    );
    assert_eq!(laptop.account_key.as_bytes(), owner.account_key.as_bytes());
}

#[tokio::test]
async fn sign_in_without_a_proxy_leaves_one_new_device_with_the_real_name() {
    // М4 (guard, expected green): the end state does not change for the person.
    let target = Target::from_env();
    let (username, owner, _) = first_device(&target).await;
    let client = client_of(&target);
    let laptop = sign_in(&client, &username, PASSWORD, "Laptop")
        .await
        .unwrap();
    let devices = list_devices(&client, &laptop.session.token, &laptop.account_key)
        .await
        .unwrap();
    assert_eq!(devices.len(), 2);
    assert_eq!(devices[0].device_id, owner.session.device_id);
    assert_eq!(devices[1].device_id, laptop.session.device_id);
    assert_eq!(devices[1].name.as_deref(), Some("Laptop"));
    assert!(devices[1].current);
}

#[tokio::test]
async fn a_refused_name_disconnects_the_new_device_and_returns_the_error() {
    // М4: the rename fails (500) → that device is disconnected, the error keeps its code, and
    // nothing but this one device was ever made.
    let target = Target::from_env();
    let (username, owner, _) = first_device(&target).await;
    let proxy = Proxy::start(&target, |seen| {
        if seen.method == "PUT" && seen.target.starts_with("/v1/devices/") {
            Action::Reply(Canned::json(
                500,
                r#"{"error":{"code":"internal","message":"x","details":{}}}"#,
            ))
        } else {
            Action::Forward
        }
    })
    .await;

    let error = sign_in(&proxy.client(), &username, PASSWORD, "Laptop")
        .await
        .unwrap_err();

    assert_eq!(api_error(&error), (500, "internal"), "М4: the code is kept");
    let logins = proxy.of("POST /v1/auth/login");
    assert_eq!(logins.len(), 1, "М4: exactly one login");
    assert!(logins[0].has_no_name());
    let id = logins[0].answer["device_id"].as_str().unwrap().to_string();
    assert_eq!(
        proxy.calls(),
        vec![
            "POST /v1/auth/prelogin".to_string(),
            "POST /v1/auth/login".to_string(),
            format!("PUT {}", device_path(&id)),
            format!("DELETE {}", device_path(&id)),
        ]
    );
    assert_eq!(
        proxy.of(&format!("DELETE {}", device_path(&id)))[0].status,
        204
    );
    assert_eq!(
        names_on_server(&target, &owner).await,
        some(&["Mac A"]),
        "М4: no device of this sign-in stays"
    );
}

#[tokio::test]
async fn an_unreadable_key_disconnects_the_new_device_with_cannot_decrypt() {
    // М4: AK does not open → DELETE of the only device made, `cannot_decrypt`, no rename.
    let target = Target::from_env();
    let (username, owner, _) = first_device(&target).await;
    let proxy = Proxy::start(&target, |seen| {
        if is_unnamed_login(seen) {
            Action::Tamper(broken_wrapped_ak)
        } else {
            Action::Forward
        }
    })
    .await;

    let error = sign_in(&proxy.client(), &username, PASSWORD, "Laptop")
        .await
        .unwrap_err();

    assert!(matches!(error, ClientError::CannotDecrypt), "{error:?}");
    let logins = proxy.of("POST /v1/auth/login");
    assert_eq!(logins.len(), 1, "М4: exactly one login");
    assert!(logins[0].has_no_name());
    let id = logins[0].answer["device_id"].as_str().unwrap().to_string();
    assert_eq!(
        proxy.calls(),
        vec![
            "POST /v1/auth/prelogin".to_string(),
            "POST /v1/auth/login".to_string(),
            format!("DELETE {}", device_path(&id)),
        ]
    );
    assert_eq!(names_on_server(&target, &owner).await, some(&["Mac A"]));
}

// ---------------------------------------------------------------- М5: recover_account

#[tokio::test]
async fn recovery_makes_one_unnamed_recover_then_keys_then_one_rename_and_no_delete() {
    // М5: one recover without a name, PUT /v1/keys (new password), PUT of the name, no DELETE.
    let target = Target::from_env();
    let (username, owner, code) = first_device(&target).await;
    let proxy = Proxy::start(&target, |_| Action::Forward).await;

    let laptop = recover_account(&proxy.client(), &username, &code, NEW_PASSWORD, "Laptop")
        .await
        .unwrap();

    let id = laptop.session.device_id.clone();
    assert_eq!(
        proxy.calls(),
        vec![
            "POST /v1/auth/recover".to_string(),
            "PUT /v1/keys".to_string(),
            format!("PUT {}", device_path(&id)),
        ],
        "М5: one recover, the new password, one rename, no DELETE"
    );
    let recover = &proxy.of("POST /v1/auth/recover")[0];
    assert!(
        recover.has_no_name(),
        "М5: no name in recover: {}",
        recover.body
    );
    assert_eq!(recover.answer["device_id"], id.as_str());
    let token = recover.answer["token"].as_str().unwrap();
    assert_eq!(proxy.of("PUT /v1/keys")[0].bearer.as_deref(), Some(token));
    let rename = &proxy.of(&format!("PUT {}", device_path(&id)))[0];
    assert_eq!(rename.status, 204);
    assert_eq!(rename.bearer.as_deref(), Some(token));
    assert_eq!(
        open_device_name(&laptop.account_key, &rename.name_enc()).unwrap(),
        "Laptop"
    );
    assert_eq!(
        names_on_server(&target, &owner).await,
        some(&["Mac A", "Laptop"])
    );
    // The new password works and the old one does not.
    sign_in(&client_of(&target), &username, NEW_PASSWORD, "Phone")
        .await
        .unwrap();
    let old = sign_in(&client_of(&target), &username, PASSWORD, "Phone")
        .await
        .unwrap_err();
    assert_eq!(api_error(&old), (401, "invalid_credentials"));
}

#[tokio::test]
async fn a_failed_keys_step_disconnects_the_recovered_device() {
    // М5: PUT /v1/keys fails (500) → the one device made by `recover` is disconnected, no rename.
    let target = Target::from_env();
    let (username, owner, code) = first_device(&target).await;
    let proxy = Proxy::start(&target, |seen| {
        if seen.call() == "PUT /v1/keys" {
            Action::Reply(Canned::json(
                500,
                r#"{"error":{"code":"internal","message":"x","details":{}}}"#,
            ))
        } else {
            Action::Forward
        }
    })
    .await;

    let error = recover_account(&proxy.client(), &username, &code, NEW_PASSWORD, "Laptop")
        .await
        .unwrap_err();

    assert_eq!(api_error(&error), (500, "internal"));
    let recovers = proxy.of("POST /v1/auth/recover");
    assert_eq!(recovers.len(), 1, "М5: exactly one recover");
    assert!(recovers[0].has_no_name());
    let id = recovers[0].answer["device_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        proxy.calls(),
        vec![
            "POST /v1/auth/recover".to_string(),
            "PUT /v1/keys".to_string(),
            format!("DELETE {}", device_path(&id)),
        ]
    );
    assert_eq!(names_on_server(&target, &owner).await, some(&["Mac A"]));
}

#[tokio::test]
async fn a_failed_name_step_disconnects_the_recovered_device() {
    // М5: the password is already changed, the rename fails (500) → the device is disconnected.
    let target = Target::from_env();
    let (username, owner, code) = first_device(&target).await;
    let proxy = Proxy::start(&target, |seen| {
        if seen.method == "PUT" && seen.target.starts_with("/v1/devices/") {
            Action::Reply(Canned::json(
                500,
                r#"{"error":{"code":"internal","message":"x","details":{}}}"#,
            ))
        } else {
            Action::Forward
        }
    })
    .await;

    let error = recover_account(&proxy.client(), &username, &code, NEW_PASSWORD, "Laptop")
        .await
        .unwrap_err();

    assert_eq!(api_error(&error), (500, "internal"));
    let recovers = proxy.of("POST /v1/auth/recover");
    assert_eq!(recovers.len(), 1, "М5: exactly one recover");
    let id = recovers[0].answer["device_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        proxy.calls(),
        vec![
            "POST /v1/auth/recover".to_string(),
            "PUT /v1/keys".to_string(),
            format!("PUT {}", device_path(&id)),
            format!("DELETE {}", device_path(&id)),
        ]
    );
    assert_eq!(names_on_server(&target, &owner).await, some(&["Mac A"]));
}

#[tokio::test]
async fn an_unreadable_recovery_key_disconnects_the_recovered_device() {
    // М5: the recovery copy of AK does not open → DELETE, `cannot_decrypt`, no password change.
    let target = Target::from_env();
    let (username, owner, code) = first_device(&target).await;
    let proxy = Proxy::start(&target, |seen| {
        if is_unnamed_recover(seen) {
            Action::Tamper(broken_wrapped_ak)
        } else {
            Action::Forward
        }
    })
    .await;

    let error = recover_account(&proxy.client(), &username, &code, NEW_PASSWORD, "Laptop")
        .await
        .unwrap_err();

    assert!(matches!(error, ClientError::CannotDecrypt), "{error:?}");
    let recovers = proxy.of("POST /v1/auth/recover");
    assert_eq!(recovers.len(), 1, "М5: exactly one recover");
    assert!(recovers[0].has_no_name());
    let id = recovers[0].answer["device_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        proxy.calls(),
        vec![
            "POST /v1/auth/recover".to_string(),
            format!("DELETE {}", device_path(&id)),
        ]
    );
    assert_eq!(names_on_server(&target, &owner).await, some(&["Mac A"]));
}

// ---------------------------------------------------------------- М6: old servers

#[tokio::test]
async fn an_old_server_that_wants_a_name_gets_the_old_path_on_sign_in() {
    // М6: `400 bad_request` on the login without a name → the client repeats the old way
    // (temporary name → AK → login under the real name → the temporary device is disconnected)
    // and succeeds; the first request is the unnamed one, the rest carry names.
    let target = Target::from_env();
    let (username, owner, _) = first_device(&target).await;
    let proxy = Proxy::start(&target, |seen| {
        if is_old_server(seen, "/v1/auth/login") {
            Action::Reply(old_server_answer())
        } else {
            Action::Forward
        }
    })
    .await;

    let laptop = sign_in(&proxy.client(), &username, PASSWORD, "Laptop")
        .await
        .unwrap();

    let logins = proxy.of("POST /v1/auth/login");
    assert_eq!(logins.len(), 3, "М6: unnamed (refused), temporary, real");
    assert!(logins[0].has_no_name(), "М6: the unnamed one goes first");
    assert_eq!(logins[0].status, 400);
    assert!(!logins[1].has_no_name() && !logins[2].has_no_name());
    let real = open_device_name(&laptop.account_key, &logins[2].name_enc()).unwrap();
    assert_eq!(real, "Laptop");
    let temporary = logins[1].answer["device_id"].as_str().unwrap().to_string();
    assert_eq!(
        proxy
            .of(&format!("DELETE {}", device_path(&temporary)))
            .len(),
        1
    );
    assert_eq!(
        logins[2].answer["device_id"],
        laptop.session.device_id.as_str()
    );
    assert!(
        proxy
            .seen()
            .iter()
            .all(|seen| !(seen.method == "PUT" && seen.target.starts_with("/v1/devices/"))),
        "М6: the old path sets the name at login, never with a rename"
    );
    assert_eq!(
        names_on_server(&target, &owner).await,
        some(&["Mac A", "Laptop"])
    );
}

#[tokio::test]
async fn an_old_server_that_wants_a_name_gets_the_old_path_on_recovery() {
    // М6 for `recover`: the same fallback; the password still changes and one device stays.
    let target = Target::from_env();
    let (username, owner, code) = first_device(&target).await;
    let proxy = Proxy::start(&target, |seen| {
        if is_old_server(seen, "/v1/auth/recover") {
            Action::Reply(old_server_answer())
        } else {
            Action::Forward
        }
    })
    .await;

    let laptop = recover_account(&proxy.client(), &username, &code, NEW_PASSWORD, "Laptop")
        .await
        .unwrap();

    let recovers = proxy.of("POST /v1/auth/recover");
    assert!(
        recovers.len() >= 2,
        "М6: the unnamed one is refused, named ones follow"
    );
    assert!(recovers[0].has_no_name(), "М6: the unnamed one goes first");
    assert_eq!(recovers[0].status, 400);
    assert!(recovers[1..].iter().all(|seen| !seen.has_no_name()));
    assert_eq!(proxy.of("PUT /v1/keys").len(), 1);
    assert!(
        proxy
            .seen()
            .iter()
            .all(|seen| !(seen.method == "PUT" && seen.target.starts_with("/v1/devices/"))),
        "М6: the old path sets the name at recover, never with a rename"
    );
    assert_eq!(
        names_on_server(&target, &owner).await,
        some(&["Mac A", "Laptop"])
    );
    assert_eq!(
        names_on_server(&target, &laptop).await,
        some(&["Mac A", "Laptop"])
    );
    sign_in(&client_of(&target), &username, NEW_PASSWORD, "Phone")
        .await
        .unwrap();
}

#[tokio::test]
async fn other_answers_to_the_unnamed_login_are_not_retried() {
    // М6: 401 (and 429, 500) do not change the path: exactly one login request, no DELETE, no
    // rename; the error reaches the caller as it is. The one request has no name.
    let target = Target::from_env();
    let (username, _, _) = first_device(&target).await;
    for (status, code) in [
        (401, "invalid_credentials"),
        (429, "rate_limited"),
        (500, "internal"),
    ] {
        let body = format!(r#"{{"error":{{"code":"{code}","message":"x","details":{{}}}}}}"#);
        let proxy = Proxy::start(&target, move |seen| {
            if seen.call() == "POST /v1/auth/login" {
                Action::Reply(Canned::json(status, &body))
            } else {
                Action::Forward
            }
        })
        .await;

        let error = sign_in(&proxy.client(), &username, PASSWORD, "Laptop")
            .await
            .unwrap_err();

        assert_eq!(api_error(&error), (status, code));
        let logins = proxy.of("POST /v1/auth/login");
        assert_eq!(logins.len(), 1, "М6: {status} is not retried");
        assert!(
            logins[0].has_no_name(),
            "М4: the one login has no name: {}",
            logins[0].body
        );
        assert_eq!(
            proxy.calls(),
            vec!["POST /v1/auth/prelogin", "POST /v1/auth/login"]
        );
    }
}

#[tokio::test]
async fn other_answers_to_the_unnamed_recover_are_not_retried() {
    // М6 for `recover`.
    let target = Target::from_env();
    let (username, _, code) = first_device(&target).await;
    for (status, error_code) in [(401, "invalid_credentials"), (429, "rate_limited")] {
        let body = format!(r#"{{"error":{{"code":"{error_code}","message":"x","details":{{}}}}}}"#);
        let proxy = Proxy::start(&target, move |seen| {
            if seen.call() == "POST /v1/auth/recover" {
                Action::Reply(Canned::json(status, &body))
            } else {
                Action::Forward
            }
        })
        .await;

        let error = recover_account(&proxy.client(), &username, &code, NEW_PASSWORD, "Laptop")
            .await
            .unwrap_err();

        assert_eq!(api_error(&error), (status, error_code));
        let recovers = proxy.of("POST /v1/auth/recover");
        assert_eq!(recovers.len(), 1, "М6: {status} is not retried");
        assert!(recovers[0].has_no_name(), "М5: the one recover has no name");
        assert_eq!(proxy.calls(), vec!["POST /v1/auth/recover"]);
    }
}

// ---------------------------------------------------------------- М7: the two new calls

#[tokio::test]
async fn login_unnamed_sends_no_device_and_parses_the_answer() {
    // М7, М1: the request has no `device`; the answer is read like that of `login`.
    let target = Target::from_env();
    let (username, owner, _) = first_device(&target).await;
    let proxy = Proxy::start(&target, |_| Action::Forward).await;
    let client = proxy.client();
    let pre = client.prelogin(&username).await.unwrap();
    let keys = derive_password_keys(PASSWORD, &pre.salt, &pre.params).unwrap();

    let answer = client
        .login_unnamed(&username, &keys.auth_key)
        .await
        .unwrap();

    let login = &proxy.of("POST /v1/auth/login")[0];
    assert!(
        login.has_no_name(),
        "М7: no name in the request: {}",
        login.body
    );
    assert_eq!(
        login.body["auth_key"],
        hex::encode(keys.auth_key.as_bytes()).as_str()
    );
    assert_eq!(
        answer.session.device_id,
        login.answer["device_id"].as_str().unwrap()
    );
    assert_eq!(answer.salt, pre.salt);
    let ak = unwrap_account_key(&keys.kek, &answer.wrapped_ak).unwrap();
    assert_eq!(ak.as_bytes(), owner.account_key.as_bytes());
    // The new device is in the list with an empty name.
    let entries = client.devices(&answer.session.token).await.unwrap();
    let entry = entries
        .iter()
        .find(|entry| entry.device_id == answer.session.device_id)
        .expect("the new device is not listed");
    assert!(entry.name_enc.is_empty(), "М3: the name is empty");
    assert!(entry.current);
}

#[tokio::test]
async fn recover_unnamed_sends_no_device_and_parses_the_answer() {
    // М7, М1: the same for the recovery code.
    let target = Target::from_env();
    let (username, owner, code) = first_device(&target).await;
    let proxy = Proxy::start(&target, |_| Action::Forward).await;
    let client = proxy.client();
    let keys = derive_recovery_keys(&code);

    let answer = client
        .recover_unnamed(&username, &keys.auth_key)
        .await
        .unwrap();

    let recover = &proxy.of("POST /v1/auth/recover")[0];
    assert!(
        recover.has_no_name(),
        "М7: no name in the request: {}",
        recover.body
    );
    assert_eq!(
        recover.body["recovery_auth_key"],
        hex::encode(keys.auth_key.as_bytes()).as_str()
    );
    assert_eq!(
        answer.session.device_id,
        recover.answer["device_id"].as_str().unwrap()
    );
    let ak = unwrap_account_key(&keys.kek, &answer.wrapped_ak_recovery).unwrap();
    assert_eq!(ak.as_bytes(), owner.account_key.as_bytes());
}
