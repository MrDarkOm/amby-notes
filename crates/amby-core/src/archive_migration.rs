//! The one-time move of the old trash into the archive (docs/sync-plan.md, К7, К9, К10, К11).
//!
//! The rules of AGENTS.md for persistent migrations: a version in `.amby/migrations/`, a read-only
//! preflight, a journal of steps written before the first move, a marker of completion, a recorded
//! outcome, a rollback by the journal, and nothing is ever deleted. Every move is one rename inside
//! the vault; what a step did is read back from the files themselves, so a run interrupted at any
//! place resumes (or rolls back) from what is really on disk.
//!
//! The journal of the steps is `plan.json` plus `steps/`: the name `journal.json` is left to the
//! migration of the properties (a folder with `journal.json` and no `outcome.json` is read there as
//! an unfinished migration of its own).
//!
//! Layout of `.amby/migrations/trash-to-archive-v1/`:
//! - `plan.json`: the whole plan, written before the first move;
//! - `steps/<id>`: one small file per finished entry (so a step costs one tiny write);
//! - `manifests/<id>.json`: the old descriptions of the migrated entries (К11 (д)), moved here;
//! - `completed.json`: the marker of completion with the recorded outcome;
//! - `rolled-back-<ms>/`: the journal, steps and marker of a run that was rolled back.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::archive::{archive_root, files_below, is_plain_relative, write_meta};
use crate::frontmatter::atomic_write_bytes;
use crate::recycle_bin::TrashEntry;

/// The kind of the migration in `.amby/migrations/` (К9).
pub const MIGRATION_KIND: &str = "trash-to-archive";
/// The version of the migration (К9).
pub const MIGRATION_VERSION: u32 = 1;

const MANIFEST_MAX_BYTES: u64 = 64 * 1024;

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

impl KeptReason {
    fn code(self) -> &'static str {
        match self {
            Self::Service => "service",
            Self::NoPayload => "no-payload",
            Self::BrokenManifest => "broken-manifest",
            Self::UnsafePath => "unsafe-path",
        }
    }

    fn from_code(code: &str) -> Option<Self> {
        Some(match code {
            "service" => Self::Service,
            "no-payload" => Self::NoPayload,
            "broken-manifest" => Self::BrokenManifest,
            "unsafe-path" => Self::UnsafePath,
            _ => return None,
        })
    }
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

impl From<String> for RunError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
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

// ----- the journal -----

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileFact {
    /// The path of the file inside the payload (`""` when the payload is the file itself).
    rel: String,
    len: u64,
    mtime_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Planned {
    id: String,
    name: String,
    deleted_at_ms: u64,
    /// The place of the payload in the archive (`.amby/archive/<dest>`): the original path, or a
    /// free name next to it (К7).
    dest: String,
    directory: bool,
    files: Vec<FileFact>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct KeptNote {
    id: String,
    reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    kind: String,
    version: u32,
    started_at_ms: u64,
    entries: Vec<Planned>,
    kept: Vec<KeptNote>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    kind: String,
    version: u32,
    completed_at_ms: u64,
    migrated: usize,
    kept: Vec<KeptNote>,
}

fn trash_root(vault: &Path) -> PathBuf {
    vault.join(".amby").join("trash")
}

fn migration_dir(vault: &Path) -> PathBuf {
    vault
        .join(".amby")
        .join("migrations")
        .join(format!("{MIGRATION_KIND}-v{MIGRATION_VERSION}"))
}

fn journal_path(vault: &Path) -> PathBuf {
    migration_dir(vault).join("plan.json")
}

fn marker_path(vault: &Path) -> PathBuf {
    migration_dir(vault).join("completed.json")
}

fn steps_dir(vault: &Path) -> PathBuf {
    migration_dir(vault).join("steps")
}

fn manifests_dir(vault: &Path) -> PathBuf {
    migration_dir(vault).join("manifests")
}

fn to_notes(kept: &[Kept]) -> Vec<KeptNote> {
    kept.iter()
        .map(|item| KeptNote {
            id: item.id.clone(),
            reason: item.reason.code().to_string(),
        })
        .collect()
}

fn from_notes(notes: &[KeptNote]) -> Vec<Kept> {
    notes
        .iter()
        .filter_map(|note| {
            Some(Kept {
                id: note.id.clone(),
                reason: KeptReason::from_code(&note.reason)?,
            })
        })
        .collect()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    atomic_write_bytes(
        path,
        &serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?,
    )
}

fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn mtime_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

// ----- looking at the trash -----

struct Scan {
    entries: usize,
    planned: Vec<Planned>,
    kept: Vec<Kept>,
    bytes: u64,
}

fn read_manifest(path: &Path, stem: &str) -> Option<TrashEntry> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MANIFEST_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MANIFEST_MAX_BYTES {
        return None;
    }
    let entry: TrashEntry = serde_json::from_slice(&bytes).ok()?;
    let name_ok =
        !entry.name.is_empty() && is_plain_relative(&entry.name) && !entry.name.contains('/');
    (entry.id == stem && stem.parse::<ulid::Ulid>().is_ok() && name_ok).then_some(entry)
}

fn facts_of(payload: &Path) -> Option<(bool, Vec<FileFact>)> {
    let metadata = fs::symlink_metadata(payload).ok()?;
    if metadata.is_dir() {
        let mut rels = Vec::new();
        files_below(payload, payload, &mut rels);
        rels.sort();
        let facts = rels
            .into_iter()
            .filter_map(|rel| {
                let meta = fs::symlink_metadata(payload.join(&rel)).ok()?;
                Some(FileFact {
                    rel,
                    len: meta.len(),
                    mtime_ms: mtime_ms(&meta),
                })
            })
            .collect();
        Some((true, facts))
    } else {
        Some((
            false,
            vec![FileFact {
                rel: String::new(),
                len: metadata.len(),
                mtime_ms: mtime_ms(&metadata),
            }],
        ))
    }
}

/// Is `candidate` the same as, inside, or around one of the `taken` archive paths?
fn overlaps(candidate: &str, taken: &BTreeSet<String>) -> bool {
    taken.iter().any(|other| {
        other == candidate
            || other.starts_with(&format!("{candidate}/"))
            || candidate.starts_with(&format!("{other}/"))
    })
}

/// `rel`, or `stem 2.ext`, `stem 3.ext`, … next to it: the first place that is free in the archive
/// and not promised to an earlier entry of the plan (К7).
fn free_archive_rel(archive: &Path, rel: &str, taken: &BTreeSet<String>) -> String {
    let free = |candidate: &str| {
        !overlaps(candidate, taken) && fs::symlink_metadata(archive.join(candidate)).is_err()
    };
    if free(rel) {
        return rel.to_string();
    }
    let (dir, name) = match rel.rfind('/') {
        Some(at) => (&rel[..=at], &rel[at + 1..]),
        None => ("", rel),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(at) if at > 0 => (&name[..at], &name[at..]),
        _ => (name, ""),
    };
    for number in 2..10_000 {
        let candidate = format!("{dir}{stem} {number}{ext}");
        if free(&candidate) {
            return candidate;
        }
    }
    format!("{dir}{stem} {}{ext}", crate::archive::now_ms())
}

fn scan(vault: &Path) -> Scan {
    let root = trash_root(vault);
    let archive = archive_root(vault);
    let mut stems: Vec<String> = fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()?
                .strip_suffix(".json")
                .map(str::to_owned)
        })
        .collect();
    stems.sort();
    let mut scan = Scan {
        entries: stems.len(),
        planned: Vec::new(),
        kept: Vec::new(),
        bytes: 0,
    };
    let mut taken = BTreeSet::new();
    for stem in stems {
        let keep = |scan: &mut Scan, reason| {
            scan.kept.push(Kept {
                id: stem.clone(),
                reason,
            });
        };
        let Some(entry) = read_manifest(&root.join(format!("{stem}.json")), &stem) else {
            keep(&mut scan, KeptReason::BrokenManifest);
            continue;
        };
        if !is_plain_relative(&entry.original_path) {
            keep(&mut scan, KeptReason::UnsafePath);
            continue;
        }
        if amby_sync_core::engine::history::is_service_path(&entry.original_path) {
            keep(&mut scan, KeptReason::Service);
            continue;
        }
        let payload = root.join(&stem).join(&entry.name);
        let Some((directory, files)) = facts_of(&payload) else {
            keep(&mut scan, KeptReason::NoPayload);
            continue;
        };
        let dest = free_archive_rel(&archive, &entry.original_path, &taken);
        taken.insert(dest.clone());
        scan.bytes += files.iter().map(|file| file.len).sum::<u64>();
        scan.planned.push(Planned {
            id: stem.clone(),
            name: entry.name,
            deleted_at_ms: entry.deleted_at_ms,
            dest,
            directory,
            files,
        });
    }
    scan
}

/// Looks, writes nothing (К9, К7).
pub fn preflight(vault: &Path) -> Result<Preflight, String> {
    let scan = scan(vault);
    Ok(Preflight {
        entries: scan.entries,
        to_move: scan.planned.len(),
        to_keep: scan.kept,
        bytes: scan.bytes,
    })
}

/// The migration as the application starts it (К11 (ж)): when the vault is opened and before a
/// synchronisation session. Looks first (К9: how many entries, how much), then runs. A failure is
/// logged and leaves everything in place: the journal resumes it at the next opening.
pub fn run_when_opening(vault: &Path) {
    if is_completed(vault) {
        return;
    }
    if let Ok(look) = preflight(vault) {
        tracing::info!(
            event = "archive_migration_preflight",
            entries = look.entries,
            to_move = look.to_move,
            kept = look.to_keep.len(),
            bytes = look.bytes
        );
    }
    match run(vault, &mut NoInterrupt) {
        Ok(outcome) => tracing::info!(
            event = "archive_migration_done",
            migrated = outcome.migrated,
            kept = outcome.kept.len()
        ),
        Err(error) => tracing::warn!(event = "archive_migration_failed", error = ?error),
    }
}

// ----- the run -----

/// Has the migration finished on this vault (the marker of К9)?
pub fn is_completed(vault: &Path) -> bool {
    read_json::<Marker>(&marker_path(vault))
        .is_some_and(|marker| marker.version == MIGRATION_VERSION)
}

/// The outcome recorded by a finished run (К9).
pub fn recorded_outcome(vault: &Path) -> Option<Outcome> {
    let marker = read_json::<Marker>(&marker_path(vault))?;
    Some(Outcome {
        migrated: marker.migrated,
        kept: from_notes(&marker.kept),
    })
}

fn record_id(entry_id: &str, index: usize) -> String {
    format!("{entry_id}-{index}")
}

fn archive_path_of(entry: &Planned, file: &FileFact) -> String {
    if file.rel.is_empty() {
        entry.dest.clone()
    } else {
        format!("{}/{}", entry.dest, file.rel)
    }
}

fn step_file(vault: &Path, id: &str) -> PathBuf {
    steps_dir(vault).join(id)
}

/// Runs the migration, or resumes an interrupted one from the step it stopped at, or does nothing
/// when it is completed (К9). Moves each movable entry of `.amby/trash/` into
/// `.amby/archive/<original path>` by renaming (a free name when taken, К7) with the record of К8
/// (`archivedAtMs` = the old `deletedAtMs`), one entry at a time, noting each step in the journal.
/// Entries that cannot move stay and are written to the outcome with a code (К7). Nothing is
/// deleted.
pub fn run(vault: &Path, interrupt: &mut dyn Interrupt) -> Result<Outcome, RunError> {
    if let Some(outcome) = recorded_outcome(vault) {
        if is_completed(vault) {
            return Ok(outcome);
        }
    }
    let journal = match read_json::<Journal>(&journal_path(vault)) {
        Some(journal) if journal.version == MIGRATION_VERSION => journal,
        _ => {
            let scan = scan(vault);
            let journal = Journal {
                kind: MIGRATION_KIND.to_string(),
                version: MIGRATION_VERSION,
                started_at_ms: crate::archive::now_ms(),
                entries: scan.planned,
                kept: to_notes(&scan.kept),
            };
            write_json(&journal_path(vault), &journal)?;
            journal
        }
    };
    if interrupt.at(&Point::JournalWritten) {
        return Err(RunError::Interrupted);
    }
    let mut vanished = 0;
    for entry in &journal.entries {
        let done = step_file(vault, &entry.id);
        if let Ok(state) = fs::read_to_string(&done) {
            vanished += usize::from(state.trim() == "vanished");
            continue;
        }
        if !move_entry(vault, entry, interrupt)? {
            vanished += 1;
        }
    }
    if interrupt.at(&Point::BeforeMarker) {
        return Err(RunError::Interrupted);
    }
    let mut kept = from_notes(&journal.kept);
    // A payload that was gone when its turn came is reported as one without content (К7).
    for entry in &journal.entries {
        if fs::read_to_string(step_file(vault, &entry.id))
            .is_ok_and(|state| state.trim() == "vanished")
        {
            kept.push(Kept {
                id: entry.id.clone(),
                reason: KeptReason::NoPayload,
            });
        }
    }
    let marker = Marker {
        kind: MIGRATION_KIND.to_string(),
        version: MIGRATION_VERSION,
        completed_at_ms: crate::archive::now_ms(),
        migrated: journal.entries.len() - vanished,
        kept: to_notes(&kept),
    };
    write_json(&marker_path(vault), &marker)?;
    Ok(Outcome {
        migrated: marker.migrated,
        kept,
    })
}

/// One entry: the rename, the records of К8, the old description moved under the migration, the
/// mark in the journal. Each step looks at the files themselves, so a repeat after a crash goes on
/// from where the last run stopped. `false`: the content was gone from both places.
fn move_entry(
    vault: &Path,
    entry: &Planned,
    interrupt: &mut dyn Interrupt,
) -> Result<bool, RunError> {
    let archive = archive_root(vault);
    let container = trash_root(vault).join(&entry.id);
    let source = container.join(&entry.name);
    let target = archive.join(&entry.dest);
    if interrupt.at(&Point::BeforeMove(entry.id.clone())) {
        return Err(RunError::Interrupted);
    }
    let in_trash = fs::symlink_metadata(&source).is_ok();
    let in_archive = fs::symlink_metadata(&target).is_ok();
    if in_trash {
        if in_archive {
            return Err(RunError::Failed(format!(
                "the archive place of {} is taken",
                entry.dest
            )));
        }
        let parent_rel = match entry.dest.rfind('/') {
            Some(at) => format!(".amby/archive/{}", &entry.dest[..at]),
            None => ".amby/archive".to_string(),
        };
        let parent = crate::paths::confine_rel_no_symlinks(vault, &parent_rel)?;
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
        fs::rename(&source, &target).map_err(|error| error.to_string())?;
    } else if !in_archive {
        write_step(vault, &entry.id, "vanished")?;
        return Ok(false);
    }
    if interrupt.at(&Point::AfterMove(entry.id.clone())) {
        return Err(RunError::Interrupted);
    }
    for (index, file) in entry.files.iter().enumerate() {
        write_meta(
            vault,
            &record_id(&entry.id, index),
            &archive_path_of(entry, file),
            entry.deleted_at_ms,
        )?;
    }
    if interrupt.at(&Point::AfterRecord(entry.id.clone())) {
        return Err(RunError::Interrupted);
    }
    let manifest = trash_root(vault).join(format!("{}.json", entry.id));
    if fs::symlink_metadata(&manifest).is_ok() {
        fs::create_dir_all(manifests_dir(vault)).map_err(|error| error.to_string())?;
        fs::rename(
            &manifest,
            manifests_dir(vault).join(format!("{}.json", entry.id)),
        )
        .map_err(|error| error.to_string())?;
    }
    // Only an empty folder goes: `remove_dir` refuses one that holds anything.
    let _ = fs::remove_dir(&container);
    write_step(vault, &entry.id, "moved")?;
    Ok(true)
}

fn write_step(vault: &Path, id: &str, state: &str) -> Result<(), String> {
    atomic_write_bytes(&step_file(vault, id), state.as_bytes())
}

// ----- the rollback -----

/// Is the content at `target` still the one the migration moved there?
fn still_ours(target: &Path, entry: &Planned) -> bool {
    let Ok(metadata) = fs::symlink_metadata(target) else {
        return false;
    };
    let same = |path: &Path, file: &FileFact| {
        fs::symlink_metadata(path)
            .is_ok_and(|meta| meta.len() == file.len && mtime_ms(&meta) == file.mtime_ms)
    };
    if entry.directory {
        // Some of the files may have been restored since: what is left goes back, if any of it is
        // still as the migration left it.
        metadata.is_dir()
            && entry
                .files
                .iter()
                .any(|file| same(&target.join(&file.rel), file))
    } else {
        !metadata.is_dir() && entry.files.first().is_some_and(|file| same(target, file))
    }
}

/// Puts every migrated entry back by reverse renames in the order of the journal (К9). The
/// migration is then not completed. A file that is no longer where the migration put it (restored,
/// moved, edited) is left alone and reported.
pub fn rollback(vault: &Path) -> Result<RollbackReport, String> {
    let Some(journal) = read_json::<Journal>(&journal_path(vault)) else {
        return Ok(RollbackReport {
            reverted: 0,
            skipped: Vec::new(),
        });
    };
    let archive = archive_root(vault);
    let mut report = RollbackReport {
        reverted: 0,
        skipped: Vec::new(),
    };
    for entry in &journal.entries {
        let container = trash_root(vault).join(&entry.id);
        let source = container.join(&entry.name);
        let target = archive.join(&entry.dest);
        if fs::symlink_metadata(&source).is_ok() {
            // Never moved (the run stopped before it): nothing to undo.
            continue;
        }
        if !still_ours(&target, entry) {
            report.skipped.push(entry.id.clone());
            continue;
        }
        fs::create_dir_all(&container).map_err(|error| error.to_string())?;
        fs::rename(&target, &source).map_err(|error| error.to_string())?;
        let moved_manifest = manifests_dir(vault).join(format!("{}.json", entry.id));
        let manifest = trash_root(vault).join(format!("{}.json", entry.id));
        if fs::symlink_metadata(&moved_manifest).is_ok() && fs::symlink_metadata(&manifest).is_err()
        {
            fs::rename(&moved_manifest, &manifest).map_err(|error| error.to_string())?;
        }
        // The records are ours and made from the journal: they go with the files they described.
        for index in 0..entry.files.len() {
            let _ = fs::remove_file(
                crate::archive::meta_root(vault)
                    .join(format!("{}.json", record_id(&entry.id, index))),
            );
        }
        prune_empty(&archive, target.parent());
        report.reverted += 1;
    }
    // The run is kept as evidence next to the rest of the migration; a later run starts afresh.
    let evidence = migration_dir(vault).join(format!("rolled-back-{}", crate::archive::now_ms()));
    fs::create_dir_all(&evidence).map_err(|error| error.to_string())?;
    for name in ["plan.json", "completed.json", "steps"] {
        let from = migration_dir(vault).join(name);
        if fs::symlink_metadata(&from).is_ok() {
            fs::rename(&from, evidence.join(name)).map_err(|error| error.to_string())?;
        }
    }
    Ok(report)
}

fn prune_empty(root: &Path, mut dir: Option<&Path>) {
    while let Some(current) = dir {
        if current == root || !current.starts_with(root) || fs::remove_dir(current).is_err() {
            break;
        }
        dir = current.parent();
    }
}

#[cfg(test)]
#[path = "archive_migration_tests.rs"]
mod tests;

#[cfg(test)]
mod coexistence_tests {
    use super::*;
    use crate::archive::test_support::Vault;

    #[test]
    fn the_journal_never_has_the_name_the_properties_migration_looks_for() {
        // `property_groups::migration::unfinished` takes any folder of `.amby/migrations/` that has
        // `journal.json` and no `outcome.json` for its own unfinished migration.
        let vault = Vault::new();
        vault.put(".amby/trash/01.json", b"{broken");
        run(&vault.root, &mut NoInterrupt).unwrap();
        assert!(
            vault
                .files()
                .keys()
                .all(|path| !path.starts_with(".amby/migrations/")
                    || !path.ends_with("/journal.json"))
        );
        assert!(is_completed(&vault.root));
    }
}
