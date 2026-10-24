//! Deliberately broken engines for the limits of appendix Е (strength of the tests, раздел 6): the
//! real engine with one rule of the plan taken away or reversed, by decorating its ports. The
//! scenarios of [`crate::limits`] must catch each of them with the invariant it breaks and pass
//! the real engine.

use std::cell::RefCell;
use std::io::Read;
use std::rc::Rc;

use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::engine::{
    AccountInfo, BlobState, ChangesPage, CommitItem, CommitReply, CycleOutcome, CycleReport,
    CycleRequest, Direction, Engine, EngineBuilder, EngineConfig, EngineError, FsError, Listing,
    LocalFs, NameRules, Ports, Remote, RemoteError, RootState, ServerInfo, StagedWrite, StateError,
    StateLock, StateOp, StateStore, StopReason, SyncEngine, SyncState, TrashReason, UnsyncedReason,
};

use crate::invariants::Kind;

/// A flaw of the engine or of the server's pruning that the scenarios of limits must catch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitFlaw {
    /// A file refused for its size or for the quota is moved to the trash (Д74, Д75).
    DeletesRefusedFile,
    /// The record of the commit is dropped when the quota refused it (Д76, С2).
    DropsSendRecordOn507,
    /// A refusal by a limit is reported as a stop for a mass change (Д78-в).
    RefusalsAreMassChanges,
    /// A refused `blob_start` is repeated again and again in one pass (Д75).
    RetriesOverQuota,
    /// The pruning of the history under the ceiling removes a latest version (П57-д). A model of
    /// the server, not of the engine.
    PrunesLatestVersion,
}

/// Every flaw with the invariant that must catch it.
pub const ALL_LIMIT_FLAWS: [(LimitFlaw, Kind); 5] = [
    (LimitFlaw::DeletesRefusedFile, Kind::LimitTouchedLocal),
    (LimitFlaw::DropsSendRecordOn507, Kind::SendRecordLost),
    (LimitFlaw::RefusalsAreMassChanges, Kind::LimitMassChange),
    (LimitFlaw::RetriesOverQuota, Kind::LimitRetryStorm),
    (LimitFlaw::PrunesLatestVersion, Kind::HistoryCeiling),
];

/// The builder of the engine with the flaw (the server flaw uses the real engine).
pub fn builder_of(flaw: LimitFlaw) -> EngineBuilder {
    match flaw {
        LimitFlaw::DeletesRefusedFile => deletes_refused_file,
        LimitFlaw::DropsSendRecordOn507 => drops_send_record,
        LimitFlaw::RefusalsAreMassChanges => refusals_are_mass_changes,
        LimitFlaw::RetriesOverQuota => retries_over_quota,
        LimitFlaw::PrunesLatestVersion => Engine::boxed,
    }
}

// ----- shared handles of the ports -----

struct SharedFs(Rc<RefCell<Box<dyn LocalFs>>>);

impl LocalFs for SharedFs {
    fn root_state(&mut self) -> Result<RootState, FsError> {
        self.0.borrow_mut().root_state()
    }
    fn list(&mut self) -> Result<Listing, FsError> {
        self.0.borrow_mut().list()
    }
    fn read(&mut self, path: &str) -> Result<Vec<u8>, FsError> {
        self.0.borrow_mut().read(path)
    }
    fn begin_write(&mut self, path: &str) -> Result<Box<dyn StagedWrite>, FsError> {
        self.0.borrow_mut().begin_write(path)
    }
    fn create_dir(&mut self, path: &str) -> Result<(), FsError> {
        self.0.borrow_mut().create_dir(path)
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<(), FsError> {
        self.0.borrow_mut().rename(from, to)
    }
    fn move_to_trash(&mut self, path: &str, reason: TrashReason) -> Result<(), FsError> {
        self.0.borrow_mut().move_to_trash(path, reason)
    }
    fn remove_empty_dir(&mut self, path: &str) -> Result<bool, FsError> {
        self.0.borrow_mut().remove_empty_dir(path)
    }
    fn recovery_pending(&mut self) -> Result<bool, FsError> {
        self.0.borrow_mut().recovery_pending()
    }
    fn cleanup_staged(&mut self) -> Result<(), FsError> {
        self.0.borrow_mut().cleanup_staged()
    }
    fn name_rules(&self) -> NameRules {
        self.0.borrow().name_rules()
    }
    fn batch_begin(&mut self) {
        self.0.borrow_mut().batch_begin();
    }
    fn batch_end(&mut self) {
        self.0.borrow_mut().batch_end();
    }
}

struct SharedState(Rc<RefCell<Box<dyn StateStore>>>);

impl StateStore for SharedState {
    fn load(&mut self) -> Result<SyncState, StateError> {
        self.0.borrow_mut().load()
    }
    fn apply(&mut self, tx: &Vec<StateOp>) -> Result<(), StateError> {
        self.0.borrow_mut().apply(tx)
    }
    fn lock(&mut self) -> Result<StateLock, StateError> {
        self.0.borrow_mut().lock()
    }
    fn base_put(&mut self, item: &ItemId, hash: &[u8; 32], bytes: &[u8]) -> Result<(), StateError> {
        self.0.borrow_mut().base_put(item, hash, bytes)
    }
    fn base_get(&mut self, item: &ItemId, hash: &[u8; 32]) -> Result<Option<Vec<u8>>, StateError> {
        self.0.borrow_mut().base_get(item, hash)
    }
    fn base_prune(&mut self, keep: &[(ItemId, [u8; 32])]) -> Result<(), StateError> {
        self.0.borrow_mut().base_prune(keep)
    }
}

/// A remote that repeats a refused `blob_start` (the flaw `RetriesOverQuota`).
struct RetryingRemote {
    inner: Box<dyn Remote>,
}

impl Remote for RetryingRemote {
    fn info(&mut self) -> Result<ServerInfo, RemoteError> {
        self.inner.info()
    }
    fn changes(&mut self, since: u64, limit: Option<u32>) -> Result<ChangesPage, RemoteError> {
        self.inner.changes(since, limit)
    }
    fn account(&mut self) -> Result<AccountInfo, RemoteError> {
        self.inner.account()
    }
    fn blob_start(
        &mut self,
        blob: &BodyId,
        size: u64,
        replaces: Option<&ItemId>,
    ) -> Result<BlobState, RemoteError> {
        let mut answer = self.inner.blob_start(blob, size, replaces);
        for _ in 0..30 {
            if !matches!(answer, Err(RemoteError::Rejected { .. })) {
                break;
            }
            answer = self.inner.blob_start(blob, size, replaces);
        }
        answer
    }
    fn blob_delete(&mut self, blob: &BodyId) -> Result<(), RemoteError> {
        self.inner.blob_delete(blob)
    }
    fn blob_put_part(&mut self, blob: &BodyId, part: u64, bytes: &[u8]) -> Result<(), RemoteError> {
        self.inner.blob_put_part(blob, part, bytes)
    }
    fn blob_complete(&mut self, blob: &BodyId) -> Result<(), RemoteError> {
        self.inner.blob_complete(blob)
    }
    fn blob_download(&mut self, blob: &BodyId) -> Result<Box<dyn Read + '_>, RemoteError> {
        self.inner.blob_download(blob)
    }
    fn commit(
        &mut self,
        commit_id: &[u8; 16],
        items: &[CommitItem],
    ) -> Result<CommitReply, RemoteError> {
        self.inner.commit(commit_id, items)
    }
}

/// The real engine and the handles needed to spoil what it did.
struct Broken {
    inner: Box<dyn SyncEngine>,
    fs: Rc<RefCell<Box<dyn LocalFs>>>,
    state: Rc<RefCell<Box<dyn StateStore>>>,
    flaw: LimitFlaw,
}

fn refused(report: &CycleReport) -> Vec<String> {
    report
        .unsynced
        .iter()
        .filter(|item| {
            matches!(
                item.reason,
                UnsyncedReason::TooLarge { .. } | UnsyncedReason::QuotaFull
            )
        })
        .map(|item| item.path.clone())
        .collect()
}

impl SyncEngine for Broken {
    fn sync_cycle(&mut self, request: &CycleRequest) -> Result<CycleReport, EngineError> {
        let mut report = self.inner.sync_cycle(request)?;
        let paths = refused(&report);
        match self.flaw {
            LimitFlaw::DeletesRefusedFile => {
                for path in &paths {
                    let _ = self
                        .fs
                        .borrow_mut()
                        .move_to_trash(path, TrashReason::RemoteDeletion);
                }
            }
            LimitFlaw::DropsSendRecordOn507 => {
                if report
                    .unsynced
                    .iter()
                    .any(|item| item.reason == UnsyncedReason::QuotaFull)
                {
                    let _ = self
                        .state
                        .borrow_mut()
                        .apply(&vec![StateOp::SetCommit(None)]);
                }
            }
            LimitFlaw::RefusalsAreMassChanges => {
                if !paths.is_empty() {
                    report.outcome = CycleOutcome::Stopped(StopReason::MassChange {
                        direction: Direction::Outgoing,
                        files: Vec::new(),
                    });
                }
            }
            LimitFlaw::RetriesOverQuota | LimitFlaw::PrunesLatestVersion => {}
        }
        Ok(report)
    }

    fn resolve_conflict(&mut self, id: &str) -> Result<(), EngineError> {
        self.inner.resolve_conflict(id)
    }
}

fn wrap(ports: Ports, config: EngineConfig, flaw: LimitFlaw) -> Box<dyn SyncEngine> {
    let fs = Rc::new(RefCell::new(ports.fs));
    let state = Rc::new(RefCell::new(ports.state));
    let remote: Box<dyn Remote> = if flaw == LimitFlaw::RetriesOverQuota {
        Box::new(RetryingRemote {
            inner: ports.remote,
        })
    } else {
        ports.remote
    };
    let inner = Engine::boxed(
        Ports {
            fs: Box::new(SharedFs(fs.clone())),
            remote,
            state: Box::new(SharedState(state.clone())),
            clock: ports.clock,
            rng: ports.rng,
        },
        config,
    );
    Box::new(Broken {
        inner,
        fs,
        state,
        flaw,
    })
}

fn deletes_refused_file(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
    wrap(ports, config, LimitFlaw::DeletesRefusedFile)
}
fn drops_send_record(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
    wrap(ports, config, LimitFlaw::DropsSendRecordOn507)
}
fn refusals_are_mass_changes(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
    wrap(ports, config, LimitFlaw::RefusalsAreMassChanges)
}
fn retries_over_quota(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
    wrap(ports, config, LimitFlaw::RetriesOverQuota)
}
