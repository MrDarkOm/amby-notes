//! The Codex that Amby runs is isolated from the user's own Codex: its own
//! `CODEX_HOME` inside the app data, a configuration only Amby writes, an empty
//! working directory and a minimal environment. Nothing from `~/.codex` (MCP
//! servers, plugins, hooks, skills, AGENTS.md) and no key from the user's
//! environment reaches it. See "Результат пробы" in docs/ai-codex-provider.md.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::CodexError;

/// Features that must stay off. Codex turns many on by default and the list changes
/// between versions, so this is only the first layer: the guard in `run_turn` is the
/// one that enforces the boundary.
pub const DISABLED_FEATURES: &[&str] = &[
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "hooks",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "image_generation",
    "view_image",
    "multi_agent",
    "in_app_browser",
    "skill_search",
    "tool_suggest",
    "goals",
    "write_stdin_approval",
];

/// The isolated Codex directory and its empty working directory. `bridge_token` is the
/// per-turn secret of Amby's tool bridge; it is only ever given to `app-server`.
#[derive(Clone, PartialEq, Eq)]
pub struct CodexHome {
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub bridge_token: Option<String>,
}

impl std::fmt::Debug for CodexHome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexHome")
            .field("home", &self.home)
            .field("workspace", &self.workspace)
            .field(
                "bridge_token",
                &self.bridge_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl CodexHome {
    pub fn with_bridge_token(mut self, token: String) -> Self {
        self.bridge_token = Some(token);
        self
    }
}

/// The environment variable the bridge's token travels in (never written to a file).
pub const BRIDGE_TOKEN_ENV: &str = "AMBY_MCP_TOKEN";

/// The `config.toml` Amby writes: no MCP servers, no web search, no project docs.
pub fn config_toml() -> String {
    let mut text = String::from(
        "# Written by Amby; changes are overwritten. This Codex is isolated from ~/.codex.\n\
         web_search = \"disabled\"\n\
         project_doc_max_bytes = 0\n\
         \n\
         [features]\n",
    );
    for feature in DISABLED_FEATURES {
        text.push_str(feature);
        text.push_str(" = false\n");
    }
    text
}

/// A directory this module is about to use: absent is fine, a symlink is not.
fn plain_dir(path: &Path) -> Result<(), CodexError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(CodexError::Io),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|_| CodexError::Io)
        }
        Err(_) => Err(CodexError::Io),
    }
}

fn empty_dir(path: &Path) -> Result<(), CodexError> {
    for entry in std::fs::read_dir(path).map_err(|_| CodexError::Io)? {
        let entry = entry.map_err(|_| CodexError::Io)?;
        let kind = entry.file_type().map_err(|_| CodexError::Io)?;
        // `file_type` does not follow links: a link is removed, never entered.
        if kind.is_dir() {
            std::fs::remove_dir_all(entry.path()).map_err(|_| CodexError::Io)?;
        } else {
            std::fs::remove_file(entry.path()).map_err(|_| CodexError::Io)?;
        }
    }
    Ok(())
}

/// The same configuration plus Amby's own MCP server on `127.0.0.1:<port>`. The bearer
/// token is not in the file: Codex reads it from the environment of its process.
pub fn config_toml_with_bridge(port: u16) -> String {
    let mut text = config_toml();
    text.push_str(&format!(
        "\n[mcp_servers.amby]\nurl = \"http://127.0.0.1:{port}/mcp\"\nbearer_token_env_var = \"{BRIDGE_TOKEN_ENV}\"\ndefault_tools_approval_mode = \"approve\"\n"
    ));
    text
}

/// Like `prepare_home`, for a turn that uses the tool bridge on `port`.
pub fn prepare_home_with_bridge(root: &Path, port: u16) -> Result<CodexHome, CodexError> {
    prepare_with(root, &config_toml_with_bridge(port))
}

/// Creates `<root>/codex/` and its empty `workspace/`, and rewrites `config.toml`
/// when it differs. Files Codex keeps there (`auth.json`, databases) are never touched.
pub fn prepare_home(root: &Path) -> Result<CodexHome, CodexError> {
    prepare_with(root, &config_toml())
}

fn prepare_with(root: &Path, wanted: &str) -> Result<CodexHome, CodexError> {
    if !root.is_absolute() || !root.is_dir() {
        return Err(CodexError::Io);
    }
    let home = root.join("codex");
    let workspace = home.join("workspace");
    plain_dir(&home)?;
    plain_dir(&workspace)?;
    empty_dir(&workspace)?;
    let config = home.join("config.toml");
    if std::fs::read_to_string(&config).ok().as_deref() != Some(wanted) {
        crate::frontmatter::atomic_write_bytes(&config, wanted.as_bytes())
            .map_err(|_| CodexError::Io)?;
    }
    Ok(CodexHome {
        home,
        workspace,
        bridge_token: None,
    })
}

/// Names the process needs to run and reach the network, compared in upper case so
/// Windows spellings (`Path`, `SystemRoot`) match. Everything else is dropped.
const KEEP: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LANGUAGE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "USERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// The only environment the Codex process gets, plus `CODEX_HOME`.
pub fn sanitized_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    home: &Path,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = vars
        .into_iter()
        .filter(|(key, _)| {
            let name = key.to_string_lossy().to_uppercase();
            KEEP.contains(&name.as_str()) || name.starts_with("LC_")
        })
        .collect();
    env.push((OsString::from("CODEX_HOME"), home.as_os_str().to_owned()));
    env
}

#[cfg(test)]
mod tests;
