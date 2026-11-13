//! Client boundary for deleting a server space (appendix Л, Л1, Л2, Л5, Л9).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

use amby_sync_client::{ClientError, DeviceToken};
use amby_sync_conformance::client::enroll;
use amby_sync_conformance::Target;
use amby_sync_core::crypto::keys::AuthKey;
use common::{client_of, Canned, FakeServer, PASSWORD};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A key for the tests whose server is fake: it only has to be sent, nobody checks it.
fn some_key() -> AuthKey {
    AuthKey::from_bytes([7u8; 32])
}

fn token_of(account: &amby_sync_conformance::client::Account) -> DeviceToken {
    DeviceToken::new(account.token.clone())
}

#[tokio::test]
async fn delete_space_uses_the_exact_id_and_owner_token() {
    // Л1, Л9: the client sends DELETE /v1/spaces/{id}; identity is only the bearer token and the
    // opaque id, never an open name or local path.
    let space_id = [0x5au8; 16];
    let (url, request) = start_delete_spy().await;
    let token = DeviceToken::new("ab".repeat(32));

    client_of_url(&url)
        .delete_space(&token, &space_id, &some_key())
        .await
        .unwrap();

    let request = request
        .lock()
        .unwrap()
        .take()
        .expect("the spy saw no request");
    assert_eq!(request.method, "DELETE");
    assert_eq!(
        request.target,
        format!("/v1/spaces/{}", hex::encode(space_id))
    );
    // Ц2 replaces "no body" with the proof body; its exact content is checked in
    // `password_proof_c.rs`. Here: the body names nothing open either.
    let body = String::from_utf8_lossy(&request.body);
    assert!(!body.contains("open name"));
    assert!(!body.contains("/Users/private/vault"));
    assert!(request
        .headers
        .to_ascii_lowercase()
        .contains(&format!("authorization: bearer {}", "ab".repeat(32))));
    assert!(!request.headers.contains("open name"));
    assert!(!request.headers.contains("/Users/private/vault"));
}

#[tokio::test]
async fn delete_space_preserves_unauthorized_and_foreign_not_found_codes() {
    // Л2: authentication and ownership errors remain machine errors for the application.
    let target = Target::from_env();
    let owner = enroll(&target, PASSWORD);
    let foreign = enroll(&target, PASSWORD);
    let space = owner.create_space();
    let client = client_of(&target);

    let unauthorized = client
        .delete_space(
            &DeviceToken::new("00".repeat(32)),
            space.id.as_bytes(),
            &owner.password_auth_key(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        unauthorized,
        ClientError::Api {
            status: 401,
            ref code,
            ..
        } if code == "unauthorized"
    ));

    let not_found = client
        .delete_space(
            &token_of(&foreign),
            space.id.as_bytes(),
            &foreign.password_auth_key(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        not_found,
        ClientError::Api {
            status: 404,
            ref code,
            ..
        } if code == "not_found"
    ));
}

#[tokio::test]
async fn repeating_delete_returns_not_found_instead_of_success() {
    // Л5: a retry after a lost success is safe, but the second answer is still an error and is not
    // silently converted to Ok.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let client = client_of(&target);
    let token = token_of(&account);

    // The first call must meet the tests-first server/client stubs and expect their real contract.
    let key = account.password_auth_key();
    client
        .delete_space(&token, space.id.as_bytes(), &key)
        .await
        .unwrap();
    let error = client
        .delete_space(&token, space.id.as_bytes(), &key)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ClientError::Api {
            status: 404,
            ref code,
            ..
        } if code == "not_found"
    ));
}

#[tokio::test]
async fn delete_space_does_not_turn_server_errors_into_success() {
    // Л5: 404/405 and an internal failure retain both status and machine code.
    for (status, code) in [
        (404, "not_found"),
        (405, "method_not_allowed"),
        (500, "internal"),
    ] {
        let body = format!(r#"{{"error":{{"code":"{code}","message":"ignored","details":{{}}}}}}"#);
        let server = FakeServer::start(move |_| Canned::json(status, &body)).await;
        let error = server
            .client()
            .delete_space(&DeviceToken::new("cd".repeat(32)), &[0x11; 16], &some_key())
            .await
            .unwrap_err();
        match error {
            ClientError::Api {
                status: actual_status,
                code: actual_code,
                ..
            } => assert_eq!((actual_status, actual_code.as_str()), (status, code)),
            other => panic!("expected an API error, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_lost_delete_answer_is_not_treated_as_success_and_retry_keeps_404() {
    // Л5: the server applies the first DELETE but closes before answering; the transport error is
    // not converted to Ok, and an explicit retry still exposes the server's 404 to the runtime.
    let (url, requests) = start_lost_delete_server().await;
    let client = client_of_url(&url);
    let token = DeviceToken::new("ef".repeat(32));
    let space_id = [0x22u8; 16];

    let first = client
        .delete_space(&token, &space_id, &some_key())
        .await
        .unwrap_err();
    assert!(
        matches!(first, ClientError::Network | ClientError::Timeout),
        "lost response must remain a transport error, got {first:?}"
    );
    let second = client
        .delete_space(&token, &space_id, &some_key())
        .await
        .unwrap_err();
    assert!(matches!(
        second,
        ClientError::Api {
            status: 404,
            ref code,
            ..
        } if code == "not_found"
    ));
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[derive(Debug)]
struct ObservedRequest {
    method: String,
    target: String,
    headers: String,
    body: Vec<u8>,
}

fn client_of_url(url: &str) -> amby_sync_client::SyncClient {
    let parsed = amby_sync_client::ServerUrl::parse(url, true).unwrap();
    amby_sync_client::SyncClient::new(&parsed).unwrap()
}

async fn start_delete_spy() -> (String, Arc<Mutex<Option<ObservedRequest>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let request = Arc::new(Mutex::new(None));
    let saved = request.clone();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let observed = read_request(&mut stream).await;
        *saved.lock().unwrap() = Some(observed);
        write_json(&mut stream, 200, r#"{"ok":true}"#).await;
    });
    (url, request)
}

async fn start_lost_delete_server() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    tokio::spawn(async move {
        for index in 0..2 {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let observed = read_request(&mut stream).await;
            assert_eq!(observed.method, "DELETE");
            seen.fetch_add(1, Ordering::SeqCst);
            if index == 1 {
                write_json(
                    &mut stream,
                    404,
                    r#"{"error":{"code":"not_found","message":"gone","details":{}}}"#,
                )
                .await;
            }
            // The first request is the applied-but-lost response: dropping the stream closes it
            // without an HTTP answer.
        }
    });
    (url, requests)
}

async fn read_request(stream: &mut TcpStream) -> ObservedRequest {
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            break bytes
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| position + 4)
                .unwrap_or(bytes.len());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let header_text = String::from_utf8_lossy(&bytes[..header_end.saturating_sub(4)]).into_owned();
    let content_length = header_text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().unwrap())
    });
    let declared = content_length.unwrap_or(0);
    let already = bytes.len().saturating_sub(header_end);
    if declared > already {
        let mut rest = vec![0u8; declared - already];
        stream.read_exact(&mut rest).await.unwrap();
        bytes.extend_from_slice(&rest);
    }
    // Include unexpected trailing bytes even when a peer lies with `Content-Length: 0`: the
    // caller's no-body assertion must inspect the wire, not merely trust that header.
    let body_len = declared.max(already);
    let request_line = header_text.lines().next().unwrap_or_default();
    let method = request_line
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    let target = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    ObservedRequest {
        method,
        target,
        headers: header_text,
        body: bytes[header_end..header_end + body_len].to_vec(),
    }
}

async fn write_json(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
}
