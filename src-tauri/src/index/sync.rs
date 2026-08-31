use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use ulid::Ulid;
use walkdir::WalkDir;

use super::identity::{conflict_id, is_path_identity, opaque_id, CONFLICT_PREFIX};
use super::links::{extract_links, resolve_links};
use super::note_index::{list_notes, IndexedNote};
use super::tags::extract_tags;
use crate::frontmatter;
use crate::history;
use crate::vault::scan::*;
use crate::vault::tree::{build_tree, TreeItem};

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
    pub warnings: Vec<String>,
    pub path_to_id: HashMap<String, String>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoadVaultResult {
    pub generation: u64,
    pub vault_path: String,
    pub tree: Vec<TreeItem>,
    pub notes: Vec<IndexedNote>,
    pub sync: SyncReport,
}

pub type DbSnapshot = (HashMap<String, String>, HashMap<String, String>);

pub fn db_snapshot(conn: &Connection) -> Result<DbSnapshot, String> {
    let mut by_id = HashMap::new();
    let mut by_path = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT id, path FROM notes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, path) = row.map_err(|e| e.to_string())?;
        by_path.insert(path.clone(), id.clone());
        by_id.insert(id, path);
    }
    Ok((by_id, by_path))
}

pub fn db_path_stamps(conn: &Connection) -> Result<HashMap<String, (String, i64, i64)>, String> {
    let mut map = HashMap::new();
    let mut conflicted_ids = HashSet::new();
    let mut stmt = conn
        .prepare("SELECT path, id, mtime_ns, size FROM notes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (path, id, mtime, size) = row.map_err(|e| e.to_string())?;
        // Conflicts must be re-read so resolution and warnings survive reloads.
        if !is_path_identity(&id) {
            if let Some(mtime_ns) = mtime {
                map.insert(path, (id, mtime_ns, size));
            }
        } else if let Some((claimed, _)) = id
            .strip_prefix(CONFLICT_PREFIX)
            .and_then(|suffix| suffix.split_once(':'))
        {
            conflicted_ids.insert(claimed.to_string());
        }
    }
    map.retain(|_, (id, _, _)| !conflicted_ids.contains(id));
    Ok(map)
}

pub fn scan_disk(
    vault: &Path,
    prev: &HashMap<String, (String, i64, i64)>,
    warnings: &mut Vec<String>,
) -> Result<Vec<ScannedNote>, String> {
    let mut notes = Vec::new();
    for entry in WalkDir::new(vault).into_iter().filter_entry(should_descend) {
        let entry = entry.map_err(|error| format!("Cannot scan vault: {error}"))?;
        let path = entry.path();
        if !path.is_file() || !is_markdown(path) || file_name(path) == "Metadata.md" {
            continue;
        }
        let rel_path = path
            .strip_prefix(vault)
            .map(normalize_rel_path)
            .map_err(|e| e.to_string())?;
        let FileStamp {
            mtime,
            mtime_ns,
            size,
        } = metadata_stamp(path)?;

        if let Some((id, prev_mtime, prev_size)) = prev.get(&rel_path) {
            if Some(*prev_mtime) == mtime_ns && *prev_size == size {
                notes.push(ScannedNote {
                    frontmatter_status: crate::model::FrontmatterStatus::Valid,
                    path: path.to_path_buf(),
                    rel_path,
                    parsed_id: Some(id.clone()),
                    identity_error: None,
                    body: String::new(),
                    frontmatter_tags: Vec::new(),
                    mtime,
                    mtime_ns,
                    size,
                    unchanged: true,
                });
                continue;
            }
        }

        // Malformed YAML is recoverable text; I/O/encoding failure is not an
        // absent note. Abort before mutating SQLite so no cached note disappears.
        let parsed = frontmatter::read_markdown(path)
            .map_err(|error| format!("Failed to read {}: {error}", path_string(path)))?;
        if let Some(error) = &parsed.parse_error {
            warnings.push(format!(
                "Invalid frontmatter in {}: {error}; text remains indexed",
                path_string(path)
            ));
        }
        let parsed_id = parsed.note_id().map(str::to_string);
        notes.push(ScannedNote {
            frontmatter_status: parsed.frontmatter_status,
            path: path.to_path_buf(),
            rel_path,
            parsed_id,
            identity_error: parsed.indexing_identity_error(),
            body: parsed.body,
            frontmatter_tags: parsed.frontmatter_tags,
            mtime,
            mtime_ns,
            size,
            unchanged: false,
        });
    }
    notes.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(notes)
}

pub fn sync_vault(conn: &Connection, vault: &Path) -> Result<SyncReport, String> {
    sync_vault_with_changes(conn, vault, &HashSet::new())
}

pub fn sync_vault_with_changes(
    conn: &Connection,
    vault: &Path,
    changed_paths: &HashSet<PathBuf>,
) -> Result<SyncReport, String> {
    if !vault.is_dir() {
        return Err(format!("Not a directory: {}", path_string(vault)));
    }
    let (db_by_id, _db_by_path) = db_snapshot(conn)?;
    let identity_version: Option<String> = conn
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'identity_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    // Invalidate only the cache fast path once; do not rewrite legacy sources.
    let mut prev = if identity_version.as_deref() == Some("3") {
        db_path_stamps(conn)?
    } else {
        HashMap::new()
    };
    // A watcher event is stronger evidence than unchanged metadata. A folder
    // event covers descendants; the vault root represents an OS rescan request.
    // Ancestor lookups avoid O(notes * events) work during large import bursts.
    if !changed_paths.is_empty() {
        prev.retain(|path, _| {
            !abs_from_rel(vault, path)
                .ancestors()
                .any(|ancestor| changed_paths.contains(ancestor))
        });
    }
    let mut warnings = Vec::new();
    let mut notes = scan_disk(vault, &prev, &mut warnings)?;
    notes.sort_by_key(|note| {
        let priority = note
            .parsed_id
            .as_ref()
            .and_then(|id| db_by_id.get(id).map(|path| (path != &note.rel_path) as u8))
            .unwrap_or(1);
        (priority, note.rel_path.clone())
    });

    for note in &mut notes {
        if note.unchanged
            || note.parsed_id.is_some()
            || note.identity_error.is_some()
            || note.frontmatter_status.is_malformed()
        {
            continue;
        }
        let id = Ulid::generate().to_string();
        let content = fs::read_to_string(&note.path).map_err(|e| e.to_string())?;
        let next = match frontmatter::body_with_id(&content, &id) {
            Ok(next) => next,
            Err(error) => {
                note.identity_error = Some(error);
                continue;
            }
        };
        history::snapshot_before_write(vault, &note.path, next.as_bytes(), "id-assignment")?;
        frontmatter::atomic_write_bytes(&note.path, next.as_bytes())?;
        let parsed = frontmatter::parse_markdown(&next);
        let FileStamp {
            mtime,
            mtime_ns,
            size,
        } = metadata_stamp(&note.path)?;
        note.parsed_id = Some(id);
        note.body = parsed.body;
        note.frontmatter_tags = parsed.frontmatter_tags;
        note.mtime = mtime;
        note.mtime_ns = mtime_ns;
        note.size = size;
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut seen_ids = HashSet::new();
    let mut seen_paths = HashSet::new();
    let mut inserted = 0;
    let mut updated = 0;
    let mut path_to_id = HashMap::new();

    for note in notes {
        let claimed_id = note.parsed_id.as_deref();
        let duplicate = claimed_id.is_some_and(|id| seen_ids.contains(id));
        let id = if note.frontmatter_status.is_malformed() {
            opaque_id(&note.rel_path, note.frontmatter_status)
        } else if let Some(error) = &note.identity_error {
            warnings.push(format!(
                "{}: {error}; indexed with a path-scoped conflict key",
                note.rel_path
            ));
            conflict_id(None, &note.rel_path)
        } else if duplicate {
            warnings.push(format!(
                "{}: duplicate Amby id {}; source left unchanged",
                note.rel_path,
                claimed_id.unwrap()
            ));
            conflict_id(claimed_id, &note.rel_path)
        } else {
            note.parsed_id
                .clone()
                .expect("identity assigned before transaction")
        };
        if note.unchanged && !duplicate {
            seen_paths.insert(note.rel_path.clone());
            seen_ids.insert(id.clone());
            path_to_id.insert(path_string(&note.path), id);
            continue;
        }

        let existed: Option<String> = tx
            .query_row("SELECT id FROM notes WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if existed.is_some() {
            updated += 1;
        } else {
            inserted += 1;
        }

        let title = title_for(&note.path, &note.body);
        // Identity may have been repaired externally at this same path. The
        // old row is disposable; durable custom properties remain in sidecars.
        tx.execute(
            "DELETE FROM notes WHERE path = ?1 AND id <> ?2",
            params![note.rel_path, id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            r#"
            INSERT INTO notes (id, path, title, mtime, size, content, word_count, mtime_ns, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%s','now'), strftime('%s','now'))
            ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                title = excluded.title,
                mtime = excluded.mtime,
                mtime_ns = excluded.mtime_ns,
                size = excluded.size,
                content = excluded.content,
                word_count = excluded.word_count,
                updated_at = strftime('%s','now')
            "#,
            params![
                id,
                note.rel_path,
                title,
                note.mtime,
                note.size,
                note.body,
                word_count(&note.body) as i64,
                note.mtime_ns
            ],
        )
        .map_err(|e| e.to_string())?;

        tx.execute("DELETE FROM tags WHERE note_id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        for tag in extract_tags(&note.body, &note.frontmatter_tags) {
            tx.execute(
                "INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.execute("DELETE FROM links WHERE note_id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        for (raw, target, label) in extract_links(&note.body) {
            tx.execute(
                "INSERT INTO links (note_id, raw, target, label, target_note_id) VALUES (?1, ?2, ?3, ?4, NULL)",
                params![id, raw, target, label],
            )
            .map_err(|e| e.to_string())?;
        }

        seen_paths.insert(note.rel_path.clone());
        seen_ids.insert(id.clone());
        path_to_id.insert(path_string(&note.path), id);
    }

    let before_delete: i64 = tx
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let seen_vec: Vec<String> = seen_ids.into_iter().collect();
    if seen_vec.is_empty() {
        tx.execute("DELETE FROM notes", [])
            .map_err(|e| e.to_string())?;
    } else {
        let placeholders = (0..seen_vec.len())
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("DELETE FROM notes WHERE id NOT IN ({placeholders})");
        tx.execute(&sql, rusqlite::params_from_iter(seen_vec.iter()))
            .map_err(|e| e.to_string())?;
    }
    let after_delete: i64 = tx
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let deleted = before_delete.saturating_sub(after_delete) as usize;

    if inserted > 0 || updated > 0 || deleted > 0 {
        resolve_links(&tx)?;
    }
    tx.execute("INSERT INTO index_metadata (key, value) VALUES ('identity_version', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value", [])
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(SyncReport {
        inserted,
        updated,
        deleted,
        warnings,
        path_to_id,
    })
}

pub fn load_vault(conn: &Connection, vault: &Path) -> Result<LoadVaultResult, String> {
    load_vault_with_changes(conn, vault, &HashSet::new())
}

pub fn load_vault_with_changes(
    conn: &Connection,
    vault: &Path,
    changed_paths: &HashSet<PathBuf>,
) -> Result<LoadVaultResult, String> {
    let sync = sync_vault_with_changes(conn, vault, changed_paths)?;
    let notes = list_notes(conn, vault)?;
    let tree = build_tree(vault, &notes)?;
    Ok(LoadVaultResult {
        generation: 0,
        vault_path: path_string(vault),
        tree,
        notes,
        sync,
    })
}
