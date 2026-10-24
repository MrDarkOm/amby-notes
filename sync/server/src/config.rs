//! Server settings from environment variables (П40, П41, table Б.9).

use std::collections::HashMap;
use std::path::PathBuf;

/// Why the settings were refused.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
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
    /// Failed attempts per user name from all addresses together (П16, the soft counter).
    pub login_max_failures_per_user: u32,
    /// The window of the soft counter, in seconds (П16).
    pub login_window_per_user_secs: u64,
    /// Believe `X-Forwarded-For` (the last address) when counting attempts per address
    /// (`AMBY_SYNC_TRUST_PROXY`, П16).
    pub trust_proxy: bool,
    /// Sealed bytes one user may keep (`AMBY_SYNC_QUOTA_BYTES_PER_USER`); `None` is no quota (П42).
    pub quota_bytes_per_user: Option<u64>,
    /// The plans file (`AMBY_SYNC_PLANS_FILE`, П51); `None` is `<data_dir>/plans.json`.
    pub plans_file: Option<PathBuf>,
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
            max_commit_items: 10_000,
            max_header_bytes: 16_384,
            max_json_bytes: 67_108_864,
            retain_version_days: 30,
            orphan_blob_hours: 24,
            enroll_code_hours: 24,
            login_max_failures: 5,
            login_window_secs: 900,
            login_max_failures_per_user: 50,
            login_window_per_user_secs: 3600,
            trust_proxy: false,
            quota_bytes_per_user: None,
            plans_file: None,
            sse_keepalive_secs: 15,
        }
    }
}

impl Config {
    /// Where the plans file is: `AMBY_SYNC_PLANS_FILE`, otherwise `<data_dir>/plans.json` (П51).
    pub fn plans_path(&self) -> PathBuf {
        self.plans_file
            .clone()
            .unwrap_or_else(|| self.data_dir.join("plans.json"))
    }

    /// Reads the settings from the process environment (П40).
    pub fn from_env() -> Result<Self, ConfigError> {
        let vars: HashMap<String, String> = std::env::vars().collect();
        Self::from_map(&vars)
    }

    /// Reads the settings from a map of variables. Unknown `AMBY_SYNC_` variables are ignored,
    /// a bad value of a known one is an error (П40); `AMBY_SYNC_PUBLIC_URL` must be `https://`
    /// unless the host is local or `AMBY_SYNC_ALLOW_HTTP=1` (П41). A retention of zero is
    /// refused: it would delete everything at once (П35).
    pub fn from_map(vars: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let mut config = Self::default();
        let get = |name: &str| vars.get(name).map(String::as_str);
        if let Some(value) = get("AMBY_SYNC_DATA_DIR") {
            config.data_dir = PathBuf::from(non_empty("AMBY_SYNC_DATA_DIR", value)?);
        }
        if let Some(value) = get("AMBY_SYNC_LISTEN") {
            config.listen = non_empty("AMBY_SYNC_LISTEN", value)?.to_string();
        }
        if let Some(value) = get("AMBY_SYNC_PUBLIC_URL") {
            config.public_url = non_empty("AMBY_SYNC_PUBLIC_URL", value)?.to_string();
        }
        if let Some(value) = get("AMBY_SYNC_ALLOW_HTTP") {
            config.allow_http = flag("AMBY_SYNC_ALLOW_HTTP", value)?;
        }
        if let Some(value) = get("AMBY_SYNC_TRUST_PROXY") {
            config.trust_proxy = flag("AMBY_SYNC_TRUST_PROXY", value)?;
        }
        number(vars, "AMBY_SYNC_MAX_BLOB_BYTES", &mut config.max_blob_bytes)?;
        number(
            vars,
            "AMBY_SYNC_MAX_COMMIT_ITEMS",
            &mut config.max_commit_items,
        )?;
        number(
            vars,
            "AMBY_SYNC_MAX_HEADER_BYTES",
            &mut config.max_header_bytes,
        )?;
        number(vars, "AMBY_SYNC_MAX_JSON_BYTES", &mut config.max_json_bytes)?;
        number(
            vars,
            "AMBY_SYNC_RETAIN_VERSION_DAYS",
            &mut config.retain_version_days,
        )?;
        number(
            vars,
            "AMBY_SYNC_ORPHAN_BLOB_HOURS",
            &mut config.orphan_blob_hours,
        )?;
        number(
            vars,
            "AMBY_SYNC_ENROLL_CODE_HOURS",
            &mut config.enroll_code_hours,
        )?;
        number(
            vars,
            "AMBY_SYNC_LOGIN_MAX_FAILURES",
            &mut config.login_max_failures,
        )?;
        number(
            vars,
            "AMBY_SYNC_LOGIN_WINDOW_SECS",
            &mut config.login_window_secs,
        )?;
        number(
            vars,
            "AMBY_SYNC_SSE_KEEPALIVE_SECS",
            &mut config.sse_keepalive_secs,
        )?;
        number(
            vars,
            "AMBY_SYNC_LOGIN_MAX_FAILURES_PER_USER",
            &mut config.login_max_failures_per_user,
        )?;
        number(
            vars,
            "AMBY_SYNC_LOGIN_WINDOW_PER_USER_SECS",
            &mut config.login_window_per_user_secs,
        )?;
        if let Some(value) = get("AMBY_SYNC_QUOTA_BYTES_PER_USER") {
            let mut quota = 0u64;
            number(
                &HashMap::from([(
                    "AMBY_SYNC_QUOTA_BYTES_PER_USER".to_string(),
                    value.to_string(),
                )]),
                "AMBY_SYNC_QUOTA_BYTES_PER_USER",
                &mut quota,
            )?;
            config.quota_bytes_per_user = Some(quota);
        }
        if let Some(value) = get("AMBY_SYNC_PLANS_FILE") {
            config.plans_file = Some(PathBuf::from(non_empty("AMBY_SYNC_PLANS_FILE", value)?));
        }
        check_public_url(&config)?;
        Ok(config)
    }
}

fn invalid(name: &str, reason: &str) -> ConfigError {
    ConfigError::Invalid {
        name: name.to_string(),
        reason: reason.to_string(),
    }
}

fn non_empty<'a>(name: &str, value: &'a str) -> Result<&'a str, ConfigError> {
    if value.trim().is_empty() {
        Err(invalid(name, "must not be empty"))
    } else {
        Ok(value.trim())
    }
}

/// `0`/`1` (also `false`/`true`).
fn flag(name: &str, value: &str) -> Result<bool, ConfigError> {
    match value.trim() {
        "1" | "true" => Ok(true),
        "0" | "false" => Ok(false),
        _ => Err(invalid(name, "must be 0 or 1")),
    }
}

/// A positive whole number. Zero is refused everywhere: a zero limit locks everything out and a
/// zero retention deletes everything at once.
fn number<T>(vars: &HashMap<String, String>, name: &str, target: &mut T) -> Result<(), ConfigError>
where
    T: std::str::FromStr + PartialEq + Default,
{
    if let Some(value) = vars.get(name) {
        let parsed: T = value
            .trim()
            .parse()
            .map_err(|_| invalid(name, "must be a whole number, not negative"))?;
        if parsed == T::default() {
            return Err(invalid(name, "must be greater than zero"));
        }
        *target = parsed;
    }
    Ok(())
}

/// П41: `https://` unless the host is local or `AMBY_SYNC_ALLOW_HTTP=1`.
fn check_public_url(config: &Config) -> Result<(), ConfigError> {
    const NAME: &str = "AMBY_SYNC_PUBLIC_URL";
    let url = config.public_url.trim();
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    let Some(rest) = lower.strip_prefix("http://") else {
        return Err(invalid(
            NAME,
            "must start with https:// (or http:// for a local host)",
        ));
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = if host_port.starts_with('[') {
        host_port
            .find(']')
            .map_or(host_port, |end| &host_port[..=end])
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    if config.allow_http || matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
        Ok(())
    } else {
        Err(invalid(
            NAME,
            "plain http:// is allowed only for localhost; use https:// or set AMBY_SYNC_ALLOW_HTTP=1",
        ))
    }
}
