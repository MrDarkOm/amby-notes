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

/// A memory in front of a key store: each entry is read from the store once per run and then
/// served from memory; `set` and `delete` go through and update the memory. One lock covers the
/// store call as well, so concurrent readers wait for the first read instead of each starting one.
/// On macOS every read of the Keychain by a build that is not yet trusted shows a password prompt,
/// and the sync status is asked for often: without this memory the prompts queue up endlessly.
/// A failed read is not remembered, so a denied prompt can be retried.
pub struct CachedSecrets<S> {
    inner: S,
    memory: std::sync::Mutex<std::collections::HashMap<String, Option<String>>>,
}

impl<S: SecretStore> CachedSecrets<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            memory: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn memory(
        &self,
    ) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, Option<String>>> {
        self.memory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl<S: SecretStore> SecretStore for CachedSecrets<S> {
    fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
        let mut memory = self.memory();
        if let Some(known) = memory.get(name) {
            return Ok(known.clone());
        }
        let value = self.inner.get(name)?;
        memory.insert(name.to_string(), value.clone());
        Ok(value)
    }

    fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
        let mut memory = self.memory();
        memory.remove(name);
        self.inner.set(name, value)?;
        memory.insert(name.to_string(), Some(value.to_string()));
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        let mut memory = self.memory();
        memory.remove(name);
        self.inner.delete(name)?;
        memory.insert(name.to_string(), None);
        Ok(())
    }
}

#[cfg(test)]
mod cached_tests {
    use super::{CachedSecrets, SecretError, SecretStore};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Counting {
        values: Mutex<HashMap<String, String>>,
        reads: AtomicUsize,
        fail_reads: AtomicUsize,
    }

    impl SecretStore for Arc<Counting> {
        fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.fail_reads.load(Ordering::SeqCst) > 0 {
                self.fail_reads.fetch_sub(1, Ordering::SeqCst);
                return Err(SecretError);
            }
            Ok(self.values.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
            self.values
                .lock()
                .unwrap()
                .insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), SecretError> {
            self.values.lock().unwrap().remove(name);
            Ok(())
        }
    }

    #[test]
    fn the_store_is_read_once_per_entry_however_often_status_asks() {
        let store = Arc::new(Counting::default());
        store
            .values
            .lock()
            .unwrap()
            .insert("account-key".into(), "k".into());
        let cached = CachedSecrets::new(store.clone());
        for _ in 0..50 {
            assert_eq!(cached.get("account-key").unwrap().as_deref(), Some("k"));
            assert_eq!(cached.get("device-token").unwrap(), None);
        }
        assert_eq!(store.reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_readers_wait_for_one_read() {
        let store = Arc::new(Counting::default());
        store
            .values
            .lock()
            .unwrap()
            .insert("device-token".into(), "t".into());
        let cached = Arc::new(CachedSecrets::new(store.clone()));
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let cached = cached.clone();
                std::thread::spawn(move || cached.get("device-token").unwrap())
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap().as_deref(), Some("t"));
        }
        assert_eq!(store.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn set_and_delete_update_the_memory_and_a_failed_read_is_retried() {
        let store = Arc::new(Counting::default());
        let cached = CachedSecrets::new(store.clone());
        store.fail_reads.store(1, Ordering::SeqCst);
        assert!(cached.get("account-key").is_err());
        assert_eq!(cached.get("account-key").unwrap(), None);
        cached.set("account-key", "new").unwrap();
        assert_eq!(cached.get("account-key").unwrap().as_deref(), Some("new"));
        cached.delete("account-key").unwrap();
        assert_eq!(cached.get("account-key").unwrap(), None);
        assert_eq!(store.reads.load(Ordering::SeqCst), 2);
    }
}
