//! A read-only view of visible Markdown notes for headless clients.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use walkdir::{DirEntry, WalkDir};

use super::{snapshot, IndexedNote, SearchResult, TagEntry};
use crate::ai_tools::{resolve_note_path, safe_folder, ToolBudget, ToolScope};
use crate::vault::scan::{
    file_name, is_markdown, is_service_directory, metadata_stamp, normalize_rel_path,
};
use serde_json::Value;

const UNAVAILABLE: &str = "unavailable";

enum Catalog {
    Snapshot(snapshot::IndexSnapshot),
    Memory(Connection),
}

pub struct ReadVault {
    root: PathBuf,
    catalog: Catalog,
}

pub struct ReadLink {
    pub other: Option<IndexedNote>,
    pub target: String,
    pub label: String,
}

impl ReadVault {
    pub fn open(root: &Path) -> Result<Self, &'static str> {
        let root = root.canonicalize().map_err(|_| "vaultNotFound")?;
        if !root.is_dir() {
            return Err("vaultNotFound");
        }
        let catalog = match snapshot::open(&root, || false) {
            Ok(index) if fresh(&root, &index).unwrap_or(false) => Catalog::Snapshot(index),
            _ => Catalog::Memory(disk_catalog(&root).map_err(|_| UNAVAILABLE)?),
        };
        Ok(Self { root, catalog })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn conn(&self) -> &Connection {
        match &self.catalog {
            Catalog::Snapshot(index) => index,
            Catalog::Memory(index) => index,
        }
    }

    pub fn notes(&self) -> Result<Vec<IndexedNote>, &'static str> {
        super::list_notes(self.conn(), &self.root).map_err(|_| UNAVAILABLE)
    }

    pub(crate) fn plan_rewrites(
        &self,
        changes: &[crate::model::PathChange],
    ) -> Result<Vec<super::PlannedWikiRewrite>, String> {
        super::plan_inbound_wiki_rewrites(self.conn(), &self.root, changes)
    }

    pub fn search(&self, query: &str) -> Result<Vec<SearchResult>, &'static str> {
        super::search_notes(self.conn(), &self.root, query).map_err(|_| UNAVAILABLE)
    }

    /// Search narrowed by tags, header properties and a folder.
    pub fn find(&self, filter: &super::NoteFilter) -> Result<Vec<SearchResult>, &'static str> {
        safe_folder(&self.root, &filter.folder)?;
        super::find_notes(self.conn(), &self.root, filter).map_err(|_| UNAVAILABLE)
    }

    /// Visible notes no other note links to.
    pub fn orphans(&self, folder: &str, limit: usize) -> Result<Value, &'static str> {
        crate::vault_tools::hygiene::orphans(self.conn(), &self.root, folder, limit)
    }

    /// Links to notes that do not exist.
    pub fn unresolved(&self, folder: &str, limit: usize) -> Result<Value, &'static str> {
        crate::vault_tools::hygiene::unresolved(self.conn(), &self.root, folder, limit)
    }

    /// A summary of one note.
    pub fn info(&self, note: &IndexedNote) -> Result<Value, &'static str> {
        crate::vault_tools::hygiene::info(self.conn(), &self.root, note)
    }

    /// The note with this ID or vault-relative path.
    pub fn note(&self, reference: &str) -> Result<IndexedNote, &'static str> {
        if let Ok(note) = super::note_by_id(self.conn(), &self.root, reference) {
            return Ok(note);
        }
        let id: String = self
            .conn()
            .query_row(
                "SELECT id FROM notes WHERE path = ?1",
                [reference.replace('\\', "/")],
                |row| row.get(0),
            )
            .map_err(|_| "notFound")?;
        super::note_by_id(self.conn(), &self.root, &id).map_err(|_| "notFound")
    }

    /// The properties of the note at a vault-relative path (docs/cli.md).
    pub fn properties(&self, path: &str) -> Result<Value, &'static str> {
        crate::vault_tools::properties::read(self.conn(), &self.root, path)
    }

    pub fn tags(&self) -> Result<Vec<TagEntry>, &'static str> {
        super::list_tags(self.conn(), &self.root).map_err(|_| UNAVAILABLE)
    }

    pub fn links(&self, id: &str, incoming: bool) -> Result<Vec<ReadLink>, &'static str> {
        let condition = if incoming {
            "l.target_note_id = ?1"
        } else {
            "l.note_id = ?1"
        };
        let mut statement = self
            .conn()
            .prepare(&format!(
            "SELECT l.note_id, l.target_note_id, l.target, l.label FROM links l WHERE {condition}
             ORDER BY l.note_id, l.target, l.label"
        ))
            .map_err(|_| UNAVAILABLE)?;
        let rows = statement
            .query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|_| UNAVAILABLE)?;
        rows.map(|row| {
            let (source, destination, target, label) = row.map_err(|_| UNAVAILABLE)?;
            let other = if incoming { Some(source) } else { destination };
            let note = other
                .map(|id| super::note_by_id(self.conn(), &self.root, &id))
                .transpose()
                .map_err(|_| UNAVAILABLE)?;
            Ok(ReadLink {
                other: note,
                target,
                label,
            })
        })
        .collect()
    }

    pub fn tool(&self, name: &str, args: &Value) -> Value {
        let scope = ToolScope {
            search_enabled: true,
            note_ids: HashSet::new(),
            folders: Vec::new(),
            writes: crate::ai_tools::Writes::Off,
        };
        ToolBudget::default().execute(self.conn(), &self.root, &scope, name, args)
    }
}

pub fn visible_folder(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    safe_folder(root, relative)
}

pub fn visible_note(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    let path = resolve_note_path(root, relative)?;
    if !is_markdown(&path) || file_name(&path) == "Metadata.md" {
        return Err("notFound");
    }
    Ok(path)
}

fn visible(entry: &DirEntry) -> bool {
    entry.depth() == 0
        || ((entry.file_type().is_dir() || entry.file_type().is_file())
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| !name.starts_with('.') && !is_service_directory(name)))
}

fn fresh(root: &Path, index: &Connection) -> Result<bool, String> {
    // A matching path set and nanosecond stamps make the snapshot reusable.
    // Older schemas, conflicts and unreadable paths use the disk view.
    let version: String = index
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'identity_version'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if version != "4" {
        return Ok(false);
    }
    let mut stamps = super::db_path_stamps(index)?;
    if super::db_snapshot(index)?.1.len() != stamps.len() {
        return Ok(false);
    }
    for entry in WalkDir::new(root).into_iter().filter_entry(visible) {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !entry.file_type().is_file() || !is_markdown(path) || file_name(path) == "Metadata.md" {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map(normalize_rel_path)
            .map_err(|error| error.to_string())?;
        let Some((_, mtime, size)) = stamps.remove(&relative) else {
            return Ok(false);
        };
        let stamp = metadata_stamp(path)?;
        if (stamp.mtime_ns, stamp.size) != (Some(mtime), size) {
            return Ok(false);
        }
    }
    Ok(stamps.is_empty())
}

pub(crate) fn disk_catalog(root: &Path) -> Result<Connection, String> {
    // Use the same search/tag/link semantics as the app. This private SQLite
    // connection has no path, and the indexer's identity writer is never called.
    let mut conn = Connection::open_in_memory().map_err(|error| error.to_string())?;
    conn.execute_batch("PRAGMA temp_store = MEMORY;")
        .map_err(|error| error.to_string())?;
    super::init_schema(&conn)?;
    let entries = WalkDir::new(root).into_iter().filter_entry(visible);
    let mut warnings = Vec::new();
    let mut notes = super::sync::scan_disk_entries(
        root,
        &HashMap::new(),
        &mut Vec::new(),
        &mut warnings,
        entries,
    )?;
    notes.sort_by_key(|note| super::is_sync_conflict_copy(&note.rel_path));
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    for note in notes {
        let id = if note.parsed_id.is_none()
            && note.identity_error.is_none()
            && !note.frontmatter_status.is_malformed()
        {
            format!("unindexed:{}", note.rel_path)
        } else {
            super::sync::resolve_scanned_id(root, &note, &seen, &mut warnings).0
        };
        super::sync::upsert_scanned_note(&tx, &id, &note)?;
        seen.insert(id);
    }
    super::resolve_links(&tx)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(conn)
}

/// List one directory without following aliases or exposing service paths.
pub fn list_visible(root: &Path, relative: &str) -> Result<Vec<(String, bool)>, &'static str> {
    let folder = safe_folder(root, relative)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(folder).map_err(|_| UNAVAILABLE)? {
        let entry = entry.map_err(|_| UNAVAILABLE)?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') || is_service_directory(&name) {
            continue;
        }
        let kind = entry.file_type().map_err(|_| UNAVAILABLE)?;
        if kind.is_dir() || (kind.is_file() && is_markdown(&entry.path()) && name != "Metadata.md")
        {
            entries.push((name, kind.is_dir()));
        }
    }
    entries.sort();
    Ok(entries)
}
