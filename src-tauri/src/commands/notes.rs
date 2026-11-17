use crate::lock_util::LockExt;
use std::fs;
use std::time::UNIX_EPOCH;

use crate::frontmatter;
use crate::history;
use crate::model::*;
use crate::paths;
use crate::property_groups;
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

/// Revision of a non-note file: the SHA-256 of its raw bytes, or an empty
/// string when the file does not exist. Notes use `read_note` revisions.
#[tauri::command]
#[specta::specta]
pub fn get_file_revision(
    scope: tauri::State<paths::VaultScope>,
    path: String,
) -> Result<String, String> {
    let path = paths::guard(&scope, &path)?;
    file_revision(&path)
}

fn file_revision(path: &std::path::Path) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(crate::database::format::raw_revision(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

/// Orders blocking writes per key (a note id or a file path). A ticket is taken when the
/// command starts, which is IPC arrival order; `wait` blocks the pool thread until every
/// earlier ticket for the same key has finished, and dropping the ticket (after the write,
/// on failure, or when the command future is cancelled) lets the next one go. Writes to
/// different keys do not wait for each other. The frontend already awaits each save before
/// sending the next; this keeps the backend order intact even if it does not.
pub(crate) struct WriteSequencer {
    state: std::sync::Mutex<std::collections::HashMap<String, QueueCounters>>,
    turn: std::sync::Condvar,
}

#[derive(Default)]
struct QueueCounters {
    next: u64,
    serving: u64,
    /// Finished tickets that are not yet at the head of the queue.
    finished: std::collections::BTreeSet<u64>,
}

pub(crate) struct WriteTicket {
    sequencer: &'static WriteSequencer,
    key: String,
    number: u64,
}

impl WriteSequencer {
    fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(std::collections::HashMap::new()),
            turn: std::sync::Condvar::new(),
        }
    }

    pub(crate) fn ticket(&'static self, key: String) -> WriteTicket {
        let mut state = self.state.lock_or_recover();
        let counters = state.entry(key.clone()).or_default();
        let number = counters.next;
        counters.next += 1;
        WriteTicket {
            sequencer: self,
            key,
            number,
        }
    }
}

impl WriteTicket {
    /// Blocks until it is this ticket's turn.
    pub(crate) fn wait(&mut self) {
        let mut state = self.sequencer.state.lock_or_recover();
        while state
            .get(&self.key)
            .is_some_and(|counters| counters.serving != self.number)
        {
            state = self
                .sequencer
                .turn
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

impl Drop for WriteTicket {
    fn drop(&mut self) {
        let mut state = self.sequencer.state.lock_or_recover();
        if let Some(counters) = state.get_mut(&self.key) {
            // A ticket dropped before its turn (cancelled command) must not stall
            // later ones: it passes the turn on once everything before it is done.
            counters.finished.insert(self.number);
            while counters.finished.remove(&counters.serving) {
                counters.serving += 1;
            }
            if counters.serving == counters.next {
                state.remove(&self.key);
            }
        }
        self.sequencer.turn.notify_all();
    }
}

pub(crate) fn write_sequencer() -> &'static WriteSequencer {
    static SEQUENCER: std::sync::OnceLock<WriteSequencer> = std::sync::OnceLock::new();
    SEQUENCER.get_or_init(WriteSequencer::new)
}

/// Writes a Canvas/Excalidraw/generic text file and returns its new revision.
/// With `expected_revision` the current bytes are compared under the mutation
/// gate first; a mismatch writes nothing. `None` keeps the unconditional
/// overwrite used by explicit conflict resolution and tests.
#[tauri::command]
#[specta::specta]
pub async fn write_file(
    window: tauri::WebviewWindow,
    path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<String, crate::model::WriteFileError> {
    // The write is a fsync plus a history snapshot: off the main thread, strictly
    // in arrival order per path (see `WriteSequencer`).
    let ticket = write_sequencer().ticket(format!("file:{path}"));
    tauri::async_runtime::spawn_blocking(move || {
        let mut ticket = ticket;
        ticket.wait();
        write_file_blocking(&window, path, content, expected_revision)
    })
    .await
    .map_err(|error| crate::model::WriteFileError::failed(format!("write task failed: {error}")))?
}

fn write_file_blocking(
    window: &tauri::WebviewWindow,
    path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<String, crate::model::WriteFileError> {
    use crate::model::WriteFileError;
    use tauri::Manager;
    let scope = window.state::<paths::VaultScope>();
    let db = window.state::<VaultContext>();
    let watcher_state = window.state::<WatcherState>();
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let path = paths::guard(&scope, &path).map_err(WriteFileError::failed)?;
    let vault = scope.get().map_err(WriteFileError::failed)?;
    let generation = db.generation().map_err(WriteFileError::failed)?;
    if let Some(expected) = &expected_revision {
        let actual = file_revision(&path).map_err(WriteFileError::failed)?;
        if &actual != expected {
            return Err(WriteFileError::RevisionConflict {
                actual_revision: actual,
            });
        }
    }
    let bytes =
        frontmatter::text_bytes_for_write(&path, &content).map_err(WriteFileError::failed)?;
    let expected = watcher::fingerprint_for_bytes(&bytes);
    let prepared = watcher_state.prepare_write([(&path, expected)]);
    let result = (|| {
        history::snapshot_before_write(&vault, &path, content.as_bytes(), "file-save")?;
        frontmatter::atomic_write(&path, &content)
    })();
    match result {
        Ok(()) => {
            watcher_state.confirm_prepared_write(&prepared);
            watcher::notify_published_files(
                window.app_handle(),
                &vault,
                generation,
                std::slice::from_ref(&path),
                Some(window.label()),
            );
            Ok(crate::database::format::raw_revision(&bytes))
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared);
            Err(WriteFileError::failed(error))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn save_conflict_copy(
    app: tauri::AppHandle,
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
    content: String,
) -> Result<String, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let original = paths::guard(&scope, &path)?;
    let vault = scope.get()?;
    let generation = db.generation()?;
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
                watcher::notify_published_files(
                    &app,
                    &vault,
                    generation,
                    std::slice::from_ref(&candidate),
                    None,
                );
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
    operation_id: Option<String>,
) -> Result<NoteReadOutcome, String> {
    let telemetry =
        crate::logging::OperationGuard::begin("note.read", operation_id, note_id.clone());
    let operation_span = tracing::error_span!("note_read", operation_id = tracing::field::Empty);
    if let Some(operation_id) = telemetry.operation_id() {
        operation_span.record("operation_id", operation_id);
    }
    let _operation_span = operation_span.enter();
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    tracing::debug!(event = "read_note", note_id = %note_id);
    // The journal keeps why a read failed as a code, never the text or the path.
    match vault_index::read_note_with_reason(conn, &conn.root, &note_id) {
        Ok(outcome) => {
            telemetry.succeed();
            Ok(outcome)
        }
        Err((error, code)) => {
            telemetry.fail(code);
            Err(error)
        }
    }
}

/// Reads the file, checks `expected_revision`, merges the frontmatter and commits
/// the write while holding `mutation_gate`, so no other mutation can slip in
/// between the check and the commit.
type CommittedNoteWrite = (
    std::path::PathBuf,
    String,
    String,
    (Vec<String>, Vec<(String, String, String)>),
);

fn commit_note_write_under_gate(
    mutation_gate: &std::sync::Mutex<()>,
    watcher_state: &WatcherState,
    vault_root: &std::path::Path,
    note_path: &std::path::Path,
    request: &WriteNoteRequest,
    history_reason: &str,
) -> Result<CommittedNoteWrite, WriteNoteError> {
    let _mutation_guard = mutation_gate.lock_or_recover();
    let prepared_note = vault_index::prepare_note_write_from_path(
        vault_root,
        note_path,
        &request.note_id,
        &request.content,
        &request.expected_revision,
    )?;
    let expected = watcher::fingerprint_for_bytes(&prepared_note.persisted_bytes);
    let prepared_write = watcher_state.prepare_write([(&prepared_note.path, expected)]);
    let index_data = (
        prepared_note.frontmatter_tags.clone(),
        prepared_note.links.clone(),
    );
    match vault_index::commit_prepared_note_write(vault_root, prepared_note, history_reason) {
        Ok((path, body, revision)) => {
            watcher_state.confirm_prepared_write(&prepared_write);
            Ok((path, body, revision, index_data))
        }
        Err(error) => {
            watcher_state.cancel_prepared_write(&prepared_write);
            Err(error)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn write_note(
    app: tauri::AppHandle,
    request: WriteNoteRequest,
    operation_id: Option<String>,
) -> Result<WriteNoteOutcome, WriteNoteError> {
    // fsync, the history snapshot and SQLite run on the blocking pool, not on the
    // main thread that also delivers WebView keyboard input. Tickets are taken here,
    // in arrival order, so writes to one note still commit strictly in that order.
    let ticket = write_sequencer().ticket(format!("note:{}", request.note_id));
    tauri::async_runtime::spawn_blocking(move || {
        let mut ticket = ticket;
        ticket.wait();
        write_note_blocking(&app, request, operation_id)
    })
    .await
    .map_err(|error| WriteNoteError::failed(format!("write task failed: {error}")))?
}

fn write_note_blocking(
    app: &tauri::AppHandle,
    request: WriteNoteRequest,
    operation_id: Option<String>,
) -> Result<WriteNoteOutcome, WriteNoteError> {
    use tauri::Manager;
    let db = app.state::<VaultContext>();
    let watcher_state = app.state::<WatcherState>();
    use tauri::Emitter;
    let telemetry =
        crate::logging::OperationGuard::begin("note.write", operation_id, request.note_id.clone());
    let operation_span = tracing::error_span!("note_write", operation_id = tracing::field::Empty);
    if let Some(operation_id) = telemetry.operation_id() {
        operation_span.record("operation_id", operation_id);
    }
    let _operation_span = operation_span.enter();

    // A renderer can finish an autosave after another window activated a new
    // vault. Bind this write to the caller's active generation so it fails
    // safely instead of resolving the same note ID in the new backend context.
    let (vault_root, generation, destination) = {
        let conn_guard = db.conn.lock_or_recover();
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| WriteNoteError::failed("No vault open"))?;
        if request.expected_generation != conn.generation {
            return Err(WriteNoteError::failed("Vault changed before note save"));
        }
        let destination = vault_index::note_metadata(conn, &conn.root, &request.note_id)
            .map_err(WriteNoteError::failed)?;
        if !request.note_id.starts_with(vault_index::OPAQUE_PREFIX) {
            vault_index::ensure_unique_identity(conn, &request.note_id)
                .map_err(WriteNoteError::failed)?;
        }
        (conn.root.clone(), conn.generation, destination)
    };

    // The revision check, the frontmatter merge and the commit form one step under
    // mutation_gate: a property write or a version restore that runs in between
    // would otherwise be overwritten by the stale frontmatter without a conflict.
    // The conn lock is not held here (order: mutation_gate, then conn, as in write_file).
    let history_reason = if request.rewrites_source {
        history::SOURCE_REWRITE_REASON
    } else {
        "note-save"
    };
    let (path, body, revision, prepared_index_data) = commit_note_write_under_gate(
        &db.mutation_gate,
        &watcher_state,
        &vault_root,
        std::path::Path::new(&destination.path),
        &request,
        history_reason,
    )?;
    let index_result = {
        let conn_guard = db.conn.lock_or_recover();
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| WriteNoteError::failed("No vault open"))?;
        if conn.generation != generation {
            return Err(WriteNoteError::failed("Vault changed while saving note"));
        }
        vault_index::prepare_note_index_from_parts(
            &conn.root,
            &request.note_id,
            &body,
            &path,
            prepared_index_data.0,
            prepared_index_data.1,
        )
        .and_then(|prepared| vault_index::upsert_prepared_note_index(conn, &prepared))
    };
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
            note_id: request.note_id.clone(),
            revision: revision.clone(),
            origin_window: request.origin_window,
        },
    ) {
        tracing::warn!(event = "note_write_event_failed", error = %error);
    }
    tracing::info!(
        event = "write_note",
        note_id = %request.note_id,
        path = %outcome.path,
        revision = %outcome.revision,
    );
    telemetry.succeed();
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

    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let conn_guard = db.conn.lock_or_recover();
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
            .and_then(|_| property_groups::restore_cache_any(conn, &conn.root));
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
            generation: request.expected_generation,
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
    let conn_guard = db.conn.lock_or_recover();
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
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::note_properties(conn, &conn.root, &note_id)
}

#[tauri::command]
#[specta::specta]
pub fn backup_custom_properties(
    db: tauri::State<'_, VaultContext>,
    note_id: String,
) -> Result<String, String> {
    let _mutation_guard = db.mutation_gate.lock_or_recover();
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    property_groups::backup_if_any(conn, &conn.root, &note_id)
}

#[tauri::command]
#[specta::specta]
pub fn list_tags(db: tauri::State<'_, VaultContext>) -> Result<Vec<vault_index::TagEntry>, String> {
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::list_tags(conn, &conn.root)
}

#[tauri::command]
#[specta::specta]
pub fn search_notes(
    db: tauri::State<'_, VaultContext>,
    query: String,
) -> Result<Vec<vault_index::SearchResult>, String> {
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::search_notes(conn, &conn.root, &query)
}

#[tauri::command]
#[specta::specta]
pub fn get_link_graph(
    db: tauri::State<'_, VaultContext>,
) -> Result<vault_index::LinkGraph, String> {
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::link_graph(conn, &conn.root)
}

#[cfg(test)]
mod tests {
    use super::commit_note_write_under_gate;
    use crate::model::WriteNoteRequest;
    use crate::watcher::WatcherState;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn a_note_save_reads_the_file_only_after_it_holds_the_mutation_gate() {
        let vault = std::env::temp_dir().join(format!("amby_save07_{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(&vault).expect("create vault");
        let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let path = vault.join("Note.md");
        std::fs::write(&path, format!("---\namby-id: {id}\n---\nbody\n")).expect("write note");
        let revision = crate::vault_index::body_revision("body\n");

        let gate = Arc::new(Mutex::new(()));
        let watcher_state = Arc::new(WatcherState::new());
        // Another mutation (a property write, a version restore) owns the gate.
        let held = gate.lock().expect("gate");
        let writer = {
            let (gate, watcher_state) = (gate.clone(), watcher_state.clone());
            let (vault, path) = (vault.clone(), path.clone());
            std::thread::spawn(move || {
                let request = WriteNoteRequest {
                    expected_generation: 0,
                    note_id: id.to_string(),
                    content: "body edited\n".to_string(),
                    expected_revision: revision,
                    origin_window: "main".to_string(),
                    rewrites_source: false,
                };
                commit_note_write_under_gate(
                    &gate,
                    &watcher_state,
                    &vault,
                    &path,
                    &request,
                    "note-save",
                )
                .map(|_| ())
            })
        };
        std::thread::sleep(Duration::from_millis(300));
        // The other mutation changes the frontmatter while the save waits.
        std::fs::write(
            &path,
            format!("---\namby-id: {id}\nstatus: done\n---\nbody\n"),
        )
        .expect("property write");
        drop(held);

        writer.join().expect("writer thread").expect("save");
        let saved = std::fs::read_to_string(&path).expect("read back");
        assert!(
            saved.contains("status: done") && saved.contains("body edited"),
            "the save must merge into the file as it is under the gate, got: {saved}"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn writes_to_one_key_run_in_ticket_order_even_when_threads_start_late() {
        let sequencer: &'static super::WriteSequencer =
            Box::leak(Box::new(super::WriteSequencer::new()));
        let order = Arc::new(Mutex::new(Vec::new()));
        let tickets: Vec<_> = (0..5).map(|_| sequencer.ticket("note:a".into())).collect();
        let mut handles = Vec::new();
        // Start the workers in reverse: the last ticket's thread is ready first.
        for (number, mut ticket) in tickets.into_iter().enumerate().rev() {
            let order = order.clone();
            handles.push(std::thread::spawn(move || {
                ticket.wait();
                std::thread::sleep(Duration::from_millis(10));
                order.lock().unwrap().push(number);
            }));
            std::thread::sleep(Duration::from_millis(15));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn a_cancelled_ticket_does_not_stall_later_writes_and_other_keys_do_not_wait() {
        let sequencer: &'static super::WriteSequencer =
            Box::leak(Box::new(super::WriteSequencer::new()));
        let first = sequencer.ticket("note:a".into());
        let cancelled = sequencer.ticket("note:a".into());
        let mut third = sequencer.ticket("note:a".into());
        let mut other = sequencer.ticket("note:b".into());
        other.wait(); // a different key is never blocked by `first`
        drop(cancelled); // dropped before its turn
        drop(first);
        third.wait(); // would hang if the cancelled ticket stalled the queue
        drop(third);
        drop(other);
        assert!(
            sequencer.state.lock().unwrap().is_empty(),
            "idle keys are forgotten"
        );
    }

    #[test]
    fn write_commands_are_async_and_do_the_blocking_work_off_the_main_thread() {
        let source = include_str!("notes.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        for name in ["write_note", "write_file"] {
            assert!(
                production.contains(&format!("pub async fn {name}(")),
                "{name} must be an async command"
            );
            assert!(
                !production.contains(&format!("pub fn {name}(")),
                "{name} must not be a synchronous command"
            );
        }
        let spawns = production
            .matches("tauri::async_runtime::spawn_blocking")
            .count();
        assert!(spawns >= 2, "both writes must run on the blocking pool");
    }
}
