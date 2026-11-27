//! Helpers shared by the client tests: a client for the server under test and a tiny fake server
//! for what a real server never does (redirects, garbage, hostile parameters).
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};

use amby_sync_client::{ServerUrl, SyncClient};
use amby_sync_conformance::Target;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[allow(unused_imports)]
pub use amby_sync_conformance::client::PASSWORD;

/// A client of the server under test. `allow_http` is on so that the tests also run against a
/// container on another address (`AMBY_SYNC_URL`).
pub fn client_of(target: &Target) -> SyncClient {
    let url =
        ServerUrl::parse(target.api.base(), true).expect("the test server has a good address");
    SyncClient::new(&url).expect("cannot build the client")
}

/// A canned answer of the fake server.
#[derive(Clone)]
pub struct Canned {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

impl Canned {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", "application/json".to_string())],
            body: body.to_string(),
        }
    }

    pub fn html(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", "text/html".to_string())],
            body: body.to_string(),
        }
    }

    pub fn with_header(mut self, name: &'static str, value: &str) -> Self {
        self.headers.push((name, value.to_string()));
        self
    }
}

/// A server on a free local port that answers every request with what `answer` says for the
/// request path, and remembers `METHOD path` of every request it received.
pub struct FakeServer {
    pub url: String,
    pub seen: Arc<Mutex<Vec<String>>>,
    /// The whole head (request line and headers) of every request, lower-cased.
    pub heads: Arc<Mutex<Vec<String>>>,
}

impl FakeServer {
    pub async fn start(answer: impl Fn(&str) -> Canned + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let heads = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let head_log = heads.clone();
        let answer = Arc::new(answer);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let log = log.clone();
                let head_log = head_log.clone();
                let answer = answer.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 16 * 1024];
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
                    let method = parts.next().unwrap_or_default().to_string();
                    let path = parts.next().unwrap_or_default().to_string();
                    log.lock().unwrap().push(format!("{method} {path}"));
                    head_log.lock().unwrap().push(head.to_ascii_lowercase());
                    let canned = answer(&path);
                    let mut response = format!(
                        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                        canned.status,
                        canned.body.len()
                    );
                    for (name, value) in &canned.headers {
                        response.push_str(&format!("{name}: {value}\r\n"));
                    }
                    response.push_str("\r\n");
                    response.push_str(&canned.body);
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Self { url, seen, heads }
    }

    pub fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }

    pub fn client(&self) -> SyncClient {
        SyncClient::new(&ServerUrl::parse(&self.url, true).unwrap()).unwrap()
    }
}
