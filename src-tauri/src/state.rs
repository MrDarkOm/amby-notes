use std::error::Error;

pub const MAIN_WINDOW_LABEL: &str = "main";

pub fn init_logging() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init()
        .ok();
}

/// Bring the one application window back to the foreground. This is used at
/// initial startup and when the OS forwards another launch request to the
/// already-running process.
pub fn show_and_focus_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn Error>> {
    use tauri::Manager;

    let window = app.get_webview_window(MAIN_WINDOW_LABEL).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Tauri did not create the main window",
        )
    })?;
    window.show()?;
    window.set_focus()?;
    Ok(())
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
    let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { application.setApplicationIconImage(Some(&icon)) };
    }
}

#[cfg(test)]
mod tests {
    use super::MAIN_WINDOW_LABEL;

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
}
