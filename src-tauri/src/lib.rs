mod ai;
mod app_data;
mod bundle;
mod frontmatter;
mod history;
mod model;
mod paths;
mod property_store;
mod recycle_bin;
mod vault_context;
mod vault_index;

use std::collections::{hash_map::DefaultHasher, HashMap};
use std::error::Error;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use bundle::*;
use model::*;

type DbState = vault_context::VaultContext;

// ── Rust-side file-system watcher ───────────────────────────────────────────

/// How long a precise self-write fingerprint remains available to reconcile
/// delayed notify events. It is never a time-only suppression rule: the
/// current filesystem fingerprint must still exactly match the record.
const SELF_WRITE_RECORD_TTL: Duration = Duration::from_secs(8);
const MAIN_WINDOW_LABEL: &str = "main";

fn init_logging() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init()
        .ok();
}

/// Bring the one application window back to the foreground. This is used at
/// initial startup and when the OS forwards another launch request to the
/// already-running process.
fn show_and_focus_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn Error>> {
    use tauri::Manager;

    let window = app.get_webview_window(MAIN_WINDOW_LABEL).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Tauri did not create the main window",
        )
    })?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn report_startup_error(error: &tauri::Error) {
    let message = format!(
        "Amby could not create its main window. On Windows, verify that the Microsoft Edge WebView2 Runtime is installed.\n\nDetails: {error}"
    );
    tracing::error!(event = "startup_error", error = %error);
    rfd::MessageDialog::new()
        .set_title("Amby could not start")
        .set_description(&message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

/// Tauri applies the configured icon to `NSApplication` in development, but
/// leaves release builds to macOS's bundle-icon fallback. On Tahoe that
/// fallback adds a generic background to legacy `.icns` icons, so explicitly
/// apply the same image at runtime for a consistent Dock appearance.
#[cfg(target_os = "macos")]
fn set_macos_application_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let marker = unsafe { MainThreadMarker::new_unchecked() };
    let application = NSApplication::sharedApplication(marker);
    let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { application.setApplicationIconImage(Some(&icon)) };
    }
}

/// Payload emitted to the frontend when an external file-system change is
/// detected in the vault (creates, modifies, deletes).
#[derive(serde::Serialize, Clone)]
struct VaultFileChangedPayload {
    kind: String, // "create" | "modify" | "remove" | "rename"
    path: String,
}

fn watched_event_kind(kind: &notify::EventKind) -> Option<&'static str> {
    match kind {
        notify::EventKind::Create(_) => Some("create"),
        notify::EventKind::Modify(notify::event::ModifyKind::Data(_)) => Some("modify"),
        notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => Some("rename"),
        notify::EventKind::Remove(_) => Some("remove"),
        _ => None,
    }
}

fn is_amby_temporary_file(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().contains(".amby-tmp-"))
}

/// Manages the active `notify` watcher for the open vault.  Stored in
/// `tauri::State` so it lives for the whole app lifetime.
pub struct WatcherState {
    /// The active watcher (dropped → OS unregisters the watch).
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Exact results of our own filesystem writes. Parent directories are not
    /// recorded: a sibling file change must never be hidden by a broad marker.
    own_writes: Arc<Mutex<HashMap<PathBuf, SelfWriteRecord>>>,
    /// The active watcher's vault generation. A callback from a dropped prior
    /// watcher is ignored even if the OS delivers it late.
    active_generation: Arc<AtomicU64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SelfWriteOperation {
    Write,
    Create,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PathFingerprint {
    File { size: u64, content_hash: u64 },
    Directory,
    Missing,
    Unavailable,
}

#[derive(Clone, Debug)]
struct SelfWriteRecord {
    operation: SelfWriteOperation,
    expected: PathFingerprint,
    recorded_at: Instant,
    expires_at: Instant,
    generation: u64,
}

fn path_fingerprint(path: &Path) -> PathFingerprint {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return PathFingerprint::Missing
        }
        Err(_) => return PathFingerprint::Unavailable,
    };
    if metadata.is_dir() {
        return PathFingerprint::Directory;
    }
    if !metadata.is_file() {
        return PathFingerprint::Unavailable;
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return PathFingerprint::Unavailable,
    };
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    PathFingerprint::File {
        size: metadata.len(),
        content_hash: hasher.finish(),
    }
}

fn operation_for_fingerprint(fingerprint: &PathFingerprint) -> SelfWriteOperation {
    match fingerprint {
        PathFingerprint::Missing => SelfWriteOperation::Delete,
        PathFingerprint::Directory => SelfWriteOperation::Create,
        PathFingerprint::File { .. } | PathFingerprint::Unavailable => SelfWriteOperation::Write,
    }
}

fn event_matches_operation(kind: &str, record: &SelfWriteRecord) -> bool {
    match kind {
        "rename" => matches!(
            record.operation,
            SelfWriteOperation::Create | SelfWriteOperation::Delete | SelfWriteOperation::Write
        ),
        "remove" => matches!(record.operation, SelfWriteOperation::Delete),
        "create" => matches!(
            record.operation,
            SelfWriteOperation::Create | SelfWriteOperation::Write
        ),
        "modify" => matches!(
            record.operation,
            SelfWriteOperation::Write | SelfWriteOperation::Create
        ),
        _ => false,
    }
}

impl WatcherState {
    fn new() -> Self {
        Self {
            watcher: Mutex::new(None),
            own_writes: Arc::new(Mutex::new(HashMap::new())),
            active_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Record a completed write's exact on-disk result. Callers invoke this
    /// after the filesystem operation succeeds, never as a speculative marker.
    fn mark_write<I, P>(&self, paths: I)
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let mut guard = self.own_writes.lock().unwrap();
        let now = Instant::now();
        let generation = self.active_generation.load(Ordering::Acquire);
        for p in paths {
            let path = p.as_ref().to_path_buf();
            let expected = path_fingerprint(&path);
            guard.insert(
                path,
                SelfWriteRecord {
                    operation: operation_for_fingerprint(&expected),
                    expected,
                    recorded_at: now,
                    expires_at: now + SELF_WRITE_RECORD_TTL,
                    generation,
                },
            );
        }
        guard.retain(|_, record| record.expires_at > now);
    }
}

fn reconcile_self_write(
    own_writes: &Mutex<HashMap<PathBuf, SelfWriteRecord>>,
    path: &Path,
    kind: &str,
    generation: u64,
) -> bool {
    let now = Instant::now();
    let mut guard = own_writes.lock().unwrap();
    let Some(record) = guard.get(path).cloned() else {
        return false;
    };
    let age = now.saturating_duration_since(record.recorded_at);
    if record.generation != generation || record.expires_at <= now || age >= SELF_WRITE_RECORD_TTL {
        // Re-fingerprint after expiry before removing the record. This
        // provides a deterministic reconciliation point for delayed or
        // directory-level events without treating elapsed time as proof.
        let _ = path_fingerprint(path);
        guard.remove(path);
        return false;
    }
    event_matches_operation(kind, &record) && path_fingerprint(path) == record.expected
}

/// Every absolute path touched by a filesystem mutation (created, renamed, or
/// deleted), so the caller can hand them all to `WatcherState::mark_write`.
fn mutation_paths(result: &FsMutationResult) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(primary) = &result.primary_path {
        paths.push(PathBuf::from(primary));
    }
    for change in &result.path_changes {
        if !change.old_path.is_empty() {
            paths.push(PathBuf::from(&change.old_path));
        }
        if !change.new_path.is_empty() {
            paths.push(PathBuf::from(&change.new_path));
        }
    }
    for deleted in &result.deleted_paths {
        paths.push(PathBuf::from(deleted));
    }
    paths
}

fn sync_mutation_result(
    context: &vault_context::VaultContext,
    conn: &rusqlite::Connection,
    vault_path: &Path,
    mut result: FsMutationResult,
) -> MutationOutcome {
    let index_result = (|| -> Result<(), String> {
        result.deleted_ids = vault_index::index_apply_mutation(
            conn,
            vault_path,
            &result.path_changes,
            &result.deleted_paths,
        )?;
        result.primary_id = result
            .primary_path
            .as_ref()
            .map(|path| vault_index::note_id_for_path(conn, vault_path, Path::new(path)))
            .transpose()?
            .flatten();
        Ok(())
    })();

    match index_result {
        Ok(()) => MutationOutcome {
            mutation: result,
            index_state: IndexState::Healthy,
            warnings: Vec::new(),
        },
        Err(error) => {
            tracing::warn!(event = "index_update_failed", error = %error);
            let _ = context.mark_index_rebuild_required();
            MutationOutcome {
                mutation: result,
                index_state: IndexState::RebuildRequired,
                warnings: vec![OperationWarning::IndexRebuildRequired],
            }
        }
    }
}

/// Grant the active vault to the asset protocol. Filesystem access stays in
/// backend commands; the renderer never receives a filesystem plugin scope.
fn grant_vault_scopes(app: &tauri::AppHandle, vault: &Path) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_directory(vault, true)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn load_vault(
    app: tauri::AppHandle,
    context: tauri::State<'_, vault_context::VaultContext>,
    vault_path: String,
) -> Result<vault_index::LoadVaultResult, String> {
    context.activate(
        &vault_path,
        |root| grant_vault_scopes(&app, root),
        |loaded, _generation| loaded,
    )
}

#[tauri::command]
#[specta::specta]
fn preflight_vault(vault_path: String) -> Result<vault_index::VaultPreflight, String> {
    let canonical = Path::new(&vault_path)
        .canonicalize()
        .map_err(|e| format!("Vault not accessible: {e}"))?;
    vault_index::preflight_vault(&canonical)
}

#[tauri::command]
#[specta::specta]
fn apply_id_migration(vault_path: String) -> Result<vault_index::IdMigrationResult, String> {
    let canonical = Path::new(&vault_path)
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("Vault is not a directory: {}", canonical.display()));
    }
    vault_index::apply_id_migration(&canonical)
}

#[tauri::command]
#[specta::specta]
fn inspect_id_migrations(
    vault_path: String,
) -> Result<Vec<vault_index::IdMigrationRecovery>, String> {
    let canonical = Path::new(&vault_path)
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    vault_index::unfinished_id_migrations(&canonical)
}

#[tauri::command]
#[specta::specta]
fn recover_id_migration(
    vault_path: String,
    journal_path: String,
    action: vault_index::IdMigrationRecoveryAction,
) -> Result<vault_index::IdMigrationRecovery, String> {
    let canonical = Path::new(&vault_path)
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    vault_index::recover_id_migration(&canonical, &journal_path, action)
}

#[tauri::command]
#[specta::specta]
fn list_files(db: tauri::State<'_, DbState>) -> Result<Vec<vault_index::TreeItem>, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::load_vault(conn, &conn.root).map(|loaded| loaded.tree)
}

#[tauri::command]
#[specta::specta]
fn read_file(scope: tauri::State<paths::VaultScope>, path: String) -> Result<String, String> {
    let path = paths::guard(&scope, &path)?;
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn write_file(
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
fn save_conflict_copy(
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
fn list_snapshots(
    scope: tauri::State<paths::VaultScope>,
    source_path: String,
) -> Result<Vec<history::SnapshotEntry>, String> {
    let source_path = paths::guard(&scope, &source_path)?;
    history::list_snapshots(&scope.get()?, &source_path)
}

#[tauri::command]
#[specta::specta]
fn restore_snapshot(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    snapshot_id: String,
) -> Result<String, String> {
    let vault = scope.get()?;
    let path = history::restore_snapshot(&vault, &snapshot_id)?;
    watcher_state.mark_write([&path]);
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::sync_vault(conn, &vault)?;
    Ok(path_string(&path))
}

#[tauri::command]
#[specta::specta]
fn read_snapshot_text(
    scope: tauri::State<paths::VaultScope>,
    snapshot_id: String,
) -> Result<history::SnapshotText, String> {
    history::read_snapshot_text(&scope.get()?, &snapshot_id)
}

#[tauri::command]
#[specta::specta]
fn read_note(db: tauri::State<'_, DbState>, note_id: String) -> Result<String, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::read_note(conn, &conn.root, &note_id)
}

#[tauri::command]
#[specta::specta]
fn write_note(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_id: String,
    content: String,
) -> Result<WriteNoteOutcome, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
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
fn get_note_metadata(
    db: tauri::State<'_, DbState>,
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
fn get_note_properties(
    db: tauri::State<'_, DbState>,
    note_id: String,
) -> Result<NoteProperties, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::note_properties(conn, &conn.root, &note_id)
}

#[tauri::command]
#[specta::specta]
fn upsert_custom_property(
    db: tauri::State<'_, DbState>,
    note_id: String,
    property: CustomProperty,
) -> Result<CustomProperty, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    property_store::upsert(conn, &conn.root, &note_id, property)
}

#[tauri::command]
#[specta::specta]
fn delete_custom_property(
    db: tauri::State<'_, DbState>,
    note_id: String,
    property_id: String,
) -> Result<(), String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    property_store::delete(conn, &conn.root, &note_id, &property_id)
}

#[tauri::command]
#[specta::specta]
fn list_tags(db: tauri::State<'_, DbState>) -> Result<Vec<vault_index::TagEntry>, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::list_tags(conn, &conn.root)
}

#[tauri::command]
#[specta::specta]
fn search_notes(
    db: tauri::State<'_, DbState>,
    query: String,
) -> Result<Vec<vault_index::SearchResult>, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::search_notes(conn, &conn.root, &query)
}

#[tauri::command]
#[specta::specta]
fn get_link_graph(db: tauri::State<'_, DbState>) -> Result<vault_index::LinkGraph, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::link_graph(conn, &conn.root)
}

#[tauri::command]
#[specta::specta]
fn ensure_bundle(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<MutationOutcome, String> {
    let path = paths::guard(&db, &path)?;
    let (primary, path_changes) = ensure_bundle_path(&path)?;
    let result = FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&primary)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    };
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
fn create_note(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
) -> Result<MutationOutcome, String> {
    let parent_path = paths::guard(&db, &parent_path)?;
    let result = bundle::create_note_impl(&parent_path, &name)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
fn create_layer(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<LayerResult, String> {
    let note_path = paths::guard(&scope, &note_path)?;
    let result = create_layer_impl(&note_path, &kind)?;
    let mut paths = vec![PathBuf::from(&result.layer_path)];
    for change in &result.path_changes {
        if !change.old_path.is_empty() {
            paths.push(PathBuf::from(&change.old_path));
        }
        if !change.new_path.is_empty() {
            paths.push(PathBuf::from(&change.new_path));
        }
    }
    watcher_state.mark_write(paths);
    let vault = scope.get()?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::index_apply_path_changes(conn, &vault, &result.path_changes)?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
fn create_canvas(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let parent_path = paths::guard(&db, &parent_path)?;
    let path = create_canvas_impl(&parent_path, &name)?;
    watcher_state.mark_write([path.as_path()]);
    Ok(path_string(&path))
}

#[tauri::command]
#[specta::specta]
fn attach_canvas_to_note(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    canvas_path: String,
) -> Result<MutationOutcome, String> {
    let canvas_path = paths::guard(&db, &canvas_path)?;
    let result = attach_canvas_impl(&canvas_path)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
fn unlink_layer(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<MutationOutcome, String> {
    let note_path = paths::guard(&db, &note_path)?;
    let result = unlink_layer_impl(&note_path, &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
fn delete_layer(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<MutationOutcome, String> {
    let note_path = paths::guard(&db, &note_path)?;
    let vault = db.root()?;
    let result = delete_layer_impl(&vault, &note_path, &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
fn note_layers(
    scope: tauri::State<paths::VaultScope>,
    note_path: String,
) -> Result<NoteLayers, String> {
    let path = paths::guard(&scope, &note_path)?;
    let mut layers = NoteLayers::default();
    if !path.is_file() {
        return Ok(layers);
    }
    let Some(parent) = path.parent() else {
        return Ok(layers);
    };
    let Some(parent_name) = parent.file_name().map(|s| s.to_string_lossy().to_string()) else {
        return Ok(layers);
    };
    let stem = file_stem(&path)?;
    if parent_name != stem {
        return Ok(layers);
    }
    layers.canvas = parent.join(format!("{stem}.canvas")).is_file();
    layers.sketch = parent.join(format!("{stem}.excalidraw")).is_file();
    layers.database = parent.join("Metadata.md").is_file();
    Ok(layers)
}

#[tauri::command]
#[specta::specta]
fn move_item(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    source_path: String,
    target_path: String,
) -> Result<MutationOutcome, String> {
    let source_path = paths::guard(&db, &source_path)?;
    let target_path = paths::guard(&db, &target_path)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    // Build the entire reference plan while SQLite still maps the old paths.
    // This avoids a post-move window where a failed plan leaves a partial
    // filesystem mutation behind.
    let preview = preview_move_item(&source_path, &target_path)?;
    let plan = vault_index::plan_inbound_wiki_rewrites(conn, &conn.root, &preview.path_changes)?;
    let result = move_item_impl(&source_path, &target_path)?;
    let rewritten = match vault_index::apply_planned_wiki_rewrites(&conn.root, &plan) {
        Ok(rewritten) => rewritten,
        Err(error) => {
            if let Err(rollback_error) = rollback_move_item(&source_path, &target_path, &result) {
                return Err(format!("Reference update failed: {error}; filesystem rollback also failed: {rollback_error}"));
            }
            return Err(format!(
                "Reference update failed; move was rolled back: {error}"
            ));
        }
    };
    let mut changed_paths = mutation_paths(&result);
    changed_paths.extend(rewritten.iter().cloned());
    watcher_state.mark_write(changed_paths);
    let mut outcome = sync_mutation_result(&db, conn, &conn.root, result);
    let rewritten_changes = rewritten
        .into_iter()
        .map(|path| PathChange {
            old_path: path_string(&path),
            new_path: path_string(&path),
        })
        .collect::<Vec<_>>();
    if let Err(error) = vault_index::index_apply_path_changes(conn, &conn.root, &rewritten_changes)
    {
        tracing::warn!(event = "index_update_failed", error = %error);
        let _ = db.mark_index_rebuild_required();
        outcome.index_state = IndexState::RebuildRequired;
        outcome
            .warnings
            .push(OperationWarning::IndexRebuildRequired);
    }
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
fn preview_move_refactor(
    db: tauri::State<'_, DbState>,
    source_path: String,
    target_path: String,
) -> Result<vault_index::RefactorPreview, String> {
    let source_path = paths::guard(&db, &source_path)?;
    let target_path = paths::guard(&db, &target_path)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let preview = preview_move_item(&source_path, &target_path)?;
    let plan = vault_index::plan_inbound_wiki_rewrites(conn, &conn.root, &preview.path_changes)?;
    Ok(vault_index::refactor_preview(&plan))
}

#[tauri::command]
#[specta::specta]
fn create_file(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let path = paths::guard(&scope, &path)?;
    if path.exists() {
        return Err(format!("File already exists: {}", path.display()));
    }
    match frontmatter::atomic_write_new(&path, "") {
        Ok(()) => {}
        Err(frontmatter::AtomicCreateError::AlreadyExists) => {
            return Err(format!("File already exists: {}", path.display()));
        }
        Err(frontmatter::AtomicCreateError::Other(error)) => return Err(error),
    }
    watcher_state.mark_write([&path]);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn create_folder(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let path = paths::guard(&scope, &path)?;
    if path.exists() {
        return Err(format!("Folder already exists: {}", path.display()));
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    watcher_state.mark_write([&path]);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn rename_item(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
    new_name: String,
) -> Result<MutationOutcome, String> {
    let path = paths::guard(&db, &path)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let preview = preview_rename_item(&path, &new_name)?;
    let plan = vault_index::plan_inbound_wiki_rewrites(conn, &conn.root, &preview.path_changes)?;
    let result = rename_item_impl(&path, &new_name)?;
    let rewritten = match vault_index::apply_planned_wiki_rewrites(&conn.root, &plan) {
        Ok(rewritten) => rewritten,
        Err(error) => {
            if let Err(rollback_error) = rollback_rename_item(&path, &result) {
                return Err(format!("Reference update failed: {error}; filesystem rollback also failed: {rollback_error}"));
            }
            return Err(format!(
                "Reference update failed; rename was rolled back: {error}"
            ));
        }
    };
    let mut changed_paths = mutation_paths(&result);
    changed_paths.extend(rewritten.iter().cloned());
    watcher_state.mark_write(changed_paths);
    let mut outcome = sync_mutation_result(&db, conn, &conn.root, result);
    let rewritten_changes = rewritten
        .into_iter()
        .map(|path| PathChange {
            old_path: path_string(&path),
            new_path: path_string(&path),
        })
        .collect::<Vec<_>>();
    if let Err(error) = vault_index::index_apply_path_changes(conn, &conn.root, &rewritten_changes)
    {
        tracing::warn!(event = "index_update_failed", error = %error);
        let _ = db.mark_index_rebuild_required();
        outcome.index_state = IndexState::RebuildRequired;
        outcome
            .warnings
            .push(OperationWarning::IndexRebuildRequired);
    }
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
fn preview_rename_refactor(
    db: tauri::State<'_, DbState>,
    path: String,
    new_name: String,
) -> Result<vault_index::RefactorPreview, String> {
    let path = paths::guard(&db, &path)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let preview = preview_rename_item(&path, &new_name)?;
    let plan = vault_index::plan_inbound_wiki_rewrites(conn, &conn.root, &preview.path_changes)?;
    Ok(vault_index::refactor_preview(&plan))
}

#[tauri::command]
#[specta::specta]
fn delete_item(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<MutationOutcome, String> {
    let path = paths::guard(&db, &path)?;
    let vault = db.root()?;
    let result = recycle_bin::move_to_trash(&vault, &path)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &conn.root, result))
}

#[tauri::command]
#[specta::specta]
fn list_trash(
    scope: tauri::State<paths::VaultScope>,
) -> Result<Vec<recycle_bin::TrashEntry>, String> {
    Ok(recycle_bin::list(&scope.get()?))
}

#[tauri::command]
#[specta::specta]
fn restore_trash(
    scope: tauri::State<paths::VaultScope>,
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    trash_id: String,
) -> Result<MutationOutcome, String> {
    let vault = scope.get()?;
    let result = recycle_bin::restore(&vault, &trash_id)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(sync_mutation_result(&db, conn, &vault, result))
}

#[tauri::command]
#[specta::specta]
fn get_file_metadata(
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
fn open_in_explorer(scope: tauri::State<paths::VaultScope>, path: String) -> Result<(), String> {
    let path = paths::guard(&scope, &path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let arg = format!("/select,\"{}\"", path.display());
        std::process::Command::new("explorer")
            .raw_arg(&arg)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn import_asset(
    context: tauri::State<'_, vault_context::VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    source_path: String,
) -> Result<ImportedAsset, String> {
    let note = paths::guard(&context, &note_path)?;
    let vault = context.root()?;
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("Source is not a file: {source_path}"));
    }
    let dir = assets_dir_for(&vault, &note);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".to_string());
    let ext = source
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // Publish attachments atomically too: a crash during an import must never
    // leave a truncated asset referenced by an otherwise valid note.
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    for _ in 0..1_000 {
        let name = unique_name(&dir, &stem, &ext);
        let dest = dir.join(&name);
        match frontmatter::atomic_write_bytes_new(&dest, &bytes) {
            Ok(()) => {
                watcher_state.mark_write([dest.as_path()]);
                return Ok(build_imported_asset(&vault, &note, dest, name));
            }
            Err(frontmatter::AtomicCreateError::AlreadyExists) => continue,
            Err(frontmatter::AtomicCreateError::Other(error)) => return Err(error),
        }
    }
    Err("Could not allocate a unique asset filename".to_string())
}

#[tauri::command]
#[specta::specta]
fn import_asset_bytes(
    context: tauri::State<'_, vault_context::VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    bytes: Vec<u8>,
    suggested_ext: String,
) -> Result<ImportedAsset, String> {
    let note = paths::guard(&context, &note_path)?;
    let vault = context.root()?;
    let dir = assets_dir_for(&vault, &note);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = suggested_ext.trim_start_matches('.').to_lowercase();
    let ext = if ext.is_empty() {
        "png".to_string()
    } else {
        ext
    };
    let stem = format!("pasted-{}", now_millis());
    for _ in 0..1_000 {
        let name = unique_name(&dir, &stem, &ext);
        let dest = dir.join(&name);
        match frontmatter::atomic_write_bytes_new(&dest, &bytes) {
            Ok(()) => {
                watcher_state.mark_write([dest.as_path()]);
                return Ok(build_imported_asset(&vault, &note, dest, name));
            }
            Err(frontmatter::AtomicCreateError::AlreadyExists) => continue,
            Err(frontmatter::AtomicCreateError::Other(error)) => return Err(error),
        }
    }
    Err("Could not allocate a unique asset filename".to_string())
}

#[tauri::command]
#[specta::specta]
async fn pick_asset_file(
    app: tauri::AppHandle,
    images_only: bool,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    let mut builder = app.dialog().file();
    if images_only {
        builder = builder.add_filter("Image", IMAGE_EXTS);
    }
    builder.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let result = rx.await.map_err(|e| e.to_string())?;
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
#[specta::specta]
async fn open_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result = rx.await.map_err(|e| e.to_string())?;
    Ok(result.map(|p| p.to_string()))
}

/// Start a Rust-side `notify` watcher on the open vault.
///
/// Any external file-system change (create / modify / remove) that is NOT
/// caused by our own commands emits a `vault-file-changed` event to the
/// frontend.  The frontend replaces the old JS `plugin-fs::watch()` call with
/// a listener on that event.
///
/// Calling this again while a watcher is already running replaces the old one
/// (handles vault-switch).
#[tauri::command]
#[specta::specta]
fn start_vault_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    context: tauri::State<'_, vault_context::VaultContext>,
) -> Result<(), String> {
    use notify::Watcher;
    use tauri::Emitter;

    let vault = context.root()?;
    let generation = context.generation()?;
    state.active_generation.store(generation, Ordering::Release);
    let own_writes = Arc::clone(&state.own_writes);
    let active_generation = Arc::clone(&state.active_generation);
    let app_handle = app.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if active_generation.load(Ordering::Acquire) != generation {
            return;
        }

        // Map to a frontend-visible kind string; ignore everything else
        // (metadata-only touches, access times, etc.).
        let Some(kind_str) = watched_event_kind(&event.kind) else {
            return;
        };

        // Filter out .amby/ internals (DB WAL, lock files, etc.) and our own
        // atomic-write temp files, which would otherwise surface as
        // create/remove events on every save.
        let relevant: Vec<&PathBuf> = event
            .paths
            .iter()
            .filter(|p| {
                !p.components().any(|c| c.as_os_str() == ".amby") && !is_amby_temporary_file(p)
            })
            .collect();
        if relevant.is_empty() {
            return;
        }

        // Reconcile each path independently. A sibling must still be emitted
        // even when the same notify batch contains one of our own writes.
        for path in relevant {
            if reconcile_self_write(&own_writes, path, kind_str, generation) {
                continue;
            }
            let _ = app_handle.emit(
                "vault-file-changed",
                VaultFileChangedPayload {
                    kind: kind_str.to_string(),
                    path: path.to_string_lossy().to_string(),
                },
            );
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&vault, notify::RecursiveMode::Recursive)
        .map_err(|error| {
            state.active_generation.store(0, Ordering::Release);
            error.to_string()
        })?;

    // Storing drops (and stops) any previously active watcher.
    *state.watcher.lock().unwrap() = Some(watcher);
    context.set_watcher_identity(Some(generation))?;
    Ok(())
}

/// Stop the active vault watcher (called on vault close / app teardown).
#[tauri::command]
#[specta::specta]
fn stop_vault_watcher(
    state: tauri::State<'_, WatcherState>,
    context: tauri::State<'_, vault_context::VaultContext>,
) -> Result<(), String> {
    *state.watcher.lock().unwrap() = None;
    state.active_generation.store(0, Ordering::Release);
    context.set_watcher_identity(None)?;
    Ok(())
}

/// Save arbitrary text to a user-chosen location via the native save dialog.
/// The destination is picked here (never supplied by the webview), so there is
/// no arbitrary-write-from-JS vector — used for exporting presets.
#[tauri::command]
#[specta::specta]
async fn export_text_file(
    app: tauri::AppHandle,
    contents: String,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = path.to_string();
    frontmatter::atomic_write(Path::new(&path), &contents)?;
    Ok(Some(path))
}

/// Open a user-chosen text file via the native dialog and return its contents.
/// The path is chosen here, so the webview can't read arbitrary files — used
/// for importing presets (which live outside the vault).
#[tauri::command]
#[specta::specta]
async fn import_text_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let contents = fs::read_to_string(path.to_string()).map_err(|e| e.to_string())?;
    Ok(Some(contents))
}

/// Single source of truth for the command set — drives both the runtime
/// invoke handler and the generated TypeScript bindings (so the frontend IPC
/// types can't drift from the Rust signatures).
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new().commands(tauri_specta::collect_commands![
        load_vault,
        preflight_vault,
        apply_id_migration,
        inspect_id_migrations,
        recover_id_migration,
        list_files,
        read_file,
        write_file,
        save_conflict_copy,
        list_snapshots,
        restore_snapshot,
        read_snapshot_text,
        list_trash,
        restore_trash,
        read_note,
        write_note,
        get_note_metadata,
        get_note_properties,
        upsert_custom_property,
        delete_custom_property,
        list_tags,
        search_notes,
        get_link_graph,
        ensure_bundle,
        create_note,
        create_layer,
        create_canvas,
        attach_canvas_to_note,
        unlink_layer,
        delete_layer,
        note_layers,
        move_item,
        preview_move_refactor,
        create_file,
        create_folder,
        rename_item,
        preview_rename_refactor,
        delete_item,
        get_file_metadata,
        open_vault,
        start_vault_watcher,
        stop_vault_watcher,
        open_in_explorer,
        import_asset,
        import_asset_bytes,
        pick_asset_file,
        export_text_file,
        import_text_file,
        app_data::read_app_data,
        app_data::write_app_data,
        app_data::read_vault_meta,
        app_data::write_vault_meta,
        app_data::delete_vault_meta,
        ai::ai_chat,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    tracing::info!(event = "app_starting");
    let builder = specta_builder();
    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default()
                .bigint(specta_typescript::BigIntExportBehavior::Number)
                .header("// @ts-nocheck\n"),
            "../src/lib/bindings.ts",
        )
        .ok();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = show_and_focus_main_window(app) {
                tracing::warn!(event = "restore_window_failed", error = %error);
            }
        }))
        .manage(vault_context::VaultContext::new())
        .manage(WatcherState::new())
        .invoke_handler(builder.invoke_handler())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            set_macos_application_icon();

            // Tauri creates this window from the configuration before calling
            // `setup`. Keeping creation declarative avoids a dev-only window
            // lifecycle and guarantees exactly one `main` window per process.
            show_and_focus_main_window(app.handle())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        report_startup_error(&error);
    }
}

#[cfg(test)]
mod watcher_guard_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("amby-watcher-{name}-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn mutation_paths_collects_primary_changes_and_deletes() {
        let result = FsMutationResult {
            primary_id: None,
            primary_path: Some("/v/New.md".into()),
            path_changes: vec![
                PathChange {
                    old_path: "/v/Old.md".into(),
                    new_path: "/v/Bundle/Bundle.md".into(),
                },
                PathChange {
                    old_path: String::new(),
                    new_path: "/v/Created.md".into(),
                },
            ],
            deleted_paths: vec!["/v/Gone.md".into()],
            deleted_ids: vec![],
        };

        let paths = mutation_paths(&result);

        for expected in [
            "/v/New.md",
            "/v/Old.md",
            "/v/Bundle/Bundle.md",
            "/v/Created.md",
            "/v/Gone.md",
        ] {
            assert!(
                paths.contains(&PathBuf::from(expected)),
                "missing {expected}"
            );
        }
        assert!(!paths.iter().any(|p| p.as_os_str().is_empty()));
    }

    #[test]
    fn own_write_with_matching_fingerprint_is_suppressed() {
        let vault = temp_vault("own-write");
        let note = vault.join("Note.md");
        fs::write(&note, "own content").unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&note]);

        assert!(reconcile_self_write(&state.own_writes, &note, "modify", 1));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn external_write_inside_the_old_grace_window_is_emitted() {
        let vault = temp_vault("external-write");
        let note = vault.join("Note.md");
        fs::write(&note, "own content").unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&note]);
        fs::write(&note, "external content").unwrap();

        assert!(!reconcile_self_write(&state.own_writes, &note, "modify", 1));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn sibling_change_is_not_suppressed_by_a_self_write() {
        let vault = temp_vault("sibling");
        let own = vault.join("Own.md");
        let sibling = vault.join("Sibling.md");
        fs::write(&own, "own").unwrap();
        fs::write(&sibling, "external").unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&own]);

        assert!(!reconcile_self_write(
            &state.own_writes,
            &sibling,
            "modify",
            1
        ));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn atomic_rename_reconciles_old_and_new_paths() {
        let vault = temp_vault("rename");
        let old = vault.join("Old.md");
        let new = vault.join("New.md");
        fs::write(&old, "content").unwrap();
        fs::rename(&old, &new).unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&old, &new]);

        assert!(reconcile_self_write(&state.own_writes, &old, "rename", 1));
        assert!(reconcile_self_write(&state.own_writes, &new, "rename", 1));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn old_watcher_generation_is_ignored() {
        let vault = temp_vault("generation");
        let note = vault.join("Note.md");
        fs::write(&note, "content").unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&note]);

        assert!(!reconcile_self_write(&state.own_writes, &note, "modify", 2));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn watcher_ignores_atomic_write_temporary_files() {
        assert!(is_amby_temporary_file(Path::new(
            "/vault/.Note.md.amby-tmp-123-0"
        )));
        assert!(!is_amby_temporary_file(Path::new("/vault/Note.md")));
    }

    #[test]
    fn watcher_keeps_rename_events() {
        let kind = notify::EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Any,
        ));
        assert_eq!(watched_event_kind(&kind), Some("rename"));
    }
}

#[cfg(test)]
mod window_configuration_tests {
    use super::MAIN_WINDOW_LABEL;

    #[test]
    fn main_window_is_created_by_tauri_configuration() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must contain valid JSON");
        let windows = config["app"]["windows"]
            .as_array()
            .expect("app.windows must be an array");
        let main_window = windows
            .iter()
            .find(|window| window["label"] == MAIN_WINDOW_LABEL)
            .expect("the main window must be configured");

        assert_ne!(main_window["create"], false);
        assert_eq!(main_window["dataDirectory"], "WebView");
    }
}

#[cfg(test)]
mod specta_export {
    /// Regenerates src/lib/bindings.ts headlessly (`cargo test`), without
    /// launching the app.
    #[test]
    fn export_bindings() {
        super::specta_builder()
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number)
                    .header("// @ts-nocheck\n"),
                "../src/lib/bindings.ts",
            )
            .expect("failed to export typescript bindings");
    }
}
