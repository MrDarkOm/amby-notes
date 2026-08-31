use std::fs;
use std::time::UNIX_EPOCH;

use crate::frontmatter;
use crate::history;
use crate::model::*;
use crate::paths;
use crate::property_store;
use crate::vault_context::VaultContext;
use crate::vault_index;
use crate::watcher::{self, WatcherState};

#[tauri::command]
#[specta::specta]
pub fn read_file(scope: tauri::State<paths::VaultScope>, path: String) -> Result<String, String> {
    let path = paths::guard(&scope, &path)?;
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    // Normalize CRLF → LF for the frontend; write path restores original endings.
    Ok(if content.contains("\r\n") {
        content.replace("\r\n", "\n")
    } else {
        content
    })
}

#[tauri::command]
#[specta::specta]
pub fn write_file(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let path = paths::guard(&scope, &path)?;
    let vault = scope.get()?;
    let expected =
        watcher::fingerprint_for_bytes(&frontmatter::text_bytes_for_write(&path, &content)?);
    let prepared = watcher_state.prepare_write([(&path, expected)]);
    let result = (|| {
        history::snapshot_before_write(&vault, &path, content.as_bytes(), "file-save")?;
        frontmatter::atomic_write(&path, &content)
    })();
    match result {
        Ok(()) => {
            watcher_state.confirm_prepared_write(&prepared);
            Ok(())
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared);
            Err(error)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn save_conflict_copy(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
    content: String,
) -> Result<String, String> {
    let original = paths::guard(&scope, &path)?;
    let parent = original
        .parent()
        .ok_or_else(|| "Cannot create a copy without a parent directory".to_string())?;
    let stem = original
        .file_stem()
        .ok_or_else(|| "Cannot create a copy without a filename".to_string())?
        .to_string_lossy();
    let extension = original
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();

    for _ in 0..1_000 {
        let conflict_id = ulid::Ulid::generate();
        let candidate = parent.join(format!("{stem}.{conflict_id}-conflict{extension}"));
        let prepared = watcher_state.prepare_write([(
            &candidate,
            watcher::fingerprint_for_bytes(content.as_bytes()),
        )]);
        match frontmatter::atomic_write_new(&candidate, &content) {
            Ok(()) => {
                watcher_state.confirm_prepared_write(&prepared);
                return Ok(candidate.to_string_lossy().to_string());
            }
            Err(frontmatter::AtomicCreateError::AlreadyExists) => {
                watcher_state.cancel_prepared_write(&prepared);
                continue;
            }
            Err(frontmatter::AtomicCreateError::Other(error)) => {
                watcher_state.cancel_prepared_write(&prepared);
                return Err(error);
            }
        }
    }
    Err("Could not allocate a unique random conflict-copy filename".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn read_note(
    db: tauri::State<'_, VaultContext>,
    note_id: String,
) -> Result<NoteReadOutcome, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::read_note(conn, &conn.root, &note_id)
}

#[tauri::command]
#[specta::specta]
pub fn write_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    request: WriteNoteRequest,
) -> Result<WriteNoteOutcome, WriteNoteError> {
    use tauri::Emitter;

    // A renderer can finish an autosave after another window activated a new
    // vault. Bind this write to the caller's active generation so it fails
    // safely instead of resolving the same note ID in the new backend context.
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard
        .as_ref()
        .ok_or_else(|| WriteNoteError::failed("No vault open"))?;
    if request.expected_generation != conn.generation {
        return Err(WriteNoteError::failed("Vault changed before note save"));
    }
    let destination = vault_index::note_metadata(conn, &conn.root, &request.note_id)
        .map_err(WriteNoteError::failed)?;
    let prepared_note = vault_index::prepare_note_write(
        conn,
        &conn.root,
        &request.note_id,
        &request.content,
        &request.expected_revision,
    )?;
    let expected = if prepared_note.preserve_opaque_bytes {
        watcher::fingerprint_for_bytes(prepared_note.next.as_bytes())
    } else {
        watcher::fingerprint_for_bytes(
            &frontmatter::text_bytes_for_write(&prepared_note.path, &prepared_note.next)
                .map_err(WriteNoteError::failed)?,
        )
    };
    let prepared_write = watcher_state.prepare_write([(&prepared_note.path, expected)]);
    let (path, body, revision) =
        match vault_index::commit_prepared_note_write(&conn.root, prepared_note) {
            Ok(written) => {
                watcher_state.confirm_prepared_write(&prepared_write);
                written
            }
            Err(error) => {
                watcher_state.cancel_prepared_write(&prepared_write);
                return Err(error);
            }
        };
    let index_result =
        vault_index::upsert_note_index(conn, &conn.root, &request.note_id, &body, &path);
    drop(conn_guard); // release DB lock before touching watcher state
    let outcome = match index_result {
        Ok(()) => WriteNoteOutcome {
            path: destination.path,
            revision: revision.clone(),
            index_state: IndexState::Healthy,
            warnings: Vec::new(),
        },
        Err(error) => {
            tracing::warn!(event = "index_update_failed", error = %error);
            db.mark_index_rebuild_required()
                .map_err(WriteNoteError::failed)?;
            WriteNoteOutcome {
                path: destination.path,
                revision: revision.clone(),
                index_state: IndexState::RebuildRequired,
                warnings: vec![OperationWarning::IndexRebuildRequired],
            }
        }
    };
    if let Err(error) = app.emit(
        "amby:note-written",
        NoteWrittenPayload {
            note_id: request.note_id,
            revision,
            origin_window: request.origin_window,
        },
    ) {
        tracing::warn!(event = "note_write_event_failed", error = %error);
    }
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn restore_deleted_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    request: RestoreDeletedNoteRequest,
) -> Result<WriteNoteOutcome, WriteNoteError> {
    use tauri::Emitter;

    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard
        .as_ref()
        .ok_or_else(|| WriteNoteError::failed("No vault open"))?;
    if request.expected_generation != conn.generation {
        return Err(WriteNoteError::failed(
            "Vault changed before deleted note restoration",
        ));
    }
    let opaque = request
        .note_id
        .starts_with(crate::index::identity::OPAQUE_PREFIX);
    if !opaque {
        crate::index::identity::ensure_unique_identity(conn, &request.note_id)
            .map_err(WriteNoteError::failed)?;
    }
    let path = paths::confine(&conn.root, std::path::Path::new(&request.path))
        .map_err(WriteNoteError::failed)?;
    if path.exists() {
        return Err(WriteNoteError::failed(
            "The deleted note path reappeared; refusing to overwrite it",
        ));
    }

    // The complete source captured by read_note is the only safe place to get
    // opaque YAML and the deleted file's original text convention. The body is
    // replaced independently so the user's latest local editor text wins.
    let next = if opaque {
        vault_index::prepare_opaque_note_text(
            &conn.root,
            &path,
            &request.note_id,
            &request.source_template,
            &request.content,
        )
    } else {
        frontmatter::replace_body_preserving_id(
            &request.source_template,
            &request.content,
            &request.note_id,
        )
    }
    .map_err(WriteNoteError::failed)?;
    let bytes = if opaque {
        next.as_bytes().to_vec()
    } else {
        frontmatter::text_bytes_from_template(&request.source_template, &next)
            .map_err(WriteNoteError::failed)?
    };
    let prepared_write =
        watcher_state.prepare_write([(&path, watcher::fingerprint_for_bytes(&bytes))]);
    match frontmatter::atomic_write_bytes_new(&path, &bytes) {
        Ok(()) => watcher_state.confirm_prepared_write(&prepared_write),
        Err(frontmatter::AtomicCreateError::AlreadyExists) => {
            watcher_state.cancel_prepared_write(&prepared_write);
            return Err(WriteNoteError::failed(
                "The deleted note path reappeared; refusing to overwrite it",
            ));
        }
        Err(frontmatter::AtomicCreateError::Other(error)) => {
            watcher_state.cancel_prepared_write(&prepared_write);
            return Err(WriteNoteError::failed(error));
        }
    }

    let persisted =
        fs::read_to_string(&path).map_err(|error| WriteNoteError::failed(error.to_string()))?;
    let body = frontmatter::parse_markdown(&persisted).body;
    let revision = vault_index::body_revision(if opaque { &persisted } else { &body });
    let index_result =
        vault_index::upsert_note_index(conn, &conn.root, &request.note_id, &body, &path)
            .and_then(|_| property_store::restore_cache(conn, &conn.root));
    let path_string = path.to_string_lossy().to_string();
    drop(conn_guard);

    let outcome = match index_result {
        Ok(()) => WriteNoteOutcome {
            path: path_string.clone(),
            revision: revision.clone(),
            index_state: IndexState::Healthy,
            warnings: Vec::new(),
        },
        Err(error) => {
            tracing::warn!(event = "deleted_note_restore_index_failed", error = %error);
            db.mark_index_rebuild_required()
                .map_err(WriteNoteError::failed)?;
            WriteNoteOutcome {
                path: path_string.clone(),
                revision: revision.clone(),
                index_state: IndexState::RebuildRequired,
                warnings: vec![OperationWarning::IndexRebuildRequired],
            }
        }
    };

    if let Err(error) = app.emit(
        "amby:note-written",
        NoteWrittenPayload {
            note_id: request.note_id,
            revision,
            origin_window: request.origin_window,
        },
    ) {
        tracing::warn!(event = "note_write_event_failed", error = %error);
    }
    if let Err(error) = app.emit(
        "vault-file-changed",
        watcher::VaultFileChangedPayload {
            kind: "create".to_string(),
            path: path_string,
        },
    ) {
        tracing::warn!(event = "restored_note_tree_event_failed", error = %error);
    }
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub fn get_note_metadata(
    db: tauri::State<'_, VaultContext>,
    note_id: String,
) -> Result<NoteMetadata, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let note = vault_index::note_metadata(conn, &conn.root, &note_id)?;
    Ok(NoteMetadata {
        created: vault_index::note_created_at(conn, &note_id)?,
        modified: note.modified,
        word_count: note.word_count,
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_file_metadata(
    scope: tauri::State<paths::VaultScope>,
    path: String,
) -> Result<FileMetadata, String> {
    let path = paths::guard(&scope, &path)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;

    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    Ok(FileMetadata {
        created,
        modified,
        word_count: content.split_whitespace().count(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_note_properties(
    db: tauri::State<'_, VaultContext>,
    note_id: String,
) -> Result<NoteProperties, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::note_properties(conn, &conn.root, &note_id)
}

#[tauri::command]
#[specta::specta]
pub fn upsert_custom_property(
    db: tauri::State<'_, VaultContext>,
    note_id: String,
    property: CustomProperty,
) -> Result<CustomProperty, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    property_store::upsert(conn, &conn.root, &note_id, property)
}

#[tauri::command]
#[specta::specta]
pub fn delete_custom_property(
    db: tauri::State<'_, VaultContext>,
    note_id: String,
    property_id: String,
) -> Result<(), String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    property_store::delete(conn, &conn.root, &note_id, &property_id)
}

#[tauri::command]
#[specta::specta]
pub fn list_tags(db: tauri::State<'_, VaultContext>) -> Result<Vec<vault_index::TagEntry>, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::list_tags(conn, &conn.root)
}

#[tauri::command]
#[specta::specta]
pub fn search_notes(
    db: tauri::State<'_, VaultContext>,
    query: String,
) -> Result<Vec<vault_index::SearchResult>, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::search_notes(conn, &conn.root, &query)
}

#[tauri::command]
#[specta::specta]
pub fn get_link_graph(
    db: tauri::State<'_, VaultContext>,
) -> Result<vault_index::LinkGraph, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::link_graph(conn, &conn.root)
}
