//! Migration from `.amby/properties.json` of the first format to the groups (З19–З21, З38–З42).
//! Interfaces only.
#![allow(dead_code, unused_variables)]

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::Connection;

/// A value in the file that differs from the header (З19, З20).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    pub note_id: String,
    pub property_id: String,
    pub name: String,
    pub file_value: String,
    pub header_value: String,
}

/// A property with a value in the file and no key in the header (З20).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingKey {
    pub note_id: String,
    pub property_id: String,
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

/// The owner's decisions (З20).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Decisions {
    /// `(note id, property id)` for which the value of the file replaces the header's.
    pub use_file_value: BTreeSet<(String, String)>,
    /// Confirmation by the owner of the vault (З21, З38).
    pub confirmed: bool,
}

/// What the application knows around the migration (З38).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Context {
    pub sync_enabled: bool,
    /// The last pass of the synchronisation was successful.
    pub last_pass_ok: bool,
    /// `layout.json` came from the server: another device migrated.
    pub layout_came_from_server: bool,
}

/// What a run did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Outcome {
    pub migration_id: String,
    pub groups_written: usize,
    pub headers_written: Vec<String>,
    /// Notes whose header changed between a crash and the repeat: left alone (З41).
    pub skipped_changed: Vec<String>,
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

/// The migration: confirmation → copies of `properties.json` and of every note whose header is
/// edited → journal in `.amby/migrations/<id>/` → groups → headers → `layout.json` last →
/// outcome (З21). `properties.json` is never changed (З22).
pub fn run(
    conn: &Connection,
    vault: &Path,
    decisions: &Decisions,
    context: &Context,
) -> Result<Outcome, String> {
    todo!("З20, З21, З22, З38, З39, З40, З41")
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
