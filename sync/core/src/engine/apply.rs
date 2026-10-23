//! The application of incoming changes (Д17): folders, renames, writes, the trash, empty folders.
//! Every file is written next to its target and published only after the whole body has been
//! verified (Д68); every replacement leaves a snapshot (Д53); a state step follows every action
//! (Д4).

use std::collections::BTreeSet;
use std::io::Write;

use crate::crypto::header::ItemKind;

use super::flow::{Flow, Res};
use super::model::{
    ConflictRecord, CycleReport, ItemError, ItemErrorKind, StateOp, UnsyncedReason, UnsyncedRecord,
};
use super::plan::{Act, CopyPlan, KeepAct, MoveAct, Plan, PutAct, Srv};
use super::ports::{FsError, RemoteError, SnapshotReason, StagedWrite, TrashReason};
use super::scan::Scan;
use super::stream::{open_body_stream, StreamError};
use super::sync::Engine;
use super::util::{ancestors, depth, hash_of, UNMATERIALISED};

/// How one action ended.
enum Step {
    Done,
    /// The target is held by another file for now (Д49): try again after the others.
    Busy,
    /// Something changed under us or failed for this item only: the cursor is held (Д5, Д17).
    Skipped,
}

/// Why a download did not make a file.
enum Failed {
    /// This item only.
    Item(ItemErrorKind),
    /// The whole pass.
    Pass(Flow),
}

/// What the application of a plan needs to know besides the plan.
pub(super) struct ApplyCtx<'a> {
    pub scan: &'a Scan,
    /// Conflicts the state already has.
    pub conflict_ids: BTreeSet<String>,
}

/// A sink that writes into a staged file and remembers why it failed.
struct StagedSink<'a> {
    staged: &'a mut Box<dyn StagedWrite>,
    failure: Option<FsError>,
}

impl Write for StagedSink<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.staged.write(buf) {
            Ok(()) => Ok(buf.len()),
            Err(error) => {
                self.failure = Some(error);
                Err(std::io::Error::other("the file could not be written"))
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn fail(plan: &mut Plan, seq: Option<u64>, srv: &Srv, kind: ItemErrorKind) {
    plan.errors.push(ItemError {
        item_id: srv.item,
        kind,
    });
    plan.hold_before(seq);
}

impl Engine {
    /// Runs the actions of `plan` in the order of Д17. Errors of single items go into the plan
    /// (`errors`, `hold`); a failure of the whole pass is returned.
    pub(super) fn apply_plan(
        &mut self,
        plan: &mut Plan,
        ctx: &mut ApplyCtx<'_>,
        report: &mut CycleReport,
    ) -> Res<()> {
        let acts = std::mem::take(&mut plan.acts);
        let mut ops: Vec<StateOp> = Vec::new();
        let mut dirs = Vec::new();
        let mut moves: Vec<MoveAct> = Vec::new();
        let mut puts: Vec<PutAct> = Vec::new();
        let mut keeps: Vec<KeepAct> = Vec::new();
        let mut trashes = Vec::new();
        for act in acts {
            match act {
                Act::Ops(more) => ops.extend(more),
                Act::Dir { path, rec } => dirs.push((path, rec)),
                Act::Move(m) => moves.push(*m),
                Act::Put(p) => puts.push(*p),
                Act::Keep(k) => keeps.push(*k),
                Act::Trash {
                    seq,
                    disk,
                    expect,
                    rec,
                } => trashes.push((seq, disk, expect, rec)),
            }
        }
        if !ops.is_empty() {
            self.ports.state.apply(&ops)?;
        }

        // (1) Folders by growing depth.
        dirs.sort_by_key(|(path, _)| depth(path));
        for (path, rec) in dirs {
            match self.ports.fs.create_dir(&path) {
                Ok(()) => self.ports.state.apply(&vec![StateOp::PutItem(rec)])?,
                Err(FsError::NoSpace) => {
                    let srv = Srv::from_record(&rec);
                    fail(plan, None, &srv, ItemErrorKind::Disk(FsError::NoSpace));
                }
                Err(error) => return Err(error.into()),
            }
        }

        // (2) Renames, a few rounds so that a name freed by one rename can be taken by another.
        let mut pending = moves;
        for round in 0..3 {
            if pending.is_empty() {
                break;
            }
            let mut next = Vec::new();
            let mut progress = false;
            for m in pending {
                match self.apply_move(&m, plan, ctx, report)? {
                    Step::Done => {
                        progress = true;
                        for up in ancestors(&m.from) {
                            plan.cleanup.insert(up.to_string());
                        }
                    }
                    Step::Busy => next.push(m),
                    Step::Skipped => progress = true,
                }
            }
            pending = next;
            if !pending.is_empty() && !progress && round < 2 {
                self.break_cycle(&mut pending)?;
            }
        }
        for m in pending {
            plan.unsynced.push(UnsyncedRecord {
                path: m.to.clone(),
                reason: UnsyncedReason::PathBusy,
            });
            plan.hold_before(m.seq);
        }

        // (3) Creations and replacements. A name that is still held is tried once more after the
        // deletions below.
        let mut busy: Vec<PutAct> = Vec::new();
        for put in puts {
            if let Step::Busy = self.apply_put(&put, plan, ctx, report)? {
                busy.push(put);
            }
        }
        for keep in keeps {
            self.apply_keep(&keep, plan, ctx, report)?;
        }

        // (4) Deletions, always to the trash (Д52).
        for (seq, disk, expect, rec) in trashes {
            match self.ports.fs.read(&disk) {
                Ok(bytes) if hash_of(&bytes) == expect => {
                    self.ports
                        .fs
                        .move_to_trash(&disk, TrashReason::RemoteDeletion)?;
                    report.trashed += 1;
                    for up in ancestors(&disk) {
                        plan.cleanup.insert(up.to_string());
                    }
                    self.ports.state.apply(&vec![StateOp::PutItem(rec)])?;
                }
                Ok(_) => plan.hold_before(seq), // changed since: the next pass decides (С9)
                Err(FsError::NotFound(_)) => {
                    self.ports.state.apply(&vec![StateOp::PutItem(rec)])?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        for put in busy {
            if let Step::Busy = self.apply_put(&put, plan, ctx, report)? {
                plan.unsynced.push(UnsyncedRecord {
                    path: put.target.clone(),
                    reason: UnsyncedReason::PathBusy,
                });
                let mut parked = put.srv.record(UNMATERIALISED);
                parked.newer_format = false;
                self.ports.state.apply(&vec![StateOp::PutItem(parked)])?;
            }
        }

        // (5) Folders that are empty now.
        self.remove_empty_folders(plan, ctx)
    }

    fn remove_empty_folders(&mut self, plan: &mut Plan, ctx: &ApplyCtx<'_>) -> Res<()> {
        let mut todo: BTreeSet<String> = std::mem::take(&mut plan.cleanup);
        // A folder that holds a live record is never removed (Р2).
        let live_folders: BTreeSet<String> = self
            .ports
            .state
            .load()?
            .items
            .values()
            .filter(|r| !r.deleted && r.kind == ItemKind::Folder)
            .map(|r| r.path.clone())
            .collect();
        let mut tried: BTreeSet<String> = BTreeSet::new();
        while let Some(path) = todo
            .iter()
            .max_by_key(|p| (depth(p), (*p).clone()))
            .cloned()
        {
            todo.remove(&path);
            if !tried.insert(path.clone()) || live_folders.contains(&path) {
                continue;
            }
            let disk = ctx
                .scan
                .dirs
                .get(&path)
                .map_or(path.clone(), |dir| dir.disk.clone());
            if self.ports.fs.remove_empty_dir(&disk)? {
                for up in ancestors(&path) {
                    todo.insert(up.to_string());
                }
            }
        }
        Ok(())
    }

    /// Breaks a cycle of renames (two names swapped) by moving one file aside under a name that
    /// is not a temporary file: if the process dies here, the file is still a file of the user.
    fn break_cycle(&mut self, pending: &mut [MoveAct]) -> Res<()> {
        for index in 0..pending.len() {
            // Follow "my target is the source of another pending rename".
            let mut at = index;
            let mut steps = 0;
            let cyclic = loop {
                let target = pending[at].to.clone();
                match pending.iter().position(|m| m.from == target) {
                    Some(next) if next == index => break true,
                    Some(next) => at = next,
                    None => break false,
                }
                steps += 1;
                if steps > pending.len() {
                    break false;
                }
            };
            if !cyclic {
                continue;
            }
            let aside = format!("{}.amby-swap-{index}", pending[index].from_disk);
            match self.ports.fs.rename(&pending[index].from_disk, &aside) {
                Ok(()) => {
                    pending[index].from_disk = aside.clone();
                    pending[index].from = aside;
                    return Ok(());
                }
                Err(FsError::AlreadyExists(_) | FsError::NotFound(_)) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    // ----- one action each -----

    fn apply_move(
        &mut self,
        m: &MoveAct,
        plan: &mut Plan,
        ctx: &mut ApplyCtx<'_>,
        report: &mut CycleReport,
    ) -> Res<Step> {
        let srv = Srv::from_record(&m.rec);
        match self.ports.fs.read(&m.from_disk) {
            Ok(bytes) if hash_of(&bytes) == m.expect => {}
            Ok(_) | Err(FsError::NotFound(_)) => {
                plan.hold_before(m.seq);
                return Ok(Step::Skipped);
            }
            Err(error) => return Err(error.into()),
        }
        let mut renamed = self.ports.fs.rename(&m.from_disk, &m.to);
        if matches!(renamed, Err(FsError::AlreadyExists(_))) {
            if let Some((occupant, copy)) = &m.occupant {
                match self.ports.fs.read(&occupant.disk) {
                    Ok(bytes) if hash_of(&bytes) == occupant.hash => {}
                    Ok(_) | Err(FsError::NotFound(_)) => {
                        plan.hold_before(m.seq);
                        return Ok(Step::Skipped);
                    }
                    Err(error) => return Err(error.into()),
                }
                // The file that is in the way is kept as a conflict copy (Д49, Д51).
                if copy.exists {
                    // The same content is at the copy path already: this one is a duplicate.
                    self.ports
                        .fs
                        .move_to_trash(&occupant.disk, TrashReason::RemoteDeletion)?;
                } else if !copy.from_server {
                    match self.ports.fs.rename(&occupant.disk, &copy.path) {
                        Ok(()) => {}
                        Err(FsError::AlreadyExists(_)) => return Ok(Step::Busy),
                        Err(error) => return Err(error.into()),
                    }
                } else {
                    self.ports
                        .fs
                        .move_to_trash(&occupant.disk, TrashReason::RemoteDeletion)?;
                }
                self.note_conflict(copy, ctx, report)?;
                renamed = self.ports.fs.rename(&m.from_disk, &m.to);
            }
        }
        match renamed {
            Ok(()) => {}
            Err(FsError::AlreadyExists(_)) => return Ok(Step::Busy),
            Err(FsError::NotFound(_)) => {
                plan.hold_before(m.seq);
                return Ok(Step::Skipped);
            }
            Err(FsError::NoSpace) => {
                fail(plan, m.seq, &srv, ItemErrorKind::Disk(FsError::NoSpace));
                return Ok(Step::Skipped);
            }
            Err(error) => return Err(error.into()),
        }
        report.renamed += 1;
        match &m.then {
            Some(put) => {
                // The rename is done; if the content cannot follow, the next pass sees the file
                // at the server's path and finishes (Д4).
                let mut put = put.clone();
                if let Some(existing) = put.existing.as_mut() {
                    existing.disk = m.to.clone();
                }
                self.apply_put(&put, plan, ctx, report)
            }
            None => {
                self.ports
                    .state
                    .apply(&vec![StateOp::PutItem(m.rec.clone())])?;
                Ok(Step::Done)
            }
        }
    }

    fn apply_put(
        &mut self,
        put: &PutAct,
        plan: &mut Plan,
        ctx: &mut ApplyCtx<'_>,
        report: &mut CycleReport,
    ) -> Res<Step> {
        let srv = &put.srv;
        // What is there now must be what the decision looked at (Д17, С9).
        let (local_bytes, write_path) = match &put.existing {
            Some(existing) => match self.ports.fs.read(&existing.disk) {
                Ok(bytes) if hash_of(&bytes) == existing.hash => {
                    (Some(bytes), existing.disk.clone())
                }
                Ok(_) | Err(FsError::NotFound(_)) => {
                    plan.hold_before(put.seq);
                    return Ok(Step::Skipped);
                }
                Err(error) => return Err(error.into()),
            },
            None => match self.ports.fs.read(&put.target) {
                Ok(_) => return Ok(Step::Busy),
                Err(FsError::NotFound(_)) => (None, put.target.clone()),
                Err(error) => return Err(error.into()),
            },
        };
        let mut staged = match self.ports.fs.begin_write(&write_path) {
            Ok(staged) => staged,
            Err(FsError::NoSpace) => {
                fail(plan, put.seq, srv, ItemErrorKind::Disk(FsError::NoSpace));
                return Ok(Step::Skipped);
            }
            Err(error) => return Err(error.into()),
        };
        match self.download_into(srv, &mut staged) {
            Ok(()) => {}
            Err(Failed::Item(kind)) => {
                staged.abort();
                fail(plan, put.seq, srv, kind);
                return Ok(Step::Skipped);
            }
            Err(Failed::Pass(flow)) => {
                staged.abort();
                return Err(flow);
            }
        }
        if let (Some(copy), Some(bytes)) = (&put.copy, &local_bytes) {
            // The local content is saved beside the file first, then listed, then replaced (Д47).
            match self.write_copy(copy, bytes) {
                Ok(()) => {}
                Err(FsError::NoSpace) => {
                    staged.abort();
                    fail(plan, put.seq, srv, ItemErrorKind::Disk(FsError::NoSpace));
                    return Ok(Step::Skipped);
                }
                Err(error) => {
                    staged.abort();
                    return Err(error.into());
                }
            }
            self.note_conflict(copy, ctx, report)?;
        }
        let snapshot = put
            .existing
            .is_some()
            .then_some(SnapshotReason::SyncOverwrite);
        match staged.publish(snapshot) {
            Ok(()) => {}
            Err(FsError::NoSpace) => {
                fail(plan, put.seq, srv, ItemErrorKind::Disk(FsError::NoSpace));
                return Ok(Step::Skipped);
            }
            Err(error) => return Err(error.into()),
        }
        report.downloaded += 1;
        self.ports
            .state
            .apply(&vec![StateOp::PutItem(put.rec.clone())])?;
        Ok(Step::Done)
    }

    /// After a `resync`: the server's version is saved as a copy, the local file stays (Д56).
    fn apply_keep(
        &mut self,
        keep: &KeepAct,
        plan: &mut Plan,
        ctx: &mut ApplyCtx<'_>,
        report: &mut CycleReport,
    ) -> Res<()> {
        let srv = &keep.srv;
        if !keep.copy.exists && !keep.copy.from_server {
            let mut staged = match self.ports.fs.begin_write(&keep.copy.path) {
                Ok(staged) => staged,
                Err(FsError::NoSpace) => {
                    fail(plan, keep.seq, srv, ItemErrorKind::Disk(FsError::NoSpace));
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            };
            match self.download_into(srv, &mut staged) {
                Ok(()) => {}
                Err(Failed::Item(kind)) => {
                    staged.abort();
                    fail(plan, keep.seq, srv, kind);
                    return Ok(());
                }
                Err(Failed::Pass(flow)) => {
                    staged.abort();
                    return Err(flow);
                }
            }
            match staged.publish(None) {
                Ok(()) => {}
                Err(FsError::NoSpace) => {
                    fail(plan, keep.seq, srv, ItemErrorKind::Disk(FsError::NoSpace));
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.note_conflict(&keep.copy, ctx, report)?;
        self.ports
            .state
            .apply(&vec![StateOp::PutItem(keep.rec.clone())])?;
        Ok(())
    }

    /// Streams the body of `srv` into `staged`, verified chunk by chunk (Д68).
    fn download_into(
        &mut self,
        srv: &Srv,
        staged: &mut Box<dyn StagedWrite>,
    ) -> Result<(), Failed> {
        let (Some(body), Some(hash)) = (srv.body, srv.hash) else {
            return Err(Failed::Item(ItemErrorKind::Inconsistent));
        };
        let mut reader = match self.ports.remote.blob_download(&body) {
            Ok(reader) => reader,
            Err(RemoteError::Rejected { .. }) => {
                return Err(Failed::Item(ItemErrorKind::Inconsistent));
            }
            Err(error) => return Err(Failed::Pass(error.into())),
        };
        let mut sink = StagedSink {
            staged,
            failure: None,
        };
        let result = open_body_stream(
            &self.config.vk,
            &body,
            srv.size,
            &hash,
            &mut reader,
            &mut sink,
        );
        match result {
            Ok(()) => Ok(()),
            Err(StreamError::Crypto(error)) => Err(Failed::Item(ItemErrorKind::Invalid(error))),
            Err(StreamError::Read(error)) => Err(Failed::Pass(Flow::Err(
                super::model::EngineError::Remote(RemoteError::Network(error.to_string())),
            ))),
            Err(StreamError::Write(error)) => Err(match sink.failure.take() {
                Some(FsError::NoSpace) => Failed::Item(ItemErrorKind::Disk(FsError::NoSpace)),
                Some(other) => Failed::Pass(other.into()),
                None => Failed::Pass(FsError::Io(error.to_string()).into()),
            }),
        }
    }

    /// Creates the file of a conflict copy unless it is there already or arrives from the server.
    fn write_copy(&mut self, copy: &CopyPlan, bytes: &[u8]) -> Result<(), FsError> {
        if copy.exists || copy.from_server {
            return Ok(());
        }
        let mut staged = self.ports.fs.begin_write(&copy.path)?;
        for chunk in bytes.chunks(64 * 1024) {
            if let Err(error) = staged.write(chunk) {
                staged.abort();
                return Err(error);
            }
        }
        staged.publish(None)
    }

    /// Lists a conflict (Д47) and tells the report.
    fn note_conflict(
        &mut self,
        copy: &CopyPlan,
        ctx: &mut ApplyCtx<'_>,
        report: &mut CycleReport,
    ) -> Res<()> {
        let record = ConflictRecord {
            id: copy.id.clone(),
            kind: copy.kind,
            original_path: copy.original.clone(),
            copy_path: copy.path.clone(),
            created_ms: self.ports.clock.now_ms(),
        };
        if ctx.conflict_ids.insert(copy.id.clone()) {
            self.ports
                .state
                .apply(&vec![StateOp::AddConflict(record.clone())])?;
        }
        if !report.conflicts.iter().any(|c| c.id == record.id) {
            report.conflicts.push(record);
        }
        Ok(())
    }
}
