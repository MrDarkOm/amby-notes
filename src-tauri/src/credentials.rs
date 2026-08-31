//! OS Keychain / Credential Manager integration for AI provider API keys.
//!
//! Keys are stored securely in the platform credential manager (macOS Keychain,
//! Windows Credential Manager, Linux Secret Service) under the service name
//! `com.ambynotes.ai` keyed by `credential_id` (a stable UUID).
//! Plaintext secrets are never stored in settings.json or exposed in full to the renderer.

use serde::{Deserialize, Serialize};

pub const SERVICE_NAME: &str = "com.ambynotes.ai";
const KEYCHAIN_ERROR: &str = "OS credential storage unavailable";

// Never format keyring errors into IPC: platform errors can contain credential attributes.
fn credential_error(_: keyring::Error) -> String {
    KEYCHAIN_ERROR.to_string()
}

fn read_credential(credential_id: &str) -> keyring::Result<String> {
    keyring::Entry::new(SERVICE_NAME, credential_id)?.get_password()
}

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
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 8 {
        return "••••••••".to_string();
    }
    let prefix: String = chars[..3].iter().collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("{prefix}••••{suffix}")
}

pub fn get_credential(credential_id: &str) -> Result<String, String> {
    read_credential(credential_id).map_err(credential_error)
}

pub fn set_credential(credential_id: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, credential_id).map_err(credential_error)?;
    entry.set_password(secret).map_err(credential_error)?;
    // A fresh entry must see the exact stored value before store reports success.
    // This also prevents an accidental switch back to entry-local mock storage.
    match read_credential(credential_id) {
        Ok(stored) if stored == secret => Ok(()),
        _ => Err(KEYCHAIN_ERROR.to_string()),
    }
}

pub fn delete_credential_entry(credential_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, credential_id).map_err(credential_error)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(credential_error(e)),
    }
}

fn store_or_delete_credential<S, D>(
    credential_id: &str,
    secret: &str,
    store: S,
    delete: D,
) -> Result<(), String>
where
    S: FnOnce(&str, &str) -> Result<(), String>,
    D: FnOnce(&str) -> Result<(), String>,
{
    if secret.trim().is_empty() {
        delete(credential_id)
    } else {
        store(credential_id, secret)
    }
}

#[tauri::command]
#[specta::specta]
pub fn store_ai_credential(credential_id: String, secret: String) -> Result<(), String> {
    store_or_delete_credential(
        &credential_id,
        &secret,
        set_credential,
        delete_credential_entry,
    )
}

#[tauri::command]
#[specta::specta]
pub fn delete_ai_credential(credential_id: String) -> Result<(), String> {
    delete_credential_entry(&credential_id)
}

#[tauri::command]
#[specta::specta]
pub fn inspect_ai_credential(credential_id: String) -> Result<CredentialInfo, String> {
    credential_info(read_credential(&credential_id))
}

fn credential_info(result: keyring::Result<String>) -> Result<CredentialInfo, String> {
    match result {
        Ok(secret) => Ok(CredentialInfo {
            exists: true,
            masked: Some(mask_key(&secret)),
        }),
        Err(keyring::Error::NoEntry) => Ok(CredentialInfo {
            exists: false,
            masked: None,
        }),
        Err(error) => Err(credential_error(error)),
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
        assert_eq!(mask_key("🔑абвгдеёжз"), "🔑аб••••еёжз");
        assert_eq!(mask_key("ключ"), "••••••••");
    }

    #[test]
    fn native_backend_is_configured() {
        // Constructing the macOS/Windows credential does not read or write a secret.
        // These references also prevent removing the required backend Cargo features.
        #[cfg(target_os = "macos")]
        assert!(keyring::Entry::new(SERVICE_NAME, "backend-type-check")
            .unwrap()
            .get_credential()
            .is::<keyring::macos::MacCredential>());
        #[cfg(target_os = "windows")]
        assert!(keyring::Entry::new(SERVICE_NAME, "backend-type-check")
            .unwrap()
            .get_credential()
            .is::<keyring::windows::WinCredential>());
        #[cfg(target_os = "linux")]
        assert_eq!(
            std::any::TypeId::of::<keyring::default::SsCredential>(),
            std::any::TypeId::of::<keyring::secret_service::SsCredential>()
        );
    }

    #[test]
    fn inspect_distinguishes_missing_from_storage_failure_without_leaking_details() {
        let missing = credential_info(Err(keyring::Error::NoEntry)).unwrap();
        assert!(!missing.exists);
        assert!(missing.masked.is_none());
        let error = credential_info(Err(keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("sensitive platform details"),
        ))))
        .unwrap_err();
        assert_eq!(error, KEYCHAIN_ERROR);
    }

    #[test]
    fn empty_credential_update_deletes_existing_entry() {
        let operation = std::cell::RefCell::new(None);
        store_or_delete_credential(
            "credential-id",
            "   ",
            |_, _| {
                *operation.borrow_mut() = Some("store");
                Ok(())
            },
            |_| {
                *operation.borrow_mut() = Some("delete");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(*operation.borrow(), Some("delete"));
    }
}
