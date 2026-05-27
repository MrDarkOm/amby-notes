mod bundle;
mod frontmatter;
mod model;
mod paths;
mod vault_index;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use bundle::*;
use model::*;

fn deleted_ids_for_paths(vault_path: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let conn = vault_index::open_connection(vault_path)?;
    let notes = vault_index::list_notes(&conn, vault_path)?;
    let by_path: std::collections::HashMap<_, _> =
        notes.into_iter().map(|note| (note.path, note.id)).collect();
    Ok(paths
        .iter()
        .filter_map(|path| by_path.get(path).cloned())
        .collect())
}

fn sync_mutation_result(vault_path: &Path, mut result: FsMutationResult) -> Result<FsMutationResult, String> {
    let loaded = vault_index::load_vault(vault_path)?;
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
async fn load_vault(
    app: tauri::AppHandle,
    scope: tauri::State<'_, paths::VaultScope>,
    vault_path: String,
) -> Result<vault_index::LoadVaultResult, String> {
    activate_vault(&app, &scope, &vault_path)?;
    tauri::async_runtime::spawn_blocking(move || vault_index::load_vault(Path::new(&vault_path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_files(vault_path: String) -> Result<Vec<vault_index::TreeItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vault_index::load_vault(Path::new(&vault_path)).map(|loaded| loaded.tree)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn read_file(scope: tauri::State<paths::VaultScope>, path: String) -> Result<String, String> {
    paths::guard(&scope, &path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(
    scope: tauri::State<paths::VaultScope>,
    path: String,
    content: String,
) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_note(vault_path: String, note_id: String) -> Result<String, String> {
    vault_index::read_note(Path::new(&vault_path), &note_id)
}

#[tauri::command]
fn write_note(vault_path: String, note_id: String, content: String) -> Result<(), String> {
    vault_index::write_note(Path::new(&vault_path), &note_id, &content)
}

#[tauri::command]
fn get_note_metadata(vault_path: String, note_id: String) -> Result<NoteMetadata, String> {
    let note = vault_index::note_metadata(Path::new(&vault_path), &note_id)?;
    Ok(NoteMetadata {
        created: None,
        modified: note.modified,
        word_count: note.word_count,
    })
}

#[tauri::command]
async fn list_tags(vault_path: String) -> Result<Vec<vault_index::TagEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || vault_index::list_tags(Path::new(&vault_path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_notes(vault_path: String, query: String) -> Result<Vec<vault_index::SearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vault_index::search_notes(Path::new(&vault_path), &query)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_link_graph(vault_path: String) -> Result<vault_index::LinkGraph, String> {
    tauri::async_runtime::spawn_blocking(move || vault_index::link_graph(Path::new(&vault_path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn ensure_bundle(vault_path: String, path: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let (primary, path_changes) = ensure_bundle_path(Path::new(&path))?;
    sync_mutation_result(Path::new(&vault_path), FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&primary)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}

#[tauri::command]
fn create_note(vault_path: String, parent_path: String, name: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &parent_path)?;
    let result = create_note_impl(Path::new(&parent_path), &name)?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn create_layer(
    scope: tauri::State<paths::VaultScope>,
    note_path: String,
    kind: String,
) -> Result<LayerResult, String> {
    paths::guard(&scope, &note_path)?;
    create_layer_impl(Path::new(&note_path), &kind)
}

#[tauri::command]
fn create_canvas(vault_path: String, parent_path: String, name: String) -> Result<String, String> {
    paths::guard_in(&vault_path, &parent_path)?;
    let path = create_canvas_impl(Path::new(&parent_path), &name)?;
    vault_index::load_vault(Path::new(&vault_path))?;
    Ok(path_string(&path))
}

#[tauri::command]
fn attach_canvas_to_note(vault_path: String, canvas_path: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &canvas_path)?;
    let result = attach_canvas_impl(Path::new(&canvas_path))?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn unlink_layer(vault_path: String, note_path: String, kind: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let result = unlink_layer_impl(Path::new(&note_path), &kind)?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn delete_layer(vault_path: String, note_path: String, kind: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let mut result = delete_layer_impl(Path::new(&note_path), &kind)?;
    if !result.deleted_paths.is_empty() {
        result.deleted_ids = deleted_ids_for_paths(Path::new(&vault_path), &result.deleted_paths)?;
    }
    vault_index::load_vault(Path::new(&vault_path))?;
    Ok(result)
}

#[tauri::command]
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
fn move_item(vault_path: String, source_path: String, target_path: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &source_path)?;
    paths::guard_in(&vault_path, &target_path)?;
    let result = move_item_impl(Path::new(&source_path), Path::new(&target_path))?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn create_file(scope: tauri::State<paths::VaultScope>, path: String) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if Path::new(&path).exists() {
        return Err(format!("File already exists: {path}"));
    }
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_folder(scope: tauri::State<paths::VaultScope>, path: String) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if Path::new(&path).exists() {
        return Err(format!("Folder already exists: {path}"));
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_item(vault_path: String, path: String, new_name: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let result = rename_item_impl(Path::new(&path), &new_name)?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn delete_item(vault_path: String, path: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let mut result = delete_item_impl(Path::new(&path))?;
    result.deleted_ids = deleted_ids_for_paths(Path::new(&vault_path), &result.deleted_paths)?;
    vault_index::load_vault(Path::new(&vault_path))?;
    Ok(result)
}

#[tauri::command]
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
fn import_asset(
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
    Ok(build_imported_asset(vault, note, dest, name))
}

#[tauri::command]
fn import_asset_bytes(
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
    Ok(build_imported_asset(vault, note, dest, name))
}

#[tauri::command]
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(paths::VaultScope::default())
        .invoke_handler(tauri::generate_handler![
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
            open_in_explorer,
            import_asset,
            import_asset_bytes,
            pick_asset_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
