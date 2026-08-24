use std::fs;
use std::path::Path;

use crate::bundle::*;
use crate::frontmatter;
use crate::model::*;
use crate::paths;
use crate::vault_context::VaultContext;
use crate::watcher::{self, WatcherState};

#[tauri::command]
#[specta::specta]
pub async fn pick_asset_file(
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
pub fn import_asset(
    context: tauri::State<'_, VaultContext>,
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
    let meta = source
        .metadata()
        .map_err(|e| format!("Failed to read source metadata: {e}"))?;
    if meta.len() > MAX_ATTACHMENT_FILE_SIZE {
        return Err(format!(
            "Imported file ({} MB) exceeds maximum allowed limit ({} MB)",
            meta.len() / (1024 * 1024),
            MAX_ATTACHMENT_FILE_SIZE / (1024 * 1024)
        ));
    }

    let dir = assets_dir_for(&vault, &note);
    let dir = paths::confine(&vault, &dir)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".to_string());
    let raw_ext = source
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = sanitize_ext(&raw_ext);

    for _ in 0..1_000 {
        let name = unique_name(&dir, &stem, &ext);
        let dest = dir.join(&name);
        let dest = paths::confine(&vault, &dest)?;
        let expected = watcher::path_fingerprint(source);
        let prepared = watcher_state.prepare_write([(&dest, expected)]);
        match frontmatter::atomic_copy_file_new(source, &dest, MAX_ATTACHMENT_FILE_SIZE) {
            Ok(_) => {
                watcher_state.confirm_prepared_write(&prepared);
                return Ok(build_imported_asset(&vault, &note, dest, name));
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
    Err("Could not allocate a unique asset filename".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn import_asset_bytes(
    context: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    note_path: String,
    bytes: Vec<u8>,
    suggested_ext: String,
) -> Result<ImportedAsset, String> {
    if bytes.len() > MAX_PASTED_BYTES {
        return Err(format!(
            "Pasted payload ({} MB) exceeds maximum allowed limit ({} MB)",
            bytes.len() / (1024 * 1024),
            MAX_PASTED_BYTES / (1024 * 1024)
        ));
    }
    let note = paths::guard(&context, &note_path)?;
    let vault = context.root()?;
    let dir = assets_dir_for(&vault, &note);
    let dir = paths::confine(&vault, &dir)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let sniffed = sniff_image_format(&bytes);
    let raw_ext = if let Some(fmt) = sniffed {
        fmt
    } else {
        &suggested_ext
    };
    let ext = sanitize_ext(raw_ext);
    let stem = format!("pasted-{}", now_millis());
    for _ in 0..1_000 {
        let name = unique_name(&dir, &stem, &ext);
        let dest = dir.join(&name);
        let dest = paths::confine(&vault, &dest)?;
        let prepared =
            watcher_state.prepare_write([(&dest, watcher::fingerprint_for_bytes(&bytes))]);
        match frontmatter::atomic_write_bytes_new(&dest, &bytes) {
            Ok(()) => {
                watcher_state.confirm_prepared_write(&prepared);
                return Ok(build_imported_asset(&vault, &note, dest, name));
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
    Err("Could not allocate a unique asset filename".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn open_in_explorer(
    scope: tauri::State<paths::VaultScope>,
    path: String,
) -> Result<(), String> {
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
pub async fn export_text_file(
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

#[tauri::command]
#[specta::specta]
pub async fn import_text_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
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
