//! The application of incoming changes (Д17): folders, renames, writes, the trash, empty folders.
//! Every file is written next to its target and published only after the whole body has been
//! verified (Д68); every replacement leaves a snapshot (Д53); a state step follows every action
//! (Д4).

use std::collections::BTreeSet;
use std::io::Write;

use crate::crypto::header::ItemKind;

use super::conflict_set::{encode_meta, set_paths, SetMeta};
use super::flow::{Flow, Res};
use super::merge::{is_mergeable_path, merge_text, MergeOutcome, MERGE_MAX_BYTES};
use super::model::{
    ConflictRecord, CycleReport, ItemError, ItemErrorKind, StateOp, UnsyncedReason, UnsyncedRecord,
};
use super::plan::{Act, CopyPlan, KeepAct, LinkBase, MoveAct, Plan, PutAct, Srv};
use super::ports::{FsError, RemoteError, SnapshotReason, StagedWrite, TrashReason};
use super::scan::Scan;
use super::stream::{open_body_stream, StreamError};
use super::sync::Engine;
use super::util::{ancestors, base_eligible, depth, hash_of, UNMATERIALISED};

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
    /// The file system refused while writing bytes already in memory.
    Fs(FsError),
    /// The whole pass.
    Pass(Flow),
}

/// What the application of a plan needs to know besides the plan.
pub(super) struct ApplyCtx<'a> {
    pub scan: &'a Scan,
    /// Conflicts the state already has.
    pub conflict_ids: BTreeSet<String>,
}

/// A sink that writes into a staged file and remembers why it failed. With `keep` it also keeps
/// the bytes of a note that may be the base of a merge (Г6), up to the size limit of Г5.
struct StagedSink<'a> {
    staged: &'a mut Box<dyn StagedWrite>,
    failure: Option<FsError>,
    keep: Option<Vec<u8>>,
}

impl Write for StagedSink<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Some(kept) = self.keep.as_mut() {
            if kept.len() + buf.len() <= MERGE_MAX_BYTES {
                kept.extend_from_slice(buf);
            } else {
                self.keep = None;
            }
        }
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

/// Writes `bytes` into a staged file in pieces.
fn write_all(staged: &mut Box<dyn StagedWrite>, bytes: &[u8]) -> Result<(), FsError> {
    for chunk in bytes.chunks(64 * 1024) {
        staged.write(chunk)?;
    }
    Ok(())
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
        // Г8 в, Г9: the files that become the common version are kept as bases first.
        for link in std::mem::take(&mut plan.link_bases) {
            self.keep_base_of_file(&link)?;
        }
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
                Err(error @ (FsError::NoSpace | FsError::AccessDenied(_))) => {
                    let srv = Srv::from_record(&rec);
                    fail(plan, None, &srv, ItemErrorKind::Disk(error));
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
            for m in pending {
                match self.apply_move(&m, plan, ctx, report)? {
                    Step::Done => {
                        for up in ancestors(&m.from) {
                            plan.cleanup.insert(up.to_string());
                        }
                    }
                    Step::Busy => next.push(m),
                    Step::Skipped => {}
                }
            }
            pending = next;
            // An independent rename must not delay breaking a cycle: the remaining two
            // rounds are needed to move both files of a swap to their final names.
            if !pending.is_empty() && round < 2 {
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
                    match self
                        .ports
                        .fs
                        .move_to_trash(&disk, TrashReason::RemoteDeletion)
                    {
                        Ok(()) => {}
                        Err(error @ FsError::AccessDenied(_)) => {
                            fail(
                                plan,
                                seq,
                                &Srv::from_record(&rec),
                                ItemErrorKind::Disk(error),
                            );
                            continue;
                        }
                        Err(error) => return Err(error.into()),
                    }
                    report.trashed += 1;
                    report.trashed_paths.push(disk.to_string());
                    for up in ancestors(&disk) {
                        plan.cleanup.insert(up.to_string());
                    }
                    self.ports.state.apply(&vec![StateOp::PutItem(rec)])?;
                }
                Ok(_) => plan.hold_before(seq), // changed since: the next pass decides (С9)
                Err(FsError::NotFound(_)) => {
                    self.ports.state.apply(&vec![StateOp::PutItem(rec)])?;
                }
                Err(error @ FsError::AccessDenied(_)) => {
                    fail(
                        plan,
                        seq,
                        &Srv::from_record(&rec),
                        ItemErrorKind::Disk(error),
                    );
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
            Err(error @ FsError::AccessDenied(_)) => {
                fail(plan, m.seq, &srv, ItemErrorKind::Disk(error));
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
                self.finish_set(copy)?;
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
            Err(error @ (FsError::NoSpace | FsError::AccessDenied(_))) => {
                fail(plan, m.seq, &srv, ItemErrorKind::Disk(error));
                return Ok(Step::Skipped);
            }
            Err(error) => return Err(error.into()),
        }
        report.renamed += 1;
        if let Some(copy) = &m.placed_as {
            self.finish_set(copy)?;
            self.note_conflict(copy, ctx, report)?;
        }
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
                Err(error @ FsError::AccessDenied(_)) => {
                    fail(plan, put.seq, srv, ItemErrorKind::Disk(error));
                    return Ok(Step::Skipped);
                }
                Err(error) => return Err(error.into()),
            },
            None => match self.ports.fs.read(&put.target) {
                Ok(_) => return Ok(Step::Busy),
                Err(FsError::NotFound(_)) => (None, put.target.clone()),
                Err(error @ FsError::AccessDenied(_)) => {
                    fail(plan, put.seq, srv, ItemErrorKind::Disk(error));
                    return Ok(Step::Skipped);
                }
                Err(error) => return Err(error.into()),
            },
        };
        let note_path = srv.path.as_str();
        let wants_base = is_mergeable_path(note_path) && srv.size <= MERGE_MAX_BYTES as u64;

        // К1, Г4: both sides changed a note that has a base: the merge comes before the copy.
        let mut server_bytes: Option<Vec<u8>> = None;
        let mut merged: Option<Vec<u8>> = None;
        if let (true, Some(copy), Some(local)) = (put.merge, &put.copy, &local_bytes) {
            if let Some(base) = &copy.base {
                if wants_base && local.len() <= MERGE_MAX_BYTES {
                    let server = match self.download_bytes(srv) {
                        Ok(bytes) => bytes,
                        Err(Failed::Item(kind)) => {
                            fail(plan, put.seq, srv, kind);
                            return Ok(Step::Skipped);
                        }
                        Err(Failed::Fs(error)) => return Err(error.into()),
                        Err(Failed::Pass(flow)) => return Err(flow),
                    };
                    if let MergeOutcome::Clean(bytes) = merge_text(base, local, &server) {
                        merged = Some(bytes);
                    }
                    server_bytes = Some(server);
                }
            }
        }
        let copy = if merged.is_some() {
            None
        } else {
            put.copy.as_ref()
        };
        let snapshot = put
            .existing
            .is_some()
            .then_some(SnapshotReason::SyncOverwrite);

        let mut kept: Option<Vec<u8>> = None;
        // The server's edits are in the local file already (Г16): nothing is written.
        let already_there = merged.is_some() && merged.as_deref() == local_bytes.as_deref();
        if !already_there {
            let mut staged = match self.ports.fs.begin_write(&write_path) {
                Ok(staged) => staged,
                Err(error @ (FsError::NoSpace | FsError::AccessDenied(_))) => {
                    fail(plan, put.seq, srv, ItemErrorKind::Disk(error));
                    return Ok(Step::Skipped);
                }
                Err(error) => return Err(error.into()),
            };
            let content = merged.as_deref().or(server_bytes.as_deref());
            let written = match content {
                Some(bytes) => write_all(&mut staged, bytes).map_err(Failed::Fs),
                None => self
                    .download_into(srv, &mut staged, wants_base)
                    .map(|bytes| {
                        kept = bytes;
                    }),
            };
            match written {
                Ok(()) => {}
                Err(Failed::Item(kind)) => {
                    staged.abort();
                    fail(plan, put.seq, srv, kind);
                    return Ok(Step::Skipped);
                }
                Err(Failed::Fs(error @ (FsError::NoSpace | FsError::AccessDenied(_)))) => {
                    staged.abort();
                    fail(plan, put.seq, srv, ItemErrorKind::Disk(error));
                    return Ok(Step::Skipped);
                }
                Err(Failed::Fs(error)) => {
                    staged.abort();
                    return Err(error.into());
                }
                Err(Failed::Pass(flow)) => {
                    staged.abort();
                    return Err(flow);
                }
            }
            if let (Some(copy), Some(bytes)) = (copy, &local_bytes) {
                // The local content is saved first, then listed, then replaced (Д47, Г23).
                match self.write_copy(copy, bytes) {
                    Ok(()) => {}
                    Err(error @ (FsError::NoSpace | FsError::AccessDenied(_))) => {
                        staged.abort();
                        fail(plan, put.seq, srv, ItemErrorKind::Disk(error));
                        return Ok(Step::Skipped);
                    }
                    Err(error) => {
                        staged.abort();
                        return Err(error.into());
                    }
                }
                self.note_conflict(copy, ctx, report)?;
            }
            match staged.publish(snapshot) {
                Ok(()) => {}
                Err(error @ (FsError::NoSpace | FsError::AccessDenied(_))) => {
                    fail(plan, put.seq, srv, ItemErrorKind::Disk(error));
                    return Ok(Step::Skipped);
                }
                Err(error) => return Err(error.into()),
            }
        }
        if merged.is_some() {
            report.merged_paths.push(put.target.clone());
        }
        report.downloaded += 1;
        if plan.restored.contains(&put.target) {
            report.restored_paths.push(put.target.clone());
        }
        // The server's version is the base now, whatever was written (Г8 а, Г16); it is kept
        // before the state says so (Г9).
        if let (Some(bytes), Some(hash)) = (server_bytes.or(kept), srv.hash) {
            if base_eligible(note_path, &bytes) && hash_of(&bytes) == hash {
                self.ports.state.base_put(&srv.item, &hash, &bytes)?;
            }
        }
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
                Err(error @ (FsError::NoSpace | FsError::AccessDenied(_))) => {
                    fail(plan, keep.seq, srv, ItemErrorKind::Disk(error));
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            };
            match self.download_into(srv, &mut staged, false) {
                Ok(_) => {}
                Err(Failed::Item(kind)) => {
                    staged.abort();
                    fail(plan, keep.seq, srv, kind);
                    return Ok(());
                }
                Err(Failed::Fs(error)) => {
                    staged.abort();
                    return Err(error.into());
                }
                Err(Failed::Pass(flow)) => {
                    staged.abort();
                    return Err(flow);
                }
            }
            match staged.publish(None) {
                Ok(()) => {}
                Err(error @ (FsError::NoSpace | FsError::AccessDenied(_))) => {
                    fail(plan, keep.seq, srv, ItemErrorKind::Disk(error));
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.finish_set(&keep.copy)?;
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
        keep: bool,
    ) -> Result<Option<Vec<u8>>, Failed> {
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
            keep: keep.then(Vec::new),
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
            Ok(()) => Ok(sink.keep.take()),
            Err(StreamError::Crypto(error)) => Err(Failed::Item(ItemErrorKind::Invalid(error))),
            Err(StreamError::Read(error)) => Err(Failed::Pass(Flow::Err(
                super::model::EngineError::Remote(RemoteError::Network(error.to_string())),
            ))),
            Err(StreamError::Write(error)) => Err(match sink.failure.take() {
                Some(error @ (FsError::NoSpace | FsError::AccessDenied(_))) => {
                    Failed::Item(ItemErrorKind::Disk(error))
                }
                Some(other) => Failed::Pass(other.into()),
                None => Failed::Pass(FsError::Io(error.to_string()).into()),
            }),
        }
    }

    /// Downloads the body of `srv` into memory, verified like a file (Д68).
    fn download_bytes(&mut self, srv: &Srv) -> Result<Vec<u8>, Failed> {
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
        let mut out = Vec::new();
        let result = open_body_stream(
            &self.config.vk,
            &body,
            srv.size,
            &hash,
            &mut reader,
            &mut out,
        );
        match result {
            Ok(()) => Ok(out),
            Err(StreamError::Crypto(error)) => Err(Failed::Item(ItemErrorKind::Invalid(error))),
            Err(StreamError::Read(error)) => Err(Failed::Pass(Flow::Err(
                super::model::EngineError::Remote(RemoteError::Network(error.to_string())),
            ))),
            Err(StreamError::Write(error)) => {
                Err(Failed::Pass(FsError::Io(error.to_string()).into()))
            }
        }
    }

    /// Writes `bytes` to `path`: nothing when the same bytes are there, a snapshot of what else
    /// is there (Д53).
    fn put_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), FsError> {
        let snapshot = match self.ports.fs.read(path) {
            Ok(existing) if existing == bytes => return Ok(()),
            Ok(_) => Some(SnapshotReason::SyncOverwrite),
            Err(FsError::NotFound(_)) => None,
            Err(error) => return Err(error),
        };
        let mut staged = self.ports.fs.begin_write(path)?;
        if let Err(error) = write_all(&mut staged, bytes) {
            staged.abort();
            return Err(error);
        }
        staged.publish(snapshot)
    }

    /// Creates the second version of a conflict (Д47, Г23): `other` first, then the base, then
    /// `meta.json`; or the old copy beside the file (Г19). Nothing when it is there already or
    /// arrives from the server.
    fn write_copy(&mut self, copy: &CopyPlan, bytes: &[u8]) -> Result<(), FsError> {
        if copy.from_server {
            return Ok(());
        }
        if !copy.exists {
            self.put_file(&copy.path, bytes)?;
        }
        self.finish_set(copy)
    }

    /// The files of a set besides `other` (Г21, Г23): the base, then `meta.json` last. The file
    /// `other` is there already, made or moved by the caller.
    fn finish_set(&mut self, copy: &CopyPlan) -> Result<(), FsError> {
        if copy.legacy || copy.from_server {
            return Ok(());
        }
        let paths = set_paths(&copy.id, &copy.original);
        let name_of = |path: &str| path.rsplit('/').next().unwrap_or(path).to_string();
        if let Some(base) = &copy.base {
            self.put_file(&paths.base, base)?;
        }
        let meta = SetMeta {
            id: copy.id.clone(),
            kind: copy.kind,
            item_id: copy.item,
            path: copy.original.clone(),
            other: name_of(&paths.other),
            other_hash: copy.other_hash,
            other_size: copy.other_size,
            base: copy.base.as_ref().map(|_| name_of(&paths.base)),
            base_hash: copy.base.as_deref().map(hash_of),
        };
        self.put_file(&paths.meta, &encode_meta(&meta))
    }

    /// The file becomes the base of its record, unchanged (Г8 в): its bytes are kept when it is
    /// a note that can be merged, before the state says so (Г9).
    fn keep_base_of_file(&mut self, link: &LinkBase) -> Res<()> {
        match self.ports.fs.read(&link.disk) {
            Ok(bytes) if hash_of(&bytes) == link.hash && base_eligible(&link.path, &bytes) => {
                self.ports.state.base_put(&link.item, &link.hash, &bytes)?;
                Ok(())
            }
            // Not there, changed, or not a note: no base, a later clash is a conflict (Г10).
            Ok(_) | Err(FsError::NotFound(_) | FsError::AccessDenied(_)) => Ok(()),
            Err(error) => Err(error.into()),
        }
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
