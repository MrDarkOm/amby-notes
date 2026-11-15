use std::error::Error;

pub const MAIN_WINDOW_LABEL: &str = "main";

pub fn init_logging() {
    crate::logging::init_logging();
}

/// The settings window (`settings-dialog.tsx`). It is created hidden shortly
/// after startup and only hides when closed.
pub const SETTINGS_WINDOW_LABEL: &str = "settings";

/// Windows that serve only the main window and close together with it. A
/// hidden settings window would otherwise keep the process running with
/// nothing on screen. Note windows are left alone: they save their own edits.
pub fn closes_with_main_window(label: &str) -> bool {
    label == SETTINGS_WINDOW_LABEL
}

/// The configured main window, used to create it again after it was closed
/// while the process stayed alive (for example, for an open note window).
pub fn main_window_config(
    windows: &[tauri::utils::config::WindowConfig],
) -> Option<&tauri::utils::config::WindowConfig> {
    windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
}

/// Bring the one application window back to the foreground: restore it when
/// minimized, show it when hidden and create it again when it was closed. This
/// is used at initial startup, when the OS forwards another launch request to
/// the already-running process and when the Dock icon is clicked on macOS.
pub fn show_and_focus_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn Error>> {
    use tauri::Manager;

    let window = match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => window,
        None => {
            let config = main_window_config(&app.config().app.windows).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "the main window is not configured",
                )
            })?;
            tracing::info!(event = "main_window_recreated");
            tauri::WebviewWindowBuilder::from_config(app, config)?.build()?
        }
    };
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Close the helper windows of a main window that was just destroyed, so the
/// process exits when nothing else is open.
pub fn close_main_window_helpers<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    for (label, window) in app.webview_windows() {
        if closes_with_main_window(&label) {
            if let Err(error) = window.destroy() {
                tracing::warn!(event = "helper_window_close_failed", label = %label, error = %error);
            }
        }
    }
}

/// Shared by the production app and the isolated native UI smoke harness.
pub fn handle_run_event<R: tauri::Runtime>(handle: &tauri::AppHandle<R>, event: tauri::RunEvent) {
    match event {
        // The Dock icon was clicked. tao leaves a minimized window alone, and a
        // closed main window is not created again on its own.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = show_and_focus_main_window(handle) {
                tracing::warn!(event = "restore_window_failed", error = %error);
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == MAIN_WINDOW_LABEL => close_main_window_helpers(handle),
        _ => {}
    }
}

pub fn report_startup_error(error: &tauri::Error) {
    let message = format!(
        "Amby could not create its main window. On Windows, verify that the Microsoft Edge WebView2 Runtime is installed.\n\nDetails: {error}"
    );
    tracing::error!(event = "startup_error", error = %error);
    rfd::MessageDialog::new()
        .set_title("Amby could not start")
        .set_description(&message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

/// Tauri applies the configured icon to `NSApplication` in development, but
/// leaves release builds to macOS's bundle-icon fallback. On Tahoe that
/// fallback adds a generic background to legacy `.icns` icons, so explicitly
/// apply the same image at runtime for a consistent Dock appearance.
#[cfg(target_os = "macos")]
pub fn set_macos_application_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let marker = unsafe { MainThreadMarker::new_unchecked() };
    let application = NSApplication::sharedApplication(marker);
    let data = NSData::with_bytes(include_bytes!("../icons/icon-macos.png"));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { application.setApplicationIconImage(Some(&icon)) };
    }
}

#[cfg(test)]
mod tests {
    use super::{closes_with_main_window, main_window_config, MAIN_WINDOW_LABEL};

    #[test]
    fn main_window_is_created_by_tauri_configuration() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must contain valid JSON");
        let windows = config["app"]["windows"]
            .as_array()
            .expect("app.windows must be an array");
        let main_window = windows
            .iter()
            .find(|window| window["label"] == MAIN_WINDOW_LABEL)
            .expect("the main window must be configured");

        assert_ne!(main_window["create"], false);
        assert_eq!(main_window["dataDirectory"], "WebView");
    }

    #[test]
    fn the_hidden_settings_window_closes_with_the_main_window() {
        // A prewarmed, hidden settings window must not keep the process alive
        // after the main window is closed: the Dock icon would then lead nowhere.
        assert!(closes_with_main_window("settings"));
        assert!(!closes_with_main_window(MAIN_WINDOW_LABEL));
        // Note windows may hold edits still being saved; they close on their own.
        assert!(!closes_with_main_window("note-3f2a"));
    }

    #[test]
    fn the_settings_label_matches_the_frontend() {
        let source = include_str!("../../src/components/workspace/settings-dialog.tsx");
        assert!(
            source.contains(&format!(
                "const SETTINGS_WINDOW_LABEL = \"{}\"",
                super::SETTINGS_WINDOW_LABEL
            )),
            "settings-dialog.tsx must use the same settings window label"
        );
    }

    #[test]
    fn the_main_window_can_be_created_again_from_configuration() {
        let config: tauri::utils::config::Config =
            serde_json::from_str(include_str!("../tauri.conf.json"))
                .expect("tauri.conf.json must be a valid Tauri configuration");
        let main = main_window_config(&config.app.windows).expect("main window configuration");
        assert_eq!(main.label, MAIN_WINDOW_LABEL);
    }
}
