//! The 16 files of lines `.amby/properties/prop_<x>.jsonl`, the marks `legacy_<x>.jsonl` and
//! `layout.json` (appendix З: З6, З47–З51, З53). One line is one note; an edit replaces, inserts
//! or removes **only its line**, every other line is copied byte for byte (З50).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::props_groups::{
    canonical_json, group_path_of, legacy_path_of, parse_line, GroupKind, NotMergeable,
};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::{BadLine, GroupFile, LegacyMark, NoteEntry, StorageMode};
use crate::frontmatter;
use crate::property_template::TEMPLATE_VERSION;

/// `.amby/properties/` (З48).
thread_local! {
    /// The clock of the edits in tests (З70); `None` is the computer's clock.
    static EDIT_CLOCK: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Sets the time `update_entry` stamps on a changed line (З70), for tests.
#[cfg(test)]
pub(crate) fn set_edit_clock(ms: Option<u64>) {
    EDIT_CLOCK.with(|clock| clock.set(ms));
}

pub fn properties_dir(vault: &Path) -> PathBuf {
    vault.join(".amby").join("properties")
}

/// `.amby/properties/layout.json` (З48).
pub fn layout_path(vault: &Path) -> PathBuf {
    properties_dir(vault).join("layout.json")
}

/// `.amby/properties/prop_<x>.jsonl` of a note (З48).
pub fn group_path(vault: &Path, note_id: &str) -> PathBuf {
    vault.join(group_path_of(note_id))
}

/// `.amby/properties/legacy_<x>.jsonl` of a note (З53).
pub fn legacy_path(vault: &Path, note_id: &str) -> PathBuf {
    vault.join(legacy_path_of(note_id))
}

/// The text of `layout.json` written by this version (З48).
pub fn layout_text() -> String {
    format!(
        "{{\"groups\":16,\"hash\":\"blake3-first-hex\",\"template\":{TEMPLATE_VERSION},\"version\":1}}\n"
    )
}

/// Lowercase hexadecimal text of bytes.
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// BLAKE3 of bytes as 64 hexadecimal digits.
pub(super) fn blake3_hex(bytes: &[u8]) -> String {
    hex(&blake3_hash(bytes))
}

/// Which storage the vault is in (З6, З38, З48).
pub fn storage_mode(vault: &Path) -> Result<StorageMode, String> {
    let bytes = match fs::read(layout_path(vault)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StorageMode::Legacy)
        }
        Err(error) => return Err(error.to_string()),
    };
    let Ok(Value::Object(layout)) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(StorageMode::Newer);
    };
    let known = layout.get("version").and_then(Value::as_u64) == Some(1)
        && layout.get("groups").and_then(Value::as_u64) == Some(16)
        && layout.get("hash").and_then(Value::as_str) == Some("blake3-first-hex");
    Ok(if known {
        StorageMode::Groups
    } else {
        StorageMode::Newer
    })
}

/// The groups may be written only in the new format (З38, З48).
pub(super) fn require_groups(vault: &Path) -> Result<(), String> {
    match storage_mode(vault)? {
        StorageMode::Groups => Ok(()),
        StorageMode::Legacy => Err("Properties are not migrated to groups yet".to_string()),
        StorageMode::Newer => {
            Err("The format of the properties is newer than this version of Amby".to_string())
        }
    }
}

// ----- the lines of a file -----

/// A file cut into its lines, with the BOM and the line ending it came with.
#[derive(Debug, Clone)]
pub(super) struct RawFile {
    pub bom: bool,
    pub crlf: bool,
    /// Every line without its ending, the first one (the version) included.
    pub lines: Vec<String>,
}

impl RawFile {
    fn new_file() -> Self {
        Self {
            bom: false,
            crlf: false,
            lines: vec!["{\"version\":1}".to_string()],
        }
    }

    pub fn join(&self) -> Vec<u8> {
        let eol = if self.crlf { "\r\n" } else { "\n" };
        let mut out = Vec::new();
        if self.bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        for line in &self.lines {
            out.extend_from_slice(line.as_bytes());
            out.extend_from_slice(eol.as_bytes());
        }
        out
    }
}

fn split_raw(bytes: &[u8]) -> Result<RawFile, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "The file is not valid UTF-8".to_string())?;
    let (bom, text) = match text.strip_prefix('\u{feff}') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let crlf = text
        .find('\n')
        .is_some_and(|at| at > 0 && text.as_bytes()[at - 1] == b'\r');
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    Ok(RawFile {
        bom,
        crlf,
        lines: lines
            .into_iter()
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .collect(),
    })
}

/// One line after the check of З51.
#[derive(Debug, Clone)]
pub(super) struct LineInfo {
    /// Index in [`RawFile::lines`].
    pub index: usize,
    /// The `id`, when the line still tells it.
    pub id: Option<String>,
    /// The parsed line, `None` when it cannot be used.
    pub value: Option<Map<String, Value>>,
}

/// A file read and checked line by line (З51).
#[derive(Debug, Clone)]
pub(super) struct Classified {
    pub raw: RawFile,
    pub header: Map<String, Value>,
    pub lines: Vec<LineInfo>,
}

impl Classified {
    pub fn empty() -> Self {
        Self {
            raw: RawFile::new_file(),
            header: Map::new(),
            lines: Vec::new(),
        }
    }

    pub fn has_bad(&self) -> bool {
        self.lines.iter().any(|line| line.value.is_none())
    }

    pub fn find(&self, id: &str) -> Option<&LineInfo> {
        self.lines
            .iter()
            .find(|line| line.id.as_deref() == Some(id))
    }
}

fn loose_id(text: &str) -> Option<String> {
    let Value::Object(map) = serde_json::from_str::<Value>(text).ok()? else {
        return None;
    };
    map.get("id")?.as_str().map(str::to_string)
}

/// Reads the bytes of a group file. An unreadable first line is an error (З48), a bad line is
/// kept in the answer (З51).
pub(super) fn classify(kind: GroupKind, bytes: &[u8]) -> Result<Classified, String> {
    let raw = split_raw(bytes)?;
    let first = raw
        .lines
        .first()
        .ok_or_else(|| "The first line of the file is missing".to_string())?;
    let Ok(Value::Object(mut header)) = serde_json::from_str::<Value>(first) else {
        return Err("The first line of the file cannot be read".to_string());
    };
    if header.remove("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err("The first line of the file names another version".to_string());
    }
    let mut lines = Vec::new();
    let mut seen = BTreeSet::new();
    let mut previous: Option<String> = None;
    for (index, text) in raw.lines.iter().enumerate().skip(1) {
        let parsed = parse_line(kind, text);
        let id = match &parsed {
            Ok(map) => map.get("id").and_then(Value::as_str).map(str::to_string),
            Err(_) => loose_id(text),
        };
        let mut value = parsed.ok();
        if let (Some(_), Some(id)) = (&value, &id) {
            let fresh = seen.insert(id.clone());
            if !fresh || previous.as_deref().is_some_and(|p| p > id.as_str()) {
                value = None;
            }
            if value.is_some() {
                previous = Some(id.clone());
            }
        }
        lines.push(LineInfo { index, id, value });
    }
    Ok(Classified { raw, header, lines })
}

fn read_classified(kind: GroupKind, path: &Path) -> Result<Option<Classified>, String> {
    match fs::read(path) {
        Ok(bytes) => classify(kind, &bytes).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn relative(vault: &Path, path: &Path) -> String {
    path.strip_prefix(vault)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn entry_of_line(info: &LineInfo) -> Option<NoteEntry> {
    serde_json::from_value(Value::Object(info.value.clone()?)).ok()
}

/// Reads the file of a note's group. A missing file is an empty one. A line that cannot be used
/// is reported in the second part, the other lines are given (З51); an unreadable first line is
/// an error and the file is never overwritten.
pub fn read_group(vault: &Path, note_id: &str) -> Result<(GroupFile, Vec<BadLine>), String> {
    let path = group_path(vault, note_id);
    let Some(classified) = read_classified(GroupKind::Props, &path)? else {
        return Ok((
            GroupFile {
                header: Map::new(),
                entries: Vec::new(),
            },
            Vec::new(),
        ));
    };
    let rel = relative(vault, &path);
    let mut entries = Vec::new();
    let mut bad = Vec::new();
    for info in &classified.lines {
        match entry_of_line(info) {
            Some(entry) => entries.push(entry),
            None => bad.push(BadLine {
                file: rel.clone(),
                number: info.index + 1,
                note_id: info.id.clone(),
            }),
        }
    }
    Ok((
        GroupFile {
            header: classified.header,
            entries,
        },
        bad,
    ))
}

/// The line of a note, if the group has it.
pub fn read_entry(vault: &Path, note_id: &str) -> Result<Option<NoteEntry>, String> {
    Ok(read_group(vault, note_id)?
        .0
        .entries
        .into_iter()
        .find(|entry| entry.id == note_id))
}

/// The mark of a note in `legacy_<x>.jsonl`, if there is one (З53).
pub fn read_mark(vault: &Path, note_id: &str) -> Result<Option<LegacyMark>, String> {
    let path = legacy_path(vault, note_id);
    let Some(classified) = read_classified(GroupKind::Legacy, &path)? else {
        return Ok(None);
    };
    Ok(classified
        .find(note_id)
        .and_then(|info| info.value.clone())
        .and_then(|map| serde_json::from_value(Value::Object(map)).ok()))
}

/// The canonical text of one line, without the line feed (З49): compact JSON, keys ascending byte
/// by byte.
pub fn canonical_line(entry: &NoteEntry) -> String {
    canonical_json(&serde_json::to_value(entry).unwrap_or(Value::Null))
}

fn canonical_mark(mark: &LegacyMark) -> String {
    canonical_json(&serde_json::to_value(mark).unwrap_or(Value::Null))
}

impl NoteEntry {
    /// A record with no `props`, `order` and `dismissedRenames` is not kept (З4, З47).
    pub fn is_empty(&self) -> bool {
        self.props.is_empty() && self.order.is_empty() && self.dismissed_renames.is_empty()
    }
}

/// Drops the properties without any difference and a record without content (З47).
pub(super) fn normalized(mut entry: NoteEntry, note_id: &str) -> Option<NoteEntry> {
    entry.id = note_id.to_string();
    entry.props.retain(|_, diff| {
        diff.icon.is_some()
            || diff.property_type.is_some()
            || diff.settings.is_some()
            || diff.previous_name.is_some()
            || !diff.extra.is_empty()
    });
    let mut seen = BTreeSet::new();
    entry.order.retain(|name| seen.insert(name.clone()));
    (!entry.is_empty()).then_some(entry)
}

/// Replaces, inserts or removes one line of a file; every other line stays as it is (З50).
/// Returns whether the file was written. A file with a line that cannot be used is never written
/// (З51), nor a file with an unreadable first line (З48).
pub(super) fn write_line(
    kind: GroupKind,
    path: &Path,
    note_id: &str,
    line: Option<String>,
) -> Result<bool, String> {
    let existing = read_classified(kind, path)?;
    if existing.as_ref().is_some_and(Classified::has_bad) {
        return Err("The file has a line that cannot be used; nothing is written".to_string());
    }
    let existed = existing.is_some();
    let classified = existing.unwrap_or_else(Classified::empty);
    let mut raw = classified.raw.clone();
    let position = classified.find(note_id).map(|info| info.index);
    match (&position, &line) {
        (Some(index), Some(new)) => {
            if &raw.lines[*index] == new {
                return Ok(false);
            }
            raw.lines[*index] = new.clone();
        }
        (Some(index), None) => {
            raw.lines.remove(*index);
        }
        (None, Some(new)) => {
            let before = classified
                .lines
                .iter()
                .find(|info| info.id.as_deref().is_some_and(|id| id > note_id))
                .map_or(raw.lines.len(), |info| info.index);
            raw.lines.insert(before, new.clone());
        }
        (None, None) => return Ok(false),
    }
    if raw.lines.len() <= 1 {
        if existed {
            // A file with only its first line holds nothing; it is written that way first, so the
            // removal is as safe as any other edit, and then the file goes (З4, З50).
            frontmatter::atomic_write_bytes(path, &raw.join())?;
            fs::remove_file(path).map_err(|error| error.to_string())?;
            return Ok(true);
        }
        return Ok(false);
    }
    frontmatter::atomic_write_bytes(path, &raw.join())?;
    Ok(true)
}

/// Reads the record of a note, lets `change` decide the new one and writes the line when it
/// really changed (З8, З50). `hint` is refreshed here and only here (З47). Returns the old and the
/// new record.
pub(super) fn update_entry(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    change: impl FnOnce(Option<NoteEntry>) -> Result<Option<NoteEntry>, String>,
) -> Result<(Option<NoteEntry>, Option<NoteEntry>), String> {
    super::files::require_groups(vault)?;
    let path = group_path(vault, note_id);
    let classified = read_classified(GroupKind::Props, &path)?;
    if classified.as_ref().is_some_and(Classified::has_bad) {
        return Err("The file of the group has a line that cannot be used".to_string());
    }
    let old = classified
        .as_ref()
        .and_then(|c| c.find(note_id))
        .and_then(entry_of_line);
    let wanted = change(old.clone())?;
    let mut new = wanted.and_then(|entry| normalized(entry, note_id));
    if new == old {
        return Ok((old, new));
    }
    if let Some(entry) = new.as_mut() {
        let current: Option<String> = conn
            .query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(path) = current {
            entry.hint = Some(super::Hint { path });
        }
    }
    let line = new.as_ref().map(canonical_line);
    write_line(GroupKind::Props, &path, note_id, line)?;
    Ok((old, new))
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
    update_entry(conn, vault, note_id, |_| Ok(entry)).map(|_| ())
}

/// Writes a record without looking at the layout: the migration writes the groups before the
/// layout, which goes last (З21, З41).
pub(super) fn put_entry_unchecked(
    vault: &Path,
    note_id: &str,
    entry: Option<NoteEntry>,
) -> Result<bool, String> {
    let entry = entry.and_then(|e| normalized(e, note_id));
    let line = entry.as_ref().map(canonical_line);
    write_line(GroupKind::Props, &group_path(vault, note_id), note_id, line)
}

/// Writes or removes the mark of a note in `legacy_<x>.jsonl` by the same rules (З53).
pub fn put_mark(vault: &Path, note_id: &str, mark: Option<LegacyMark>) -> Result<(), String> {
    if storage_mode(vault)? == StorageMode::Newer {
        return Err("The format of the properties is newer than this version of Amby".to_string());
    }
    let line = mark.as_ref().map(canonical_mark);
    write_line(
        GroupKind::Legacy,
        &legacy_path(vault, note_id),
        note_id,
        line,
    )
    .map(|_| ())
}

/// Every mark of the files `legacy_<x>.jsonl` and every record of `prop_<x>.jsonl`, for the walks
/// that need the whole vault: the rebuild of the cache, the migration and the inspection (З56).
/// The records and the bad lines of one file.
pub(super) type GroupContent = (Vec<NoteEntry>, Vec<BadLine>);

pub(super) fn all_groups(vault: &Path) -> Result<Vec<GroupContent>, String> {
    let mut out = Vec::new();
    for digit in "0123456789abcdef".chars() {
        let path = properties_dir(vault).join(format!("prop_{digit}.jsonl"));
        let Some(classified) = read_classified(GroupKind::Props, &path)? else {
            continue;
        };
        let rel = relative(vault, &path);
        let mut entries = Vec::new();
        let mut bad = Vec::new();
        for info in &classified.lines {
            match entry_of_line(info) {
                Some(entry) => entries.push(entry),
                None => bad.push(BadLine {
                    file: rel.clone(),
                    number: info.index + 1,
                    note_id: info.id.clone(),
                }),
            }
        }
        out.push((entries, bad));
    }
    Ok(out)
}

/// A line of a group is a problem in the sense of [`NotMergeable`] only for the engine; here the
/// reason is not needed.
pub(super) fn reason_text(reason: NotMergeable) -> String {
    format!("{reason:?}")
}
