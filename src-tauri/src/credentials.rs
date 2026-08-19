//! OS Keychain / Credential Manager integration for AI provider API keys.
//!
//! Keys are stored securely in the platform credential manager (macOS Keychain,
//! Windows Credential Manager, Linux Secret Service) under the service name
//! `com.ambynotes.ai` keyed by `credential_id` (a stable UUID).
//! Plaintext secrets are never stored in settings.json or exposed in full to the renderer.

use serde::{Deserialize, Serialize};

pub const SERVICE_NAME: &str = "com.ambynotes.ai";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInfo {
    pub exists: bool,
    pub masked: Option<String>,
}

pub fn mask_key(secret: &str) -> String {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() <= 8 {
        return "••••••••".to_string();
    }
    let prefix = &trimmed[..3];
    let suffix = &trimmed[trimmed.len() - 4..];
    format!("{prefix}••••{suffix}")
}

pub fn get_credential(credential_id: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, credential_id)
        .map_err(|e| format!("Keychain error: {e}"))?;
    entry
        .get_password()
        .map_err(|e| format!("Keychain error: {e}"))
}

pub fn set_credential(credential_id: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, credential_id)
        .map_err(|e| format!("Keychain error: {e}"))?;
    entry
        .set_password(secret)
        .map_err(|e| format!("Keychain error: {e}"))
}

pub fn delete_credential_entry(credential_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, credential_id)
        .map_err(|e| format!("Keychain error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}

#[tauri::command]
#[specta::specta]
pub fn store_ai_credential(credential_id: String, secret: String) -> Result<(), String> {
    set_credential(&credential_id, &secret)
}

#[tauri::command]
#[specta::specta]
pub fn delete_ai_credential(credential_id: String) -> Result<(), String> {
    delete_credential_entry(&credential_id)
}

#[tauri::command]
#[specta::specta]
pub fn inspect_ai_credential(credential_id: String) -> Result<CredentialInfo, String> {
    match get_credential(&credential_id) {
        Ok(secret) => Ok(CredentialInfo {
            exists: true,
            masked: Some(mask_key(&secret)),
        }),
        Err(_) => Ok(CredentialInfo {
            exists: false,
            masked: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mask_key() {
        assert_eq!(mask_key(""), "");
        assert_eq!(mask_key("12345"), "••••••••");
        assert_eq!(mask_key("sk-ant-api03-abcdef1234"), "sk-••••1234");
    }
}
