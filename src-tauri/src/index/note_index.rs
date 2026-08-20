use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
#[cfg(test)]
use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use ulid::Ulid;

use super::links::{extract_links, resolve_links_for_note};
use super::tags::extract_tags;
use crate::frontmatter;
use crate::history;
use crate::vault::scan::*;

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexedNote {
    pub id: String,
    pub path: String,
    pub title: String,
    pub modified: Option<u64>,
    pub word_count: usize,
}

pub struct PreparedNoteIndex {
    pub note_id: String,
    pub rel_path: String,
    pub title: String,
    pub mtime: i64,
    pub size: i64,
    pub body: String,
    pub frontmatter_tags: Vec<String>,
    pub links: Vec<(String, String, String)>,
}

#[cfg(test)]
thread_local! {
    static INDEX_FAILURE_STAGE: Cell<Option<u8>> = const { Cell::new(None) };
}

#[cfg(test)]
pub fn fail_next_index_stage(stage: u8) {
    INDEX_FAILURE_STAGE.with(|configured| configured.set(Some(stage)));
}

#[cfg(test)]
pub fn check_index_failure(stage: u8) -> Result<(), String> {
    INDEX_FAILURE_STAGE.with(|configured| {
        if configured.get() == Some(stage) {
            configured.set(None);
            Err(format!("injected index failure at SQL stage {stage}"))
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
pub fn check_index_failure(_stage: u8) -> Result<(), String> {
    Ok(())
}

pub fn list_notes(conn: &Connection, vault: &Path) -> Result<Vec<IndexedNote>, String> {
    let mut stmt = conn
        .prepare("SELECT id, path, title, mtime, word_count FROM notes ORDER BY path")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let rel_path: String = row.get(1)?;
            Ok(IndexedNote {
                id: row.get(0)?,
                path: path_string(&abs_from_rel(vault, &rel_path)),
                title: row.get(2)?,
                modified: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                word_count: row.get::<_, i64>(4)? as usize,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn note_by_id(conn: &Connection, vault: &Path, note_id: &str) -> Result<IndexedNote, String> {
    conn.query_row(
        "SELECT id, path, title, mtime, word_count FROM notes WHERE id = ?1",
        [note_id],
        |row| {
            let rel_path: String = row.get(1)?;
            Ok(IndexedNote {
                id: row.get(0)?,
                path: path_string(&abs_from_rel(vault, &rel_path)),
                title: row.get(2)?,
                modified: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                word_count: row.get::<_, i64>(4)? as usize,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Note not found: {note_id}"))
}

pub fn read_note(conn: &Connection, vault: &Path, note_id: &str) -> Result<String, String> {
    let note = note_by_id(conn, vault, note_id)?;
    frontmatter::read_markdown(Path::new(&note.path)).map(|parsed| {
        // Normalize CRLF → LF for the frontend.  The editor works exclusively
        // with LF; `preserve_text_format` converts back on write.  Without
        // this, the watcher reads CRLF from disk while the editor holds LF,
        // triggering false external-conflict detection that pauses autosave.
        if parsed.body.contains("\r\n") {
            parsed.body.replace("\r\n", "\n")
        } else {
            parsed.body
        }
    })
}

pub fn note_properties(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<crate::model::NoteProperties, String> {
    let note = note_by_id(conn, vault, note_id)?;
    let content = fs::read_to_string(&note.path).map_err(|error| error.to_string())?;
    let mut properties = frontmatter::note_properties(&content);
    properties.custom_properties = crate::property_store::list(conn, note_id)?;
    Ok(properties)
}

pub fn upsert_note_index(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    body: &str,
    note_path: &Path,
) -> Result<(), String> {
    let prepared = prepare_note_index(vault, note_id, body, note_path)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    apply_prepared_note_index(&tx, &prepared)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn prepare_note_index(
    vault: &Path,
    note_id: &str,
    body: &str,
    note_path: &Path,
) -> Result<PreparedNoteIndex, String> {
    let (mtime, size) = metadata_stamp(note_path)?;
    let rel_path = note_path
        .strip_prefix(vault)
        .map(normalize_rel_path)
        .map_err(|e| e.to_string())?;
    let title = title_for(note_path, body);
    let frontmatter_tags = frontmatter::read_markdown(note_path)
        .map(|parsed| parsed.frontmatter_tags)
        .unwrap_or_default();

    Ok(PreparedNoteIndex {
        note_id: note_id.to_string(),
        rel_path,
        title,
        mtime,
        size,
        body: body.to_string(),
        frontmatter_tags,
        links: extract_links(body),
    })
}

pub fn apply_prepared_note_index(
    tx: &rusqlite::Transaction<'_>,
    prepared: &PreparedNoteIndex,
) -> Result<(), String> {
    let note_id = &prepared.note_id;

    tx.execute(
        r#"
        INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(id) DO UPDATE SET
            path       = excluded.path,
            title      = excluded.title,
            mtime      = excluded.mtime,
            size       = excluded.size,
            content    = excluded.content,
            word_count = excluded.word_count,
            updated_at = strftime('%s','now')
        "#,
        rusqlite::params![
            note_id,
            prepared.rel_path,
            prepared.title,
            prepared.mtime,
            prepared.size,
            prepared.body,
            word_count(&prepared.body) as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    check_index_failure(1)?;

    tx.execute("DELETE FROM tags WHERE note_id = ?1", [note_id])
        .map_err(|e| e.to_string())?;
    for tag in extract_tags(&prepared.body, &prepared.frontmatter_tags) {
        tx.execute(
            "INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?1, ?2)",
            rusqlite::params![note_id, tag],
        )
        .map_err(|e| e.to_string())?;
    }
    check_index_failure(2)?;

    tx.execute("DELETE FROM links WHERE note_id = ?1", [note_id])
        .map_err(|e| e.to_string())?;
    for (raw, target, label) in &prepared.links {
        tx.execute(
            "INSERT INTO links (note_id, raw, target, label, target_note_id) VALUES (?1, ?2, ?3, ?4, NULL)",
            rusqlite::params![note_id, raw, target, label],
        )
        .map_err(|e| e.to_string())?;
    }
    check_index_failure(3)?;

    check_index_failure(4)?;
    resolve_links_for_note(tx, note_id)?;

    Ok(())
}

pub fn write_note_filesystem(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    content: &str,
) -> Result<(PathBuf, String), String> {
    let note = note_by_id(conn, vault, note_id)?;
    let path = PathBuf::from(&note.path);
    let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let next = frontmatter::replace_body_preserving_id(&current, content, note_id)?;
    history::snapshot_before_write(vault, &path, next.as_bytes(), "note-save")?;
    frontmatter::atomic_write(&path, &next)?;
    let written = frontmatter::parse_markdown(&next);
    Ok((path, written.body))
}

pub fn note_metadata(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<IndexedNote, String> {
    note_by_id(conn, vault, note_id)
}

pub fn note_created_at(conn: &Connection, note_id: &str) -> Result<Option<u64>, String> {
    conn.query_row(
        "SELECT created_at FROM notes WHERE id = ?1",
        [note_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .map(|value| value.map(|timestamp| timestamp as u64))
    .map_err(|error| error.to_string())
}

pub fn note_path_for_id(conn: &Connection, vault: &Path, note_id: &str) -> Result<PathBuf, String> {
    let note = note_by_id(conn, vault, note_id)?;
    Ok(PathBuf::from(note.path))
}

pub fn relative_path(vault: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(vault)
        .map(normalize_rel_path)
        .map_err(|e| e.to_string())
}

pub fn prepare_note_at_path(
    conn: &Connection,
    vault: &Path,
    path: &Path,
) -> Result<PreparedNoteIndex, String> {
    let rel_path = relative_path(vault, path)?;
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let parsed = frontmatter::parse_markdown(&content);

    let existing_id = parsed.id.filter(|id| !id.is_empty());
    if let Some(id) = existing_id.as_deref() {
        if !is_amby_id(id) {
            return Err("Refusing to replace an existing non-Amby frontmatter id".to_string());
        }
    }
    let id = existing_id;
    if let Some(existing_id) = &id {
        let indexed_path: Option<String> = conn
            .query_row(
                "SELECT path FROM notes WHERE id = ?1",
                [existing_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if indexed_path
            .as_deref()
            .is_some_and(|indexed| indexed != rel_path)
        {
            return Err(format!(
                "Duplicate Amby id {existing_id}; the source file was left unchanged"
            ));
        }
    }

    let (id, body) = if let Some(id) = id {
        (id, parsed.body)
    } else {
        let id = Ulid::generate().to_string();
        let next = frontmatter::body_with_id(&content, &id)?;
        history::snapshot_before_write(vault, path, next.as_bytes(), "id-assignment")?;
        frontmatter::atomic_write(path, &next)?;
        let reparsed = frontmatter::parse_markdown(&next);
        (id, reparsed.body)
    };

    prepare_note_index(vault, &id, &body, path)
}

pub fn prepare_path_changes(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<Vec<PreparedNoteIndex>, String> {
    let mut prepared = Vec::new();
    for change in changes {
        if change.new_path.is_empty() {
            continue;
        }
        let new_path = Path::new(&change.new_path);
        if !is_markdown(new_path) {
            continue;
        }

        if change.old_path.is_empty() || !is_markdown(Path::new(&change.old_path)) {
            prepared.push(prepare_note_at_path(conn, vault, new_path)?);
            continue;
        }

        let old_rel = relative_path(vault, Path::new(&change.old_path))?;
        let id: Option<String> = conn
            .query_row("SELECT id FROM notes WHERE path = ?1", [&old_rel], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some(id) = id {
            let content = fs::read_to_string(new_path).map_err(|e| e.to_string())?;
            let body = frontmatter::parse_markdown(&content).body;
            prepared.push(prepare_note_index(vault, &id, &body, new_path)?);
        } else {
            prepared.push(prepare_note_at_path(conn, vault, new_path)?);
        }
    }
    Ok(prepared)
}

pub fn prepare_deleted_ids(
    conn: &Connection,
    vault: &Path,
    deleted_paths: &[String],
) -> Result<Vec<String>, String> {
    let mut deleted_ids = Vec::new();
    for path in deleted_paths {
        let path = Path::new(path);
        if !is_markdown(path) {
            continue;
        }
        let rel_path = relative_path(vault, path)?;
        let id: Option<String> = conn
            .query_row("SELECT id FROM notes WHERE path = ?1", [&rel_path], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(id) = id {
            deleted_ids.push(id);
        }
    }
    Ok(deleted_ids)
}

pub fn apply_deleted_ids(
    tx: &rusqlite::Transaction<'_>,
    deleted_ids: &[String],
) -> Result<(), String> {
    for id in deleted_ids {
        tx.execute(
            "UPDATE links SET target_note_id = NULL WHERE target_note_id = ?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM tags WHERE note_id = ?1", [id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM links WHERE note_id = ?1", [id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM notes WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn apply_prepared_index_updates(
    conn: &Connection,
    prepared_notes: &[PreparedNoteIndex],
    deleted_ids: &[String],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for prepared in prepared_notes {
        apply_prepared_note_index(&tx, prepared)?;
    }
    apply_deleted_ids(&tx, deleted_ids)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn index_apply_path_changes(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<(), String> {
    let prepared = prepare_path_changes(conn, vault, changes)?;
    apply_prepared_index_updates(conn, &prepared, &[])
}

pub fn index_apply_mutation(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
    deleted_paths: &[String],
) -> Result<Vec<String>, String> {
    let prepared = prepare_path_changes(conn, vault, changes)?;
    let deleted_ids = prepare_deleted_ids(conn, vault, deleted_paths)?;
    apply_prepared_index_updates(conn, &prepared, &deleted_ids)?;
    Ok(deleted_ids)
}

pub fn note_id_for_path(
    conn: &Connection,
    vault: &Path,
    path: &Path,
) -> Result<Option<String>, String> {
    let rel_path = relative_path(vault, path)?;
    conn.query_row("SELECT id FROM notes WHERE path = ?1", [&rel_path], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

pub fn index_update_note(
    conn: &Connection,
    vault: &Path,
    path: &Path,
    content: &str,
) -> Result<(), String> {
    let parsed = frontmatter::parse_markdown(content);
    let note_id = parsed
        .id
        .ok_or_else(|| "Note does not have a frontmatter ID".to_string())?;
    upsert_note_index(conn, vault, &note_id, &parsed.body, path)
}
