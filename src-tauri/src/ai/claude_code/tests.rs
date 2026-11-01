//! Protocol tests for the Claude Code adapter: version range, argument safety, decoding of
//! the `stream-json` lines (shapes taken from Claude Code 2.1.312) and the boundary guard.

use super::*;
use tokio::io::AsyncWriteExt;

fn allowed() -> Vec<String> {
    allowed_tool_names(true)
}

const INIT: &str = r#"{"type":"system","subtype":"init","tools":["mcp__amby__read_note"],"mcp_servers":[{"name":"amby","status":"connected"}],"skills":[],"slash_commands":[]}"#;
const RESULT_OK: &str =
    r#"{"type":"result","subtype":"success","is_error":false,"result":"Hi there"}"#;

fn delta(text: &str) -> String {
    format!(
        r#"{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{text}"}}}}}}"#
    )
}

async fn run(lines: &[&str]) -> (Result<String, ClaudeError>, String) {
    let (mut tx, rx) = tokio::io::duplex(1 << 16);
    for line in lines {
        tx.write_all(line.as_bytes()).await.unwrap();
        tx.write_all(b"\n").await.unwrap();
    }
    drop(tx);
    let (_cancel, cancel_rx) = tokio::sync::watch::channel(false);
    let mut seen = String::new();
    let result = run_stream(rx, &allowed(), Duration::from_secs(5), cancel_rx, |delta| {
        seen.push_str(delta)
    })
    .await;
    (result, seen)
}

#[test]
fn only_the_two_supported_lines_of_claude_code_are_accepted() {
    assert_eq!(check_version("2.1.312 (Claude Code)"), Ok(()));
    assert_eq!(check_version("2.1.0"), Ok(()));
    assert_eq!(
        check_version("2.0.99 (Claude Code)"),
        Err(ClaudeError::UnsupportedVersion)
    );
    assert_eq!(
        check_version("3.0.0 (Claude Code)"),
        Err(ClaudeError::UnsupportedVersion)
    );
    assert_eq!(
        check_version("not a version"),
        Err(ClaudeError::UnsupportedVersion)
    );
    assert_eq!(check_version(""), Err(ClaudeError::UnsupportedVersion));
}

#[test]
fn a_model_name_is_one_safe_argument() {
    assert!(valid_model("opus"));
    assert!(valid_model("claude-opus-5-5"));
    assert!(valid_model("sonnet[1m]"));
    assert!(!valid_model(""));
    assert!(!valid_model("--dangerously-skip-permissions"));
    assert!(!valid_model("a b"));
    assert!(!valid_model("a;b"));
    assert!(!valid_model(&"a".repeat(129)));
}

#[test]
fn turn_arguments_switch_off_every_tool_and_every_other_server() {
    let args = turn_args(Some("opus"), 4242, &allowed()).unwrap();
    let joined = args.join("\u{1}");
    for must in [
        "--restricted",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "dontAsk",
        "none",
    ] {
        assert!(args.iter().any(|arg| arg == must), "missing {must}");
    }
    // `--tools ""`: an empty tool list, as two arguments.
    let tools = args.iter().position(|arg| arg == "--tools").unwrap();
    assert_eq!(args[tools + 1], "");
    // Never the flags that widen access or drop the bridge.
    for never in [
        "--dangerously-skip-permissions",
        "--allow-dangerously-skip-permissions",
        "--safe-mode",
        "--add-dir",
        "bypassPermissions",
    ] {
        assert!(!joined.contains(never), "{never} must not be passed");
    }
    // The token is not on the command line; the port is.
    let config = &args[args.iter().position(|arg| arg == "--mcp-config").unwrap() + 1];
    assert!(config.contains("127.0.0.1:4242"));
    assert!(config.contains("${AMBY_MCP_TOKEN}"));
    assert!(args
        .iter()
        .any(|arg| arg.starts_with("--allowedTools=mcp__amby__read_note,")));
    // The prompt is not an argument.
    assert!(!joined.contains("Conversation:"));
}

#[test]
fn a_hostile_model_name_never_reaches_the_command_line() {
    assert_eq!(
        turn_args(Some("--mcp-config"), 1, &allowed()),
        Err(ClaudeError::Rejected)
    );
    assert!(turn_args(None, 1, &allowed()).is_ok());
    assert!(turn_args(Some(""), 1, &allowed()).is_ok());
}

#[test]
fn search_tools_are_allowed_only_when_search_is_on() {
    assert_eq!(
        allowed_tool_names(false),
        ["mcp__amby__read_note", "mcp__amby__get_links"]
    );
    assert_eq!(allowed_tool_names(true).len(), 4);
}

#[test]
fn lines_are_split_across_arbitrary_chunking_and_bounded() {
    let mut buffer = LineBuffer::default();
    assert!(buffer.push(b"{\"a\":").unwrap().is_empty());
    assert_eq!(
        buffer.push(b"1}\r\n\n{\"b\":2}\n").unwrap(),
        ["{\"a\":1}", "{\"b\":2}"]
    );
    let mut buffer = LineBuffer::default();
    assert_eq!(
        buffer.push(&vec![b'x'; MAX_LINE_BYTES + 1]),
        Err(ClaudeError::Protocol)
    );
    assert_eq!(
        LineBuffer::default().push(&[0xff, b'\n']),
        Err(ClaudeError::Protocol)
    );
}

#[test]
fn lines_decode_to_the_events_amby_uses() {
    assert_eq!(
        parse_line(INIT).unwrap(),
        StreamEvent::Init {
            tools: vec!["mcp__amby__read_note".into()],
            mcp_servers: vec!["amby".into()],
            skills: 0
        }
    );
    assert_eq!(
        parse_line(&delta("Hi")).unwrap(),
        StreamEvent::TextDelta("Hi".into())
    );
    assert_eq!(
        parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}}"#).unwrap(),
        StreamEvent::Other
    );
    assert_eq!(
        parse_line(r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}"#).unwrap(),
        StreamEvent::ToolUse("Bash".into())
    );
    assert_eq!(
        parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"Bash"}]},"error":"authentication_failed"}"#).unwrap(),
        StreamEvent::Assistant { tool_uses: vec!["Bash".into()], error: Some("authentication_failed".into()) }
    );
    assert_eq!(
        parse_line(RESULT_OK).unwrap(),
        StreamEvent::Result {
            ok: true,
            text: "Hi there".into()
        }
    );
    assert_eq!(
        parse_line(r#"{"type":"system","subtype":"ui_invalidate"}"#).unwrap(),
        StreamEvent::Other
    );
}

#[test]
fn malformed_lines_are_protocol_errors() {
    for line in [
        "",
        "not json",
        "[]",
        r#"{"no":"type"}"#,
        r#"{"type":"system","subtype":"init"}"#,
    ] {
        assert_eq!(parse_line(line), Err(ClaudeError::Protocol), "{line}");
    }
}

#[test]
fn models_come_from_the_initialize_answer_deduplicated_and_bounded() {
    let response = serde_json::json!({"models": [
        {"value": "default", "displayName": "Default (recommended)"},
        {"value": "opus", "displayName": "Opus"},
        {"value": "opus", "displayName": "Again"},
        {"value": "--bad", "displayName": "Bad"},
        {"value": "fable"}
    ]});
    assert_eq!(
        parse_models(&response).unwrap(),
        [
            ("default".to_owned(), "Default (recommended)".to_owned()),
            ("opus".to_owned(), "Opus".to_owned()),
            ("fable".to_owned(), "fable".to_owned()),
        ]
    );
    assert_eq!(
        parse_models(&serde_json::json!({})),
        Err(ClaudeError::Protocol)
    );
    assert_eq!(
        parse_models(&serde_json::json!({"models": [{"nope": 1}]})),
        Err(ClaudeError::Protocol)
    );
}

#[test]
fn model_labels_carry_the_version_the_alias_resolves_to() {
    let response = serde_json::json!({"models": [
        {"value": "default", "displayName": "Default (recommended)", "resolvedModel": "claude-opus-5-5"},
        {"value": "opus", "displayName": "Opus", "resolvedModel": "claude-opus-5-5"},
        {"value": "fable", "displayName": "Fable", "resolvedModel": "claude-fable-5-1"},
        {"value": "haiku", "displayName": "Haiku", "resolvedModel": "claude-haiku-4-5-20251001"},
        {"value": "odd", "displayName": "Odd", "resolvedModel": "not-a-claude-id"}
    ]});
    assert_eq!(
        parse_models(&response).unwrap(),
        [
            ("opus".to_owned(), "Opus 5.5".to_owned()),
            ("fable".to_owned(), "Fable 5.1".to_owned()),
            ("haiku".to_owned(), "Haiku 4.5".to_owned()),
            ("odd".to_owned(), "Odd".to_owned()),
        ]
    );
}

#[test]
fn default_is_kept_only_when_no_alias_names_the_same_model() {
    let response = serde_json::json!({"models": [
        {"value": "default", "displayName": "Default (recommended)", "resolvedModel": "claude-opus-5-5"},
        {"value": "opus", "displayName": "Opus", "resolvedModel": "claude-opus-5-5"},
        {"value": "opus-copy", "displayName": "Opus again", "resolvedModel": "claude-opus-5-5"},
    ]});
    let models = parse_models(&response).unwrap();
    assert_eq!(
        models.iter().map(|m| m.0.as_str()).collect::<Vec<_>>(),
        ["opus"]
    );
    let alone = serde_json::json!({"models": [
        {"value": "default", "displayName": "Default (recommended)", "resolvedModel": "claude-opus-5-5"},
    ]});
    assert_eq!(
        parse_models(&alone).unwrap(),
        [(
            "default".to_owned(),
            "Default (recommended) · Opus 5.5".to_owned()
        )]
    );
}

#[tokio::test]
async fn a_turn_streams_text_and_returns_it() {
    let (result, seen) = run(&[INIT, &delta("Hel"), &delta("lo"), RESULT_OK]).await;
    assert_eq!(result.unwrap(), "Hello");
    assert_eq!(seen, "Hello");
}

#[tokio::test]
async fn without_partial_messages_the_result_text_is_the_answer() {
    let (result, seen) = run(&[INIT, RESULT_OK]).await;
    assert_eq!(result.unwrap(), "Hi there");
    assert_eq!(seen, "Hi there");
}

#[tokio::test]
async fn amby_tools_may_be_called() {
    let call = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__amby__read_note"}]}}"#;
    let (result, _) = run(&[INIT, call, RESULT_OK]).await;
    assert_eq!(result.unwrap(), "Hi there");
}

#[tokio::test]
async fn any_other_tool_in_the_init_line_ends_the_turn() {
    for init in [
        r#"{"type":"system","subtype":"init","tools":["Bash"],"mcp_servers":[],"skills":[]}"#,
        r#"{"type":"system","subtype":"init","tools":["mcp__amby__shell"],"mcp_servers":[],"skills":[]}"#,
        r#"{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"evil"}],"skills":[]}"#,
        r#"{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"skills":["x"]}"#,
    ] {
        let (result, seen) = run(&[init, &delta("never shown"), RESULT_OK]).await;
        assert_eq!(result, Err(ClaudeError::Boundary), "{init}");
        assert!(seen.is_empty());
    }
}

#[tokio::test]
async fn a_tool_call_outside_the_bridge_ends_the_turn_before_more_text() {
    for call in [
        r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebFetch"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__other__x"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}"#,
    ] {
        let (result, seen) = run(&[INIT, call, &delta("after"), RESULT_OK]).await;
        assert_eq!(result, Err(ClaudeError::Boundary), "{call}");
        assert!(seen.is_empty(), "{call}");
    }
}

#[tokio::test]
async fn search_tools_are_a_boundary_violation_when_search_is_off() {
    let (mut tx, rx) = tokio::io::duplex(1 << 16);
    let call = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__amby__search_notes"}]}}"#;
    for line in [INIT, call] {
        tx.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    }
    let (_cancel, cancel_rx) = tokio::sync::watch::channel(false);
    let result = run_stream(
        rx,
        &allowed_tool_names(false),
        Duration::from_secs(5),
        cancel_rx,
        |_| {},
    )
    .await;
    assert_eq!(result, Err(ClaudeError::Boundary));
}

#[tokio::test]
async fn nothing_counts_before_the_init_line_proves_the_boundary() {
    let (result, seen) = run(&[&delta("early"), RESULT_OK]).await;
    assert_eq!(result, Err(ClaudeError::Protocol));
    assert!(seen.is_empty());
}

#[tokio::test]
async fn a_signed_out_claude_code_is_reported_as_not_logged_in() {
    let assistant = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}"#;
    let (result, _) = run(&[INIT, assistant]).await;
    assert_eq!(result, Err(ClaudeError::NotLoggedIn));
    let failed =
        r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}"#;
    let (result, _) = run(&[INIT, failed]).await;
    assert_eq!(result, Err(ClaudeError::NotLoggedIn));
}

#[tokio::test]
async fn other_failures_are_rejections_and_never_leak_their_text() {
    let failed =
        r#"{"type":"result","is_error":true,"result":"secret endpoint https://x/?key=abc"}"#;
    let (result, _) = run(&[INIT, failed]).await;
    assert_eq!(result, Err(ClaudeError::Rejected));
    let limited = r#"{"type":"assistant","message":{"content":[]},"error":"rate_limit"}"#;
    let (result, _) = run(&[INIT, limited]).await;
    assert_eq!(result, Err(ClaudeError::Rejected));
}

#[tokio::test]
async fn a_broken_or_truncated_stream_is_an_error_not_an_answer() {
    let (result, _) = run(&[INIT, "this is not json"]).await;
    assert_eq!(result, Err(ClaudeError::Protocol));
    // The stream ends without a result line.
    let (result, _) = run(&[INIT, &delta("partial")]).await;
    assert_eq!(result, Err(ClaudeError::Io));
}

#[tokio::test]
async fn a_cancel_ends_the_stream_even_while_it_is_silent() {
    let (_tx, rx) = tokio::io::duplex(64);
    let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(run_stream(
        rx,
        &[],
        Duration::from_secs(30),
        cancel_rx,
        |_| {},
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel.send(true).unwrap();
    assert_eq!(task.await.unwrap(), Err(ClaudeError::Cancelled));
}

#[tokio::test]
async fn a_silent_stream_times_out() {
    let (_tx, rx) = tokio::io::duplex(64);
    let (_cancel, cancel_rx) = tokio::sync::watch::channel(false);
    let result = run_stream(rx, &[], Duration::from_millis(100), cancel_rx, |_| {}).await;
    assert_eq!(result, Err(ClaudeError::Io));
}

#[test]
fn errors_map_to_codes_the_renderer_understands() {
    assert_eq!(
        error_code(&ClaudeError::NotLoggedIn),
        AiErrorCode::MissingCredential
    );
    assert_eq!(
        error_code(&ClaudeError::Boundary),
        AiErrorCode::AgentBoundary
    );
    assert_eq!(
        error_code(&ClaudeError::NotInstalled),
        AiErrorCode::InvalidConfiguration
    );
    assert_eq!(
        error_code(&ClaudeError::UnsupportedVersion),
        AiErrorCode::InvalidConfiguration
    );
    assert_eq!(error_code(&ClaudeError::Cancelled), AiErrorCode::Cancelled);
    assert_eq!(
        error_code(&ClaudeError::Rejected),
        AiErrorCode::ProviderRejected
    );
    assert_eq!(
        error_code(&ClaudeError::Protocol),
        AiErrorCode::InvalidResponse
    );
}
