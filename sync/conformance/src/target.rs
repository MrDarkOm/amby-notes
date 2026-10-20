//! Where the suite runs: a server in this process, or any address from the environment.

use std::sync::Arc;

use amby_sync_core::crypto::random::{OsRandom, Random};
use amby_sync_server::Config;

use crate::admin::{AdminFailure, CommandAdmin, EnrollTicket, InProcessAdmin, UserAdmin};
use crate::http::Api;
use crate::inprocess::InProcess;

/// JSON limit of a server started by the suite (П8); the container script uses the same value.
pub const TEST_MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
/// Keep-alive of a server started by the suite (П34).
pub const TEST_SSE_KEEPALIVE_SECS: u64 = 1;

/// The server under test.
pub struct Target {
    pub api: Api,
    pub admin: Arc<dyn UserAdmin>,
    process: Option<Arc<InProcess>>,
}

impl Target {
    /// `AMBY_SYNC_URL` and `AMBY_SYNC_ADMIN_CMD` name a running server; without them a fresh
    /// server is started in the process.
    pub fn from_env() -> Self {
        match std::env::var("AMBY_SYNC_URL") {
            Ok(url) if !url.trim().is_empty() => {
                let command = std::env::var("AMBY_SYNC_ADMIN_CMD").unwrap_or_default();
                assert!(
                    !command.trim().is_empty(),
                    "AMBY_SYNC_URL is set, so AMBY_SYNC_ADMIN_CMD must name the admin command \
                     (for example `docker exec amby-sync amby-sync-server`)"
                );
                Self {
                    api: Api::new(&url),
                    admin: Arc::new(CommandAdmin::parse(&command)),
                    process: None,
                }
            }
            _ => Self::in_process(),
        }
    }

    /// A fresh server in this process with the default settings.
    pub fn in_process() -> Self {
        Self::in_process_with(|_| {})
    }

    /// A fresh server in this process with adjusted settings.
    ///
    /// The runs of the suite lower two settings so that the limit tests stay cheap: a JSON limit of
    /// 2 MiB (П8) and a one-second keep-alive (П34). Both are shown by `/v1/info`, and the tests
    /// read them from there. The container script sets the same values through the environment.
    pub fn in_process_with(adjust: impl FnOnce(&mut Config)) -> Self {
        Self::from_process(InProcess::start(|config| {
            config.max_json_bytes = TEST_MAX_JSON_BYTES;
            config.sse_keepalive_secs = TEST_SSE_KEEPALIVE_SECS;
            adjust(config);
        }))
    }

    pub fn from_process(process: InProcess) -> Self {
        let process = Arc::new(process);
        Self {
            api: Api::new(&process.base_url()),
            admin: Arc::new(InProcessAdmin {
                state: process.state.clone(),
            }),
            process: Some(process),
        }
    }

    /// The server in this process: clock, cleanup, restart, data directory. `None` for a
    /// foreign address (see [`crate::in_process_or_skip`]).
    pub fn control(&self) -> Option<&InProcess> {
        self.process.as_deref()
    }

    /// A user name nobody used before: the suite may share one server with other runs.
    pub fn new_username(&self) -> String {
        let mut bytes = [0u8; 6];
        OsRandom.fill(&mut bytes);
        format!("t{}", hex::encode(bytes))
    }

    /// `user add` with a fresh name; a failure fails the test with the reason.
    pub fn new_ticket(&self) -> EnrollTicket {
        let name = self.new_username();
        self.try_user_add(&name)
            .unwrap_or_else(|error| panic!("user add {name} failed: {}", error.message))
    }

    pub fn try_user_add(&self, name: &str) -> Result<EnrollTicket, AdminFailure> {
        self.admin.user_add(name)
    }
}
