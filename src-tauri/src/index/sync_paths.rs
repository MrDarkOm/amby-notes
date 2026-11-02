//! Bring the index up to date for a handful of changed paths, without walking the vault.
//!
//! This is the same synchronisation as `sync_vault_with_changes` (the same reading of notes, the
//! same identity rules, the same writes), limited to the notes under the changed paths and to
//! the other notes whose identity they can affect. Whatever it cannot decide on its own it hands
//! back as `None`, and the caller runs the full synchronisation.

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::identity::{is_path_identity, is_sync_conflict_copy, CONFLICT_PREFIX};
use super::links::{build_note_lookup, resolve_links_for_note_with};
use super::sync::{
    assign_missing_identities, read_scanned_note, resolve_scanned_id, upsert_scanned_note,
    SyncReport,
};
use crate::vault::scan::*;

/// A change that touches more notes than this is a bulk import; the full scan is the right tool.
const MAX_SCOPED_NOTES: usize = 2_000;

fn is_indexed_name(vault: &Path, relative: &str) -> bool {
    let path = abs_from_rel(vault, relative);
    is_markdown(&path) && file_name(&path) != "Metadata.md"
}

/// Does the walk of the vault skip this relative path (a hidden or reserved folder or file)?
fn is_skipped(relative: &Path) -> bool {
    relative.components().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        name.starts_with('.') || is_reserved_directory(name.as_ref())
    })
}

pub fn sync_paths(
    conn: &Connection,
    vault: &Path,
    changed: &HashSet<PathBuf>,
) -> Result<Option<SyncReport>, String> {
    if !vault.is_dir() {
        return Err(format!("Not a directory: {}", path_string(vault)));
    }

    // 1. The notes to read: every note under a changed path that exists, and the paths whose
    //    rows have to be checked against the disk.
    let mut files = BTreeSet::<String>::new();
    let mut prefixes = BTreeSet::<String>::new();
    for path in changed {
        // A path that is not under the vault (another spelling of it, say) cannot be trusted to
        // mean nothing: the full scan decides.
        let Ok(relative) = path.strip_prefix(vault) else {
            return Ok(None);
        };
        if relative.as_os_str().is_empty() {
            return Ok(None);
        }
        if is_skipped(relative) {
            continue;
        }
        // The full scan never follows a symbolic link into a folder: only it decides about those.
        if path
            .ancestors()
            .take_while(|ancestor| *ancestor != vault)
            .any(|ancestor| {
                std::fs::symlink_metadata(ancestor)
                    .is_ok_and(|meta| meta.file_type().is_symlink() && ancestor.is_dir())
            })
        {
            return Ok(None);
        }
        let relative_path = normalize_rel_path(relative);
        if path.is_dir() {
            for entry in WalkDir::new(path).into_iter().filter_entry(should_descend) {
                let entry = entry.map_err(|error| format!("Cannot scan vault: {error}"))?;
                if !entry.path().is_file() {
                    continue;
                }
                let inner = entry
                    .path()
                    .strip_prefix(vault)
                    .map(normalize_rel_path)
                    .map_err(|error| error.to_string())?;
                if is_indexed_name(vault, &inner) {
                    files.insert(inner);
                }
                if files.len() > MAX_SCOPED_NOTES {
                    return Ok(None);
                }
            }
        } else if path.is_file() && is_indexed_name(vault, &relative_path) {
            files.insert(relative_path.clone());
        }
        prefixes.insert(relative_path);
    }

    // 2. The rows under those paths: they stay, move or go depending on what the disk shows.
    let mut rows = BTreeMap::<String, String>::new(); // path -> id
    for prefix in &prefixes {
        let mut statement = conn
            .prepare_cached(
                "SELECT path, id FROM notes WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
            )
            .map_err(|error| error.to_string())?;
        let found = statement
            .query_map(
                params![prefix, format!("{prefix}/"), format!("{prefix}0")],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows.extend(found);
        if rows.len() > MAX_SCOPED_NOTES {
            return Ok(None);
        }
    }

    // 3. Read the notes. A note that claims the id of a note outside the changed paths brings
    //    that note in, so the two are judged together exactly as a full scan judges them.
    let mut warnings = Vec::new();
    let mut notes = Vec::new();
    let mut scanned = BTreeSet::<String>::new();
    let mut queue = files.iter().cloned().collect::<Vec<_>>();
    while let Some(relative) = queue.pop() {
        if !scanned.insert(relative.clone()) {
            continue;
        }
        let path = abs_from_rel(vault, &relative);
        let FileStamp {
            mtime,
            mtime_ns,
            size,
        } = metadata_stamp(&path)?;
        let note = read_scanned_note(&path, relative, mtime, mtime_ns, size, &mut warnings)?;
        if let Some(claimed) = note
            .parsed_id
            .as_deref()
            .filter(|_| !note.frontmatter_status.is_malformed())
        {
            let holder: Option<String> = conn
                .query_row("SELECT path FROM notes WHERE id = ?1", [claimed], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some(holder) = holder.filter(|holder| {
                holder != &note.rel_path
                    && !scanned.contains(holder)
                    && !is_skipped(Path::new(holder))
                    && is_indexed_name(vault, holder)
                    && abs_from_rel(vault, holder).is_file()
            }) {
                queue.push(holder);
            }
        }
        notes.push(note);
        if notes.len() > MAX_SCOPED_NOTES {
            return Ok(None);
        }
    }

    // 4. The order a full scan uses: a note keeps its identity before a note that merely claims it.
    let mut db_by_id = HashMap::<String, String>::new();
    for note in &notes {
        if let Some(id) = &note.parsed_id {
            if let Some(path) = conn
                .query_row("SELECT path FROM notes WHERE id = ?1", [id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|error| error.to_string())?
            {
                db_by_id.insert(id.clone(), path);
            }
        }
    }
    notes.sort_by_key(|note| {
        let priority = note
            .parsed_id
            .as_ref()
            .and_then(|id| db_by_id.get(id).map(|path| (path != &note.rel_path) as u8))
            .unwrap_or(1);
        (
            is_sync_conflict_copy(&note.rel_path) as u8,
            priority,
            note.rel_path.clone(),
        )
    });
    assign_missing_identities(vault, &mut notes)?;

    // 5. Write.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut seen_ids = HashSet::new();
    let mut inserted = 0;
    let mut updated = 0;
    let mut path_to_id = HashMap::new();
    let mut upserted = Vec::new();
    for note in notes {
        let (id, _duplicate) = resolve_scanned_id(vault, &note, &seen_ids, &mut warnings);
        if upsert_scanned_note(&tx, &id, &note)? {
            updated += 1;
        } else {
            inserted += 1;
        }
        seen_ids.insert(id.clone());
        path_to_id.insert(path_string(&note.path), id.clone());
        upserted.push(id);
    }

    // Rows under the changed paths that no note on disk accounts for any more.
    let mut deleted = 0;
    for (path, id) in &rows {
        if seen_ids.contains(id) {
            continue;
        }
        // Another note claiming the id of one that goes would have to be promoted: that needs the
        // whole picture.
        if !is_path_identity(id) && has_conflict_rows(&tx, id)? {
            return Ok(None);
        }
        let _ = path;
        deleted += tx
            .execute("DELETE FROM notes WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
    }

    let lookup = build_note_lookup(&tx)?;
    for id in &upserted {
        resolve_links_for_note_with(&tx, id, &lookup)?;
    }
    tx.commit().map_err(|error| error.to_string())?;

    Ok(Some(SyncReport {
        inserted,
        updated,
        deleted,
        warnings,
        path_to_id,
    }))
}

/// Are there notes stored under a path key because they claim `id` too?
fn has_conflict_rows(conn: &Connection, id: &str) -> Result<bool, String> {
    let prefix = format!("{CONFLICT_PREFIX}{id}:");
    let upper = format!("{CONFLICT_PREFIX}{id};");
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM notes WHERE id >= ?1 AND id < ?2)",
        [prefix, upper],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|error| error.to_string())
}
