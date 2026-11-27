//! Settings → General: connect the open vault to Claude Code, Codex or Cursor (`crate::mcp_clients`).
//! The vault comes from the window but must be the vault the app has open.

use std::path::PathBuf;

use crate::mcp_clients::{self, McpClient, McpClientError, McpClientStatus};
use crate::vault_context::VaultContext;

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, McpClientError> + Send + 'static,
) -> Result<T, McpClientError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| McpClientError::Failed)?
}

fn open_vault(context: &VaultContext, vault: &str) -> Result<PathBuf, McpClientError> {
    let active = context.conn.lock().map_err(|_| McpClientError::Failed)?;
    let root = active
        .as_ref()
        .map(|active| active.root.clone())
        .ok_or(McpClientError::NoVault)?;
    let asked = std::fs::canonicalize(vault).map_err(|_| McpClientError::NoVault)?;
    if asked != root {
        return Err(McpClientError::NoVault);
    }
    Ok(root)
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_clients_status() -> Result<Vec<McpClientStatus>, McpClientError> {
    blocking(|| Ok(mcp_clients::CLIENTS.map(mcp_clients::status).to_vec())).await
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_client_connect(
    context: tauri::State<'_, VaultContext>,
    client: McpClient,
    vault: String,
    write: bool,
) -> Result<McpClientStatus, McpClientError> {
    let root = open_vault(&context, &vault)?;
    let (cli, prefix) = mcp_clients::bundled_cli().ok_or(McpClientError::NoCli)?;
    let launch = mcp_clients::launch(&cli, &prefix, &crate::system_open::plain_path(&root), write);
    blocking(move || mcp_clients::connect(client, &launch)).await
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_client_disconnect(client: McpClient) -> Result<McpClientStatus, McpClientError> {
    blocking(move || mcp_clients::disconnect(client)).await
}
