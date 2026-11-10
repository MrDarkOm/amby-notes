//! Earlier versions of a note and deleted files from the server (docs/sync-plan.md, appendix И,
//! Э5): the flows behind the commands `sync_note_versions`, `sync_read_server_version`,
//! `sync_restore_server_version`, `sync_deleted_files` and `sync_restore_deleted` (И19).
//!
//! The flows work on a [`ServerAccess`] (the port of the server, the keys, the state of the
//! engine) and on the vault folder; they do not know Tauri. A restore is an ordinary local write
//! through the existing atomic functions of history and trash (И6, И15), under the same
//! `mutation_gate` as every other write (the command takes it). The pure parts — opening the
//! headers, dropping repeats — are `amby_sync_core::engine::history` (И18).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use amby_sync_core::crypto::keys::{ItemId, SpaceId, SpaceKey};
use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::history::{
    self as core_history, DeletedFile, HistoryVersion, ItemHistory, OpenedVersion,
    MAX_PREVIEW_BYTES,
};
use amby_sync_core::engine::{ItemRecord, Remote, RemoteError, SyncState, VersionEntry};
use serde::{Deserialize, Serialize};

use crate::frontmatter::AtomicCreateError;
use crate::sync::types::SyncError;

/// Why the server part of a list is not there (И4, И13). Not an error: the person has nothing to
/// do, the panel shows one calm line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ServerListUnavailable {
    /// Sync of this vault is off or this device is not signed in: "…when sync is on".
    SyncOff,
    /// The server could not be reached: "…when there is a connection".
    Offline,
}

/// Whose change a version is (И1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum VersionDevice {
    /// Made on this computer.
    ThisDevice,
    /// Made on another device.
    OtherDevice,
}

/// One version from the server in the history list of a note (И1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerVersionView {
    /// The item on the server, 32 hex digits.
    pub item_id: String,
    /// The version number on the server.
    pub version: u64,
    /// The path this version had; differs from the note's path after a rename (И2-г).
    pub path: String,
    /// Size of the content in bytes.
    pub size_bytes: u64,
    /// BLAKE3 of the content, 64 hex digits.
    pub content_hash: String,
    /// `committed_ms` of the server, for display only (Р3).
    pub committed_ms: u64,
    /// This computer or another device.
    pub device: VersionDevice,
    /// The name of the device when the server knows it.
    pub device_name: Option<String>,
}

/// The server part of the history list of a note (И19).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteServerVersions {
    /// Is the server part there? `false` is not an error (И4).
    pub available: bool,
    /// Why not, when `available` is `false`.
    pub reason: Option<ServerListUnavailable>,
    /// Newest first (И2, И3).
    pub versions: Vec<ServerVersionView>,
    /// BLAKE3 of the note on the disk when this list was made, 64 hex digits: "Вернуть" passes it
    /// back as `expected_hash` so a note that changed meanwhile is not overwritten (И6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub current_hash: Option<String>,
    /// Local snapshots whose text is also on the server (И3а): they get a cloud, the matching
    /// version has no row of its own.
    #[serde(default)]
    pub snapshots_on_server: Vec<SnapshotOnServer>,
    /// The file on the disk is the newest version on the server (И3а): one calm line.
    #[serde(default)]
    pub current_on_server: bool,
}

/// A local snapshot that equals a version on the server (И3а).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOnServer {
    /// The local snapshot.
    pub snapshot_id: String,
    /// The newest server version with the same content.
    pub version: u64,
    /// This computer or another device made that version (I1).
    pub device: VersionDevice,
    /// The name of the device when the server knows it.
    pub device_name: Option<String>,
    /// `committed_ms` of that version, for display only.
    pub committed_ms: u64,
}

/// What opening a version for a preview gave (И5, И14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ServerVersionState {
    /// The text is there.
    Ok,
    /// The body does not match the header: neither shown nor restorable.
    Damaged,
    /// Bigger than the memory limit (Д71): not downloaded.
    TooLarge,
    /// The server could not be reached.
    Offline,
}

/// The text of a version for the preview, the same as for a snapshot (И5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerVersionText {
    /// How it went.
    pub state: ServerVersionState,
    /// The content as text when `state` is `Ok` and it is valid UTF-8.
    pub content: Option<String>,
}

/// How a restore of a version went (И6). The person reads it under the button (И20).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RestoreVersionStatus {
    /// The bytes of the version are on the disk; the old content is in a `restore` snapshot.
    Restored,
    /// The file changed since the list was shown: nothing was written, the list is read again.
    NoteChanged,
    /// The version is damaged: nothing was written.
    Damaged,
    /// Too large to restore: nothing was written.
    TooLarge,
    /// The server could not be reached: nothing was written.
    Offline,
    /// Sync of this vault is off: nothing was written, no snapshot was made (И6).
    SyncOff,
}

/// The answer to "Вернуть" for a version (И6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreVersionOutcome {
    /// How it went.
    pub status: RestoreVersionStatus,
}

/// A deleted file in the "on the server" part of the archive (И10, И12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedFileView {
    /// The item on the server, 32 hex digits.
    pub item_id: String,
    /// Path of the last version with a body.
    pub path: String,
    /// Size of that content in bytes.
    pub size_bytes: u64,
    /// When the deletion reached the server, milliseconds.
    pub deleted_ms: u64,
    /// Until when the server keeps it, milliseconds (a hint, И12).
    pub kept_until_ms: Option<u64>,
    /// This computer or another device deleted it.
    pub device: VersionDevice,
    /// The name of the device when the server knows it.
    pub device_name: Option<String>,
}

/// The "on the server" part of the archive (И19).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedOnServer {
    /// Is the server part there? `false` is not an error (И13).
    pub available: bool,
    /// Why not.
    pub reason: Option<ServerListUnavailable>,
    /// Newest deletion first, at most 500 (И13).
    pub files: Vec<DeletedFileView>,
    /// There were more than 500 deleted files: only the newest are shown (И13).
    pub truncated: bool,
    /// Local trash entries that match a deleted file of the server (И11а): they get a cloud, the
    /// file has no row of its own.
    #[serde(default)]
    pub trash_on_server: Vec<TrashOnServer>,
}

/// A local trash entry that is also on the server (И11а).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashOnServer {
    /// The trash entry (`list_trash` id).
    pub trash_id: String,
    /// The item on the server, 32 hex digits.
    pub item_id: String,
    /// When the deletion reached the server, milliseconds.
    pub deleted_ms: u64,
    /// Until when the server keeps it (a hint, И12).
    pub kept_until_ms: Option<u64>,
    /// This computer or another device deleted it.
    pub device: VersionDevice,
    /// The name of the device when the server knows it.
    pub device_name: Option<String>,
}

/// How one file of a restore went (И15, И17).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RestoreFileStatus {
    /// Written to its own path.
    Restored,
    /// The path was taken: written next to it under a free name, nothing was replaced.
    RestoredRenamed,
    /// Damaged on the server: nothing written.
    Damaged,
    /// Too large: nothing written.
    TooLarge,
    /// The server no longer has it, or it is not a deleted file of this vault: nothing written.
    Gone,
    /// The server could not be reached or the disk refused: nothing written.
    Failed,
    /// Sync of this vault is off: nothing written (И15).
    SyncOff,
    /// A service file (inside `.amby/`): never restored, even when asked for; nothing written
    /// (И10а).
    NotRestorable,
}

/// One row of the answer to a restore of several files (И17).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFileResult {
    /// The item asked for.
    pub item_id: String,
    /// How it went.
    pub status: RestoreFileStatus,
    /// The path the file has now (relative to the vault), when it was written (И15).
    pub final_path: Option<String>,
}

/// The answer to "Вернуть" in the archive (И17): one line under the button.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreDeletedOutcome {
    /// How many files were asked for.
    pub requested: u32,
    /// How many were written (also under another name).
    pub restored: u32,
    /// How many were damaged on the server.
    pub damaged: u32,
    /// Every file, in the order asked.
    pub results: Vec<RestoreFileResult>,
}

/// Everything a flow needs from the sync of the open vault. `None` instead of it means sync is off
/// (`reason = SyncOff`).
pub struct ServerAccess<'a> {
    /// Makes a fresh port of the server. The flows ask for several (at most
    /// [`MAX_PARALLEL_VERSION_REQUESTS`] at a time, И13); a port is used by one thread.
    pub connect: &'a (dyn Fn() -> Box<dyn Remote + Send> + Sync),
    /// The space.
    pub space: SpaceId,
    /// The keys of the space, every epoch.
    pub keys: Vec<SpaceKey>,
    /// The state of the engine: the bases and tombstones (Д3).
    pub state: SyncState,
    /// The id of this device, to tell "this computer" from "another device" (И1).
    pub this_device: [u8; 16],
    /// Names of devices the server knows.
    pub device_names: Vec<([u8; 16], String)>,
    /// `history_days` of the account, else `retention.version_days` of the server (И12, П61, П9).
    pub history_days: u32,
}

/// The most `versions` requests at the same time (И13).
pub const MAX_PARALLEL_VERSION_REQUESTS: usize = 8;
/// The most deleted files in a list (И13).
pub const MAX_DELETED_ROWS: usize = 500;

/// A cache of the lists of deleted files, kept in memory until the next pass of the sync (И13) or
/// until the tombstones of the state change: an own push does not move the cursor of the feed
/// until the next pass, so a local delete must end the life of the list by itself.
#[derive(Default)]
pub struct ServerHistoryCache {
    /// The list and the fingerprint of the tombstones it was built from.
    deleted: Mutex<Option<(u64, DeletedOnServer)>>,
    cursor: Mutex<Option<u64>>,
}

impl ServerHistoryCache {
    /// Forgets everything: called when a pass of the sync ends (И13).
    pub fn invalidate(&self) {
        *self
            .deleted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    /// A pass of the sync that moved the cursor of the feed ends the life of the list: the
    /// state it was built from is out of date (И13).
    pub fn see_cursor(&self, cursor: u64) {
        let mut seen = self
            .cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *seen != Some(cursor) {
            *seen = Some(cursor);
            self.invalidate();
        }
    }
}

// ----- helpers -----

const DAY_MS: u64 = 86_400_000;

/// Replaces a note with a version; `Ok(false)` when the note changed and nothing was written (И6).
pub type RestoreFn<'a> = &'a dyn Fn(&Path, &[u8]) -> Result<bool, String>;

/// Creates a file that must not exist yet (the write of a restored file, И15).
pub type CreateFn<'a> = &'a dyn Fn(&Path, &[u8]) -> Result<(), AtomicCreateError>;

fn parse_item(text: &str) -> Option<ItemId> {
    let bytes: [u8; 16] = hex::decode(text).ok()?.try_into().ok()?;
    Some(ItemId::from_bytes(bytes))
}

fn ms(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn device_of(access: &ServerAccess<'_>, device: &[u8; 16]) -> (VersionDevice, Option<String>) {
    if *device == access.this_device {
        return (VersionDevice::ThisDevice, None);
    }
    let name = access
        .device_names
        .iter()
        .find(|(id, _)| id == device)
        .map(|(_, name)| name.clone());
    (VersionDevice::OtherDevice, name)
}

/// What `versions` of one item answered.
enum Listing {
    Entries(Vec<VersionEntry>),
    /// `404`: the server has no such item (also after the cleanup, П36).
    Missing,
    /// Any other failure: the server is not there for now.
    Down,
}

fn list_versions(remote: &mut dyn Remote, item: &ItemId) -> Listing {
    match remote.versions(item) {
        Ok(entries) => Listing::Entries(entries),
        Err(RemoteError::Rejected { status: 404, .. }) => Listing::Missing,
        Err(_) => Listing::Down,
    }
}

/// The record the engine has for the live file at `relative` (И2).
fn record_at<'a>(state: &'a SyncState, relative: &str) -> Option<&'a ItemRecord> {
    state.items.values().find(|record| {
        !record.deleted
            && record.kind == amby_sync_core::crypto::header::ItemKind::File
            && record.path == relative
    })
}

fn relative_of(vault: &Path, note: &Path) -> Option<String> {
    crate::durable::relative_string(vault, note, "note").ok()
}

/// A body that was asked for, in the shape a flow needs.
enum Fetched {
    Content(Vec<u8>),
    Damaged,
    TooLarge,
    Offline,
}

/// Downloads the body of `version`, opens it in memory and checks BLAKE3 against the header
/// (И5, Д14). A body above the memory limit is not downloaded at all (Д71).
fn fetch_body(
    access: &ServerAccess<'_>,
    remote: &mut dyn Remote,
    version: &HistoryVersion,
) -> Fetched {
    if version.size > MAX_PREVIEW_BYTES {
        return Fetched::TooLarge;
    }
    let Ok(expected) = sealed_body_len(version.size) else {
        return Fetched::Damaged;
    };
    let mut sealed = Vec::new();
    match remote.blob_download(&version.body_id) {
        Ok(reader) => {
            if reader.take(expected + 1).read_to_end(&mut sealed).is_err() {
                return Fetched::Offline;
            }
        }
        Err(RemoteError::Rejected { status: 404, .. }) => return Fetched::Damaged,
        Err(_) => return Fetched::Offline,
    }
    match core_history::open_version_body(&access.keys, version, &sealed) {
        OpenedVersion::Content(bytes) => Fetched::Content(bytes),
        OpenedVersion::Damaged => Fetched::Damaged,
        OpenedVersion::TooLarge => Fetched::TooLarge,
    }
}

/// One version of an item as the core lays it out, plus the text of the failure when there is none.
enum Located {
    Version(Box<HistoryVersion>),
    /// Not listed, or not a version that passes the checks.
    Unusable,
    Offline,
}

fn locate_version(
    access: &ServerAccess<'_>,
    remote: &mut dyn Remote,
    item: &ItemId,
    version: u64,
) -> Located {
    let entries = match list_versions(remote, item) {
        Listing::Entries(entries) => entries,
        Listing::Missing => return Located::Unusable,
        Listing::Down => return Located::Offline,
    };
    let wanted: Vec<VersionEntry> = entries
        .into_iter()
        .filter(|entry| entry.version == version)
        .collect();
    core_history::server_history(&access.space, &access.keys, &wanted, None, &[])
        .versions
        .into_iter()
        .next()
        .map_or(Located::Unusable, |found| Located::Version(Box::new(found)))
}

fn hash_hex(hash: &[u8; 32]) -> String {
    hex::encode(hash)
}

fn file_hash(path: &Path) -> Option<[u8; 32]> {
    std::fs::read(path).ok().map(|bytes| blake3_hash(&bytes))
}

/// Is the file still the one the list was shown for? (И6)
pub fn file_matches(path: &Path, expected_hash: &str) -> bool {
    file_hash(path).is_some_and(|hash| hash_hex(&hash).eq_ignore_ascii_case(expected_hash))
}

/// The plain write of a version over a note: the `restore` snapshot, then the atomic write. The
/// file is checked once more right before (the caller holds the gate): `Ok(false)` when it
/// changed, nothing is written then.
pub fn plain_restore_write(
    vault: &Path,
    note: &Path,
    bytes: &[u8],
    expected_hash: &str,
) -> Result<bool, String> {
    if !file_matches(note, expected_hash) {
        return Ok(false);
    }
    crate::history::commit_snapshot_restore(
        vault,
        crate::history::PreparedSnapshotRestore {
            path: note.to_path_buf(),
            bytes: bytes.to_vec(),
        },
    )
    .map(|_| true)
}

fn plain_create_write(path: &Path, bytes: &[u8]) -> Result<(), AtomicCreateError> {
    crate::frontmatter::atomic_write_bytes_new(path, bytes)
}

/// The server versions of the note at `note` (an absolute path in `vault`) for the history panel
/// (И1–И4). One `versions` request, made when the panel opens. No access, a lost connection and
/// any failure of the request are `available = false` with a reason, never an error. Versions
/// equal to the file on the disk or to a local snapshot of this note are left out (И3).
pub fn note_versions(
    vault: &Path,
    note: &Path,
    access: Option<&ServerAccess<'_>>,
) -> NoteServerVersions {
    let unavailable = |reason| NoteServerVersions {
        available: false,
        reason: Some(reason),
        versions: Vec::new(),
        current_hash: None,
        snapshots_on_server: Vec::new(),
        current_on_server: false,
    };
    let Some(access) = access else {
        return unavailable(ServerListUnavailable::SyncOff);
    };
    let current = file_hash(note);
    let available = |versions| NoteServerVersions {
        available: true,
        reason: None,
        versions,
        current_hash: current.as_ref().map(hash_hex),
        snapshots_on_server: Vec::new(),
        current_on_server: false,
    };
    let Some(record) = relative_of(vault, note).and_then(|rel| record_at(&access.state, &rel))
    else {
        // The engine does not know the note yet: the server has nothing of it.
        return available(Vec::new());
    };
    let item = record.item_id;
    let mut remote = (access.connect)();
    let entries = match list_versions(remote.as_mut(), &item) {
        Listing::Entries(entries) => entries,
        Listing::Missing => return available(Vec::new()),
        Listing::Down => return unavailable(ServerListUnavailable::Offline),
    };
    let snapshots: Vec<(String, [u8; 32])> = crate::history::list_snapshots(vault, note)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let prepared = crate::history::prepare_snapshot_restore(vault, &entry.id).ok()?;
            Some((entry.id.clone(), blake3_hash(&prepared.bytes)))
        })
        .collect();
    let snapshot_hashes: Vec<[u8; 32]> = snapshots.iter().map(|(_, hash)| *hash).collect();
    let history = core_history::server_history(
        &access.space,
        &access.keys,
        &entries,
        current,
        &snapshot_hashes,
    );
    for skipped in &history.skipped {
        tracing::warn!(
            event = "sync_history_version_skipped",
            version = skipped.version,
            code = ?skipped.code
        );
    }
    // И3а: a snapshot whose text is on the server gets the label of the newest such version.
    let snapshots_on_server = snapshots
        .iter()
        .filter_map(|(snapshot_id, hash)| {
            let version = history
                .covered
                .iter()
                .find(|version| version.content_hash == *hash)?;
            let (device, device_name) = device_of(access, &version.device_id);
            Some(SnapshotOnServer {
                snapshot_id: snapshot_id.clone(),
                version: version.version,
                device,
                device_name,
                committed_ms: ms(version.committed_ms),
            })
        })
        .collect();
    let mut list = available(
        history
            .versions
            .iter()
            .map(|version| {
                let (device, device_name) = device_of(access, &version.device_id);
                ServerVersionView {
                    item_id: hex::encode(version.item_id.as_bytes()),
                    version: version.version,
                    path: version.path.clone(),
                    size_bytes: version.size,
                    content_hash: hash_hex(&version.content_hash),
                    committed_ms: ms(version.committed_ms),
                    device,
                    device_name,
                }
            })
            .collect(),
    );
    list.snapshots_on_server = snapshots_on_server;
    list.current_on_server = history.current_is_latest;
    list
}

/// The text of one version for the preview (И5): downloads, decrypts in memory, checks BLAKE3
/// against the header. Nothing is written.
pub fn read_server_version(
    access: Option<&ServerAccess<'_>>,
    item_id: &str,
    version: u64,
) -> Result<ServerVersionText, SyncError> {
    let access = access.ok_or_else(|| SyncError::new("sync_not_running"))?;
    let item = parse_item(item_id).ok_or_else(|| SyncError::new("invalid_item"))?;
    let state = |state| ServerVersionText {
        state,
        content: None,
    };
    let mut remote = (access.connect)();
    let found = match locate_version(access, remote.as_mut(), &item, version) {
        Located::Version(found) => found,
        Located::Unusable => return Ok(state(ServerVersionState::Damaged)),
        Located::Offline => return Ok(state(ServerVersionState::Offline)),
    };
    Ok(match fetch_body(access, remote.as_mut(), &found) {
        Fetched::Content(bytes) => ServerVersionText {
            state: ServerVersionState::Ok,
            content: String::from_utf8(bytes).ok(),
        },
        Fetched::Damaged => state(ServerVersionState::Damaged),
        Fetched::TooLarge => state(ServerVersionState::TooLarge),
        Fetched::Offline => state(ServerVersionState::Offline),
    })
}

/// "Вернуть" for a version of the note at `note` (И6): (а) the current content is saved as a
/// snapshot with the reason `restore`, also when history is off; (б) the bytes of the version are
/// written atomically to the **current** path of the note, byte for byte; (в) the caller then
/// refreshes the watcher and the index as for a snapshot restore. If the file's BLAKE3 is not
/// `expected_hash` (hex) nothing is written and the status is `NoteChanged`. The caller holds the
/// `mutation_gate`.
pub fn restore_server_version(
    vault: &Path,
    note: &Path,
    access: Option<&ServerAccess<'_>>,
    item_id: &str,
    version: u64,
    expected_hash: &str,
) -> Result<RestoreVersionOutcome, SyncError> {
    let restore =
        |path: &Path, bytes: &[u8]| plain_restore_write(vault, path, bytes, expected_hash);
    restore_server_version_with(
        vault,
        note,
        access,
        item_id,
        version,
        expected_hash,
        &restore,
    )
}

/// [`restore_server_version`] with the write supplied by the caller (the command takes the gate
/// and adds the watcher's prepare / confirm around it). `write` answers `Ok(false)` when the file
/// changed after all and nothing was written.
pub fn restore_server_version_with(
    vault: &Path,
    note: &Path,
    access: Option<&ServerAccess<'_>>,
    item_id: &str,
    version: u64,
    expected_hash: &str,
    write: RestoreFn<'_>,
) -> Result<RestoreVersionOutcome, SyncError> {
    let outcome = |status| Ok(RestoreVersionOutcome { status });
    let Some(access) = access else {
        return outcome(RestoreVersionStatus::SyncOff);
    };
    let item = parse_item(item_id).ok_or_else(|| SyncError::new("invalid_item"))?;
    let unchanged = |note: &Path| file_matches(note, expected_hash);
    // The list was shown for this file and this note: anything else is a stale list.
    let is_this_note = relative_of(vault, note)
        .and_then(|rel| record_at(&access.state, &rel).map(|record| record.item_id == item))
        .unwrap_or(false);
    if !is_this_note || !unchanged(note) {
        return outcome(RestoreVersionStatus::NoteChanged);
    }
    let mut remote = (access.connect)();
    let found = match locate_version(access, remote.as_mut(), &item, version) {
        Located::Version(found) => found,
        Located::Unusable => return outcome(RestoreVersionStatus::Damaged),
        Located::Offline => return outcome(RestoreVersionStatus::Offline),
    };
    let bytes = match fetch_body(access, remote.as_mut(), &found) {
        Fetched::Content(bytes) => bytes,
        Fetched::Damaged => return outcome(RestoreVersionStatus::Damaged),
        Fetched::TooLarge => return outcome(RestoreVersionStatus::TooLarge),
        Fetched::Offline => return outcome(RestoreVersionStatus::Offline),
    };
    // The download took time: the file must still be what the list was shown for.
    if !unchanged(note) {
        return outcome(RestoreVersionStatus::NoteChanged);
    }
    let written = write(note, &bytes).map_err(|error| {
        tracing::warn!(event = "sync_history_restore_failed", error = %error);
        SyncError::new("storage_error")
    })?;
    outcome(if written {
        RestoreVersionStatus::Restored
    } else {
        RestoreVersionStatus::NoteChanged
    })
}

/// `versions` of every item, at most [`MAX_PARALLEL_VERSION_REQUESTS`] at the same time (И13).
/// `Err` when the server could not be reached.
fn fetch_histories(access: &ServerAccess<'_>, items: &[ItemId]) -> Result<Vec<ItemHistory>, ()> {
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let results: Mutex<Vec<Option<ItemHistory>>> = Mutex::new(vec![None; items.len()]);
    let workers = MAX_PARALLEL_VERSION_REQUESTS.min(items.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let mut remote = (access.connect)();
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    if index >= items.len() || failed.load(Ordering::SeqCst) {
                        return;
                    }
                    let entries = match list_versions(remote.as_mut(), &items[index]) {
                        Listing::Entries(entries) => Some(entries),
                        Listing::Missing => None,
                        Listing::Down => {
                            failed.store(true, Ordering::SeqCst);
                            return;
                        }
                    };
                    results
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)[index] =
                        Some(ItemHistory {
                            item_id: items[index],
                            entries,
                        });
                }
            });
        }
    });
    if failed.load(Ordering::SeqCst) {
        return Err(());
    }
    Ok(results
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .into_iter()
        .flatten()
        .collect())
}

/// What the person already has, for the paths of `tombstones` only (И11, К6): the file in the
/// archive `.amby/archive/` at the same path and the file that lies at that path now. The list of
/// the server does not show a deleted file that the person has with the same content.
/// `(path, hash)` of each.
fn hidden_by_local_copies(vault: &Path, tombstones: &[&ItemRecord]) -> Vec<(String, [u8; 32])> {
    let wanted: std::collections::HashSet<&str> = tombstones
        .iter()
        .map(|record| record.path.as_str())
        .collect();
    let mut hidden = Vec::new();
    let archive = crate::archive::archive_root(vault);
    for path in &wanted {
        if crate::archive::is_plain_relative(path) && !path.starts_with(".meta/") {
            let archived = archive.join(path);
            if std::fs::symlink_metadata(&archived).is_ok_and(|meta| meta.is_file()) {
                if let Some(hash) = file_hash(&archived) {
                    hidden.push(((*path).to_string(), hash));
                }
            }
        }
        if let Ok(full) = crate::durable::guarded_path(vault, path, "deleted file") {
            if full.is_file() {
                if let Some(hash) = file_hash(&full) {
                    hidden.push(((*path).to_string(), hash));
                }
            }
        }
    }
    hidden
}

/// The tombstones of files the person can see: a tombstone of a service path (И10а) is not asked
/// for at all.
fn tombstone_files(state: &SyncState) -> Vec<&ItemRecord> {
    state
        .items
        .values()
        .filter(|record| {
            record.deleted
                && record.kind == amby_sync_core::crypto::header::ItemKind::File
                && !core_history::is_service_path(&record.path)
        })
        .collect()
}

/// A number that changes when a tombstone appears, goes or is replaced by a newer version (the
/// cache key of the list besides the cursor).
fn tombstone_fingerprint(tombstones: &[&ItemRecord]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut keys: Vec<([u8; 16], u64)> = tombstones
        .iter()
        .map(|record| (*record.item_id.as_bytes(), record.version))
        .collect();
    keys.sort_unstable();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    keys.hash(&mut hasher);
    hasher.finish()
}

/// The "on the server" part of the archive (И9–И13): one `versions` request per tombstone, at most
/// [`MAX_PARALLEL_VERSION_REQUESTS`] at the same time; the newest [`MAX_DELETED_ROWS`]; the result
/// is kept in `cache` until the next pass. Files that the local trash holds with the same path and
/// content, and files that lie at their path with that content, are left out (И11).
pub fn deleted_files(
    vault: &Path,
    access: Option<&ServerAccess<'_>>,
    cache: &ServerHistoryCache,
    _now_ms: u64,
) -> DeletedOnServer {
    let unavailable = |reason| DeletedOnServer {
        available: false,
        reason: Some(reason),
        files: Vec::new(),
        truncated: false,
        trash_on_server: Vec::new(),
    };
    let Some(access) = access else {
        return unavailable(ServerListUnavailable::SyncOff);
    };
    let tombstones = tombstone_files(&access.state);
    let fingerprint = tombstone_fingerprint(&tombstones);
    if let Some((_, cached)) = cache
        .deleted
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .filter(|(seen, _)| *seen == fingerprint)
    {
        return cached;
    }
    let items: Vec<ItemId> = tombstones.iter().map(|record| record.item_id).collect();
    let Ok(histories) = fetch_histories(access, &items) else {
        return unavailable(ServerListUnavailable::Offline);
    };
    let hidden = hidden_by_local_copies(vault, &tombstones);
    let records: Vec<ItemRecord> = tombstones.into_iter().cloned().collect();
    let core_history::DeletedFiles { mut rows, .. } = core_history::deleted_files_matched(
        &access.space,
        &access.keys,
        &records,
        &histories,
        &hidden,
    );
    let truncated = rows.len() > MAX_DELETED_ROWS;
    rows.truncate(MAX_DELETED_ROWS);
    let keep_ms = u64::from(access.history_days) * DAY_MS;
    let view = |row: &DeletedFile| {
        let (device, device_name) = device_of(access, &row.deleted_by);
        let deleted_ms = ms(row.deleted_ms);
        DeletedFileView {
            item_id: hex::encode(row.item_id.as_bytes()),
            path: row.path.clone(),
            size_bytes: row.size,
            deleted_ms,
            kept_until_ms: Some(deleted_ms.saturating_add(keep_ms)),
            device,
            device_name,
        }
    };
    let files = rows.iter().map(view).collect();
    let list = DeletedOnServer {
        available: true,
        reason: None,
        files,
        truncated,
        // К6: the archive is synchronised, so its rows carry no mark of the server any more.
        trash_on_server: Vec::new(),
    };
    *cache
        .deleted
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((fingerprint, list.clone()));
    list
}

/// `name`, or `stem 2.ext`… next to `path`, the rule of the import (И15).
fn free_sibling(path: &Path) -> Option<PathBuf> {
    let dir = path.parent()?;
    let name = path.file_name()?.to_str()?;
    Some(crate::commands::import_files::free_path(dir, name))
}

/// One deleted file: the status and the final path (relative to the vault).
fn restore_one(
    vault: &Path,
    access: &ServerAccess<'_>,
    remote: &mut dyn Remote,
    item_id: &str,
    create: CreateFn<'_>,
) -> (RestoreFileStatus, Option<String>) {
    let none = |status| (status, None);
    let Some(item) = parse_item(item_id) else {
        return none(RestoreFileStatus::Gone);
    };
    let Some(record) = access.state.items.get(item.as_bytes()).filter(|record| {
        record.deleted && record.kind == amby_sync_core::crypto::header::ItemKind::File
    }) else {
        return none(RestoreFileStatus::Gone);
    };
    // И10а: a service file is refused before anything is asked of the server.
    if core_history::is_service_path(&record.path) {
        return none(RestoreFileStatus::NotRestorable);
    }
    let entries = match list_versions(remote, &item) {
        Listing::Entries(entries) => entries,
        Listing::Missing => return none(RestoreFileStatus::Gone),
        Listing::Down => return none(RestoreFileStatus::Failed),
    };
    let histories = [ItemHistory {
        item_id: item,
        entries: Some(entries),
    }];
    let Some(row) = histories[0].entries.as_deref().and_then(|entries| {
        core_history::locate_deleted_file(&access.space, &access.keys, record, entries)
    }) else {
        return none(RestoreFileStatus::Gone);
    };
    // И10а again, by the path of the version that would be written.
    if core_history::is_service_path(&row.path) {
        return none(RestoreFileStatus::NotRestorable);
    }
    let row = &row;
    let version = as_history_version(row);
    let bytes = match fetch_body(access, remote, &version) {
        Fetched::Content(bytes) => bytes,
        Fetched::Damaged => return none(RestoreFileStatus::Damaged),
        Fetched::TooLarge => return none(RestoreFileStatus::TooLarge),
        Fetched::Offline => return none(RestoreFileStatus::Failed),
    };
    let Ok(target) = crate::durable::guarded_path(vault, &row.path, "deleted file") else {
        return none(RestoreFileStatus::Failed);
    };
    let mut path = target.clone();
    for _ in 0..8 {
        if std::fs::symlink_metadata(&path).is_ok() {
            match free_sibling(&path) {
                Some(next) => path = next,
                None => return none(RestoreFileStatus::Failed),
            }
        }
        match create(&path, &bytes) {
            Ok(()) => {
                let relative = crate::durable::relative_string(vault, &path, "deleted file").ok();
                let status = if path == target {
                    RestoreFileStatus::Restored
                } else {
                    RestoreFileStatus::RestoredRenamed
                };
                return (status, relative);
            }
            // Taken in the meantime: never replaced, the next free name is tried.
            Err(AtomicCreateError::AlreadyExists) => {}
            Err(AtomicCreateError::Other(error)) => {
                tracing::warn!(event = "sync_history_restore_failed", error = %error);
                return none(RestoreFileStatus::Failed);
            }
        }
    }
    none(RestoreFileStatus::Failed)
}

fn as_history_version(row: &DeletedFile) -> HistoryVersion {
    HistoryVersion {
        item_id: row.item_id,
        version: row.version,
        path: row.path.clone(),
        size: row.size,
        content_hash: row.content_hash,
        body_id: row.body_id,
        device_id: row.deleted_by,
        committed_ms: row.deleted_ms,
    }
}

/// "Вернуть" for deleted files (И15, И17): each file by itself, in the order asked; an error of
/// one does not stop the others. A file is written **without replacing** at its original path
/// (missing folders are created); if the path is taken it goes next to it as `Name 2.md`, `Name 3.md`… (the rule of `free_path` in `commands/import_files.rs`). Without `access` every file is `SyncOff`. The
/// caller holds the `mutation_gate`, then refreshes the watcher and the index, and a pass of the
/// sync sends the files as new or revived items (И16).
pub fn restore_deleted(
    vault: &Path,
    access: Option<&ServerAccess<'_>>,
    item_ids: &[String],
) -> Result<RestoreDeletedOutcome, SyncError> {
    restore_deleted_with(vault, access, item_ids, &plain_create_write)
}

/// [`restore_deleted`] with the creating write supplied by the caller (the command adds the
/// watcher's prepare / confirm around it).
pub fn restore_deleted_with(
    vault: &Path,
    access: Option<&ServerAccess<'_>>,
    item_ids: &[String],
    create: CreateFn<'_>,
) -> Result<RestoreDeletedOutcome, SyncError> {
    let mut remote = access.map(|access| (access.connect)());
    let mut results = Vec::with_capacity(item_ids.len());
    for item_id in item_ids {
        let (status, final_path) = match (access, remote.as_mut()) {
            (Some(access), Some(remote)) => {
                restore_one(vault, access, remote.as_mut(), item_id, create)
            }
            _ => (RestoreFileStatus::SyncOff, None),
        };
        results.push(RestoreFileResult {
            item_id: item_id.clone(),
            status,
            final_path,
        });
    }
    let restored = |result: &RestoreFileResult| {
        matches!(
            result.status,
            RestoreFileStatus::Restored | RestoreFileStatus::RestoredRenamed
        )
    };
    Ok(RestoreDeletedOutcome {
        requested: u32::try_from(results.len()).unwrap_or(u32::MAX),
        restored: u32::try_from(results.iter().filter(|r| restored(r)).count()).unwrap_or(u32::MAX),
        damaged: u32::try_from(
            results
                .iter()
                .filter(|r| r.status == RestoreFileStatus::Damaged)
                .count(),
        )
        .unwrap_or(u32::MAX),
        results,
    })
}

/// The pieces of a running session that the history flows need (cloned, no secrets are printed).
pub struct HistoryLink {
    /// The vault folder.
    pub vault: PathBuf,
    /// Carries the requests.
    pub handle: tokio::runtime::Handle,
    /// The server.
    pub client: amby_sync_client::SyncClient,
    /// The token of this device.
    pub token: amby_sync_client::DeviceToken,
    /// AK, to read the names of devices.
    pub account_key: amby_sync_core::crypto::keys::AccountKey,
    /// The space.
    pub space_id: [u8; 16],
    /// Its key.
    pub vk: SpaceKey,
    /// This device.
    pub device_id: [u8; 16],
}

impl HistoryLink {
    /// A fresh port of the server for one thread.
    pub fn connect(&self) -> Box<dyn Remote + Send> {
        Box::new(crate::sync::remote::HttpRemote::new(
            self.handle.clone(),
            self.client.clone(),
            self.token.clone(),
            self.space_id,
        ))
    }

    /// The names of the devices and `history_days`, as far as the server answers: a failure is
    /// an empty list and the default of 30 days, never an error (И1, И12).
    pub async fn extras(&self, need_days: bool) -> (Vec<([u8; 16], String)>, u32) {
        use std::time::Duration;
        let names = async {
            let devices =
                amby_sync_client::list_devices(&self.client, &self.token, &self.account_key)
                    .await
                    .ok()?;
            Some(
                devices
                    .into_iter()
                    .filter_map(|device| {
                        let id: [u8; 16] = hex::decode(&device.device_id).ok()?.try_into().ok()?;
                        Some((id, device.name?))
                    })
                    .collect::<Vec<_>>(),
            )
        };
        let names = tokio::time::timeout(Duration::from_secs(8), names)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        let days = if need_days {
            let ask = async {
                if let Ok(view) = self.client.account(&self.token).await {
                    return u32::try_from(view.limits.history_days).ok();
                }
                let info = self.client.info().await.ok()?;
                let days = info.rest.get("retention")?.get("version_days")?.as_u64()?;
                u32::try_from(days).ok()
            };
            tokio::time::timeout(Duration::from_secs(8), ask)
                .await
                .ok()
                .flatten()
                .unwrap_or(30)
        } else {
            30
        };
        (names, days)
    }

    /// The state of the engine: the bases and the tombstones (Д3).
    pub fn load_state(&self) -> Result<SyncState, SyncError> {
        use amby_sync_core::engine::StateStore;
        crate::sync::state_db::SqliteStateStore::open(&self.vault)
            .and_then(|mut store| store.load())
            .map_err(|_| SyncError::new("state_error"))
    }
}
