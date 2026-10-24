//! The engine itself (Д2, Д10): one function, [`SyncEngine::sync_cycle`], and the ports it
//! works through.

use std::collections::{BTreeMap, BTreeSet};

use crate::crypto::header::ItemKind;
use crate::crypto::keys::{ItemId, SpaceId, SpaceKey};
use crate::crypto::random::Random;

use super::apply::ApplyCtx;
use super::classify::{classify, Lc};
use super::decide::{decide, Inputs};
use super::flow::{Flow, Res};
use super::merge::is_mergeable_path;
use super::model::{
    CycleOutcome, CycleReport, CycleRequest, Direction, EngineError, ItemRecord, ReadOnlyItem,
    StateOp, StopReason, SyncState, UnsyncedRecord,
};
use super::plan::Srv;
use super::ports::{Clock, CommitReply, LocalFs, Remote, RootState, StateError, StateStore};
use super::rules::mass_change_reached;
use super::scan::scan;
use super::util::is_unmaterialised;

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

/// The sync engine of the plan (Э3).
pub struct Engine {
    pub(super) ports: Ports,
    pub(super) config: EngineConfig,
}

impl Engine {
    /// Makes an engine for one device and one space.
    pub fn new(ports: Ports, config: EngineConfig) -> Self {
        Self { ports, config }
    }

    /// An [`EngineBuilder`] for the real engine.
    pub fn boxed(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
        Box::new(Self::new(ports, config))
    }
}

impl SyncEngine for Engine {
    /// Д10, Р7, Р8, Р9, Р10, Р13, С1–С14: the whole pass.
    fn sync_cycle(&mut self, request: &CycleRequest) -> Result<CycleReport, EngineError> {
        // Д9, С14: the lock is the first thing; when it is busy nothing else is touched.
        let _lock = self.ports.state.lock().map_err(|error| match error {
            StateError::Locked => EngineError::Locked,
            other => EngineError::State(other),
        })?;
        let mut report = CycleReport {
            outcome: CycleOutcome::Done,
            downloaded: 0,
            uploaded: 0,
            renamed: 0,
            trashed: 0,
            trashed_paths: Vec::new(),
            restored_paths: Vec::new(),
            merged_paths: Vec::new(),
            conflicts: Vec::new(),
            unsynced: Vec::new(),
            read_only: Vec::new(),
            needs_update: false,
            errors: Vec::new(),
            outgoing_paused: false,
            full_reconcile: false,
        };
        // Д10: after a lost race the whole pass is made again, a few times.
        for _ in 0..5 {
            match self.attempt(request, &mut report) {
                Ok(()) => return Ok(report),
                Err(Flow::Retry) => {
                    report.errors.clear();
                    report.read_only.clear();
                    report.needs_update = false;
                }
                Err(Flow::Stop(reason)) => {
                    report.outcome = CycleOutcome::Stopped(reason);
                    return Ok(report);
                }
                Err(Flow::Err(error)) => return Err(error),
            }
        }
        report.outcome = CycleOutcome::Busy;
        Ok(report)
    }

    /// Д47: a resolved conflict leaves the list.
    fn resolve_conflict(&mut self, id: &str) -> Result<(), EngineError> {
        self.ports
            .state
            .apply(&vec![StateOp::RemoveConflict(id.to_string())])
            .map_err(EngineError::State)
    }
}

impl Engine {
    /// One try of the steps of Д10.
    fn attempt(&mut self, request: &CycleRequest, report: &mut CycleReport) -> Res<()> {
        let approvals = request.approvals;
        // Д55: a folder that is gone is never a deletion, and nothing can approve it.
        if self.ports.fs.root_state()? == RootState::Missing {
            return Err(Flow::Stop(StopReason::VaultMissing));
        }
        self.ports.fs.cleanup_staged()?;
        let info = self.ports.remote.info()?;
        if info.protocol_min > 1 || info.protocol_max < 1 {
            return Err(Flow::Stop(StopReason::IncompatibleServer));
        }
        let mut state = self.ports.state.load()?;

        // Д56: which server is this?
        let resync = approvals.resync;
        if resync {
            // The answer "upload this vault again": the link with the server is forgotten, in
            // memory now and in the state when the pass goes on (it may still stop).
            state.items.clear();
            state.uploads.clear();
            state.commit = None;
            state.cursor = 0;
            state.head = 0;
            state.instance_id = Some(info.instance_id);
        } else {
            match state.instance_id {
                None => {
                    self.ports
                        .state
                        .apply(&vec![StateOp::SetInstance(info.instance_id)])?;
                    state.instance_id = Some(info.instance_id);
                }
                Some(known) if known != info.instance_id => {
                    return Err(Flow::Stop(StopReason::ServerReset {
                        old: known,
                        new: info.instance_id,
                    }));
                }
                Some(_) => {}
            }
        }

        // Д10 step 3: the disk.
        let disk = scan(
            &mut *self.ports.fs,
            &state.items,
            self.config.max_file_bytes,
            info.max_blob_bytes,
        )?;
        let live_files = state
            .items
            .values()
            .filter(|r| !r.deleted && r.kind == ItemKind::File && !is_unmaterialised(r))
            .count();
        // Д55: a vault with nothing in it while the state has files.
        if live_files > 0
            && disk.files.is_empty()
            && disk.blocked.is_empty()
            && !approvals.accept_empty_vault
        {
            return Err(Flow::Stop(StopReason::VaultEmpty));
        }

        // С2, Д7: a commit that may or may not have arrived is sent again, unchanged, first.
        let mut disk = disk;
        if let Some(pending) = state.commit.clone() {
            let probe = self.ports.remote.changes(state.cursor, Some(1))?;
            if probe.seq < state.cursor {
                return Err(Flow::Stop(StopReason::ServerBehind {
                    head: probe.seq,
                    cursor: state.cursor,
                }));
            }
            match self
                .ports
                .remote
                .commit(&pending.commit_id, &pending.items)?
            {
                CommitReply::Accepted(_) => self.commit_accepted(&pending.after, &pending.items)?,
                CommitReply::Conflict(_) => {
                    self.ports.state.apply(&vec![StateOp::SetCommit(None)])?;
                }
            }
            state = self.ports.state.load()?;
            // The bases moved: look at the disk again.
            disk = scan(
                &mut *self.ports.fs,
                &state.items,
                self.config.max_file_bytes,
                info.max_blob_bytes,
            )?;
        }

        let live_files = state
            .items
            .values()
            .filter(|r| !r.deleted && r.kind == ItemKind::File && !is_unmaterialised(r))
            .count();

        // Д10 step 4: the feed.
        let feed = self.read_feed(&state, state.cursor, resync)?;
        let full = feed.full;

        // Д57: an older or different version of what we know.
        for srv in &feed.items {
            if let Some(known) = state.items.get(srv.item.as_bytes()) {
                let differs = srv.path != known.path
                    || srv.hash != known.content_hash
                    || srv.body != known.body_id
                    || srv.deleted != known.deleted
                    || srv.kind != known.kind;
                if srv.version < known.version || (srv.version == known.version && differs) {
                    return Err(Flow::Stop(StopReason::Rollback {
                        item_id: srv.item,
                        known: known.version,
                        got: srv.version,
                    }));
                }
            }
        }

        // Д58: after a gap nothing is believed about deletions; bases the server no longer
        // knows are forgotten, their files stay and become new.
        let mut forgotten: BTreeSet<[u8; 16]> = BTreeSet::new();
        if full && !resync {
            let in_feed: BTreeSet<[u8; 16]> =
                feed.items.iter().map(|s| *s.item.as_bytes()).collect();
            let unreadable: BTreeSet<[u8; 16]> = feed
                .bad
                .iter()
                .map(|(error, _)| *error.item_id.as_bytes())
                .chain(feed.read_only.iter().map(|(_, key)| *key))
                .collect();
            for key in state.items.keys() {
                if !in_feed.contains(key) && !unreadable.contains(key) {
                    forgotten.insert(*key);
                }
            }
        }

        // Д10 step 6: decisions for everything, nothing written yet.
        let classes = classify(&state.items, &disk, &request.rename_hints);
        let bases = self.load_bases(&state, &classes, &feed.items)?;
        let mut plan = decide(
            &Inputs {
                state: &state,
                scan: &disk,
                classes: &classes,
                rules: self.ports.fs.name_rules(),
                max_file_bytes: self.config.max_file_bytes,
                full,
                resync,
                forgotten: &forgotten,
                bases: &bases,
            },
            &feed.items,
        );
        plan.forget
            .extend(forgotten.iter().map(|key| ItemId::from_bytes(*key)));

        // Д54: too many files would change.
        if !approvals.mass_change {
            let total = live_files.max(1);
            if mass_change_reached(
                plan.incoming.len(),
                total,
                self.config.mass_min_files,
                self.config.mass_percent,
            ) {
                return Err(Flow::Stop(StopReason::MassChange {
                    direction: Direction::Incoming,
                    files: plan.incoming,
                }));
            }
            if mass_change_reached(
                plan.outgoing.len(),
                total,
                self.config.mass_min_files,
                self.config.mass_percent,
            ) {
                return Err(Flow::Stop(StopReason::MassChange {
                    direction: Direction::Outgoing,
                    files: plan.outgoing,
                }));
            }
        }

        // From here on the pass writes.
        if resync {
            self.ports.state.apply(&vec![
                StateOp::ResetServerLink,
                StateOp::SetInstance(info.instance_id),
            ])?;
        }
        report.full_reconcile = full;
        for (error, seq) in &feed.bad {
            if !report.errors.iter().any(|e| e.item_id == error.item_id) {
                report.errors.push(error.clone());
            }
            plan.hold_before(Some(*seq));
        }
        // Records of a newer format are only read (Д66).
        let mut flag_ops = Vec::new();
        for (item, key) in &feed.read_only {
            report.read_only.push(item.clone());
            report.needs_update = true;
            if let Some(record) = state.items.get(key) {
                if !record.newer_format {
                    let mut flagged: ItemRecord = record.clone();
                    flagged.newer_format = true;
                    flag_ops.push(StateOp::PutItem(flagged));
                }
            }
        }
        for record in state.items.values().filter(|r| r.newer_format) {
            if !report.read_only.iter().any(|r| r.item_id == record.item_id) {
                report.read_only.push(ReadOnlyItem {
                    item_id: record.item_id,
                    path: Some(record.path.clone()),
                });
            }
            report.needs_update = true;
        }
        if !flag_ops.is_empty() {
            self.ports.state.apply(&flag_ops)?;
        }
        if !plan.forget.is_empty() {
            let ops: Vec<StateOp> = plan
                .forget
                .iter()
                .copied()
                .map(StateOp::RemoveItem)
                .collect();
            self.ports.state.apply(&ops)?;
        }

        // Д17: apply, inside one batch.
        let mut ctx = ApplyCtx {
            scan: &disk,
            conflict_ids: state.conflicts.iter().map(|c| c.id.clone()).collect(),
        };
        self.ports.fs.batch_begin();
        let applied = self.apply_plan(&mut plan, &mut ctx, report);
        self.ports.fs.batch_end();
        applied?;
        for error in std::mem::take(&mut plan.errors) {
            if !report.errors.iter().any(|e| e.item_id == error.item_id) {
                report.errors.push(error);
            }
        }

        // The cursor moves up to the first record that did not go through (Д5).
        let stop_at = plan.hold.map_or(feed.next, |hold| hold.min(feed.next));
        let cursor = if full {
            stop_at
        } else {
            stop_at.max(state.cursor)
        };
        let head = feed.head.max(if full { 0 } else { state.head });
        if cursor != state.cursor || head != state.head || resync {
            self.ports
                .state
                .apply(&vec![StateOp::SetCursor { cursor, head }])?;
        }

        // Д18: what goes out.
        let after = self.push(&info, &plan.undelete, &request.rename_hints, report)?;
        self.prune_bases()?;

        // Д64: the list is made again every pass.
        let mut unsynced: Vec<UnsyncedRecord> = match &after {
            Some(scan) => scan.unsynced.clone(),
            None => disk.unsynced.clone(),
        };
        unsynced.extend(plan.unsynced);
        unsynced.sort_by(|a, b| a.path.cmp(&b.path));
        unsynced.dedup_by(|a, b| a.path == b.path && a.reason == b.reason);
        let current = self.ports.state.load()?;
        if current.unsynced != unsynced {
            self.ports
                .state
                .apply(&vec![StateOp::SetUnsynced(unsynced.clone())])?;
        }
        report.unsynced = unsynced;
        Ok(())
    }
}

impl Engine {
    /// The bases of the notes that both sides may have edited (Г6, Г10): those of the items with a
    /// new server version whose local file was edited here. A base whose bytes do not match its
    /// hash is not there (Г7).
    fn load_bases(
        &mut self,
        state: &SyncState,
        classes: &BTreeMap<[u8; 16], Lc>,
        items: &[Srv],
    ) -> Res<BTreeMap<[u8; 16], Vec<u8>>> {
        let mut bases = BTreeMap::new();
        for srv in items {
            let key = *srv.item.as_bytes();
            let Some(record) = state.items.get(&key) else {
                continue;
            };
            let edited = matches!(
                classes.get(&key),
                Some(Lc::Edited | Lc::Moved { edited: true, .. })
            );
            let (Some(hash), true) = (record.content_hash, edited) else {
                continue;
            };
            if record.deleted
                || srv.deleted
                || record.kind != ItemKind::File
                || is_unmaterialised(record)
                || srv.version <= record.version
                || srv.hash == record.content_hash
                || !is_mergeable_path(&record.path)
            {
                continue;
            }
            if let Some(bytes) = self.ports.state.base_get(&record.item_id, &hash)? {
                bases.insert(key, bytes);
            }
        }
        Ok(bases)
    }

    /// Only the bases that the state refers to stay (Г9).
    fn prune_bases(&mut self) -> Res<()> {
        let state = self.ports.state.load()?;
        let mut keep: Vec<(ItemId, [u8; 32])> = state
            .items
            .values()
            .filter(|r| !r.deleted)
            .filter_map(|r| r.content_hash.map(|hash| (r.item_id, hash)))
            .collect();
        if let Some(pending) = &state.commit {
            keep.extend(
                pending
                    .after
                    .iter()
                    .filter_map(|r| r.content_hash.map(|hash| (r.item_id, hash))),
            );
        }
        self.ports.state.base_prune(&keep)?;
        Ok(())
    }
}
