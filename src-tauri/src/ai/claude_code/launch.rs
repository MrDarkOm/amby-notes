//! Finding and starting the user's own `claude` binary. Every process is Amby's child:
//! started for one operation, its stdout read by Amby, and killed and reaped when the
//! operation ends, however it ends. Amby never installs or updates it here.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::home::{sanitized_env, ClaudeHome};
use super::{ClaudeError, LineBuffer, StreamEvent};
use crate::ai::AiMessage;

/// `claude --version` and `claude auth status` must answer within this time.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
/// A sign-in that is not finished within this time is abandoned.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// Fetching the model catalogue is abandoned after this.
pub const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a killed child gets to be reaped before it is abandoned to the OS.
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
/// Handing the prompt to the child may not take longer than this.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Output of the short commands (`--version`, `auth status`) is bounded.
const SHORT_OUTPUT_BYTES: u64 = 64 * 1024;

#[cfg(windows)]
const BINARY_NAME: &str = "claude.exe";
#[cfg(not(windows))]
const BINARY_NAME: &str = "claude";

/// The first `claude` regular file found in `dirs`, in order.
pub fn find_binary_in(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(BINARY_NAME))
        .find(|candidate| std::fs::metadata(candidate).is_ok_and(|meta| meta.is_file()))
}

/// `PATH`, then the usual install locations (`~/.local/bin`, `~/.claude/local`, Homebrew,
/// npm global).
pub fn find_binary() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    dirs.extend(
        ["/opt/homebrew/bin", "/usr/local/bin"]
            .into_iter()
            .map(PathBuf::from),
    );
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        dirs.extend([
            home.join(".local").join("bin"),
            home.join(".claude").join("local"),
            home.join(".npm-global").join("bin"),
            home.join(".bun").join("bin"),
        ]);
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    find_binary_in(&dirs).filter(|path| path.is_absolute())
}

/// Every Claude Code process Amby starts: its own config directory, an empty working
/// directory and a minimal environment.
fn command(binary: &Path, home: &ClaudeHome) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(binary);
    command
        .kill_on_drop(true)
        .env_clear()
        .envs(sanitized_env(std::env::vars_os(), &home.home))
        .current_dir(&home.workspace);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// Runs a short command and returns its exit success and (bounded) stdout.
async fn short(
    binary: &Path,
    home: &ClaudeHome,
    args: &[&str],
) -> Result<(bool, Vec<u8>), ClaudeError> {
    let binary = super::validate_binary(binary)?;
    let mut child = command(&binary, home)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ClaudeError::NotInstalled)?;
    let mut stdout = child.stdout.take().ok_or(ClaudeError::Io)?;
    let outcome = tokio::time::timeout(VERSION_TIMEOUT, async {
        let mut bytes = Vec::new();
        (&mut stdout)
            .take(SHORT_OUTPUT_BYTES)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| ClaudeError::Io)?;
        let status = child.wait().await.map_err(|_| ClaudeError::Io)?;
        Ok::<_, ClaudeError>((status.success(), bytes))
    })
    .await;
    // On a timeout or a bounded read the child may still be alive.
    let _ = child.start_kill();
    let _ = tokio::time::timeout(REAP_TIMEOUT, child.wait()).await;
    outcome.map_err(|_| ClaudeError::Io)?
}

/// Runs `<binary> --version` and checks it against the supported range.
pub async fn check_installed(binary: &Path, home: &ClaudeHome) -> Result<(), ClaudeError> {
    let (success, stdout) = short(binary, home, &["--version"]).await?;
    if !success {
        return Err(ClaudeError::UnsupportedVersion);
    }
    super::check_version(&String::from_utf8_lossy(&stdout))
}

/// `<binary> auth status --json`: succeeds only while Claude Code is signed in.
pub async fn login_status(binary: &Path, home: &ClaudeHome) -> Result<(), ClaudeError> {
    check_installed(binary, home).await?;
    let (_, stdout) = short(binary, home, &["auth", "status", "--json"]).await?;
    let status: Value = serde_json::from_slice(&stdout).map_err(|_| ClaudeError::Protocol)?;
    match status.get("loggedIn").and_then(Value::as_bool) {
        Some(true) => Ok(()),
        Some(false) => Err(ClaudeError::NotLoggedIn),
        None => Err(ClaudeError::Protocol),
    }
}

/// A running child, killed and reaped by `finish` (and on drop).
struct Running {
    child: tokio::process::Child,
}

impl Running {
    async fn finish(mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(REAP_TIMEOUT, self.child.wait()).await;
    }
}

/// Signs in inside the isolated directory. `claude auth login` opens the browser itself
/// and listens for the answer on a local port; Amby only waits, then checks the result.
/// Its stdin stays open and unwritten (the manual "paste the code" prompt waits on it).
pub async fn login_claude(
    binary: &Path,
    home: &ClaudeHome,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<(), ClaudeError> {
    check_installed(binary, home).await?;
    let binary = super::validate_binary(binary)?;
    let child = command(&binary, home)
        .args(["auth", "login", "--claudeai"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ClaudeError::NotInstalled)?;
    let mut running = Running { child };
    let _stdin = running.child.stdin.take();
    let ended = tokio::select! {
        status = tokio::time::timeout(LOGIN_TIMEOUT, running.child.wait()) => match status {
            Ok(Ok(status)) => Ok(status.success()),
            Ok(Err(_)) => Err(ClaudeError::Io),
            Err(_) => Err(ClaudeError::Cancelled),
        },
        _ = async {
            loop {
                if *cancel.borrow() { break }
                if cancel.changed().await.is_err() { std::future::pending::<()>().await }
            }
        } => Err(ClaudeError::Cancelled),
    };
    running.finish().await;
    match ended? {
        true => login_status(&binary, home).await,
        false => Err(ClaudeError::Rejected),
    }
}

/// `<binary> auth logout` inside the isolated directory.
pub async fn logout_claude(binary: &Path, home: &ClaudeHome) -> Result<(), ClaudeError> {
    check_installed(binary, home).await?;
    let (success, _) = short(binary, home, &["auth", "logout"]).await?;
    if success {
        Ok(())
    } else {
        Err(ClaudeError::Rejected)
    }
}

/// The arguments of a chat-shaped process without a prompt, tools or bridge.
fn machine_args() -> Vec<&'static str> {
    vec![
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--tools",
        "",
    ]
}

/// The model catalogue from the machine `initialize` request: no prompt is sent, so
/// nothing is billed. The list does not prove the account may use each model.
pub async fn claude_model_catalog(
    binary: &Path,
    home: &ClaudeHome,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<Vec<(String, String)>, ClaudeError> {
    login_status(binary, home).await?;
    let binary = super::validate_binary(binary)?;
    let mut child = command(&binary, home)
        .args(machine_args())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ClaudeError::NotInstalled)?;
    let (stdin, stdout) = (child.stdin.take(), child.stdout.take());
    let running = Running { child };
    let (Some(mut stdin), Some(mut stdout)) = (stdin, stdout) else {
        running.finish().await;
        return Err(ClaudeError::Io);
    };
    let result = tokio::time::timeout(CATALOG_TIMEOUT, async {
        let request = json!({
            "type": "control_request",
            "request_id": "amby-initialize",
            "request": {"subtype": "initialize"}
        });
        let mut line = request.to_string();
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|_| ClaudeError::Io)?;
        stdin.flush().await.map_err(|_| ClaudeError::Io)?;
        let mut cancel = cancel;
        let mut buffer = LineBuffer::default();
        let mut chunk = [0u8; 8192];
        loop {
            if *cancel.borrow() {
                return Err(ClaudeError::Cancelled);
            }
            let read = tokio::select! {
                read = stdout.read(&mut chunk) => read.map_err(|_| ClaudeError::Io)?,
                _ = cancel.changed() => continue,
            };
            if read == 0 {
                return Err(ClaudeError::Io);
            }
            for line in buffer.push(&chunk[..read])? {
                if let StreamEvent::Control {
                    request_id,
                    response,
                } = super::parse_line(&line)?
                {
                    if request_id == "amby-initialize" {
                        return super::parse_models(&response);
                    }
                }
            }
        }
    })
    .await
    .unwrap_or(Err(ClaudeError::Io));
    running.finish().await;
    result
}

/// What one chat turn is about.
pub struct TurnRequest<'a> {
    pub bridge_port: u16,
    pub search: bool,
    pub messages: &'a [AiMessage],
    pub system: Option<&'a str>,
    pub model: Option<&'a str>,
}

/// One whole turn: check the sign-in, start the chat process with Amby's bridge, hand
/// over the prompt, read the answer, and always kill and reap the child.
pub async fn run_claude_turn(
    binary: &Path,
    home: &ClaudeHome,
    request: &TurnRequest<'_>,
    cancel: tokio::sync::watch::Receiver<bool>,
    on_delta: impl FnMut(&str) + Send,
) -> Result<String, ClaudeError> {
    run_claude_turn_limited(
        binary,
        home,
        request,
        super::IDLE_TIMEOUT,
        super::TURN_TIMEOUT,
        cancel,
        on_delta,
    )
    .await
}

/// `run_claude_turn` with explicit limits (the tests use short ones).
pub async fn run_claude_turn_limited(
    binary: &Path,
    home: &ClaudeHome,
    request: &TurnRequest<'_>,
    idle: Duration,
    total: Duration,
    cancel: tokio::sync::watch::Receiver<bool>,
    on_delta: impl FnMut(&str) + Send,
) -> Result<String, ClaudeError> {
    login_status(binary, home).await?;
    let token = home.bridge_token.as_deref().ok_or(ClaudeError::Io)?;
    let allowed = super::allowed_tool_names(request.search);
    let args = super::turn_args(request.model, request.bridge_port, &allowed)?;
    let prompt = crate::ai::codex::agent::prompt_for(request.messages, request.system);
    let binary = super::validate_binary(binary)?;
    let mut child = command(&binary, home)
        // The bridge's token is for this one process: not for `--version`, not for `auth`.
        .env(super::BRIDGE_TOKEN_ENV, token)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ClaudeError::NotInstalled)?;
    let (stdin, stdout) = (child.stdin.take(), child.stdout.take());
    let running = Running { child };
    let (Some(mut stdin), Some(stdout)) = (stdin, stdout) else {
        running.finish().await;
        return Err(ClaudeError::Io);
    };
    // A child that exits early makes this fail; the stream then reports why.
    let _ = tokio::time::timeout(WRITE_TIMEOUT, async {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await
    })
    .await;
    drop(stdin);
    let result = tokio::time::timeout(
        total,
        super::run_stream(stdout, &allowed, idle, cancel, on_delta),
    )
    .await
    .unwrap_or(Err(ClaudeError::Io));
    running.finish().await;
    result
}

fn failure(error: &ClaudeError) -> crate::ai::AiChatError {
    crate::ai::AiChatError {
        code: super::error_code(error),
        provider: "claude-code".into(),
    }
}

/// At most one sign-in at a time; the button that started it can also cancel it.
#[derive(Default)]
pub struct ClaudeLoginSlot(pub crate::ai::codex::launch::LoginSlot);

/// What the settings screen shows about the user's Claude Code.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    pub supported: bool,
    pub signed_in: bool,
}

/// `None` is "no claude found on this machine".
pub async fn status_for(binary: Option<&Path>, home: &ClaudeHome) -> ClaudeStatus {
    let none = ClaudeStatus {
        installed: false,
        supported: false,
        signed_in: false,
    };
    let Some(binary) = binary else { return none };
    match check_installed(binary, home).await {
        Ok(()) => ClaudeStatus {
            installed: true,
            supported: true,
            signed_in: login_status(binary, home).await.is_ok(),
        },
        Err(ClaudeError::UnsupportedVersion) => ClaudeStatus {
            installed: true,
            ..none
        },
        Err(_) => none,
    }
}

/// The renderer asks this to show whether Claude Code can be used.
#[tauri::command]
#[specta::specta]
pub async fn ai_claude_status(app: tauri::AppHandle) -> ClaudeStatus {
    let _home_guard = super::CLAUDE_HOME_LOCK.lock().await;
    let none = ClaudeStatus {
        installed: false,
        supported: false,
        signed_in: false,
    };
    let Ok(root) = crate::app_data::app_root(&app) else {
        return none;
    };
    let Ok(home) = super::home::prepare_home(&root) else {
        return none;
    };
    let binary = find_binary();
    status_for(binary.as_deref(), &home).await
}

/// The settings screen's "Sign in with Claude": the browser opens and Amby waits.
#[tauri::command]
#[specta::specta]
pub async fn ai_claude_login(
    app: tauri::AppHandle,
    slot: tauri::State<'_, ClaudeLoginSlot>,
) -> Result<(), crate::ai::AiChatError> {
    let (_guard, cancel) = slot
        .0
        .begin()
        .ok_or_else(|| failure(&ClaudeError::Rejected))?;
    let _home_guard = super::CLAUDE_HOME_LOCK.lock().await;
    let root = crate::app_data::app_root(&app).map_err(|_| failure(&ClaudeError::Io))?;
    let home = super::home::prepare_home(&root).map_err(|error| failure(&error))?;
    let binary = find_binary().ok_or_else(|| failure(&ClaudeError::NotInstalled))?;
    login_claude(&binary, &home, cancel)
        .await
        .map_err(|error| failure(&error))
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
#[specta::specta]
pub fn ai_claude_login_cancel(slot: tauri::State<'_, ClaudeLoginSlot>) -> bool {
    slot.0.cancel()
}

/// Removes the sign-in stored for Amby's own Claude Code directory.
#[tauri::command]
#[specta::specta]
pub async fn ai_claude_logout(app: tauri::AppHandle) -> Result<(), crate::ai::AiChatError> {
    let _home_guard = super::CLAUDE_HOME_LOCK.lock().await;
    let root = crate::app_data::app_root(&app).map_err(|_| failure(&ClaudeError::Io))?;
    let home = super::home::prepare_home(&root).map_err(|error| failure(&error))?;
    let binary = find_binary().ok_or_else(|| failure(&ClaudeError::NotInstalled))?;
    logout_claude(&binary, &home)
        .await
        .map_err(|error| failure(&error))
}

#[cfg(test)]
mod tests;
