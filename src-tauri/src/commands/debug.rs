use crate::logging::{DebugBackendStatus, DebugConfig, DebugEvent, DebugRuntime, DebugState};
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

#[tauri::command]
#[specta::specta]
pub fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = log_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|_| "LogDirectoryUnavailable".to_owned())?;
    crate::system_open::open_path(&dir).map_err(|_| "OpenFolderFailed".to_owned())
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
