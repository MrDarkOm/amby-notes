//! The proof of the current password for dangerous actions (appendix Ц, Ц2).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::sync::{Arc, Mutex};

use amby_sync_client::flows::password_proof;
use amby_sync_client::{ClientError, DeviceToken};
use amby_sync_conformance::client::enroll;
use amby_sync_conformance::Target;
use common::{Canned, FakeServer, PASSWORD};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A fake server that answers `GET /v1/keys` with the real keys of a real account and refuses
/// everything else, so that any further request shows up in the log.
async fn keys_server(target: &Target) -> (FakeServer, amby_sync_conformance::client::Account) {
    let account = enroll(target, PASSWORD);
    let keys = account.get("/v1/keys").expect(200).text();
    let server = FakeServer::start(move |path| {
        if path == "/v1/keys" {
            Canned::json(200, &keys)
        } else {
            Canned::json(
                500,
                r#"{"error":{"code":"internal","message":"unexpected","details":{}}}"#,
            )
        }
    })
    .await;
    (server, account)
}

#[tokio::test]
async fn the_right_password_gives_the_auth_key_with_one_read_of_the_keys() {
    // Ц2: the key equals the auth key of the account's password; only `GET /v1/keys` is sent.
    let target = Target::from_env();
    let (server, account) = keys_server(&target).await;
    let token = DeviceToken::new(account.token.clone());

    let key = password_proof(&server.client(), &token, PASSWORD)
        .await
        .unwrap();

    assert_eq!(
        key.as_bytes(),
        account.password_auth_key().as_bytes(),
        "Ц2: the key is the sign-in key of the password"
    );
    assert_eq!(server.requests(), vec!["GET /v1/keys".to_string()]);
}

#[tokio::test]
async fn a_wrong_password_is_invalid_proof_without_any_other_request_or_the_password_in_the_text() {
    // Ц2: a wrong password is `403 invalid_proof` decided on the device (only the keys were
    // read); the password never appears in the error.
    let target = Target::from_env();
    let (server, account) = keys_server(&target).await;
    let token = DeviceToken::new(account.token.clone());
    let wrong = "a quite different pass phrase 99";

    let error = password_proof(&server.client(), &token, wrong)
        .await
        .unwrap_err();

    assert!(
        matches!(
            error,
            ClientError::Api { status: 403, ref code, .. } if code == "invalid_proof"
        ),
        "expected 403 invalid_proof, got {error:?}"
    );
    assert_eq!(server.requests(), vec!["GET /v1/keys".to_string()]);
    for text in [format!("{error}"), format!("{error:?}")] {
        assert!(!text.contains(wrong), "Ц2: the password is in {text:?}");
        assert!(!text.contains(PASSWORD));
    }
}

#[tokio::test]
async fn delete_space_sends_the_key_as_a_json_body() {
    // Ц2: `delete_space` sends `{"auth_key": <hex of the key>}` as a JSON body.
    let (url, seen) = start_spy().await;
    let client =
        amby_sync_client::SyncClient::new(&amby_sync_client::ServerUrl::parse(&url, true).unwrap())
            .unwrap();
    let key = amby_sync_core::crypto::keys::AuthKey::from_bytes([0x3c; 32]);

    client
        .delete_space(&DeviceToken::new("ab".repeat(32)), &[0x5a; 16], &key)
        .await
        .unwrap();

    let (head, body) = seen.lock().unwrap().take().expect("the spy saw nothing");
    let head = head.to_ascii_lowercase();
    assert!(head.starts_with(&format!("delete /v1/spaces/{} ", "5a".repeat(16))));
    assert!(head.contains("content-type: application/json"));
    let body: Value = serde_json::from_slice(&body).expect("the body is not JSON");
    assert_eq!(
        body,
        serde_json::json!({ "auth_key": hex::encode([0x3c; 32]) })
    );
}

/// A server that answers one request with 200 and keeps its head and body.
async fn start_spy() -> (String, Arc<Mutex<Option<(String, Vec<u8>)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(None));
    let saved = seen.clone();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let (head_end, length) = loop {
            let mut chunk = [0u8; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(at) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:")?.trim().parse().ok())
                    .unwrap_or(0usize);
                break (at + 4, length);
            }
            if count == 0 {
                break (bytes.len(), 0);
            }
        };
        while bytes.len() < head_end + length {
            let mut chunk = [0u8; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
        let head = String::from_utf8_lossy(&bytes[..head_end.saturating_sub(4)]).into_owned();
        *saved.lock().unwrap() = Some((head, bytes[head_end.min(bytes.len())..].to_vec()));
        let body = r#"{"ok":true}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (url, seen)
}
