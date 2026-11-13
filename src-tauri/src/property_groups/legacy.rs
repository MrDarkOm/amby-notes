//! Carrying the edits of an old version over (appendix З: З22, З36, З37, З53), and the reading of
//! the old `properties.json`, which only the migration and this check ever read.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use amby_sync_core::engine::props_groups::{canonical_json, name_key, GroupKind};
use rusqlite::Connection;
use serde_json::{Map, Value};

use super::files::{blake3_hex, classify, put_mark, read_entry, storage_mode, update_entry};
use super::header::{open_note, same_name, set_look, Look};
use super::{Diff, LegacyMark, NoteEntry, StorageMode, OLD_VERSION_WARNING};

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
        let count = self.transferred.len();
        if count == 0 {
            return None;
        }
        let word = match (count % 100, count % 10) {
            (11..=14, _) => "заметок",
            (_, 1) => "заметка",
            (_, 2..=4) => "заметки",
            _ => "заметок",
        };
        Some(format!(
            "Свойства, изменённые старой версией Amby на другом устройстве, перенесены: {count} {word}"
        ))
    }
}

// ----- the old file -----

/// The properties of a note in `properties.json`: the objects as they are written.
pub(super) type OldProps = Vec<Map<String, Value>>;

/// `properties.json` of the first format, read as it is.
pub(super) struct OldFile {
    pub bytes: Vec<u8>,
    pub notes: BTreeMap<String, OldProps>,
}

pub(super) fn old_file_path(vault: &Path) -> PathBuf {
    vault.join(".amby").join("properties.json")
}

/// Reads `.amby/properties.json`. `None` when there is none; an error when it cannot be read or
/// is of another version (З41).
pub(super) fn read_old_file(vault: &Path) -> Result<Option<OldFile>, String> {
    let bytes = match fs::read(old_file_path(vault)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("properties.json: {error}"))?;
    let Value::Object(root) = value else {
        return Err("properties.json is not an object".to_string());
    };
    if root.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported properties format version".to_string());
    }
    let mut notes = BTreeMap::new();
    if let Some(Value::Object(map)) = root.get("notes") {
        for (id, list) in map {
            let Value::Array(items) = list else {
                return Err(format!("properties.json: the note {id} is not a list"));
            };
            let mut props = Vec::new();
            for item in items {
                let Value::Object(object) = item else {
                    return Err(format!(
                        "properties.json: a property of {id} is not an object"
                    ));
                };
                props.push(object.clone());
            }
            notes.insert(id.clone(), props);
        }
    }
    Ok(Some(OldFile { bytes, notes }))
}

const NO_RECORD: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// BLAKE3 of the old record of a note without `value` (З36, З53); 32 zeros when there is none.
pub(super) fn old_entry_hash(list: Option<&OldProps>) -> String {
    let Some(list) = list else {
        return NO_RECORD.to_string();
    };
    let stripped: Vec<Value> = list
        .iter()
        .map(|object| {
            let mut object = object.clone();
            object.remove("value");
            Value::Object(object)
        })
        .collect();
    blake3_hex(canonical_json(&Value::Array(stripped)).as_bytes())
}

/// BLAKE3 of the canonical line of a note without `hint`, `dismissedRenames` and `edited` (З70);
/// 32 zeros when there is no line (З53).
pub(super) fn record_hash(entry: Option<&NoteEntry>) -> String {
    let Some(entry) = entry else {
        return NO_RECORD.to_string();
    };
    let mut stripped = entry.clone();
    stripped.hint = None;
    stripped.dismissed_renames.clear();
    stripped.extra.remove("edited");
    blake3_hex(super::files::canonical_line(&stripped).as_bytes())
}

fn text_field(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// The record of a note made of its old list: only the differences from the template, in the
/// language of the name that matched; the order only when it differs from the header's (З54).
/// `header_names` are the keys of the header in its order, as they will be; `None` when the header
/// cannot be read.
pub(super) fn entry_from_old(
    note_id: &str,
    list: &OldProps,
    header_names: Option<&[String]>,
) -> Option<NoteEntry> {
    let mut props: BTreeMap<String, Diff> = BTreeMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    for object in list {
        let name = text_field(object, "name").trim().to_string();
        if name.is_empty() || !seen.insert(name_key(&name)) {
            continue;
        }
        let property_type = match text_field(object, "propertyType") {
            ty if ty.is_empty() => "text".to_string(),
            ty => ty,
        };
        let look = Look {
            property_type,
            icon: text_field(object, "icon"),
            settings: text_field(object, "settings"),
            from_template: false,
        };
        let mut diff = Diff::default();
        set_look(&mut diff, &name, &look);
        if diff.icon.is_some() || diff.property_type.is_some() || diff.settings.is_some() {
            props.insert(name.clone(), diff);
        }
        names.push(name);
    }
    let order = match header_names {
        Some(header) => {
            let present = |name: &str| header.iter().any(|key| same_name(key, name));
            let listed: Vec<String> = names
                .iter()
                .filter(|n| present(n) || props.keys().any(|k| same_name(k, n)))
                .cloned()
                .collect();
            let effective: Vec<&String> = listed
                .iter()
                .filter(|n| present(n))
                .chain(
                    header
                        .iter()
                        .filter(|key| !listed.iter().any(|n| same_name(n, key))),
                )
                .collect();
            let differs = effective.len() != header.len()
                || effective
                    .iter()
                    .zip(header.iter())
                    .any(|(a, b)| !same_name(a, b));
            if differs {
                listed
            } else {
                Vec::new()
            }
        }
        None if names.len() > 1 => names,
        None => Vec::new(),
    };
    let entry = NoteEntry {
        id: note_id.to_string(),
        props,
        order,
        ..NoteEntry::default()
    };
    (!entry.is_empty()).then_some(entry)
}

/// The names of the keys of the header of a note as the panel sees them; `None` when the header
/// cannot be read.
pub(super) fn header_names_of(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Option<Vec<String>> {
    let access = open_note(conn, vault, note_id).ok()?;
    Some(
        access
            .keys
            .iter()
            .filter(|k| !super::header::is_reserved(&k.key))
            .map(|k| k.key.clone())
            .collect(),
    )
}

// ----- the memo of this device -----

fn memo_path(vault: &Path) -> PathBuf {
    vault
        .join(".amby")
        .join("migrations")
        .join("properties")
        .join("legacy-state.json")
}

/// Remembers the hash of `properties.json` this device has looked at (local, З36).
pub(super) fn remember_old_file(vault: &Path, bytes: &[u8]) -> Result<(), String> {
    let path = memo_path(vault);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = format!("{{\"propertiesHash\":\"{}\"}}\n", blake3_hex(bytes));
    fs::write(&path, body).map_err(|error| error.to_string())
}

/// Forgets the memo (the migration was taken back).
pub(super) fn forget_old_file(vault: &Path) {
    let _ = fs::remove_file(memo_path(vault));
}

fn remembered_hash(vault: &Path) -> Option<String> {
    let value: Value = serde_json::from_slice(&fs::read(memo_path(vault)).ok()?).ok()?;
    value.get("propertiesHash")?.as_str().map(str::to_string)
}

/// Did `properties.json` change since this device last looked (hash kept locally in
/// `.amby/migrations/`)? Drives the warning on the sync screen (З22).
pub fn properties_json_changed(vault: &Path) -> Result<bool, String> {
    let bytes = match fs::read(old_file_path(vault)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    Ok(remembered_hash(vault).as_deref() != Some(blake3_hex(&bytes).as_str()))
}

// ----- the check (З36, З53) -----

fn all_marks(vault: &Path) -> Result<BTreeMap<String, LegacyMark>, String> {
    let mut marks = BTreeMap::new();
    for digit in "0123456789abcdef".chars() {
        let path = super::files::properties_dir(vault).join(format!("legacy_{digit}.jsonl"));
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let classified = classify(GroupKind::Legacy, &bytes)?;
        for info in &classified.lines {
            if let Some(map) = &info.value {
                if let Ok(mark) = serde_json::from_value::<LegacyMark>(Value::Object(map.clone())) {
                    marks.insert(mark.id.clone(), mark);
                }
            }
        }
    }
    Ok(marks)
}

/// Makes the record of a note out of the old list and writes it; `dismissedRenames` stay.
fn carry(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    old: Option<&OldProps>,
) -> Result<Option<NoteEntry>, String> {
    let names = header_names_of(conn, vault, note_id);
    let fresh = old.and_then(|list| entry_from_old(note_id, list, names.as_deref()));
    let (_, written) = update_entry(conn, vault, note_id, |current| {
        let dismissed = current.map(|c| c.dismissed_renames).unwrap_or_default();
        Ok(match fresh {
            Some(mut entry) => {
                entry.dismissed_renames = dismissed;
                Some(entry)
            }
            None if dismissed.is_empty() => None,
            None => Some(NoteEntry {
                id: note_id.to_string(),
                dismissed_renames: dismissed,
                ..NoteEntry::default()
            }),
        })
    })?;
    Ok(written)
}

/// The check of З36 and З53: only when the hash of `properties.json` differs from the remembered
/// one. Per note: the old record equals `entry` of the mark in `legacy_<x>.jsonl` — nothing; else
/// the current line (without `hint` and `dismissedRenames`) hashes to `record` — carry the old
/// record over as differences from the template (without values); else a conflict. No mark and an
/// old record: no line — carry over, a line — a conflict. Marks are refreshed. Values are never
/// carried (З36).
pub fn check_old_version_edits(conn: &Connection, vault: &Path) -> Result<LegacyReport, String> {
    let mut report = LegacyReport::default();
    if storage_mode(vault)? != StorageMode::Groups || !properties_json_changed(vault)? {
        return Ok(report);
    }
    let Some(old) = read_old_file(vault)? else {
        return Ok(report);
    };
    let marks = all_marks(vault)?;
    let ids: BTreeSet<&String> = old.notes.keys().chain(marks.keys()).collect();
    for id in ids {
        let list = old.notes.get(id);
        let old_hash = old_entry_hash(list);
        let current = read_entry(vault, id)?;
        let move_over = match marks.get(id) {
            Some(mark) if mark.entry == old_hash => continue,
            Some(mark) => record_hash(current.as_ref()) == mark.record,
            None if list.is_none() => continue,
            None => current.is_none(),
        };
        if !move_over {
            report.conflicts.push(LegacyConflict {
                note_id: id.clone(),
            });
            continue;
        }
        let written = carry(conn, vault, id, list)?;
        put_mark(
            vault,
            id,
            Some(LegacyMark {
                id: id.clone(),
                entry: old_hash,
                record: record_hash(written.as_ref()),
            }),
        )?;
        report.transferred.push(id.clone());
    }
    if report.conflicts.is_empty() {
        remember_old_file(vault, &old.bytes)?;
    }
    for id in &report.transferred {
        let _ = super::panel::refresh_cache(conn, vault, id);
    }
    Ok(report)
}

/// Settles a conflict of a note by the owner's choice; the mark is refreshed either way.
pub fn resolve_conflict(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    choice: LegacyChoice,
) -> Result<(), String> {
    let old = read_old_file(vault)?;
    let list = old.as_ref().and_then(|file| file.notes.get(note_id));
    let old_hash = old_entry_hash(list);
    let current = match choice {
        LegacyChoice::TakeOld => carry(conn, vault, note_id, list)?,
        LegacyChoice::KeepHere => read_entry(vault, note_id)?,
    };
    put_mark(
        vault,
        note_id,
        Some(LegacyMark {
            id: note_id.to_string(),
            entry: old_hash,
            record: record_hash(current.as_ref()),
        }),
    )?;
    let _ = super::panel::refresh_cache(conn, vault, note_id);
    Ok(())
}

/// The warning on the sync screen while an old version still writes `properties.json` (З22,
/// З37): `Some` with [`super::OLD_VERSION_WARNING`] when the file changed since this device last
/// looked, otherwise `None`.
pub fn sync_screen_warning(vault: &Path) -> Result<Option<String>, String> {
    Ok(properties_json_changed(vault)?.then(|| OLD_VERSION_WARNING.to_string()))
}
