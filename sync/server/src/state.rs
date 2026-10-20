//! What every handler shares.

use std::sync::Arc;

use crate::clock::Clock;
use crate::config::Config;
use crate::store::{BlobStore, StubBlobStore, StubUserStore, UserStore};

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
}

impl AppState {
    /// Opens the data directory of `config` and builds the state. In the stub stage nothing is
    /// opened: the stores are stubs and every handler answers `not_implemented`. Later this
    /// creates the database and the `instance_id` on first start and keeps both afterwards (П10).
    pub fn open(config: Config, clock: Arc<dyn Clock>) -> Self {
        Self {
            config: Arc::new(config),
            clock,
            blobs: Arc::new(StubBlobStore),
            users: Arc::new(StubUserStore),
        }
    }
}
