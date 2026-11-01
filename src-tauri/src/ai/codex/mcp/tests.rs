//! Protocol and HTTP tests for the MCP bridge. Written before the implementation and frozen.

use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct Fake {
    calls: AtomicUsize,
}

impl Fake {
    fn new() -> Arc<Fake> {
        Arc::new(Fake {
            calls: AtomicUsize::new(0),
        })
    }
    fn count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl ToolHost for Fake {
    fn tools(&self) -> Vec<Value> {
        vec![json!({
            "name": "read_note",
            "description": "Read a note.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}},
            "annotations": {"readOnlyHint": true}
        })]
    }
    fn call(&self, name: &str, arguments: &Value) -> Value {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match name {
            "read_note" => json!({"id": arguments["id"], "title": "T", "content": "body"}),
            _ => json!({"error": "unknownTool"}),
        }
    }
}

fn rpc(host: &Fake, message: Value) -> Option<Value> {
    handle_rpc(host, &message)
}

// ---- protocol --------------------------------------------------------------

#[test]
fn initialize_answers_with_a_supported_version_tools_and_the_server_name() {
    let host = Fake::new();
    for version in ["2025-03-26", "2025-06-18", "2024-11-05"] {
        let reply = rpc(
            &host,
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":version,"capabilities":{},"clientInfo":{"name":"c","version":"1"}}}),
        )
        .unwrap();
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["result"]["protocolVersion"], version);
        assert!(reply["result"]["capabilities"]["tools"].is_object());
        assert_eq!(reply["result"]["serverInfo"]["name"], "amby");
    }
    let unknown = rpc(
        &host,
        json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}),
    )
    .unwrap();
    assert_eq!(unknown["result"]["protocolVersion"], "2025-03-26");
}

#[test]
fn notifications_get_no_reply_and_ping_gets_an_empty_result() {
    let host = Fake::new();
    assert!(rpc(
        &host,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )
    .is_none());
    assert!(rpc(
        &host,
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{}})
    )
    .is_none());
    let pong = rpc(&host, json!({"jsonrpc":"2.0","id":7,"method":"ping"})).unwrap();
    assert_eq!(pong, json!({"jsonrpc":"2.0","id":7,"result":{}}));
}

#[test]
fn tools_list_returns_exactly_what_the_host_offers() {
    let host = Fake::new();
    let reply = rpc(&host, json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})).unwrap();
    assert_eq!(reply["result"]["tools"], json!(host.tools()));
}

#[test]
fn a_tool_call_returns_the_result_as_text_and_runs_the_host_once() {
    let host = Fake::new();
    let reply = rpc(
        &host,
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_note","arguments":{"id":"n1"}}}),
    )
    .unwrap();
    assert_eq!(host.count(), 1);
    assert_eq!(reply["result"]["isError"], false);
    let text = reply["result"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(reply["result"]["content"][0]["type"], "text");
    let parsed: Value = serde_json::from_str(text).unwrap();
    assert_eq!(parsed["id"], "n1");
    assert_eq!(parsed["content"], "body");
}

#[test]
fn a_failed_tool_is_marked_as_an_error_result_not_a_protocol_error() {
    let host = Fake::new();
    let reply = rpc(
        &host,
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope","arguments":{}}}),
    )
    .unwrap();
    assert!(reply.get("error").is_none());
    assert_eq!(reply["result"]["isError"], true);
}

#[test]
fn a_tool_call_without_a_name_is_invalid_params_and_runs_nothing() {
    let host = Fake::new();
    for params in [json!({}), json!({"name": 5}), json!(null), json!([])] {
        let reply = rpc(
            &host,
            json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":params}),
        )
        .unwrap();
        assert_eq!(reply["error"]["code"], -32602);
    }
    assert_eq!(host.count(), 0);
}

#[test]
fn unknown_methods_and_malformed_messages_are_json_rpc_errors() {
    let host = Fake::new();
    let unknown = rpc(
        &host,
        json!({"jsonrpc":"2.0","id":8,"method":"resources/list"}),
    )
    .unwrap();
    assert_eq!(unknown["error"]["code"], -32601);
    for bad in [
        json!([]),
        json!("x"),
        json!(5),
        json!(null),
        json!([{"id":1}]),
    ] {
        let reply = rpc(&host, bad).unwrap();
        assert_eq!(reply["error"]["code"], -32600);
        assert_eq!(reply["id"], Value::Null);
    }
    assert_eq!(host.count(), 0);
}

// ---- HTTP ------------------------------------------------------------------

struct Reply {
    status: u16,
    body: String,
}

async fn request(addr: SocketAddr, raw: String) -> Reply {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(raw.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes).await;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();
    Reply { status, body }
}

fn post(addr: SocketAddr, token: Option<&str>, host: &str, extra: &str, body: &str) -> String {
    let auth = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    format!(
        "POST /mcp HTTP/1.1\r\nHost: {host}\r\n{auth}{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .replace("{addr}", &addr.to_string())
}

const LIST: &str = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;

#[tokio::test]
async fn the_server_listens_on_loopback_only_and_answers_a_valid_request() {
    let host = Fake::new();
    let server = McpServer::start(host.clone()).await.unwrap();
    assert!(server.addr.ip().is_loopback());
    assert!(server.token.len() >= 32);
    let reply = request(
        server.addr,
        post(
            server.addr,
            Some(&server.token),
            &server.addr.to_string(),
            "",
            LIST,
        ),
    )
    .await;
    assert_eq!(reply.status, 200);
    let json: Value = serde_json::from_str(&reply.body).unwrap();
    assert_eq!(json["result"]["tools"][0]["name"], "read_note");
    server.stop().await;
}

#[tokio::test]
async fn every_server_gets_its_own_token() {
    let host = Fake::new();
    let a = McpServer::start(host.clone()).await.unwrap();
    let b = McpServer::start(host).await.unwrap();
    assert_ne!(a.token, b.token);
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_missing_or_wrong_token_is_refused_and_nothing_runs() {
    let host = Fake::new();
    let server = McpServer::start(host.clone()).await.unwrap();
    let call = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"id":"x"}}}"#;
    let host_header = server.addr.to_string();
    let wrong = format!("{}x", server.token);
    let short = &server.token[..server.token.len() - 1];
    for token in [
        None,
        Some(""),
        Some("wrong"),
        Some(wrong.as_str()),
        Some(short),
    ] {
        let reply = request(
            server.addr,
            post(server.addr, token, &host_header, "", call),
        )
        .await;
        assert_eq!(reply.status, 401, "{token:?}");
    }
    let lower = format!(
        "POST /mcp HTTP/1.1\r\nHost: {host_header}\r\nAuthorization: bearer {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{call}",
        server.token,
        call.len()
    );
    assert_eq!(request(server.addr, lower).await.status, 401);
    let basic = format!(
        "POST /mcp HTTP/1.1\r\nHost: {host_header}\r\nAuthorization: Basic {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{call}",
        server.token,
        call.len()
    );
    assert_eq!(request(server.addr, basic).await.status, 401);
    assert_eq!(host.count(), 0);
    server.stop().await;
}

#[tokio::test]
async fn a_foreign_host_or_an_origin_is_refused_even_with_the_token() {
    let host = Fake::new();
    let server = McpServer::start(host.clone()).await.unwrap();
    let token = server.token.clone();
    for host_header in ["evil.example", "localhost", "127.0.0.1:1", ""] {
        let reply = request(
            server.addr,
            post(server.addr, Some(&token), host_header, "", LIST),
        )
        .await;
        assert_eq!(reply.status, 403, "Host {host_header:?}");
    }
    let origin = request(
        server.addr,
        post(
            server.addr,
            Some(&token),
            &server.addr.to_string(),
            "Origin: https://evil.example\r\n",
            LIST,
        ),
    )
    .await;
    assert_eq!(origin.status, 403);
    server.stop().await;
}

#[tokio::test]
async fn only_post_to_the_mcp_path_is_served() {
    let host = Fake::new();
    let server = McpServer::start(host.clone()).await.unwrap();
    let h = server.addr.to_string();
    let t = &server.token;
    for (method, path, status) in [
        ("GET", "/mcp", 405),
        ("PUT", "/mcp", 405),
        ("DELETE", "/mcp", 405),
        ("POST", "/", 404),
        ("POST", "/mcp/extra", 404),
        ("POST", "/admin", 404),
    ] {
        let raw = format!(
            "{method} {path} HTTP/1.1\r\nHost: {h}\r\nAuthorization: Bearer {t}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        assert_eq!(
            request(server.addr, raw).await.status,
            status,
            "{method} {path}"
        );
    }
    server.stop().await;
}

#[tokio::test]
async fn a_notification_gets_202_and_a_bad_body_gets_400() {
    let host = Fake::new();
    let server = McpServer::start(host).await.unwrap();
    let h = server.addr.to_string();
    let note = request(
        server.addr,
        post(
            server.addr,
            Some(&server.token),
            &h,
            "",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        ),
    )
    .await;
    assert_eq!(note.status, 202);
    for body in ["", "not json", "{"] {
        let reply = request(
            server.addr,
            post(server.addr, Some(&server.token), &h, "", body),
        )
        .await;
        assert_eq!(reply.status, 400, "{body:?}");
    }
    server.stop().await;
}

#[tokio::test]
async fn an_oversized_body_is_refused_before_it_is_read() {
    let host = Fake::new();
    let server = McpServer::start(host.clone()).await.unwrap();
    let h = server.addr.to_string();
    let raw = format!(
        "POST /mcp HTTP/1.1\r\nHost: {h}\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        server.token,
        MAX_BODY_BYTES + 1
    );
    assert_eq!(request(server.addr, raw).await.status, 413);
    assert_eq!(host.count(), 0);
    server.stop().await;
}

#[tokio::test]
async fn oversized_headers_are_refused() {
    let host = Fake::new();
    let server = McpServer::start(host).await.unwrap();
    let h = server.addr.to_string();
    let raw = format!(
        "POST /mcp HTTP/1.1\r\nHost: {h}\r\nX-Pad: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "a".repeat(MAX_HEADER_BYTES + 100)
    );
    let status = request(server.addr, raw).await.status;
    assert!(status == 431 || status == 400 || status == 0, "{status}");
    server.stop().await;
}

#[tokio::test]
async fn a_silent_client_is_dropped_and_does_not_block_others() {
    let host = Fake::new();
    let server = McpServer::start_with(host, Duration::from_millis(200))
        .await
        .unwrap();
    let mut slow = TcpStream::connect(server.addr).await.unwrap();
    slow.write_all(b"POST /mcp HTTP/1.1\r\n").await.unwrap();
    let h = server.addr.to_string();
    let reply = request(
        server.addr,
        post(server.addr, Some(&server.token), &h, "", LIST),
    )
    .await;
    assert_eq!(reply.status, 200);
    let mut sink = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), slow.read_to_end(&mut sink)).await;
    assert!(closed.is_ok(), "the silent connection was not closed");
    server.stop().await;
}

#[tokio::test]
async fn requests_are_served_concurrently() {
    let host = Fake::new();
    let server = McpServer::start(host.clone()).await.unwrap();
    let h = server.addr.to_string();
    let call = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_note","arguments":{"id":"n"}}}"#;
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let raw = post(server.addr, Some(&server.token), &h, "", call);
        let addr = server.addr;
        tasks.push(tokio::spawn(async move { request(addr, raw).await.status }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap(), 200);
    }
    assert_eq!(host.count(), 8);
    server.stop().await;
}

#[tokio::test]
async fn after_stop_nothing_is_listening() {
    let host = Fake::new();
    let server = McpServer::start(host).await.unwrap();
    let addr = server.addr;
    server.stop().await;
    assert!(TcpStream::connect(addr).await.is_err());
}
