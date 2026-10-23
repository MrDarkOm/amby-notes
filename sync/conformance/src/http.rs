//! A thin blocking HTTP client. It never fails on 4xx and 5xx: the status and the body are what
//! the tests look at. A transport failure (no server, a hung connection) is a panic with a clear
//! text, never a silent pass.

use std::any::Any;
use std::io::{BufRead, BufReader, Read};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

/// One response.
#[derive(Debug, Clone)]
pub struct Resp {
    pub status: u16,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The body as JSON; a body that is not JSON fails the test with the text shown.
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|error| {
            panic!(
                "HTTP {}: the body is not JSON ({error}): {}",
                self.status,
                truncate(&self.text())
            )
        })
    }

    /// `error.code` of an error answer (П4).
    pub fn error_code(&self) -> Option<String> {
        let value: Value = serde_json::from_slice(&self.body).ok()?;
        value["error"]["code"].as_str().map(str::to_string)
    }

    /// `error.details` of an error answer (П4).
    pub fn details(&self) -> Value {
        self.json()["error"]["details"].clone()
    }

    /// Fails the test unless the status is `status`. The failure shows what the server said,
    /// so that a `501 not_implemented` is recognisable as the reason.
    pub fn expect(self, status: u16) -> Resp {
        if self.status != status {
            panic!(
                "expected HTTP {status}, got HTTP {} ({}): {}",
                self.status,
                self.error_code().unwrap_or_else(|| "no error code".into()),
                truncate(&self.text())
            );
        }
        self
    }

    /// Fails the test unless the answer is the error `code` with the HTTP status `status` (П4).
    pub fn expect_error(self, status: u16, code: &str) -> Resp {
        if self.status != status || self.error_code().as_deref() != Some(code) {
            panic!(
                "expected HTTP {status} {code}, got HTTP {} ({}): {}",
                self.status,
                self.error_code().unwrap_or_else(|| "no error code".into()),
                truncate(&self.text())
            );
        }
        self
    }
}

fn truncate(text: &str) -> String {
    let mut shown: String = text.chars().take(300).collect();
    if text.chars().count() > 300 {
        shown.push('…');
    }
    shown
}

/// What a request carries.
pub enum Body {
    None,
    Json(Value),
    Bytes(Vec<u8>),
    /// Raw bytes with an explicit `Content-Type` (or none at all).
    Raw(Vec<u8>, Option<&'static str>),
}

/// The client bound to one base address.
#[derive(Clone)]
pub struct Api {
    base: String,
    agent: ureq::Agent,
    /// The server started in this process, kept running while any client of it exists: a test
    /// may drop its `Target` (for example `fresh_space(&Target::from_env())`) and go on using the
    /// accounts and spaces made from it.
    keep_alive: Option<Arc<dyn Any + Send + Sync>>,
}

impl Api {
    pub fn new(base: &str) -> Self {
        // Connections are kept and reused (stage Э4, carried over from Э3): a connection per
        // request filled the table of ports in TIME_WAIT on macOS and long runs failed on the
        // transport. A clone shares the pool.
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(120))
            .max_idle_connections(64)
            .max_idle_connections_per_host(64)
            .build();
        Self {
            base: base.trim_end_matches('/').to_string(),
            agent,
            keep_alive: None,
        }
    }

    /// The same client, keeping `server` alive as long as any clone of it exists.
    pub fn keeping(mut self, server: Arc<dyn Any + Send + Sync>) -> Self {
        self.keep_alive = Some(server);
        self
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// Sends a request and returns whatever came back.
    #[allow(clippy::result_large_err)]
    pub fn send(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        headers: &[(&str, &str)],
        body: Body,
    ) -> Resp {
        let url = format!("{}{}", self.base, path);
        // A kept connection may have been closed by the server in the meantime; macOS reports
        // that as `Invalid argument` or a reset when the answer is read, and the library does not
        // retry it. Every request of the protocol is safe to repeat (bodies are written by part
        // number, a commit has its `commit_id`, П22, П28), so a transport failure is tried again
        // on another connection a few times before the test fails.
        let mut last = None;
        for attempt in 0..4 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(15 * attempt));
            }
            let mut request = self.agent.request(method, &url);
            if let Some(token) = token {
                request = request.set("Authorization", &format!("Bearer {token}"));
            }
            for (name, value) in headers {
                request = request.set(name, value);
            }
            // The HTTP library can panic (an `expect` while it returns a connection to the pool
            // and the system refuses to reset its timeout, seen on macOS): that is a failure of
            // the transport too, repeated like the others.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &body {
                Body::None => request.call(),
                Body::Json(value) => request
                    .set("Content-Type", "application/json")
                    .send_bytes(value.to_string().as_bytes()),
                Body::Bytes(bytes) => request
                    .set("Content-Type", "application/octet-stream")
                    .send_bytes(bytes),
                Body::Raw(bytes, content_type) => {
                    let request = match content_type {
                        Some(content_type) => request.set("Content-Type", content_type),
                        None => request,
                    };
                    request.send_bytes(bytes)
                }
            }));
            let Ok(result) = result else {
                last = Some("the HTTP library panicked".to_string());
                continue;
            };
            let response = match result {
                Ok(response) | Err(ureq::Error::Status(_, response)) => response,
                Err(ureq::Error::Transport(error)) => {
                    last = Some(error.to_string());
                    continue;
                }
            };
            match try_read_response(response) {
                Ok(answer) => return answer,
                // The connection broke while the body came: the same repeat applies.
                Err(error) => last = Some(error),
            }
        }
        let error = last.expect("the loop ran");
        panic!("{method} {url}: transport failure (is the server running?): {error}")
    }

    pub fn get(&self, path: &str, token: Option<&str>) -> Resp {
        self.send("GET", path, token, &[], Body::None)
    }

    pub fn post(&self, path: &str, token: Option<&str>, body: Value) -> Resp {
        self.send("POST", path, token, &[], Body::Json(body))
    }

    pub fn put(&self, path: &str, token: Option<&str>, body: Value) -> Resp {
        self.send("PUT", path, token, &[], Body::Json(body))
    }

    pub fn delete(&self, path: &str, token: Option<&str>) -> Resp {
        self.send("DELETE", path, token, &[], Body::None)
    }

    pub fn put_bytes(&self, path: &str, token: Option<&str>, bytes: Vec<u8>) -> Resp {
        self.send("PUT", path, token, &[], Body::Bytes(bytes))
    }

    /// Opens an event stream (П34). An answer other than 200 is returned as `Err`.
    pub fn open_events(
        &self,
        path: &str,
        token: Option<&str>,
        wait: Duration,
    ) -> Result<Sse, Resp> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(wait)
            .max_idle_connections(0)
            .build();
        let url = format!("{}{}", self.base, path);
        let mut request = agent.get(&url).set("Accept", "text/event-stream");
        if let Some(token) = token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        match request.call() {
            Ok(response) => {
                let content_type = response.header("content-type").unwrap_or("").to_string();
                Ok(Sse {
                    content_type,
                    reader: BufReader::new(response.into_reader()),
                })
            }
            Err(ureq::Error::Status(_, response)) => Err(read_response(response)),
            Err(ureq::Error::Transport(error)) => {
                panic!("GET {url}: transport failure (is the server running?): {error}")
            }
        }
    }
}

fn read_response(response: ureq::Response) -> Resp {
    let status = response.status();
    try_read_response(response)
        .unwrap_or_else(|error| panic!("reading the body of HTTP {status} failed: {error}"))
}

/// The answer with its body; an error when the body cannot be read to the end.
fn try_read_response(response: ureq::Response) -> Result<Resp, String> {
    let status = response.status();
    let headers = response
        .headers_names()
        .into_iter()
        .filter_map(|name| {
            response
                .header(&name)
                .map(|value| (name.to_ascii_lowercase(), value.to_string()))
        })
        .collect();
    let mut body = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut body)
        .map_err(|error| format!("reading the body of HTTP {status} failed: {error}"))?;
    Ok(Resp {
        status,
        headers,
        body,
    })
}

/// One event of an event stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// `event:` name; empty for a bare `data:` event; `:comment` for a comment line.
    pub name: String,
    pub id: Option<String>,
    pub data: String,
}

impl SseEvent {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.data)
            .unwrap_or_else(|error| panic!("event data is not JSON ({error}): {}", self.data))
    }
}

/// An open event stream (П34).
pub struct Sse {
    pub content_type: String,
    reader: BufReader<Box<dyn Read + Send + Sync + 'static>>,
}

impl Sse {
    /// The next event, or `None` when the read timed out or the stream ended. A comment line
    /// (`: ping`) comes back as an event named `:comment`.
    pub fn next_event(&mut self) -> Option<SseEvent> {
        let mut name = String::new();
        let mut id = None;
        let mut data = Vec::new();
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) | Err(_) => return None,
                Ok(_) => {}
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if name.is_empty() && data.is_empty() && id.is_none() {
                    continue;
                }
                return Some(SseEvent {
                    name,
                    id,
                    data: data.join("\n"),
                });
            }
            if let Some(comment) = line.strip_prefix(':') {
                return Some(SseEvent {
                    name: ":comment".to_string(),
                    id: None,
                    data: comment.trim().to_string(),
                });
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => name = value.to_string(),
                "id" => id = Some(value.to_string()),
                "data" => data.push(value.to_string()),
                _ => {}
            }
        }
    }

    /// The next event that is not a comment.
    pub fn next_real_event(&mut self) -> Option<SseEvent> {
        loop {
            let event = self.next_event()?;
            if event.name != ":comment" {
                return Some(event);
            }
        }
    }
}
