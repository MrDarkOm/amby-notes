//! What crosses the IPC border for the sync of a vault (docs/sync-plan.md, stage Э4): the status,
//! the lists the person works with (conflicts, "not synchronised"), the approvals of the stops
//! of Р8 and the choice of a space. Machine words only: the interface translates them.

use serde::{Deserialize, Serialize};

use crate::sync::conflict_store::ConflictSource;

/// What the sync of the open vault is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    /// This vault is not synchronised (never enabled, or switched off).
    Off,
    /// Enabled, nothing to do right now; waits for a change on disk or on the server.
    Idle,
    /// A pass is running.
    Running,
    /// A pass failed (no network, the server is busy): it will be repeated after a pause (Д19).
    Waiting,
    /// A stop of Р8 or a failure that needs the person: nothing happens until they answer.
    Stopped,
}

/// One file of a stop for a mass change (Р8, Д54).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannedView {
    /// The path in the vault.
    pub path: String,
    /// `overwrite`, `trash` or `sendDelete`.
    pub action: String,
}

/// Why synchronisation stopped and waits for the person (Р8, Д60).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StopView {
    /// Too many files would be overwritten, deleted or sent as deleted.
    #[serde(rename_all = "camelCase")]
    MassChange {
        /// `incoming` (the server would change this computer) or `outgoing`.
        direction: String,
        /// How many files in all.
        total: u32,
        /// The first files (at most 200).
        files: Vec<PlannedView>,
    },
    /// The folder of the vault is gone (an unplugged disk?).
    VaultMissing,
    /// The folder of the vault is empty but sync remembers files.
    VaultEmpty,
    /// The server was reset: it has another identity.
    ServerReset,
    /// The server has fewer changes than this computer already saw.
    ServerBehind,
    /// The server showed an older version of a file.
    Rollback,
    /// The server no longer accepts this computer (sign in again).
    AuthRequired,
    /// The server speaks another protocol.
    IncompatibleServer,
}

/// An unresolved conflict (Р7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    /// The id inside the name of the copy; used to resolve it.
    pub id: String,
    /// `bothEdited` or `bothCreated`.
    pub kind: String,
    /// The file that kept the name.
    pub original_path: String,
    /// The copy with the other version.
    pub copy_path: String,
    /// When the copy was made, Unix milliseconds.
    pub created_ms: i64,
    /// Where the second version is kept: a set in `.amby/conflicts/` or an old copy beside the
    /// file (Г32). The fields below were added in stage Э4б; they are optional on the interface
    /// side so that it can read a status without them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub source: Option<ConflictSource>,
    /// Both versions can be compared line by line (Г28).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub text: Option<bool>,
    /// The set has a common base (Г21).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub has_base: Option<bool>,
    /// This computer made the conflict (Г25, Г34).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub created_here: Option<bool>,
}

/// A file that is not synchronised on this computer (Р4, Р9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnsyncedView {
    /// The path.
    pub path: String,
    /// `symlink`, `notUtf8`, `tooLarge`, `tooBigForMemory`, `excludedPath`, `invalidName`,
    /// `caseCollision`, `nameCollision`, `pathBusy`, `noAccess` or `quotaFull`.
    pub reason: String,
    /// More about the reason: for `invalidName` the problem (`forbiddenChar`, `trailingDot`,
    /// `reservedName`, `segmentTooLong`, `pathTooLong`), for `caseCollision` the other path.
    pub detail: Option<String>,
    /// For `tooLarge` (appendix Е, Д74): the largest sealed body in force, in bytes. Optional on
    /// the interface side so that it can read a status without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub max_bytes: Option<u64>,
    /// For `tooLarge`: `plan` or `server`, where the limit comes from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub limit_source: Option<String>,
}

/// What the last pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PassSummary {
    /// Files written from the server.
    pub downloaded: u32,
    /// Bodies uploaded.
    pub uploaded: u32,
    /// Files renamed on disk.
    pub renamed: u32,
    /// Files moved to the trash of the vault.
    pub trashed: u32,
}

/// The state of the sync of the open vault. No secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultSyncStatus {
    /// The vault is linked to a space and switched on.
    pub enabled: bool,
    /// The vault is linked to a space (switched on or off).
    pub linked: bool,
    /// The link belongs to the connection of this device (the same server and account), so
    /// switching on again resumes the very same space. A link that is not resumable is stale: the
    /// screen offers the choice of a space as the first time.
    pub resumable: bool,
    /// Legacy stored value retained for IPC compatibility; never displayed by the UI.
    pub test_vault: bool,
    /// Legacy gate state; false after the confirmed runs of stage Э4.
    pub gate_closed: bool,
    /// Complete external pre-sync copy, containing `vault/`, a manifest and restore instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub backup_path: Option<String>,
    /// The space on the server (hex), if linked.
    pub space_id: Option<String>,
    /// Its name, if it could be read.
    pub space_name: Option<String>,
    /// What it is doing.
    pub phase: SyncPhase,
    /// When the last pass ended well, Unix milliseconds.
    pub last_sync_ms: Option<i64>,
    /// Seconds until the next try after a failure.
    pub next_try_secs: Option<u64>,
    /// The machine code of the last failure (`network`, `timeout`, `server_unavailable`, …).
    pub error_code: Option<String>,
    /// The stop that waits for an answer.
    pub stop: Option<StopView>,
    /// Outgoing changes wait for an unfinished operation to end (Р8).
    pub outgoing_paused: bool,
    /// Some file needs a newer Amby (С13).
    pub needs_update: bool,
    /// Open conflicts.
    pub conflicts: Vec<ConflictView>,
    /// Files that are not synchronised here.
    pub unsynced: Vec<UnsyncedView>,
    /// Files that failed in the last pass and will be tried again.
    pub item_errors: u32,
    /// What the last pass did.
    pub last: Option<PassSummary>,
}

impl VaultSyncStatus {
    /// The status of a vault that is not synchronised.
    pub fn off(gate_closed: bool) -> Self {
        Self {
            enabled: false,
            linked: false,
            resumable: false,
            test_vault: false,
            gate_closed,
            backup_path: None,
            space_id: None,
            space_name: None,
            phase: SyncPhase::Off,
            last_sync_ms: None,
            next_try_secs: None,
            error_code: None,
            stop: None,
            outgoing_paused: false,
            needs_update: false,
            conflicts: Vec::new(),
            unsynced: Vec::new(),
            item_errors: 0,
            last: None,
        }
    }
}

/// The answer to a stop of Р8 (Д60). Each lasts one pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalKind {
    /// Go on despite a mass change.
    MassChange,
    /// The folder of the vault really is empty.
    EmptyVault,
    /// Forget the link with the server and reconcile this vault with it again by content.
    Resync,
}

/// How a conflict is resolved (Р7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// Keep the file under its name, the copy goes to the trash of the vault.
    KeepOriginal,
    /// The content of the copy replaces the file (the replaced version stays in the history).
    KeepCopy,
    /// Both stay as files; the entry leaves the list.
    KeepBoth,
}

/// The two versions of a conflict as text, for the comparison (stage Э4б). A side is `None` when it
/// cannot be shown as text: bytes that are not UTF-8, a file that is gone, or one too large to
/// compare in the window. The text is the whole file as it is on disk (BOM, line endings, properties).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersions {
    /// The file under its name.
    pub original: Option<String>,
    /// The second version.
    pub copy: Option<String>,
    /// A fingerprint of both files as they were read; `resolve_conflict_with_text` refuses a text
    /// built from versions that have changed since (`conflict_changed`).
    pub stamp: String,
}

/// A space of the account, for "connect an existing vault".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceView {
    /// The identifier (hex, 32 characters).
    pub space_id: String,
    /// The name; `None` when it cannot be read with this account key.
    pub name: Option<String>,
    /// The number of the last commit.
    pub seq: u64,
    /// Created, Unix milliseconds.
    pub created_ms: i64,
}

/// Which space this vault is linked to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpaceTarget {
    /// Make a new space with this name.
    #[serde(rename_all = "camelCase")]
    New {
        /// The name; empty means the name of the folder of the vault.
        name: String,
    },
    /// Use a space that exists on the server.
    #[serde(rename_all = "camelCase")]
    Existing {
        /// Its identifier (hex).
        space_id: String,
    },
}
