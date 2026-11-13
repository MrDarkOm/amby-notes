//! Earlier versions and deleted files from the server (docs/sync-plan.md, appendix И, Э5).
//!
//! Pure functions: they open and check what the server listed ([`super::ports::Remote::versions`],
//! П33) and lay it out for the history panel of a note and for the "on the server" part of the
//! archive. None of them writes to a disk or talks to a server (И18). A restore is an ordinary
//! local write made by the application; the engine has no path of its own for it (И.0).
//!
use crate::crypto::body::open_body;
use crate::crypto::error::CryptoError;
use crate::crypto::header::{header_envelope_epoch, open_header, Header, ItemKind};
use crate::crypto::keys::{BodyId, ItemId, SpaceId, SpaceKey};
use crate::crypto::padme::sealed_body_len;

use super::consistency::check_header;
use super::model::ItemRecord;
use super::ports::VersionEntry;

/// Opens the header of one listed version and checks it against the entry (Ф14, Ф19, Д65). The
/// open `deleted` mark of the entry is not believed (Р6).
fn open_entry(
    space: &SpaceId,
    keys: &[SpaceKey],
    item: &ItemId,
    entry: &VersionEntry,
) -> Result<Header, SkipCode> {
    let epoch = header_envelope_epoch(&entry.header).map_err(|_| SkipCode::Unreadable)?;
    let key = keys
        .iter()
        .find(|key| key.epoch() == epoch)
        .ok_or(SkipCode::UnknownEpoch)?;
    let header =
        open_header(key, space, item, entry.version, &entry.header).map_err(
            |error| match error {
                CryptoError::EpochMismatch => SkipCode::UnknownEpoch,
                _ => SkipCode::Unreadable,
            },
        )?;
    check_header(&header).map_err(|_| SkipCode::Inconsistent)?;
    if entry.blob_id != header.body_id {
        return Err(SkipCode::Inconsistent);
    }
    if header.body_id.is_some() {
        let expected = sealed_body_len(header.size).ok();
        if entry.blob_size.is_none() || entry.blob_size != expected {
            return Err(SkipCode::Inconsistent);
        }
    }
    Ok(header)
}

/// A live file header that passed the checks → the fields of a shown version.
fn as_version(entry: &VersionEntry, header: &Header) -> Option<HistoryVersion> {
    if header.deleted || header.kind != ItemKind::File {
        return None;
    }
    Some(HistoryVersion {
        item_id: entry.item_id,
        version: entry.version,
        path: header.path.clone(),
        size: header.size,
        content_hash: header.content_hash?,
        body_id: header.body_id?,
        device_id: entry.device_id,
        committed_ms: entry.committed_ms,
    })
}

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
    /// Versions that are not shown because their content equals the file on the disk or a local
    /// snapshot (И3), newest first. The application marks the matching snapshots with a cloud
    /// (И3а); they never get a row of their own.
    pub covered: Vec<HistoryVersion>,
    /// The file on the disk equals the newest version the server has (И3а).
    pub current_is_latest: bool,
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
    let mut history = ServerHistory::default();
    let mut newest: Option<(u64, bool)> = None;
    for entry in entries {
        match open_entry(space, keys, &entry.item_id, entry) {
            Ok(header) => {
                let version = as_version(entry, &header);
                // The newest opened header decides "the file is the latest version" (И3а): a
                // deletion on top is not a text the file could equal.
                if newest.is_none_or(|(number, _)| entry.version > number) {
                    let equal = version
                        .as_ref()
                        .is_some_and(|found| current_hash == Some(found.content_hash));
                    newest = Some((entry.version, equal));
                }
                let Some(version) = version else {
                    continue;
                };
                let repeated = current_hash == Some(version.content_hash)
                    || snapshot_hashes.contains(&version.content_hash);
                if repeated {
                    history.covered.push(version);
                } else {
                    history.versions.push(version);
                }
            }
            Err(code) => history.skipped.push(SkippedVersion {
                version: entry.version,
                code,
            }),
        }
    }
    history.current_is_latest = newest.is_some_and(|(_, equal)| equal);
    history
        .versions
        .sort_by_key(|version| std::cmp::Reverse(version.version));
    history
        .covered
        .sort_by_key(|version| std::cmp::Reverse(version.version));
    history
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
    if version.size > MAX_PREVIEW_BYTES {
        return OpenedVersion::TooLarge;
    }
    keys.iter()
        .find_map(|key| {
            open_body(
                key,
                &version.body_id,
                version.size,
                &version.content_hash,
                sealed,
            )
            .ok()
        })
        .map_or(OpenedVersion::Damaged, OpenedVersion::Content)
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

/// Is `path` inside the service folder `.amby/` of the vault (conflict sets, property group files,
/// layout and the rest)? Such files are never shown to the person and never restored (И10а). The
/// folder is the first component of a vault path; the comparison ignores case because the disk of
/// a Mac or a Windows machine does.
pub fn is_service_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized
        .trim_start_matches('/')
        .split('/')
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case(".amby"))
}

/// The deleted file one tombstone stands for, with **no** filtering by path (И10): the caller of a
/// restore uses it to find out what was asked for and refuse a service path itself (И10а).
/// `None` when the latest version that passes the checks is not a deletion, or no earlier version
/// has a body.
pub fn locate_deleted_file(
    space: &SpaceId,
    keys: &[SpaceKey],
    tombstone: &ItemRecord,
    entries: &[VersionEntry],
) -> Option<DeletedFile> {
    if !tombstone.deleted || tombstone.kind != ItemKind::File {
        return None;
    }
    // Only the headers that pass the checks count, newest first.
    let mut opened: Vec<(&VersionEntry, Header)> = entries
        .iter()
        .filter_map(|entry| {
            open_entry(space, keys, &tombstone.item_id, entry)
                .ok()
                .map(|header| (entry, header))
        })
        .collect();
    opened.sort_by_key(|(entry, _)| std::cmp::Reverse(entry.version));
    let (deleting, latest) = opened.first()?;
    if !latest.deleted {
        return None;
    }
    let version = opened
        .iter()
        .skip(1)
        .find_map(|(entry, header)| as_version(entry, header))?;
    Some(DeletedFile {
        item_id: tombstone.item_id,
        path: version.path,
        size: version.size,
        version: version.version,
        body_id: version.body_id,
        content_hash: version.content_hash,
        deleted_ms: deleting.committed_ms,
        deleted_seq: deleting.seq,
        deleted_by: deleting.device_id,
    })
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
/// descending). A path inside `.amby/` never gets a row (И10а); a path deleted several times gets one
/// row, for the newest deletion (И10б). Appendix И, И10, И10а, И10б, И11, И18.
pub fn deleted_files(
    space: &SpaceId,
    keys: &[SpaceKey],
    tombstones: &[ItemRecord],
    histories: &[ItemHistory],
    hidden: &[(String, [u8; 32])],
) -> Vec<DeletedFile> {
    deleted_files_matched(space, keys, tombstones, histories, hidden).rows
}

/// A deleted file of the server that something in `hidden` covers (И11а).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HiddenMatch {
    /// Position in the `hidden` list passed in: the application knows what it was (a trash entry
    /// or a file that lies at its path).
    pub hidden_index: usize,
    /// The deleted file on the server.
    pub file: DeletedFile,
}

/// [`deleted_files`] and the rows that `hidden` covered (И11а).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeletedFiles {
    /// The rows to show, newest deletion first.
    pub rows: Vec<DeletedFile>,
    /// Rows left out by `hidden`, one per matching entry of `hidden`, newest deletion first.
    pub matched: Vec<HiddenMatch>,
}

/// [`deleted_files`] that also reports which entry of `hidden` covered which deleted file, so the
/// application can mark the local trash entry with a cloud (И11а). The rows are the same.
/// Appendix И, И10, И11, И11а, И18.
pub fn deleted_files_matched(
    space: &SpaceId,
    keys: &[SpaceKey],
    tombstones: &[ItemRecord],
    histories: &[ItemHistory],
    hidden: &[(String, [u8; 32])],
) -> DeletedFiles {
    let mut files: Vec<DeletedFile> = Vec::new();
    for tombstone in tombstones {
        let Some(entries) = histories
            .iter()
            .find(|history| history.item_id == tombstone.item_id)
            .and_then(|history| history.entries.as_ref())
        else {
            continue;
        };
        // Service files (И10а) are not the person's: no row, no cloud mark.
        if let Some(file) = locate_deleted_file(space, keys, tombstone, entries)
            .filter(|file| !is_service_path(&file.path))
        {
            files.push(file);
        }
    }
    let covering = |file: &DeletedFile| -> Vec<usize> {
        hidden
            .iter()
            .enumerate()
            .filter(|(_, (path, hash))| *path == file.path && *hash == file.content_hash)
            .map(|(index, _)| index)
            .collect()
    };
    let mut matched = Vec::new();
    for file in &files {
        matched.extend(covering(file).into_iter().map(|hidden_index| HiddenMatch {
            hidden_index,
            file: file.clone(),
        }));
    }
    // И10б: one row per path, for the newest deletion.
    let mut rows: Vec<DeletedFile> = Vec::new();
    for file in files {
        match rows.iter_mut().find(|row| row.path == file.path) {
            Some(row) if row.deleted_seq >= file.deleted_seq => {}
            Some(row) => *row = file,
            None => rows.push(file),
        }
    }
    rows.retain(|row| covering(row).is_empty());
    rows.sort_by_key(|row| std::cmp::Reverse(row.deleted_seq));
    matched.sort_by_key(|found| std::cmp::Reverse(found.file.deleted_seq));
    DeletedFiles { rows, matched }
}
