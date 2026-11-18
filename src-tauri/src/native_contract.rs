//! Opt-in real WebView/IPC harness. It uses the production command registry,
//! not a mock runtime or replacement storage implementation.
use crate::lock_util::LockExt;
use std::{
    fs,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[path = "native_contract_ai.rs"]
mod fake_ai;

pub(crate) struct NativeAppDataRoot(pub std::path::PathBuf);

/// The key store of the harness: in memory, so that a check never writes to the key store of the
/// person who runs it. `AMBY_NATIVE_REAL_KEYCHAIN=1` opts in to the system key store.
#[derive(Default)]
struct MemorySecrets(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl crate::sync::secrets::SecretStore for MemorySecrets {
    fn get(&self, name: &str) -> Result<Option<String>, crate::sync::secrets::SecretError> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }

    fn set(&self, name: &str, value: &str) -> Result<(), crate::sync::secrets::SecretError> {
        self.0
            .lock()
            .unwrap()
            .insert(name.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), crate::sync::secrets::SecretError> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

/// The sync service and the sync of the open vault in the harness: the record lives in the
/// isolated app data, the key store in memory unless `AMBY_NATIVE_REAL_KEYCHAIN` asks for the
/// system one. Both share the same stores, as in the application.
fn manage_harness_sync(app: &tauri::App, app_data: &std::path::Path) {
    use crate::sync::connection::{ConnectionStore, FileConnectionStore, CONNECTION_FILE};
    use crate::sync::secrets::{KeyringStore, SecretStore};
    let secrets: Arc<dyn SecretStore> = if std::env::var_os("AMBY_NATIVE_REAL_KEYCHAIN").is_some() {
        Arc::new(crate::sync::secrets::BundledSecrets::new(KeyringStore))
    } else {
        Arc::new(MemorySecrets::default())
    };
    let connection: Arc<dyn ConnectionStore> =
        Arc::new(FileConnectionStore::new(app_data.join(CONNECTION_FILE)));
    app.manage(crate::sync::service::SyncService::new(
        secrets.clone(),
        connection.clone(),
    ));
    let batch = app.state::<crate::watcher::WatcherState>().batch.clone();
    app.manage(crate::sync::runtime::SyncRuntime::new(
        secrets,
        connection,
        tauri::async_runtime::handle().inner().clone(),
        crate::sync::session::Schedule::production(),
        Arc::new(crate::sync::app_hooks::AppHooks::new(
            app.handle().clone(),
            batch,
        )),
    ));
}

/// The pages the contract harness may load (an allow-list: the name comes from the environment).
fn contract_page() -> &'static str {
    match std::env::var("AMBY_NATIVE_PAGE").as_deref() {
        Ok("sync-connect") => "tests/native/sync-connect.html",
        Ok("sync-vault") => "tests/native/sync-vault.html",
        _ => "tests/native/index.html",
    }
}

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
    let app_data_root = root.join(".app-data");
    let mut context = tauri::generate_context!();
    // Keep the main configuration for the production restore/recreate path,
    // but use only the disposable WebView profile and create it in setup.
    for window in &mut context.config_mut().app.windows {
        window.create = false;
        window.data_directory = Some(profile.clone());
        window.title = "Amby native UI smoke (isolated profile)".into();
    }
    crate::state::init_logging();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(NativeAppDataRoot(root.join(".app-data")))
        .manage(crate::vault_context::VaultContext::new())
        .manage(crate::cli_open::PendingCliOpens::default())
        .manage(crate::watcher::WatcherState::new())
        .manage(crate::path_grants::PathGrants::trust_everything())
        .manage(crate::database::runtime_state::DatabaseRuntimeState::default())
        .manage(crate::database::mutation_state::DatabaseMutationState::default())
        .manage(crate::database::history::DatabaseHistoryState::default())
        .manage(crate::ai::AiStreamState::default())
        .manage(crate::logging::DebugState(crate::logging::global_runtime()))
        .invoke_handler(crate::specta_builder().invoke_handler())
        .on_menu_event(crate::state::handle_menu_event)
        .setup(move |app| {
            manage_harness_sync(app, &app_data_root);
            crate::cli_structural::start(app.handle());
            #[cfg(target_os = "macos")]
            app.set_menu(crate::state::app_menu(app.handle())?)?;
            let debug = crate::logging::global_runtime();
            debug.set_app(app.handle().clone());
            debug
                .configure_path(
                    crate::commands::debug::log_file_path(app.handle())
                        .map_err(std::io::Error::other)?,
                )
                .map_err(std::io::Error::other)?;
            crate::state::show_and_focus_main_window(app.handle())
        })
        .build(context)
        .expect("native UI startup")
        .run(crate::state::handle_run_event);
}

// The real CLI runs outside the webview and writes directly to the disposable
// scenario vault. The marker is created only after the native watcher is ready.
fn spawn_cli_write_probe(root: std::path::PathBuf, binary: std::ffi::OsString) {
    std::thread::spawn(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            let vault = fs::read_dir(&root)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("case-"))
                .map(|entry| entry.path())
                .find(|path| path.join(".amby/cli-native-ready").is_file());
            if let Some(vault) = vault {
                let result = (|| -> std::io::Result<()> {
                    let mut child = Command::new(&binary)
                        .arg("--vault")
                        .arg(&vault)
                        .args(["append", "CLI external.md"])
                        .stdin(Stdio::piped())
                        .stdout(Stdio::null())
                        .spawn()?;
                    child
                        .stdin
                        .take()
                        .ok_or_else(|| std::io::Error::other("missing CLI stdin"))?
                        .write_all(b"external CLI edit\n")?;
                    if !child.wait()?.success() {
                        return Err(std::io::Error::other("CLI append failed"));
                    }
                    let ready = vault.join(".amby/cli-native-structural-ready");
                    while !ready.is_file() && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    if !ready.is_file() {
                        return Err(std::io::Error::other(
                            "CLI structural probe was not started",
                        ));
                    }
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    let profile = root.join(".app-data");
                    let dispatch = |vault, version| {
                        use amby_core::cli_ipc::{self, Action, Request};
                        runtime.block_on(cli_ipc::dispatch(
                            &profile,
                            Request {
                                version,
                                vault,
                                action: Action::Archive {
                                    path: "CLI external.md".into(),
                                },
                            },
                        ))
                    };
                    let version = amby_core::cli_ipc::VERSION;
                    for (target, requested, expected) in [
                        (root.canonicalize()?, version, "vaultNotActive"),
                        (vault.canonicalize()?, version + 1, "desktopProtocolVersion"),
                    ] {
                        if !matches!(dispatch(target, requested), Err(code) if code == expected) {
                            return Err(std::io::Error::other(format!(
                                "Expected {expected} from desktop"
                            )));
                        }
                    }
                    for args in [
                        &["rename", "CLI external.md", "CLI renamed"][..],
                        &["move", "CLI renamed.md", "Destination"][..],
                        &["archive", "Destination/CLI renamed.md"][..],
                        &["restore", "Destination/CLI renamed.md"][..],
                        &["recover"][..],
                    ] {
                        let output = Command::new(&binary)
                            .env("AMBY_APP_DATA_DIR", root.join(".app-data"))
                            .arg("--vault")
                            .arg(&vault)
                            .arg("--json")
                            .args(args)
                            .output()?;
                        if !output.status.success() {
                            return Err(std::io::Error::other(format!(
                                "CLI {args:?} failed: {}",
                                String::from_utf8_lossy(&output.stdout)
                            )));
                        }
                    }
                    let call_tool = |grant: &str, name: &str, arguments: serde_json::Value| {
                        let mut child = Command::new(&binary)
                            .env("AMBY_APP_DATA_DIR", &profile)
                            .arg("--vault")
                            .arg(&vault)
                            .args(["mcp", grant])
                            .stdin(Stdio::piped())
                            .stdout(Stdio::piped())
                            .spawn()?;
                        let request = serde_json::json!({
                            "jsonrpc":"2.0", "id":1, "method":"tools/call",
                            "params":{"name":name, "arguments":arguments}
                        });
                        writeln!(
                            child
                                .stdin
                                .take()
                                .ok_or_else(|| std::io::Error::other("MCP stdin unavailable"))?,
                            "{request}"
                        )?;
                        let output = child.wait_with_output()?;
                        let reply: serde_json::Value = serde_json::from_slice(&output.stdout)?;
                        let text = reply["result"]["content"][0]["text"]
                            .as_str()
                            .ok_or_else(|| std::io::Error::other("Missing MCP result text"))?;
                        serde_json::from_str::<serde_json::Value>(text)
                            .map_err(std::io::Error::other)
                    };
                    let rename = serde_json::json!({"path":"Destination/CLI renamed.md","name":"CLI MCP renamed"});
                    let denied =
                        call_tool("--allow-write=Destination", "rename_item", rename.clone())?;
                    if denied["error"] != "outsideWriteScope" {
                        return Err(std::io::Error::other(format!(
                            "Expected delegated scope denial: {denied}"
                        )));
                    }
                    let allowed = call_tool("--allow-write", "rename_item", rename)?;
                    if allowed["destination"] != "Destination/CLI MCP renamed.md" {
                        return Err(std::io::Error::other(format!(
                            "Expected delegated rename: {allowed}"
                        )));
                    }
                    let denied = call_tool(
                        "--allow-write=Destination",
                        "create_database",
                        serde_json::json!({"parent":"Destination","name":"Inactive database"}),
                    )?;
                    if denied["error"] != "moduleDisabled" {
                        return Err(std::io::Error::other(format!(
                            "Expected disabled runtime module: {denied}"
                        )));
                    }
                    fs::write(vault.join(".amby/cli-native-enable-modules"), "")?;
                    let enabled = vault.join(".amby/cli-native-modules-enabled");
                    while !enabled.is_file() && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    if !enabled.is_file() {
                        return Err(std::io::Error::other(
                            "Native harness did not enable modules",
                        ));
                    }
                    let scoped = |tool, args| call_tool("--allow-write=Destination", tool, args);
                    let database = scoped(
                        "create_database",
                        serde_json::json!({"parent":"Destination","name":"MCP Tasks"}),
                    )?;
                    let renamed = scoped(
                        "rename_database",
                        serde_json::json!({
                            "databaseId":database["databaseId"], "expectedRevision":database["revision"], "name":"MCP Tasks Renamed"
                        }),
                    )?;
                    if renamed["name"] != "MCP Tasks Renamed" {
                        return Err(std::io::Error::other(format!(
                            "Expected database rename: {renamed}"
                        )));
                    }
                    let targets = scoped(
                        "create_database",
                        serde_json::json!({
                            "parent":"Destination","name":"MCP Targets"
                        }),
                    )?;
                    let relation = scoped(
                        "create_database_relation",
                        serde_json::json!({
                            "databaseId":database["databaseId"],"targetDatabaseId":targets["databaseId"],
                            "name":"Related","inverseName":"Backlinks","expectedRevision":renamed["revision"],
                            "expectedTargetRevision":targets["revision"],"operationId":"native-relation"
                        }),
                    )?;
                    let left = scoped(
                        "create_database_row",
                        serde_json::json!({
                            "databaseId":database["databaseId"],"title":"Left"
                        }),
                    )?;
                    let right = scoped(
                        "create_database_row",
                        serde_json::json!({
                            "databaseId":targets["databaseId"],"title":"Right"
                        }),
                    )?;
                    let linked = scoped(
                        "set_database_relation",
                        serde_json::json!({
                            "databaseId":database["databaseId"],"noteId":left["noteId"],
                            "propertyId":relation["propertyId"],"targetNoteIds":[right["noteId"]],
                            "expectedRevision":left["revision"],"operationId":"native-link"
                        }),
                    )?;
                    if linked["affectedPaths"] != serde_json::json!([left["path"], right["path"]]) {
                        return Err(std::io::Error::other(format!(
                            "Expected both MCP relation paths: {linked}"
                        )));
                    }
                    let inverse = fs::read_to_string(
                        vault.join(
                            right["path"]
                                .as_str()
                                .ok_or_else(|| std::io::Error::other("No target row path"))?,
                        ),
                    )?;
                    if !left["noteId"]
                        .as_str()
                        .is_some_and(|id| inverse.contains(id))
                    {
                        return Err(std::io::Error::other(
                            "The inverse relation was not durably written",
                        ));
                    }
                    let workshop = scoped(
                        "create_workshop",
                        serde_json::json!({
                            "parent":"Destination","name":"MCP Workshop","operationId":"native-workshop"
                        }),
                    )?;
                    let updated = scoped(
                        "update_workshop",
                        serde_json::json!({
                            "workshopId":workshop["workshopId"],"expectedRevision":workshop["revision"],
                            "operationId":"native-workshop-details","tags":["native"]
                        }),
                    )?;
                    if updated["tags"] != serde_json::json!(["native"]) {
                        return Err(std::io::Error::other(format!(
                            "Expected workshop update: {updated}"
                        )));
                    }
                    let story = scoped(
                        "create_story",
                        serde_json::json!({
                            "workshopId":workshop["workshopId"],"title":"First Story","operationId":"native-story"
                        }),
                    )?;
                    let details = scoped(
                        "read_story",
                        serde_json::json!({"storyId":story["storyId"]}),
                    )?;
                    let page = scoped(
                        "create_text_page",
                        serde_json::json!({
                            "storyId":story["storyId"],"title":"First Page",
                            "levelId":details["text"]["levels"][0]["id"],"orderKey":"a0"
                        }),
                    )?;
                    let result_path = page["path"].as_str().map(|path| vault.join(path));
                    if !result_path.is_some_and(|path| path.is_file()) {
                        return Err(std::io::Error::other(format!(
                            "Expected lasting text page: {page}"
                        )));
                    }
                    fs::write(vault.join(".amby/cli-native-structural-result"), "done")?;
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = fs::write(
                        vault.join(".amby/cli-native-structural-result"),
                        error.to_string(),
                    );
                    eprintln!("Native CLI probe failed: {error}");
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    });
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
    if contract_page() == "tests/native/index.html" {
        // Under .amby so loading the harness root cannot index or rewrite the immutable copy.
        let fixture = root.join(".amby/native-backup-fixture");
        fs::create_dir_all(fixture.join(".amby")).expect("backup fixture directory");
        fs::write(fixture.join("note.md"), b"\xef\xbb\xbfNative backup\r\n")
            .expect("backup fixture note");
        fs::write(fixture.join(".amby/keep.bin"), [0, 255, 42]).expect("backup fixture sidecar");
        crate::sync::backup::ensure(&fixture).expect("verified native backup fixture");
    }
    let setup_root = root.clone();
    let fake_ai_url = if contract_page() == "tests/native/index.html" {
        fake_ai::start().expect("start disposable AI provider")
    } else {
        String::new()
    };
    let app_data_root = root.join(".app-data");
    let exit_code = Arc::new(AtomicI32::new(1));
    let result_code = exit_code.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(NativeAppDataRoot(root.join(".app-data")))
        .manage(crate::vault_context::VaultContext::new())
        .manage(crate::cli_open::PendingCliOpens::default())
        .manage(crate::watcher::WatcherState::new())
        .manage(crate::path_grants::PathGrants::trust_everything())
        .manage(crate::database::runtime_state::DatabaseRuntimeState::default())
        .manage(crate::database::mutation_state::DatabaseMutationState::default())
        .manage(crate::database::history::DatabaseHistoryState::default())
        .manage(crate::ai::AiStreamState::default())
        .manage(crate::logging::DebugState(crate::logging::global_runtime()))
        .invoke_handler(crate::specta_builder().invoke_handler())
        .setup(move |app| {
            manage_harness_sync(app, &app_data_root);
            let debug = crate::logging::global_runtime();
            debug.set_app(app.handle().clone());
            debug
                .configure_path(
                    crate::commands::debug::log_file_path(app.handle())
                        .map_err(std::io::Error::other)?,
                )
                .map_err(std::io::Error::other)?;
            let initialization = format!(
                "window.__AMBY_NATIVE_TEST_ROOT__ = {}; window.__AMBY_NATIVE_AI_URL__ = {}; window.__AMBY_NATIVE_SYNC__ = {};",
                serde_json::to_string(&setup_root.to_string_lossy()).unwrap(),
                serde_json::to_string(&fake_ai_url).unwrap(),
                // Where the sync check finds its server and the one-time codes (env, never a file).
                serde_json::json!({
                    "url": std::env::var("AMBY_NATIVE_SYNC_URL").ok(),
                    "username": std::env::var("AMBY_NATIVE_SYNC_USER").ok(),
                    "enrollCode": std::env::var("AMBY_NATIVE_SYNC_CODE").ok(),
                    // The check of two computers: which one this process is, the password of the
                    // account and the name of the shared space.
                    "role": std::env::var("AMBY_NATIVE_SYNC_ROLE").ok(),
                    "password": std::env::var("AMBY_NATIVE_SYNC_PASSWORD").ok(),
                    "spaceName": std::env::var("AMBY_NATIVE_SYNC_SPACE").ok(),
                })
            );
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App(contract_page().into()),
            )
            .title("Amby native storage contract (disposable vault)")
            .data_directory(setup_root.join(".webview"))
            .initialization_script(initialization)
            .build()?;
            if contract_page() == "tests/native/index.html" {
                crate::cli_structural::start(app.handle());
                if let Some(binary) = std::env::var_os("AMBY_NATIVE_CLI_BIN") {
                    spawn_cli_write_probe(setup_root.clone(), binary);
                }
                let name = "Command line note.md";
                fs::write(setup_root.join(name), "# Command line note")?;
                for path in ["../outside.md", name] {
                    crate::cli_open::enqueue(app.handle(), [
                        amby_core::desktop_launch::OPEN_NOTE_FLAG.into(),
                        setup_root.as_os_str().to_owned(),
                        path.into(),
                    ]);
                }
            }
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
                .lock_or_recover()
                .take();
        }
    });
    if let Err(error) = fs::remove_dir_all(&root) {
        eprintln!("Native test cleanup failed for {}: {error}", root.display());
        exit_code.store(1, Ordering::SeqCst);
    }
    std::process::exit(exit_code.load(Ordering::SeqCst));
}
