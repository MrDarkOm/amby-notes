//! The Claude Code that Amby runs is isolated from the user's own: its own
//! `CLAUDE_CONFIG_DIR` inside the app data (the sign-in is stored for that directory
//! only), an empty working directory and a minimal environment. Nothing from `~/.claude`
//! (settings, hooks, MCP servers, plugins, skills, CLAUDE.md) and no key from the user's
//! environment, such as `ANTHROPIC_API_KEY`, reaches it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::ClaudeError;

/// The isolated config directory and its empty working directory. `bridge_token` is the
/// per-turn secret of Amby's tool bridge; it is only ever given to the chat process.
#[derive(Clone, PartialEq, Eq)]
pub struct ClaudeHome {
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub bridge_token: Option<String>,
}

impl std::fmt::Debug for ClaudeHome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeHome")
            .field("home", &self.home)
            .field("workspace", &self.workspace)
            .field(
                "bridge_token",
                &self.bridge_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl ClaudeHome {
    pub fn with_bridge_token(mut self, token: String) -> Self {
        self.bridge_token = Some(token);
        self
    }
}

/// A directory this module is about to use: absent is fine, a symlink is not.
fn plain_dir(path: &Path) -> Result<(), ClaudeError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(ClaudeError::Io),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|_| ClaudeError::Io)
        }
        Err(_) => Err(ClaudeError::Io),
    }
}

fn empty_dir(path: &Path) -> Result<(), ClaudeError> {
    for entry in std::fs::read_dir(path).map_err(|_| ClaudeError::Io)? {
        let entry = entry.map_err(|_| ClaudeError::Io)?;
        let kind = entry.file_type().map_err(|_| ClaudeError::Io)?;
        // `file_type` does not follow links: a link is removed, never entered.
        if kind.is_dir() {
            std::fs::remove_dir_all(entry.path()).map_err(|_| ClaudeError::Io)?;
        } else {
            std::fs::remove_file(entry.path()).map_err(|_| ClaudeError::Io)?;
        }
    }
    Ok(())
}

/// Creates `<root>/claude/` and its empty `workspace/`. Files Claude Code keeps in the
/// config directory (sign-in, caches) are never touched.
pub fn prepare_home(root: &Path) -> Result<ClaudeHome, ClaudeError> {
    if !root.is_absolute() || !root.is_dir() {
        return Err(ClaudeError::Io);
    }
    let home = root.join("claude");
    let workspace = home.join("workspace");
    plain_dir(&home)?;
    plain_dir(&workspace)?;
    empty_dir(&workspace)?;
    Ok(ClaudeHome {
        home,
        workspace,
        bridge_token: None,
    })
}

/// The only environment the process gets, plus `CLAUDE_CONFIG_DIR` and switches that keep
/// it from updating itself or reporting.
pub fn sanitized_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    home: &Path,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = vars
        .into_iter()
        .filter(|(key, _)| {
            let name = key.to_string_lossy().to_uppercase();
            crate::ai::codex::home::KEEP.contains(&name.as_str()) || name.starts_with("LC_")
        })
        .collect();
    env.push((
        OsString::from("CLAUDE_CONFIG_DIR"),
        home.as_os_str().to_owned(),
    ));
    env.push((OsString::from("DISABLE_AUTOUPDATER"), OsString::from("1")));
    env.push((OsString::from("DISABLE_TELEMETRY"), OsString::from("1")));
    env
}

#[cfg(test)]
mod tests;
