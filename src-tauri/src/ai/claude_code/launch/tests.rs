//! Process tests for the Claude Code launcher, against a fake `claude` shell script.

#![cfg(unix)]

use super::*;
use crate::ai::claude_code::home::prepare_home;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "amby-claude-launch-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn home() -> ClaudeHome {
    prepare_home(&scratch()).unwrap()
}

fn install(path: &Path, script: &str) {
    std::fs::write(path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

const SCRIPT: &str = r#"#!/bin/sh
DIR="@DIR@"
case "$1" in
  --version) echo "@VERSION@ (Claude Code)"; exit 0;;
  auth)
    env > "$DIR/auth_env"
    case "$2" in
      status)
        if [ "@SIGNED@" = "1" ] || [ -f "$CLAUDE_CONFIG_DIR/signed" ]; then echo '{"loggedIn":true}'; exit 0; fi
        echo '{"loggedIn":false}'; exit 1;;
      login)
        echo "$$" > "$DIR/login_pid"
        if [ "@LOGIN@" = "ok" ]; then touch "$CLAUDE_CONFIG_DIR/signed"; exit 0; fi
        if [ "@LOGIN@" = "fail" ]; then exit 1; fi
        sleep 300 & wait;;
      logout) rm -f "$CLAUDE_CONFIG_DIR/signed"; exit 0;;
    esac;;
esac
# A chat-shaped process.
echo "$$" > "$DIR/pid"
echo "$@" > "$DIR/args"
pwd > "$DIR/cwd"
env > "$DIR/env"
case "$*" in
  *stream-json*"--input-format"*|*"--input-format stream-json"*)
    IFS= read -r line
    case "$line" in
      *'"subtype":"initialize"'*)
        if [ "@MODE@" = "garbage" ]; then echo 'not json'; sleep 300 & wait; fi
        echo '{"type":"system","subtype":"ui_invalidate"}'
        echo '{"type":"control_response","response":{"subtype":"success","request_id":"amby-initialize","response":{"models":[{"value":"default","displayName":"Default"},{"value":"opus","displayName":"Opus"}]}}}'
        if [ "@MODE@" = "hang" ]; then sleep 300 & wait; fi
        while IFS= read -r more; do :; done;;
    esac
    exit 0;;
esac
cat > "$DIR/prompt"
case "@MODE@" in
  garbage) echo 'definitely not json'; sleep 300 & wait;;
  silent) exit 0;;
  tool)
    echo '{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"amby"}],"skills":[]}'
    echo '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}'
    sleep 300 & wait;;
  hang)
    echo '{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"amby"}],"skills":[]}'
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}'
    sleep 300 & wait;;
  *)
    echo '{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"amby"}],"skills":[]}'
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}'
    echo '{"type":"result","is_error":false,"result":"Hello"}';;
esac
"#;

struct Fake {
    dir: PathBuf,
    binary: PathBuf,
}

fn fake(version: &str, signed: bool, login: &str, mode: &str) -> Fake {
    let dir = scratch();
    let binary = dir.join("claude");
    install(
        &binary,
        &SCRIPT
            .replace("@DIR@", &dir.display().to_string())
            .replace("@VERSION@", version)
            .replace("@SIGNED@", if signed { "1" } else { "0" })
            .replace("@LOGIN@", login)
            .replace("@MODE@", mode),
    );
    Fake { dir, binary }
}

fn ready(mode: &str) -> Fake {
    fake("2.1.312", true, "ok", mode)
}

fn never_cancelled() -> (
    tokio::sync::watch::Sender<bool>,
    tokio::sync::watch::Receiver<bool>,
) {
    tokio::sync::watch::channel(false)
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid.trim()])
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap_or_default()
}

fn assert_gone(dir: &Path, file: &str) {
    let pid = read(dir, file);
    assert!(!pid.trim().is_empty(), "the fake never wrote {file}");
    // Reaping is asynchronous in the OS: give it a moment.
    for _ in 0..40 {
        if !alive(&pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("child {pid} is still running");
}

fn home_with_token(home: ClaudeHome) -> ClaudeHome {
    home.with_bridge_token("bridge-secret".into())
}

fn messages() -> Vec<AiMessage> {
    vec![AiMessage {
        role: "user".into(),
        content: "hello".into(),
    }]
}

fn request(messages: &[AiMessage]) -> TurnRequest<'_> {
    TurnRequest {
        bridge_port: 4242,
        search: true,
        messages,
        system: Some("scoped context"),
        model: Some("opus"),
    }
}

// ---- discovery and status ---------------------------------------------------

#[test]
fn the_first_directory_holding_claude_wins() {
    let (a, b) = (
        fake("2.1.312", true, "ok", "ok"),
        fake("2.1.312", true, "ok", "ok"),
    );
    assert_eq!(
        find_binary_in(&[a.dir.clone(), b.dir.clone()]),
        Some(a.binary.clone())
    );
    assert_eq!(find_binary_in(&[scratch()]), None);
}

#[tokio::test]
async fn a_missing_binary_is_not_installed() {
    let home = home();
    assert_eq!(
        check_installed(&scratch().join("claude"), &home).await,
        Err(ClaudeError::NotInstalled)
    );
    assert_eq!(
        check_installed(Path::new("claude"), &home).await,
        Err(ClaudeError::NotInstalled)
    );
    assert_eq!(
        status_for(None, &home).await,
        ClaudeStatus {
            installed: false,
            supported: false,
            signed_in: false
        }
    );
}

#[tokio::test]
async fn an_unsupported_version_is_installed_but_not_supported() {
    let home = home();
    for version in ["1.0.0", "3.0.0", "garbage"] {
        let fake = fake(version, true, "ok", "ok");
        assert_eq!(
            check_installed(&fake.binary, &home).await,
            Err(ClaudeError::UnsupportedVersion),
            "{version}"
        );
        assert_eq!(
            status_for(Some(&fake.binary), &home).await,
            ClaudeStatus {
                installed: true,
                supported: false,
                signed_in: false
            }
        );
    }
}

#[tokio::test]
async fn signed_out_and_ready_are_told_apart() {
    let home = home();
    let out = fake("2.1.312", false, "ok", "ok");
    assert_eq!(
        login_status(&out.binary, &home).await,
        Err(ClaudeError::NotLoggedIn)
    );
    assert_eq!(
        status_for(Some(&out.binary), &home).await,
        ClaudeStatus {
            installed: true,
            supported: true,
            signed_in: false
        }
    );
    let ok = ready("ok");
    assert_eq!(login_status(&ok.binary, &home).await, Ok(()));
    assert_eq!(
        status_for(Some(&ok.binary), &home).await,
        ClaudeStatus {
            installed: true,
            supported: true,
            signed_in: true
        }
    );
}

#[tokio::test]
async fn an_unreadable_status_answer_is_a_protocol_error() {
    let fake = ready("ok");
    let script = std::fs::read_to_string(&fake.binary)
        .unwrap()
        .replace("echo '{\"loggedIn\":true}'", "echo 'oops'");
    install(&fake.binary, &script);
    assert_eq!(
        login_status(&fake.binary, &home()).await,
        Err(ClaudeError::Protocol)
    );
}

// ---- sign-in and sign-out ---------------------------------------------------

#[tokio::test]
async fn sign_in_waits_for_the_process_and_checks_the_result() {
    let fake = fake("2.1.312", false, "ok", "ok");
    let home = home();
    let (_cancel, rx) = never_cancelled();
    assert_eq!(login_claude(&fake.binary, &home, rx).await, Ok(()));
    assert_eq!(login_status(&fake.binary, &home).await, Ok(()));
    // The sign-in is stored in the isolated directory the process was given.
    assert!(
        read(&fake.dir, "auth_env").contains(&format!("CLAUDE_CONFIG_DIR={}", home.home.display()))
    );
}

#[tokio::test]
async fn a_failed_sign_in_is_a_rejection() {
    let fake = fake("2.1.312", false, "fail", "ok");
    let (_cancel, rx) = never_cancelled();
    assert_eq!(
        login_claude(&fake.binary, &home(), rx).await,
        Err(ClaudeError::Rejected)
    );
}

#[tokio::test]
async fn a_sign_in_that_ends_without_a_session_is_not_a_success() {
    // Exit code 0 but nothing stored: the status check has the last word.
    let fake = fake("2.1.312", false, "ok", "ok");
    let script = std::fs::read_to_string(&fake.binary)
        .unwrap()
        .replace("touch \"$CLAUDE_CONFIG_DIR/signed\"; ", "");
    install(&fake.binary, &script);
    let (_cancel, rx) = never_cancelled();
    assert_eq!(
        login_claude(&fake.binary, &home(), rx).await,
        Err(ClaudeError::NotLoggedIn)
    );
}

#[tokio::test]
async fn cancelling_a_sign_in_kills_the_process() {
    let fake = fake("2.1.312", false, "wait", "ok");
    let home = home();
    let (cancel, rx) = never_cancelled();
    let binary = fake.binary.clone();
    let task = tokio::spawn(async move { login_claude(&binary, &home, rx).await });
    for _ in 0..100 {
        if !read(&fake.dir, "login_pid").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cancel.send(true).unwrap();
    assert_eq!(task.await.unwrap(), Err(ClaudeError::Cancelled));
    assert_gone(&fake.dir, "login_pid");
}

#[tokio::test]
async fn sign_out_removes_the_stored_session() {
    let fake = fake("2.1.312", false, "ok", "ok");
    let home = home();
    let (_cancel, rx) = never_cancelled();
    login_claude(&fake.binary, &home, rx).await.unwrap();
    logout_claude(&fake.binary, &home).await.unwrap();
    assert_eq!(
        login_status(&fake.binary, &home).await,
        Err(ClaudeError::NotLoggedIn)
    );
}

// ---- catalogue --------------------------------------------------------------

#[tokio::test]
async fn the_catalogue_comes_from_the_initialize_request_and_the_child_is_gone() {
    let fake = ready("ok");
    let (_cancel, rx) = never_cancelled();
    let models = claude_model_catalog(&fake.binary, &home(), rx)
        .await
        .unwrap();
    assert_eq!(
        models,
        [
            ("default".to_owned(), "Default".to_owned()),
            ("opus".to_owned(), "Opus".to_owned())
        ]
    );
    assert!(read(&fake.dir, "args").contains("--restricted"));
    assert!(read(&fake.dir, "args").contains("--strict-mcp-config"));
    assert!(
        read(&fake.dir, "prompt").is_empty(),
        "no prompt may be sent"
    );
    assert_gone(&fake.dir, "pid");
}

#[tokio::test]
async fn the_catalogue_needs_a_sign_in_and_starts_nothing_without_one() {
    let fake = fake("2.1.312", false, "ok", "ok");
    let (_cancel, rx) = never_cancelled();
    assert_eq!(
        claude_model_catalog(&fake.binary, &home(), rx).await,
        Err(ClaudeError::NotLoggedIn)
    );
    assert!(read(&fake.dir, "pid").is_empty());
}

#[tokio::test]
async fn a_broken_catalogue_answer_is_a_protocol_error_and_the_child_is_gone() {
    let fake = ready("garbage");
    let (_cancel, rx) = never_cancelled();
    assert_eq!(
        claude_model_catalog(&fake.binary, &home(), rx).await,
        Err(ClaudeError::Protocol)
    );
    assert_gone(&fake.dir, "pid");
}

#[tokio::test]
async fn cancelling_the_catalogue_kills_the_child() {
    let fake = ready("hang");
    let home = home();
    let (cancel, rx) = never_cancelled();
    let binary = fake.binary.clone();
    // The fake answers, so cancel before it can: the answer is already queued, hence the
    // outcome is either the models or Cancelled, and the child is gone in both.
    cancel.send(true).unwrap();
    let result = claude_model_catalog(&binary, &home, rx).await;
    assert!(matches!(result, Err(ClaudeError::Cancelled) | Ok(_)));
    if !read(&fake.dir, "pid").is_empty() {
        assert_gone(&fake.dir, "pid");
    }
}

// ---- chat turns -------------------------------------------------------------

#[tokio::test]
async fn a_turn_streams_the_answer_in_the_isolated_home() {
    let fake = ready("ok");
    let home = home_with_token(home());
    let (_cancel, rx) = never_cancelled();
    let mut seen = String::new();
    let messages = messages();
    let answer = run_claude_turn(&fake.binary, &home, &request(&messages), rx, |d| {
        seen.push_str(d)
    })
    .await
    .unwrap();
    assert_eq!(answer, "Hello");
    assert_eq!(seen, "Hello");
    let args = read(&fake.dir, "args");
    for flag in [
        "--restricted",
        "--strict-mcp-config",
        "--model opus",
        "dontAsk",
    ] {
        assert!(args.contains(flag), "{flag}");
    }
    assert!(
        !args.contains("bridge-secret"),
        "the token is never an argument"
    );
    assert!(read(&fake.dir, "prompt").contains("User: hello"));
    assert!(read(&fake.dir, "prompt").contains("scoped context"));
    // The process works in the empty workspace with the isolated config directory.
    assert_eq!(
        read(&fake.dir, "cwd").trim(),
        home.workspace.canonicalize().unwrap().display().to_string()
    );
    let env = read(&fake.dir, "env");
    assert!(env.contains(&format!("CLAUDE_CONFIG_DIR={}", home.home.display())));
    assert!(env.contains("AMBY_MCP_TOKEN=bridge-secret"));
    // The token reaches only the chat process, not the version or status checks.
    assert!(!read(&fake.dir, "auth_env").contains("bridge-secret"));
    assert_gone(&fake.dir, "pid");
}

#[tokio::test]
async fn a_signed_out_turn_never_starts_the_chat_process() {
    let fake = fake("2.1.312", false, "ok", "ok");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let result = run_claude_turn(
        &fake.binary,
        &home_with_token(home()),
        &request(&messages),
        rx,
        |_| {},
    )
    .await;
    assert_eq!(result, Err(ClaudeError::NotLoggedIn));
    assert!(read(&fake.dir, "pid").is_empty());
}

#[tokio::test]
async fn an_unsupported_version_never_starts_the_chat_process() {
    let fake = fake("1.9.0", true, "ok", "ok");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let result = run_claude_turn(
        &fake.binary,
        &home_with_token(home()),
        &request(&messages),
        rx,
        |_| {},
    )
    .await;
    assert_eq!(result, Err(ClaudeError::UnsupportedVersion));
    assert!(read(&fake.dir, "pid").is_empty());
}

#[tokio::test]
async fn a_turn_without_a_bridge_token_does_not_run() {
    let fake = ready("ok");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let result = run_claude_turn(&fake.binary, &home(), &request(&messages), rx, |_| {}).await;
    assert_eq!(result, Err(ClaudeError::Io));
    assert!(read(&fake.dir, "pid").is_empty());
}

#[tokio::test]
async fn a_broken_answer_is_a_protocol_error_and_the_child_is_gone() {
    let fake = ready("garbage");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let result = run_claude_turn(
        &fake.binary,
        &home_with_token(home()),
        &request(&messages),
        rx,
        |_| {},
    )
    .await;
    assert_eq!(result, Err(ClaudeError::Protocol));
    assert_gone(&fake.dir, "pid");
}

#[tokio::test]
async fn an_attempt_to_use_another_tool_is_stopped_and_the_child_is_gone() {
    let fake = ready("tool");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let result = run_claude_turn(
        &fake.binary,
        &home_with_token(home()),
        &request(&messages),
        rx,
        |_| {},
    )
    .await;
    assert_eq!(result, Err(ClaudeError::Boundary));
    assert_gone(&fake.dir, "pid");
}

#[tokio::test]
async fn a_process_that_exits_silently_is_an_error() {
    let fake = ready("silent");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let result = run_claude_turn(
        &fake.binary,
        &home_with_token(home()),
        &request(&messages),
        rx,
        |_| {},
    )
    .await;
    assert_eq!(result, Err(ClaudeError::Io));
}

#[tokio::test]
async fn cancelling_a_turn_kills_the_child() {
    let fake = ready("hang");
    let home = home_with_token(home());
    let (cancel, rx) = never_cancelled();
    let binary = fake.binary.clone();
    let task = tokio::spawn(async move {
        let messages = messages();
        run_claude_turn(&binary, &home, &request(&messages), rx, |_| {}).await
    });
    for _ in 0..100 {
        if !read(&fake.dir, "prompt").is_empty() || fake.dir.join("prompt").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cancel.send(true).unwrap();
    assert_eq!(task.await.unwrap(), Err(ClaudeError::Cancelled));
    assert_gone(&fake.dir, "pid");
}

#[tokio::test]
async fn a_silent_child_times_out_and_is_killed() {
    let fake = ready("hang");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let result = run_claude_turn_limited(
        &fake.binary,
        &home_with_token(home()),
        &request(&messages),
        Duration::from_millis(300),
        Duration::from_secs(30),
        rx,
        |_| {},
    )
    .await;
    assert_eq!(result, Err(ClaudeError::Io));
    assert_gone(&fake.dir, "pid");
}

#[tokio::test]
async fn a_turn_that_runs_too_long_is_killed() {
    let fake = ready("hang");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let result = run_claude_turn_limited(
        &fake.binary,
        &home_with_token(home()),
        &request(&messages),
        Duration::from_secs(30),
        Duration::from_millis(500),
        rx,
        |_| {},
    )
    .await;
    assert_eq!(result, Err(ClaudeError::Io));
    assert_gone(&fake.dir, "pid");
}

#[tokio::test]
async fn a_hostile_model_name_is_refused_before_anything_starts() {
    let fake = ready("ok");
    let (_cancel, rx) = never_cancelled();
    let messages = messages();
    let mut bad = request(&messages);
    bad.model = Some("--dangerously-skip-permissions");
    let result = run_claude_turn(&fake.binary, &home_with_token(home()), &bad, rx, |_| {}).await;
    assert_eq!(result, Err(ClaudeError::Rejected));
    assert!(read(&fake.dir, "pid").is_empty());
}
