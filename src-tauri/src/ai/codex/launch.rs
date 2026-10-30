//! Finding and starting the user's own `codex` binary. The process is Amby's child:
//! it is started only for a turn, speaks the protocol on stdio, and is killed when
//! the turn ends, however it ends. Amby never installs or updates it here.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use super::home::{sanitized_env, CodexHome};
use super::{CodexError, TurnInput, TurnOutput};

/// `codex --version` must answer within this time.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(windows)]
const BINARY_NAME: &str = "codex.exe";
#[cfg(not(windows))]
const BINARY_NAME: &str = "codex";

/// How long a killed child gets to be reaped before it is abandoned to the OS.
const REAP_TIMEOUT: Duration = Duration::from_secs(2);

/// The first `codex` regular file found in `dirs`, in order.
pub fn find_binary_in(dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(BINARY_NAME))
        .find(|candidate| std::fs::metadata(candidate).is_ok_and(|meta| meta.is_file()))
}

/// `PATH`, then the usual install locations (Homebrew, /usr/local, ~/.local, npm global).
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
            home.join(".npm-global").join("bin"),
            home.join(".bun").join("bin"),
        ]);
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    find_binary_in(&dirs).filter(|path| path.is_absolute())
}

/// Every Codex process Amby starts: its own home, an empty working directory and a
/// minimal environment. Nothing from the user's `~/.codex` or environment is passed on.
fn command(binary: &Path, home: &CodexHome) -> tokio::process::Command {
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

/// Runs `<binary> --version` and checks it against the supported range.
pub async fn check_installed(binary: &Path, home: &CodexHome) -> Result<(), CodexError> {
    let binary = super::validate_binary(binary)?;
    let output = tokio::time::timeout(
        VERSION_TIMEOUT,
        command(&binary, home)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| CodexError::Io)?
    .map_err(|_| CodexError::NotInstalled)?;
    if !output.status.success() {
        return Err(CodexError::UnsupportedVersion);
    }
    super::check_version(&String::from_utf8_lossy(&output.stdout))
}

/// `<binary> login status`: succeeds only while Codex is signed in.
pub async fn login_status(binary: &Path, home: &CodexHome) -> Result<(), CodexError> {
    check_installed(binary, home).await?;
    let binary = super::validate_binary(binary)?;
    let status = tokio::time::timeout(
        VERSION_TIMEOUT,
        command(&binary, home)
            .args(["login", "status"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| CodexError::Io)?
    .map_err(|_| CodexError::NotInstalled)?;
    if status.success() {
        Ok(())
    } else {
        Err(CodexError::NotLoggedIn)
    }
}

/// A sign-in that is not finished within this time is abandoned.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Signs in inside the isolated home: starts `app-server`, opens the sign-in page through
/// `open_url`, waits for the result, and always kills the child.
pub async fn login_codex(
    binary: &Path,
    home: &CodexHome,
    open_url: impl FnMut(&str) -> bool + Send,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<(), CodexError> {
    let mut app_server = spawn_app_server(binary, home).await?;
    let result = tokio::time::timeout(
        LOGIN_TIMEOUT,
        super::run_login(
            app_server.stdout.take().ok_or(CodexError::Io)?,
            app_server.stdin.take().ok_or(CodexError::Io)?,
            open_url,
            cancel,
        ),
    )
    .await
    .unwrap_or(Err(CodexError::Cancelled));
    app_server.finish().await;
    result
}

/// `<binary> logout` inside the isolated home: removes the stored sign-in.
pub async fn logout_codex(binary: &Path, home: &CodexHome) -> Result<(), CodexError> {
    check_installed(binary, home).await?;
    let binary = super::validate_binary(binary)?;
    let status = tokio::time::timeout(
        VERSION_TIMEOUT,
        command(&binary, home)
            .arg("logout")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| CodexError::Io)?
    .map_err(|_| CodexError::NotInstalled)?;
    if status.success() {
        Ok(())
    } else {
        Err(CodexError::Rejected)
    }
}

/// A running `codex app-server`, killed and reaped by `finish` (and on drop).
struct AppServer {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<tokio::process::ChildStdout>,
}

impl AppServer {
    async fn finish(mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(REAP_TIMEOUT, self.child.wait()).await;
    }
}

async fn spawn_app_server(binary: &Path, home: &CodexHome) -> Result<AppServer, CodexError> {
    check_installed(binary, home).await?;
    let binary = super::validate_binary(binary)?;
    let mut app_server = command(&binary, home);
    // The bridge's token is for this one process: not for `--version`, not for `login`.
    if let Some(token) = &home.bridge_token {
        app_server.env(super::home::BRIDGE_TOKEN_ENV, token);
    }
    let mut child = app_server
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| CodexError::NotInstalled)?;
    let (stdin, stdout) = (child.stdin.take(), child.stdout.take());
    if stdin.is_none() || stdout.is_none() {
        let _ = child.start_kill();
        return Err(CodexError::Io);
    }
    Ok(AppServer {
        child,
        stdin,
        stdout,
    })
}

/// At most one sign-in at a time; the button that started it can also cancel it.
#[derive(Default)]
pub struct LoginSlot(std::sync::Arc<std::sync::Mutex<Option<tokio::sync::watch::Sender<bool>>>>);

/// Held while a sign-in runs; dropping it frees the slot.
pub struct LoginGuard(std::sync::Arc<std::sync::Mutex<Option<tokio::sync::watch::Sender<bool>>>>);

impl LoginSlot {
    /// `None` while another sign-in is running.
    pub fn begin(&self) -> Option<(LoginGuard, tokio::sync::watch::Receiver<bool>)> {
        let mut slot = self.0.lock().ok()?;
        if slot.is_some() {
            return None;
        }
        let (sender, receiver) = tokio::sync::watch::channel(false);
        *slot = Some(sender);
        Some((LoginGuard(self.0.clone()), receiver))
    }

    /// Asks the running sign-in to stop; `false` when none runs.
    pub fn cancel(&self) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|sender| sender.send(true).is_ok()))
            .unwrap_or(false)
    }
}

impl Drop for LoginGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }
}

/// Opens the sign-in page in the user's browser. The caller has already checked the
/// address; it is passed as one argument, never through a shell.
fn open_in_browser(url: &str) -> bool {
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

fn failure(error: &CodexError) -> crate::ai::AiChatError {
    crate::ai::AiChatError {
        code: super::error_code(error),
        provider: "codex".into(),
    }
}

/// The settings screen's "Sign in with ChatGPT": opens the browser and waits.
#[tauri::command]
#[specta::specta]
pub async fn ai_codex_login(
    app: tauri::AppHandle,
    slot: tauri::State<'_, LoginSlot>,
) -> Result<(), crate::ai::AiChatError> {
    let (_guard, cancel) = slot.begin().ok_or_else(|| failure(&CodexError::Rejected))?;
    let root = crate::app_data::app_root(&app).map_err(|_| failure(&CodexError::Io))?;
    let home = super::home::prepare_home(&root).map_err(|error| failure(&error))?;
    let binary = find_binary().ok_or_else(|| failure(&CodexError::NotInstalled))?;
    login_codex(&binary, &home, open_in_browser, cancel)
        .await
        .map_err(|error| failure(&error))
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
#[specta::specta]
pub fn ai_codex_login_cancel(slot: tauri::State<'_, LoginSlot>) -> bool {
    slot.cancel()
}

/// Removes the sign-in stored in Amby's own Codex home.
#[tauri::command]
#[specta::specta]
pub async fn ai_codex_logout(app: tauri::AppHandle) -> Result<(), crate::ai::AiChatError> {
    let root = crate::app_data::app_root(&app).map_err(|_| failure(&CodexError::Io))?;
    let home = super::home::prepare_home(&root).map_err(|error| failure(&error))?;
    let binary = find_binary().ok_or_else(|| failure(&CodexError::NotInstalled))?;
    logout_codex(&binary, &home)
        .await
        .map_err(|error| failure(&error))
}

/// What the settings screen shows about the user's Codex.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub installed: bool,
    pub supported: bool,
    pub signed_in: bool,
}

/// `None` is "no codex found on this machine".
pub async fn status_for(binary: Option<&Path>, home: &CodexHome) -> CodexStatus {
    let none = CodexStatus {
        installed: false,
        supported: false,
        signed_in: false,
    };
    let Some(binary) = binary else { return none };
    match check_installed(binary, home).await {
        Ok(()) => CodexStatus {
            installed: true,
            supported: true,
            signed_in: login_status(binary, home).await.is_ok(),
        },
        Err(CodexError::UnsupportedVersion) => CodexStatus {
            installed: true,
            ..none
        },
        Err(_) => none,
    }
}

/// The renderer asks this to show whether Codex can be used.
#[tauri::command]
#[specta::specta]
pub async fn ai_codex_status(app: tauri::AppHandle) -> CodexStatus {
    let none = CodexStatus {
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

/// One whole turn: validate the binary, check its version, start `app-server`,
/// run the turn, and always kill and reap the child.
pub async fn run_codex_turn(
    binary: &Path,
    home: &CodexHome,
    mut input: TurnInput,
    cancel: tokio::sync::watch::Receiver<bool>,
    on_delta: impl FnMut(&str) + Send,
) -> Result<TurnOutput, CodexError> {
    // The requested directory is ignored: Codex only ever sees its empty workspace.
    input.cwd = home.workspace.clone();
    let mut app_server = spawn_app_server(binary, home).await?;
    let (Some(stdout), Some(stdin)) = (app_server.stdout.take(), app_server.stdin.take()) else {
        app_server.finish().await;
        return Err(CodexError::Io);
    };
    let result = super::run_turn(stdout, stdin, input, cancel, on_delta).await;
    app_server.finish().await;
    result
}

#[cfg(test)]
mod tests;
