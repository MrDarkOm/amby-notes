//! The engine itself (Д2, Д10): one function, [`SyncEngine::sync_cycle`], and the ports it
//! works through. Interface only in stage Э3, step 1; the body is `todo!()`.

use crate::crypto::keys::{SpaceId, SpaceKey};
use crate::crypto::random::Random;

use super::model::{CycleReport, CycleRequest, EngineError};
use super::ports::{Clock, LocalFs, Remote, StateStore};

/// The five ports of one device and one space (Д2).
pub struct Ports {
    /// The vault on disk.
    pub fs: Box<dyn LocalFs>,
    /// The server, signed in, for this space.
    pub remote: Box<dyn Remote>,
    /// The state of the device.
    pub state: Box<dyn StateStore>,
    /// The clock (marks only).
    pub clock: Box<dyn Clock>,
    /// Randomness (item, body and commit ids, nonces: Ф31).
    pub rng: Box<dyn Random>,
}

/// Settings of the engine.
pub struct EngineConfig {
    /// The space.
    pub space_id: SpaceId,
    /// Its key.
    pub vk: SpaceKey,
    /// A mass change needs at least this many files (Р8: 20).
    pub mass_min_files: usize,
    /// … and more than this per cent of the synchronised files (Р8: 10).
    pub mass_percent: usize,
    /// The largest file this device synchronises: bodies are sealed and read whole in memory
    /// until streaming encryption exists (Д71). Larger files are listed as "not synchronised".
    pub max_file_bytes: u64,
}

impl EngineConfig {
    /// The defaults of the plan (Р8, раздел 9).
    pub fn new(space_id: SpaceId, vk: SpaceKey) -> Self {
        Self {
            space_id,
            vk,
            mass_min_files: 20,
            mass_percent: 10,
            max_file_bytes: 256 * 1024 * 1024,
        }
    }
}

/// What a device calls to synchronise (Д2). The real [`Engine`] and the broken mini-engines of
/// the simulation implement it, so the same scenarios run against all of them (раздел 6).
pub trait SyncEngine {
    /// One pass (Д10): look for local changes, read the feed, decide, apply, send. Stops are an
    /// `Ok` report with [`super::model::CycleOutcome::Stopped`] (Д60); a lost network or a failing
    /// store is an error and leaves a state a later pass continues from (Д4, Д19).
    fn sync_cycle(&mut self, request: &CycleRequest) -> Result<CycleReport, EngineError>;

    /// The user resolved a conflict (Д47): it leaves the list.
    fn resolve_conflict(&mut self, id: &str) -> Result<(), EngineError>;
}

/// How the simulation makes an engine; the real one is [`Engine::boxed`].
pub type EngineBuilder = fn(Ports, EngineConfig) -> Box<dyn SyncEngine>;

/// The sync engine of the plan (Э3). Every method is `todo!()` until the second session writes
/// it against the tests.
pub struct Engine {
    _ports: Ports,
    _config: EngineConfig,
}

impl Engine {
    /// Makes an engine for one device and one space.
    pub fn new(ports: Ports, config: EngineConfig) -> Self {
        Self {
            _ports: ports,
            _config: config,
        }
    }

    /// An [`EngineBuilder`] for the real engine.
    pub fn boxed(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
        Box::new(Self::new(ports, config))
    }
}

impl SyncEngine for Engine {
    /// Д10, Р7, Р8, Р9, Р10, Р13, С1–С14: the whole pass.
    fn sync_cycle(&mut self, _request: &CycleRequest) -> Result<CycleReport, EngineError> {
        todo!("Э3: sync engine, appendix В")
    }

    /// Д47: a resolved conflict leaves the list.
    fn resolve_conflict(&mut self, _id: &str) -> Result<(), EngineError> {
        todo!("Д47: resolve a conflict")
    }
}
