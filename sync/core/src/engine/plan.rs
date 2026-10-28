//! What a pass decided (private): the server version of an item as the engine sees it, and the
//! actions of Д17 that the decisions of Д16 turn into.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::crypto::header::{Header, ItemKind};
use crate::crypto::keys::{BodyId, ItemId};

use super::model::{ConflictKind, ItemError, ItemRecord, PlannedChange, StateOp, UnsyncedRecord};
use super::ports::ChangeEntry;

/// A version of an item on the server, from a feed entry and its opened header, or rebuilt from
/// a base that was never materialised on this disk (Д3).
#[derive(Debug, Clone)]
pub(super) struct Srv {
    pub item: ItemId,
    pub version: u64,
    /// `seq` of the feed entry; none for a retry of a remembered base.
    pub seq: Option<u64>,
    pub kind: ItemKind,
    pub path: String,
    pub hash: Option<[u8; 32]>,
    pub size: u64,
    pub body: Option<BodyId>,
    pub deleted: bool,
    pub extra: BTreeMap<String, Value>,
}

impl Srv {
    pub(super) fn from_feed(entry: &ChangeEntry, header: &Header) -> Self {
        Self {
            item: entry.item_id,
            version: entry.version,
            seq: Some(entry.seq),
            kind: header.kind,
            path: header.path.clone(),
            hash: header.content_hash,
            size: header.size,
            body: header.body_id,
            deleted: header.deleted,
            extra: header.extra.clone(),
        }
    }

    pub(super) fn from_record(record: &ItemRecord) -> Self {
        Self {
            item: record.item_id,
            version: record.version,
            seq: None,
            kind: record.kind,
            path: record.path.clone(),
            hash: record.content_hash,
            size: record.size,
            body: record.body_id,
            deleted: record.deleted,
            extra: record.extra.clone(),
        }
    }

    /// The base this version becomes, with the given `mtime_ns` (0 when the disk was not looked
    /// at after the write).
    pub(super) fn record(&self, mtime_ns: i64) -> ItemRecord {
        ItemRecord {
            item_id: self.item,
            kind: self.kind,
            path: self.path.clone(),
            content_hash: self.hash,
            size: self.size,
            mtime_ns,
            version: self.version,
            body_id: self.body,
            deleted: self.deleted,
            newer_format: false,
            extra: self.extra.clone(),
        }
    }
}

/// A local file that an action replaces; `hash` is checked again right before (Д17).
#[derive(Debug, Clone)]
pub(super) struct Existing {
    pub disk: String,
    pub hash: [u8; 32],
}

/// Where the second version of a conflict goes and how it comes to be (Д46, Д47, Г20–Г23): a set
/// in `.amby/conflicts/<id>/`, or, for a path inside that folder, a copy beside the file (Г19).
#[derive(Debug, Clone)]
pub(super) struct CopyPlan {
    pub id: String,
    /// Where the second version lies: `other<ext>` of the set, or the copy beside the file.
    pub path: String,
    /// The path of the file that keeps the name.
    pub original: String,
    pub kind: ConflictKind,
    /// A file with the same content is already at the path: nothing to create (Д46).
    pub exists: bool,
    /// The server has this very copy: it arrives by itself (Д46).
    pub from_server: bool,
    /// An old-style copy beside the file (Г19): no set files besides it.
    pub legacy: bool,
    /// The item whose content kept the name (Г21).
    pub item: ItemId,
    /// Hash and size of the second version (Г21).
    pub other_hash: [u8; 32],
    pub other_size: u64,
    /// The common base, for a conflict of two edits that had one (Г6, Г21). It is also what the
    /// merge starts from (Г12).
    pub base: Option<Vec<u8>>,
}

/// Write the server version of a file: a new file, or a replacement of an existing one with a
/// snapshot (Д53), perhaps keeping the local content as a copy first (Д29, Д31, Д43).
#[derive(Debug, Clone)]
pub(super) struct PutAct {
    pub seq: Option<u64>,
    pub srv: Srv,
    /// NFC path to write.
    pub target: String,
    pub existing: Option<Existing>,
    pub copy: Option<CopyPlan>,
    /// The base after success.
    pub rec: ItemRecord,
    /// Both sides changed the content of a note that has a base: try the merge before the copy
    /// becomes a set (К1, Г4). The base is `copy.base`.
    pub merge: bool,
}

/// Rename a file on disk (Д26, Д30, Д34): `LocalFs::rename` never overwrites.
#[derive(Debug, Clone)]
pub(super) struct MoveAct {
    pub seq: Option<u64>,
    pub from_disk: String,
    pub from: String,
    pub to: String,
    pub expect: [u8; 32],
    /// The base after the rename, when nothing follows.
    pub rec: ItemRecord,
    /// A replacement of the content that follows the rename (Д27, Д31, Д35).
    pub then: Option<PutAct>,
    /// A file without a record lies at the target: it becomes this copy (Д49, Д51).
    pub occupant: Option<(Existing, CopyPlan)>,
    /// This rename puts the file at the name of a conflict copy because another live item keeps
    /// the path (Д71): the copy is listed as a conflict once the rename is done (Д47).
    pub placed_as: Option<CopyPlan>,
}

/// After a `resync`: the local file stays, the server version becomes a copy (Д56, Д57).
#[derive(Debug, Clone)]
pub(super) struct KeepAct {
    pub seq: Option<u64>,
    pub srv: Srv,
    pub copy: CopyPlan,
    pub rec: ItemRecord,
}

/// A file whose content is the common version from now on (Г8 в): its bytes become the base
/// before the state says so (Г9).
#[derive(Debug, Clone)]
pub(super) struct LinkBase {
    pub item: ItemId,
    pub hash: [u8; 32],
    /// The path of the base record, which decides whether the file is a note (Г5).
    pub path: String,
    /// Where the file lies now.
    pub disk: String,
}

/// One action of the application of incoming changes (Д17).
#[derive(Debug, Clone)]
pub(super) enum Act {
    /// The state learns something; the disk is as it should be.
    Ops(Vec<StateOp>),
    /// Create a folder.
    Dir {
        path: String,
        rec: ItemRecord,
    },
    Move(Box<MoveAct>),
    Put(Box<PutAct>),
    Keep(Box<KeepAct>),
    /// Send a file to the trash (Д28, Д52).
    Trash {
        seq: Option<u64>,
        disk: String,
        expect: [u8; 32],
        rec: ItemRecord,
    },
}

/// An item whose deletion on the server loses to a local change: it is written as a new version
/// of the same item (Д32, Д36).
#[derive(Debug, Clone)]
pub(super) struct Undelete {
    pub item: ItemId,
    /// The version of the server's tombstone.
    pub version: u64,
    pub extra: BTreeMap<String, Value>,
}

/// Everything the decisions of one pass produced.
#[derive(Debug, Default)]
pub(super) struct Plan {
    pub acts: Vec<Act>,
    /// The cursor must stay at or below this (Д5).
    pub hold: Option<u64>,
    pub errors: Vec<ItemError>,
    /// "Not synchronised" entries for incoming items (Д64).
    pub unsynced: Vec<UnsyncedRecord>,
    /// Local path → the item to write a new version of.
    pub undelete: BTreeMap<String, Undelete>,
    /// Server paths of items that come back over a local deletion (Д37–Д39): reported once written.
    pub restored: BTreeSet<String>,
    /// Bases to forget (Д58).
    pub forget: Vec<ItemId>,
    /// Files this pass would replace or trash (Д54).
    pub incoming: Vec<PlannedChange>,
    /// Deletions this pass would send (Д54).
    pub outgoing: Vec<PlannedChange>,
    /// Folders to try to remove when they are empty (Д17, step 5).
    pub cleanup: BTreeSet<String>,
    /// Files that become the base of their record unchanged (Г8 в).
    pub link_bases: Vec<LinkBase>,
}

impl Plan {
    /// Keep the cursor before the entry with this `seq` (Д5).
    pub(super) fn hold_before(&mut self, seq: Option<u64>) {
        if let Some(seq) = seq {
            let below = seq.saturating_sub(1);
            self.hold = Some(self.hold.map_or(below, |hold| hold.min(below)));
        }
    }
}
