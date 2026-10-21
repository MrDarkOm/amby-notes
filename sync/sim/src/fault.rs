//! Faults of the simulation: the process dies at the N-th call of a port, a request does not
//! reach the server, an answer is lost, the server lies (an old version, damaged data), the user
//! edits a file in the middle of a pass. Every port of a device is wrapped, and all wrappers share
//! one [`Faults`], so "the N-th call" counts calls across the file system, the server and the
//! state store in the order the engine made them.

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::io::Read;
use std::rc::Rc;

use amby_sync_core::crypto::header::open_header;
use amby_sync_core::crypto::keys::{BodyId, SpaceId, SpaceKey};
use amby_sync_core::engine::{
    BlobState, ChangesPage, CommitItem, CommitReply, FsError, Listing, LocalFs, NameRules, Remote,
    RemoteError, RootState, ServerInfo, StagedWrite, StateError, StateLock, StateStore, StateTx,
    SyncState, TrashReason,
};

use crate::vfs::Hash;

/// The text of every error a dead process gives.
pub const PROCESS_DIED: &str = "the process died";

/// Which port a call goes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Port {
    Fs,
    Remote,
    State,
}

/// What kind of request to the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteKind {
    Info,
    Changes,
    BlobStart,
    PutPart(u64),
    Complete,
    Download,
    Commit,
}

/// What the network does to a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetFault {
    None,
    /// The request does not reach the server.
    DropRequest,
    /// The server does the work, the answer is lost.
    LoseResponse,
}

/// One call to the server, for the rules of faults and for the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteCall {
    /// 1-based number among the calls to the server in this pass.
    pub ordinal: u64,
    pub kind: RemoteKind,
    /// The body the request is about, if any.
    pub blob: Option<[u8; 16]>,
}

type NetRule = Box<dyn FnMut(&RemoteCall) -> NetFault>;

struct Hook {
    before_call: Option<u64>,
    before_remote: Option<RemoteKind>,
    /// Runs before the first call whose `port.method` name is this.
    before_named: Option<String>,
    /// Runs before the first call after a call with this name.
    after_named: Option<String>,
    armed: bool,
    action: Option<Box<dyn FnOnce()>>,
}

#[derive(Default)]
struct Inner {
    calls: u64,
    remote_calls: u64,
    crash_at: Option<u64>,
    dead: bool,
    net_rule: Option<NetRule>,
    hooks: Vec<Hook>,
    log: Vec<String>,
    remote_log: Vec<RemoteCall>,
}

/// The plan of faults of one pass of one device; cloning shares it.
#[derive(Clone, Default)]
pub struct Faults(Rc<RefCell<Inner>>);

impl Faults {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a new pass: counters to zero, the process alive, rules and hooks as they were set
    /// before (they apply to the next pass).
    pub fn begin_pass(&self) {
        let mut inner = self.0.borrow_mut();
        inner.calls = 0;
        inner.remote_calls = 0;
        inner.dead = false;
        inner.log.clear();
        inner.remote_log.clear();
    }

    /// Clears the plan for the next pass: no crash, no net rule, no hooks.
    pub fn clear(&self) {
        let mut inner = self.0.borrow_mut();
        inner.crash_at = None;
        inner.net_rule = None;
        inner.hooks.clear();
    }

    /// The process dies at the `n`-th call (1-based) of the next pass, before it is done.
    pub fn crash_at(&self, n: u64) {
        self.0.borrow_mut().crash_at = Some(n);
    }

    /// A rule that decides for every request to the server what the network does with it.
    pub fn net_rule(&self, rule: impl FnMut(&RemoteCall) -> NetFault + 'static) {
        self.0.borrow_mut().net_rule = Some(Box::new(rule));
    }

    /// The first request of this kind loses its answer.
    pub fn lose_response_of(&self, kind: RemoteKind) {
        let mut done = false;
        self.net_rule(move |call| {
            if !done && call.kind == kind {
                done = true;
                NetFault::LoseResponse
            } else {
                NetFault::None
            }
        });
    }

    /// The first request of this kind does not reach the server.
    pub fn drop_request_of(&self, kind: RemoteKind) {
        let mut done = false;
        self.net_rule(move |call| {
            if !done && call.kind == kind {
                done = true;
                NetFault::DropRequest
            } else {
                NetFault::None
            }
        });
    }

    /// Runs `action` just before the `n`-th call of the pass (the user edits a file, another
    /// device commits).
    pub fn before_call(&self, n: u64, action: impl FnOnce() + 'static) {
        self.0.borrow_mut().hooks.push(Hook {
            before_call: Some(n),
            before_remote: None,
            before_named: None,
            after_named: None,
            armed: false,
            action: Some(Box::new(action)),
        });
    }

    /// Runs `action` just before the first request to the server of this kind.
    pub fn before_remote(&self, kind: RemoteKind, action: impl FnOnce() + 'static) {
        self.0.borrow_mut().hooks.push(Hook {
            before_call: None,
            before_remote: Some(kind),
            before_named: None,
            after_named: None,
            armed: false,
            action: Some(Box::new(action)),
        });
    }

    /// Runs `action` just before the first call named `port.method` (for example `Fs.rename`).
    pub fn before_named(&self, name: &str, action: impl FnOnce() + 'static) {
        self.0.borrow_mut().hooks.push(Hook {
            before_call: None,
            before_remote: None,
            before_named: Some(name.to_string()),
            after_named: None,
            armed: false,
            action: Some(Box::new(action)),
        });
    }

    /// Runs `action` right after the first call named `port.method` has been made, before the
    /// next call (the user acts while the engine is in the middle of a step).
    pub fn after_named(&self, name: &str, action: impl FnOnce() + 'static) {
        self.0.borrow_mut().hooks.push(Hook {
            before_call: None,
            before_remote: None,
            before_named: None,
            after_named: Some(name.to_string()),
            armed: false,
            action: Some(Box::new(action)),
        });
    }

    /// How many calls the pass made (all ports).
    pub fn calls(&self) -> u64 {
        self.0.borrow().calls
    }

    /// The calls of the last pass, as `port.method`.
    pub fn log(&self) -> Vec<String> {
        self.0.borrow().log.clone()
    }

    /// The requests to the server of the last pass.
    pub fn remote_log(&self) -> Vec<RemoteCall> {
        self.0.borrow().remote_log.clone()
    }

    pub fn is_dead(&self) -> bool {
        self.0.borrow().dead
    }

    /// Counts a call; `Err` when the process is (now) dead. Hooks run before the call.
    fn tick(&self, port: Port, name: &str, remote: Option<&RemoteKind>) -> Result<(), ()> {
        let mut to_run: Vec<Box<dyn FnOnce()>> = Vec::new();
        {
            let mut inner = self.0.borrow_mut();
            if inner.dead {
                return Err(());
            }
            inner.calls += 1;
            let n = inner.calls;
            inner.log.push(format!("{port:?}.{name}"));
            if inner.crash_at == Some(n) {
                inner.dead = true;
                return Err(());
            }
            let current = format!("{port:?}.{name}");
            for hook in &mut inner.hooks {
                let hit = hook.before_call == Some(n)
                    || (hook.before_remote.is_some() && hook.before_remote.as_ref() == remote)
                    || hook.before_named.as_deref() == Some(current.as_str())
                    || hook.armed;
                if hit {
                    if let Some(action) = hook.action.take() {
                        to_run.push(action);
                    }
                } else if hook.after_named.as_deref() == Some(current.as_str()) {
                    hook.armed = true;
                }
            }
        }
        for action in to_run {
            action();
        }
        Ok(())
    }

    fn net_decision(&self, kind: RemoteKind, blob: Option<[u8; 16]>) -> NetFault {
        let mut inner = self.0.borrow_mut();
        inner.remote_calls += 1;
        let call = RemoteCall {
            ordinal: inner.remote_calls,
            kind,
            blob,
        };
        inner.remote_log.push(call.clone());
        match inner.net_rule.as_mut() {
            Some(rule) => rule(&call),
            None => NetFault::None,
        }
    }
}

fn died_fs() -> FsError {
    FsError::Io(PROCESS_DIED.into())
}

// ----- file system -----

pub struct FaultyFs<F: LocalFs> {
    pub inner: F,
    pub faults: Faults,
}

struct FaultyStaged {
    inner: Box<dyn StagedWrite>,
    faults: Faults,
}

impl StagedWrite for FaultyStaged {
    fn write(&mut self, bytes: &[u8]) -> Result<(), FsError> {
        self.faults
            .tick(Port::Fs, "staged.write", None)
            .map_err(|()| died_fs())?;
        self.inner.write(bytes)
    }

    fn publish(
        self: Box<Self>,
        snapshot: Option<amby_sync_core::engine::SnapshotReason>,
    ) -> Result<(), FsError> {
        self.faults
            .tick(Port::Fs, "staged.publish", None)
            .map_err(|()| died_fs())?;
        self.inner.publish(snapshot)
    }

    fn abort(self: Box<Self>) {
        // A dead process cannot clean up: the temporary file stays (С3).
        if self.faults.tick(Port::Fs, "staged.abort", None).is_ok() {
            self.inner.abort();
        }
    }
}

impl<F: LocalFs> LocalFs for FaultyFs<F> {
    fn root_state(&mut self) -> Result<RootState, FsError> {
        self.faults
            .tick(Port::Fs, "root_state", None)
            .map_err(|()| died_fs())?;
        self.inner.root_state()
    }
    fn list(&mut self) -> Result<Listing, FsError> {
        self.faults
            .tick(Port::Fs, "list", None)
            .map_err(|()| died_fs())?;
        self.inner.list()
    }
    fn read(&mut self, path: &str) -> Result<Vec<u8>, FsError> {
        self.faults
            .tick(Port::Fs, "read", None)
            .map_err(|()| died_fs())?;
        self.inner.read(path)
    }
    fn begin_write(&mut self, path: &str) -> Result<Box<dyn StagedWrite>, FsError> {
        self.faults
            .tick(Port::Fs, "begin_write", None)
            .map_err(|()| died_fs())?;
        let inner = self.inner.begin_write(path)?;
        Ok(Box::new(FaultyStaged {
            inner,
            faults: self.faults.clone(),
        }))
    }
    fn create_dir(&mut self, path: &str) -> Result<(), FsError> {
        self.faults
            .tick(Port::Fs, "create_dir", None)
            .map_err(|()| died_fs())?;
        self.inner.create_dir(path)
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<(), FsError> {
        self.faults
            .tick(Port::Fs, "rename", None)
            .map_err(|()| died_fs())?;
        self.inner.rename(from, to)
    }
    fn move_to_trash(&mut self, path: &str, reason: TrashReason) -> Result<(), FsError> {
        self.faults
            .tick(Port::Fs, "move_to_trash", None)
            .map_err(|()| died_fs())?;
        self.inner.move_to_trash(path, reason)
    }
    fn remove_empty_dir(&mut self, path: &str) -> Result<bool, FsError> {
        self.faults
            .tick(Port::Fs, "remove_empty_dir", None)
            .map_err(|()| died_fs())?;
        self.inner.remove_empty_dir(path)
    }
    fn recovery_pending(&mut self) -> Result<bool, FsError> {
        self.faults
            .tick(Port::Fs, "recovery_pending", None)
            .map_err(|()| died_fs())?;
        self.inner.recovery_pending()
    }
    fn cleanup_staged(&mut self) -> Result<(), FsError> {
        self.faults
            .tick(Port::Fs, "cleanup_staged", None)
            .map_err(|()| died_fs())?;
        self.inner.cleanup_staged()
    }
    fn name_rules(&self) -> NameRules {
        self.inner.name_rules()
    }
    fn batch_begin(&mut self) {
        // Not a failing call: a dead process simply never gets to `batch_end`.
        if !self.faults.is_dead() {
            self.inner.batch_begin();
        }
    }
    fn batch_end(&mut self) {
        if !self.faults.is_dead() {
            self.inner.batch_end();
        }
    }
}

// ----- state -----

pub struct FaultyState<S: StateStore> {
    pub inner: S,
    pub faults: Faults,
}

impl<S: StateStore> StateStore for FaultyState<S> {
    fn load(&mut self) -> Result<SyncState, StateError> {
        self.faults
            .tick(Port::State, "load", None)
            .map_err(|()| StateError::Io(PROCESS_DIED.into()))?;
        self.inner.load()
    }
    fn apply(&mut self, tx: &StateTx) -> Result<(), StateError> {
        self.faults
            .tick(Port::State, "apply", None)
            .map_err(|()| StateError::Io(PROCESS_DIED.into()))?;
        self.inner.apply(tx)
    }
    fn lock(&mut self) -> Result<StateLock, StateError> {
        self.faults
            .tick(Port::State, "lock", None)
            .map_err(|()| StateError::Io(PROCESS_DIED.into()))?;
        self.inner.lock()
    }
}

// ----- server -----

/// What the server lies about, set by a test (the engine must notice, С5, С6).
#[derive(Default)]
pub struct Lies {
    /// Changes what `info` says (an incompatible server).
    pub info: Option<Box<dyn FnMut(ServerInfo) -> ServerInfo>>,
    /// Changes every page of the feed before the engine sees it.
    pub changes: Option<Box<dyn FnMut(ChangesPage) -> ChangesPage>>,
    /// Changes the sealed body of a download; `Err(n)` cuts the stream after `n` bytes with an
    /// i/o error (С1).
    pub download: Option<Box<dyn FnMut(&BodyId, Vec<u8>) -> Result<Vec<u8>, usize>>>,
}

pub struct FaultyRemote {
    pub inner: Box<dyn Remote>,
    pub faults: Faults,
    pub lies: Rc<RefCell<Lies>>,
    /// Content hashes the server has accepted in a commit through this wrapper.
    pub known: Rc<RefCell<BTreeSet<Hash>>>,
    pub space_id: SpaceId,
    pub vk: SpaceKey,
}

fn died_net() -> RemoteError {
    RemoteError::Network(PROCESS_DIED.into())
}

fn lost() -> RemoteError {
    RemoteError::Network("simulated network fault".into())
}

struct CutReader {
    data: Vec<u8>,
    pos: usize,
    cut_at: usize,
}

impl Read for CutReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.cut_at {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "simulated cut connection",
            ));
        }
        let end = (self.pos + buf.len()).min(self.cut_at).min(self.data.len());
        let n = end - self.pos;
        buf[..n].copy_from_slice(&self.data[self.pos..end]);
        self.pos = end;
        Ok(n)
    }
}

impl FaultyRemote {
    fn pre(
        &self,
        name: &str,
        kind: RemoteKind,
        blob: Option<&BodyId>,
    ) -> Result<NetFault, RemoteError> {
        self.faults
            .tick(Port::Remote, name, Some(&kind))
            .map_err(|()| died_net())?;
        let fault = self.faults.net_decision(kind, blob.map(|b| *b.as_bytes()));
        if fault == NetFault::DropRequest {
            return Err(lost());
        }
        Ok(fault)
    }

    fn post<T>(&self, fault: NetFault, result: Result<T, RemoteError>) -> Result<T, RemoteError> {
        match (fault, result) {
            (NetFault::LoseResponse, _) => Err(lost()),
            (_, result) => result,
        }
    }
}

impl Remote for FaultyRemote {
    fn info(&mut self) -> Result<ServerInfo, RemoteError> {
        let fault = self.pre("info", RemoteKind::Info, None)?;
        let result = self.inner.info();
        let result = match (result, self.lies.borrow_mut().info.as_mut()) {
            (Ok(info), Some(lie)) => Ok(lie(info)),
            (result, _) => result,
        };
        self.post(fault, result)
    }

    fn changes(&mut self, since: u64, limit: Option<u32>) -> Result<ChangesPage, RemoteError> {
        let fault = self.pre("changes", RemoteKind::Changes, None)?;
        let result = self.inner.changes(since, limit);
        let result = match (result, self.lies.borrow_mut().changes.as_mut()) {
            (Ok(page), Some(lie)) => Ok(lie(page)),
            (result, _) => result,
        };
        self.post(fault, result)
    }

    fn blob_start(&mut self, blob: &BodyId, size: u64) -> Result<BlobState, RemoteError> {
        let fault = self.pre("blob_start", RemoteKind::BlobStart, Some(blob))?;
        let result = self.inner.blob_start(blob, size);
        self.post(fault, result)
    }

    fn blob_put_part(&mut self, blob: &BodyId, part: u64, bytes: &[u8]) -> Result<(), RemoteError> {
        let fault = self.pre("blob_put_part", RemoteKind::PutPart(part), Some(blob))?;
        let result = self.inner.blob_put_part(blob, part, bytes);
        self.post(fault, result)
    }

    fn blob_complete(&mut self, blob: &BodyId) -> Result<(), RemoteError> {
        let fault = self.pre("blob_complete", RemoteKind::Complete, Some(blob))?;
        let result = self.inner.blob_complete(blob);
        self.post(fault, result)
    }

    fn blob_download(&mut self, blob: &BodyId) -> Result<Box<dyn Read + '_>, RemoteError> {
        let fault = self.pre("blob_download", RemoteKind::Download, Some(blob))?;
        let mut stream = self.inner.blob_download(blob)?;
        if fault == NetFault::LoseResponse {
            return Err(lost());
        }
        if self.lies.borrow().download.is_none() {
            return Ok(stream);
        }
        let mut bytes = Vec::new();
        stream
            .read_to_end(&mut bytes)
            .map_err(|e| RemoteError::Network(e.to_string()))?;
        let mut lies = self.lies.borrow_mut();
        let lie = lies.download.as_mut().expect("checked above");
        match lie(blob, bytes.clone()) {
            Ok(changed) => Ok(Box::new(std::io::Cursor::new(changed))),
            Err(cut) => Ok(Box::new(CutReader {
                data: bytes,
                pos: 0,
                cut_at: cut,
            })),
        }
    }

    fn commit(
        &mut self,
        commit_id: &[u8; 16],
        items: &[CommitItem],
    ) -> Result<CommitReply, RemoteError> {
        let fault = self.pre("commit", RemoteKind::Commit, None)?;
        let result = self.inner.commit(commit_id, items);
        if let Ok(CommitReply::Accepted(_)) = &result {
            for item in items {
                if let Ok(header) = open_header(
                    &self.vk,
                    &self.space_id,
                    &item.item_id,
                    item.base_version + 1,
                    &item.header,
                ) {
                    if let Some(hash) = header.content_hash {
                        self.known.borrow_mut().insert(hash);
                    }
                }
            }
        }
        self.post(fault, result)
    }
}
