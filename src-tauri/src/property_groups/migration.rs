//! Migration from `.amby/properties.json` of the first format to the groups (З19–З21, З38–З42).
//! Interfaces only.
#![allow(dead_code, unused_variables)]

use std::path::Path;

use rusqlite::Connection;

/// A value in the file that differs from the header (З19, З20).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    pub note_id: String,
    pub name: String,
    pub file_value: String,
    pub header_value: String,
}

/// A property with a value in the file and no key in the header (З20).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingKey {
    pub note_id: String,
    pub name: String,
    pub file_value: String,
}

/// Why a note is not touched (З20, З25).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Untouchable {
    MalformedHeader,
    NoId,
    DuplicateId,
    /// The value cannot be written into the header without loss (З40).
    HeaderCannotChange,
}

/// The report of the dry run (З19).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Report {
    pub notes: usize,
    pub properties: usize,
    /// Values equal to the header by the meaning of YAML (З40).
    pub same: usize,
    pub mismatches: Vec<Mismatch>,
    pub missing_keys: Vec<MissingKey>,
    /// Notes the migration does not touch; their designs are carried over (З20).
    pub untouchable: Vec<(String, Untouchable)>,
    /// Records without a note (З11).
    pub orphans: Vec<String>,
    /// How many notes get a new header: the owner is warned of the question of Д54 (З40).
    pub header_edits: usize,
    /// Includes [`super::OLD_VERSION_WARNING`] (З37).
    pub warnings: Vec<String>,
}

/// What the application knows around the migration (З38).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Context {
    pub sync_enabled: bool,
    /// The last pass of the synchronisation was successful.
    pub last_pass_ok: bool,
    /// `layout.json` came from the server: another device migrated.
    pub layout_came_from_server: bool,
    /// The number of the template in a `layout.json` that arrived from another device (З54).
    pub arrived_template: Option<u32>,
}

/// What a run did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Outcome {
    pub migration_id: String,
    pub groups_written: usize,
    pub headers_written: Vec<String>,
    /// Notes whose header changed between a crash and the repeat: left alone (З41).
    pub skipped_changed: Vec<String>,
    /// Notes whose value in the old file and in the header differed; the header's was kept
    /// (З58). The list for the report and the notice «Расходились значения у N заметок».
    pub diverged: Vec<Mismatch>,
}

/// What a rollback did (З42).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RollbackReport {
    pub headers_restored: Vec<String>,
    /// Headers not restored because they changed after the migration.
    pub not_restored: Vec<String>,
    pub groups_removed: usize,
}

/// The dry run: counts and decisions, **no write at all** (З19). An unreadable `properties.json`
/// or an unknown version is an error (З41).
pub fn preview(conn: &Connection, vault: &Path) -> Result<Report, String> {
    todo!("З19, З20, З40, З41")
}

/// The migration (З21, З54, З57): copies of `properties.json` and of every note whose header is
/// edited → journal in `.amby/migrations/<id>/` → files → headers → `layout.json` last → outcome.
/// No confirmation and no choice of values: a diverging value keeps the header's and is listed
/// in [`Outcome::diverged`] (З58). `properties.json` becomes differences from the template, in
/// the language of the name that matched; a property equal to the template gives no line; the
/// order goes to `order` only when it differs from the header's; the `id` of properties are not
/// carried. `properties.json` is never changed (З22). It does not start when the template number
/// of an arrived `layout.json` is higher than ours (З54).
pub fn run(conn: &Connection, vault: &Path, context: &Context) -> Result<Outcome, String> {
    todo!("З21, З22, З38, З39, З40, З41, З54, З57, З58")
}

/// Why the properties of a vault are for reading only (З57, З59).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOnlyReason {
    /// `properties.json` cannot be read or has an unknown version (З59).
    UnreadableOldFile,
    /// Synchronisation is on and there was no successful pass yet (З38).
    WaitingForSync,
}

/// What the opening of a vault found (З57).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenOutcome {
    /// `layout.json` is there: nothing to do.
    AlreadyGroups,
    /// Migrated now (or an interrupted migration was finished by its journal).
    Migrated(Outcome),
    /// `layout.json` came from another device: no migration of our own (З38).
    ArrivedFromServer,
    /// Not migrated, the properties are for reading only (З59, З38).
    ReadOnly(ReadOnlyReason),
}

/// The first opening of a vault by the new version (З57): decides by itself, with no question —
/// preview, then [`run`], or [`resume`] by an existing journal. Nothing is written when it does
/// not migrate. Never changes `properties.json`.
pub fn open_vault(
    conn: &Connection,
    vault: &Path,
    context: &Context,
) -> Result<OpenOutcome, String> {
    todo!("З38, З41, З57, З59")
}

/// «Взять значение из старого файла» (З58): writes the value of `properties.json` into the header
/// of the note as an ordinary edit of a value (З1, with history); changes nothing else.
pub fn take_file_value(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
) -> Result<(), String> {
    todo!("З58, З1")
}

/// Finishes an interrupted migration by its journal (З21, З41).
pub fn resume(conn: &Connection, vault: &Path) -> Result<Outcome, String> {
    todo!("З21, З41")
}

/// The rollback (З42): before `layout.json` it is part of the repeat; after the end it is a manual
/// action of the inspection.
pub fn rollback(
    conn: &Connection,
    vault: &Path,
    migration_id: &str,
) -> Result<RollbackReport, String> {
    todo!("З42")
}
