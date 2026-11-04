//! Note properties as the header plus groups (docs/sync-plan.md, appendix З). Interfaces only
//! (раздел 6, шаг 1): every body is `todo!()` until the tests of this folder are reviewed.
//!
//! The value of a property lives only in the YAML header of the note (З1). The type, the icon, the
//! settings and the order live in 256 files `.amby/properties/<g>.json`, one record per note
//! (З2, З5, З7). This module replaces [`crate::property_store`] once the owner confirms the
//! migration (З38); until then the old store works and no group exists.
//!
//! Every function names the requirements it fulfils (`З…`).
#![allow(dead_code, unused_variables)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub mod legacy;
pub mod migration;

#[cfg(test)]
mod testkit;
#[cfg(test)]
mod tests_dormant;
#[cfg(test)]
mod tests_edits;
#[cfg(test)]
mod tests_format;
#[cfg(test)]
mod tests_identity;
#[cfg(test)]
mod tests_legacy;
#[cfg(test)]
mod tests_matching;
#[cfg(test)]
mod tests_migration;
#[cfg(test)]
mod tests_scale;

/// The sentence of the warning on the sync screen and in the report of the migration (З37, З.10-2).
pub const OLD_VERSION_WARNING: &str = "На устройствах со старой версией Amby не меняйте свойства — она может вернуть прежние значения";

// ----- the files (З2, З5–З8) -----

/// `.amby/properties/layout.json` (З6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Layout {
    pub version: u32,
    pub groups: u32,
    pub hash: String,
}

/// The hint of a record: for a human and for rebinding, **not a key** (З7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hint {
    pub path: String,
    pub title: String,
}

/// The design of one property of a note (З2): no value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Design {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub property_type: String,
    pub settings: String,
    /// Set only between the steps of a rename (З9).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
    /// Fields of a newer Amby are kept (З2).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The mark of a record that came from `properties.json` of the first format (З36).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyMark {
    /// BLAKE3 of the canonical record of the note in `properties.json`, without `value`.
    pub entry: String,
    /// BLAKE3 of the list `properties` right after the transfer.
    pub record: String,
}

/// The record of one note in a group (З7).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<Hint>,
    #[serde(default)]
    pub properties: Vec<Design>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy: Option<LegacyMark>,
    /// Pairs «old name, new name» that the owner refused to rename (З3а, З44).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dismissed_renames: Vec<[String; 2]>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A group file (З7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupFile {
    pub version: u32,
    pub notes: BTreeMap<String, NoteEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Where the properties of a vault live (З6, З38).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageMode {
    /// No `layout.json`: the old `properties.json` works, there are no groups (З38).
    Legacy,
    /// `layout.json` of version 1 with 256 groups: this module works.
    Groups,
    /// Another number of groups or a newer version: read only, nothing is written (З6).
    Newer,
}

/// Which storage the vault is in (З6, З38).
pub fn storage_mode(vault: &Path) -> Result<StorageMode, String> {
    todo!("З6, З38")
}

/// `.amby/properties/layout.json` (З6).
pub fn layout_path(vault: &Path) -> PathBuf {
    todo!("З6")
}

/// `.amby/properties/<g>.json` of a note (З5).
pub fn group_path(vault: &Path, note_id: &str) -> PathBuf {
    todo!("З5")
}

/// Reads the group of a note. A missing file is an empty group; an unreadable one is an error and
/// is never overwritten (З6, З8).
pub fn read_group(vault: &Path, note_id: &str) -> Result<GroupFile, String> {
    todo!("З2, З6")
}

/// The record of a note, if the group has it.
pub fn read_entry(vault: &Path, note_id: &str) -> Result<Option<NoteEntry>, String> {
    todo!("З2")
}

/// The canonical bytes of a group (З8): keys of `notes` ascending, fields in the order of the
/// structure, two-space indent, one line feed at the end.
pub fn canonical_group_bytes(group: &GroupFile) -> Vec<u8> {
    todo!("З8")
}

/// Writes the record of a note (`None` removes it): one group, canonical form, BOM and line
/// endings of the old file kept, nothing written when nothing changes. An empty record is not
/// kept, and a group without records has no file, except a record with a `legacy` mark (З4, З36).
/// Refuses under a newer layout (З6). `hint` is refreshed only here (З7).
pub fn put_entry(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    entry: Option<NoteEntry>,
) -> Result<(), String> {
    todo!("З4, З6, З7, З8, З36")
}

// ----- matching a property to a key of the header (З1, З24–З27) -----

/// The answer of [`match_key`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyMatch {
    /// One key: its spelling in the header, the value as text, and whether the value cannot be
    /// rewritten without loss (multiline, anchor, block string: З26).
    Found {
        key: String,
        value: String,
        complex: bool,
    },
    /// No such key (the property is dormant, З3).
    Missing,
    /// Several keys equal apart from the ASCII case: shown empty with a warning, nothing is
    /// written (З1).
    Ambiguous { keys: Vec<String> },
    /// The header cannot be read or changed without loss (З25).
    HeaderUnreadable,
}

/// Looks for the key of the property `name` in the header of `note_text` (З1): exact (after NFC),
/// then the only match ignoring ASCII case. Only keys that YAML reads as strings; `amby-*` keys
/// never (З24). `previous_name` is tried only when `name` is absent (З29).
pub fn match_key(note_text: &str, name: &str, previous_name: Option<&str>) -> KeyMatch {
    todo!("З1, З24, З25, З26, З29")
}

// ----- the panel of a note (З1, З3, З3а, З23, З25) -----

/// A property with a design and a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveProperty {
    pub design: Design,
    /// The key as written in the header.
    pub key: String,
    pub value: String,
    /// Shown for reading only («правьте в исходном тексте», З26).
    pub read_only: bool,
    /// The value does not fit the type («не подходит к типу», З26).
    pub type_mismatch: bool,
}

/// «Похоже, «Статус» переименовали в «Состояние». Перенести на него тип и иконку?» (З3а).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameHint {
    pub old_name: String,
    pub new_name: String,
}

/// Warnings of the panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PanelWarning {
    /// Several keys match a name (З1).
    AmbiguousKey { name: String },
    /// The layout is newer than this Amby: read only (З6).
    FormatNewer,
}

/// What the panel of a note shows.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Panel {
    /// The header or the identity cannot be used: no sleeping records, no hints, no edits (З25).
    pub unreadable: bool,
    /// In the order of the group (З2).
    pub active: Vec<ActiveProperty>,
    /// Records without a key: below the active ones, grey, «нет в шапке» (З3).
    pub dormant: Vec<Design>,
    /// Keys of the header without a design: ordinary header lines (З3).
    pub plain: Vec<(String, String)>,
    pub rename_hint: Option<RenameHint>,
    pub warnings: Vec<PanelWarning>,
}

/// The panel of a note. Reads only: never writes (З8).
pub fn panel(conn: &Connection, vault: &Path, note_id: &str) -> Result<Panel, String> {
    todo!("З1, З3, З3а, З23, З25, З26, З44")
}

/// Rebuilds the SQLite table `note_custom_properties` from the groups and the headers; `value` is
/// the one of the header. Migrates and deletes nothing (З23).
pub fn rebuild_cache(conn: &Connection, vault: &Path) -> Result<(), String> {
    todo!("З23")
}

// ----- edits (З9, З24–З29) -----

/// A new property: the key goes into the header first, then the record (З28).
pub fn create_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    design: Design,
    value: &str,
) -> Result<Design, String> {
    todo!("З9, З24, З28")
}

/// Renames a property: group with `previousName`, header, then `previousName` removed (З9, З28).
pub fn rename_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
    new_name: &str,
) -> Result<(), String> {
    todo!("З9, З24, З26, З28")
}

/// Writes the value into the found spelling of the key (З1, З24, З26).
pub fn set_value(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
    value: &str,
) -> Result<(), String> {
    todo!("З1, З24, З26")
}

/// Changes the type: the group first, then the value when it is rewritten and the conversion is
/// reversible (З26, З28).
pub fn change_type(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
    property_type: &str,
) -> Result<(), String> {
    todo!("З26, З28")
}

/// Only the design: icon and settings. One group, the note is not touched (З9).
pub fn set_appearance(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
    icon: &str,
    settings: &str,
) -> Result<(), String> {
    todo!("З9")
}

/// The order of the panel. One group (З2, З9).
pub fn reorder(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_ids: &[String],
) -> Result<(), String> {
    todo!("З2, З9")
}

/// Deletes a property: the key goes from the header first, then the record (З28).
pub fn delete_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
) -> Result<(), String> {
    todo!("З28")
}

/// «Вернуть»: the key is added to the header with an empty value (З3).
pub fn restore_dormant(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
) -> Result<(), String> {
    todo!("З3")
}

/// «Удалить окончательно»: a copy in `property-backups/<note-id>/<ULID>.json` first, then the
/// record leaves the group (З3, З34).
pub fn purge_dormant(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
) -> Result<(), String> {
    todo!("З3, З34")
}

/// «Перенести»: the record is renamed in the group; the header is not touched (З3а).
pub fn accept_rename_hint(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    hint: &RenameHint,
) -> Result<(), String> {
    todo!("З3а")
}

/// «Нет»: the pair goes to `dismissedRenames` of the record (З3а, З44).
pub fn dismiss_rename_hint(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    hint: &RenameHint,
) -> Result<(), String> {
    todo!("З3а, З44")
}

/// A copy in `property-backups/` (as now), then the record leaves the group; returns the relative
/// path of the copy (З27).
pub fn backup_and_clear(conn: &Connection, vault: &Path, note_id: &str) -> Result<String, String> {
    todo!("З27")
}

/// What `recover_operations` did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RecoverReport {
    /// Renames rolled back (`name := previousName`).
    pub rolled_back: Vec<String>,
    /// Renames completed (`previousName` removed).
    pub completed: Vec<String>,
    /// Notes whose header changed in another way: left as they are, shown in the inspection.
    pub left_for_inspection: Vec<String>,
}

/// At the opening of a vault: finishes what **this device** began, by its own journal
/// `.amby/property-ops/` (З28, З29). Never walks the groups; a group that came by sync with a
/// `previousName` is only read.
pub fn recover_operations(conn: &Connection, vault: &Path) -> Result<RecoverReport, String> {
    todo!("З28, З29")
}

// ----- identity and the inspection (З10–З12, З34, З35) -----

/// An offer to rebind (З11, З35).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebindOffer {
    pub old_id: String,
    pub new_id: String,
    pub path: String,
}

/// Records whose note got another `amby-id` at the same path while the old id is nowhere else, and
/// whose new id has no record or an equal one (without `hint`) (З11, З35).
pub fn rebind_offers(conn: &Connection, vault: &Path) -> Result<Vec<RebindOffer>, String> {
    todo!("З11, З35")
}

/// On consent: the new record first, a copy of the old one in `property-backups/`, then the old
/// record is removed. A repeat after a crash finishes it (З35).
pub fn rebind(conn: &Connection, vault: &Path, old_id: &str, new_id: &str) -> Result<(), String> {
    todo!("З11, З35")
}

/// The inspection of the properties of a vault (З10).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inspection {
    /// Sleeping records: `(note id, property name)` (З3).
    pub dormant: Vec<(String, String)>,
    /// Records without a note (З11, З34).
    pub orphans: Vec<String>,
    /// Ambiguous keys: `(note id, property name)` (З1).
    pub ambiguous: Vec<(String, String)>,
    /// Names that start with `amby-` (З24).
    pub reserved_names: Vec<(String, String)>,
    /// Notes with an operation that could not be finished (З29).
    pub unfinished_operations: Vec<String>,
}

/// Walks the groups: the only full walk besides the rebuild and the migration (З43). Reads only.
pub fn inspect(conn: &Connection, vault: &Path) -> Result<Inspection, String> {
    todo!("З10")
}

/// «Удалить» an orphan record from the inspection: a copy in `property-backups/` first (З34).
pub fn delete_orphan(conn: &Connection, vault: &Path, note_id: &str) -> Result<(), String> {
    todo!("З10, З34")
}

/// Journal folder, local, not synchronised (З28).
pub fn ops_dir(vault: &Path) -> PathBuf {
    todo!("З28")
}

/// Unused alias keeping `BTreeSet` imported for the migration module.
pub type NoteSet = BTreeSet<String>;
