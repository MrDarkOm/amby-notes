//! The ports of the engine: everything it touches goes through these traits (Р12, Д2).
//!
//! Every method is called one after another from one thread. A port may fail at any call; the
//! engine must leave the device in a state a later pass can continue from (Д4). A port that "loses
//! the process" (the simulation does) fails every call from then on.

use std::any::Any;
use std::io::Read;

use crate::crypto::keys::{BodyId, ItemId};

use super::model::{StateTx, SyncState};

// ----- clock -----

/// The clock. Used only for marks in lists (conflicts, "not synchronised"), never for decisions
/// (Р3, С10, Д2).
pub trait Clock {
    /// Milliseconds since the Unix epoch, UTC.
    fn now_ms(&self) -> i64;
}

// ----- local file system -----

/// What a directory entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalKind {
    /// A regular file.
    File,
    /// A directory.
    Folder,
    /// A symbolic link (never synchronised, Р4).
    Symlink,
}

/// One entry of the local listing (Д12). `path` is relative to the root of the vault, with `/`
/// separators, in the spelling the system gave (NFD on macOS, Д61).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalEntry {
    /// Path relative to the vault root.
    pub path: String,
    /// File, folder or link.
    pub kind: LocalKind,
    /// Size in bytes (0 for folders and links).
    pub size: u64,
    /// Modification time in nanoseconds (Р10: with the size, the fast check).
    pub mtime_ns: i64,
}

/// The result of listing the vault.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Listing {
    /// Everything that has a name the engine can use, files, folders and links, recursively.
    pub entries: Vec<LocalEntry>,
    /// Entries whose names are not UTF-8 (shown lossily): they cannot be synchronised (Р4, Д11).
    pub not_utf8: Vec<String>,
}

/// Does the folder of the vault exist (Р8, С8)?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootState {
    /// The folder is there (it may be empty).
    Present,
    /// The folder is gone, for example an unmounted disk.
    Missing,
}

/// Why a snapshot is made before a file is replaced (Р8, Д53).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotReason {
    /// A file is replaced by a version from the server (history reason `sync-overwrite`). The
    /// port must keep the old content in the history even when the history is switched off.
    SyncOverwrite,
}

/// Why a file goes to the trash (Р8, Д52).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashReason {
    /// Deleted on another device. The port moves it to `.amby/trash/` whatever the delete mode.
    RemoteDeletion,
}

/// Rules of names on this system (Р9, Д62).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NameRules {
    /// Windows rules: `<>:"\|?*`, trailing dot or space, reserved names.
    pub windows_names: bool,
    /// Names that differ only in case are the same file (macOS, Windows).
    pub case_insensitive: bool,
    /// The longest segment in UTF-8 bytes.
    pub max_segment_bytes: usize,
    /// The longest path in UTF-8 bytes.
    pub max_path_bytes: usize,
}

impl NameRules {
    /// Windows: its forbidden names, case-insensitive, 255-byte segments, 259-byte paths.
    pub const fn windows() -> Self {
        Self {
            windows_names: true,
            case_insensitive: true,
            max_segment_bytes: 255,
            max_path_bytes: 259,
        }
    }

    /// macOS: case-insensitive, 255-byte segments, 1024-byte paths.
    pub const fn macos() -> Self {
        Self {
            windows_names: false,
            case_insensitive: true,
            max_segment_bytes: 255,
            max_path_bytes: 1024,
        }
    }

    /// Linux: case-sensitive, 255-byte segments, 4096-byte paths.
    pub const fn linux() -> Self {
        Self {
            windows_names: false,
            case_insensitive: false,
            max_segment_bytes: 255,
            max_path_bytes: 4096,
        }
    }
}

/// Why the file system refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FsError {
    /// The path is not there.
    #[error("not found: {0}")]
    NotFound(String),
    /// The target exists and may not be replaced (`rename`).
    #[error("already exists: {0}")]
    AlreadyExists(String),
    /// The disk is full (С4). The target is untouched.
    #[error("no space left")]
    NoSpace,
    /// The system refuses access to this one file or folder (permissions, a lock held by another
    /// program). It stops that item only, never the whole pass (Э4, carried over from Э3).
    #[error("access denied: {0}")]
    AccessDenied(String),
    /// Anything else, including a lost process in the simulation.
    #[error("i/o error: {0}")]
    Io(String),
}

/// A file being written next to its target (С3, Ф24). Nothing is visible at the target until
/// [`StagedWrite::publish`].
pub trait StagedWrite {
    /// Appends bytes to the temporary file.
    fn write(&mut self, bytes: &[u8]) -> Result<(), FsError>;
    /// Makes the temporary file the target **atomically**. If the target exists and `snapshot` is
    /// given, the old content is first saved to the history of this device (Р8, Д53); a failure
    /// of the snapshot fails the publish and leaves the old file.
    fn publish(self: Box<Self>, snapshot: Option<SnapshotReason>) -> Result<(), FsError>;
    /// Throws the temporary file away. The target is not touched.
    fn abort(self: Box<Self>);
}

/// The local file system of the vault (Р10, Д12–Д17). Paths are relative to the root, `/`
/// separators.
pub trait LocalFs {
    /// Is the root there (Д55)?
    fn root_state(&mut self) -> Result<RootState, FsError>;
    /// Lists the whole vault recursively, with the fast-check attributes (Д12).
    fn list(&mut self) -> Result<Listing, FsError>;
    /// Reads a whole file.
    fn read(&mut self, path: &str) -> Result<Vec<u8>, FsError>;
    /// Starts a write to `path`: a temporary file next to it (`.<name>.amby-tmp-*`, Р4), missing
    /// parent folders are created at publish.
    fn begin_write(&mut self, path: &str) -> Result<Box<dyn StagedWrite>, FsError>;
    /// Creates a folder with its parents; it is fine when it exists.
    fn create_dir(&mut self, path: &str) -> Result<(), FsError>;
    /// Moves a file or a folder. **Never overwrites**: an existing target is
    /// [`FsError::AlreadyExists`]. Missing parents of the target are created.
    fn rename(&mut self, from: &str, to: &str) -> Result<(), FsError>;
    /// Moves a file to the trash of the vault (Р8, О4, Д52). The only way the engine removes a
    /// file.
    fn move_to_trash(&mut self, path: &str, reason: TrashReason) -> Result<(), FsError>;
    /// Removes a folder when it is empty; answers whether it did.
    fn remove_empty_dir(&mut self, path: &str) -> Result<bool, FsError>;
    /// Is there an unfinished journal of a multi-file operation (`.amby/recovery/`, Р8, Д59)?
    fn recovery_pending(&mut self) -> Result<bool, FsError>;
    /// Removes temporary files left by a process that died during a write (С3, Д10).
    fn cleanup_staged(&mut self) -> Result<(), FsError>;
    /// Rules of names on this system (Р9).
    fn name_rules(&self) -> NameRules;
    /// Start of a batch of incoming changes: watcher events are merged and the index is updated
    /// once at [`LocalFs::batch_end`] (Р8, Д17).
    fn batch_begin(&mut self);
    /// End of the batch; always called after `batch_begin`, also after an error.
    fn batch_end(&mut self);
}

// ----- remote server -----

/// What `GET /v1/info` says that the engine needs (П9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    /// Lowest protocol version the server speaks.
    pub protocol_min: u32,
    /// Highest protocol version the server speaks.
    pub protocol_max: u32,
    /// Changes when the server is reset (П10, Д56).
    pub instance_id: [u8; 16],
    /// The largest body after encryption (П8).
    pub max_blob_bytes: u64,
    /// The most items in one commit (П8).
    pub max_commit_items: u32,
}

/// One entry of the compressed change feed (П31).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeEntry {
    /// Sequence number of the commit that made this version.
    pub seq: u64,
    /// The item.
    pub item_id: ItemId,
    /// Its version on the server.
    pub version: u64,
    /// The encrypted header envelope (Ф18).
    pub header: Vec<u8>,
    /// The body of this version, if any.
    pub blob_id: Option<BodyId>,
    /// Size of the sealed body, if any.
    pub blob_size: Option<u64>,
    /// The open deletion mark (not trusted, Р6).
    pub deleted: bool,
    /// The device that made the commit.
    pub device_id: [u8; 16],
    /// When the server accepted it.
    pub committed_ms: i64,
}

/// A page of the change feed (П31).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangesPage {
    /// The server instance (П10).
    pub instance_id: [u8; 16],
    /// Head of the feed.
    pub seq: u64,
    /// The cursor this page answers.
    pub since: u64,
    /// The cursor for the next request.
    pub next: u64,
    /// Is there more after this page?
    pub more: bool,
    /// A full reconcile is needed (П32, Д58).
    pub gap: bool,
    /// The entries, ascending by `seq`.
    pub changes: Vec<ChangeEntry>,
}

/// State of a body upload (П21).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobState {
    /// Size of the sealed body.
    pub size: u64,
    /// Numbers of the parts that are already there.
    pub uploaded: Vec<u64>,
    /// Is the body complete?
    pub complete: bool,
}

/// One entry of a commit (П26).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitItem {
    /// The item.
    pub item_id: ItemId,
    /// The version this change is based on; 0 creates (Р3).
    pub base_version: u64,
    /// The sealed header envelope.
    pub header: Vec<u8>,
    /// The body this version points to.
    pub blob_id: Option<BodyId>,
    /// The open deletion mark.
    pub deleted: bool,
}

/// An accepted commit (П26, П28).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitAccepted {
    /// The `seq` the commit got.
    pub seq: u64,
    /// This is the answer to a repeat of an accepted commit.
    pub replayed: bool,
    /// The new version of each item, in request order.
    pub versions: Vec<(ItemId, u64)>,
}

/// One item that did not match its base (П27).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionConflict {
    /// The item.
    pub item_id: ItemId,
    /// The version we based the change on.
    pub base_version: u64,
    /// The version the server has.
    pub current_version: u64,
}

/// The answer to a commit (П27).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitReply {
    /// Accepted (or a replay of an accepted one).
    Accepted(CommitAccepted),
    /// Rejected as a whole, with every conflicting item.
    Conflict(Vec<VersionConflict>),
}

/// Why a request to the server failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RemoteError {
    /// The request did not reach the server or the answer was lost: **it is unknown whether the
    /// request was applied** (С1, С2). Retrying is the next pass (Д19).
    #[error("network error: {0}")]
    Network(String),
    /// No valid token (С12, `401`).
    #[error("unauthorized")]
    Unauthorized,
    /// The token of this device was revoked (`401 token_revoked`).
    #[error("device revoked")]
    Revoked,
    /// The server refused for another reason.
    #[error("server refused: HTTP {status} {code}")]
    Rejected {
        /// HTTP status.
        status: u16,
        /// Machine code (Б.0.1).
        code: String,
    },
}

/// The server for **one** space, already signed in (protocol: appendix Б).
pub trait Remote {
    /// `GET /v1/info` (П9).
    fn info(&mut self) -> Result<ServerInfo, RemoteError>;
    /// `GET …/changes?since=…&limit=…` (П31).
    fn changes(&mut self, since: u64, limit: Option<u32>) -> Result<ChangesPage, RemoteError>;
    /// `POST …/blobs`: starts a body or finds out how far it got (П21).
    fn blob_start(&mut self, blob: &BodyId, size: u64) -> Result<BlobState, RemoteError>;
    /// `PUT …/blobs/{id}/parts/{n}` (П22).
    fn blob_put_part(&mut self, blob: &BodyId, part: u64, bytes: &[u8]) -> Result<(), RemoteError>;
    /// `POST …/blobs/{id}/complete` (П23).
    fn blob_complete(&mut self, blob: &BodyId) -> Result<(), RemoteError>;
    /// `GET …/blobs/{id}`: the sealed body as a stream (П24).
    fn blob_download(&mut self, blob: &BodyId) -> Result<Box<dyn Read + '_>, RemoteError>;
    /// `POST …/commit` (П26–П28).
    fn commit(
        &mut self,
        commit_id: &[u8; 16],
        items: &[CommitItem],
    ) -> Result<CommitReply, RemoteError>;
}

// ----- state of the device -----

/// Why the state store failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StateError {
    /// Another process holds the lock (С14).
    #[error("the vault is being synchronised by another process")]
    Locked,
    /// Anything else, including a lost process in the simulation.
    #[error("state store error: {0}")]
    Io(String),
}

/// A held lock; dropping it releases the lock (С14, Д9).
pub struct StateLock(
    /// Whatever keeps the lock alive.
    pub Box<dyn Any>,
);

/// The persistent state of the device (Р10, Д3).
pub trait StateStore {
    /// The whole state; empty for a device that never synchronised (Д8).
    fn load(&mut self) -> Result<SyncState, StateError>;
    /// Applies a transaction **atomically**: all of it or none of it (Д4).
    fn apply(&mut self, tx: &StateTx) -> Result<(), StateError>;
    /// Takes the exclusive lock of the vault (С14, Д9). Busy is [`StateError::Locked`].
    fn lock(&mut self) -> Result<StateLock, StateError>;

    /// Keeps the content of a base (appendix Г, Г6–Г9) under `(item, hash)` where `hash` is the
    /// BLAKE3 of `bytes`. Durable and atomic before it returns; a repeat is harmless. Written
    /// **before** the transaction that makes it the base of the record (Г9). Not part of
    /// [`StateStore::apply`]: it is a file of the device, not a row. Г7.
    fn base_put(&mut self, item: &ItemId, hash: &[u8; 32], bytes: &[u8]) -> Result<(), StateError>;

    /// The content of a base, **only if** the BLAKE3 of the stored bytes equals `hash`. No base,
    /// a damaged file or one that belongs to another hash is `Ok(None)`, never an error (Г7, Г10).
    fn base_get(&mut self, item: &ItemId, hash: &[u8; 32]) -> Result<Option<Vec<u8>>, StateError>;

    /// Removes every base except the listed `(item, hash)` pairs (Г9). Nothing listed removes all.
    fn base_prune(&mut self, keep: &[(ItemId, [u8; 32])]) -> Result<(), StateError>;
}
