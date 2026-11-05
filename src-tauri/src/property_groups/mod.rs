//! Note properties as the header plus a template plus 16 files of differences (docs/sync-plan.md,
//! appendix З, with the revision of З.11). Interfaces only (раздел 6, шаг 1): every body is
//! `todo!()` until the tests of this folder are reviewed.
//!
//! The value of a property lives only in the YAML header of the note (З1). The type, the icon and
//! the options come from the template in the code ([`crate::property_template`], З45); a note's
//! record keeps only the differences from it, by the name of the property, and the order only
//! after the user moved something (З47). The records are the lines of 16 files
//! `.amby/properties/prop_<x>.jsonl` (З48); the marks of old versions are in
//! `legacy_<x>.jsonl` (З53). This module replaces [`crate::property_store`] once the owner
//! confirms the migration (З38); until then the old store works and no group exists.
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
#[cfg(test)]
mod tests_template;

/// The sentence of the warning on the sync screen and in the report of the migration (З37, З.10-2).
pub const OLD_VERSION_WARNING: &str = "На устройствах со старой версией Amby не меняйте свойства — она может вернуть прежние значения";

// ----- the files (З2, З47–З49, З53) -----

/// `.amby/properties/layout.json` (З48).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Layout {
    pub version: u32,
    pub groups: u32,
    pub hash: String,
    /// The number of the template the files were written under (З54).
    pub template: u32,
}

/// The hint of a record: the path, for a human and for rebinding, **not a key** (З47).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hint {
    pub path: String,
}

/// What a note changes in one property against the template (З47): only the fields that differ.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<String>,
    /// Set only between the steps of a rename (З9, З55).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
    /// Fields of a newer Amby are kept (З2).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The line of one note in a `prop_<x>.jsonl` (З47).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<Hint>,
    /// Name of the property → differences. Names are unique after NFC without ASCII case.
    #[serde(default)]
    pub props: BTreeMap<String, Diff>,
    /// Only after the user moved something: names (З47).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<String>,
    /// Pairs «old name, new name» that the owner refused to rename (З3а, З44).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dismissed_renames: Vec<[String; 2]>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The mark of a note that came from `properties.json` of the first format: a line of
/// `legacy_<x>.jsonl` (З53).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyMark {
    pub id: String,
    /// BLAKE3 of the canonical record of the note in `properties.json`, without `value`.
    pub entry: String,
    /// BLAKE3 of the canonical line of the note (З49) without `hint` and `dismissedRenames`, or
    /// 32 zeros when there is no line.
    pub record: String,
}

/// What a file of a group holds: the first line (with unknown fields) and the lines (З48).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupFile {
    pub header: Map<String, Value>,
    pub entries: Vec<NoteEntry>,
}

/// A line that cannot be used (З51).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadLine {
    /// The file, relative to the vault.
    pub file: String,
    /// 1-based line number.
    pub number: usize,
    /// The `id` of the note, when the line still tells it.
    pub note_id: Option<String>,
}

/// Where the properties of a vault live (З6, З38).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageMode {
    /// No `layout.json`: the old `properties.json` works, there are no groups (З38).
    Legacy,
    /// `layout.json` of version 1 with 16 groups: this module works.
    Groups,
    /// Another number of groups or a newer version: read only, nothing is written (З48).
    Newer,
}

/// Which storage the vault is in (З6, З38, З48).
pub fn storage_mode(vault: &Path) -> Result<StorageMode, String> {
    todo!("З6, З38, З48")
}

/// `.amby/properties/layout.json` (З48).
pub fn layout_path(vault: &Path) -> PathBuf {
    todo!("З48")
}

/// `.amby/properties/prop_<x>.jsonl` of a note (З48).
pub fn group_path(vault: &Path, note_id: &str) -> PathBuf {
    todo!("З48")
}

/// `.amby/properties/legacy_<x>.jsonl` of a note (З53).
pub fn legacy_path(vault: &Path, note_id: &str) -> PathBuf {
    todo!("З53")
}

/// Reads the file of a note's group. A missing file is an empty one. A line that cannot be used
/// is reported in the second part, the other lines are given (З51); an unreadable first line is
/// an error and the file is never overwritten.
pub fn read_group(vault: &Path, note_id: &str) -> Result<(GroupFile, Vec<BadLine>), String> {
    todo!("З2, З48, З51")
}

/// The line of a note, if the group has it.
pub fn read_entry(vault: &Path, note_id: &str) -> Result<Option<NoteEntry>, String> {
    todo!("З47")
}

/// The mark of a note in `legacy_<x>.jsonl`, if there is one (З53).
pub fn read_mark(vault: &Path, note_id: &str) -> Result<Option<LegacyMark>, String> {
    todo!("З53")
}

/// The canonical text of one line, without the line feed (З49): compact JSON, keys ascending byte
/// by byte.
pub fn canonical_line(entry: &NoteEntry) -> String {
    todo!("З49")
}

/// Writes the line of a note (`None` removes it): replaces, inserts (keeping the lines sorted by
/// `id`) or deletes **only that line**; every other line is copied byte for byte (З50). A record
/// with no `props`, `order` and `dismissedRenames` is not kept, and a file without lines has no
/// file (З4, З47). Refuses when the layout is newer (З48) or when the file has a bad line
/// (З51). Nothing is written when nothing changes (З8). `hint` is refreshed only here.
pub fn put_entry(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    entry: Option<NoteEntry>,
) -> Result<(), String> {
    todo!("З4, З8, З47, З48, З50, З51")
}

/// Writes or removes the mark of a note in `legacy_<x>.jsonl` by the same rules (З53).
pub fn put_mark(vault: &Path, note_id: &str, mark: Option<LegacyMark>) -> Result<(), String> {
    todo!("З53")
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

// ----- the panel of a note (З1, З3, З3а, З23, З25, З45, З46) -----

/// A key of the header with its value and the look it gets (З46).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveProperty {
    /// The name: the key as the panel calls the property.
    pub name: String,
    /// The key as written in the header.
    pub key: String,
    pub value: String,
    /// Template + differences (З46).
    pub property_type: String,
    pub icon: String,
    pub settings: String,
    /// The name is in the template (З45).
    pub from_template: bool,
    /// The note's record has differences for it (З47).
    pub has_record: bool,
    /// Shown for reading only («правьте в исходном тексте», З26).
    pub read_only: bool,
    /// The value does not fit the type («не подходит к типу», З26).
    pub type_mismatch: bool,
    /// A select whose value is not among the options: shown as it is with a mark (З45).
    pub outside_options: bool,
}

/// A record property without a key: grey, «нет в шапке» (З3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DormantProperty {
    pub name: String,
    pub diff: Diff,
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
    /// The layout is newer than this Amby: read only (З48).
    FormatNewer,
    /// The file of the group has a bad line: the properties of its notes are read only (З51).
    BadLineInGroup,
}

/// What the panel of a note shows.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Panel {
    /// The header or the identity cannot be used: no sleeping records, no hints, no edits (З25).
    pub unreadable: bool,
    /// Every key of the header (except the keys of Amby), in the order of З47.
    pub active: Vec<ActiveProperty>,
    /// Records without a key: below the active ones (З3).
    pub dormant: Vec<DormantProperty>,
    pub rename_hint: Option<RenameHint>,
    pub warnings: Vec<PanelWarning>,
    /// The whole panel is for reading only: the vault is not migrated yet or cannot be (З57, З59).
    pub read_only: bool,
}

/// The panel of a note. Reads only: never writes (З8).
pub fn panel(conn: &Connection, vault: &Path, note_id: &str) -> Result<Panel, String> {
    todo!("З1, З3, З3а, З23, З25, З26, З44, З45, З46, З47, З51")
}

/// Rebuilds the SQLite table `note_custom_properties` from the files, the template and the
/// headers; `value` is the one of the header. Migrates and deletes nothing (З23).
pub fn rebuild_cache(conn: &Connection, vault: &Path) -> Result<(), String> {
    todo!("З23")
}

// ----- edits (З9, З24–З29, З55) -----

/// The look a user gives a property: the whole of it. The record keeps only what differs from
/// the template (or from plain text for a name that is not in it) (З47).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Design {
    pub name: String,
    pub icon: String,
    pub property_type: String,
    pub settings: String,
}

/// A new property: the key goes into the header first, then the record, if any (З28).
pub fn create_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    design: Design,
    value: &str,
) -> Result<(), String> {
    todo!("З9, З24, З28, З47")
}

/// Renames a property: the record with `previousName`, the header, then `previousName` removed.
/// A property with no record and not from the template changes only the key of the header, the
/// line is written for the time of the operation only (З9, З28, З55).
pub fn rename_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    new_name: &str,
) -> Result<(), String> {
    todo!("З9, З24, З26, З28, З55")
}

/// Writes the value into the found spelling of the key (З1, З24, З26).
pub fn set_value(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    value: &str,
) -> Result<(), String> {
    todo!("З1, З24, З26")
}

/// Changes the type: the record first, then the value when it is rewritten and the conversion is
/// reversible (З26, З28).
pub fn change_type(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    property_type: &str,
) -> Result<(), String> {
    todo!("З26, З28")
}

/// Only the look: icon and settings. One line of one file, the note is not touched (З9, З47).
pub fn set_appearance(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    icon: &str,
    settings: &str,
) -> Result<(), String> {
    todo!("З9, З47")
}

/// The order of the panel: names. Written to `order` only when it differs from the order of the
/// header (З47).
pub fn reorder(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    names: &[String],
) -> Result<(), String> {
    todo!("З47")
}

/// Deletes a property: the key goes from the header first, then the record (З28).
pub fn delete_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
) -> Result<(), String> {
    todo!("З28")
}

/// «Вернуть»: the key is added to the header with an empty value (З3).
pub fn restore_dormant(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
) -> Result<(), String> {
    todo!("З3")
}

/// «Удалить окончательно»: a copy in `property-backups/<note-id>/<ULID>.json` first, then the
/// record of the property leaves the line (З3, З34).
pub fn purge_dormant(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
) -> Result<(), String> {
    todo!("З3, З34")
}

/// «Перенести»: the record is renamed in the line; the header is not touched (З3а).
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

/// A copy in `property-backups/` (as now), then the line leaves the file; returns the relative
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
/// `.amby/property-ops/` (З28, З29). Never walks the files; a line that came by sync with a
/// `previousName` is only read.
pub fn recover_operations(conn: &Connection, vault: &Path) -> Result<RecoverReport, String> {
    todo!("З28, З29")
}

// ----- identity and the inspection (З10–З12, З34, З35, З51) -----

/// An offer to rebind (З11, З35).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebindOffer {
    pub old_id: String,
    pub new_id: String,
    pub path: String,
}

/// Lines whose note got another `amby-id` at the same path while the old id is nowhere else, and
/// whose new id has no line or an equal one (without `hint`) (З11, З35).
pub fn rebind_offers(conn: &Connection, vault: &Path) -> Result<Vec<RebindOffer>, String> {
    todo!("З11, З35")
}

/// On consent: the whole line moves to the group of the new id (possibly the same file); a copy
/// of the old one goes to `property-backups/`, then the old line is removed. A repeat after a
/// crash finishes it (З35, З55).
pub fn rebind(conn: &Connection, vault: &Path, old_id: &str, new_id: &str) -> Result<(), String> {
    todo!("З11, З35, З55")
}

/// The inspection of the properties of a vault (З10).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inspection {
    /// Sleeping records: `(note id, property name)` (З3).
    pub dormant: Vec<(String, String)>,
    /// Lines without a note (З11, З34).
    pub orphans: Vec<String>,
    /// Ambiguous keys: `(note id, property name)` (З1).
    pub ambiguous: Vec<(String, String)>,
    /// Names that start with `amby-` (З24).
    pub reserved_names: Vec<(String, String)>,
    /// Notes with an operation that could not be finished (З29).
    pub unfinished_operations: Vec<String>,
    /// Lines that cannot be used: the file and the number (З51).
    pub bad_lines: Vec<BadLine>,
}

/// Walks the files: the only full walk besides the rebuild and the migration (З56). Reads only.
pub fn inspect(conn: &Connection, vault: &Path) -> Result<Inspection, String> {
    todo!("З10, З51")
}

/// «Удалить» an orphan line from the inspection: a copy in `property-backups/` first (З34).
pub fn delete_orphan(conn: &Connection, vault: &Path, note_id: &str) -> Result<(), String> {
    todo!("З10, З34")
}

/// Journal folder, local, not synchronised (З28).
pub fn ops_dir(vault: &Path) -> PathBuf {
    todo!("З28")
}

/// Unused alias keeping `BTreeSet` imported for the migration module.
pub type NoteSet = BTreeSet<String>;
