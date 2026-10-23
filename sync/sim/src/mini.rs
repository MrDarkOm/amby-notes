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
}

pub const ALL_FLAWS: [Flaw; 7] = [
    Flaw::LastWriterWins,
    Flaw::DeleteBeatsEdit,
    Flaw::EmptyServerDeletesAll,
    Flaw::NoRollbackCheck,
    Flaw::NoMassGuard,
    Flaw::NoSnapshot,
    Flaw::EmptyVaultSendsDeletes,
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
        copy: Option<(String, Vec<u8>, ConflictKind)>,
        rec: ItemRecord,
    },
    /// After the user's `resync` (Д56): the local version stays at the path and goes up as a new
    /// version; the server's differing version is kept as a conflict copy.
    KeepLocal {
        remote: Remote,
        copy_path: String,
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
        || path.starts_with(".amby/")
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
        let state = self.ports.remote.blob_start(&body, sealed.len() as u64)?;
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
                        taken: &mut BTreeSet<String>|
         -> Option<(String, Vec<u8>, ConflictKind)> {
            if lww {
                return None;
            }
            let mut attempt = 0;
            loop {
                let id = conflict_id(item, &file.hash, remote_version, attempt);
                let path = copy_path(original, &id);
                let remote_path_taken = remotes
                    .values()
                    .any(|r| !r.header.deleted && r.header.path == path);
                if !taken.contains(&path) && !local.contains_key(&path) && !remote_path_taken {
                    taken.insert(path.clone());
                    return Some((path, file.bytes.clone(), kind));
                }
                if let Some(existing) = local.get(&path) {
                    if existing.hash == file.hash {
                        return None; // the copy is already there
                    }
                }
                // The same copy made on another device arrives from the server (Д46).
                if remotes.values().any(|r| {
                    !r.header.deleted
                        && r.header.path == path
                        && r.header.content_hash == Some(file.hash)
                }) {
                    return None;
                }
                attempt += 1;
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
                        let copy_path = loop {
                            let id = conflict_id(&item, &remote_hash, version, attempt);
                            let candidate = copy_path(&header.path, &id);
                            if !copies_taken.contains(&candidate) && !local.contains_key(&candidate)
                            {
                                break candidate;
                            }
                            attempt += 1;
                        };
                        copies_taken.insert(copy_path.clone());
                        plans.push(Plan::KeepLocal {
                            remote: remote.clone(),
                            copy_path,
                            rec: server_rec,
                        });
                    }
                    Some(file) => {
                        let copy = conflict(
                            &item,
                            &header.path,
                            file,
                            version,
                            ConflictKind::BothCreated,
                            &mut copies_taken,
                        );
                        plans.push(Plan::Write {
                            remote: remote.clone(),
                            path: header.path.clone(),
                            from: None,
                            overwrite: true,
                            copy,
                            rec: server_rec,
                        });
                    }
                    None => plans.push(Plan::Write {
                        remote: remote.clone(),
                        path: header.path.clone(),
                        from: None,
                        overwrite: false,
                        copy: None,
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
            let write_to = |path: &str, from: Option<String>, overwrite: bool, copy| Plan::Write {
                remote: remote.clone(),
                path: path.to_string(),
                from,
                overwrite,
                copy,
                rec: server_rec.clone(),
            };
            match (class, header.deleted, renamed, changed) {
                (Local::Same, true, _, _) => plans.push(Plan::Trash {
                    path: rec.path.clone(),
                    rec: server_rec,
                }),
                (Local::Same, false, false, false) => plans.push(Plan::Link(server_rec)),
                (Local::Same, false, false, true) => {
                    plans.push(write_to(&rec.path, None, true, None))
                }
                (Local::Same, false, true, false) => plans.push(Plan::Rename {
                    from: rec.path.clone(),
                    to: header.path.clone(),
                    rec: server_rec,
                }),
                (Local::Same, false, true, true) => {
                    plans.push(write_to(&header.path, Some(rec.path.clone()), true, None))
                }
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
                        let copy = conflict(
                            &item,
                            &rec.path,
                            file,
                            version,
                            ConflictKind::BothEdited,
                            &mut copies_taken,
                        );
                        plans.push(write_to(&rec.path, None, true, copy));
                    }
                }
                (Local::Edited, false, true, false) => plans.push(Plan::Rename {
                    from: rec.path.clone(),
                    to: header.path.clone(),
                    rec: server_rec,
                }),
                (Local::Edited, false, true, true) => {
                    let file = &local[&rec.path];
                    let copy = conflict(
                        &item,
                        &header.path,
                        file,
                        version,
                        ConflictKind::BothEdited,
                        &mut copies_taken,
                    );
                    plans.push(write_to(&header.path, Some(rec.path.clone()), true, copy));
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
                (Local::Moved(p), false, false, true) => plans.push(write_to(&p, None, true, None)),
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
                    plans.push(write_to(&header.path, Some(p), true, None))
                }
                (Local::Deleted, true, _, _) => plans.push(Plan::Tombstone(server_rec)),
                (Local::Deleted, false, false, false) => plans.push(Plan::Link(server_rec)),
                (Local::Deleted, false, _, _) => {
                    plans.push(write_to(&header.path, None, false, None))
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
                Plan::Link(rec) | Plan::Tombstone(rec) => self.tx(vec![StateOp::PutItem(rec)])?,
                Plan::Rename { from, to, rec } => {
                    self.make_room(&to, &rec, local, report)?;
                    self.ports.fs.rename(&from, &to)?;
                    report.renamed += 1;
                    self.tx(vec![StateOp::PutItem(rec)])?;
                }
                Plan::KeepLocal {
                    remote,
                    copy_path,
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
                    self.write_file(&copy_path, &bytes, false)?;
                    let id = copy_path
                        .rsplit('/')
                        .next()
                        .and_then(|n| n.split('.').rev().nth(1).map(str::to_string))
                        .unwrap_or_default()
                        .trim_end_matches("-conflict")
                        .to_string();
                    let record = ConflictRecord {
                        id,
                        kind: ConflictKind::BothCreated,
                        original_path: rec.path.clone(),
                        copy_path,
                        created_ms: self.ports.clock.now_ms(),
                    };
                    report.conflicts.push(record.clone());
                    self.tx(vec![StateOp::AddConflict(record), StateOp::PutItem(rec)])?;
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
                    match self.write_file(&path, &bytes, replaces) {
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
                    self.tx(vec![StateOp::PutItem(rec)])?;
                }
            }
        }
        Ok(())
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
            conflicts: Vec::new(),
            unsynced: Vec::new(),
            read_only: Vec::new(),
            needs_update: false,
            errors: Vec::new(),
            outgoing_paused: false,
            full_reconcile: false,
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
