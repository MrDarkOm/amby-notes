mod ai;
mod app_data;
mod bundle;
mod frontmatter;
mod model;
mod paths;
mod vault_index;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

use bundle::*;
use model::*;

// ── Rust-side file-system watcher ───────────────────────────────────────────

/// How long (ms) after our own write we suppress the watcher event for that
/// path. Covers the latency between `atomic_write` and the notify callback.
const SELF_WRITE_GRACE_MS: u128 = 2_000;

/// Payload emitted to the frontend when an external file-system change is
/// detected in the vault (creates, modifies, deletes).
#[derive(serde::Serialize, Clone)]
struct VaultFileChangedPayload {
    kind: String, // "create" | "modify" | "remove"
    path: String,
}

/// Holds the single open SQLite connection for the active vault.
/// All Tauri commands that need the DB lock this mutex and pass `&conn`
/// to vault_index functions, avoiding the per-command open/close overhead
/// (WAL pragma + schema check) that the old pattern incurred.
pub struct DbState {
    conn: Mutex<Option<rusqlite::Connection>>,
}

impl DbState {
    fn new() -> Self {
        Self { conn: Mutex::new(None) }
    }

    /// Open (or replace) the connection for `vault`.  Called from `load_vault`
    /// whenever a vault is activated.  Vault-switch is handled automatically:
    /// the old connection is dropped when `Some` is replaced.
    fn open(&self, vault: &std::path::Path) -> Result<(), String> {
        let new_conn = vault_index::open_connection(vault)?;
        *self.conn.lock().unwrap() = Some(new_conn);
        Ok(())
    }
}

/// Manages the active `notify` watcher for the open vault.  Stored in
/// `tauri::State` so it lives for the whole app lifetime.
pub struct WatcherState {
    /// The active watcher (dropped → OS unregisters the watch).
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Absolute paths written by our own commands + the write timestamp.
    /// The watcher callback skips their events within SELF_WRITE_GRACE_MS.
    own_writes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

impl WatcherState {
    fn new() -> Self {
        Self {
            watcher: Mutex::new(None),
            own_writes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Record paths our own commands just wrote so the watcher callback can
    /// suppress the resulting fs events within the grace window. Each path's
    /// parent dir is registered too: that covers directory-create events (bundle
    /// promotion, new folders) and macOS FSEvents that report the parent dir
    /// instead of the changed file.
    fn mark_write<I, P>(&self, paths: I)
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let mut guard = self.own_writes.lock().unwrap();
        let now = Instant::now();
        for p in paths {
            let path = p.as_ref();
            guard.insert(path.to_path_buf(), now);
            if let Some(parent) = path.parent() {
                guard.insert(parent.to_path_buf(), now);
            }
        }
        guard.retain(|_, at| at.elapsed().as_millis() < SELF_WRITE_GRACE_MS * 4);
    }
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

fn deleted_ids_for_paths(
    conn: &rusqlite::Connection,
    vault_path: &Path,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let notes = vault_index::list_notes(conn, vault_path)?;
    let by_path: std::collections::HashMap<_, _> =
        notes.into_iter().map(|note| (note.path, note.id)).collect();
    Ok(paths
        .iter()
        .filter_map(|path| by_path.get(path).cloned())
        .collect())
}

fn sync_mutation_result(
    conn: &rusqlite::Connection,
    vault_path: &Path,
    mut result: FsMutationResult,
) -> Result<FsMutationResult, String> {
    let loaded = vault_index::load_vault(conn, vault_path)?;
    result.primary_id = result.primary_path.as_ref().and_then(|primary_path| {
        loaded
            .notes
            .iter()
            .find(|note| &note.path == primary_path)
            .map(|note| note.id.clone())
    });
    Ok(result)
}

/// Mark `vault_path` as the active vault: record it for path guards and grant
/// the fs + asset-protocol scopes dynamically (instead of a static recursive
/// scope over the whole home directory).
fn activate_vault(
    app: &tauri::AppHandle,
    scope: &paths::VaultScope,
    vault_path: &str,
) -> Result<PathBuf, String> {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    let canonical = Path::new(vault_path)
        .canonicalize()
        .map_err(|e| format!("Vault not accessible: {e}"))?;
    scope.set(canonical.clone());
    let _ = app.fs_scope().allow_directory(&canonical, true);
    let _ = app.asset_protocol_scope().allow_directory(&canonical, true);
    Ok(canonical)
}

#[tauri::command]
#[specta::specta]
fn load_vault(
    app: tauri::AppHandle,
    scope: tauri::State<'_, paths::VaultScope>,
    db: tauri::State<'_, DbState>,
    vault_path: String,
) -> Result<vault_index::LoadVaultResult, String> {
    let canonical = activate_vault(&app, &scope, &vault_path)?;
    // Open (or replace) the persistent connection for this vault.
    db.open(&canonical)?;
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().unwrap();
    vault_index::load_vault(conn, &canonical)
}

#[tauri::command]
#[specta::specta]
fn list_files(
    db: tauri::State<'_, DbState>,
    vault_path: String,
) -> Result<Vec<vault_index::TreeItem>, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::load_vault(conn, Path::new(&vault_path)).map(|loaded| loaded.tree)
}

#[tauri::command]
#[specta::specta]
fn read_file(scope: tauri::State<paths::VaultScope>, path: String) -> Result<String, String> {
    paths::guard(&scope, &path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn write_file(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
    content: String,
) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())?;
    watcher_state.mark_write([Path::new(&path)]);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn read_note(
    db: tauri::State<'_, DbState>,
    vault_path: String,
    note_id: String,
) -> Result<String, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::read_note(conn, Path::new(&vault_path), &note_id)
}

#[tauri::command]
#[specta::specta]
fn write_note(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    note_id: String,
    content: String,
) -> Result<(), String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let path = vault_index::write_note(conn, Path::new(&vault_path), &note_id, &content)?;
    drop(conn_guard); // release DB lock before touching watcher state
    watcher_state.mark_write([path]);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn get_note_metadata(
    db: tauri::State<'_, DbState>,
    vault_path: String,
    note_id: String,
) -> Result<NoteMetadata, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let note = vault_index::note_metadata(conn, Path::new(&vault_path), &note_id)?;
    Ok(NoteMetadata {
        created: None,
        modified: note.modified,
        word_count: note.word_count,
    })
}

#[tauri::command]
#[specta::specta]
fn list_tags(
    db: tauri::State<'_, DbState>,
    vault_path: String,
) -> Result<Vec<vault_index::TagEntry>, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::list_tags(conn, Path::new(&vault_path))
}

#[tauri::command]
#[specta::specta]
fn search_notes(
    db: tauri::State<'_, DbState>,
    vault_path: String,
    query: String,
) -> Result<Vec<vault_index::SearchResult>, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::search_notes(conn, Path::new(&vault_path), &query)
}

#[tauri::command]
#[specta::specta]
fn get_link_graph(
    db: tauri::State<'_, DbState>,
    vault_path: String,
) -> Result<vault_index::LinkGraph, String> {
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::link_graph(conn, Path::new(&vault_path))
}

#[tauri::command]
#[specta::specta]
fn ensure_bundle(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    path: String,
) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let (primary, path_changes) = ensure_bundle_path(Path::new(&path))?;
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
    sync_mutation_result(conn, Path::new(&vault_path), result)
}

#[tauri::command]
#[specta::specta]
fn create_note(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    parent_path: String,
    name: String,
) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &parent_path)?;
    let result = create_note_impl(Path::new(&parent_path), &name)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    sync_mutation_result(conn, Path::new(&vault_path), result)
}

#[tauri::command]
#[specta::specta]
fn create_layer(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    kind: String,
) -> Result<LayerResult, String> {
    paths::guard(&scope, &note_path)?;
    let result = create_layer_impl(Path::new(&note_path), &kind)?;
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
    Ok(result)
}

#[tauri::command]
#[specta::specta]
fn create_canvas(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    paths::guard_in(&vault_path, &parent_path)?;
    let path = create_canvas_impl(Path::new(&parent_path), &name)?;
    watcher_state.mark_write([path.as_path()]);
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    vault_index::load_vault(conn, Path::new(&vault_path))?;
    Ok(path_string(&path))
}

#[tauri::command]
#[specta::specta]
fn attach_canvas_to_note(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    canvas_path: String,
) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &canvas_path)?;
    let result = attach_canvas_impl(Path::new(&canvas_path))?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    sync_mutation_result(conn, Path::new(&vault_path), result)
}

#[tauri::command]
#[specta::specta]
fn unlink_layer(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    note_path: String,
    kind: String,
) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let result = unlink_layer_impl(Path::new(&note_path), &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    sync_mutation_result(conn, Path::new(&vault_path), result)
}

#[tauri::command]
#[specta::specta]
fn delete_layer(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    note_path: String,
    kind: String,
) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let mut result = delete_layer_impl(Path::new(&note_path), &kind)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    if !result.deleted_paths.is_empty() {
        result.deleted_ids = deleted_ids_for_paths(conn, Path::new(&vault_path), &result.deleted_paths)?;
    }
    vault_index::load_vault(conn, Path::new(&vault_path))?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
fn note_layers(
    scope: tauri::State<paths::VaultScope>,
    note_path: String,
) -> Result<NoteLayers, String> {
    paths::guard(&scope, &note_path)?;
    let path = Path::new(&note_path);
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
    let stem = file_stem(path)?;
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
    vault_path: String,
    source_path: String,
    target_path: String,
) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &source_path)?;
    paths::guard_in(&vault_path, &target_path)?;
    let result = move_item_impl(Path::new(&source_path), Path::new(&target_path))?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    sync_mutation_result(conn, Path::new(&vault_path), result)
}

#[tauri::command]
#[specta::specta]
fn create_file(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if Path::new(&path).exists() {
        return Err(format!("File already exists: {path}"));
    }
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())?;
    watcher_state.mark_write([Path::new(&path)]);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn create_folder(
    scope: tauri::State<paths::VaultScope>,
    watcher_state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if Path::new(&path).exists() {
        return Err(format!("Folder already exists: {path}"));
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    watcher_state.mark_write([Path::new(&path)]);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn rename_item(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    path: String,
    new_name: String,
) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let result = rename_item_impl(Path::new(&path), &new_name)?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    sync_mutation_result(conn, Path::new(&vault_path), result)
}

#[tauri::command]
#[specta::specta]
fn delete_item(
    db: tauri::State<'_, DbState>,
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    path: String,
) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let mut result = delete_item_impl(Path::new(&path))?;
    watcher_state.mark_write(mutation_paths(&result));
    let conn_guard = db.conn.lock().unwrap();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    result.deleted_ids = deleted_ids_for_paths(conn, Path::new(&vault_path), &result.deleted_paths)?;
    vault_index::load_vault(conn, Path::new(&vault_path))?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
fn get_file_metadata(
    scope: tauri::State<paths::VaultScope>,
    path: String,
) -> Result<FileMetadata, String> {
    paths::guard(&scope, &path)?;
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
fn open_in_explorer(
    scope: tauri::State<paths::VaultScope>,
    path: String,
) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let arg = format!("/select,\"{}\"", path);
        std::process::Command::new("explorer")
            .raw_arg(&arg)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
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
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    note_path: String,
    source_path: String,
) -> Result<ImportedAsset, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let vault = Path::new(&vault_path);
    let note = Path::new(&note_path);
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("Source is not a file: {source_path}"));
    }
    let dir = assets_dir_for(vault, note);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".to_string());
    let ext = source
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = unique_name(&dir, &stem, &ext);
    let dest = dir.join(&name);
    fs::copy(source, &dest).map_err(|e| e.to_string())?;
    watcher_state.mark_write([dest.as_path()]);
    Ok(build_imported_asset(vault, note, dest, name))
}

#[tauri::command]
#[specta::specta]
fn import_asset_bytes(
    watcher_state: tauri::State<'_, WatcherState>,
    vault_path: String,
    note_path: String,
    bytes: Vec<u8>,
    suggested_ext: String,
) -> Result<ImportedAsset, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let vault = Path::new(&vault_path);
    let note = Path::new(&note_path);
    let dir = assets_dir_for(vault, note);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = suggested_ext.trim_start_matches('.').to_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    let stem = format!("pasted-{}", now_millis());
    let name = unique_name(&dir, &stem, &ext);
    let dest = dir.join(&name);
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    watcher_state.mark_write([dest.as_path()]);
    Ok(build_imported_asset(vault, note, dest, name))
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
    vault_path: String,
) -> Result<(), String> {
    use notify::Watcher;
    use tauri::Emitter;

    let vault = PathBuf::from(&vault_path);
    let own_writes = Arc::clone(&state.own_writes);
    let app_handle = app.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };

        // Map to a frontend-visible kind string; ignore everything else
        // (metadata-only touches, access times, etc.).
        let kind_str = match &event.kind {
            notify::EventKind::Create(_) => "create",
            notify::EventKind::Modify(notify::event::ModifyKind::Data(_)) => "modify",
            notify::EventKind::Remove(_) => "remove",
            _ => return,
        };

        // Filter out .amby/ internals (DB WAL, lock files, etc.) and our own
        // atomic-write temp files, which would otherwise surface as
        // create/remove events on every save.
        let relevant: Vec<&PathBuf> = event
            .paths
            .iter()
            .filter(|p| {
                !p.components().any(|c| c.as_os_str() == ".amby")
                    && !p
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().ends_with(".amby-tmp"))
            })
            .collect();
        if relevant.is_empty() {
            return;
        }

        // Atomic writes and renames can surface as Create or Remove rather than
        // Modify, so suppress every event kind for paths recently touched by us.
        {
            let guard = own_writes.lock().unwrap();
            if relevant.iter().all(|p| {
                guard
                    .get(*p)
                    .is_some_and(|at| at.elapsed().as_millis() < SELF_WRITE_GRACE_MS)
            }) {
                return;
            }
        }

        // Emit one event per changed path.
        for path in relevant {
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
        .map_err(|e| e.to_string())?;

    // Storing drops (and stops) any previously active watcher.
    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

/// Stop the active vault watcher (called on vault close / app teardown).
#[tauri::command]
#[specta::specta]
fn stop_vault_watcher(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    *state.watcher.lock().unwrap() = None;
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
    fs::write(&path, contents).map_err(|e| e.to_string())?;
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
        list_files,
        read_file,
        write_file,
        read_note,
        write_note,
        get_note_metadata,
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
        create_file,
        create_folder,
        rename_item,
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(paths::VaultScope::default())
        .manage(DbState::new())
        .manage(WatcherState::new())
        .invoke_handler(builder.invoke_handler())
        .setup(|_app| {
            // In dev mode (`tauri dev`) the Tauri CLI force-creates the window
            // from config before this hook runs, so we skip manual creation
            // there — the WebView2 cache location doesn't matter for development.
            //
            // In release builds the CLI does NOT inject windows, so
            // `"create": false` in tauri.conf.json is respected and we create
            // the window here, allowing us to redirect the WebView2 / WebKitGTK
            // cache to Amby\notes\WebView\ instead of the default amby-notes\.
            #[cfg(not(debug_assertions))]
            {
                use tauri::{Manager, WebviewWindowBuilder};

                let data_dir = _app
                    .path()
                    .local_data_dir()?
                    .join("Amby")
                    .join("notes")
                    .join("WebView");

                let window_config = &_app.config().app.windows[0];
                WebviewWindowBuilder::from_config(_app.handle(), window_config)?
                    .data_directory(data_dir)
                    .build()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}

#[cfg(test)]
mod watcher_guard_tests {
    use super::*;

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
    fn mark_write_records_path_and_parent_dir() {
        let state = WatcherState::new();
        state.mark_write([Path::new("/vault/Folder/Note.md")]);

        let guard = state.own_writes.lock().unwrap();
        assert!(guard.contains_key(Path::new("/vault/Folder/Note.md")));
        assert!(guard.contains_key(Path::new("/vault/Folder")));
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
