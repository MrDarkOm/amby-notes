mod ai;
mod app_data;
mod bundle;
mod commands;
mod credentials;
mod database;
mod durable;
mod frontmatter;
mod history;
pub mod index;
pub mod logging;
mod model;
pub mod package_manager;
mod paths;
mod project;
mod property_store;
mod recovery;
mod recycle_bin;
mod state;
mod system_recycle_bin;
pub mod vault;
mod vault_context;
pub mod vault_index;
mod watcher;

#[cfg(feature = "native-contract")]
mod native_contract;
#[cfg(feature = "native-contract")]
pub use native_contract::run_native_contract;

#[cfg(test)]
mod security_integration_test;

#[cfg(test)]
mod desktop_e2e_tests;

use logging::DebugState;
use state::*;
use watcher::WatcherState;

/// Single source of truth for the command set — drives both the runtime
/// invoke handler and the generated TypeScript bindings (so the frontend IPC
/// types can't drift from the Rust signatures).
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new().commands(tauri_specta::collect_commands![
        commands::vault::load_vault,
        commands::vault::load_active_vault,
        commands::vault::reindex_vault,
        commands::vault::preflight_vault,
        commands::vault::apply_id_migration,
        commands::vault::inspect_id_migrations,
        commands::vault::recover_id_migration,
        commands::vault::list_files,
        commands::notes::read_file,
        commands::notes::write_file,
        commands::notes::get_file_revision,
        commands::notes::save_conflict_copy,
        commands::history::list_snapshots,
        commands::history::get_history_stats,
        commands::history::preview_history_cleanup,
        commands::history::cleanup_history,
        commands::history::restore_snapshot,
        commands::history::delete_snapshot,
        commands::history::read_snapshot_text,
        commands::history::save_recovery,
        commands::history::read_recovery,
        commands::history::delete_recovery,
        commands::history::list_recovery,
        commands::history::list_trash,
        commands::history::restore_trash,
        commands::history::purge_trash,
        commands::notes::read_note,
        commands::notes::write_note,
        commands::notes::restore_deleted_note,
        commands::notes::get_note_metadata,
        commands::notes::get_note_properties,
        commands::notes::upsert_custom_property,
        commands::notes::delete_custom_property,
        commands::notes::reorder_custom_properties,
        commands::notes::backup_custom_properties,
        commands::notes::list_tags,
        commands::notes::search_notes,
        commands::notes::get_link_graph,
        commands::mutations::ensure_bundle,
        commands::mutations::create_note,
        commands::mutations::create_layer,
        commands::mutations::create_canvas,
        commands::mutations::attach_canvas_to_note,
        commands::mutations::create_sketch,
        commands::mutations::attach_sketch_to_note,
        commands::mutations::unlink_layer,
        commands::mutations::delete_layer,
        commands::mutations::note_layers,
        commands::mutations::move_item,
        commands::history::preview_move_refactor,
        commands::mutations::create_file,
        commands::mutations::create_folder,
        commands::mutations::rename_item,
        commands::history::preview_rename_refactor,
        commands::mutations::delete_item,
        commands::mutations::archive_item,
        commands::notes::get_file_metadata,
        commands::vault::open_vault,
        commands::vault::start_vault_watcher,
        commands::vault::stop_vault_watcher,
        commands::database::get_database_module_state,
        commands::database::set_database_module_enabled,
        commands::database::rebuild_database_projection,
        commands::database::refresh_database_change,
        commands::database::create_database,
        commands::database::create_database_property,
        commands::database::change_database_property_type,
        commands::database::delete_database_property,
        commands::database::reorder_database_properties,
        commands::database::rename_database,
        commands::database::rename_database_property,
        commands::database::apply_database_value_batch,
        commands::database::update_database_relation_value,
        commands::database::create_database_row,
        commands::database::duplicate_database_row,
        commands::database::import_database_asset,
        commands::database::resolve_database_asset_paths,
        commands::database::configure_database_rollup,
        commands::database::update_database_property_config,
        commands::database::update_database_property_options,
        commands::database::search_relation_candidates,
        commands::database::resolve_record_references,
        commands::database::sync_database_yaml,
        commands::database::resolve_database_yaml_conflict,
        commands::database::list_databases,
        commands::database::get_database_note_context,
        commands::database::query_database,
        commands::database::aggregate_database,
        commands::database::get_database_view,
        commands::database::create_database_view,
        commands::database::rename_database_view,
        commands::database::update_database_view_config,
        commands::database::duplicate_database_view,
        commands::database::delete_database_view,
        commands::database::reorder_database_views,
        commands::database::set_default_database_view,
        commands::database::detect_database_migrations,
        commands::database::preflight_database_migration,
        commands::database::execute_database_migration,
        commands::database::rollback_database_migration,
        commands::database::undo_database_mutation,
        commands::database::redo_database_mutation,
        commands::database::get_database_history_status,
        commands::project::list_projects,
        commands::project::refresh_projects,
        commands::project::create_project,
        commands::project::create_project_section,
        commands::project::create_text_page,
        commands::project::move_text_page,
        commands::project::list_note_references,
        commands::assets::open_in_explorer,
        commands::external::open_attachment,
        commands::external::open_web_address,
        commands::assets::import_asset,
        commands::assets::import_asset_bytes,
        commands::assets::pick_asset_file,
        commands::assets::export_text_file,
        commands::assets::import_text_file,
        app_data::read_app_data,
        app_data::write_app_data,
        app_data::read_vault_meta,
        app_data::write_vault_meta,
        app_data::delete_vault_meta,
        credentials::store_ai_credential,
        credentials::delete_ai_credential,
        credentials::inspect_ai_credential,
        ai::cancel_ai_request,
        ai::ai_chat,
        commands::modules::stage_module_package,
        commands::modules::download_and_stage_module_package,
        commands::modules::publish_staged_module,
        commands::modules::rollback_module,
        commands::modules::uninstall_module_package,
        commands::modules::list_installed_module_packages,
        commands::modules::get_module_entry_path,
        commands::modules::verify_module_signature,
        commands::debug::get_log_dir_path,
        commands::debug::get_log_file_path,
        commands::debug::open_log_folder,
        commands::debug::read_log_file,
        commands::debug::clear_log_file,
        commands::debug::append_log,
        commands::debug::get_recent_logs,
        commands::debug::set_debug_mode_enabled,
        commands::debug::open_devtools,
        commands::debug::toggle_devtools,
        commands::debug::is_devtools_open,
        commands::debug::configure_debug,
        commands::debug::get_debug_status,
        commands::debug::append_debug_events,
        commands::debug::get_debug_events,
        commands::debug::get_debug_history,
        commands::debug::clear_debug_logs,
        commands::debug::flush_debug_logs,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    tracing::info!(event = "app_starting");
    let builder = specta_builder();
    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default()
                .bigint(specta_typescript::BigIntExportBehavior::Number)
                .header("// @ts-nocheck\n"),
            "../src/lib/bindings.ts",
        )
        .ok();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = show_and_focus_main_window(app) {
                tracing::warn!(event = "restore_window_failed", error = %error);
            }
        }))
        .manage(vault_context::VaultContext::new())
        .manage(WatcherState::new())
        .manage(ai::AiStreamState::default())
        .manage(database::runtime_state::DatabaseRuntimeState::default())
        .manage(database::mutation_state::DatabaseMutationState::default())
        .manage(database::history::DatabaseHistoryState::default())
        .manage(DebugState(logging::global_runtime()))
        .invoke_handler(builder.invoke_handler())
        .setup(|app| {
            let debug = logging::global_runtime();
            debug.set_app(app.handle().clone());
            // Merely remember the path; the opt-in writer creates files only
            // after the user enables persistent diagnostics.
            match commands::debug::log_file_path(app.handle()) {
                Ok(log_path) => {
                    if let Err(error) = debug.configure_path(log_path) {
                        debug.set_file_error(error);
                    }
                }
                Err(_) => debug.set_file_error("AppDataUnavailable"),
            }

            #[cfg(target_os = "macos")]
            set_macos_application_icon();

            if let Ok(modules_dir) = package_manager::modules_root(app.handle()) {
                use tauri::Manager;
                let _ = app
                    .handle()
                    .asset_protocol_scope()
                    .allow_directory(&modules_dir, true);
            }

            // Tauri creates this window from the configuration before calling
            // `setup`. Keeping creation declarative avoids a dev-only window
            // lifecycle and guarantees exactly one `main` window per process.
            show_and_focus_main_window(app.handle())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        report_startup_error(&error);
    }
}

#[cfg(test)]
mod specta_export {
    /// Regenerates src/lib/bindings.ts headlessly (`cargo test`), without
    /// launching the app. Tests may set AMBY_BINDINGS_OUTPUT to compare a
    /// temporary export without overwriting the checked-in binding file.
    #[test]
    fn export_bindings() {
        let output = std::env::var_os("AMBY_BINDINGS_OUTPUT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| "../src/lib/bindings.ts".into());
        super::specta_builder()
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number)
                    .header("// @ts-nocheck\n"),
                output,
            )
            .expect("failed to export typescript bindings");
    }
}
