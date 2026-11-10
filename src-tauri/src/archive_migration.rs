//! The one-time move of the old trash into the archive (docs/sync-plan.md, К7, К9, К10).
//!
//! INTERFACE ONLY (section 6, step 1): bodies are `todo!()`; `archive_migration_tests.rs` is red
//! until the code is written. The rules of AGENTS.md for persistent migrations apply: a version in
//! `.amby/migrations/`, a read-only preflight, a journal of steps, a marker of completion, a
//! recorded outcome, a rollback by the journal, and nothing is ever deleted.
#![allow(dead_code, unused_variables, clippy::needless_pass_by_value)]

use std::path::Path;

/// The kind of the migration in `.amby/migrations/` (К9).
pub const MIGRATION_KIND: &str = "trash-to-archive";
/// The version of the migration (К9).
pub const MIGRATION_VERSION: u32 = 1;

/// What the migration would do, found without writing anything (К9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preflight {
    /// All entries of `.amby/trash/` the migration looked at.
    pub entries: usize,
    /// Entries that would move: original path outside `.amby/`, payload and description sound.
    pub to_move: usize,
    /// Entries that would stay and why (К7).
    pub to_keep: Vec<Kept>,
    /// The bytes of the payloads that would move, to know that there is room (К9).
    pub bytes: u64,
}

/// Why an entry stays in `.amby/trash/` (К7). The codes are written in the log and the outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeptReason {
    /// The original path is inside `.amby/`: a service entry (closed conflict set).
    Service,
    /// A description without the content.
    NoPayload,
    /// A damaged description.
    BrokenManifest,
    /// An original path that leads out of the vault or is not a plain relative path.
    UnsafePath,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kept {
    /// The trash id of the entry (the name of its folder and of `<id>.json`).
    pub id: String,
    pub reason: KeptReason,
}

/// The recorded result (К9): how many moved, which stayed and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub migrated: usize,
    pub kept: Vec<Kept>,
}

/// A place of the run where a crash may be simulated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Point {
    /// The journal with the whole plan is written, nothing has moved.
    JournalWritten,
    /// Before the content of the entry is renamed into the archive.
    BeforeMove(String),
    /// The content is in the archive, its record is not written.
    AfterMove(String),
    /// The record of the archive is written, the entry is not marked done in the journal.
    AfterRecord(String),
    /// Every entry is done, the marker of completion is not written.
    BeforeMarker,
}

/// Tests stop the run "as by a crash" at a [`Point`]: the run returns
/// [`RunError::Interrupted`] at once and does no clean-up of its own.
pub trait Interrupt {
    /// `true` stops the run here.
    fn at(&mut self, point: &Point) -> bool;
}

/// Never stops.
pub struct NoInterrupt;

impl Interrupt for NoInterrupt {
    fn at(&mut self, _point: &Point) -> bool {
        false
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RunError {
    Interrupted,
    Failed(String),
}

/// What a rollback did (К9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RollbackReport {
    /// Entries put back into `.amby/trash/` by the reverse renames.
    pub reverted: usize,
    /// Entries whose file is no longer where the migration put it (restored or moved since): left
    /// alone and reported.
    pub skipped: Vec<String>,
}

/// Looks, writes nothing (К9, К7).
///
/// Requirements: К7, К9.
pub fn preflight(vault: &Path) -> Result<Preflight, String> {
    todo!("К7, К9")
}

/// Runs the migration, or resumes an interrupted one from the step it stopped at, or does nothing
/// when it is completed (К9). Moves each movable entry of `.amby/trash/` into
/// `.amby/archive/<original path>` by renaming (a free name when taken, К7) with the record of К8
/// (`archivedAtMs` = the old `deletedAtMs`), one entry at a time, noting each step in the journal.
/// Entries that cannot move stay and are written to the outcome with a code (К7). Nothing is
/// deleted.
///
/// Requirements: К7, К9, К10.
pub fn run(vault: &Path, interrupt: &mut dyn Interrupt) -> Result<Outcome, RunError> {
    todo!("К7, К9")
}

/// Has the migration finished on this vault (the marker of К9)?
///
/// Requirement: К9.
pub fn is_completed(vault: &Path) -> bool {
    todo!("К9")
}

/// The outcome recorded by a finished run (К9).
///
/// Requirement: К9.
pub fn recorded_outcome(vault: &Path) -> Option<Outcome> {
    todo!("К9")
}

/// Puts every migrated entry back by reverse renames in the order of the journal (К9). The
/// migration is then not completed.
///
/// Requirement: К9.
pub fn rollback(vault: &Path) -> Result<RollbackReport, String> {
    todo!("К9")
}

#[cfg(test)]
#[path = "archive_migration_tests.rs"]
mod tests;
