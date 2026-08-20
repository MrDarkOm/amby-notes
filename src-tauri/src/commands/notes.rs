use std::fs;
use std::time::UNIX_EPOCH;

use crate::frontmatter;
use crate::history;
use crate::model::*;
use crate::paths;
use crate::property_store;
use crate::vault_context::VaultContext;
use crate::vault_index;
use crate::watcher::WatcherState;

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
    history::snapshot_before_write(&vault, &path, content.as_bytes(), "file-save")?;
    frontmatter::atomic_write(&path, &content)?;
    watcher_state.mark_write([&path]);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn save_conflict_copy(
    scope: tauri::State<paths::VaultScope>,
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
        match frontmatter::atomic_write_new(&candidate, &content) {
            Ok(()) => return Ok(candidate.to_string_lossy().to_string()),
            Err(frontmatter::AtomicCreateError::AlreadyExists) => continue,
            Err(frontmatter::AtomicCreateError::Other(error)) => return Err(error),
        }
    }
    Err("Could not allocate a unique random conflict-copy filename".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn read_note(db: tauri::State<'_, VaultContext>, note_id: String) -> Result<String, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::read_note(conn, &conn.root, &note_id)
}

#[tauri::command]
#[specta::specta]
pub fn write_note(
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    expected_generation: u64,
    note_id: String,
    content: String,
) -> Result<WriteNoteOutcome, String> {
    // A renderer can finish an autosave after another window activated a new
    // vault. Bind this write to the caller's active generation so it fails
    // safely instead of resolving the same note ID in the new backend context.
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    if expected_generation != conn.generation {
        return Err("Vault changed before note save".to_string());
    }
    let destination = vault_index::note_metadata(conn, &conn.root, &note_id)?;
    let (path, body) = vault_index::write_note_filesystem(conn, &conn.root, &note_id, &content)?;
    watcher_state.mark_write([&path]);
    let index_result = vault_index::upsert_note_index(conn, &conn.root, &note_id, &body, &path);
    drop(conn_guard); // release DB lock before touching watcher state
    match index_result {
        Ok(()) => Ok(WriteNoteOutcome {
            path: destination.path,
            index_state: IndexState::Healthy,
            warnings: Vec::new(),
        }),
        Err(error) => {
            tracing::warn!(event = "index_update_failed", error = %error);
            db.mark_index_rebuild_required()?;
            Ok(WriteNoteOutcome {
                path: destination.path,
                index_state: IndexState::RebuildRequired,
                warnings: vec![OperationWarning::IndexRebuildRequired],
            })
        }
    }
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
