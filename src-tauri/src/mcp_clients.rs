//! Connects the open vault to the person's AI clients as an MCP server (`amby mcp`), from Settings.
//!
//! Amby never edits another program's configuration file itself: Claude Code, Codex and
//! Antigravity are asked through their own `mcp add` / `mcp remove` commands, and Cursor through its
//! install link, which asks the person in Cursor. Their files are only read, to show what is
//! connected. Each client keeps its own access (read only or with writes).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// The name the server is registered under in every client.
pub const SERVER_NAME: &str = "amby";
const CLIENT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpClient {
    ClaudeCode,
    Codex,
    Cursor,
    /// Google Antigravity, through its `agy` command.
    Antigravity,
}

pub const CLIENTS: [McpClient; 4] = [
    McpClient::ClaudeCode,
    McpClient::Codex,
    McpClient::Cursor,
    McpClient::Antigravity,
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpClientStatus {
    pub client: McpClient,
    /// The client is installed on this computer.
    pub found: bool,
    /// An `amby` server is registered in the client.
    pub connected: bool,
    /// The vault it serves, when it could be read.
    pub vault: Option<String>,
    /// Whether it may write, when it could be read.
    pub write: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpClientError {
    /// No vault is open, or the request named another one.
    NoVault,
    /// This build has no bundled CLI to register.
    NoCli,
    /// The client is not installed.
    ClientMissing,
    /// Cursor removes servers in its own settings.
    Unsupported,
    Failed,
}

/// What a client runs: the program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// The `amby mcp` command for `vault`: the CLI beside the app, or the AppImage with `--amby-cli`.
pub fn launch(cli: &Path, prefix: &[&str], vault: &Path, write: bool) -> Launch {
    let mut args: Vec<String> = prefix.iter().map(|arg| (*arg).to_owned()).collect();
    args.extend([
        "--vault".to_owned(),
        vault.to_string_lossy().into_owned(),
        "mcp".to_owned(),
    ]);
    if write {
        args.push("--allow-write".to_owned());
    }
    Launch {
        program: cli.to_path_buf(),
        args,
    }
}

/// The bundled CLI of this app and the arguments that come before its own.
pub fn bundled_cli() -> Option<(PathBuf, Vec<&'static str>)> {
    #[cfg(target_os = "linux")]
    if let Some(image) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        if image.is_file() {
            return Some((image, vec!["--amby-cli"]));
        }
    }
    let name = if cfg!(windows) { "amby.exe" } else { "amby" };
    let cli = std::env::current_exe().ok()?.with_file_name(name);
    cli.is_file().then(|| (cli, Vec::new()))
}

/// The vault and write mode read back from a registered command's arguments.
fn served(args: &[String]) -> (Option<String>, Option<bool>) {
    let vault = args
        .iter()
        .position(|arg| arg == "--vault")
        .and_then(|at| args.get(at + 1))
        .cloned();
    let write = args.iter().any(|arg| arg.starts_with("--allow-write"));
    (vault, Some(write))
}

/// `mcpServers.amby` of a JSON configuration (Claude Code's `~/.claude.json`, Cursor's `mcp.json`,
/// Antigravity's `mcp_config.json`).
pub fn status_from_json(text: &str) -> Option<(Option<String>, Option<bool>)> {
    let value: Value = serde_json::from_str(text).ok()?;
    let server = value.get("mcpServers")?.get(SERVER_NAME)?;
    let args: Vec<String> = server
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(|arg| arg.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Some(served(&args))
}

/// `[mcp_servers.amby]` of Codex's `config.toml`. Only the `args` line is read back; a value that is
/// not a plain string array still counts as connected.
pub fn status_from_toml(text: &str) -> Option<(Option<String>, Option<bool>)> {
    let header = format!("[mcp_servers.{SERVER_NAME}]");
    let mut lines = text.lines().skip_while(|line| line.trim() != header);
    lines.next()?;
    for line in lines {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        if let Some(value) = line.strip_prefix("args").map(str::trim_start) {
            if let Some(array) = value.strip_prefix('=') {
                if let Ok(args) = serde_json::from_str::<Vec<String>>(array.trim()) {
                    return Some(served(&args));
                }
            }
        }
    }
    Some((None, None))
}

/// Cursor's install link: the server configuration as base64 JSON. Cursor shows it and asks.
pub fn cursor_link(launch: &Launch) -> String {
    use base64::Engine as _;
    let config = serde_json::json!({
        "command": launch.program.to_string_lossy(),
        "args": launch.args,
    });
    let encoded = base64::engine::general_purpose::STANDARD.encode(config.to_string());
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query
        .append_pair("name", SERVER_NAME)
        .append_pair("config", &encoded);
    format!(
        "cursor://anysphere.cursor-deeplink/mcp/install?{}",
        query.finish()
    )
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn codex_config() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(".codex")))
        .map(|dir| dir.join("config.toml"))
}

fn cursor_dir() -> Option<PathBuf> {
    home().map(|home| home.join(".cursor"))
}

/// Antigravity's own configuration of MCP servers, written by `agy mcp add`.
fn antigravity_config() -> Option<PathBuf> {
    home().map(|home| home.join(".gemini").join("config").join("mcp_config.json"))
}

/// The first `name` in `dirs` that is a file.
fn find_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file() && candidate.is_absolute())
}

/// `agy`: `PATH`, `~/.local/bin` (where its installer puts it) and the one inside the app.
fn antigravity_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) { "agy.exe" } else { "agy" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = home() {
        dirs.push(home.join(".local").join("bin"));
    }
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/Applications/Gemini.app/Contents/Helpers"));
    }
    find_in(&dirs, name)
}

fn binary(client: McpClient) -> Option<PathBuf> {
    match client {
        McpClient::ClaudeCode => crate::ai::claude_code::launch::find_binary(),
        McpClient::Codex => crate::ai::codex::launch::find_binary(),
        McpClient::Antigravity => antigravity_binary(),
        McpClient::Cursor => None,
    }
}

pub fn status(client: McpClient) -> McpClientStatus {
    let read = |path: Option<PathBuf>| path.and_then(|path| std::fs::read_to_string(path).ok());
    let (found, served) = match client {
        McpClient::ClaudeCode => (
            binary(client).is_some(),
            read(home().map(|home| home.join(".claude.json")))
                .and_then(|text| status_from_json(&text)),
        ),
        McpClient::Codex => (
            binary(client).is_some(),
            read(codex_config()).and_then(|text| status_from_toml(&text)),
        ),
        McpClient::Antigravity => (
            binary(client).is_some(),
            read(antigravity_config()).and_then(|text| status_from_json(&text)),
        ),
        McpClient::Cursor => (
            cursor_dir().is_some_and(|dir| dir.is_dir()),
            read(cursor_dir().map(|dir| dir.join("mcp.json")))
                .and_then(|text| status_from_json(&text)),
        ),
    };
    let (vault, write) = served.clone().unwrap_or((None, None));
    McpClientStatus {
        client,
        found,
        connected: served.is_some(),
        vault,
        write,
    }
}

/// Runs a client's own command with the person's environment. A GUI app does not inherit the shell's
/// `PATH`, so the client's folder and the usual tool folders are put in front (Node-based clients
/// need `node` beside them).
fn run(binary: &Path, args: &[String]) -> Result<bool, McpClientError> {
    let mut path: Vec<PathBuf> = binary.parent().map(Path::to_path_buf).into_iter().collect();
    if !cfg!(windows) {
        path.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    if let Some(current) = std::env::var_os("PATH") {
        path.extend(std::env::split_paths(&current));
    }
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Ok(joined) = std::env::join_paths(path) {
        command.env("PATH", joined);
    }
    if let Some(home) = home() {
        command.current_dir(home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|_| McpClientError::Failed)?;
    let deadline = Instant::now() + CLIENT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(McpClientError::Failed);
            }
        }
    }
}

fn add_args(client: McpClient, launch: &Launch) -> Vec<String> {
    let head: &[&str] = match client {
        McpClient::ClaudeCode => &["mcp", "add", "--scope", "user", SERVER_NAME, "--"],
        _ => &["mcp", "add", SERVER_NAME, "--"],
    };
    let mut args: Vec<String> = head.iter().map(|arg| (*arg).to_owned()).collect();
    args.push(launch.program.to_string_lossy().into_owned());
    args.extend(launch.args.iter().cloned());
    args
}

fn remove_args(client: McpClient) -> Vec<String> {
    match client {
        McpClient::ClaudeCode => vec!["mcp", "remove", SERVER_NAME, "--scope", "user"],
        _ => vec!["mcp", "remove", SERVER_NAME],
    }
    .into_iter()
    .map(str::to_owned)
    .collect()
}

/// Registers `launch` in the client, replacing an earlier `amby` registration.
pub fn connect(client: McpClient, launch: &Launch) -> Result<McpClientStatus, McpClientError> {
    if client == McpClient::Cursor {
        crate::system_open::open_address(&cursor_link(launch))
            .map_err(|_| McpClientError::Failed)?;
        return Ok(status(client));
    }
    let binary = binary(client).ok_or(McpClientError::ClientMissing)?;
    if status(client).connected {
        run(&binary, &remove_args(client))?;
    }
    if !run(&binary, &add_args(client, launch))? {
        return Err(McpClientError::Failed);
    }
    Ok(status(client))
}

pub fn disconnect(client: McpClient) -> Result<McpClientStatus, McpClientError> {
    if client == McpClient::Cursor {
        return Err(McpClientError::Unsupported);
    }
    let binary = binary(client).ok_or(McpClientError::ClientMissing)?;
    if status(client).connected && !run(&binary, &remove_args(client))? {
        return Err(McpClientError::Failed);
    }
    Ok(status(client))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Launch {
        launch(
            Path::new("/Applications/Amby.app/Contents/MacOS/amby"),
            &[],
            Path::new("/Users/p/Notes"),
            true,
        )
    }

    #[test]
    fn the_command_serves_one_vault_and_writes_only_when_asked() {
        assert_eq!(
            sample().args,
            ["--vault", "/Users/p/Notes", "mcp", "--allow-write"]
        );
        let image = launch(
            Path::new("/opt/Amby.AppImage"),
            &["--amby-cli"],
            Path::new("/v"),
            false,
        );
        assert_eq!(image.args, ["--amby-cli", "--vault", "/v", "mcp"]);
    }

    #[test]
    fn claude_code_and_codex_are_asked_through_their_own_commands() {
        let claude = add_args(McpClient::ClaudeCode, &sample());
        assert_eq!(
            &claude[..6],
            ["mcp", "add", "--scope", "user", "amby", "--"]
        );
        assert_eq!(claude[6], "/Applications/Amby.app/Contents/MacOS/amby");
        assert_eq!(
            &add_args(McpClient::Codex, &sample())[..4],
            ["mcp", "add", "amby", "--"]
        );
        assert_eq!(
            remove_args(McpClient::ClaudeCode),
            ["mcp", "remove", "amby", "--scope", "user"]
        );
    }

    #[test]
    fn antigravity_is_asked_through_agy_and_read_back_from_its_configuration() {
        let add = add_args(McpClient::Antigravity, &sample());
        assert_eq!(&add[..4], ["mcp", "add", "amby", "--"]);
        assert_eq!(
            &add[5..],
            ["--vault", "/Users/p/Notes", "mcp", "--allow-write"]
        );
        assert_eq!(
            remove_args(McpClient::Antigravity),
            ["mcp", "remove", "amby"]
        );
        // As `agy mcp add` writes it.
        let config = r#"{"mcpServers":{"amby":{"args":["--vault","/Users/p/Notes","mcp"],"command":"/a/amby","disabled":false}}}"#;
        assert_eq!(
            status_from_json(config),
            Some((Some("/Users/p/Notes".into()), Some(false)))
        );
    }

    #[test]
    fn a_registration_is_read_back_from_each_configuration() {
        let json = r#"{"projects":{},"mcpServers":{"other":{},"amby":{"command":"/a/amby","args":["--vault","/Users/p/Notes","mcp"]}}}"#;
        assert_eq!(
            status_from_json(json),
            Some((Some("/Users/p/Notes".into()), Some(false)))
        );
        assert_eq!(status_from_json(r#"{"mcpServers":{"other":{}}}"#), None);
        assert_eq!(status_from_json("not json"), None);

        let toml = "model = \"x\"\n\n[mcp_servers.amby]\ncommand = \"/a/amby\"\nargs = [\"--vault\", \"/Users/p/Notes\", \"mcp\", \"--allow-write\"]\n\n[mcp_servers.other]\nargs = [\"--vault\", \"/x\"]\n";
        assert_eq!(
            status_from_toml(toml),
            Some((Some("/Users/p/Notes".into()), Some(true)))
        );
        assert_eq!(status_from_toml("[mcp_servers.amby_old]\n"), None);
        assert_eq!(
            status_from_toml("[mcp_servers.amby]\nargs = ['--vault']\n"),
            Some((None, None))
        );
    }

    #[test]
    fn the_cursor_link_carries_the_command_as_base64_json() {
        use base64::Engine as _;
        let link = cursor_link(&sample());
        let query = link
            .strip_prefix("cursor://anysphere.cursor-deeplink/mcp/install?")
            .unwrap();
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(pairs[0], ("name".into(), "amby".into()));
        let config: Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(&pairs[1].1)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            config["command"],
            "/Applications/Amby.app/Contents/MacOS/amby"
        );
        assert_eq!(config["args"][1], "/Users/p/Notes");
    }
}
