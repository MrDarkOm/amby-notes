mod ai;
mod app_data;
mod bundle;
mod commands;
mod credentials;
mod frontmatter;
mod history;
pub mod index;
mod model;
mod paths;
mod property_store;
mod recovery;
mod recycle_bin;
mod state;
pub mod vault;
mod vault_context;
pub mod vault_index;
mod watcher;

#[cfg(test)]
mod security_integration_test;

use state::*;
use watcher::WatcherState;

/// Single source of truth for the command set — drives both the runtime
/// invoke handler and the generated TypeScript bindings (so the frontend IPC
/// types can't drift from the Rust signatures).
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new().commands(tauri_specta::collect_commands![
        commands::vault::load_vault,
        commands::vault::load_active_vault,
        commands::vault::preflight_vault,
        commands::vault::apply_id_migration,
        commands::vault::inspect_id_migrations,
        commands::vault::recover_id_migration,
        commands::vault::list_files,
        commands::notes::read_file,
        commands::notes::write_file,
        commands::notes::save_conflict_copy,
        commands::history::list_snapshots,
        commands::history::get_history_stats,
        commands::history::preview_history_cleanup,
        commands::history::cleanup_history,
        commands::history::restore_snapshot,
        commands::history::read_snapshot_text,
        commands::history::save_recovery,
        commands::history::read_recovery,
        commands::history::delete_recovery,
        commands::history::list_recovery,
        commands::history::list_trash,
        commands::history::restore_trash,
        commands::notes::read_note,
        commands::notes::write_note,
        commands::notes::get_note_metadata,
        commands::notes::get_note_properties,
        commands::notes::upsert_custom_property,
        commands::notes::delete_custom_property,
        commands::notes::list_tags,
        commands::notes::search_notes,
        commands::notes::get_link_graph,
        commands::mutations::ensure_bundle,
        commands::mutations::create_note,
        commands::mutations::create_layer,
        commands::mutations::create_canvas,
        commands::mutations::attach_canvas_to_note,
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
        commands::notes::get_file_metadata,
        commands::vault::open_vault,
        commands::vault::start_vault_watcher,
        commands::vault::stop_vault_watcher,
        commands::assets::open_in_explorer,
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = show_and_focus_main_window(app) {
                tracing::warn!(event = "restore_window_failed", error = %error);
            }
        }))
        .manage(vault_context::VaultContext::new())
        .manage(WatcherState::new())
        .manage(ai::AiStreamState::default())
        .invoke_handler(builder.invoke_handler())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            set_macos_application_icon();

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
    /// launching the app.
    #[test]
    fn export_bindings() {
        super::specta_builder()
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number)
                    .header("// @ts-nocheck\n"),
                "../src/lib/bindings.ts",
            )
            .expect("failed to export typescript bindings");
    }
}
