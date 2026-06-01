//! Tiered settings storage commands.
//!
//! Two roots, both fail-closed via `paths::confine_rel`:
//! - **Global** `{local_data_dir}/Amby/` — workspace list, last opened, global
//!   settings. Survives across all vaults and machines-per-user.
//! - **Per-vault** `{vault}/.amby/` — workspace settings, session memory and
//!   per-note block sidecars (`blocks/<id>.json`). Travels with the vault folder.
//!
//! These wrap `std::fs` directly (no JS fs-plugin capability needed). The webview
//! only ever supplies a relative file name; absolute paths and `..` are rejected.

use std::fs;
use std::path::PathBuf;

use tauri::Manager;

use crate::paths::{self, VaultScope};

/// Root of the global app-data area: `{local_data_dir}/Amby/notes`. Created if missing.
fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .local_data_dir()
        .map_err(|e| e.to_string())?
        .join("Amby")
        .join("notes");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// Root of the per-vault metadata area: `{vault}/.amby`. Created if missing.
fn vault_meta_root(scope: &VaultScope) -> Result<PathBuf, String> {
    let root = scope.get()?.join(".amby");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn read_opt(path: &PathBuf) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_all(path: &PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn read_app_data(app: tauri::AppHandle, rel: String) -> Result<Option<String>, String> {
    let path = paths::confine_rel(&app_root(&app)?, &rel)?;
    read_opt(&path)
}

#[tauri::command]
#[specta::specta]
pub fn write_app_data(app: tauri::AppHandle, rel: String, contents: String) -> Result<(), String> {
    let path = paths::confine_rel(&app_root(&app)?, &rel)?;
    write_all(&path, &contents)
}

#[tauri::command]
#[specta::specta]
pub fn read_vault_meta(
    scope: tauri::State<VaultScope>,
    rel: String,
) -> Result<Option<String>, String> {
    let path = paths::confine_rel(&vault_meta_root(&scope)?, &rel)?;
    read_opt(&path)
}

#[tauri::command]
#[specta::specta]
pub fn write_vault_meta(
    scope: tauri::State<VaultScope>,
    rel: String,
    contents: String,
) -> Result<(), String> {
    let path = paths::confine_rel(&vault_meta_root(&scope)?, &rel)?;
    write_all(&path, &contents)
}

#[tauri::command]
#[specta::specta]
pub fn delete_vault_meta(scope: tauri::State<VaultScope>, rel: String) -> Result<(), String> {
    let path = paths::confine_rel(&vault_meta_root(&scope)?, &rel)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
