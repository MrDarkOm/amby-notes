use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use ulid::Ulid;
use walkdir::WalkDir;

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
    let mut stmt = conn
        .prepare("SELECT path, id, mtime, size FROM notes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (path, id, mtime, size) = row.map_err(|e| e.to_string())?;
        map.insert(path, (id, mtime, size));
    }
    Ok(map)
}

pub fn scan_disk(
    vault: &Path,
    prev: &HashMap<String, (String, i64, i64)>,
    warnings: &mut Vec<String>,
) -> Result<Vec<ScannedNote>, String> {
    let mut notes = Vec::new();
    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(should_descend)
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() || !is_markdown(path) || file_name(path) == "Metadata.md" {
            continue;
        }
        let rel_path = path
            .strip_prefix(vault)
            .map(normalize_rel_path)
            .map_err(|e| e.to_string())?;
        let (mtime, size) = metadata_stamp(path)?;

        if let Some((id, prev_mtime, prev_size)) = prev.get(&rel_path) {
            if *prev_mtime == mtime && *prev_size == size {
                notes.push(ScannedNote {
                    path: path.to_path_buf(),
                    rel_path,
                    parsed_id: Some(id.clone()),
                    body: String::new(),
                    frontmatter_tags: Vec::new(),
                    mtime,
                    size,
                    unchanged: true,
                });
                continue;
            }
        }

        let parsed = match frontmatter::read_markdown(path) {
            Ok(parsed) => parsed,
            Err(err) => {
                warnings.push(format!("Failed to read {}: {err}", path_string(path)));
                continue;
            }
        };
        if parsed.has_frontmatter && !parsed.yaml_is_map {
            warnings.push(format!(
                "Skipped malformed frontmatter in {}",
                path_string(path)
            ));
            continue;
        }
        notes.push(ScannedNote {
            path: path.to_path_buf(),
            rel_path,
            parsed_id: parsed.id,
            body: parsed.body,
            frontmatter_tags: parsed.frontmatter_tags,
            mtime,
            size,
            unchanged: false,
        });
    }
    notes.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(notes)
}

pub fn sync_vault(conn: &Connection, vault: &Path) -> Result<SyncReport, String> {
    if !vault.is_dir() {
        return Err(format!("Not a directory: {}", path_string(vault)));
    }
    let (db_by_id, _db_by_path) = db_snapshot(conn)?;
    let prev = db_path_stamps(conn)?;
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
        if note.unchanged || note.parsed_id.as_deref().is_some_and(|id| !id.is_empty()) {
            continue;
        }
        let id = Ulid::generate().to_string();
        let content = fs::read_to_string(&note.path).map_err(|e| e.to_string())?;
        let next = frontmatter::body_with_id(&content, &id)?;
        history::snapshot_before_write(vault, &note.path, next.as_bytes(), "id-assignment")?;
        frontmatter::atomic_write(&note.path, &next)?;
        let parsed = frontmatter::parse_markdown(&next);
        let (mtime, size) = metadata_stamp(&note.path)?;
        note.parsed_id = Some(id);
        note.body = parsed.body;
        note.frontmatter_tags = parsed.frontmatter_tags;
        note.mtime = mtime;
        note.size = size;
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut seen_ids = HashSet::new();
    let mut seen_paths = HashSet::new();
    let mut inserted = 0;
    let mut updated = 0;
    let mut path_to_id = HashMap::new();

    for note in notes {
        if note.unchanged {
            if let Some(id) = note.parsed_id.clone() {
                seen_paths.insert(note.rel_path.clone());
                seen_ids.insert(id.clone());
                path_to_id.insert(path_string(&note.path), id);
                continue;
            }
        }

        let existing_id = note.parsed_id.clone().filter(|id| !id.is_empty());
        if let Some(id) = existing_id.as_deref() {
            if !is_amby_id(id) {
                warnings.push(format!(
                    "Skipped {}: existing frontmatter id is not an Amby ULID",
                    note.rel_path
                ));
                continue;
            }
            if seen_ids.contains(id) {
                warnings.push(format!(
                    "Skipped {}: duplicate Amby id {id} was left unchanged",
                    note.rel_path
                ));
                continue;
            }
        }

        let id = existing_id.expect("notes without IDs are prepared before the transaction");

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
        tx.execute(
            r#"
            INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s','now'), strftime('%s','now'))
            ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                title = excluded.title,
                mtime = excluded.mtime,
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
                word_count(&note.body) as i64
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
    let sync = sync_vault(conn, vault)?;
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
