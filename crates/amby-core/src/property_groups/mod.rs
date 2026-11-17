//! Note properties as the header plus a template plus 16 files of differences (docs/sync-plan.md,
//! appendix З, with the revision of З.11).
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
#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

mod edits;
mod files;
mod header;
mod identity;
pub mod legacy;
mod lifecycle;
pub mod migration;
mod panel;

#[cfg(test)]
pub(crate) mod testkit;
#[cfg(test)]
mod tests_dormant;
#[cfg(test)]
mod tests_edits;
#[cfg(test)]
mod tests_fields;
#[cfg(test)]
mod tests_format;
#[cfg(test)]
mod tests_icons;
#[cfg(test)]
mod tests_identity;
#[cfg(test)]
mod tests_last_edit;
#[cfg(test)]
mod tests_legacy;
#[cfg(test)]
mod tests_lists;
#[cfg(test)]
mod tests_matching;
#[cfg(test)]
mod tests_migration;
#[cfg(test)]
mod tests_options;
#[cfg(test)]
mod tests_polish;
#[cfg(test)]
mod tests_scale;
#[cfg(test)]
mod tests_take;
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
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

// ----- the panel of a note (З1, З3, З3а, З23, З25, З45, З46) -----

/// A key of the header with its value and the look it gets (З46).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveProperty {
    /// The name: the key as the panel calls the property.
    pub name: String,
    /// The key as written in the header.
    pub key: String,
    pub value: String,
    /// The items when the value is a list (YAML), as they are, never glued (З62); empty otherwise.
    pub items: Vec<String>,
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

// ----- identity and the inspection (З10–З12, З34, З35, З51) -----

/// An offer to rebind (З11, З35).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebindOffer {
    pub old_id: String,
    pub new_id: String,
    pub path: String,
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

pub use edits::*;
pub use files::*;
pub use header::look_for_view;
#[allow(unused_imports)]
pub use header::match_key;
pub use identity::*;
pub use lifecycle::*;
pub use panel::*;
