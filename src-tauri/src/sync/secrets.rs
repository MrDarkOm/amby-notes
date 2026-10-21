//! AK and the device token live only in the system key store (Р5): macOS Keychain, Windows
//! Credential Manager, Linux Secret Service, service `com.ambynotes.sync`. Not in the settings,
//! not in the vault. Like [`crate::credentials`], no platform detail is copied into an error.

/// The service name of the key store entries (Р5).
pub const KEYRING_SERVICE: &str = "com.ambynotes.sync";
/// The name of the entry with AK (64 hex characters).
pub const SECRET_ACCOUNT_KEY: &str = "account-key";
/// The name of the entry with the token of this device (64 hex characters, П5).
pub const SECRET_DEVICE_TOKEN: &str = "device-token";

/// The key store could not be used. Carries no detail on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretError;

/// A place for secrets. The real one is the system key store; tests use a memory one.
pub trait SecretStore: Send + Sync {
    /// The value of `name`, or `None` when there is no such entry.
    fn get(&self, name: &str) -> Result<Option<String>, SecretError>;
    /// Stores `value` under `name` and reads it back; anything else is an error (as
    /// `credentials::set_credential` does).
    fn set(&self, name: &str, value: &str) -> Result<(), SecretError>;
    /// Removes `name`; a missing entry is not an error.
    fn delete(&self, name: &str) -> Result<(), SecretError>;
}

/// The system key store (`keyring`).
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringStore;

fn entry(name: &str) -> Result<keyring::Entry, SecretError> {
    keyring::Entry::new(KEYRING_SERVICE, name).map_err(|_| SecretError)
}

impl SecretStore for KeyringStore {
    fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
        match entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(SecretError),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
        entry(name)?.set_password(value).map_err(|_| SecretError)?;
        // A fresh entry must see the exact stored value; this also catches a build that fell
        // back to entry-local mock storage.
        match self.get(name)? {
            Some(stored) if stored == value => Ok(()),
            _ => Err(SecretError),
        }
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(SecretError),
        }
    }
}
