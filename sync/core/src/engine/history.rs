//! Earlier versions and deleted files from the server (docs/sync-plan.md, appendix И, Э5).
//!
//! Pure functions: they open and check what the server listed ([`super::ports::Remote::versions`],
//! П33) and lay it out for the history panel of a note and for the "on the server" part of the
//! archive. None of them writes to a disk or talks to a server (И18). A restore is an ordinary
//! local write made by the application; the engine has no path of its own for it (И.0).
//!
//! Stage Э5 (plan, раздел 6): interfaces only so far, the bodies are `todo!()` until the tests of
//! `sync/core/tests/history_server.rs` are reviewed.

use crate::crypto::keys::{BodyId, ItemId, SpaceId, SpaceKey};

use super::model::ItemRecord;
use super::ports::VersionEntry;

/// The largest body that is downloaded for a preview or a restore: the memory limit of Д71
/// (`EngineConfig::max_file_bytes`). Bigger bodies are "too large to preview" (И5).
pub const MAX_PREVIEW_BYTES: u64 = 256 * 1024 * 1024;

/// One version from the server that the history panel may show (И1, И2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryVersion {
    /// The item.
    pub item_id: ItemId,
    /// The version number on the server.
    pub version: u64,
    /// The path the header of this version has: a renamed note shows older versions under their
    /// earlier paths (И2-г).
    pub path: String,
    /// Size of the content in bytes.
    pub size: u64,
    /// BLAKE3 of the content (header, trusted after the checks of И2).
    pub content_hash: [u8; 32],
    /// The body of this version.
    pub body_id: BodyId,
    /// The device that made this version (the server knows its id, the name comes from the
    /// device list).
    pub device_id: [u8; 16],
    /// When the server accepted it; for display only (И1, Р3).
    pub committed_ms: i64,
}

/// Why a version was left out although the server listed it (И2-в): it goes to the journal with a
/// code, the person sees nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipCode {
    /// The header does not open: another key, another item, another version in the AAD, damaged
    /// bytes, a bad path (Ф14, Ф19).
    Unreadable,
    /// The header opens but its fields contradict each other or the entry (Д65).
    Inconsistent,
    /// No key for the epoch of the header.
    UnknownEpoch,
}

/// A version that was left out by [`SkipCode`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SkippedVersion {
    /// The version number on the server.
    pub version: u64,
    /// Why.
    pub code: SkipCode,
}

/// The list for the history panel and the versions that were refused.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ServerHistory {
    /// Shown versions, newest first.
    pub versions: Vec<HistoryVersion>,
    /// Versions the journal must mention. Versions that are simply not shown (deleted, same as the
    /// file or a snapshot) are not here.
    pub skipped: Vec<SkippedVersion>,
}

/// Opens, checks and lays out the versions of **one** note (И2, И3, И18).
///
/// `entries` are what [`super::ports::Remote::versions`] answered; `keys` hold the key of every
/// epoch the space has had; `current_hash` is the BLAKE3 of the file on the disk now;
/// `snapshot_hashes` are the BLAKE3 of the local snapshots of this note.
///
/// Shown: versions whose header (a) is not `deleted` — the open mark of the entry is not believed
/// (Р6) —, (b) has a body that agrees with the entry, (c) passes the checks of the core (Ф14, Ф19,
/// Д65; otherwise the version is in `skipped`), whatever its path is (d). Not shown: a version
/// whose `content_hash` equals `current_hash` or one of `snapshot_hashes` (И3). Newest first.
/// Appendix И, И2, И3, И18.
pub fn server_history(
    space: &SpaceId,
    keys: &[SpaceKey],
    entries: &[VersionEntry],
    current_hash: Option<[u8; 32]>,
    snapshot_hashes: &[[u8; 32]],
) -> ServerHistory {
    let _ = (space, keys, entries, current_hash, snapshot_hashes);
    todo!("И2, И3, И18")
}

/// What opening the body of a version gave (И5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenedVersion {
    /// The content, byte for byte, verified against `content_hash` of the header.
    Content(Vec<u8>),
    /// The body does not pass the checks of Ф22–Ф25 or its BLAKE3 differs from the header: the
    /// version is "damaged", it can be neither shown nor restored.
    Damaged,
    /// The content is bigger than [`MAX_PREVIEW_BYTES`]: it is not downloaded at all.
    TooLarge,
}

/// Opens the downloaded `sealed` body of `version` with the key of its epoch (И5, И15). A size
/// above [`MAX_PREVIEW_BYTES`] is `TooLarge` whatever `sealed` holds; any check that fails is
/// `Damaged`; nothing else is ever returned as content. Appendix И, И5, Д14, Д71.
pub fn open_version_body(
    keys: &[SpaceKey],
    version: &HistoryVersion,
    sealed: &[u8],
) -> OpenedVersion {
    let _ = (keys, version, sealed);
    todo!("И5")
}

/// What the server answered for one tombstone: `entries` is `None` when the server has no such
/// item any more (`404`, removed by the cleanup, П36).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemHistory {
    /// The item.
    pub item_id: ItemId,
    /// `versions` of the item; `None` for `404`.
    pub entries: Option<Vec<VersionEntry>>,
}

/// A deleted file the server can still give back (И10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletedFile {
    /// The item.
    pub item_id: ItemId,
    /// Path of the **last version with a body** before the deletion.
    pub path: String,
    /// Size of that content.
    pub size: u64,
    /// The version that holds the body (the one to download).
    pub version: u64,
    /// The body of that version.
    pub body_id: BodyId,
    /// BLAKE3 of that content.
    pub content_hash: [u8; 32],
    /// `committed_ms` of the version that deleted the item.
    pub deleted_ms: i64,
    /// `seq` of the deleting commit: the order of the list and the cut of И13.
    pub deleted_seq: u64,
    /// The device that made the deletion.
    pub deleted_by: [u8; 16],
}

/// Lays out the deleted files of the server (И10, И11, И18).
///
/// A row for every tombstone in `tombstones` that is a file (not a folder, Д3) and whose `history`
/// says: the latest version is `deleted` **by its header**, and an earlier version has a body that
/// passed the checks of И2. The row describes that last version with a body. No row for an item
/// that is not in `histories`, for `entries == None` (`404`), for one without a body anywhere, or
/// for one whose latest version is alive. `hidden` lists `(path, content_hash)` of what the
/// person already has — the local trash and the files that lie at their path now (И11): a row
/// with the same path and the same hash is dropped. Newest deletion first (`deleted_seq`
/// descending). Appendix И, И10, И11, И18.
pub fn deleted_files(
    space: &SpaceId,
    keys: &[SpaceKey],
    tombstones: &[ItemRecord],
    histories: &[ItemHistory],
    hidden: &[(String, [u8; 32])],
) -> Vec<DeletedFile> {
    let _ = (space, keys, tombstones, histories, hidden);
    todo!("И10, И11, И18")
}
