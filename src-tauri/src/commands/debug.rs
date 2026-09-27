use crate::logging::{
    DebugBackendStatus, DebugConfig, DebugEvent, DebugRuntime, DebugState, LogLevel,
};
use std::path::PathBuf;

fn runtime<'a>(state: &'a tauri::State<'_, DebugState>) -> &'a DebugRuntime {
    state.0.as_ref()
}

#[tauri::command]
#[specta::specta]
pub fn configure_debug(
    state: tauri::State<'_, DebugState>,
    context: tauri::State<'_, crate::vault_context::VaultContext>,
    watcher: tauri::State<'_, crate::watcher::WatcherState>,
    config: DebugConfig,
) -> Result<DebugBackendStatus, String> {
    runtime(&state).configure(config)?;
    status_with_health(&state, &context, &watcher)
}

#[tauri::command]
#[specta::specta]
pub fn get_debug_status(
    state: tauri::State<'_, DebugState>,
    context: tauri::State<'_, crate::vault_context::VaultContext>,
    watcher: tauri::State<'_, crate::watcher::WatcherState>,
) -> Result<DebugBackendStatus, String> {
    status_with_health(&state, &context, &watcher)
}

fn status_with_health(
    state: &tauri::State<'_, DebugState>,
    context: &tauri::State<'_, crate::vault_context::VaultContext>,
    watcher: &tauri::State<'_, crate::watcher::WatcherState>,
) -> Result<DebugBackendStatus, String> {
    let watcher_running = watcher
        .watcher
        .lock()
        .map_err(|_| "LockPoisoned".to_owned())?
        .is_some();
    let context = context.conn.lock().map_err(|_| "LockPoisoned".to_owned())?;
    let vault_open = context.is_some();
    let index_ready = context
        .as_ref()
        .is_some_and(|active| active.index_health.get() == crate::model::IndexState::Healthy);
    runtime(state).status(watcher_running, index_ready, vault_open)
}

#[tauri::command]
#[specta::specta]
pub fn append_debug_events(
    state: tauri::State<'_, DebugState>,
    events: Vec<DebugEvent>,
) -> Result<Vec<DebugEvent>, String> {
    if events.len() > 256 {
        return Err("BatchTooLarge".to_owned());
    }
    let runtime = runtime(&state);
    let mut recorded = Vec::with_capacity(events.len());
    for event in events {
        let result = runtime.ingest(event)?;
        if result.sequence.is_some() {
            recorded.push(result);
        }
    }
    Ok(recorded)
}

#[tauri::command]
#[specta::specta]
pub fn get_debug_events(state: tauri::State<'_, DebugState>) -> Result<Vec<DebugEvent>, String> {
    Ok(runtime(&state).recent())
}

#[tauri::command]
#[specta::specta]
pub fn get_debug_history(state: tauri::State<'_, DebugState>) -> Result<Vec<DebugEvent>, String> {
    runtime(&state).history()
}

#[tauri::command]
#[specta::specta]
pub fn clear_debug_logs(state: tauri::State<'_, DebugState>) -> Result<(), String> {
    runtime(&state).clear()
}

#[tauri::command]
#[specta::specta]
pub fn flush_debug_logs(state: tauri::State<'_, DebugState>) -> Result<(), String> {
    runtime(&state).barrier(false)
}

pub fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = crate::app_data::app_root(app).map_err(|_| "AppDataUnavailable".to_owned())?;
    Ok(if base.file_name().is_some_and(|name| name == "notes") {
        base.parent().unwrap_or(&base).join("logs")
    } else {
        base.join("logs")
    })
}

pub fn log_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(log_dir(app)?.join("amby-debug.jsonl"))
}

fn open_in_system_explorer(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|_| "OpenFolderFailed".to_owned())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|_| "OpenFolderFailed".to_owned())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|_| "OpenFolderFailed".to_owned())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = log_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|_| "LogDirectoryUnavailable".to_owned())?;
    open_in_system_explorer(&dir)
}

#[tauri::command]
#[specta::specta]
pub fn toggle_devtools(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager;
    let target = app
        .get_webview_window(crate::state::MAIN_WINDOW_LABEL)
        .unwrap_or(window);
    if target.is_devtools_open() {
        target.close_devtools();
    } else {
        target.open_devtools();
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn open_devtools(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager;
    let target = app
        .get_webview_window(crate::state::MAIN_WINDOW_LABEL)
        .unwrap_or(window);
    target.open_devtools();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn is_devtools_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    use tauri::Manager;
    let target = app
        .get_webview_window(crate::state::MAIN_WINDOW_LABEL)
        .unwrap_or(window);
    Ok(target.is_devtools_open())
}

// Compatibility shims for older frontend builds. They expose only sanitized
// JSONL events; arbitrary text payloads and legacy plaintext logs are rejected.
#[tauri::command]
#[specta::specta]
pub fn get_log_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(log_dir(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_log_file_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(log_file_path(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub fn read_log_file(
    state: tauri::State<'_, DebugState>,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let _ = max_bytes;
    runtime(&state)
        .history()?
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map(|lines| lines.join("\n"))
        .map_err(|_| "SerializeFailed".to_owned())
}

#[tauri::command]
#[specta::specta]
pub fn clear_log_file(state: tauri::State<'_, DebugState>) -> Result<(), String> {
    runtime(&state).clear()
}

#[tauri::command]
#[specta::specta]
pub fn append_log(state: tauri::State<'_, DebugState>, line: String) -> Result<(), String> {
    if line.len() > 64 * 1024 {
        return Err("EventTooLarge".to_owned());
    }
    let mut imported = 0;
    for raw in line.lines() {
        let event: DebugEvent =
            serde_json::from_str(raw).map_err(|_| "InvalidEventPayload".to_owned())?;
        runtime(&state).ingest(event)?;
        imported += 1;
    }
    if imported == 0 {
        return Err("InvalidEventPayload".to_owned());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_recent_logs(state: tauri::State<'_, DebugState>) -> Result<Vec<String>, String> {
    runtime(&state)
        .recent()
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "SerializeFailed".to_owned())
}

#[tauri::command]
#[specta::specta]
pub fn set_debug_mode_enabled(
    state: tauri::State<'_, DebugState>,
    enabled: bool,
) -> Result<(), String> {
    let current = runtime(&state).status(false, false, false)?.config;
    runtime(&state).configure(DebugConfig {
        enabled,
        log_level: if enabled && current.log_level == LogLevel::Info {
            LogLevel::Debug
        } else {
            current.log_level
        },
        log_to_file: current.log_to_file,
    })?;
    Ok(())
}
