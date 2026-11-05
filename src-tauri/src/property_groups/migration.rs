//! Migration from `.amby/properties.json` of the first format to the groups (appendix З:
//! З19–З21, З38–З42, З54). The dry run writes nothing; the run keeps copies and a journal and
//! writes `layout.json` last, so a repeat finishes what a crash left (З41).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use amby_sync_core::engine::props_groups::GroupKind;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use super::files::{
    blake3_hex, canonical_line, layout_path, layout_text, legacy_path, properties_dir,
    storage_mode, write_line,
};
use super::header::resolve;
use super::legacy::{
    entry_from_old, forget_old_file, old_entry_hash, read_old_file, record_hash, remember_old_file,
    OldFile, OldProps,
};
use super::{Hint, KeyMatch, LegacyMark, StorageMode, OLD_VERSION_WARNING};
use crate::frontmatter::{self, HeaderKeys};
use crate::property_template::TEMPLATE_VERSION;

use std::collections::BTreeSet as Set;

/// A value in the file that differs from the header (З19, З20).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// (З58).
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

// ----- the plan -----

/// One edit of a header: the keys that are added or given the value of the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Op {
    key: String,
    value: String,
    #[serde(rename = "type")]
    property_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Edit {
    note_id: String,
    /// Relative to the vault.
    path: String,
    /// BLAKE3 of the bytes of the note before and after (З41).
    before: String,
    after: String,
    ops: Vec<Op>,
}

/// The journal of a migration: the whole plan, so a repeat does the same (З21, З41).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Journal {
    version: u32,
    id: String,
    template: u32,
    /// Lines of the groups: note id → the canonical line.
    lines: BTreeMap<String, String>,
    marks: BTreeMap<String, LegacyMark>,
    edits: Vec<Edit>,
    #[serde(default)]
    diverged: Vec<Mismatch>,
}

struct Plan {
    lines: BTreeMap<String, String>,
    marks: BTreeMap<String, LegacyMark>,
    edits: Vec<Edit>,
    report: Report,
}

fn text_field(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Is the value of the file the value of the header, by the meaning of YAML (З40)?
fn same_value(file_value: &str, property_type: &str, header_value: &str) -> bool {
    let (file, header) = (file_value.trim(), header_value.trim());
    if file.is_empty() && header.is_empty() {
        return true;
    }
    let items = |text: &str| -> Vec<String> {
        text.trim_matches(['[', ']'])
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect()
    };
    match property_type {
        "checkbox" => {
            let flag = |text: &str| text.eq_ignore_ascii_case("true") || text == "1";
            flag(file) == flag(header)
        }
        "number" => match (file.parse::<f64>(), header.parse::<f64>()) {
            (Ok(a), Ok(b)) => a == b,
            _ => file == header,
        },
        "list" => items(file) == items(header),
        _ => file == header,
    }
}

fn find_note_path(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT path FROM notes WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|error| error.to_string())
}

/// Can the note be trusted with a header edit (З25)?
fn touch_state(
    conn: &Connection,
    vault: &Path,
    id: &str,
    rel: &str,
) -> Result<(String, Vec<crate::frontmatter::HeaderKey>), Untouchable> {
    if crate::index::identity::ensure_unique_identity(conn, id).is_err() {
        return Err(Untouchable::DuplicateId);
    }
    let text = fs::read_to_string(vault.join(rel)).map_err(|_| Untouchable::MalformedHeader)?;
    let parsed = frontmatter::parse_markdown(&text);
    if parsed.frontmatter_status.is_malformed() {
        return Err(Untouchable::MalformedHeader);
    }
    if parsed.identity_error.is_some() || parsed.id.as_deref() != Some(id) {
        return Err(Untouchable::NoId);
    }
    match frontmatter::header_keys(&text) {
        HeaderKeys::Keys(keys) => Ok((text, keys)),
        _ => Err(Untouchable::MalformedHeader),
    }
}

fn build_plan(conn: &Connection, vault: &Path, old: &OldFile) -> Result<Plan, String> {
    let mut plan = Plan {
        lines: BTreeMap::new(),
        marks: BTreeMap::new(),
        edits: Vec::new(),
        report: Report::default(),
    };
    plan.report.warnings.push(OLD_VERSION_WARNING.to_string());
    plan.report.notes = old.notes.len();
    for (id, list) in &old.notes {
        plan.report.properties += list.len();
        let rel = find_note_path(conn, id)?;
        let mut header_names: Option<Vec<String>> = None;
        if let Some(rel) = &rel {
            match touch_state(conn, vault, id, rel) {
                Err(reason) => plan.report.untouchable.push((id.clone(), reason)),
                Ok((text, keys)) => {
                    let (names, edit) =
                        examine(id, rel, &text, &keys, list, &mut plan.report, vault)?;
                    header_names = names;
                    if let Some(edit) = edit {
                        plan.report.header_edits += 1;
                        plan.edits.push(edit);
                    }
                }
            }
        } else {
            plan.report.orphans.push(id.clone());
        }
        let mut entry = entry_from_old(id, list, header_names.as_deref());
        if let (Some(entry), Some(rel)) = (entry.as_mut(), &rel) {
            entry.hint = Some(Hint { path: rel.clone() });
        }
        if let Some(entry) = &entry {
            plan.lines.insert(id.clone(), canonical_line(entry));
        }
        plan.marks.insert(
            id.clone(),
            LegacyMark {
                id: id.clone(),
                entry: old_entry_hash(Some(list)),
                record: record_hash(entry.as_ref()),
            },
        );
    }
    Ok(plan)
}

/// Compares the values of one note with its header and plans the edit of the header.
#[allow(clippy::too_many_arguments)]
fn examine(
    id: &str,
    rel: &str,
    text: &str,
    keys: &[crate::frontmatter::HeaderKey],
    list: &OldProps,
    report: &mut Report,
    vault: &Path,
) -> Result<(Option<Vec<String>>, Option<Edit>), String> {
    let mut ops: Vec<Op> = Vec::new();
    let mut names: Vec<String> = keys
        .iter()
        .filter(|k| !super::header::is_reserved(&k.key))
        .map(|k| k.key.clone())
        .collect();
    let mut seen: Set<String> = Set::new();
    for object in list {
        let name = text_field(object, "name").trim().to_string();
        if name.is_empty() || !seen.insert(amby_sync_core::engine::props_groups::name_key(&name)) {
            continue;
        }
        let property_type = match text_field(object, "propertyType") {
            ty if ty.is_empty() => "text".to_string(),
            ty => ty,
        };
        let file_value = text_field(object, "value");
        match resolve(keys, &name, None) {
            KeyMatch::Found { value, .. } => {
                if same_value(&file_value, &property_type, &value) {
                    report.same += 1;
                } else {
                    report.mismatches.push(Mismatch {
                        note_id: id.to_string(),
                        name: name.clone(),
                        file_value: file_value.clone(),
                        header_value: value,
                    });
                }
            }
            KeyMatch::Missing => {
                if !file_value.trim().is_empty() {
                    report.missing_keys.push(MissingKey {
                        note_id: id.to_string(),
                        name: name.clone(),
                        file_value: file_value.clone(),
                    });
                    names.push(name.clone());
                    ops.push(Op {
                        key: name,
                        value: file_value,
                        property_type,
                    });
                }
            }
            KeyMatch::Ambiguous { .. } | KeyMatch::HeaderUnreadable => {}
        }
    }
    if ops.is_empty() {
        return Ok((Some(names), None));
    }
    let path = vault.join(rel);
    let mut content = text.to_string();
    for op in &ops {
        match frontmatter::upsert_frontmatter_property(
            &content,
            id,
            &op.key,
            &op.value,
            &op.property_type,
        ) {
            Ok(next) => content = next,
            Err(_) => {
                report
                    .untouchable
                    .push((id.to_string(), Untouchable::HeaderCannotChange));
                return Ok((None, None));
            }
        }
    }
    if content == text {
        return Ok((Some(names), None));
    }
    let before = fs::read(&path).map_err(|error| error.to_string())?;
    let after = frontmatter::text_bytes_for_write(&path, &content)?;
    Ok((
        Some(names),
        Some(Edit {
            note_id: id.to_string(),
            path: rel.to_string(),
            before: blake3_hex(&before),
            after: blake3_hex(&after),
            ops,
        }),
    ))
}

/// The dry run: counts and decisions, **no write at all** (З19). An unreadable `properties.json`
/// or an unknown version is an error (З41).
pub fn preview(conn: &Connection, vault: &Path) -> Result<Report, String> {
    let Some(old) = read_old_file(vault)? else {
        let mut report = Report::default();
        report.warnings.push(OLD_VERSION_WARNING.to_string());
        return Ok(report);
    };
    Ok(build_plan(conn, vault, &old)?.report)
}

// ----- the run -----

fn migrations_dir(vault: &Path) -> PathBuf {
    vault.join(".amby").join("migrations")
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match frontmatter::atomic_write_bytes_new(path, bytes) {
        Ok(()) | Err(frontmatter::AtomicCreateError::AlreadyExists) => Ok(()),
        Err(frontmatter::AtomicCreateError::Other(error)) => Err(error),
    }
}

/// The migration (З21, З54, З57): copies of `properties.json` and of every note whose header is
/// edited → journal in `.amby/migrations/<id>/` → files → headers → `layout.json` last → outcome.
/// No confirmation and no choice of values: a diverging value keeps the header's and is listed in
/// [`Outcome::diverged`] (З58). `properties.json` becomes differences from the template, in the language of the name
/// that matched; a property equal to the template gives no line; the order goes to `order` only
/// when it differs from the header's; the `id` of properties are not carried. `properties.json`
/// is never changed (З22). It does not start when the template number of an arrived `layout.json`
/// is higher than ours (З54).
pub fn run(conn: &Connection, vault: &Path, context: &Context) -> Result<Outcome, String> {
    if context.sync_enabled && !context.last_pass_ok {
        return Err("The migration waits for a successful pass of the synchronisation".to_string());
    }
    if context.layout_came_from_server {
        return Err("Another device has migrated this vault already".to_string());
    }
    if context
        .arrived_template
        .is_some_and(|n| n > TEMPLATE_VERSION)
    {
        return Err("The template of the arrived layout is newer than this Amby".to_string());
    }
    if storage_mode(vault)? != StorageMode::Legacy {
        return Err("The properties of this vault are in the new format already".to_string());
    }
    if let Some(dir) = unfinished(vault) {
        let _ = dir;
        return resume(conn, vault);
    }
    let old = read_old_file(vault)?;
    let Some(old) = old.filter(|file| !file.notes.is_empty()) else {
        write_new(&layout_path(vault), layout_text().as_bytes())?;
        return Ok(Outcome::default());
    };
    let mut plan = build_plan(conn, vault, &old)?;
    let diverged = std::mem::take(&mut plan.report.mismatches);
    let id = Ulid::generate().to_string();
    let dir = migrations_dir(vault).join(&id);
    write_new(&dir.join("properties.json"), &old.bytes)?;
    for edit in &plan.edits {
        let bytes = fs::read(vault.join(&edit.path)).map_err(|error| error.to_string())?;
        write_new(&dir.join("notes").join(&edit.note_id), &bytes)?;
    }
    let journal = Journal {
        version: 1,
        id: id.clone(),
        template: TEMPLATE_VERSION,
        lines: plan.lines,
        marks: plan.marks,
        edits: plan.edits,
        diverged,
    };
    let mut body = serde_json::to_vec_pretty(&journal).map_err(|error| error.to_string())?;
    body.push(b'\n');
    write_new(&dir.join("journal.json"), &body)?;
    execute(vault, &dir, &journal)
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
/// [`run`], or [`resume`] by an existing journal. Nothing is written when it does not migrate.
/// Never changes `properties.json`.
pub fn open_vault(
    conn: &Connection,
    vault: &Path,
    context: &Context,
) -> Result<OpenOutcome, String> {
    if storage_mode(vault)? != StorageMode::Legacy {
        return Ok(OpenOutcome::AlreadyGroups);
    }
    if context.layout_came_from_server {
        return Ok(OpenOutcome::ArrivedFromServer);
    }
    if context.sync_enabled && !context.last_pass_ok {
        return Ok(OpenOutcome::ReadOnly(ReadOnlyReason::WaitingForSync));
    }
    if read_old_file(vault).is_err() {
        return Ok(OpenOutcome::ReadOnly(ReadOnlyReason::UnreadableOldFile));
    }
    run(conn, vault, context).map(OpenOutcome::Migrated)
}

/// «Взять значение из старого файла» (З58): writes the value of `properties.json` into the header
/// of the note as an ordinary edit of a value (З1, with history); changes nothing else.
pub fn take_file_value(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
) -> Result<(), String> {
    take_file_value_as(conn, vault, note_id, name, name)
}

/// The same after a rename in Amby: the old file knows the property as `file_name`, the note has it
/// as `name` now.
pub fn take_file_value_as(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    file_name: &str,
    name: &str,
) -> Result<(), String> {
    let old = read_old_file(vault)?.ok_or_else(|| "There is no properties.json".to_string())?;
    let list = old
        .notes
        .get(note_id)
        .ok_or_else(|| format!("The old file has no note {note_id}"))?;
    let object = list
        .iter()
        .find(|object| super::header::same_name(&text_field(object, "name"), file_name))
        .ok_or_else(|| format!("The old file has no property {file_name}"))?;
    super::edits::set_value(conn, vault, note_id, name, &text_field(object, "value"))
}

/// A migration with a journal and no outcome, the newest one.
fn unfinished(vault: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(migrations_dir(vault))
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join("journal.json").is_file() && !path.join("outcome.json").exists())
        .collect();
    dirs.sort();
    dirs.pop()
}

fn read_journal(dir: &Path) -> Result<Journal, String> {
    let bytes = fs::read(dir.join("journal.json")).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// The planned content of the files of the groups: the first line and the lines sorted by `id`.
fn planned_files(
    lines: impl Iterator<Item = (String, String)>,
    path_of: fn(&Path, &str) -> PathBuf,
    vault: &Path,
) -> BTreeMap<PathBuf, Vec<(String, String)>> {
    let mut files: BTreeMap<PathBuf, Vec<(String, String)>> = BTreeMap::new();
    for (id, line) in lines {
        files
            .entry(path_of(vault, &id))
            .or_default()
            .push((id, line));
    }
    for entries in files.values_mut() {
        entries.sort();
    }
    files
}

fn file_bytes(entries: &[(String, String)]) -> Vec<u8> {
    let mut text = String::from("{\"version\":1}\n");
    for (_, line) in entries {
        text.push_str(line);
        text.push('\n');
    }
    text.into_bytes()
}

fn group_file_path(vault: &Path, id: &str) -> PathBuf {
    super::files::group_path(vault, id)
}

fn mark_file_path(vault: &Path, id: &str) -> PathBuf {
    legacy_path(vault, id)
}

/// Writes one planned file: as it is when it is not there, line by line when something else is.
fn put_planned(path: &Path, kind: GroupKind, entries: &[(String, String)]) -> Result<bool, String> {
    let planned = file_bytes(entries);
    match fs::read(path) {
        Ok(existing) if existing == planned => Ok(false),
        Ok(_) => {
            for (id, line) in entries {
                write_line(kind, path, id, Some(line.clone()))?;
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            frontmatter::atomic_write_bytes(path, &planned)?;
            Ok(true)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn execute(vault: &Path, dir: &Path, journal: &Journal) -> Result<Outcome, String> {
    let mut outcome = Outcome {
        migration_id: journal.id.clone(),
        diverged: journal.diverged.clone(),
        ..Outcome::default()
    };
    // The files of the groups and the marks come first (З21).
    let groups = planned_files(
        journal.lines.iter().map(|(i, l)| (i.clone(), l.clone())),
        group_file_path,
        vault,
    );
    for (path, entries) in &groups {
        if put_planned(path, GroupKind::Props, entries)? {
            outcome.groups_written += 1;
        }
    }
    let marks = planned_files(
        journal.marks.iter().map(|(i, m)| (i.clone(), mark_line(m))),
        mark_file_path,
        vault,
    );
    for (path, entries) in &marks {
        put_planned(path, GroupKind::Legacy, entries)?;
    }
    // The headers: done is done, «до» is done now, anything else is left alone (З41).
    for edit in &journal.edits {
        let path = vault.join(&edit.path);
        let Ok(current) = fs::read(&path) else {
            outcome.skipped_changed.push(edit.note_id.clone());
            continue;
        };
        let hash = blake3_hex(&current);
        if hash == edit.after {
            continue;
        }
        if hash != edit.before {
            outcome.skipped_changed.push(edit.note_id.clone());
            continue;
        }
        let mut content = String::from_utf8(current).map_err(|error| error.to_string())?;
        for op in &edit.ops {
            content = frontmatter::upsert_frontmatter_property(
                &content,
                &edit.note_id,
                &op.key,
                &op.value,
                &op.property_type,
            )?;
        }
        let bytes = frontmatter::text_bytes_for_write(&path, &content)?;
        if blake3_hex(&bytes) != edit.after {
            outcome.skipped_changed.push(edit.note_id.clone());
            continue;
        }
        let _ = crate::history::snapshot_before_write(vault, &path, &bytes, "property-migration");
        frontmatter::atomic_write_bytes(&path, &bytes)?;
        outcome.headers_written.push(edit.note_id.clone());
    }
    // The memo of this device, then the layout: the mark of the end (З21, З36).
    if let Some(old) = read_old_file(vault)? {
        remember_old_file(vault, &old.bytes)?;
    }
    write_new(&layout_path(vault), layout_text().as_bytes())?;
    let record = serde_json::json!({
        "version": 1,
        "id": journal.id,
        "headersWritten": outcome.headers_written,
        "skippedChanged": outcome.skipped_changed,
    });
    let mut bytes = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    write_new(&dir.join("outcome.json"), &bytes)?;
    Ok(outcome)
}

fn mark_line(mark: &LegacyMark) -> String {
    amby_sync_core::engine::props_groups::canonical_json(
        &serde_json::to_value(mark).unwrap_or(serde_json::Value::Null),
    )
}

/// Finishes an interrupted migration by its journal (З21, З41).
pub fn resume(_conn: &Connection, vault: &Path) -> Result<Outcome, String> {
    let dir = unfinished(vault).ok_or_else(|| "No unfinished migration".to_string())?;
    let journal = read_journal(&dir)?;
    if journal.template > TEMPLATE_VERSION {
        return Err("The journal was made under a newer template".to_string());
    }
    execute(vault, &dir, &journal)
}

/// The rollback (З42): before `layout.json` it is part of the repeat; after the end it is a manual
/// action of the inspection.
pub fn rollback(
    _conn: &Connection,
    vault: &Path,
    migration_id: &str,
) -> Result<RollbackReport, String> {
    let dir = migrations_dir(vault).join(migration_id);
    let journal = read_journal(&dir)?;
    let mut report = RollbackReport::default();
    for edit in &journal.edits {
        let path = vault.join(&edit.path);
        let Ok(current) = fs::read(&path) else {
            report.not_restored.push(edit.note_id.clone());
            continue;
        };
        let hash = blake3_hex(&current);
        if hash == edit.before {
            continue;
        }
        if hash != edit.after {
            report.not_restored.push(edit.note_id.clone());
            continue;
        }
        let original = fs::read(dir.join("notes").join(&edit.note_id))
            .map_err(|error| format!("The copy of the note is missing: {error}"))?;
        frontmatter::atomic_write_bytes(&path, &original)?;
        report.headers_restored.push(edit.note_id.clone());
    }
    if layout_path(vault).exists() {
        // After the end the groups go to the trash of the vault, nothing is deleted (З42).
        let trash = vault
            .join(".amby")
            .join("trash")
            .join(format!("properties-{migration_id}"));
        fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(properties_dir(vault))
            .map_err(|error| error.to_string())?
            .flatten()
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name();
            let is_group = name
                .to_str()
                .is_some_and(|n| n.starts_with("prop_") || n.starts_with("legacy_"));
            fs::rename(&path, trash.join(&name)).map_err(|error| error.to_string())?;
            if is_group {
                report.groups_removed += 1;
            }
        }
    } else {
        // Before the end only what the migration wrote goes, byte for byte (З42).
        let groups = planned_files(
            journal.lines.iter().map(|(i, l)| (i.clone(), l.clone())),
            group_file_path,
            vault,
        );
        let marks = planned_files(
            journal.marks.iter().map(|(i, m)| (i.clone(), mark_line(m))),
            mark_file_path,
            vault,
        );
        for (path, entries) in groups.iter().chain(marks.iter()) {
            if fs::read(path).ok().as_deref() == Some(file_bytes(entries).as_slice()) {
                fs::remove_file(path).map_err(|error| error.to_string())?;
                report.groups_removed += 1;
            }
        }
    }
    forget_old_file(vault);
    // The journal now says the migration is over, so no repeat starts it again.
    let mut bytes = b"{\"version\":1,\"rolledBack\":true}\n".to_vec();
    bytes.push(b'\n');
    write_new(&dir.join("outcome.json"), &bytes)?;
    Ok(report)
}
