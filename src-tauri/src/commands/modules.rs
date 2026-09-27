use crate::package_manager::{self, *};
use std::collections::BTreeMap;

#[tauri::command]
#[specta::specta]
pub fn stage_module_package(
    app: tauri::AppHandle,
    staging_id: String,
    manifest: ModuleManifest,
    files: BTreeMap<String, String>,
) -> Result<StagedPackageInfo, String> {
    package_manager::stage_module(&app, staging_id, manifest, files)
}

#[tauri::command]
#[specta::specta]
pub async fn download_and_stage_module_package(
    app: tauri::AppHandle,
    url: String,
) -> Result<StagedPackageInfo, String> {
    package_manager::download_remote_package(&app, url).await
}

#[tauri::command]
#[specta::specta]
pub fn publish_staged_module(
    app: tauri::AppHandle,
    staging_id: String,
    module_id: String,
    version: String,
) -> Result<PublishModuleResult, String> {
    package_manager::publish_module(&app, staging_id, module_id, version)
}

#[tauri::command]
#[specta::specta]
pub fn rollback_module(
    app: tauri::AppHandle,
    module_id: String,
) -> Result<RollbackModuleResult, String> {
    package_manager::rollback_module(&app, module_id)
}

#[tauri::command]
#[specta::specta]
pub fn uninstall_module_package(app: tauri::AppHandle, module_id: String) -> Result<(), String> {
    package_manager::uninstall_module(&app, module_id)
}

#[tauri::command]
#[specta::specta]
pub fn list_installed_module_packages(
    app: tauri::AppHandle,
) -> Result<Vec<InstalledModuleInfo>, String> {
    package_manager::list_installed_modules(&app)
}

#[tauri::command]
#[specta::specta]
pub fn get_module_entry_path(app: tauri::AppHandle, module_id: String) -> Result<String, String> {
    package_manager::get_module_entry_path(&app, module_id)
}

#[tauri::command]
#[specta::specta]
pub fn verify_module_signature(
    public_key_hex: String,
    message_hex: String,
    signature_str: String,
) -> Result<bool, String> {
    let msg_bytes = package_manager::hex_decode(&message_hex)?;
    package_manager::verify_ed25519(&public_key_hex, &msg_bytes, &signature_str)
}
