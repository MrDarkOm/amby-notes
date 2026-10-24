//! The mini-engine: a small **working** implementation of the same interface as the real engine,
//! for files only (no folders, no name rules, no resumable uploads). It exists for two reasons
//! (plan, раздел 6, «Где тест нельзя написать просто по плану»):
//!
//! - with [`Flaw::None`] it shows that the scenarios and the simulation can be satisfied by an
//!   implementation, so they are not tests that nothing can pass;
//! - with one [`Flaw`] switched on it is a broken engine with exactly one error, and the
//!   simulation must catch it with its own invariant. A broken engine that only panics on a stub
//!   proves nothing, which is why all of them are real.
//!
//! The rules are appendix В of the plan, in the same words where the mini-engine supports them.
//! It is test code: it does not call the todo!() functions of `sync/core/src/engine`.

use std::collections::{BTreeMap, BTreeSet};

use amby_sync_core::crypto::body::{open_body, seal_body};
use amby_sync_core::crypto::error::CryptoError;
use amby_sync_core::crypto::header::{open_header, seal_header, Header, ItemKind};
use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::{
    ChangeEntry, CommitItem, CommitReply, ConflictKind, ConflictRecord, CycleOutcome, CycleReport,
    CycleRequest, Direction, EngineConfig, EngineError, FsError, ItemError, ItemErrorKind,
    ItemRecord, LocalKind, PendingCommit, PlannedChange, PlannedKind, Ports, ReadOnlyItem,
    RemoteError, RootState, SnapshotReason, StateError, StateOp, StopReason, SyncEngine, SyncState,
    TrashReason,
};
use amby_sync_proto::PART_SIZE;

use crate::conflicts as sets;
use crate::linemerge;
use crate::vfs::Hash;

/// The one error of a broken engine; [`Flaw::None`] is the correct mini-engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flaw {
    None,
    /// Both edited: the server's version wins and the local one is dropped, no copy (О5, Р7).
    LastWriterWins,
    /// Deleted on one device, edited on the other: the deletion wins (Р7, Р8).
    DeleteBeatsEdit,
    /// A server that lost its data (`instance_id` changed, feed empty) is read as "delete
    /// everything" (Р8, С7).
    EmptyServerDeletesAll,
    /// An older version of an item from the server is accepted (Р6, С6).
    NoRollbackCheck,
    /// No stop before a mass change (Р8, О6).
    NoMassGuard,
    /// A file is replaced without a snapshot (Р8, О4).
    NoSnapshot,
    /// A missing or empty vault folder is read as "the user deleted everything" (Р8, С8).
    EmptyVaultSendsDeletes,
    /// Edits of two computers in different places are merged, but one line of the other side's
    /// edit is lost in the result (К1, Г15 д).
    MergeDropsLine,
    /// Edits of two computers are never merged: every both-edited note is a conflict (К1, Г4).
    NeverMerges,
    /// The second version of a conflict is a copy beside the file, as before stage Э4б (К2, Г20).
    ConflictCopyInTree,
    /// A conflict is written into the file with marks, and no second version is kept (К2, Г15 е).
    MergeWritesMarks,
    /// Without a base the two versions are "merged" anyway, by taking the lines of both (К1, Г10).
    MergeWithoutBase,
}

pub const ALL_FLAWS: [Flaw; 12] = [
    Flaw::LastWriterWins,
    Flaw::DeleteBeatsEdit,
    Flaw::EmptyServerDeletesAll,
    Flaw::NoRollbackCheck,
    Flaw::NoMassGuard,
    Flaw::NoSnapshot,
    Flaw::EmptyVaultSendsDeletes,
    Flaw::MergeDropsLine,
    Flaw::NeverMerges,
    Flaw::ConflictCopyInTree,
    Flaw::MergeWritesMarks,
    Flaw::MergeWithoutBase,
];

pub struct MiniEngine {
    ports: Ports,
    config: EngineConfig,
    flaw: Flaw,
}

macro_rules! builder {
    ($name:ident, $flaw:expr) => {
        pub fn $name(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
            Box::new(MiniEngine {
                ports,
                config,
                flaw: $flaw,
            })
        }
    };
}

builder!(correct, Flaw::None);
builder!(last_writer_wins, Flaw::LastWriterWins);
builder!(delete_beats_edit, Flaw::DeleteBeatsEdit);
builder!(empty_server_deletes_all, Flaw::EmptyServerDeletesAll);
builder!(no_rollback_check, Flaw::NoRollbackCheck);
builder!(no_mass_guard, Flaw::NoMassGuard);
builder!(no_snapshot, Flaw::NoSnapshot);
builder!(empty_vault_sends_deletes, Flaw::EmptyVaultSendsDeletes);
builder!(merge_drops_line, Flaw::MergeDropsLine);
builder!(never_merges, Flaw::NeverMerges);
builder!(conflict_copy_in_tree, Flaw::ConflictCopyInTree);
builder!(merge_writes_marks, Flaw::MergeWritesMarks);
builder!(merge_without_base, Flaw::MergeWithoutBase);

/// The builder of a flaw.
pub fn builder_of(flaw: Flaw) -> amby_sync_core::engine::EngineBuilder {
    match flaw {
        Flaw::None => correct,
        Flaw::LastWriterWins => last_writer_wins,
        Flaw::DeleteBeatsEdit => delete_beats_edit,
        Flaw::EmptyServerDeletesAll => empty_server_deletes_all,
        Flaw::NoRollbackCheck => no_rollback_check,
        Flaw::NoMassGuard => no_mass_guard,
        Flaw::NoSnapshot => no_snapshot,
        Flaw::EmptyVaultSendsDeletes => empty_vault_sends_deletes,
        Flaw::MergeDropsLine => merge_drops_line,
        Flaw::NeverMerges => never_merges,
        Flaw::ConflictCopyInTree => conflict_copy_in_tree,
        Flaw::MergeWritesMarks => merge_writes_marks,
        Flaw::MergeWithoutBase => merge_without_base,
    }
}

enum Flow {
    Stop(StopReason),
    Err(EngineError),
    Retry,
}

impl From<EngineError> for Flow {
    fn from(e: EngineError) -> Self {
        Flow::Err(e)
    }
}
impl From<RemoteError> for Flow {
    fn from(e: RemoteError) -> Self {
        match e {
            RemoteError::Unauthorized | RemoteError::Revoked => {
                Flow::Stop(StopReason::AuthRequired)
            }
            other => Flow::Err(EngineError::Remote(other)),
        }
    }
}
impl From<FsError> for Flow {
    fn from(e: FsError) -> Self {
        Flow::Err(EngineError::Fs(e))
    }
}
impl From<StateError> for Flow {
    fn from(e: StateError) -> Self {
        Flow::Err(match e {
            StateError::Locked => EngineError::Locked,
            other => EngineError::State(other),
        })
    }
}
impl From<CryptoError> for Flow {
    fn from(e: CryptoError) -> Self {
        Flow::Err(EngineError::Crypto(e))
    }
}

type Res<T> = Result<T, Flow>;

#[derive(Clone)]
struct LocalFile {
    hash: Hash,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Local {
    Same,
    Edited,
    Moved(String),
    Deleted,
}

#[derive(Clone)]
struct Remote {
    entry: ChangeEntry,
    header: Header,
}

/// What to do with an item, decided before the first action (Д17).
enum Plan {
    /// The state learns the server's version; the disk is as it should be.
    Link(ItemRecord),
    /// A tombstone.
    Tombstone(ItemRecord),
    /// Write the server's content to `path`. `from` is where the local file is now (renamed
    /// first). `overwrite`: a local file of this item is replaced. `copy`: keep the local content
    /// as a conflict copy first.
    Write {
        remote: Remote,
        path: String,
        from: Option<String>,
        overwrite: bool,
        /// An old-style copy beside the file: only inside `.amby/conflicts/` (Г19), or the flaw.
        copy: Option<(String, Vec<u8>, ConflictKind)>,
        /// The local version that meets the server's: merged if it can be, else kept in a set.
        clash: Option<Clash>,
        rec: ItemRecord,
    },
    /// After the user's `resync` (Д56): the local version stays at the path and goes up as a new
    /// version; the server's differing version is kept as a conflict copy.
    KeepLocal {
        remote: Remote,
        clash: Clash,
        rec: ItemRecord,
    },
    /// Rename only.
    Rename {
        from: String,
        to: String,
        rec: ItemRecord,
    },
    /// The local file goes to the trash (remote deletion).
    Trash { path: String, rec: ItemRecord },
}

/// A second version on its way to a set (Г20–Г23).
#[derive(Clone)]
struct Clash {
    id: String,
    kind: ConflictKind,
    /// The path that keeps the name.
    original: String,
    item: ItemId,
    /// The displaced version (for `KeepLocal` filled in when the server's body is downloaded).
    other: Vec<u8>,
    /// The common base, when this device has it and the note qualifies (Г6, Г10).
    base: Option<Vec<u8>>,
    /// The server has this very set (made by another device): it arrives by itself (Д46).
    from_server: bool,
}

/// What the engine does with the local version that meets the server's.
enum Decision {
    /// Nothing is kept: the flaw `LastWriterWins`, or the copy is there already (Д46).
    Nothing,
    /// A copy beside the file, as before stage Э4б (Г19, or the flaw `ConflictCopyInTree`).
    Copy(String, Vec<u8>, ConflictKind),
    /// Merge if it can be, else a set (Г4, Г20).
    Clash(Clash),
}

impl Decision {
    fn split(self) -> (Option<(String, Vec<u8>, ConflictKind)>, Option<Clash>) {
        match self {
            Decision::Nothing => (None, None),
            Decision::Copy(path, bytes, kind) => (Some((path, bytes, kind)), None),
            Decision::Clash(clash) => (None, Some(clash)),
        }
    }
}

fn conflict_id(item: &ItemId, local_hash: &Hash, remote_version: u64, attempt: u32) -> String {
    let mut data = b"amby-sync/conflict/1".to_vec();
    data.extend_from_slice(item.as_bytes());
    data.extend_from_slice(local_hash);
    data.extend_from_slice(&remote_version.to_be_bytes());
    if attempt != 0 {
        data.extend_from_slice(&attempt.to_be_bytes());
    }
    hex::encode(&blake3_hash(&data)[..6])
}

fn copy_path(original: &str, id: &str) -> String {
    let (dir, name) = match original.rfind('/') {
        Some(i) => (&original[..=i], &original[i + 1..]),
        None => ("", original),
    };
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{dir}{}.{id}-conflict{}", &name[..i], &name[i..]),
        _ => format!("{dir}{name}.{id}-conflict"),
    }
}

fn excluded(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    (name.starts_with('.') && name.contains(".amby-tmp-"))
        || name == ".DS_Store"
        || path.starts_with(".git/")
        || path.starts_with(".obsidian/")
        || (path.starts_with(".amby/") && !path.starts_with(".amby/conflicts/"))
}

/// Does the content of a note qualify for a base and for merging (Г5)?
fn mergeable_md(path: &str, len: usize) -> bool {
    path.to_ascii_lowercase().ends_with(".md")
        && !path.starts_with(".amby/")
        && len <= linemerge::MAX_BYTES
}

/// The flaw `MergeDropsLine`: the first line the local side wrote that the remote side does not
/// have is missing from the result.
fn drop_a_line(merged: &[u8], local: &[u8], remote: &[u8]) -> Vec<u8> {
    let remote_lines: Vec<&[u8]> = remote.split_inclusive(|b| *b == b'\n').collect();
    let local_lines: Vec<&[u8]> = local.split_inclusive(|b| *b == b'\n').collect();
    let mut dropped = false;
    let mut out = Vec::new();
    for line in merged.split_inclusive(|b| *b == b'\n') {
        if !dropped && local_lines.contains(&line) && !remote_lines.contains(&line) {
            dropped = true;
            continue;
        }
        out.extend_from_slice(line);
    }
    out
}

/// The flaw `MergeWithoutBase`: the lines of `first`, then the lines of `second` that it lacks.
fn union_of_lines(first: &[u8], second: &[u8]) -> Vec<u8> {
    let known: Vec<&[u8]> = first.split_inclusive(|b| *b == b'\n').collect();
    let mut out = first.to_vec();
    if !out.is_empty() && !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    for line in second.split_inclusive(|b| *b == b'\n') {
        if !known.contains(&line) {
            out.extend_from_slice(line);
        }
    }
    out
}

fn mass(count: usize, total: usize, min: usize, percent: usize) -> bool {
    count >= min && count * 100 > total * percent
}

impl MiniEngine {
    fn st(&mut self) -> Res<SyncState> {
        Ok(self.ports.state.load()?)
    }

    fn tx(&mut self, ops: Vec<StateOp>) -> Res<()> {
        Ok(self.ports.state.apply(&ops)?)
    }

    fn record_from(item: ItemId, header: &Header, version: u64) -> ItemRecord {
        ItemRecord {
            item_id: item,
            kind: header.kind,
            path: header.path.clone(),
            content_hash: header.content_hash,
            size: header.size,
            mtime_ns: 0,
            version,
            body_id: header.body_id,
            deleted: header.deleted,
            newer_format: false,
            extra: header.extra.clone(),
        }
    }

    /// The base of a record, if this device has it and the note qualifies (Г6, Г10).
    fn load_base(&mut self, rec: &ItemRecord) -> Res<Option<Vec<u8>>> {
        let Some(hash) = rec.content_hash else {
            return Ok(None);
        };
        if !mergeable_md(&rec.path, rec.size as usize) {
            return Ok(None);
        }
        Ok(self.ports.state.base_get(&rec.item_id, &hash)?)
    }

    /// Keeps `bytes` as the base of `item` (Г8), written before the state refers to it (Г9).
    fn keep_base(&mut self, item: &ItemId, path: &str, bytes: &[u8]) -> Res<()> {
        if mergeable_md(path, bytes.len())
            && std::str::from_utf8(bytes).is_ok()
            && !bytes.contains(&0)
        {
            self.ports
                .state
                .base_put(item, &blake3_hash(bytes), bytes)?;
        }
        Ok(())
    }

    fn scan(&mut self) -> Res<BTreeMap<String, LocalFile>> {
        let listing = match self.ports.fs.list() {
            Ok(l) => l,
            Err(FsError::NotFound(_)) if self.flaw == Flaw::EmptyVaultSendsDeletes => {
                return Ok(BTreeMap::new())
            }
            Err(e) => return Err(e.into()),
        };
        let mut out = BTreeMap::new();
        for entry in listing.entries {
            if entry.kind != LocalKind::File || excluded(&entry.path) {
                continue;
            }
            let bytes = self.ports.fs.read(&entry.path)?;
            out.insert(
                entry.path,
                LocalFile {
                    hash: blake3_hash(&bytes),
                    bytes,
                },
            );
        }
        Ok(out)
    }

    /// Classifies every live record against the disk (Д13): unique hash pairs are renames.
    fn classify(
        &self,
        state: &SyncState,
        local: &BTreeMap<String, LocalFile>,
    ) -> BTreeMap<[u8; 16], Local> {
        let record_paths: BTreeSet<&String> = state
            .items
            .values()
            .filter(|r| !r.deleted)
            .map(|r| &r.path)
            .collect();
        let new_files: Vec<(&String, &LocalFile)> = local
            .iter()
            .filter(|(p, _)| !record_paths.contains(p))
            .collect();
        let missing: Vec<&ItemRecord> = state
            .items
            .values()
            .filter(|r| !r.deleted && !local.contains_key(&r.path))
            .collect();
        let mut out = BTreeMap::new();
        for rec in state.items.values().filter(|r| !r.deleted) {
            let class = match local.get(&rec.path) {
                Some(file) if Some(file.hash) == rec.content_hash => Local::Same,
                Some(_) => Local::Edited,
                None => {
                    let hash = rec.content_hash;
                    let pairs: Vec<&&String> = new_files
                        .iter()
                        .filter(|(_, f)| Some(f.hash) == hash)
                        .map(|(p, _)| p)
                        .collect();
                    let same_missing = missing.iter().filter(|m| m.content_hash == hash).count();
                    if pairs.len() == 1 && same_missing == 1 {
                        Local::Moved((*pairs[0]).clone())
                    } else {
                        Local::Deleted
                    }
                }
            };
            out.insert(*rec.item_id.as_bytes(), class);
        }
        out
    }

    fn upload(&mut self, bytes: &[u8]) -> Res<BodyId> {
        let body = BodyId::random(&mut *self.ports.rng);
        let sealed = seal_body(&self.config.vk, &body, bytes, &mut *self.ports.rng)?;
        let state = self
            .ports
            .remote
            .blob_start(&body, sealed.len() as u64, None)?;
        for (index, part) in sealed.chunks(PART_SIZE as usize).enumerate() {
            if !state.uploaded.contains(&(index as u64)) {
                self.ports.remote.blob_put_part(&body, index as u64, part)?;
            }
        }
        self.ports.remote.blob_complete(&body)?;
        Ok(body)
    }

    fn download(&mut self, remote: &Remote) -> Result<Vec<u8>, ItemErrorKind> {
        let header = &remote.header;
        let body_id = header.body_id.ok_or(ItemErrorKind::Inconsistent)?;
        let mut stream = self
            .ports
            .remote
            .blob_download(&body_id)
            .map_err(|_| ItemErrorKind::Inconsistent)?;
        let mut sealed = Vec::new();
        std::io::Read::read_to_end(&mut stream, &mut sealed)
            .map_err(|_| ItemErrorKind::Inconsistent)?;
        drop(stream);
        open_body(
            &self.config.vk,
            &body_id,
            header.size,
            &header.content_hash.ok_or(ItemErrorKind::Inconsistent)?,
            &sealed,
        )
        .map_err(ItemErrorKind::Invalid)
    }

    fn write_file(&mut self, path: &str, bytes: &[u8], snapshot: bool) -> Result<(), FsError> {
        let mut staged = self.ports.fs.begin_write(path)?;
        let result = (|| {
            for chunk in bytes.chunks(64 * 1024) {
                staged.write(chunk)?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            staged.abort();
            return Err(e);
        }
        let reason = if snapshot && self.flaw != Flaw::NoSnapshot {
            Some(SnapshotReason::SyncOverwrite)
        } else {
            None
        };
        staged.publish(reason)
    }

    fn sealed_header(&mut self, item: &ItemId, header: &Header) -> Res<Vec<u8>> {
        Ok(seal_header(
            &self.config.vk,
            &self.config.space_id,
            item,
            header,
            &mut *self.ports.rng,
        )?)
    }

    fn new_header(
        version: u64,
        path: &str,
        bytes: Option<&[u8]>,
        body: Option<BodyId>,
        deleted: bool,
        extra: &BTreeMap<String, serde_json::Value>,
    ) -> Header {
        Header {
            format: 1,
            version,
            kind: ItemKind::File,
            path: path.to_string(),
            size: bytes.map_or(0, |b| b.len() as u64),
            mtime_ms: 0,
            content_hash: bytes.map(blake3_hash),
            body_id: body,
            deleted,
            extra: extra.clone(),
        }
    }

    // ----- a pass -----

    fn attempt(&mut self, req: &CycleRequest, report: &mut CycleReport) -> Res<()> {
        let approvals = req.approvals;
        let info = self.ports.remote.info()?;
        let mut state = self.st()?;
        let mut full = false;

        // Server identity (Д56).
        if approvals.resync {
            self.tx(vec![
                StateOp::ResetServerLink,
                StateOp::SetInstance(info.instance_id),
            ])?;
            state = self.st()?;
            full = true;
        } else {
            match state.instance_id {
                None => {
                    self.tx(vec![StateOp::SetInstance(info.instance_id)])?;
                    state.instance_id = Some(info.instance_id);
                }
                Some(known) if known != info.instance_id => {
                    if self.flaw != Flaw::EmptyServerDeletesAll {
                        return Err(Flow::Stop(StopReason::ServerReset {
                            old: known,
                            new: info.instance_id,
                        }));
                    }
                    self.tx(vec![StateOp::SetInstance(info.instance_id)])?;
                    state.instance_id = Some(info.instance_id);
                }
                _ => {}
            }
        }

        // An unconfirmed commit goes first (С2, Д7).
        if let Some(pending) = state.commit.clone() {
            match self
                .ports
                .remote
                .commit(&pending.commit_id, &pending.items)?
            {
                CommitReply::Accepted(_) => {
                    let mut ops: Vec<StateOp> =
                        pending.after.into_iter().map(StateOp::PutItem).collect();
                    ops.push(StateOp::SetCommit(None));
                    self.tx(ops)?;
                }
                CommitReply::Conflict(_) => self.tx(vec![StateOp::SetCommit(None)])?,
            }
            state = self.st()?;
        }

        // The vault folder (Д55).
        if self.ports.fs.root_state()? == RootState::Missing
            && self.flaw != Flaw::EmptyVaultSendsDeletes
        {
            return Err(Flow::Stop(StopReason::VaultMissing));
        }
        let local = self.scan()?;
        let live = state.items.values().filter(|r| !r.deleted).count();
        if live > 0
            && local.is_empty()
            && !approvals.accept_empty_vault
            && self.flaw != Flaw::EmptyVaultSendsDeletes
        {
            return Err(Flow::Stop(StopReason::VaultEmpty));
        }

        // The feed (Д14).
        let mut cursor = if full { 0 } else { state.cursor };
        let mut entries: BTreeMap<[u8; 16], ChangeEntry> = BTreeMap::new();
        let mut head = 0;
        let mut next;
        let mut first = true;
        loop {
            let page = self.ports.remote.changes(cursor, None)?;
            if first {
                first = false;
                if page.gap && !full {
                    full = true;
                    cursor = 0;
                    continue;
                }
                if !full && page.seq < state.cursor && self.flaw != Flaw::EmptyServerDeletesAll {
                    return Err(Flow::Stop(StopReason::ServerBehind {
                        head: page.seq,
                        cursor: state.cursor,
                    }));
                }
            }
            head = head.max(page.seq);
            for entry in page.changes {
                entries.insert(*entry.item_id.as_bytes(), entry);
            }
            next = page.next;
            if !page.more {
                break;
            }
            cursor = page.next;
        }

        let mut hold: Option<u64> = None;
        let mut remotes: BTreeMap<[u8; 16], Remote> = BTreeMap::new();
        for (key, entry) in &entries {
            match open_header(
                &self.config.vk,
                &self.config.space_id,
                &entry.item_id,
                entry.version,
                &entry.header,
            ) {
                Ok(header) => {
                    remotes.insert(
                        *key,
                        Remote {
                            entry: entry.clone(),
                            header,
                        },
                    );
                }
                Err(CryptoError::UnsupportedFormat(_))
                | Err(CryptoError::UnsupportedVersion(_)) => {
                    report.read_only.push(ReadOnlyItem {
                        item_id: entry.item_id,
                        path: state.items.get(key).map(|r| r.path.clone()),
                    });
                    report.needs_update = true;
                }
                Err(error) => {
                    report.errors.push(ItemError {
                        item_id: entry.item_id,
                        kind: ItemErrorKind::Invalid(error),
                    });
                    hold = Some(hold.map_or(entry.seq - 1, |h| h.min(entry.seq - 1)));
                }
            }
        }

        // Rollback (Д57).
        if self.flaw != Flaw::NoRollbackCheck {
            for (key, remote) in &remotes {
                if let Some(rec) = state.items.get(key) {
                    let differs = remote.header.path != rec.path
                        || remote.header.content_hash != rec.content_hash
                        || remote.header.deleted != rec.deleted;
                    if remote.entry.version < rec.version
                        || (remote.entry.version == rec.version && differs)
                    {
                        return Err(Flow::Stop(StopReason::Rollback {
                            item_id: remote.entry.item_id,
                            known: rec.version,
                            got: remote.entry.version,
                        }));
                    }
                }
            }
        }

        // A server with no data at all, read as "everything was deleted" (the flaw).
        let wipe_all = self.flaw == Flaw::EmptyServerDeletesAll && head == 0 && live > 0;

        // Decisions (Д16).
        let classes = self.classify(&state, &local);
        let mut plans: Vec<Plan> = Vec::new();
        let mut undelete: BTreeMap<String, (ItemId, u64)> = BTreeMap::new();
        let mut handled: BTreeSet<[u8; 16]> = BTreeSet::new();
        let mut copies_taken: BTreeSet<String> = BTreeSet::new();

        let lww = self.flaw == Flaw::LastWriterWins;
        let conflict = |item: &ItemId,
                        original: &str,
                        file: &LocalFile,
                        remote_version: u64,
                        kind: ConflictKind,
                        base: Option<Vec<u8>>,
                        taken: &mut BTreeSet<String>|
         -> Decision {
            if lww {
                return Decision::Nothing;
            }
            let in_sets = original.starts_with(".amby/conflicts/");
            let base_hash = base.as_ref().map(|b| blake3_hash(b));
            let mut attempt = 0;
            loop {
                if in_sets {
                    // The old copy beside the file (Г19).
                    let id = conflict_id(item, &file.hash, remote_version, attempt);
                    let path = copy_path(original, &id);
                    let remote_path_taken = remotes
                        .values()
                        .any(|r| !r.header.deleted && r.header.path == path);
                    if !taken.contains(&path) && !local.contains_key(&path) && !remote_path_taken {
                        taken.insert(path.clone());
                        return Decision::Copy(path, file.bytes.clone(), kind);
                    }
                    if let Some(existing) = local.get(&path) {
                        if existing.hash == file.hash {
                            return Decision::Nothing;
                        }
                    }
                    if remotes.values().any(|r| {
                        !r.header.deleted
                            && r.header.path == path
                            && r.header.content_hash == Some(file.hash)
                    }) {
                        return Decision::Nothing;
                    }
                    attempt += 1;
                    continue;
                }
                let id = sets::set_id(
                    item.as_bytes(),
                    &file.hash,
                    remote_version,
                    base_hash.as_ref(),
                    attempt,
                );
                let other_path = sets::paths(&id, original).1;
                let remote_path_taken = remotes
                    .values()
                    .any(|r| !r.header.deleted && r.header.path == other_path);
                let mut from_server = false;
                if let Some(existing) = local.get(&other_path) {
                    if existing.hash != file.hash {
                        attempt += 1;
                        continue;
                    }
                } else if remote_path_taken {
                    if remotes.values().any(|r| {
                        !r.header.deleted
                            && r.header.path == other_path
                            && r.header.content_hash == Some(file.hash)
                    }) {
                        from_server = true; // the same set made on another device arrives (Д46)
                    } else {
                        attempt += 1;
                        continue;
                    }
                }
                if taken.contains(&other_path) {
                    attempt += 1;
                    continue;
                }
                taken.insert(other_path);
                return Decision::Clash(Clash {
                    id,
                    kind,
                    original: original.to_string(),
                    item: *item,
                    other: file.bytes.clone(),
                    base: if kind == ConflictKind::BothEdited {
                        base
                    } else {
                        None
                    },
                    from_server,
                });
            }
        };

        for (key, remote) in &remotes {
            let rec = state.items.get(key).filter(|r| !r.deleted);
            let header = &remote.header;
            let version = remote.entry.version;
            let item = remote.entry.item_id;
            if rec.map_or(true, |r| r.version != version) {
                handled.insert(*key);
            }
            let Some(rec) = rec else {
                // No base (Д41–Д44).
                let server_rec = Self::record_from(item, header, version);
                if header.deleted {
                    plans.push(Plan::Tombstone(server_rec));
                    continue;
                }
                match local.get(&header.path) {
                    Some(file) if Some(file.hash) == header.content_hash => {
                        plans.push(Plan::Link(server_rec))
                    }
                    Some(_) if approvals.resync && header.content_hash.is_some() => {
                        let remote_hash = header.content_hash.unwrap();
                        let mut attempt = 0;
                        let id = loop {
                            let id =
                                sets::set_id(item.as_bytes(), &remote_hash, version, None, attempt);
                            let candidate = sets::paths(&id, &header.path).1;
                            if !copies_taken.contains(&candidate) && !local.contains_key(&candidate)
                            {
                                copies_taken.insert(candidate);
                                break id;
                            }
                            attempt += 1;
                        };
                        plans.push(Plan::KeepLocal {
                            remote: remote.clone(),
                            clash: Clash {
                                id,
                                kind: ConflictKind::BothCreated,
                                original: header.path.clone(),
                                item,
                                other: Vec::new(),
                                base: None,
                                from_server: false,
                            },
                            rec: server_rec,
                        });
                    }
                    Some(file) => {
                        let decision = conflict(
                            &item,
                            &header.path,
                            file,
                            version,
                            ConflictKind::BothCreated,
                            None,
                            &mut copies_taken,
                        );
                        let (copy, clash) = decision.split();
                        plans.push(Plan::Write {
                            remote: remote.clone(),
                            path: header.path.clone(),
                            from: None,
                            overwrite: true,
                            copy,
                            clash,
                            rec: server_rec,
                        });
                    }
                    None => plans.push(Plan::Write {
                        remote: remote.clone(),
                        path: header.path.clone(),
                        from: None,
                        overwrite: false,
                        copy: None,
                        clash: None,
                        rec: server_rec,
                    }),
                }
                continue;
            };
            if version == rec.version {
                continue;
            }
            let class = classes.get(key).cloned().unwrap_or(Local::Same);
            let server_rec = Self::record_from(item, header, version);
            let renamed = !header.deleted && header.path != rec.path;
            let changed = !header.deleted && header.content_hash != rec.content_hash;
            let write_to =
                |path: &str, from: Option<String>, overwrite: bool, decision: Decision| {
                    let (copy, clash) = decision.split();
                    Plan::Write {
                        remote: remote.clone(),
                        path: path.to_string(),
                        from,
                        overwrite,
                        copy,
                        clash,
                        rec: server_rec.clone(),
                    }
                };
            match (class, header.deleted, renamed, changed) {
                (Local::Same, true, _, _) => plans.push(Plan::Trash {
                    path: rec.path.clone(),
                    rec: server_rec,
                }),
                (Local::Same, false, false, false) => plans.push(Plan::Link(server_rec)),
                (Local::Same, false, false, true) => {
                    plans.push(write_to(&rec.path, None, true, Decision::Nothing))
                }
                (Local::Same, false, true, false) => plans.push(Plan::Rename {
                    from: rec.path.clone(),
                    to: header.path.clone(),
                    rec: server_rec,
                }),
                (Local::Same, false, true, true) => plans.push(write_to(
                    &header.path,
                    Some(rec.path.clone()),
                    true,
                    Decision::Nothing,
                )),
                (Local::Edited, true, _, _) => {
                    if self.flaw == Flaw::DeleteBeatsEdit {
                        plans.push(Plan::Trash {
                            path: rec.path.clone(),
                            rec: server_rec,
                        });
                    } else {
                        undelete.insert(rec.path.clone(), (item, version));
                        plans.push(Plan::Tombstone(server_rec));
                    }
                }
                (Local::Edited, false, false, false) => plans.push(Plan::Link(server_rec)),
                (Local::Edited, false, false, true) => {
                    let file = &local[&rec.path];
                    if Some(file.hash) == header.content_hash {
                        plans.push(Plan::Link(server_rec));
                    } else {
                        let base = self.load_base(rec)?;
                        let decision = conflict(
                            &item,
                            &rec.path,
                            file,
                            version,
                            ConflictKind::BothEdited,
                            base,
                            &mut copies_taken,
                        );
                        plans.push(write_to(&rec.path, None, true, decision));
                    }
                }
                (Local::Edited, false, true, false) => plans.push(Plan::Rename {
                    from: rec.path.clone(),
                    to: header.path.clone(),
                    rec: server_rec,
                }),
                (Local::Edited, false, true, true) => {
                    let file = &local[&rec.path];
                    let base = self.load_base(rec)?;
                    let decision = conflict(
                        &item,
                        &header.path,
                        file,
                        version,
                        ConflictKind::BothEdited,
                        base,
                        &mut copies_taken,
                    );
                    plans.push(write_to(
                        &header.path,
                        Some(rec.path.clone()),
                        true,
                        decision,
                    ));
                }
                (Local::Moved(p), true, _, _) => {
                    if self.flaw == Flaw::DeleteBeatsEdit {
                        plans.push(Plan::Trash {
                            path: p,
                            rec: server_rec,
                        });
                    } else {
                        undelete.insert(p, (item, version));
                        plans.push(Plan::Tombstone(server_rec));
                    }
                }
                (Local::Moved(_), false, false, false) => plans.push(Plan::Link(server_rec)),
                (Local::Moved(p), false, false, true) => {
                    plans.push(write_to(&p, None, true, Decision::Nothing))
                }
                (Local::Moved(p), false, true, false) => {
                    if p == header.path {
                        plans.push(Plan::Link(server_rec));
                    } else {
                        plans.push(Plan::Rename {
                            from: p,
                            to: header.path.clone(),
                            rec: server_rec,
                        });
                    }
                }
                (Local::Moved(p), false, true, true) => {
                    plans.push(write_to(&header.path, Some(p), true, Decision::Nothing))
                }
                (Local::Deleted, true, _, _) => plans.push(Plan::Tombstone(server_rec)),
                (Local::Deleted, false, false, false) => plans.push(Plan::Link(server_rec)),
                (Local::Deleted, false, _, _) => {
                    plans.push(write_to(&header.path, None, false, Decision::Nothing))
                }
            }
        }
        if wipe_all {
            for rec in state.items.values().filter(|r| !r.deleted) {
                if !handled.contains(rec.item_id.as_bytes())
                    && classes.get(rec.item_id.as_bytes()) == Some(&Local::Same)
                {
                    let mut gone = rec.clone();
                    gone.deleted = true;
                    gone.version += 1;
                    plans.push(Plan::Trash {
                        path: rec.path.clone(),
                        rec: gone,
                    });
                }
            }
        }
        // A full feed that lacks a record: forget it, the file stays and is new (Д58).
        let mut forget: Vec<ItemId> = Vec::new();
        if full {
            for rec in state.items.values() {
                if !remotes.contains_key(rec.item_id.as_bytes())
                    && !entries.contains_key(rec.item_id.as_bytes())
                {
                    forget.push(rec.item_id);
                }
            }
        }

        // Protection against mass changes (Д54).
        if self.flaw != Flaw::NoMassGuard && !approvals.mass_change {
            let total = live.max(1);
            let incoming: Vec<PlannedChange> = plans
                .iter()
                .filter_map(|p| match p {
                    Plan::Write {
                        overwrite: true,
                        path,
                        ..
                    } => Some(PlannedChange {
                        path: path.clone(),
                        kind: PlannedKind::Overwrite,
                    }),
                    Plan::Trash { path, .. } => Some(PlannedChange {
                        path: path.clone(),
                        kind: PlannedKind::Trash,
                    }),
                    _ => None,
                })
                .collect();
            if mass(
                incoming.len(),
                total,
                self.config.mass_min_files,
                self.config.mass_percent,
            ) {
                return Err(Flow::Stop(StopReason::MassChange {
                    direction: Direction::Incoming,
                    files: incoming,
                }));
            }
            let outgoing: Vec<PlannedChange> = state
                .items
                .values()
                .filter(|r| !r.deleted && !handled.contains(r.item_id.as_bytes()))
                .filter(|r| classes.get(r.item_id.as_bytes()) == Some(&Local::Deleted))
                .map(|r| PlannedChange {
                    path: r.path.clone(),
                    kind: PlannedKind::SendDelete,
                })
                .collect();
            if mass(
                outgoing.len(),
                total,
                self.config.mass_min_files,
                self.config.mass_percent,
            ) {
                return Err(Flow::Stop(StopReason::MassChange {
                    direction: Direction::Outgoing,
                    files: outgoing,
                }));
            }
        }

        // Apply the incoming plans (Д17).
        self.ports.fs.batch_begin();
        let applied = self.apply(plans, &local, report, &mut hold);
        self.ports.fs.batch_end();
        applied?;
        let mut ops: Vec<StateOp> = forget.into_iter().map(StateOp::RemoveItem).collect();
        let new_cursor = hold
            .map_or(next, |h| h.min(next))
            .max(state.cursor.min(next));
        ops.push(StateOp::SetCursor {
            cursor: if full {
                new_cursor
            } else {
                new_cursor.max(state.cursor)
            },
            head: head.max(state.head),
        });
        self.tx(ops)?;

        // Outgoing (Д18).
        if self.ports.fs.recovery_pending()? {
            report.outgoing_paused = true;
            report.full_reconcile = full;
            return Ok(());
        }
        self.push(&undelete, report)?;
        report.full_reconcile = full;
        // Only the bases the state refers to stay (Г9).
        let state = self.st()?;
        let mut keep: Vec<(ItemId, Hash)> = state
            .items
            .values()
            .filter(|r| !r.deleted)
            .filter_map(|r| r.content_hash.map(|h| (r.item_id, h)))
            .collect();
        if let Some(pending) = &state.commit {
            keep.extend(
                pending
                    .after
                    .iter()
                    .filter_map(|r| r.content_hash.map(|h| (r.item_id, h))),
            );
        }
        self.ports.state.base_prune(&keep)?;
        Ok(())
    }

    fn apply(
        &mut self,
        plans: Vec<Plan>,
        local: &BTreeMap<String, LocalFile>,
        report: &mut CycleReport,
        hold: &mut Option<u64>,
    ) -> Res<()> {
        for plan in plans {
            match plan {
                Plan::Link(rec) => {
                    // Equal on both sides: the content is the base from now on (Г8 в).
                    if let (Some(file), Some(hash)) = (local.get(&rec.path), rec.content_hash) {
                        if file.hash == hash {
                            self.keep_base(&rec.item_id, &rec.path, &file.bytes)?;
                        }
                    }
                    self.tx(vec![StateOp::PutItem(rec)])?;
                }
                Plan::Tombstone(rec) => self.tx(vec![StateOp::PutItem(rec)])?,
                Plan::Rename { from, to, rec } => {
                    self.make_room(&to, &rec, local, report)?;
                    self.ports.fs.rename(&from, &to)?;
                    report.renamed += 1;
                    self.tx(vec![StateOp::PutItem(rec)])?;
                }
                Plan::KeepLocal {
                    remote,
                    mut clash,
                    rec,
                } => {
                    let bytes = match self.download(&remote) {
                        Ok(bytes) => bytes,
                        Err(kind) => {
                            report.errors.push(ItemError {
                                item_id: remote.entry.item_id,
                                kind,
                            });
                            let seq = remote.entry.seq;
                            *hold = Some(hold.map_or(seq - 1, |h| h.min(seq - 1)));
                            continue;
                        }
                    };
                    clash.other = bytes;
                    self.write_set(&clash, report)?;
                    self.tx(vec![StateOp::PutItem(rec)])?;
                }
                Plan::Trash { path, rec } => {
                    // The file must still be what it was (Д17); otherwise the next pass decides.
                    let still = self.ports.fs.read(&path).ok().map(|b| blake3_hash(&b));
                    let was = local.get(&path).map(|f| f.hash);
                    if still.is_some() && still == was {
                        self.ports
                            .fs
                            .move_to_trash(&path, TrashReason::RemoteDeletion)?;
                        report.trashed += 1;
                        report.trashed_paths.push(path.to_string());
                    }
                    self.tx(vec![StateOp::PutItem(rec)])?;
                }
                Plan::Write {
                    remote,
                    path,
                    from,
                    overwrite,
                    copy,
                    clash,
                    rec,
                } => {
                    let bytes = match self.download(&remote) {
                        Ok(bytes) => bytes,
                        Err(kind) => {
                            report.errors.push(ItemError {
                                item_id: remote.entry.item_id,
                                kind,
                            });
                            let seq = remote.entry.seq;
                            *hold = Some(hold.map_or(seq - 1, |h| h.min(seq - 1)));
                            continue;
                        }
                    };
                    let server_bytes = bytes.clone();
                    let mut bytes = bytes;
                    if let Some(clash) = &clash {
                        // The local version meets the server's: merge, or keep it in a set (К1, К2).
                        if let Some((combined, truly_merged)) =
                            self.settle_clash(clash, &server_bytes, &path, report)?
                        {
                            if truly_merged {
                                report.merged_paths.push(path.clone());
                            }
                            bytes = combined;
                        }
                    }
                    if let Some((copy_path, copy_bytes, kind)) = copy {
                        self.write_file(&copy_path, &copy_bytes, false)?;
                        let id = copy_path
                            .rsplit('/')
                            .next()
                            .and_then(|n| n.split('.').rev().nth(1).map(str::to_string))
                            .unwrap_or_default()
                            .trim_end_matches("-conflict")
                            .to_string();
                        let record = ConflictRecord {
                            id: id.clone(),
                            kind,
                            original_path: path.clone(),
                            copy_path: copy_path.clone(),
                            created_ms: self.ports.clock.now_ms(),
                        };
                        report.conflicts.push(record.clone());
                        self.tx(vec![StateOp::AddConflict(record)])?;
                    }
                    let replaces = overwrite || from.is_some();
                    if let Some(from) = from {
                        if from != path {
                            self.make_room(&path, &rec, local, report)?;
                            self.ports.fs.rename(&from, &path)?;
                            report.renamed += 1;
                        }
                    } else if !overwrite {
                        self.make_room(&path, &rec, local, report)?;
                    }
                    // The merged text is the local file already: nothing to write (Г16).
                    let already_there = clash.as_ref().is_some_and(|c| c.other == bytes);
                    let written = if already_there {
                        Ok(())
                    } else {
                        self.write_file(&path, &bytes, replaces)
                    };
                    match written {
                        Ok(()) => {}
                        Err(FsError::NoSpace) => {
                            report.errors.push(ItemError {
                                item_id: remote.entry.item_id,
                                kind: ItemErrorKind::Disk(FsError::NoSpace),
                            });
                            let seq = remote.entry.seq;
                            *hold = Some(hold.map_or(seq - 1, |h| h.min(seq - 1)));
                            continue;
                        }
                        Err(e) => return Err(e.into()),
                    }
                    report.downloaded += 1;
                    // The server's version is the base now, whatever was written (Г8 а, Г16).
                    self.keep_base(&rec.item_id, &path, &server_bytes)?;
                    self.tx(vec![StateOp::PutItem(rec)])?;
                }
            }
        }
        Ok(())
    }

    /// The local version of `clash` meets `remote` at `path`: a clean merge is returned as the
    /// content to write (К1, Г12–Г16); otherwise the local version goes to a set (К2, Г20–Г23)
    /// and `None` is returned, so that the server's version is written. The second part of the
    /// answer says whether it was a real merge (a flaw may write something else).
    fn settle_clash(
        &mut self,
        clash: &Clash,
        remote: &[u8],
        path: &str,
        report: &mut CycleReport,
    ) -> Res<Option<(Vec<u8>, bool)>> {
        let eligible = mergeable_md(path, clash.other.len()) && mergeable_md(path, remote.len());
        if eligible && self.flaw != Flaw::NeverMerges {
            match (&clash.base, clash.kind) {
                (Some(base), ConflictKind::BothEdited) => {
                    if let linemerge::Outcome::Clean(merged) =
                        linemerge::merge(base, &clash.other, remote)
                    {
                        let merged = if self.flaw == Flaw::MergeDropsLine {
                            drop_a_line(&merged, &clash.other, remote)
                        } else {
                            merged
                        };
                        return Ok(Some((merged, true)));
                    }
                }
                _ if self.flaw == Flaw::MergeWithoutBase => {
                    // Without a base the two are "merged" by taking the lines of both.
                    return Ok(Some((union_of_lines(remote, &clash.other), true)));
                }
                _ => {}
            }
        }
        if self.flaw == Flaw::ConflictCopyInTree {
            // The second version beside the file, as before stage Э4б (the flaw).
            let id = conflict_id(&clash.item, &blake3_hash(&clash.other), 0, 0);
            let beside = copy_path(path, &id);
            if self.ports.fs.read(&beside).ok().as_deref() != Some(&clash.other[..]) {
                self.write_file(&beside, &clash.other, false)?;
            }
            let record = ConflictRecord {
                id,
                kind: clash.kind,
                original_path: path.to_string(),
                copy_path: beside,
                created_ms: self.ports.clock.now_ms(),
            };
            report.conflicts.push(record.clone());
            self.tx(vec![StateOp::AddConflict(record)])?;
            return Ok(None);
        }
        if self.flaw == Flaw::MergeWritesMarks
            && clash.other.ends_with(b"\n")
            && remote.ends_with(b"\n")
        {
            let mut marked = b"<<<<<<< local\n".to_vec();
            marked.extend_from_slice(&clash.other);
            marked.extend_from_slice(b"=======\n");
            marked.extend_from_slice(remote);
            marked.extend_from_slice(b">>>>>>> remote\n");
            return Ok(Some((marked, false)));
        }
        self.write_set(clash, report)?;
        Ok(None)
    }

    /// Writes the files of a set, the second version first and `meta.json` last (Г23), and
    /// lists the conflict (Г25). Files that are there already are not written again.
    fn write_set(&mut self, clash: &Clash, report: &mut CycleReport) -> Res<()> {
        let kind = match clash.kind {
            ConflictKind::BothEdited => "bothEdited",
            ConflictKind::BothCreated => "bothCreated",
        };
        let files = sets::set_files(
            &clash.id,
            kind,
            clash.item.as_bytes(),
            &clash.original,
            &clash.other,
            clash.base.as_deref(),
        );
        let other_path = files[0].0.clone();
        for (file_path, bytes) in files.into_iter().filter(|_| !clash.from_server) {
            match self.ports.fs.read(&file_path) {
                Ok(existing) if existing == bytes => {}
                Ok(_) => self.write_file(&file_path, &bytes, true)?,
                Err(FsError::NotFound(_)) => self.write_file(&file_path, &bytes, false)?,
                Err(error) => return Err(error.into()),
            }
        }
        let record = ConflictRecord {
            id: clash.id.clone(),
            kind: clash.kind,
            original_path: clash.original.clone(),
            copy_path: other_path,
            created_ms: self.ports.clock.now_ms(),
        };
        if !report.conflicts.iter().any(|c| c.id == record.id) {
            report.conflicts.push(record.clone());
        }
        self.tx(vec![StateOp::AddConflict(record)])
    }

    /// Moves a file that stands where something else must be written to a conflict copy name
    /// (Д51).
    fn make_room(
        &mut self,
        target: &str,
        rec: &ItemRecord,
        local: &BTreeMap<String, LocalFile>,
        report: &mut CycleReport,
    ) -> Res<()> {
        let Some(occupant) = local.get(target) else {
            return Ok(());
        };
        if self.flaw != Flaw::ConflictCopyInTree && !target.starts_with(".amby/conflicts/") {
            // The file in the way moves into a set (Г20); the set's other files are written
            // around it.
            let mut attempt = 0;
            let (id, other_path) = loop {
                let id = sets::set_id(
                    rec.item_id.as_bytes(),
                    &occupant.hash,
                    rec.version,
                    None,
                    attempt,
                );
                let other_path = sets::paths(&id, target).1;
                if local.contains_key(&other_path) {
                    attempt += 1;
                    continue;
                }
                break (id, other_path);
            };
            match self.ports.fs.rename(target, &other_path) {
                Ok(()) => {}
                Err(FsError::NotFound(_)) => return Ok(()),
                Err(e) => return Err(e.into()),
            }
            let files = sets::set_files(
                &id,
                "bothCreated",
                rec.item_id.as_bytes(),
                target,
                &occupant.bytes,
                None,
            );
            for (file_path, bytes) in files.into_iter().filter(|(p, _)| p.ends_with("meta.json")) {
                match self.ports.fs.read(&file_path) {
                    Ok(existing) if existing == bytes => {}
                    Ok(_) => self.write_file(&file_path, &bytes, true)?,
                    Err(FsError::NotFound(_)) => self.write_file(&file_path, &bytes, false)?,
                    Err(error) => return Err(error.into()),
                }
            }
            let record = ConflictRecord {
                id,
                kind: ConflictKind::BothCreated,
                original_path: target.to_string(),
                copy_path: other_path,
                created_ms: self.ports.clock.now_ms(),
            };
            report.conflicts.push(record.clone());
            return self.tx(vec![StateOp::AddConflict(record)]);
        }
        let mut attempt = 0;
        let path = loop {
            let id = conflict_id(&rec.item_id, &occupant.hash, rec.version, attempt);
            let candidate = copy_path(target, &id);
            if local.contains_key(&candidate) {
                attempt += 1;
                continue;
            }
            break candidate;
        };
        match self.ports.fs.rename(target, &path) {
            Ok(()) => {}
            Err(FsError::NotFound(_)) => return Ok(()),
            Err(e) => return Err(e.into()),
        }
        let record = ConflictRecord {
            id: String::new(),
            kind: ConflictKind::BothCreated,
            original_path: target.to_string(),
            copy_path: path,
            created_ms: self.ports.clock.now_ms(),
        };
        report.conflicts.push(record);
        Ok(())
    }

    /// Everything that differs from the (now current) bases goes to the server.
    fn push(
        &mut self,
        undelete: &BTreeMap<String, (ItemId, u64)>,
        report: &mut CycleReport,
    ) -> Res<()> {
        let state = self.st()?;
        let local = self.scan()?;
        let classes = self.classify(&state, &local);
        let mut items: Vec<CommitItem> = Vec::new();
        let mut after: Vec<ItemRecord> = Vec::new();
        let record_paths: BTreeSet<String> = state
            .items
            .values()
            .filter(|r| !r.deleted)
            .map(|r| r.path.clone())
            .collect();
        let mut moved_to: BTreeSet<String> = BTreeSet::new();
        let mut uploads = 0;

        for rec in state.items.values().filter(|r| !r.deleted) {
            let Some(class) = classes.get(rec.item_id.as_bytes()) else {
                continue;
            };
            match class {
                Local::Same => {}
                Local::Edited => {
                    let file = &local[&rec.path];
                    // The base of the new version, before the commit that makes it one (Г8 б, Г9).
                    self.keep_base(&rec.item_id, &rec.path, &file.bytes)?;
                    let body = self.upload(&file.bytes)?;
                    uploads += 1;
                    let header = Self::new_header(
                        rec.version + 1,
                        &rec.path,
                        Some(&file.bytes),
                        Some(body),
                        false,
                        &rec.extra,
                    );
                    let sealed = self.sealed_header(&rec.item_id, &header)?;
                    items.push(CommitItem {
                        item_id: rec.item_id,
                        base_version: rec.version,
                        header: sealed,
                        blob_id: Some(body),
                        deleted: false,
                    });
                    after.push(Self::record_from(rec.item_id, &header, rec.version + 1));
                }
                Local::Moved(to) => {
                    moved_to.insert(to.clone());
                    let file = &local[to];
                    let mut header = Self::new_header(
                        rec.version + 1,
                        to,
                        Some(&file.bytes),
                        rec.body_id,
                        false,
                        &rec.extra,
                    );
                    header.content_hash = rec.content_hash;
                    header.size = rec.size;
                    let sealed = self.sealed_header(&rec.item_id, &header)?;
                    items.push(CommitItem {
                        item_id: rec.item_id,
                        base_version: rec.version,
                        header: sealed,
                        blob_id: rec.body_id,
                        deleted: false,
                    });
                    after.push(Self::record_from(rec.item_id, &header, rec.version + 1));
                }
                Local::Deleted => {
                    let header =
                        Self::new_header(rec.version + 1, &rec.path, None, None, true, &rec.extra);
                    let sealed = self.sealed_header(&rec.item_id, &header)?;
                    items.push(CommitItem {
                        item_id: rec.item_id,
                        base_version: rec.version,
                        header: sealed,
                        blob_id: None,
                        deleted: true,
                    });
                    after.push(Self::record_from(rec.item_id, &header, rec.version + 1));
                }
            }
        }
        for (path, file) in &local {
            if record_paths.contains(path) || moved_to.contains(path) {
                continue;
            }
            let (item, base) = undelete
                .get(path)
                .copied()
                .unwrap_or_else(|| (ItemId::random(&mut *self.ports.rng), 0));
            self.keep_base(&item, path, &file.bytes)?;
            let body = self.upload(&file.bytes)?;
            uploads += 1;
            let header = Self::new_header(
                base + 1,
                path,
                Some(&file.bytes),
                Some(body),
                false,
                &BTreeMap::new(),
            );
            let sealed = self.sealed_header(&item, &header)?;
            items.push(CommitItem {
                item_id: item,
                base_version: base,
                header: sealed,
                blob_id: Some(body),
                deleted: false,
            });
            after.push(Self::record_from(item, &header, base + 1));
        }
        report.uploaded += uploads;

        let limit = 10_000;
        let pairs: Vec<(CommitItem, ItemRecord)> = items.into_iter().zip(after).collect();
        for chunk in pairs.chunks(limit) {
            let mut commit_id = [0u8; 16];
            self.ports.rng.fill(&mut commit_id);
            let items: Vec<CommitItem> = chunk.iter().map(|(i, _)| i.clone()).collect();
            let after: Vec<ItemRecord> = chunk.iter().map(|(_, r)| r.clone()).collect();
            self.tx(vec![StateOp::SetCommit(Some(PendingCommit {
                commit_id,
                items: items.clone(),
                after: after.clone(),
            }))])?;
            match self.ports.remote.commit(&commit_id, &items)? {
                CommitReply::Accepted(_) => {
                    let mut ops: Vec<StateOp> = after.into_iter().map(StateOp::PutItem).collect();
                    ops.push(StateOp::SetCommit(None));
                    self.tx(ops)?;
                }
                CommitReply::Conflict(_) => {
                    self.tx(vec![StateOp::SetCommit(None)])?;
                    return Err(Flow::Retry);
                }
            }
        }
        Ok(())
    }
}

impl SyncEngine for MiniEngine {
    fn sync_cycle(&mut self, request: &CycleRequest) -> Result<CycleReport, EngineError> {
        let _lock = self.ports.state.lock().map_err(|e| match e {
            StateError::Locked => EngineError::Locked,
            other => EngineError::State(other),
        })?;
        self.ports.fs.cleanup_staged().map_err(EngineError::Fs)?;
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
            limits: amby_sync_core::engine::PassLimits::unknown(),
        };
        for _ in 0..5 {
            match self.attempt(request, &mut report) {
                Ok(()) => return Ok(report),
                Err(Flow::Retry) => continue,
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

    fn resolve_conflict(&mut self, id: &str) -> Result<(), EngineError> {
        self.ports
            .state
            .apply(&vec![StateOp::RemoveConflict(id.to_string())])
            .map_err(EngineError::State)
    }
}
