//! Opt-in real WebView/IPC harness. It uses the production command registry,
//! not a mock runtime or replacement storage implementation.
use std::{
    fs,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

pub(crate) struct NativeAppDataRoot(pub std::path::PathBuf);

/// Full production React UI with isolated settings and WebView state. Files
/// remain available after exit so close/reopen and external edits are testable.
fn run_native_ui(root: std::path::PathBuf) {
    let root = root.canonicalize().expect("existing native UI test root");
    assert_eq!(
        fs::read_to_string(root.join(".native-ui-profile")).unwrap(),
        "amby-native-ui-v1",
        "Only a profile created by the native UI runner may be used"
    );
    let profile = root.join(".webview");
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    crate::state::init_logging();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(NativeAppDataRoot(root.join(".app-data")))
        .manage(crate::vault_context::VaultContext::new())
        .manage(crate::watcher::WatcherState::new())
        .manage(crate::ai::AiStreamState::default())
        .invoke_handler(crate::specta_builder().invoke_handler())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Amby native UI smoke (isolated profile)")
            .inner_size(1280.0, 800.0)
            .decorations(false)
            .data_directory(profile)
            .build()?;
            Ok(())
        })
        .run(context)
        .expect("native UI startup");
}

pub fn run_native_contract() {
    if let Some(root) = std::env::var_os("AMBY_NATIVE_UI_ROOT") {
        run_native_ui(root.into());
        return;
    }
    let root =
        std::env::temp_dir().join(format!("amby-native-contract-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&root).expect("create disposable native vault");
    let root = root.canonicalize().expect("canonical test root");
    let setup_root = root.clone();
    let exit_code = Arc::new(AtomicI32::new(1));
    let result_code = exit_code.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(NativeAppDataRoot(root.join(".app-data")))
        .manage(crate::vault_context::VaultContext::new())
        .manage(crate::watcher::WatcherState::new())
        .manage(crate::ai::AiStreamState::default())
        .invoke_handler(crate::specta_builder().invoke_handler())
        .setup(move |app| {
            let initialization = format!(
                "window.__AMBY_NATIVE_TEST_ROOT__ = {};",
                serde_json::to_string(&setup_root.to_string_lossy()).unwrap()
            );
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("tests/native/index.html".into()),
            )
            .title("Amby native storage contract (disposable vault)")
            .data_directory(setup_root.join(".webview"))
            .initialization_script(initialization)
            .build()?;
            let handle = app.handle().clone();
            let report = setup_root.join("result.json");
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(120);
                loop {
                    if let Ok(bytes) = fs::read(&report) {
                        if let Ok(result) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                            println!("AMBY_NATIVE_RESULT={result}");
                            let code = if result["passed"] == true { 0 } else { 1 };
                            result_code.store(code, Ordering::SeqCst);
                            handle.exit(code);
                            break;
                        }
                    }
                    if Instant::now() >= deadline {
                        eprintln!("Native contract timed out before reporting");
                        handle.exit(1);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            Ok(())
        })
        .build(context)
        .expect("native contract WebView startup");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle
                .state::<crate::vault_context::VaultContext>()
                .conn
                .lock()
                .unwrap()
                .take();
        }
    });
    if let Err(error) = fs::remove_dir_all(&root) {
        eprintln!("Native test cleanup failed for {}: {error}", root.display());
        exit_code.store(1, Ordering::SeqCst);
    }
    std::process::exit(exit_code.load(Ordering::SeqCst));
}
