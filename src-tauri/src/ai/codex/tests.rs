//! Protocol tests for the Codex provider. Fixtures follow the app-server schema
//! of Codex 0.164 (`codex app-server generate-json-schema`). Written before the
//! implementation and frozen while it is written: change a test only with a reason.

use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};

// ---- framing ---------------------------------------------------------------

#[test]
fn lines_are_reassembled_across_chunk_boundaries() {
    let mut buffer = LineBuffer::default();
    assert!(buffer.push(b"{\"a\":").unwrap().is_empty());
    assert_eq!(
        buffer.push(b"1}\n{\"b\":2}\n{\"c\"").unwrap(),
        vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
    );
    assert_eq!(
        buffer.push(b":3}\n").unwrap(),
        vec!["{\"c\":3}".to_string()]
    );
}

#[test]
fn crlf_and_blank_lines_are_tolerated() {
    let mut buffer = LineBuffer::default();
    assert_eq!(
        buffer.push(b"{\"a\":1}\r\n\n{\"b\":2}\n").unwrap(),
        vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
    );
}

#[test]
fn a_line_longer_than_the_limit_is_a_protocol_error() {
    let mut buffer = LineBuffer::default();
    let long = vec![b'x'; MAX_LINE_BYTES + 1];
    assert_eq!(buffer.push(&long), Err(CodexError::Protocol));
}

#[test]
fn invalid_utf8_is_a_protocol_error() {
    let mut buffer = LineBuffer::default();
    assert_eq!(buffer.push(b"\xff\xfe\n"), Err(CodexError::Protocol));
}

// ---- parsing ---------------------------------------------------------------

#[test]
fn a_response_and_an_error_are_told_apart() {
    assert_eq!(
        parse_line(r#"{"id":3,"result":{"x":1}}"#).unwrap(),
        Incoming::Response {
            id: 3,
            result: json!({"x":1})
        }
    );
    assert_eq!(
        parse_line(r#"{"id":4,"error":{"code":-32600,"message":"bad"}}"#).unwrap(),
        Incoming::Error {
            id: 4,
            code: -32600
        }
    );
}

#[test]
fn agent_message_deltas_and_turn_completion_are_recognised() {
    let delta = r#"{"method":"item/agentMessage/delta","params":{"delta":"Hi","itemId":"i","threadId":"t","turnId":"u"}}"#;
    assert_eq!(
        parse_line(delta).unwrap(),
        Incoming::Notification(Event::AgentDelta("Hi".into()))
    );
    let done = r#"{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","status":"completed","items":[],"error":null}}}"#;
    assert_eq!(
        parse_line(done).unwrap(),
        Incoming::Notification(Event::TurnCompleted {
            status: "completed".into(),
            error: None
        })
    );
    let failed = r#"{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","status":"failed","items":[],"error":{"message":"boom"}}}}"#;
    match parse_line(failed).unwrap() {
        Incoming::Notification(Event::TurnCompleted { status, error }) => {
            assert_eq!(status, "failed");
            assert!(error.is_some());
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn login_completion_carries_success_and_the_error() {
    let line = r#"{"method":"account/login/completed","params":{"success":false,"error":"denied","loginId":"l"}}"#;
    assert_eq!(
        parse_line(line).unwrap(),
        Incoming::Notification(Event::LoginCompleted {
            success: false,
            error: Some("denied".into())
        })
    );
}

#[test]
fn unknown_notifications_are_ignored_not_errors() {
    let line = r#"{"method":"thread/realtime/started","params":{"anything":true}}"#;
    assert!(matches!(
        parse_line(line).unwrap(),
        Incoming::Notification(Event::Other(method)) if method == "thread/realtime/started"
    ));
}

#[test]
fn a_request_from_codex_keeps_its_id_method_and_params() {
    let line = r#"{"id":"srv-1","method":"item/commandExecution/requestApproval","params":{"command":"rm"}}"#;
    assert_eq!(
        parse_line(line).unwrap(),
        Incoming::ServerRequest {
            id: json!("srv-1"),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"command":"rm"}),
        }
    );
}

#[test]
fn garbage_is_a_protocol_error() {
    for line in ["", "not json", "[1,2]", "{\"id\":\"x\"}", "{}"] {
        assert_eq!(parse_line(line), Err(CodexError::Protocol), "{line:?}");
    }
}

// ---- version and binary ----------------------------------------------------

#[test]
fn supported_versions_are_accepted() {
    for output in [
        "codex-cli 0.164.0",
        "codex-cli 0.164.0\n",
        "codex-cli 0.166.2",
        "codex-cli 0.199.9",
    ] {
        assert_eq!(check_version(output), Ok(()), "{output:?}");
    }
}

#[test]
fn old_new_and_unreadable_versions_are_refused() {
    for output in ["codex-cli 0.163.9", "codex-cli 0.200.0", "codex-cli 1.0.0"] {
        assert_eq!(
            check_version(output),
            Err(CodexError::UnsupportedVersion),
            "{output:?}"
        );
    }
    for output in ["", "codex", "no digits here"] {
        assert_eq!(
            check_version(output),
            Err(CodexError::UnsupportedVersion),
            "{output:?}"
        );
    }
}

#[test]
fn only_an_absolute_existing_regular_file_is_a_binary() {
    assert_eq!(
        validate_binary(Path::new("codex")),
        Err(CodexError::NotInstalled)
    );
    assert_eq!(
        validate_binary(Path::new("/definitely/not/here/codex")),
        Err(CodexError::NotInstalled)
    );
    assert_eq!(
        validate_binary(&std::env::temp_dir()),
        Err(CodexError::NotInstalled)
    );
    let file = std::env::temp_dir().join(format!("amby-codex-test-{}", std::process::id()));
    std::fs::write(&file, b"#!/bin/sh\n").unwrap();
    let canonical = validate_binary(&file).unwrap();
    assert!(canonical.is_absolute());
    std::fs::remove_file(&file).unwrap();
}

// ---- requests --------------------------------------------------------------

#[test]
fn initialize_names_the_client() {
    let request = initialize_request(1);
    assert_eq!(request["id"], 1);
    assert_eq!(request["method"], "initialize");
    assert_eq!(request["params"]["clientInfo"]["name"], "amby-notes");
    assert!(request["params"]["clientInfo"]["version"].is_string());
    assert!(initialized_notification().get("id").is_none());
    assert_eq!(initialized_notification()["method"], "initialized");
}

#[test]
fn a_thread_is_read_only_and_never_asks_for_approval() {
    let request = thread_start_request(3, Path::new("/vault"), Some("gpt-5"));
    assert_eq!(request["method"], "thread/start");
    let params = &request["params"];
    assert_eq!(params["sandbox"], "read-only");
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["ephemeral"], true);
    assert_eq!(params["cwd"], "/vault");
    assert_eq!(params["model"], "gpt-5");
    let text = request.to_string();
    assert!(!text.contains("workspace-write") && !text.contains("danger-full-access"));
}

#[test]
fn the_model_is_omitted_when_not_chosen() {
    let request = thread_start_request(3, Path::new("/vault"), None);
    assert!(request["params"].get("model").is_none_or(Value::is_null));
}

#[test]
fn a_turn_sends_text_and_cannot_widen_the_sandbox() {
    let request = turn_start_request(4, "t1", "hello");
    assert_eq!(request["method"], "turn/start");
    assert_eq!(request["params"]["threadId"], "t1");
    assert_eq!(request["params"]["input"][0]["type"], "text");
    assert_eq!(request["params"]["input"][0]["text"], "hello");
    let text = request.to_string();
    assert!(!text.contains("workspace-write") && !text.contains("danger-full-access"));
    assert!(request["params"].get("sandboxPolicy").is_none());
    assert!(request["params"].get("approvalPolicy").is_none());
}

#[test]
fn login_uses_the_chatgpt_browser_flow_not_an_api_key() {
    let request = login_start_request(5);
    assert_eq!(request["method"], "account/login/start");
    assert_eq!(request["params"]["type"], "chatgpt");
    assert!(!request.to_string().to_lowercase().contains("apikey"));
}

#[test]
fn interrupt_names_the_thread_and_turn() {
    let request = turn_interrupt_request(6, "t1", "u1");
    assert_eq!(request["method"], "turn/interrupt");
    assert_eq!(request["params"]["threadId"], "t1");
    assert_eq!(request["params"]["turnId"], "u1");
}

// ---- answering Codex -------------------------------------------------------

#[test]
fn every_approval_is_declined_and_keeps_the_request_id() {
    for method in [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "applyPatchApproval",
        "execCommandApproval",
    ] {
        let reply = answer_server_request(&json!("srv-9"), method);
        assert_eq!(reply["id"], "srv-9", "{method}");
        let text = reply.to_string();
        assert!(!text.contains("accept"), "{method}: {text}");
        assert!(
            text.contains("decline") || text.contains("denied") || reply.get("error").is_some(),
            "{method}: {text}"
        );
    }
}

#[test]
fn elicitations_and_user_input_are_not_answered_with_consent() {
    for method in [
        "mcpServer/elicitation/request",
        "item/tool/requestUserInput",
    ] {
        let text = answer_server_request(&json!(7), method).to_string();
        assert!(!text.contains("accept"), "{method}: {text}");
    }
}

#[test]
fn amby_never_supplies_tokens_or_attestations() {
    for method in [
        "account/chatgptAuthTokens/refresh",
        "attestation/generate",
        "item/tool/call",
        "something/new",
    ] {
        let reply = answer_server_request(&json!(8), method);
        assert_eq!(reply["id"], 8, "{method}");
        assert_eq!(reply["error"]["code"], -32601, "{method}");
        assert!(reply.get("result").is_none(), "{method}");
    }
}

// ---- error mapping ---------------------------------------------------------

#[test]
fn errors_map_to_the_safe_codes_the_renderer_knows() {
    assert_eq!(
        error_code(&CodexError::NotLoggedIn),
        AiErrorCode::MissingCredential
    );
    assert_eq!(
        error_code(&CodexError::NotInstalled),
        AiErrorCode::InvalidConfiguration
    );
    assert_eq!(
        error_code(&CodexError::UnsupportedVersion),
        AiErrorCode::InvalidConfiguration
    );
    assert_eq!(error_code(&CodexError::Cancelled), AiErrorCode::Cancelled);
    assert_eq!(
        error_code(&CodexError::Rejected),
        AiErrorCode::ProviderRejected
    );
    assert_eq!(
        error_code(&CodexError::Protocol),
        AiErrorCode::InvalidResponse
    );
    assert_eq!(error_code(&CodexError::Io), AiErrorCode::Network);
}

// ---- a whole turn against a scripted app-server ----------------------------

type Seen = Arc<Mutex<Vec<Value>>>;

/// What `config/read` reports for Amby's isolated Codex: every listed feature off, a few
/// unrelated ones on, no MCP servers, no web search.
fn compliant_config() -> Value {
    let mut features = serde_json::Map::new();
    for name in crate::ai::codex::home::DISABLED_FEATURES {
        features.insert((*name).into(), json!(false));
    }
    features.insert("api_key_model_discovery".into(), json!(true));
    json!({"features": features, "mcp_servers": {}, "web_search": "disabled"})
}

/// Plays the server: for each line the client writes, `script` returns the lines to send back.
/// `None` from `script` closes the connection.
fn spawn_server(
    mut script: impl FnMut(&Value) -> Option<Vec<Value>> + Send + 'static,
) -> (tokio::io::DuplexStream, tokio::io::DuplexStream, Seen) {
    let (client_reader, mut server_writer) = duplex(64 * 1024);
    let (client_writer, server_reader) = duplex(64 * 1024);
    let seen: Seen = Arc::default();
    let log = seen.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(server_reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let message: Value = serde_json::from_str(&line).unwrap();
            log.lock().unwrap().push(message.clone());
            match script(&message) {
                Some(replies) if replies.is_empty() && message["method"] == "config/read" => {
                    let reply =
                        json!({"id": message["id"], "result": {"config": compliant_config()}});
                    server_writer
                        .write_all(format!("{reply}\n").as_bytes())
                        .await
                        .unwrap();
                }
                Some(replies) => {
                    for reply in replies {
                        server_writer
                            .write_all(format!("{reply}\n").as_bytes())
                            .await
                            .unwrap();
                    }
                }
                None => break,
            }
        }
    });
    (client_reader, client_writer, seen)
}

fn methods(seen: &Seen) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .filter_map(|m| m["method"].as_str().map(str::to_owned))
        .collect()
}

fn reply(request: &Value, result: Value) -> Value {
    json!({"id": request["id"], "result": result})
}

fn turn_notifications(status: &str) -> Vec<Value> {
    vec![
        json!({"method":"item/agentMessage/delta","params":{"delta":"Hel","itemId":"i","threadId":"t1","turnId":"u1"}}),
        json!({"method":"item/agentMessage/delta","params":{"delta":"lo","itemId":"i","threadId":"t1","turnId":"u1"}}),
        json!({"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"u1","status":status,"items":[],"error":null}}}),
    ]
}

fn input() -> TurnInput {
    TurnInput {
        cwd: PathBuf::from("/vault"),
        prompt: "hello".into(),
        model: None,
    }
}

/// Standard happy-path script; `turn` supplies what follows the `turn/start` response.
fn happy(turn: Vec<Value>) -> impl FnMut(&Value) -> Option<Vec<Value>> + Send + 'static {
    move |request| match request["method"].as_str() {
        Some("initialize") => Some(vec![reply(request, json!({"userAgent":"codex"}))]),
        Some("initialized") => Some(vec![]),
        Some("account/read") => Some(vec![reply(
            request,
            json!({"account":{"type":"chatgpt","email":"a@b.c","planType":"plus"},"requiresOpenaiAuth":true}),
        )]),
        Some("thread/start") => Some(vec![reply(request, json!({"thread":{"id":"t1"}}))]),
        Some("turn/start") => {
            let mut out = vec![reply(
                request,
                json!({"turn":{"id":"u1","status":"inProgress","items":[]}}),
            )];
            out.extend(turn.clone());
            Some(out)
        }
        _ => Some(vec![]),
    }
}

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("the turn hung instead of finishing")
}

#[tokio::test]
async fn a_turn_streams_text_and_follows_the_handshake_order() {
    let (reader, writer, seen) = spawn_server(happy(turn_notifications("completed")));
    let (_cancel_tx, cancel) = tokio::sync::watch::channel(false);
    let mut deltas = Vec::new();
    let output = within(run_turn(reader, writer, input(), cancel, |d| {
        deltas.push(d.to_owned())
    }))
    .await
    .unwrap();
    assert_eq!(
        output,
        TurnOutput {
            text: "Hello".into(),
            thread_id: "t1".into()
        }
    );
    assert_eq!(deltas, vec!["Hel", "lo"]);
    assert_eq!(
        methods(&seen),
        [
            "initialize",
            "initialized",
            "account/read",
            "config/read",
            "thread/start",
            "turn/start"
        ]
    );
}

#[tokio::test]
async fn a_signed_out_account_stops_before_any_thread_is_created() {
    let (reader, writer, seen) = spawn_server(|request| match request["method"].as_str() {
        Some("initialize") => Some(vec![reply(request, json!({}))]),
        Some("account/read") => Some(vec![reply(
            request,
            json!({"account":null,"requiresOpenaiAuth":true}),
        )]),
        _ => Some(vec![]),
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert_eq!(result, Err(CodexError::NotLoggedIn));
    assert!(!methods(&seen).contains(&"thread/start".to_string()));
}

#[tokio::test]
async fn an_approval_request_mid_turn_is_declined_and_the_turn_still_ends() {
    let mut turn = vec![json!({
        "id": "srv-1",
        "method": "item/commandExecution/requestApproval",
        "params": {"command": "rm -rf /"}
    })];
    turn.extend(turn_notifications("completed"));
    let (reader, writer, seen) = spawn_server(happy(turn));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    within(run_turn(reader, writer, input(), cancel, |_| {}))
        .await
        .unwrap();
    // The scripted server logs on its own task: give it a moment to read the last line.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let answers: Vec<Value> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|m| m["id"] == "srv-1" && m.get("method").is_none())
        .cloned()
        .collect();
    assert_eq!(
        answers.len(),
        1,
        "exactly one answer to the approval request"
    );
    assert!(!answers[0].to_string().contains("accept"));
}

#[tokio::test]
async fn a_failed_turn_is_an_error_not_partial_text() {
    let (reader, writer, _seen) = spawn_server(happy(turn_notifications("failed")));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert!(matches!(
        result,
        Err(CodexError::Rejected) | Err(CodexError::Protocol)
    ));
}

#[tokio::test]
async fn cancelling_interrupts_the_turn_and_returns_cancelled() {
    // The server streams one delta and then goes quiet until it is interrupted.
    let (reader, writer, seen) = spawn_server(|request| match request["method"].as_str() {
        Some("turn/start") => Some(vec![
            reply(
                request,
                json!({"turn":{"id":"u1","status":"inProgress","items":[]}}),
            ),
            json!({"method":"item/agentMessage/delta","params":{"delta":"Hel","itemId":"i","threadId":"t1","turnId":"u1"}}),
        ]),
        Some("turn/interrupt") => Some(vec![
            reply(request, json!({})),
            json!({"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"u1","status":"interrupted","items":[],"error":null}}}),
        ]),
        Some("initialize") => Some(vec![reply(request, json!({}))]),
        Some("account/read") => Some(vec![reply(
            request,
            json!({"account":{"type":"chatgpt","email":"a@b.c","planType":"plus"},"requiresOpenaiAuth":true}),
        )]),
        Some("thread/start") => Some(vec![reply(request, json!({"thread":{"id":"t1"}}))]),
        _ => Some(vec![]),
    });
    let (cancel_tx, cancel) = tokio::sync::watch::channel(false);
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel_tx.send(true).unwrap();
        cancel_tx
    });
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert_eq!(result, Err(CodexError::Cancelled));
    assert!(methods(&seen).contains(&"turn/interrupt".to_string()));
    drop(canceller);
}

#[tokio::test]
async fn the_connection_closing_mid_turn_ends_with_an_error_instead_of_hanging() {
    let (reader, writer, _seen) = spawn_server(|request| match request["method"].as_str() {
        Some("turn/start") => None,
        Some("initialize") => Some(vec![reply(request, json!({}))]),
        Some("account/read") => Some(vec![reply(
            request,
            json!({"account":{"type":"chatgpt","email":"a@b.c","planType":"plus"},"requiresOpenaiAuth":true}),
        )]),
        Some("thread/start") => Some(vec![reply(request, json!({"thread":{"id":"t1"}}))]),
        _ => Some(vec![]),
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert!(matches!(
        result,
        Err(CodexError::Io) | Err(CodexError::Protocol)
    ));
}

#[tokio::test]
async fn a_json_rpc_error_on_a_request_fails_the_turn() {
    let (reader, writer, _seen) = spawn_server(|request| match request["method"].as_str() {
        Some("initialize") => Some(vec![
            json!({"id":request["id"],"error":{"code":-32603,"message":"internal"}}),
        ]),
        _ => Some(vec![]),
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert!(result.is_err());
}

// ---- a thread that fails without ever completing the turn ------------------

#[test]
fn a_system_error_status_is_recognised_and_other_statuses_are_not() {
    let broken = r#"{"method":"thread/status/changed","params":{"threadId":"t","status":{"type":"systemError"}}}"#;
    assert_eq!(
        parse_line(broken).unwrap(),
        Incoming::Notification(Event::SystemError)
    );
    for status in [
        r#"{"type":"idle"}"#,
        r#"{"type":"active","activeFlags":[]}"#,
    ] {
        let line = format!(
            r#"{{"method":"thread/status/changed","params":{{"threadId":"t","status":{status}}}}}"#
        );
        assert!(matches!(
            parse_line(&line).unwrap(),
            Incoming::Notification(Event::Other(_))
        ));
    }
}

#[tokio::test]
async fn a_system_error_ends_the_turn_instead_of_waiting_for_a_completion_that_never_comes() {
    // What Codex does for a model name it does not know: no turn/completed, ever.
    let turn = vec![json!({
        "method": "thread/status/changed",
        "params": {"threadId": "t1", "status": {"type": "systemError"}}
    })];
    let (reader, writer, _seen) = spawn_server(happy(turn));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert_eq!(result, Err(CodexError::Rejected));
}

#[tokio::test]
async fn a_system_error_after_some_text_still_fails_the_turn() {
    let mut turn = vec![turn_notifications("completed").remove(0)];
    turn.push(json!({
        "method": "thread/status/changed",
        "params": {"threadId": "t1", "status": {"type": "systemError"}}
    }));
    let (reader, writer, _seen) = spawn_server(happy(turn));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert_eq!(result, Err(CodexError::Rejected));
}

// ---- signing in --------------------------------------------------------------

#[test]
fn only_the_openai_sign_in_page_may_be_opened() {
    for url in [
        "https://auth.openai.com/oauth/authorize?client_id=x&state=y",
        "https://auth.openai.com/",
    ] {
        assert!(auth_url_allowed(url), "{url}");
    }
    for url in [
        "http://auth.openai.com/oauth/authorize",
        "https://auth.openai.com.evil.com/oauth/authorize",
        "https://evil.com/?u=auth.openai.com",
        "https://evil.com/auth.openai.com",
        "https://auth.openai.com@evil.com/",
        "https://user:pw@auth.openai.com/",
        "https://auth.openai.com:8443/oauth",
        "https://AUTH.OPENAI.COM.evil.com/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,x",
        "",
        "not a url",
    ] {
        assert!(!auth_url_allowed(url), "{url}");
    }
}

const SIGN_IN_URL: &str = "https://auth.openai.com/oauth/authorize?state=abc";

fn login_server(
    completion: Option<Value>,
    url: &'static str,
) -> impl FnMut(&Value) -> Option<Vec<Value>> + Send + 'static {
    move |request| match request["method"].as_str() {
        Some("initialize") => Some(vec![reply(request, json!({}))]),
        Some("account/login/start") => {
            let mut out = vec![reply(
                request,
                json!({"type":"chatgpt","loginId":"l1","authUrl":url}),
            )];
            out.extend(completion.clone());
            Some(out)
        }
        Some("account/login/cancel") => Some(vec![reply(request, json!({"status":"canceled"}))]),
        _ => Some(vec![]),
    }
}

fn completed(success: bool) -> Value {
    json!({"method":"account/login/completed","params":{"loginId":"l1","success":success,"error":null}})
}

#[tokio::test]
async fn signing_in_opens_the_page_once_and_waits_for_the_result() {
    let (reader, writer, seen) = spawn_server(login_server(Some(completed(true)), SIGN_IN_URL));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let mut opened = Vec::new();
    within(run_login(
        reader,
        writer,
        |url| {
            opened.push(url.to_owned());
            true
        },
        cancel,
    ))
    .await
    .unwrap();
    assert_eq!(opened, vec![SIGN_IN_URL]);
    assert_eq!(
        methods(&seen),
        ["initialize", "initialized", "account/login/start"]
    );
}

#[tokio::test]
async fn a_failed_sign_in_is_not_logged_in() {
    let (reader, writer, _seen) = spawn_server(login_server(Some(completed(false)), SIGN_IN_URL));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_login(reader, writer, |_| true, cancel)).await;
    assert_eq!(result, Err(CodexError::NotLoggedIn));
}

#[tokio::test]
async fn a_page_that_is_not_openai_is_never_opened_and_the_login_is_cancelled() {
    let (reader, writer, seen) = spawn_server(login_server(
        None,
        "https://auth.openai.com.evil.com/oauth/authorize",
    ));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let mut opened = false;
    let result = within(run_login(
        reader,
        writer,
        |_| {
            opened = true;
            true
        },
        cancel,
    ))
    .await;
    assert_eq!(result, Err(CodexError::Rejected));
    assert!(!opened);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(methods(&seen).contains(&"account/login/cancel".to_string()));
}

#[tokio::test]
async fn a_browser_that_will_not_open_cancels_the_login() {
    let (reader, writer, seen) = spawn_server(login_server(None, SIGN_IN_URL));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_login(reader, writer, |_| false, cancel)).await;
    assert_eq!(result, Err(CodexError::Io));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(methods(&seen).contains(&"account/login/cancel".to_string()));
}

#[tokio::test]
async fn cancelling_while_waiting_cancels_the_login_in_codex() {
    let (reader, writer, seen) = spawn_server(login_server(None, SIGN_IN_URL));
    let (tx, cancel) = tokio::sync::watch::channel(false);
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        tx.send(true).unwrap();
        tx
    });
    let result = within(run_login(reader, writer, |_| true, cancel)).await;
    assert_eq!(result, Err(CodexError::Cancelled));
    // The scripted server logs on its own task: give it a moment to read the last line.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(methods(&seen).contains(&"account/login/cancel".to_string()));
    drop(canceller);
}

#[tokio::test]
async fn the_connection_closing_during_sign_in_is_an_error_not_a_hang() {
    let (reader, writer, _seen) = spawn_server(|request| match request["method"].as_str() {
        Some("initialize") => Some(vec![reply(request, json!({}))]),
        Some("account/login/start") => None,
        _ => Some(vec![]),
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_login(reader, writer, |_| true, cancel)).await;
    assert!(matches!(
        result,
        Err(CodexError::Io) | Err(CodexError::Protocol)
    ));
}

#[tokio::test]
async fn a_server_request_while_signing_in_is_answered_without_consent() {
    let mut script = login_server(Some(completed(true)), SIGN_IN_URL);
    let (reader, writer, seen) = spawn_server(move |request| {
        let mut out = script(request)?;
        if request["method"] == "account/login/start" {
            out.insert(
                1,
                json!({"id":"srv-1","method":"item/commandExecution/requestApproval","params":{}}),
            );
        }
        Some(out)
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    within(run_login(reader, writer, |_| true, cancel))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let answered = seen.lock().unwrap().iter().any(|m| {
        m["id"] == "srv-1" && m.get("method").is_none() && !m.to_string().contains("accept")
    });
    assert!(answered);
}

// ---- the guard: effective configuration ------------------------------------

fn config_with(change: impl FnOnce(&mut Value)) -> Value {
    let mut config = compliant_config();
    change(&mut config);
    config
}

#[test]
fn the_isolated_configuration_passes_the_guard() {
    assert_eq!(check_effective_config(&compliant_config()), Ok(()));
}

#[test]
fn a_feature_that_is_on_or_unreported_fails_the_guard() {
    for name in crate::ai::codex::home::DISABLED_FEATURES {
        let on = config_with(|c| c["features"][*name] = json!(true));
        assert_eq!(
            check_effective_config(&on),
            Err(CodexError::Boundary),
            "{name} on"
        );
        let missing = config_with(|c| {
            c["features"].as_object_mut().unwrap().remove(*name);
        });
        assert_eq!(
            check_effective_config(&missing),
            Err(CodexError::Boundary),
            "{name} missing"
        );
    }
}

#[test]
fn only_amby_may_be_an_mcp_server() {
    let amby =
        config_with(|c| c["mcp_servers"] = json!({"amby": {"url": "http://127.0.0.1:1/mcp"}}));
    assert_eq!(check_effective_config(&amby), Ok(()));
    for rogue in ["node_repl", "codex_apps", "amby2", "AMBY", ""] {
        let config = config_with(|c| {
            c["mcp_servers"] = json!({"amby": {}, rogue: {"command": "sh"}});
        });
        assert_eq!(
            check_effective_config(&config),
            Err(CodexError::Boundary),
            "{rogue:?}"
        );
    }
}

#[test]
fn web_search_must_be_disabled() {
    for value in [json!("live"), json!("cached"), json!(null), json!(true)] {
        let config = config_with(|c| c["web_search"] = value.clone());
        assert_eq!(
            check_effective_config(&config),
            Err(CodexError::Boundary),
            "{value}"
        );
    }
    let absent = config_with(|c| {
        c.as_object_mut().unwrap().remove("web_search");
    });
    assert_eq!(check_effective_config(&absent), Err(CodexError::Boundary));
}

#[test]
fn a_report_without_the_expected_shape_is_refused() {
    for config in [
        json!(null),
        json!([]),
        json!({}),
        json!({"features": 1, "mcp_servers": {}}),
        json!({"features": {}, "mcp_servers": []}),
    ] {
        assert!(check_effective_config(&config).is_err(), "{config}");
    }
}

// ---- the guard: items -------------------------------------------------------

#[test]
fn talking_thinking_and_amby_tools_are_allowed() {
    for item in [
        json!({"type": "userMessage", "id": "1", "content": []}),
        json!({"type": "agentMessage", "id": "2", "text": "hi"}),
        json!({"type": "reasoning", "id": "3", "summary": []}),
        json!({"type": "mcpToolCall", "id": "4", "server": "amby", "tool": "read_note", "arguments": {}}),
    ] {
        assert_eq!(check_item(&item), Ok(()), "{item}");
    }
}

#[test]
fn every_other_kind_of_item_is_a_violation_including_ones_that_do_not_exist_yet() {
    for item in [
        json!({"type": "commandExecution", "id": "1", "command": "cat ~/.ssh/id_rsa"}),
        json!({"type": "fileChange", "id": "1", "changes": []}),
        json!({"type": "webSearch", "id": "1", "query": "x"}),
        json!({"type": "imageView", "id": "1", "path": "/etc/passwd"}),
        json!({"type": "imageGeneration", "id": "1"}),
        json!({"type": "dynamicToolCall", "id": "1"}),
        json!({"type": "collabAgentToolCall", "id": "1"}),
        json!({"type": "mcpToolCall", "id": "1", "server": "node_repl", "tool": "js"}),
        json!({"type": "mcpToolCall", "id": "1", "tool": "read_note"}),
        json!({"type": "mcpToolCall", "id": "1", "server": "AMBY", "tool": "read_note"}),
        json!({"type": "someFutureTool", "id": "1"}),
        json!({"id": "1"}),
        json!("agentMessage"),
        json!(null),
    ] {
        assert_eq!(check_item(&item), Err(CodexError::Boundary), "{item}");
    }
}

#[test]
fn item_notifications_are_parsed_for_the_guard() {
    let started =
        r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"1"}}}"#;
    assert_eq!(
        parse_line(started).unwrap(),
        Incoming::Notification(Event::Item(json!({"type": "commandExecution", "id": "1"})))
    );
    let completed = r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"2","text":"x"}}}"#;
    assert!(matches!(
        parse_line(completed).unwrap(),
        Incoming::Notification(Event::Item(_))
    ));
    assert_eq!(
        parse_line(r#"{"method":"item/started","params":{}}"#),
        Err(CodexError::Protocol)
    );
}

#[test]
fn a_boundary_violation_has_its_own_safe_code() {
    assert_eq!(
        error_code(&CodexError::Boundary),
        AiErrorCode::AgentBoundary
    );
}

// ---- the guard in a whole turn ------------------------------------------------

fn item_event(kind: &str, item: Value) -> Value {
    json!({"method": kind, "params": {"threadId": "t1", "turnId": "u1", "item": item}})
}

#[tokio::test]
async fn an_extra_mcp_server_stops_the_turn_before_any_thread_exists() {
    let (reader, writer, seen) = spawn_server(|request| match request["method"].as_str() {
        Some("config/read") => Some(vec![reply(
            request,
            json!({"config": {"features": compliant_config()["features"].clone(),
                              "mcp_servers": {"node_repl": {"command": "x"}},
                              "web_search": "disabled"}}),
        )]),
        _ => happy(vec![])(request),
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert_eq!(result, Err(CodexError::Boundary));
    let sent = methods(&seen);
    assert!(
        !sent.contains(&"thread/start".to_string()) && !sent.contains(&"turn/start".to_string())
    );
}

#[tokio::test]
async fn a_command_attempt_stops_the_turn_interrupts_it_and_returns_no_text() {
    let mut turn = vec![turn_notifications("completed").remove(0)];
    turn.push(item_event(
        "item/started",
        json!({"type": "commandExecution", "id": "c1", "command": "cat ~/.ssh/id_rsa"}),
    ));
    let (reader, writer, seen) = spawn_server(move |request| match request["method"].as_str() {
        Some("turn/interrupt") => Some(vec![
            reply(request, json!({})),
            json!({"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"u1","status":"interrupted","items":[],"error":null}}}),
        ]),
        _ => happy(turn.clone())(request),
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let mut deltas = Vec::new();
    let result = within(run_turn(reader, writer, input(), cancel, |d| {
        deltas.push(d.to_owned())
    }))
    .await;
    assert_eq!(result, Err(CodexError::Boundary));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(methods(&seen).contains(&"turn/interrupt".to_string()));
}

#[tokio::test]
async fn a_tool_on_another_mcp_server_is_a_violation() {
    let turn = vec![item_event(
        "item/started",
        json!({"type": "mcpToolCall", "id": "m1", "server": "node_repl", "tool": "js", "arguments": {}}),
    )];
    let (reader, writer, _seen) = spawn_server(move |request| match request["method"].as_str() {
        Some("turn/interrupt") => Some(vec![reply(request, json!({}))]),
        _ => happy(turn.clone())(request),
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert_eq!(result, Err(CodexError::Boundary));
}

#[tokio::test]
async fn thinking_and_amby_tool_calls_do_not_trip_the_guard() {
    let mut turn = vec![
        item_event(
            "item/started",
            json!({"type": "reasoning", "id": "r1", "summary": []}),
        ),
        item_event(
            "item/started",
            json!({"type": "mcpToolCall", "id": "m1", "server": "amby", "tool": "read_note", "arguments": {}}),
        ),
        item_event(
            "item/completed",
            json!({"type": "mcpToolCall", "id": "m1", "server": "amby", "tool": "read_note", "status": "completed"}),
        ),
    ];
    turn.extend(turn_notifications("completed"));
    let (reader, writer, _seen) = spawn_server(happy(turn));
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let output = within(run_turn(reader, writer, input(), cancel, |_| {}))
        .await
        .unwrap();
    assert_eq!(output.text, "Hello");
}

#[tokio::test]
async fn the_connection_closing_right_after_a_violation_still_returns_the_violation() {
    let turn = vec![item_event(
        "item/started",
        json!({"type": "webSearch", "id": "w1", "query": "x"}),
    )];
    let (reader, writer, _seen) = spawn_server(move |request| match request["method"].as_str() {
        Some("turn/interrupt") => None,
        _ => happy(turn.clone())(request),
    });
    let (_tx, cancel) = tokio::sync::watch::channel(false);
    let result = within(run_turn(reader, writer, input(), cancel, |_| {})).await;
    assert_eq!(result, Err(CodexError::Boundary));
}

// ---- standing instructions -------------------------------------------------

#[test]
fn every_thread_carries_the_standing_instructions() {
    let request = thread_start_request(3, Path::new("/vault"), None);
    assert_eq!(
        request["params"]["developerInstructions"],
        DEVELOPER_INSTRUCTIONS
    );
}

#[test]
fn the_instructions_name_the_tools_and_treat_note_text_as_data() {
    let text = DEVELOPER_INSTRUCTIONS.to_lowercase();
    assert!(
        text.len() > 200 && text.len() < 2000,
        "{} bytes",
        text.len()
    );
    assert!(text.contains("amby"), "names the only tools it has");
    assert!(text.contains("read_note") && text.contains("search_notes"));
    assert!(text.contains("data"), "note text is data");
    assert!(text.contains("never") && text.contains("instruction"));
    assert!(text.contains("cite") || text.contains("citation"));
    for risky in ["shell", "web", "file"] {
        assert!(text.contains(risky), "should say it has no {risky} access");
    }
}

#[tokio::test]
async fn model_catalog_paginates_deduplicates_and_filters_non_text() {
    let (reader, writer, seen) = spawn_server(|request| match request["method"].as_str() {
        Some("initialize") => Some(vec![reply(request, json!({}))]),
        Some("initialized") => Some(vec![]),
        Some("account/read") => Some(vec![reply(
            request,
            json!({"account": {"type": "chatgpt"}}),
        )]),
        Some("model/list") if request["params"]["cursor"].is_null() => Some(vec![reply(
            request,
            json!({
                "data": [{"model":"a","displayName":"A"}, {"model":"audio","displayName":"Audio","inputModalities":["audio"]}], "nextCursor":"next"
            }),
        )]),
        Some("model/list") => Some(vec![reply(
            request,
            json!({"data": [{"model":"a","displayName":"A"}, {"model":"b","displayName":"B"}], "nextCursor":null}),
        )]),
        _ => None,
    });
    let (_sender, cancel) = tokio::sync::watch::channel(false);
    assert_eq!(
        run_model_catalog(reader, writer, cancel).await.unwrap(),
        vec![("a".into(), "A".into()), ("b".into(), "B".into())]
    );
    let requests = seen.lock().unwrap();
    let pages: Vec<_> = requests
        .iter()
        .filter(|request| request["method"] == "model/list")
        .collect();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[1]["params"]["cursor"], "next");
}

#[tokio::test]
async fn model_catalog_refuses_repeated_cursor() {
    let (reader, writer, _) = spawn_server(|request| match request["method"].as_str() {
        Some("initialize") => Some(vec![reply(request, json!({}))]),
        Some("initialized") => Some(vec![]),
        Some("account/read") => Some(vec![reply(
            request,
            json!({"account": {"type": "chatgpt"}}),
        )]),
        Some("model/list") => Some(vec![reply(
            request,
            json!({"data": [], "nextCursor":"same"}),
        )]),
        _ => None,
    });
    let (_sender, cancel) = tokio::sync::watch::channel(false);
    assert_eq!(
        run_model_catalog(reader, writer, cancel).await.unwrap_err(),
        CodexError::Protocol
    );
}
