//! Settings → General: put the bundled `amby` command on PATH and take it off (`crate::cli_path`).
//! The commands take no input: every path comes from the running app and the person's home.

use crate::cli_path::{self, CliPathError, CliPathStatus};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CliPathError> + Send + 'static,
) -> Result<T, CliPathError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| CliPathError::Failed)?
}

#[tauri::command]
#[specta::specta]
pub async fn cli_path_status() -> Result<CliPathStatus, CliPathError> {
    #[cfg(unix)]
    return blocking(|| Ok(cli_path::status(&cli_path::UnixEnv::current()))).await;
    #[cfg(windows)]
    return blocking(|| Ok(cli_path::status())).await;
}

#[tauri::command]
#[specta::specta]
pub async fn cli_path_install() -> Result<CliPathStatus, CliPathError> {
    #[cfg(unix)]
    return blocking(|| cli_path::install(&cli_path::UnixEnv::current())).await;
    #[cfg(windows)]
    return blocking(cli_path::install).await;
}

#[tauri::command]
#[specta::specta]
pub async fn cli_path_remove() -> Result<CliPathStatus, CliPathError> {
    #[cfg(unix)]
    return blocking(|| cli_path::remove(&cli_path::UnixEnv::current())).await;
    #[cfg(windows)]
    return blocking(cli_path::remove).await;
}
