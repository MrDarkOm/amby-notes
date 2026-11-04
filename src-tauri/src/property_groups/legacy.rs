//! Carrying the edits of an old version over (З22, З36). Interfaces only.
#![allow(dead_code, unused_variables)]

use std::path::Path;

use rusqlite::Connection;

/// A note changed both here and by the old version (З22, З.7-3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyConflict {
    pub note_id: String,
}

/// Which side the owner keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyChoice {
    /// «оставить здешнее»
    KeepHere,
    /// «взять из старой версии»
    TakeOld,
}

/// What a check found.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LegacyReport {
    /// Notes carried over by themselves.
    pub transferred: Vec<String>,
    /// Notes changed here and there.
    pub conflicts: Vec<LegacyConflict>,
}

impl LegacyReport {
    /// «Свойства, изменённые старой версией Amby на другом устройстве, перенесены: N заметок»
    /// (З22); empty when nothing was carried over.
    pub fn hint_text(&self) -> Option<String> {
        todo!("З22")
    }
}

/// Did `properties.json` change since this device last looked (hash kept locally in
/// `.amby/migrations/`)? Drives the warning on the sync screen (З22).
pub fn properties_json_changed(vault: &Path) -> Result<bool, String> {
    todo!("З22")
}

/// The check of З36: only when the hash of `properties.json` differs from the remembered one.
/// Per note: the old record equals `entry` of the mark — nothing; else the current list equals
/// `record` — carry the old list over (without values); else a conflict. No mark and an old
/// record: no entry — carry over, an entry — a conflict. Marks are refreshed. Values are never
/// carried (З36).
pub fn check_old_version_edits(conn: &Connection, vault: &Path) -> Result<LegacyReport, String> {
    todo!("З22, З36")
}

/// Settles a conflict of a note by the owner's choice; the mark is refreshed either way.
pub fn resolve_conflict(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    choice: LegacyChoice,
) -> Result<(), String> {
    todo!("З22, З36")
}

/// The warning on the sync screen while an old version still writes `properties.json` (З22,
/// З37): `Some` with [`super::OLD_VERSION_WARNING`] when the file changed since this device last
/// looked, otherwise `None`.
pub fn sync_screen_warning(vault: &Path) -> Result<Option<String>, String> {
    todo!("З22, З37")
}
