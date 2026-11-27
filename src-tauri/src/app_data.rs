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
use crate::lock_util::LockExt;
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
        let root = match debug_app_data_override() {
            Some(root) => root,
            None => app
                .path()
                .local_data_dir()
                .map_err(|e| e.to_string())?
                .join("Amby")
                .join("notes"),
        };
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(root)
    }
}

/// A debug build started with `AMBY_APP_DATA_DIR` (the CLI's variable) keeps its workspace list,
/// settings and AI sign-ins there, so a test copy never opens or changes the owner's vaults. A
/// release build ignores the variable.
#[cfg(not(feature = "native-contract"))]
fn debug_app_data_override() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os("AMBY_APP_DATA_DIR")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// Root of the per-vault metadata area: `{vault}/.amby`. Created if missing.
fn vault_meta_root(context: &VaultContext) -> Result<PathBuf, String> {
    let root = context.root()?.join(".amby");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// Names the renderer may use in the app-data area. Everything else there (the
/// sign-in files of Codex and Claude, for one) is out of reach of these commands.
/// Keep in step with the constants in `app-config.ts`, `modules/types.ts`,
/// `package-manager/catalog.ts` and `notices/journal-storage.ts`.
const APP_DATA_FILES: &[&str] = &[
    "workspaces.json",
    "settings.json",
    "ai-connections.json",
    "modules.json",
    "module-catalog.json",
];

/// Names the renderer may use inside `.amby/` (`app-config.ts`, `graph-layout-store.ts`).
const VAULT_META_FILES: &[&str] = &["workspace.json", "session.json", "graph-layout.json"];

fn is_hex_name(name: &str, len: usize) -> bool {
    name.len() == len
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `settings.json.corrupt-1700000000000.json` is the backup the renderer makes
/// of a damaged file; the name it is a backup of comes back.
fn strip_corrupt_backup(rel: &str) -> &str {
    if let Some(head) = rel.strip_suffix(".json") {
        if let Some((name, stamp)) = head.rsplit_once(".corrupt-") {
            if !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()) {
                return name;
            }
        }
    }
    rel
}

/// Is `rel` one of the files the renderer keeps in the app-data area?
pub(crate) fn app_data_name_allowed(rel: &str) -> bool {
    let name = strip_corrupt_backup(rel);
    if APP_DATA_FILES.contains(&name) {
        return true;
    }
    // The notice journal of one vault: `notice-journal/<16 hex digits>.json`.
    name.strip_prefix("notice-journal/")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|key| is_hex_name(key, 16))
}

/// Is `rel` one of the files the renderer keeps in `.amby/`?
pub(crate) fn vault_meta_name_allowed(rel: &str) -> bool {
    let name = strip_corrupt_backup(rel);
    if VAULT_META_FILES.contains(&name) {
        return true;
    }
    // A sidecar of a database block: `blocks/<id>.json`, the id being a UUID or
    // `blk-<ms>-<base36>`: letters, digits, `-` and `_`, at most 128 characters.
    name.strip_prefix("blocks/")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

fn refuse_unknown(allowed: bool) -> Result<(), String> {
    if allowed {
        Ok(())
    } else {
        Err("appDataNameNotAllowed".into())
    }
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
    refuse_unknown(app_data_name_allowed(&rel))?;
    let path = paths::confine_rel(&app_root(&app)?, &rel)?;
    read_opt(&path)
}

#[tauri::command]
#[specta::specta]
pub fn write_app_data(app: tauri::AppHandle, rel: String, contents: String) -> Result<(), String> {
    refuse_unknown(app_data_name_allowed(&rel))?;
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
    refuse_unknown(app_data_name_allowed(&rel))?;
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
    } else if path == paths::confine_rel(root, crate::ai::connections::CONNECTIONS)? {
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
    refuse_unknown(vault_meta_name_allowed(&rel))?;
    let path = paths::confine_rel(&vault_meta_root(&context)?, &rel)?;
    read_opt(&path)
}

#[tauri::command]
#[specta::specta]
pub fn write_vault_meta(
    context: tauri::State<VaultContext>,
    rel: String,
    contents: String,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    write_vault_meta_under_gate(
        &context.mutation_gate,
        || vault_meta_root(&context),
        || context.generation(),
        expected_generation,
        &rel,
        &contents,
    )
}

#[tauri::command]
#[specta::specta]
pub fn delete_vault_meta(
    context: tauri::State<VaultContext>,
    rel: String,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    delete_vault_meta_under_gate(
        &context.mutation_gate,
        || vault_meta_root(&context),
        || context.generation(),
        expected_generation,
        &rel,
    )
}

/// A write that names the vault generation it was made for is refused when another vault
/// (or the same one, reopened) is active now, so a late save cannot land in the wrong `.amby/`.
/// `None` is for a window that does not know the generation (the settings window).
fn refuse_stale_generation(
    current: impl FnOnce() -> Result<u64, String>,
    expected: Option<u64>,
) -> Result<(), String> {
    match expected {
        Some(expected) if current()? != expected => Err("vaultGenerationConflict".into()),
        _ => Ok(()),
    }
}

/// Writes under `mutation_gate`, as every other write into the vault does, and
/// only for the names the renderer really keeps in `.amby/`.
fn write_vault_meta_under_gate(
    gate: &Mutex<()>,
    root: impl FnOnce() -> Result<PathBuf, String>,
    current_generation: impl FnOnce() -> Result<u64, String>,
    expected_generation: Option<u64>,
    rel: &str,
    contents: &str,
) -> Result<(), String> {
    refuse_unknown(vault_meta_name_allowed(rel))?;
    let _guard = gate.lock_or_recover();
    refuse_stale_generation(current_generation, expected_generation)?;
    let path = paths::confine_rel(&root()?, rel)?;
    write_all(&path, contents)
}

fn delete_vault_meta_under_gate(
    gate: &Mutex<()>,
    root: impl FnOnce() -> Result<PathBuf, String>,
    current_generation: impl FnOnce() -> Result<u64, String>,
    expected_generation: Option<u64>,
    rel: &str,
) -> Result<(), String> {
    refuse_unknown(vault_meta_name_allowed(rel))?;
    let _guard = gate.lock_or_recover();
    refuse_stale_generation(current_generation, expected_generation)?;
    let path = paths::confine_rel(&root()?, rel)?;
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

    #[cfg(not(feature = "native-contract"))]
    #[test]
    fn a_debug_build_keeps_app_data_where_amby_app_data_dir_points_and_only_there() {
        // The only test that touches this variable; tests run in a debug build.
        let dir = temp_test_dir("override");
        std::env::set_var("AMBY_APP_DATA_DIR", &dir);
        assert_eq!(debug_app_data_override(), Some(dir.clone()));
        std::env::set_var("AMBY_APP_DATA_DIR", "relative/path");
        assert_eq!(debug_app_data_override(), None);
        std::env::remove_var("AMBY_APP_DATA_DIR");
        assert_eq!(debug_app_data_override(), None);
        fs::remove_dir_all(dir).ok();
    }

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

    #[test]
    fn app_data_names_are_a_closed_list() {
        for rel in [
            "workspaces.json",
            "settings.json",
            "ai-connections.json",
            "modules.json",
            "module-catalog.json",
            "settings.json.corrupt-1700000000000.json",
            "notice-journal/0123456789abcdef.json",
        ] {
            assert!(app_data_name_allowed(rel), "{rel} must be allowed");
        }
        for rel in [
            "codex/auth.json",
            "claude/settings.json",
            "../x",
            "/etc/passwd",
            "C:/x.json",
            "notice-journal/../codex/auth.json",
            "notice-journal/xyz.json",
            "notice-journal/0123456789abcdef.json.bak",
            "settings.json/../codex/auth.json",
            "codex/auth.json.corrupt-1.json",
            "",
        ] {
            assert!(!app_data_name_allowed(rel), "{rel} must be refused");
        }
    }

    #[test]
    fn vault_meta_names_are_a_closed_list() {
        for rel in [
            "workspace.json",
            "session.json",
            "graph-layout.json",
            "session.json.corrupt-42.json",
            "blocks/0b1f6a9c-1111-4222-8333-444455556666.json",
            "blocks/blk-1700000000000-ab12cd34.json",
        ] {
            assert!(vault_meta_name_allowed(rel), "{rel} must be allowed");
        }
        for rel in [
            "notes.db",
            "sync/state.db",
            "history/manifest.json",
            "recovery/x.json",
            "migrations/x.json",
            "properties/layout.json",
            "blocks/../notes.db",
            "blocks/a/b.json",
            "blocks/.json",
            "../x",
            "/abs.json",
            "",
        ] {
            assert!(!vault_meta_name_allowed(rel), "{rel} must be refused");
        }
    }

    #[test]
    fn a_vault_meta_write_outside_the_list_is_refused_and_writes_nothing() {
        let root = temp_test_dir("meta-refused");
        let gate = Mutex::new(());
        assert!(write_vault_meta_under_gate(
            &gate,
            || Ok(root.clone()),
            || Ok(1),
            None,
            "notes.db",
            "x"
        )
        .is_err());
        assert!(write_vault_meta_under_gate(
            &gate,
            || Ok(root.clone()),
            || Ok(1),
            None,
            "history/manifest.json",
            "x"
        )
        .is_err());
        assert!(!root.join("notes.db").exists());
        assert!(!root.join("history").exists());
        fs::write(root.join("keep.json"), "k").unwrap();
        assert!(delete_vault_meta_under_gate(
            &gate,
            || Ok(root.clone()),
            || Ok(1),
            None,
            "keep.json"
        )
        .is_err());
        assert!(root.join("keep.json").exists());
        write_vault_meta_under_gate(
            &gate,
            || Ok(root.clone()),
            || Ok(1),
            None,
            "workspace.json",
            "{}",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("workspace.json")).unwrap(),
            "{}"
        );
        delete_vault_meta_under_gate(&gate, || Ok(root.clone()), || Ok(1), None, "workspace.json")
            .unwrap();
        assert!(!root.join("workspace.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_vault_meta_write_for_another_generation_is_refused_and_writes_nothing() {
        let root = temp_test_dir("meta-generation");
        let gate = Mutex::new(());
        fs::write(root.join("session.json"), "old").unwrap();
        let err = write_vault_meta_under_gate(
            &gate,
            || Ok(root.clone()),
            || Ok(7),
            Some(6),
            "workspace.json",
            "{}",
        )
        .unwrap_err();
        assert_eq!(err, "vaultGenerationConflict");
        assert!(!root.join("workspace.json").exists());
        let err = delete_vault_meta_under_gate(
            &gate,
            || Ok(root.clone()),
            || Ok(7),
            Some(6),
            "session.json",
        )
        .unwrap_err();
        assert_eq!(err, "vaultGenerationConflict");
        assert!(root.join("session.json").exists());
        write_vault_meta_under_gate(
            &gate,
            || Ok(root.clone()),
            || Ok(7),
            Some(7),
            "workspace.json",
            "{}",
        )
        .unwrap();
        assert!(root.join("workspace.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn vault_meta_writes_and_deletes_wait_for_the_mutation_gate() {
        use std::sync::Arc;
        use std::time::Duration;
        let root = temp_test_dir("meta-gate");
        fs::write(root.join("session.json"), "old").unwrap();
        let gate = Arc::new(Mutex::new(()));
        let held = gate.lock().unwrap();
        let writer = {
            let (gate, root) = (gate.clone(), root.clone());
            std::thread::spawn(move || {
                write_vault_meta_under_gate(
                    &gate,
                    || Ok(root.clone()),
                    || Ok(1),
                    None,
                    "workspace.json",
                    "{}",
                )
            })
        };
        let deleter = {
            let (gate, root) = (gate.clone(), root.clone());
            std::thread::spawn(move || {
                delete_vault_meta_under_gate(
                    &gate,
                    || Ok(root.clone()),
                    || Ok(1),
                    None,
                    "session.json",
                )
            })
        };
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !root.join("workspace.json").exists(),
            "the write must wait for the gate"
        );
        assert!(
            root.join("session.json").exists(),
            "the delete must wait for the gate"
        );
        drop(held);
        writer.join().unwrap().unwrap();
        deleter.join().unwrap().unwrap();
        assert!(root.join("workspace.json").exists());
        assert!(!root.join("session.json").exists());
        let _ = fs::remove_dir_all(root);
    }
}
