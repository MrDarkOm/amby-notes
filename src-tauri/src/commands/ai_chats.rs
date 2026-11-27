use crate::ai::chats::{self, Chat, ChatEntry, LoadedChat};
use crate::vault_context::VaultContext;

#[tauri::command]
#[specta::specta]
pub fn ai_search_consent(
    context: tauri::State<'_, VaultContext>,
    generation: u64,
    config: crate::ai::AiConfig,
) -> Result<String, String> {
    let active = context.conn.lock().map_err(|_| "Vault unavailable")?;
    crate::ai::consent::status(active_root(&active, generation)?, &config).map(str::to_owned)
}

#[tauri::command]
#[specta::specta]
pub fn ai_set_search_consent(
    context: tauri::State<'_, VaultContext>,
    generation: u64,
    config: crate::ai::AiConfig,
    allowed: bool,
) -> Result<(), String> {
    let _gate = context
        .mutation_gate
        .lock()
        .map_err(|_| "Vault unavailable")?;
    let active = context.conn.lock().map_err(|_| "Vault unavailable")?;
    crate::ai::consent::decide(active_root(&active, generation)?, &config, allowed)
}

fn active_root(
    active: &Option<crate::vault_context::ActiveVault>,
    generation: u64,
) -> Result<&std::path::Path, String> {
    let active = active.as_ref().ok_or("No vault is open")?;
    if active.generation != generation {
        return Err("Vault changed".into());
    }
    Ok(&active.root)
}

#[tauri::command]
#[specta::specta]
pub fn ai_list_chats(
    context: tauri::State<'_, VaultContext>,
    generation: u64,
) -> Result<Vec<ChatEntry>, String> {
    let active = context.conn.lock().map_err(|_| "Vault unavailable")?;
    chats::list(active_root(&active, generation)?)
}

#[tauri::command]
#[specta::specta]
pub fn ai_load_chat(
    context: tauri::State<'_, VaultContext>,
    generation: u64,
    id: String,
) -> Result<LoadedChat, String> {
    let active = context.conn.lock().map_err(|_| "Vault unavailable")?;
    chats::load(active_root(&active, generation)?, &id)
}

#[tauri::command]
#[specta::specta]
pub fn ai_save_chat(
    context: tauri::State<'_, VaultContext>,
    generation: u64,
    chat: Chat,
    expected_revision: Option<String>,
) -> Result<String, String> {
    let _gate = context
        .mutation_gate
        .lock()
        .map_err(|_| "Vault unavailable")?;
    let active = context.conn.lock().map_err(|_| "Vault unavailable")?;
    chats::save(
        active_root(&active, generation)?,
        &chat,
        expected_revision.as_deref(),
    )
}

#[tauri::command]
#[specta::specta]
pub fn ai_trash_chat(
    context: tauri::State<'_, VaultContext>,
    generation: u64,
    id: String,
    expected_revision: String,
) -> Result<(), String> {
    let _gate = context
        .mutation_gate
        .lock()
        .map_err(|_| "Vault unavailable")?;
    let active = context.conn.lock().map_err(|_| "Vault unavailable")?;
    chats::trash(active_root(&active, generation)?, &id, &expected_revision)
}
