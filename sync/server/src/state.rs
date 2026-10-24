//! What every handler shares.

use std::sync::Arc;

use tokio::sync::broadcast;

use crate::clock::Clock;
use crate::config::Config;
use crate::db::{Db, DbError};
use crate::plans::{PlansError, PlansFile};
use crate::store::{BlobStore, DbUserStore, FsBlobStore, UserStore};

/// Something the open event streams (П34) must hear about.
#[derive(Debug, Clone)]
pub(crate) enum HubEvent {
    /// A commit was accepted.
    Commit {
        /// The space.
        space_id: [u8; 16],
        /// The new head.
        seq: u64,
        /// The device that committed.
        device_id: [u8; 16],
        /// How many items the commit holds.
        items: usize,
    },
    /// The token of a device was revoked: its streams end (П19, П34).
    Revoked {
        /// The device.
        device_id: [u8; 16],
    },
}

/// The shared state of the server: settings, clock and the stores behind interfaces (Р11).
#[derive(Clone)]
pub struct AppState {
    /// The settings.
    pub config: Arc<Config>,
    /// The only source of time (П37).
    pub clock: Arc<dyn Clock>,
    /// Bodies.
    pub blobs: Arc<dyn BlobStore>,
    /// Users.
    pub users: Arc<dyn UserStore>,
    /// The plans read from the file when the state was opened (П51).
    pub(crate) plans: Arc<PlansFile>,
    /// Why the plans file could not be read, if so. Opening stays lenient (see
    /// [`AppState::check_plans`]); `plans` is then empty.
    pub(crate) plans_error: Option<PlansError>,
    pub(crate) db: Arc<Db>,
    pub(crate) files: Arc<FsBlobStore>,
    pub(crate) hub: broadcast::Sender<HubEvent>,
}

impl AppState {
    /// Opens the data directory of `config` and builds the state. The database and the
    /// `instance_id` are created on first start and kept afterwards (П10).
    ///
    /// # Panics
    /// When the data directory cannot be opened; the server cannot run without it. Use
    /// [`AppState::try_open`] to handle the error.
    pub fn open(config: Config, clock: Arc<dyn Clock>) -> Self {
        Self::try_open(config, clock)
            .unwrap_or_else(|error| panic!("cannot open the data directory: {error}"))
    }

    /// The same as [`AppState::open`], returning the reason instead of panicking.
    pub fn try_open(config: Config, clock: Arc<dyn Clock>) -> Result<Self, DbError> {
        let db = Arc::new(Db::open(&config.data_dir, clock.now_ms())?);
        let files = Arc::new(FsBlobStore::new(&config.data_dir));
        let users = Arc::new(DbUserStore::new(db.clone(), files.clone(), clock.clone()));
        let (hub, _) = broadcast::channel(1024);
        let (plans, plans_error) = match PlansFile::load(&config.plans_path()) {
            Ok(plans) => (plans, None),
            Err(error) => (PlansFile::default(), Some(error)),
        };
        Ok(Self {
            plans: Arc::new(plans),
            plans_error,
            config: Arc::new(config),
            clock,
            blobs: files.clone(),
            users,
            db,
            files,
            hub,
        })
    }

    /// The start-up check of appendix Е: the plans file is valid (П51) and every pinned user's
    /// plan is in it (П52). `serve` calls it before it listens; `try_open` itself stays lenient,
    /// so that `plans check` and `user plan set <name> --default` can run on a state whose file
    /// has a problem (that is how the problem is cured).
    pub fn check_plans(&self) -> Result<(), PlansError> {
        if let Some(error) = &self.plans_error {
            return Err(error.clone());
        }
        let pinned = self
            .pinned_plans()
            .map_err(|error| PlansError::Io(error.to_string()))?;
        self.plans.check_pinned(&pinned)
    }

    /// Every `(user, plan)` that is pinned.
    pub(crate) fn pinned_plans(&self) -> rusqlite::Result<Vec<(String, String)>> {
        self.db.call(|conn| {
            let mut statement = conn
                .prepare("SELECT username, plan FROM users WHERE plan IS NOT NULL ORDER BY id")?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect()
        })
    }
}
