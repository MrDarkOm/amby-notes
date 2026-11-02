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
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

static APP_DATA_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_app_data_writes() -> Result<MutexGuard<'static, ()>, String> {
    APP_DATA_WRITE_LOCK
        .lock()
        .map_err(|_| "appDataLockFailed".into())
}

use tauri::Manager;

use crate::frontmatter;
use crate::paths;
use crate::vault_context::VaultContext;

/// Root of the global app-data area: `{local_data_dir}/Amby/notes`. Created if missing.
pub fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "native-contract")]
    {
        let root = app
            .try_state::<crate::native_contract::NativeAppDataRoot>()
            .ok_or("Native harness requires isolated app data")?
            .0
            .clone();
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(root)
    }
    #[cfg(not(feature = "native-contract"))]
    {
        let root = app
            .path()
            .local_data_dir()
            .map_err(|e| e.to_string())?
            .join("Amby")
            .join("notes");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(root)
    }
}

/// Root of the per-vault metadata area: `{vault}/.amby`. Created if missing.
fn vault_meta_root(context: &VaultContext) -> Result<PathBuf, String> {
    let root = context.root()?.join(".amby");
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

fn write_all(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    frontmatter::atomic_write(path, contents)
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
    let _guard = lock_app_data_writes()?;
    let root = app_root(&app)?;
    let path = paths::confine_rel(&root, &rel)?;
    if let Some(file) = ai_file(&root, &path)? {
        guard_ai_version(&path, &contents, file)?;
    }
    write_all(&path, &contents)
}

/// Compare and publish while holding the same lock as all app-data writers.
#[tauri::command]
#[specta::specta]
pub fn compare_write_app_data(
    app: tauri::AppHandle,
    rel: String,
    expected: Option<String>,
    contents: String,
) -> Result<bool, String> {
    let _guard = lock_app_data_writes()?;
    let root = app_root(&app)?;
    let path = paths::confine_rel(&root, &rel)?;
    if read_opt(&path)? != expected {
        return Ok(false);
    }
    if let Some(file) = ai_file(&root, &path)? {
        guard_ai_version(&path, &contents, file)?;
    }
    write_all(&path, &contents)?;
    Ok(true)
}

/// Which file the version guard is looking at.
#[derive(Clone, Copy)]
enum AiFile {
    /// settings.json, whose `ai` section may still hold a migrated version.
    Settings,
    /// ai-connections.json, which is an AI section of its own.
    Connections,
}

fn ai_file(root: &Path, path: &Path) -> Result<Option<AiFile>, String> {
    if path == paths::confine_rel(root, "settings.json")? {
        Ok(Some(AiFile::Settings))
    } else if path == paths::confine_rel(root, crate::ai::settings_migration::CONNECTIONS)? {
        Ok(Some(AiFile::Connections))
    } else {
        Ok(None)
    }
}

/// Do not let an older renderer overwrite a migrated or future AI section.
fn guard_ai_version(path: &Path, next: &str, file: AiFile) -> Result<(), String> {
    fn version(raw: &str, file: AiFile) -> Option<serde_json::Value> {
        let root: serde_json::Value =
            serde_json::from_str(raw.strip_prefix('\u{feff}').unwrap_or(raw)).ok()?;
        match file {
            AiFile::Settings => root.get("ai")?.get("version").cloned(),
            AiFile::Connections => root.get("version").cloned(),
        }
    }
    let existing = match fs::read_to_string(path) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("settingsUnavailable".into()),
    };
    if matches!(file, AiFile::Connections) && version(next, file) != Some(1.into()) {
        // The file is only ever a version 1 section, whether or not it exists yet.
        return Err("unsupportedAiVersion".into());
    }
    if let Some(current) = existing.as_deref().and_then(|raw| version(raw, file)) {
        if current != 1 || version(next, file) != Some(current) {
            return Err("unsupportedAiVersion".into());
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn read_vault_meta(
    context: tauri::State<VaultContext>,
    rel: String,
) -> Result<Option<String>, String> {
    let path = paths::confine_rel(&vault_meta_root(&context)?, &rel)?;
    read_opt(&path)
}

#[tauri::command]
#[specta::specta]
pub fn write_vault_meta(
    context: tauri::State<VaultContext>,
    rel: String,
    contents: String,
) -> Result<(), String> {
    let path = paths::confine_rel(&vault_meta_root(&context)?, &rel)?;
    write_all(&path, &contents)
}

#[tauri::command]
#[specta::specta]
pub fn delete_vault_meta(context: tauri::State<VaultContext>, rel: String) -> Result<(), String> {
    let path = paths::confine_rel(&vault_meta_root(&context)?, &rel)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ulid::Ulid;

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("amby-appdata-{name}-{}", Ulid::generate()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn test_write_and_read_app_data() {
        let dir = temp_test_dir("readwrite");
        let file_path = dir.join("test.json");

        assert_eq!(read_opt(&file_path).unwrap(), None);

        write_all(&file_path, "{\"key\":\"value\"}").expect("write");
        assert_eq!(
            read_opt(&file_path).unwrap(),
            Some("{\"key\":\"value\"}".to_string())
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_write_creates_intermediate_parent_directories() {
        let dir = temp_test_dir("nested");
        let file_path = dir.join("nested").join("sub").join("config.json");

        write_all(&file_path, "{\"schemaVersion\":1}").expect("write");
        assert_eq!(
            read_opt(&file_path).unwrap(),
            Some("{\"schemaVersion\":1}".to_string())
        );

        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn refuses_old_or_future_ai_writes() {
        let dir = temp_test_dir("ai-version");
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"ai":{"version":1}}"#).unwrap();
        assert!(guard_ai_version(&path, r#"{"ai":{"models":[]}}"#, AiFile::Settings).is_err());
        assert!(guard_ai_version(&path, r#"{"ai":{"version":1}}"#, AiFile::Settings).is_ok());
        fs::write(&path, r#"{"ai":{"version":2}}"#).unwrap();
        assert!(guard_ai_version(&path, r#"{"ai":{"version":2}}"#, AiFile::Settings).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn the_connections_file_only_ever_holds_version_one() {
        let dir = temp_test_dir("ai-connections-version");
        let path = dir.join("ai-connections.json");
        // Even before it exists, an older shape or another version is refused.
        assert!(guard_ai_version(&path, r#"{"models":[]}"#, AiFile::Connections).is_err());
        assert!(guard_ai_version(&path, r#"{"version":2}"#, AiFile::Connections).is_err());
        assert!(
            guard_ai_version(&path, r#"{"version":1,"models":[]}"#, AiFile::Connections).is_ok()
        );
        fs::write(&path, r#"{"version":1}"#).unwrap();
        assert!(guard_ai_version(&path, r#"{"models":[]}"#, AiFile::Connections).is_err());
        assert!(guard_ai_version(&path, r#"{"version":1,"x":1}"#, AiFile::Connections).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }
}
