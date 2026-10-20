//! Server settings from environment variables (П40, П41, table Б.9).

use std::collections::HashMap;
use std::path::PathBuf;

/// Why the settings were refused.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    /// The parsing is not written yet (stage Э2, step 1).
    #[error("not_implemented: configuration parsing")]
    NotImplemented,
    /// A known variable has a value that cannot be used (П40).
    #[error("{name}: {reason}")]
    Invalid {
        /// The variable.
        name: String,
        /// What is wrong with it.
        reason: String,
    },
}

/// The settings of the server (П40). `Default` holds the values of table Б.9.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Directory of the SQLite database and of `blobs/` (`AMBY_SYNC_DATA_DIR`).
    pub data_dir: PathBuf,
    /// Address to listen on (`AMBY_SYNC_LISTEN`).
    pub listen: String,
    /// External address (`AMBY_SYNC_PUBLIC_URL`, П41).
    pub public_url: String,
    /// Allow `http://` for a host that is not localhost (`AMBY_SYNC_ALLOW_HTTP`, П41).
    pub allow_http: bool,
    /// Largest sealed body in bytes (П8).
    pub max_blob_bytes: u64,
    /// Largest number of items in one commit (П8).
    pub max_commit_items: usize,
    /// Largest header envelope in bytes (П8).
    pub max_header_bytes: usize,
    /// Largest JSON request in bytes (П8).
    pub max_json_bytes: usize,
    /// Days to keep old versions and deleted items (П35, П36).
    pub retain_version_days: u64,
    /// Hours to keep a body that no commit refers to (П25).
    pub orphan_blob_hours: u64,
    /// Hours an enrolment code is valid (П17).
    pub enroll_code_hours: u64,
    /// Failed attempts that lock a name (П16).
    pub login_max_failures: u32,
    /// The window in which failed attempts count, in seconds (П16).
    pub login_window_secs: u64,
    /// Seconds between `: ping` lines on an event stream (П34).
    pub sse_keepalive_secs: u64,
}

impl Default for Config {
    /// The defaults of table Б.9.
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("/data"),
            listen: "0.0.0.0:8080".to_string(),
            public_url: "http://localhost:8080".to_string(),
            allow_http: false,
            max_blob_bytes: 536_870_912,
            max_commit_items: 1000,
            max_header_bytes: 16_384,
            max_json_bytes: 16_777_216,
            retain_version_days: 30,
            orphan_blob_hours: 24,
            enroll_code_hours: 24,
            login_max_failures: 5,
            login_window_secs: 900,
            sse_keepalive_secs: 15,
        }
    }
}

impl Config {
    /// Reads the settings from the process environment (П40).
    pub fn from_env() -> Result<Self, ConfigError> {
        let vars: HashMap<String, String> = std::env::vars().collect();
        Self::from_map(&vars)
    }

    /// Reads the settings from a map of variables. Unknown `AMBY_SYNC_` variables are ignored,
    /// a bad value of a known one is an error (П40); `AMBY_SYNC_PUBLIC_URL` must be `https://`
    /// unless the host is local or `AMBY_SYNC_ALLOW_HTTP=1` (П41). A retention of zero is
    /// refused: it would delete everything at once (П35).
    pub fn from_map(_vars: &HashMap<String, String>) -> Result<Self, ConfigError> {
        Err(ConfigError::NotImplemented)
    }
}
