use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use ulid::Ulid;

use super::identity::{
    conflict_id, ensure_unique_identity, is_path_identity, opaque_id, OPAQUE_PREFIX,
    OPAQUE_SOURCE_PREFIX,
};
use super::links::{extract_links, resolve_links_for_note};
use super::tags::extract_tags;
use crate::frontmatter;
use crate::history;
use crate::model::{NoteReadOutcome, WriteNoteError};
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
    pub mtime_ns: Option<i64>,
    pub size: i64,
    pub body: String,
    pub frontmatter_tags: Vec<String>,
    pub links: Vec<(String, String, String)>,
}

pub struct PreparedNoteWrite {
    pub path: PathBuf,
    pub next: String,
    pub body: String,
    pub preserve_opaque_bytes: bool,
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

pub fn body_revision(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

pub fn read_note(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<NoteReadOutcome, String> {
    let note = note_by_id(conn, vault, note_id)?;
    fs::read_to_string(Path::new(&note.path))
        .map(|source| {
            let parsed = frontmatter::parse_markdown(&source);
            // Normalize CRLF → LF for the frontend.  The editor works exclusively
            // with LF; `preserve_text_format` converts back on write.  Without
            // this, the watcher reads CRLF from disk while the editor holds LF,
            // triggering false external-conflict detection that pauses autosave.
            let revision = body_revision(if note_id.starts_with(OPAQUE_PREFIX) {
                &source
            } else {
                &parsed.body
            });
            let editor_content = if note_id.starts_with(OPAQUE_SOURCE_PREFIX) {
                source.clone()
            } else {
                parsed.body
            };
            let content = if editor_content.contains("\r\n") {
                editor_content.replace("\r\n", "\n")
            } else {
                editor_content
            };
            NoteReadOutcome {
                content,
                revision,
                source,
            }
        })
        .map_err(|error| error.to_string())
}

pub fn note_properties(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<crate::model::NoteProperties, String> {
    let note = note_by_id(conn, vault, note_id)?;
    let content = fs::read_to_string(&note.path).map_err(|error| error.to_string())?;
    let mut properties = frontmatter::note_properties(&content);
    let parsed = frontmatter::parse_markdown(&content);
    if parsed.frontmatter_status.is_malformed() {
        properties.body_read_only = note_id
            != opaque_id(
                &relative_path(vault, Path::new(&note.path))?,
                parsed.frontmatter_status,
            );
        return Ok(properties);
    }
    if let Err(error) = ensure_unique_identity(conn, note_id) {
        properties.parse_error = Some(error);
        properties.body_read_only = true;
        return Ok(properties);
    }
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
    let FileStamp {
        mtime,
        mtime_ns,
        size,
    } = metadata_stamp(note_path)?;
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
        mtime_ns,
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
        "DELETE FROM notes WHERE path = ?1 AND id <> ?2",
        rusqlite::params![prepared.rel_path, note_id],
    )
    .map_err(|error| error.to_string())?;

    tx.execute(
        r#"
        INSERT INTO notes (id, path, title, mtime, size, content, word_count, mtime_ns, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(id) DO UPDATE SET
            path       = excluded.path,
            title      = excluded.title,
            mtime      = excluded.mtime,
            mtime_ns   = excluded.mtime_ns,
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
            word_count(&prepared.body) as i64,
            prepared.mtime_ns
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

pub fn prepare_note_write(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    content: &str,
    expected_revision: &str,
) -> Result<PreparedNoteWrite, WriteNoteError> {
    let opaque = note_id.starts_with(OPAQUE_PREFIX);
    if !opaque {
        ensure_unique_identity(conn, note_id).map_err(WriteNoteError::failed)?;
    }
    let note = note_by_id(conn, vault, note_id).map_err(WriteNoteError::failed)?;
    let path = PathBuf::from(&note.path);
    let current =
        fs::read_to_string(&path).map_err(|error| WriteNoteError::failed(error.to_string()))?;
    let current_body = frontmatter::parse_markdown(&current).body;
    let actual_revision = body_revision(if opaque { &current } else { &current_body });
    if expected_revision != actual_revision {
        return Err(WriteNoteError::RevisionConflict { actual_revision });
    }
    let next = if opaque {
        prepare_opaque_note_text(vault, &path, note_id, &current, content)
    } else {
        frontmatter::replace_body_preserving_id(&current, content, note_id)
    }
    .map_err(WriteNoteError::failed)?;
    let body = frontmatter::parse_markdown(&next).body;
    Ok(PreparedNoteWrite {
        path,
        next,
        body,
        preserve_opaque_bytes: opaque,
    })
}

/// Validate the cache key against the current path and malformed envelope before
/// permitting a body edit. Never trust a stale alias after external YAML repair.
pub fn prepare_opaque_note_text(
    vault: &Path,
    path: &Path,
    note_id: &str,
    current: &str,
    content: &str,
) -> Result<String, String> {
    let parsed = frontmatter::parse_markdown(current);
    if !parsed.frontmatter_status.is_malformed()
        || note_id != opaque_id(&relative_path(vault, path)?, parsed.frontmatter_status)
    {
        return Err(
            "The frontmatter boundary or identity changed; refresh and reopen the note".into(),
        );
    }
    if note_id.starts_with(OPAQUE_SOURCE_PREFIX) {
        // With no closing delimiter there is no safe body boundary. This is an
        // explicit full-source edit, never an automatic YAML repair or ID write.
        String::from_utf8(frontmatter::text_bytes_from_template(current, content)?)
            .map_err(|error| error.to_string())
    } else {
        frontmatter::replace_body_preserving_opaque_frontmatter(current, content)
    }
}

pub fn commit_prepared_note_write(
    vault: &Path,
    prepared: PreparedNoteWrite,
) -> Result<(PathBuf, String, String), WriteNoteError> {
    history::snapshot_before_write(vault, &prepared.path, prepared.next.as_bytes(), "note-save")
        .map_err(WriteNoteError::failed)?;
    if prepared.preserve_opaque_bytes {
        frontmatter::atomic_write_bytes(&prepared.path, prepared.next.as_bytes())
    } else {
        frontmatter::atomic_write(&prepared.path, &prepared.next)
    }
    .map_err(WriteNoteError::failed)?;
    // atomic_write restores a note's original BOM/line-ending convention. Read
    // back the persisted body so the returned CAS token hashes the actual bytes,
    // not the frontend-normalised LF buffer.
    let persisted = fs::read_to_string(&prepared.path)
        .map_err(|error| WriteNoteError::failed(error.to_string()))?;
    let persisted_body = frontmatter::parse_markdown(&persisted).body;
    let revision = body_revision(if prepared.preserve_opaque_bytes {
        &persisted
    } else {
        &persisted_body
    });
    Ok((prepared.path, prepared.body, revision))
}

pub fn write_note_filesystem(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    content: &str,
    expected_revision: &str,
) -> Result<(PathBuf, String, String), WriteNoteError> {
    let prepared = prepare_note_write(conn, vault, note_id, content, expected_revision)?;
    commit_prepared_note_write(vault, prepared)
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

    if parsed.frontmatter_status.is_malformed() {
        return prepare_note_index(
            vault,
            &opaque_id(&rel_path, parsed.frontmatter_status),
            &parsed.body,
            path,
        );
    }
    if parsed.indexing_identity_error().is_some() {
        return prepare_note_index(vault, &conflict_id(None, &rel_path), &parsed.body, path);
    }
    let id = parsed.note_id().map(str::to_string);
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
            .is_some_and(|indexed| indexed != rel_path && abs_from_rel(vault, indexed).is_file())
        {
            return prepare_note_index(
                vault,
                &conflict_id(Some(existing_id), &rel_path),
                &parsed.body,
                path,
            );
        }
    }

    let (id, body) = if let Some(id) = id {
        (id, parsed.body)
    } else {
        let id = Ulid::generate().to_string();
        let next = match frontmatter::body_with_id(&content, &id) {
            Ok(next) => next,
            Err(_) => {
                return prepare_note_index(vault, &conflict_id(None, &rel_path), &parsed.body, path)
            }
        };
        history::snapshot_before_write(vault, path, next.as_bytes(), "id-assignment")?;
        frontmatter::atomic_write_bytes(path, next.as_bytes())?;
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

        if let Some(id) = id.filter(|id| !is_path_identity(id)) {
            let content = fs::read_to_string(new_path).map_err(|e| e.to_string())?;
            let parsed = frontmatter::parse_markdown(&content);
            if parsed.frontmatter_status.is_malformed() {
                prepared.push(prepare_note_at_path(conn, vault, new_path)?);
            } else {
                prepared.push(prepare_note_index(vault, &id, &parsed.body, new_path)?);
            }
        } else {
            prepared.push(prepare_note_at_path(conn, vault, new_path)?);
        }
    }
    let mut identities = std::collections::HashSet::new();
    for note in &mut prepared {
        if !identities.insert(note.note_id.clone()) {
            note.note_id = conflict_id(Some(&note.note_id), &note.rel_path);
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
        .note_id()
        .ok_or_else(|| "Note does not have a frontmatter ID".to_string())?;
    ensure_unique_identity(conn, note_id)?;
    upsert_note_index(conn, vault, note_id, &parsed.body, path)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{body_revision, read_note, upsert_note_index, write_note_filesystem};
    use crate::index::open_connection;
    use crate::model::WriteNoteError;

    #[test]
    fn stale_renderer_revision_cannot_overwrite_a_newer_note_save() {
        let vault = std::env::temp_dir().join(format!("amby_note_cas_{}", ulid::Ulid::generate()));
        fs::create_dir_all(&vault).expect("create vault");
        let path = vault.join("Note.md");
        fs::write(
            &path,
            "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\ninitial\n",
        )
        .expect("write note");
        let conn = open_connection(&vault).expect("open index");
        upsert_note_index(
            &conn,
            &vault,
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "initial\n",
            &path,
        )
        .expect("index note");

        // Two independent renderer reads observe the same initial revision.
        let first_reader =
            read_note(&conn, &vault, "01ARZ3NDEKTSV4RRFFQ69G5FAV").expect("first read");
        let second_reader =
            read_note(&conn, &vault, "01ARZ3NDEKTSV4RRFFQ69G5FAV").expect("second read");
        assert_eq!(first_reader.revision, second_reader.revision);

        let (_, _, written_revision) = write_note_filesystem(
            &conn,
            &vault,
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "saved by first renderer\n",
            &first_reader.revision,
        )
        .expect("first writer succeeds");

        let error = write_note_filesystem(
            &conn,
            &vault,
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "stale second renderer buffer\n",
            &second_reader.revision,
        )
        .expect_err("stale writer must fail CAS");
        match error {
            WriteNoteError::RevisionConflict { actual_revision } => {
                assert_eq!(actual_revision, written_revision);
            }
            WriteNoteError::Failed { message } => panic!("unexpected write failure: {message}"),
        }
        assert_eq!(
            read_note(&conn, &vault, "01ARZ3NDEKTSV4RRFFQ69G5FAV")
                .expect("read saved note")
                .content,
            "saved by first renderer\n"
        );

        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn revision_hashes_the_actual_body_bytes_before_frontend_line_ending_normalization() {
        let body = "one\r\ntwo\r\n";
        assert_ne!(
            body_revision(body),
            body_revision(&body.replace("\r\n", "\n"))
        );
    }

    #[test]
    fn returned_revision_allows_the_next_save_when_crlf_is_preserved() {
        let vault =
            std::env::temp_dir().join(format!("amby_note_crlf_cas_{}", ulid::Ulid::generate()));
        fs::create_dir_all(&vault).expect("create vault");
        let path = vault.join("Note.md");
        fs::write(
            &path,
            "---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n---\r\none\r\n",
        )
        .expect("write note");
        let conn = open_connection(&vault).expect("open index");
        upsert_note_index(
            &conn,
            &vault,
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "one\r\n",
            &path,
        )
        .expect("index note");

        let initial = read_note(&conn, &vault, "01ARZ3NDEKTSV4RRFFQ69G5FAV").expect("read initial");
        assert_eq!(initial.content, "one\n");
        assert_eq!(
            initial.source,
            "---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n---\r\none\r\n"
        );
        let (_, _, first_revision) = write_note_filesystem(
            &conn,
            &vault,
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "two\n",
            &initial.revision,
        )
        .expect("first save");
        assert_eq!(
            read_note(&conn, &vault, "01ARZ3NDEKTSV4RRFFQ69G5FAV")
                .expect("read after first save")
                .revision,
            first_revision
        );
        write_note_filesystem(
            &conn,
            &vault,
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "three\n",
            &first_revision,
        )
        .expect("second save with returned revision");

        let _ = fs::remove_dir_all(vault);
    }
}
