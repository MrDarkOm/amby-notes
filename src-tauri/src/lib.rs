use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone)]
pub struct TreeItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeItem>>,
}

#[derive(Serialize)]
pub struct FileMetadata {
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub word_count: usize,
}

fn scan_dir(dir: &Path) -> Result<Vec<TreeItem>, String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .collect();

    // folders first, then files, each group alphabetically
    entries.sort_by_key(|e| {
        let is_file = e.path().is_file() as u8;
        let name = e.file_name().to_string_lossy().to_lowercase();
        (is_file, name)
    });

    let mut items = Vec::new();
    for entry in entries {
        let path = entry.path();
        let raw_name = entry.file_name().to_string_lossy().to_string();
        let abs_id = path.to_string_lossy().to_string();

        if path.is_dir() {
            let children = scan_dir(&path)?;
            items.push(TreeItem {
                id: abs_id,
                name: raw_name,
                item_type: "folder".to_string(),
                icon: "folder".to_string(),
                children: Some(children),
            });
        } else if path.extension().map_or(false, |ext| ext == "md") {
            let display_name = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            items.push(TreeItem {
                id: abs_id,
                name: display_name,
                item_type: "file".to_string(),
                icon: "file".to_string(),
                children: None,
            });
        }
    }
    Ok(items)
}

#[tauri::command]
fn list_files(vault_path: String) -> Result<Vec<TreeItem>, String> {
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Not a directory: {vault_path}"));
    }
    scan_dir(path)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_item(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_item(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
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
fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
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
fn open_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result = rx.recv().map_err(|e| e.to_string())?;
    Ok(result.map(|p| p.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            list_files,
            read_file,
            write_file,
            create_file,
            create_folder,
            rename_item,
            delete_item,
            get_file_metadata,
            open_vault,
            open_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
