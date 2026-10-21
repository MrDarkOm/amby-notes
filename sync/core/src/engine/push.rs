//! Outgoing changes (Д18): bodies first, then commits. The pass looks at the disk again after the
//! incoming changes were applied, so that what it sends is what is on disk now.

use std::collections::{BTreeMap, BTreeSet};

use amby_sync_proto::PART_SIZE;

use crate::crypto::body::seal_body;
use crate::crypto::header::{canonical_header_json, seal_header, Header, ItemKind};
use crate::crypto::keys::{BodyId, ItemId};
use crate::crypto::padme::sealed_body_len;

use super::classify::{classify, Lc};
use super::flow::{Flow, Res};
use super::model::{
    CycleReport, ItemRecord, PendingCommit, PendingUpload, RenameHint, StateOp, SyncState,
    UnsyncedReason, UnsyncedRecord,
};
use super::plan::Undelete;
use super::ports::{CommitItem, CommitReply, FsError, ServerInfo};
use super::scan::{scan, Scan};
use super::sync::Engine;
use super::util::{hash_of, is_unmaterialised, FixedRandom};

/// One change on its way to the server.
struct Out {
    item: ItemId,
    base_version: u64,
    header: Header,
    blob: Option<BodyId>,
    after: ItemRecord,
}

impl Engine {
    /// Sends what differs from the bases. Returns the disk as it was seen, for the list of files
    /// that are not synchronised.
    pub(super) fn push(
        &mut self,
        info: &ServerInfo,
        undelete: &BTreeMap<String, Undelete>,
        hints: &[RenameHint],
        report: &mut CycleReport,
    ) -> Res<Option<Scan>> {
        if self.ports.fs.recovery_pending()? {
            // Д59: a multi-file operation is unfinished; nothing leaves this device.
            report.outgoing_paused = true;
            return Ok(None);
        }
        let mut state = self.ports.state.load()?;
        let disk = scan(
            &mut *self.ports.fs,
            &state.items,
            self.config.max_file_bytes,
            info.max_blob_bytes,
        )?;
        let classes = classify(&state.items, &disk, hints);

        // Files that were written by us or only touched: remember size and time, so that the next
        // pass does not read them again (Д12).
        let mut refresh = Vec::new();
        for record in state.items.values() {
            if record.deleted || record.kind != ItemKind::File || is_unmaterialised(record) {
                continue;
            }
            if classes.get(record.item_id.as_bytes()) == Some(&Lc::Same) {
                if let Some(file) = disk.files.get(&record.path) {
                    if file.size != record.size || file.mtime_ns != record.mtime_ns {
                        let mut updated = record.clone();
                        updated.size = file.size;
                        updated.mtime_ns = file.mtime_ns;
                        refresh.push(StateOp::PutItem(updated));
                    }
                }
            }
        }
        if !refresh.is_empty() {
            self.ports.state.apply(&refresh)?;
            state = self.ports.state.load()?;
        }

        let mut outs: Vec<Out> = Vec::new();
        let mut skipped: Vec<UnsyncedRecord> = Vec::new();
        let mut uploads = state.uploads.clone();
        let mut moved_to: BTreeSet<String> = BTreeSet::new();

        let records: Vec<ItemRecord> = state.items.values().cloned().collect();
        for record in &records {
            if record.deleted || record.newer_format || is_unmaterialised(record) {
                continue;
            }
            let Some(class) = classes.get(record.item_id.as_bytes()) else {
                continue;
            };
            match (record.kind, class) {
                (_, Lc::Same | Lc::Blocked) => {}
                (ItemKind::File, Lc::Edited) => {
                    let Some(file) = disk.files.get(&record.path) else {
                        continue;
                    };
                    let (disk_path, mtime) = (file.disk.clone(), file.mtime_ns);
                    let path = record.path.clone();
                    if let Some(out) = self.file_out(
                        record,
                        &path,
                        &disk_path,
                        mtime,
                        true,
                        &mut uploads,
                        &mut skipped,
                        report,
                        None,
                    )? {
                        outs.push(out);
                    }
                }
                (ItemKind::File, Lc::Moved { to, edited }) => {
                    moved_to.insert(to.clone());
                    let Some(file) = disk.files.get(to) else {
                        continue;
                    };
                    let (disk_path, mtime) = (file.disk.clone(), file.mtime_ns);
                    if let Some(out) = self.file_out(
                        record,
                        to,
                        &disk_path,
                        mtime,
                        *edited,
                        &mut uploads,
                        &mut skipped,
                        report,
                        None,
                    )? {
                        outs.push(out);
                    }
                }
                (ItemKind::File, Lc::Deleted) => {
                    let header = Header {
                        format: 1,
                        version: record.version + 1,
                        kind: ItemKind::File,
                        path: record.path.clone(),
                        size: 0,
                        mtime_ms: 0,
                        content_hash: None,
                        body_id: None,
                        deleted: true,
                        extra: record.extra.clone(),
                    };
                    let mut after = record.clone();
                    after.version += 1;
                    after.deleted = true;
                    after.content_hash = None;
                    after.size = 0;
                    after.body_id = None;
                    after.mtime_ns = 0;
                    outs.push(Out {
                        item: record.item_id,
                        base_version: record.version,
                        header,
                        blob: None,
                        after,
                    });
                }
                (ItemKind::Folder, Lc::Deleted) => {
                    let header =
                        folder_header(record, record.path.clone(), record.version + 1, true);
                    let mut after = record.clone();
                    after.version += 1;
                    after.deleted = true;
                    outs.push(Out {
                        item: record.item_id,
                        base_version: record.version,
                        header,
                        blob: None,
                        after,
                    });
                }
                (ItemKind::Folder, Lc::Moved { to, .. }) => {
                    moved_to.insert(to.clone());
                    let header = folder_header(record, to.clone(), record.version + 1, false);
                    let mut after = record.clone();
                    after.version += 1;
                    after.path = to.clone();
                    outs.push(Out {
                        item: record.item_id,
                        base_version: record.version,
                        header,
                        blob: None,
                        after,
                    });
                }
                _ => {}
            }
        }

        // New files and new empty folders (Д45).
        let file_record_paths: BTreeSet<&str> = records
            .iter()
            .filter(|r| !r.deleted && r.kind == ItemKind::File && !is_unmaterialised(r))
            .map(|r| r.path.as_str())
            .collect();
        let folder_record_paths: BTreeSet<&str> = records
            .iter()
            .filter(|r| !r.deleted && r.kind == ItemKind::Folder && !is_unmaterialised(r))
            .map(|r| r.path.as_str())
            .collect();
        let mut taken_items: BTreeSet<[u8; 16]> = BTreeSet::new();
        for (path, file) in &disk.files {
            if file_record_paths.contains(path.as_str()) || moved_to.contains(path) {
                continue;
            }
            let (disk_path, mtime) = (file.disk.clone(), file.mtime_ns);
            let bytes = match self.ports.fs.read(&disk_path) {
                Ok(bytes) => bytes,
                Err(FsError::NotFound(_)) => continue,
                Err(error) => return Err(error.into()),
            };
            let hash = hash_of(&bytes);
            let (item, base_version, extra) = match undelete.get(path) {
                Some(u) => (u.item, u.version, u.extra.clone()),
                None => {
                    // An interrupted upload of this very content keeps its item (С1, Д6).
                    let resumed = uploads
                        .values()
                        .find(|u| {
                            u.content_hash == hash
                                && u.size == bytes.len() as u64
                                && !state.items.contains_key(u.item_id.as_bytes())
                                && !taken_items.contains(u.item_id.as_bytes())
                        })
                        .map(|u| u.item_id);
                    let item = match resumed {
                        Some(item) => item,
                        None => ItemId::random(&mut *self.ports.rng),
                    };
                    (item, 0, BTreeMap::new())
                }
            };
            taken_items.insert(*item.as_bytes());
            let stand_in = ItemRecord {
                item_id: item,
                kind: ItemKind::File,
                path: path.clone(),
                content_hash: None,
                size: 0,
                mtime_ns: 0,
                version: base_version,
                body_id: None,
                deleted: false,
                newer_format: false,
                extra,
            };
            if let Some(out) = self.file_out(
                &stand_in,
                path,
                &disk_path,
                mtime,
                true,
                &mut uploads,
                &mut skipped,
                report,
                Some(bytes),
            )? {
                outs.push(out);
            }
        }
        for (path, dir) in &disk.dirs {
            if !dir.empty || folder_record_paths.contains(path.as_str()) || moved_to.contains(path)
            {
                continue;
            }
            let item = ItemId::random(&mut *self.ports.rng);
            let stand_in = ItemRecord {
                item_id: item,
                kind: ItemKind::Folder,
                path: path.clone(),
                content_hash: None,
                size: 0,
                mtime_ns: 0,
                version: 0,
                body_id: None,
                deleted: false,
                newer_format: false,
                extra: BTreeMap::new(),
            };
            let header = folder_header(&stand_in, path.clone(), 1, false);
            if canonical_header_json(&header).is_err() {
                skipped.push(UnsyncedRecord {
                    path: path.clone(),
                    reason: UnsyncedReason::ExcludedPath,
                });
                continue;
            }
            let mut after = stand_in.clone();
            after.version = 1;
            outs.push(Out {
                item,
                base_version: 0,
                header,
                blob: None,
                after,
            });
        }

        // Uploads that no change of this pass refers to are forgotten: the file changed again or
        // is gone (the server removes the orphaned body itself, П25).
        let used: BTreeSet<[u8; 16]> = outs
            .iter()
            .filter_map(|out| out.blob)
            .map(|blob| *blob.as_bytes())
            .collect();
        let stale: Vec<StateOp> = uploads
            .keys()
            .filter(|key| !used.contains(*key))
            .map(|key| StateOp::RemoveUpload(BodyId::from_bytes(*key)))
            .collect();
        if !stale.is_empty() {
            self.ports.state.apply(&stale)?;
        }

        // Folders first, then by path: a folder rename that needs several commits sends the
        // folder record first (Д50).
        outs.sort_by(|a, b| {
            let rank = |o: &Out| u8::from(o.header.kind == ItemKind::File);
            rank(a)
                .cmp(&rank(b))
                .then_with(|| a.header.path.cmp(&b.header.path))
        });
        let limit = (info.max_commit_items as usize).max(1);
        for chunk in outs.chunks(limit) {
            self.commit_chunk(chunk)?;
        }

        let mut result = disk;
        result.unsynced.extend(skipped);
        Ok(Some(result))
    }

    /// Builds the outgoing change of one file: uploads a body when the content is new.
    #[allow(clippy::too_many_arguments)]
    fn file_out(
        &mut self,
        record: &ItemRecord,
        path: &str,
        disk_path: &str,
        mtime_ns: i64,
        with_body: bool,
        uploads: &mut BTreeMap<[u8; 16], PendingUpload>,
        skipped: &mut Vec<UnsyncedRecord>,
        report: &mut CycleReport,
        prefetched: Option<Vec<u8>>,
    ) -> Res<Option<Out>> {
        let version = record.version + 1;
        let mut header = Header {
            format: 1,
            version,
            kind: ItemKind::File,
            path: path.to_string(),
            size: record.size,
            mtime_ms: mtime_ns / 1_000_000,
            content_hash: record.content_hash,
            body_id: record.body_id,
            deleted: false,
            extra: record.extra.clone(),
        };
        // A path the format cannot carry is not sent (Ф33).
        if canonical_header_json(&header).is_err() {
            skipped.push(UnsyncedRecord {
                path: path.to_string(),
                reason: UnsyncedReason::ExcludedPath,
            });
            return Ok(None);
        }
        let mut blob = record.body_id;
        if with_body {
            let bytes = match prefetched {
                Some(bytes) => bytes,
                None => match self.ports.fs.read(disk_path) {
                    Ok(bytes) => bytes,
                    // Gone since the listing: the next pass decides.
                    Err(FsError::NotFound(_)) => return Ok(None),
                    Err(error) => return Err(error.into()),
                },
            };
            // Header and body are made of the same bytes (Д12).
            let hash = hash_of(&bytes);
            let size = bytes.len() as u64;
            if size > self.config.max_file_bytes {
                skipped.push(UnsyncedRecord {
                    path: path.to_string(),
                    reason: UnsyncedReason::TooBigForMemory,
                });
                return Ok(None);
            }
            let body = self.upload(&record.item_id, &bytes, hash, uploads)?;
            report.uploaded += 1;
            header.size = size;
            header.content_hash = Some(hash);
            header.body_id = Some(body);
            blob = Some(body);
        }
        let mut after = record.clone();
        after.path = path.to_string();
        after.version = version;
        after.size = header.size;
        after.content_hash = header.content_hash;
        after.body_id = header.body_id;
        after.deleted = false;
        after.mtime_ns = mtime_ns;
        Ok(Some(Out {
            item: record.item_id,
            base_version: record.version,
            header,
            blob,
            after,
        }))
    }

    /// Uploads a body and returns its id; picks up an interrupted upload of the same content
    /// (С1, Д6).
    fn upload(
        &mut self,
        item: &ItemId,
        bytes: &[u8],
        hash: [u8; 32],
        uploads: &mut BTreeMap<[u8; 16], PendingUpload>,
    ) -> Res<BodyId> {
        let size = bytes.len() as u64;
        let existing = uploads
            .values()
            .find(|u| u.item_id == *item && u.content_hash == hash && u.size == size)
            .cloned();
        let (blob_id, prefix) = match existing {
            Some(upload) => (upload.blob_id, upload.nonce_prefix),
            None => {
                let mut ops: Vec<StateOp> = Vec::new();
                for old in uploads.values().filter(|u| u.item_id == *item) {
                    ops.push(StateOp::RemoveUpload(old.blob_id));
                }
                uploads.retain(|_, u| u.item_id != *item);
                let blob_id = BodyId::random(&mut *self.ports.rng);
                let mut prefix = [0u8; 19];
                self.ports.rng.fill(&mut prefix);
                let upload = PendingUpload {
                    blob_id,
                    item_id: *item,
                    content_hash: hash,
                    size,
                    nonce_prefix: prefix,
                };
                ops.push(StateOp::PutUpload(upload.clone()));
                self.ports.state.apply(&ops)?;
                uploads.insert(*blob_id.as_bytes(), upload);
                (blob_id, prefix)
            }
        };
        let sealed = seal_body(
            &self.config.vk,
            &blob_id,
            bytes,
            &mut FixedRandom::new(&prefix),
        )?;
        debug_assert_eq!(Some(sealed.len() as u64), sealed_body_len(size).ok());
        let state = self
            .ports
            .remote
            .blob_start(&blob_id, sealed.len() as u64)?;
        if !state.complete {
            for (index, part) in sealed.chunks(PART_SIZE as usize).enumerate() {
                if !state.uploaded.contains(&(index as u64)) {
                    self.ports
                        .remote
                        .blob_put_part(&blob_id, index as u64, part)?;
                }
            }
            self.ports.remote.blob_complete(&blob_id)?;
        }
        Ok(blob_id)
    }

    /// One commit, written to the state before it is sent (С2, Д7).
    fn commit_chunk(&mut self, chunk: &[Out]) -> Res<()> {
        let mut items = Vec::with_capacity(chunk.len());
        let mut after = Vec::with_capacity(chunk.len());
        for out in chunk {
            let header = seal_header(
                &self.config.vk,
                &self.config.space_id,
                &out.item,
                &out.header,
                &mut *self.ports.rng,
            )?;
            items.push(CommitItem {
                item_id: out.item,
                base_version: out.base_version,
                header,
                blob_id: out.blob,
                deleted: out.header.deleted,
            });
            after.push(out.after.clone());
        }
        let mut commit_id = [0u8; 16];
        self.ports.rng.fill(&mut commit_id);
        self.ports
            .state
            .apply(&vec![StateOp::SetCommit(Some(PendingCommit {
                commit_id,
                items: items.clone(),
                after: after.clone(),
            }))])?;
        match self.ports.remote.commit(&commit_id, &items)? {
            CommitReply::Accepted(_) => self.commit_accepted(&after, &items),
            CommitReply::Conflict(_) => {
                // Nothing was applied (П27): decide again with the new server state (Д7, Д10).
                self.ports.state.apply(&vec![StateOp::SetCommit(None)])?;
                Err(Flow::Retry)
            }
        }
    }

    /// The commit is on the server: its bases become true and its uploads are done (Д6, Д7).
    pub(super) fn commit_accepted(
        &mut self,
        after: &[ItemRecord],
        items: &[CommitItem],
    ) -> Res<()> {
        let state: SyncState = self.ports.state.load()?;
        let mut ops: Vec<StateOp> = after.iter().cloned().map(StateOp::PutItem).collect();
        ops.push(StateOp::SetCommit(None));
        for item in items {
            for upload in state.uploads.values().filter(|u| u.item_id == item.item_id) {
                ops.push(StateOp::RemoveUpload(upload.blob_id));
            }
        }
        self.ports.state.apply(&ops)?;
        Ok(())
    }
}

fn folder_header(record: &ItemRecord, path: String, version: u64, deleted: bool) -> Header {
    Header {
        format: 1,
        version,
        kind: ItemKind::Folder,
        path,
        size: 0,
        mtime_ms: 0,
        content_hash: None,
        body_id: None,
        deleted,
        extra: record.extra.clone(),
    }
}
