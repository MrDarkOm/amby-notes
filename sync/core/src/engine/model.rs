//! What the engine keeps on the device (Р10, Д3) and what a pass reports (Д20, Д60).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::crypto::error::CryptoError;
use crate::crypto::header::ItemKind;
use crate::crypto::keys::{BodyId, ItemId};

use super::names::NameProblem;
use super::ports::{CommitItem, FsError, RemoteError, StateError};

/// The **base** of one item: the last common version of the disk and the server (Д1), plus what
/// the engine must remember about it.
#[derive(Debug, Clone, PartialEq)]
pub struct ItemRecord {
    /// The item.
    pub item_id: ItemId,
    /// File or folder.
    pub kind: ItemKind,
    /// Path in NFC (Д61).
    pub path: String,
    /// BLAKE3 of the content; `None` for folders and tombstones.
    pub content_hash: Option<[u8; 32]>,
    /// Size of the content.
    pub size: u64,
    /// Modification time of the local file when it was last known equal (fast check, Д12).
    pub mtime_ns: i64,
    /// Version on the server (Р3, Р6).
    pub version: u64,
    /// Body of this version.
    pub body_id: Option<BodyId>,
    /// A tombstone: the item is deleted (Д3, Д57).
    pub deleted: bool,
    /// A header with a format this build does not understand was seen: read-only (Д66).
    pub newer_format: bool,
    /// Unknown header fields, kept for every rewrite (Р13, Д67).
    pub extra: BTreeMap<String, Value>,
}

/// A body upload that has begun (С1, Д6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUpload {
    /// The body on the server.
    pub blob_id: BodyId,
    /// The item it is for.
    pub item_id: ItemId,
    /// Hash of the content that was sealed.
    pub content_hash: [u8; 32],
    /// Size of the content.
    pub size: u64,
    /// The 19-byte nonce prefix: the same prefix and content give the same bytes again (Д6).
    pub nonce_prefix: [u8; 19],
}

/// A commit that is about to be sent or was sent and not confirmed (С2, Д7).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingCommit {
    /// The `commit_id`, reused verbatim on a repeat.
    pub commit_id: [u8; 16],
    /// The entries exactly as sent: headers are not sealed again.
    pub items: Vec<CommitItem>,
    /// The bases that become true when the commit is accepted: the version is `base_version + 1`
    /// (Р3).
    pub after: Vec<ItemRecord>,
}

/// Kind of a conflict (Р7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictKind {
    /// Both devices changed the content (Д29, Д31).
    BothEdited,
    /// Both devices created a file at one path (Д43).
    BothCreated,
}

/// An unresolved conflict, kept until the user decides (Р7, Д47).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictRecord {
    /// The id inside the copy name (Д46).
    pub id: String,
    /// What happened.
    pub kind: ConflictKind,
    /// Path of the file that kept the name (the server's version).
    pub original_path: String,
    /// Path of the copy with the other version.
    pub copy_path: String,
    /// When the copy was made, by the clock (display only).
    pub created_ms: i64,
}

/// Why a file is not synchronised here (Р4, Р9, Д64).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnsyncedReason {
    /// A symbolic link.
    Symlink,
    /// The name is not UTF-8.
    NotUtf8,
    /// The sealed body is larger than the server accepts.
    TooLarge,
    /// The file is larger than this device's memory limit for a file (Д71).
    TooBigForMemory,
    /// An incoming path the rules exclude (`.git/`, temporary files, …).
    ExcludedPath,
    /// The name cannot be created on this system (Р9).
    InvalidName(NameProblem),
    /// Differs from another file only in case on a case-insensitive system (Р9).
    CaseCollision {
        /// The path that was there first.
        with: String,
    },
    /// Two local names with the same NFC form (Д61).
    NameCollision,
    /// The target is held by another item that did not move away (Д49).
    PathBusy,
}

/// One entry of the "not synchronised" list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsyncedRecord {
    /// Path of the file (the server's spelling for incoming ones).
    pub path: String,
    /// Why.
    pub reason: UnsyncedReason,
}

/// The whole state of the device (Р10).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SyncState {
    /// `instance_id` of the server, once known (Д56).
    pub instance_id: Option<[u8; 16]>,
    /// Everything up to this `seq` is processed (Д5).
    pub cursor: u64,
    /// The largest `seq` the server ever named.
    pub head: u64,
    /// The bases by `item_id` bytes.
    pub items: BTreeMap<[u8; 16], ItemRecord>,
    /// Begun body uploads by `blob_id` bytes.
    pub uploads: BTreeMap<[u8; 16], PendingUpload>,
    /// The commit in flight, if any.
    pub commit: Option<PendingCommit>,
    /// Open conflicts.
    pub conflicts: Vec<ConflictRecord>,
    /// The "not synchronised" list of the last pass.
    pub unsynced: Vec<UnsyncedRecord>,
}

/// One change of the state; a [`StateTx`] applies several atomically (Д4).
#[derive(Debug, Clone, PartialEq)]
pub enum StateOp {
    /// Remember the instance of the server.
    SetInstance([u8; 16]),
    /// Move the cursor and the head.
    SetCursor {
        /// New cursor.
        cursor: u64,
        /// New head.
        head: u64,
    },
    /// Insert or replace a base.
    PutItem(ItemRecord),
    /// Forget a base.
    RemoveItem(ItemId),
    /// Remember a begun upload.
    PutUpload(PendingUpload),
    /// Forget an upload.
    RemoveUpload(BodyId),
    /// Set or clear the commit in flight.
    SetCommit(Option<PendingCommit>),
    /// Add an open conflict.
    AddConflict(ConflictRecord),
    /// Remove a conflict by its id (the user resolved it).
    RemoveConflict(String),
    /// Replace the "not synchronised" list.
    SetUnsynced(Vec<UnsyncedRecord>),
    /// Forget the link with the server: bases, cursor, head, uploads and the commit (Д56). The
    /// conflict list and the "not synchronised" list stay.
    ResetServerLink,
}

/// Several [`StateOp`]s applied as one atomic step.
pub type StateTx = Vec<StateOp>;

/// Which way a mass change goes (Д54).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// The server would overwrite or delete local files.
    Incoming,
    /// This device would send deletions.
    Outgoing,
}

/// What a planned change does to a file (Д54).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlannedKind {
    /// A local file is replaced by a server version.
    Overwrite,
    /// A local file goes to the trash.
    Trash,
    /// A deletion would be sent to the server.
    SendDelete,
}

/// One line of the list shown when a pass stops for a mass change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedChange {
    /// The local path.
    pub path: String,
    /// What would happen.
    pub kind: PlannedKind,
}

/// Why a pass stopped without doing anything (Д60).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    /// Too many files would be overwritten, deleted or sent as deleted (Д54).
    MassChange {
        /// The direction.
        direction: Direction,
        /// The files.
        files: Vec<PlannedChange>,
    },
    /// The vault folder is gone (Д55, С8).
    VaultMissing,
    /// The vault folder has nothing to synchronise but the state has files (Д55).
    VaultEmpty,
    /// The server has another `instance_id` (Д56, С7).
    ServerReset {
        /// The one we knew.
        old: [u8; 16],
        /// The one it has now.
        new: [u8; 16],
    },
    /// The head of the feed is below our cursor (Д56, С7).
    ServerBehind {
        /// The head the server named.
        head: u64,
        /// Our cursor.
        cursor: u64,
    },
    /// The server showed an older or different version of an item (Д57, С6).
    Rollback {
        /// The item.
        item_id: ItemId,
        /// The version we have.
        known: u64,
        /// The version the server showed.
        got: u64,
    },
    /// No valid token (Д19, С12).
    AuthRequired,
    /// The server does not speak protocol 1.
    IncompatibleServer,
}

/// The answers of the user after a stop; each lasts one pass (Д60).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Approvals {
    /// Go on despite a mass change (Д54).
    pub mass_change: bool,
    /// The vault really is empty (Д55).
    pub accept_empty_vault: bool,
    /// Forget the server link and reconcile again by hashes, deleting nothing (Д56, Д57).
    pub resync: bool,
}

/// "This move was a rename" (Д70): the application knows the renames and moves that the user made
/// through Amby, and tells the engine, so that a rename together with an edit is not read as a
/// deletion and a creation (Д13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameHint {
    /// The path before (NFC, relative).
    pub from: String,
    /// The path after.
    pub to: String,
}

/// What the application asks of one pass.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CycleRequest {
    /// The answers to earlier stops.
    pub approvals: Approvals,
    /// Renames the application made since the last pass; each is used once (Д70).
    pub rename_hints: Vec<RenameHint>,
}

/// How a pass ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CycleOutcome {
    /// The pass ran to the end.
    Done,
    /// It stopped before doing anything (Д60).
    Stopped(StopReason),
    /// Commits kept losing the race (Д10); try again later.
    Busy,
}

/// Why one item could not be processed (Д14, Д17).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemErrorKind {
    /// Data from the server did not pass the checks; nothing was written (С5).
    Invalid(CryptoError),
    /// The header fields contradict each other (Д65).
    Inconsistent,
    /// The disk refused (С4).
    Disk(FsError),
}

/// An error that stopped one item but not the pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemError {
    /// The item.
    pub item_id: ItemId,
    /// What went wrong.
    pub kind: ItemErrorKind,
}

/// An item this build only reads (Д66, С13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadOnlyItem {
    /// The item.
    pub item_id: ItemId,
    /// Its path, when an older version was seen.
    pub path: Option<String>,
}

/// The report of one pass (Д20).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CycleReport {
    /// How it ended.
    pub outcome: CycleOutcome,
    /// Files written from the server.
    pub downloaded: usize,
    /// Bodies uploaded.
    pub uploaded: usize,
    /// Files renamed on disk.
    pub renamed: usize,
    /// Files moved to the trash.
    pub trashed: usize,
    /// Conflicts created by this pass.
    pub conflicts: Vec<ConflictRecord>,
    /// The "not synchronised" list after the pass.
    pub unsynced: Vec<UnsyncedRecord>,
    /// Items this build only reads.
    pub read_only: Vec<ReadOnlyItem>,
    /// Some item needs a newer Amby (С13).
    pub needs_update: bool,
    /// Items that failed.
    pub errors: Vec<ItemError>,
    /// Outgoing changes were held back by an unfinished journal (Д59).
    pub outgoing_paused: bool,
    /// The pass was a full reconcile without deletions (Д8, Д58).
    pub full_reconcile: bool,
}

/// Why a pass could not run to a report.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    /// Another process synchronises this vault (С14).
    #[error("the vault is being synchronised by another process")]
    Locked,
    /// The network failed (Д19); the state is whole.
    #[error("remote: {0}")]
    Remote(RemoteError),
    /// The file system failed in a way that stops the pass (not a single item).
    #[error("file system: {0}")]
    Fs(FsError),
    /// The state store failed.
    #[error("state: {0}")]
    State(StateError),
    /// A cryptographic failure that is not about one item.
    #[error("crypto: {0}")]
    Crypto(CryptoError),
}
