//! Creating users (П38). The suite does not know how: it asks the trait.

use std::process::Command;
use std::sync::{Arc, RwLock};

use amby_sync_server::AppState;
use serde_json::Value;

/// A user with a waiting one-time code (П17).
#[derive(Debug, Clone)]
pub struct EnrollTicket {
    pub username: String,
    pub enroll_code: String,
    pub expires_ms: i64,
}

/// A failed administrator command.
#[derive(Debug, Clone)]
pub struct AdminFailure {
    /// Exit code of the command line (П38), when there is one.
    pub exit_code: Option<i32>,
    pub message: String,
}

/// What a command of appendix Е printed and how it ended (П53).
#[derive(Debug, Clone)]
pub struct AdminOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl AdminOutput {
    /// The standard output as one JSON document (`--json`); fails the test otherwise.
    pub fn json(&self) -> Value {
        assert_eq!(
            self.code, 0,
            "the command failed (exit {}): {}",
            self.code, self.stderr
        );
        serde_json::from_str(self.stdout.trim())
            .unwrap_or_else(|error| panic!("not JSON ({error}): {}", self.stdout))
    }
}

/// `user add` for any kind of server (П38).
pub trait UserAdmin: Send + Sync {
    /// Any administrator command by its words (`["user", "plan", "show", "alice", "--json"]`),
    /// for the commands of appendix Е (П53).
    fn run(&self, args: &[&str]) -> AdminOutput;
    fn user_add(&self, username: &str) -> Result<EnrollTicket, AdminFailure>;
    /// `user remove <name> --yes` (П38).
    fn user_remove(&self, username: &str) -> Result<(), AdminFailure>;
}

/// A direct call into the server that runs in this process.
pub struct InProcessAdmin {
    pub state: Arc<RwLock<AppState>>,
}

impl UserAdmin for InProcessAdmin {
    fn run(&self, args: &[&str]) -> AdminOutput {
        let state = self.state.read().unwrap().clone();
        let output = amby_sync_server::admin::run_cli(&state, args);
        AdminOutput {
            code: output.code,
            stdout: output.stdout,
            stderr: output.stderr,
        }
    }

    fn user_add(&self, username: &str) -> Result<EnrollTicket, AdminFailure> {
        let state = self.state.read().unwrap().clone();
        amby_sync_server::admin::user_add(&state, username)
            .map(|added| EnrollTicket {
                username: added.username,
                enroll_code: added.enroll_code,
                expires_ms: added.expires_ms,
            })
            .map_err(|error| AdminFailure {
                exit_code: Some(error.exit_code()),
                message: error.to_string(),
            })
    }

    fn user_remove(&self, username: &str) -> Result<(), AdminFailure> {
        let state = self.state.read().unwrap().clone();
        amby_sync_server::admin::user_remove(&state, username).map_err(|error| AdminFailure {
            exit_code: Some(error.exit_code()),
            message: error.to_string(),
        })
    }
}

/// A command line, for example `docker exec amby-sync amby-sync-server` (П38).
pub struct CommandAdmin {
    pub command: Vec<String>,
}

impl CommandAdmin {
    /// Splits the command on whitespace.
    pub fn parse(command: &str) -> Self {
        Self {
            command: command.split_whitespace().map(str::to_string).collect(),
        }
    }
}

impl UserAdmin for CommandAdmin {
    fn run(&self, args: &[&str]) -> AdminOutput {
        let (program, base) = self
            .command
            .split_first()
            .expect("AMBY_SYNC_ADMIN_CMD is empty");
        let output = Command::new(program)
            .args(base)
            .args(args)
            .output()
            .unwrap_or_else(|error| panic!("cannot run {program}: {error}"));
        AdminOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    fn user_add(&self, username: &str) -> Result<EnrollTicket, AdminFailure> {
        let (program, args) = self.command.split_first().ok_or_else(|| AdminFailure {
            exit_code: None,
            message: "AMBY_SYNC_ADMIN_CMD is empty".into(),
        })?;
        let output = Command::new(program)
            .args(args)
            .args(["user", "add", username, "--json"])
            .output()
            .map_err(|error| AdminFailure {
                exit_code: None,
                message: format!("cannot run {program}: {error}"),
            })?;
        if !output.status.success() {
            return Err(AdminFailure {
                exit_code: output.status.code(),
                message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or_default();
        let value: Value = serde_json::from_str(line).map_err(|error| AdminFailure {
            exit_code: output.status.code(),
            message: format!("`user add --json` printed no JSON line ({error}): {line}"),
        })?;
        Ok(EnrollTicket {
            username: value["username"].as_str().unwrap_or(username).to_string(),
            enroll_code: value["enroll_code"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            expires_ms: value["expires_ms"].as_i64().unwrap_or(0),
        })
    }

    fn user_remove(&self, username: &str) -> Result<(), AdminFailure> {
        let (program, args) = self.command.split_first().ok_or_else(|| AdminFailure {
            exit_code: None,
            message: "AMBY_SYNC_ADMIN_CMD is empty".into(),
        })?;
        let output = Command::new(program)
            .args(args)
            .args(["user", "remove", username, "--yes"])
            .output()
            .map_err(|error| AdminFailure {
                exit_code: None,
                message: format!("cannot run {program}: {error}"),
            })?;
        if output.status.success() {
            Ok(())
        } else {
            Err(AdminFailure {
                exit_code: output.status.code(),
                message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            })
        }
    }
}
