//! Earlier versions of a note and deleted files from the server (docs/sync-plan.md, appendix И,
//! Э5): the flows behind the commands `sync_note_versions`, `sync_read_server_version`,
//! `sync_restore_server_version`, `sync_deleted_files` and `sync_restore_deleted` (И19).
//!
//! The flows work on a [`ServerAccess`] (the port of the server, the keys, the state of the
//! engine) and on the vault folder; they do not know Tauri. A restore is an ordinary local write
//! through the existing atomic functions of history and trash (И6, И15), under the same
//! `mutation_gate` as every other write (the command takes it). The pure parts — opening the
//! headers, dropping repeats — are `amby_sync_core::engine::history` (И18).
//!
//! Stage Э5 (plan, раздел 6): interfaces only so far, the bodies are `todo!()` until the tests in
//! [`super::server_history_tests`] are reviewed.

use std::path::Path;
use std::sync::Mutex;

use amby_sync_core::crypto::keys::{SpaceId, SpaceKey};
use amby_sync_core::engine::{Remote, SyncState};
use serde::{Deserialize, Serialize};

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

/// A cache of the lists of deleted files, kept in memory until the next pass of the sync (И13).
#[derive(Default)]
pub struct ServerHistoryCache {
    deleted: Mutex<Option<DeletedOnServer>>,
}

impl ServerHistoryCache {
    /// Forgets everything: called when a pass of the sync ends (И13).
    pub fn invalidate(&self) {
        *self
            .deleted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
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
    let _ = (vault, note, access);
    todo!("И1–И4")
}

/// The text of one version for the preview (И5): downloads, decrypts in memory, checks BLAKE3
/// against the header. Nothing is written.
pub fn read_server_version(
    access: Option<&ServerAccess<'_>>,
    item_id: &str,
    version: u64,
) -> Result<ServerVersionText, SyncError> {
    let _ = (access, item_id, version);
    todo!("И5")
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
    let _ = (vault, note, access, item_id, version, expected_hash);
    todo!("И6")
}

/// The "on the server" part of the archive (И9–И13): one `versions` request per tombstone, at most
/// [`MAX_PARALLEL_VERSION_REQUESTS`] at the same time; the newest [`MAX_DELETED_ROWS`]; the result
/// is kept in `cache` until the next pass. Files that the local trash holds with the same path and
/// content, and files that lie at their path with that content, are left out (И11).
pub fn deleted_files(
    vault: &Path,
    access: Option<&ServerAccess<'_>>,
    cache: &ServerHistoryCache,
    now_ms: u64,
) -> DeletedOnServer {
    let _ = (vault, access, cache, now_ms);
    todo!("И9–И13")
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
    let _ = (vault, access, item_ids);
    todo!("И15, И17")
}
