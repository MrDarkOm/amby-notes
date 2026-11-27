//! What every handler shares.

use std::sync::Arc;

use tokio::sync::{broadcast, Notify, Semaphore};

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
    /// A space was deleted by its owner: its streams end (Л4).
    SpaceRemoved {
        /// The space.
        space_id: [u8; 16],
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
    /// Places for JSON bodies over 1 MiB read at the same time (Х4).
    pub(crate) large_bodies: Arc<Semaphore>,
    /// The open event streams of each device (Ч2).
    pub(crate) streams: Arc<StreamSlots>,
}

/// Event streams one device may keep open at once (Ч2, Б7). A newer one closes the oldest.
pub(crate) const STREAMS_PER_DEVICE: usize = 4;

/// Per device: its open streams, oldest first, each with its number and the signal that ends it.
type OpenStreams =
    std::collections::HashMap<[u8; 16], std::collections::VecDeque<(u64, Arc<Notify>)>>;

/// The open event streams of every device, oldest first, each with the signal that ends it.
#[derive(Default)]
pub(crate) struct StreamSlots {
    open: std::sync::Mutex<OpenStreams>,
    next: std::sync::atomic::AtomicU64,
}

/// One open stream; dropping it (the stream ended or the client went away) frees its place.
pub(crate) struct StreamSlot {
    slots: Arc<StreamSlots>,
    device_id: [u8; 16],
    id: u64,
    /// Notified when a newer stream of the same device takes this place.
    pub(crate) closed: Arc<Notify>,
}

impl StreamSlots {
    /// Takes a place for a new stream of `device_id`; the oldest beyond the limit is told to end.
    pub(crate) fn open(self: &Arc<Self>, device_id: [u8; 16]) -> StreamSlot {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let closed = Arc::new(Notify::new());
        let mut open = self
            .open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let streams = open.entry(device_id).or_default();
        streams.push_back((id, closed.clone()));
        while streams.len() > STREAMS_PER_DEVICE {
            if let Some((_, oldest)) = streams.pop_front() {
                oldest.notify_one();
            }
        }
        StreamSlot {
            slots: self.clone(),
            device_id,
            id,
            closed,
        }
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut open = self
            .slots
            .open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(streams) = open.get_mut(&self.device_id) {
            streams.retain(|(id, _)| *id != self.id);
            if streams.is_empty() {
                open.remove(&self.device_id);
            }
        }
    }
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
        let large_bodies = Arc::new(Semaphore::new(
            usize::try_from(config.max_large_bodies).unwrap_or(Semaphore::MAX_PERMITS),
        ));
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
            large_bodies,
            streams: Arc::new(StreamSlots::default()),
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
