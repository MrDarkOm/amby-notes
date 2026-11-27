//! The system's own dictation for the AI panel's microphone button. Amby records and
//! recognizes nothing: it asks the system to start dictating into the focused field, as the
//! Edit menu's "Start Dictation…" does, so the audio is handled by the person's system settings.

/// Why dictation did not start; a stable code for the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DictationError {
    /// This system has no dictation Amby can start.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
    /// The system did not accept the request (dictation is off in its settings).
    NotStarted,
}

#[cfg(target_os = "macos")]
fn start(app: &tauri::AppHandle) -> Result<(), DictationError> {
    use objc2::sel;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let started = MainThreadMarker::new().is_some_and(|marker| {
            // SAFETY: `startDictation:` is the system's standard responder-chain action, the one
            // the Edit menu's item sends; it takes only a sender, and a nil target and sender are
            // allowed. It runs on the main thread, as AppKit requires.
            unsafe {
                NSApplication::sharedApplication(marker).sendAction_to_from(
                    sel!(startDictation:),
                    None,
                    None,
                )
            }
        });
        let _ = sender.send(started);
    })
    .map_err(|_| DictationError::NotStarted)?;
    match receiver.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(true) => Ok(()),
        _ => Err(DictationError::NotStarted),
    }
}

#[cfg(not(target_os = "macos"))]
fn start(_app: &tauri::AppHandle) -> Result<(), DictationError> {
    Err(DictationError::Unsupported)
}

/// Starts the system's dictation into the focused text field. Takes no input.
#[tauri::command]
#[specta::specta]
pub async fn start_system_dictation(app: tauri::AppHandle) -> Result<(), DictationError> {
    tauri::async_runtime::spawn_blocking(move || start(&app))
        .await
        .map_err(|_| DictationError::NotStarted)?
}
