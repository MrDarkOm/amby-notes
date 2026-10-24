//! AK and the device token live only in the system key store (Р5): macOS Keychain, Windows
//! Credential Manager, Linux Secret Service, service `com.ambynotes.sync`. Not in the settings,
//! not in the vault. Like [`crate::credentials`], no platform detail is copied into an error.

/// The service name of the key store entries (Р5).
pub const KEYRING_SERVICE: &str = "com.ambynotes.sync";
/// The name of the entry with AK (64 hex characters).
pub const SECRET_ACCOUNT_KEY: &str = "account-key";
/// The name of the entry with the token of this device (64 hex characters, П5).
pub const SECRET_DEVICE_TOKEN: &str = "device-token";

/// The single key store entry that holds both secrets (JSON, see [`BundledSecrets`]).
pub const SECRET_BUNDLE: &str = "credentials";

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

/// Stub: not yet bundling (tests first).
pub struct BundledSecrets<S> {
    inner: S,
}

impl<S: SecretStore> BundledSecrets<S> {
    pub fn new(inner: S) -> Self {
        Self { inner }
    }
}

impl<S: SecretStore> SecretStore for BundledSecrets<S> {
    fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
        self.inner.get(name)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
        self.inner.set(name, value)
    }
    fn delete(&self, name: &str) -> Result<(), SecretError> {
        self.inner.delete(name)
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

#[cfg(test)]
mod bundled_tests {
    use super::{BundledSecrets, SecretError, SecretStore};
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    const AK: &str = "account-key";
    const TOKEN: &str = "device-token";
    const BUNDLE: &str = "credentials";

    /// A key store that records every physical call and can be told to fail or to lie.
    #[derive(Default)]
    struct Fake {
        values: Mutex<HashMap<String, String>>,
        reads: Mutex<Vec<String>>,
        deletes: Mutex<Vec<String>>,
        fail_get: Mutex<HashSet<String>>,
        fail_set: Mutex<HashSet<String>>,
        fail_delete: Mutex<HashSet<String>>,
        /// `set` reports success but stores nothing.
        lie_set: Mutex<HashSet<String>>,
    }

    impl SecretStore for Arc<Fake> {
        fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
            self.reads.lock().unwrap().push(name.into());
            if self.fail_get.lock().unwrap().contains(name) {
                return Err(SecretError);
            }
            Ok(self.values.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
            if self.fail_set.lock().unwrap().contains(name) {
                return Err(SecretError);
            }
            if self.lie_set.lock().unwrap().contains(name) {
                return Ok(());
            }
            self.values
                .lock()
                .unwrap()
                .insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), SecretError> {
            self.deletes.lock().unwrap().push(name.into());
            if self.fail_delete.lock().unwrap().contains(name) {
                return Err(SecretError);
            }
            self.values.lock().unwrap().remove(name);
            Ok(())
        }
    }

    impl Fake {
        fn put(&self, name: &str, value: &str) {
            self.values
                .lock()
                .unwrap()
                .insert(name.into(), value.into());
        }
        fn raw(&self, name: &str) -> Option<String> {
            self.values.lock().unwrap().get(name).cloned()
        }
        fn names(&self) -> Vec<String> {
            let mut names: Vec<_> = self.values.lock().unwrap().keys().cloned().collect();
            names.sort();
            names
        }
        fn read_count(&self) -> usize {
            self.reads.lock().unwrap().len()
        }
        fn failing(&self, which: &Mutex<HashSet<String>>, name: &str) {
            which.lock().unwrap().insert(name.into());
        }
    }

    fn bundle_json(ak: Option<&str>, token: Option<&str>) -> String {
        serde_json::json!({"v": 1, "account_key": ak, "device_token": token}).to_string()
    }

    fn fresh() -> (Arc<Fake>, BundledSecrets<Arc<Fake>>) {
        let fake = Arc::new(Fake::default());
        let secrets = BundledSecrets::new(fake.clone());
        (fake, secrets)
    }

    #[test]
    fn signing_in_writes_one_entry_and_no_legacy_ones() {
        let (fake, secrets) = fresh();
        secrets.set(AK, "ak1").unwrap();
        secrets.set(TOKEN, "tok1").unwrap();
        assert_eq!(fake.names(), vec![BUNDLE.to_string()]);
        let json: serde_json::Value = serde_json::from_str(&fake.raw(BUNDLE).unwrap()).unwrap();
        assert_eq!(json["v"], 1);
        assert_eq!(json["account_key"], "ak1");
        assert_eq!(json["device_token"], "tok1");
        // a new run sees both
        let next = BundledSecrets::new(fake.clone());
        assert_eq!(next.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(next.get(TOKEN).unwrap().as_deref(), Some("tok1"));
    }

    #[test]
    fn the_entry_is_read_from_the_key_store_once_per_run() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, &bundle_json(Some("ak1"), Some("tok1")));
        for _ in 0..50 {
            assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
            assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("tok1"));
        }
        assert_eq!(fake.read_count(), 1);
    }

    #[test]
    fn nothing_stored_reads_as_signed_out_and_is_remembered() {
        let (fake, secrets) = fresh();
        assert_eq!(secrets.get(AK).unwrap(), None);
        assert_eq!(secrets.get(TOKEN).unwrap(), None);
        let after_first = fake.read_count();
        assert_eq!(secrets.get(AK).unwrap(), None);
        assert_eq!(fake.read_count(), after_first);
        assert!(fake.names().is_empty());
    }

    #[test]
    fn a_failed_read_is_not_remembered() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, &bundle_json(Some("ak1"), Some("tok1")));
        fake.failing(&fake.fail_get, BUNDLE);
        assert!(secrets.get(AK).is_err());
        fake.fail_get.lock().unwrap().clear();
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
    }

    #[test]
    fn two_old_entries_move_into_the_new_one_and_are_removed() {
        let (fake, secrets) = fresh();
        fake.put(AK, "ak1");
        fake.put(TOKEN, "tok1");
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("tok1"));
        assert_eq!(fake.names(), vec![BUNDLE.to_string()]);
        let next = BundledSecrets::new(fake.clone());
        assert_eq!(next.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(next.get(TOKEN).unwrap().as_deref(), Some("tok1"));
    }

    #[test]
    fn only_one_old_entry_migrates_what_there_is() {
        let (fake, secrets) = fresh();
        fake.put(TOKEN, "tok1");
        assert_eq!(secrets.get(AK).unwrap(), None);
        assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("tok1"));
        assert_eq!(fake.names(), vec![BUNDLE.to_string()]);
        let json: serde_json::Value = serde_json::from_str(&fake.raw(BUNDLE).unwrap()).unwrap();
        assert!(json["account_key"].is_null());
        assert_eq!(json["device_token"], "tok1");
    }

    #[test]
    fn old_entries_stay_when_the_new_one_cannot_be_written() {
        let (fake, secrets) = fresh();
        fake.put(AK, "ak1");
        fake.put(TOKEN, "tok1");
        fake.failing(&fake.fail_set, BUNDLE);
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("tok1"));
        assert_eq!(fake.raw(AK).as_deref(), Some("ak1"));
        assert_eq!(fake.raw(TOKEN).as_deref(), Some("tok1"));
        assert!(fake.deletes.lock().unwrap().is_empty());
    }

    #[test]
    fn old_entries_stay_when_the_new_one_does_not_read_back() {
        let (fake, secrets) = fresh();
        fake.put(AK, "ak1");
        fake.put(TOKEN, "tok1");
        fake.failing(&fake.lie_set, BUNDLE);
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("tok1"));
        assert_eq!(fake.raw(AK).as_deref(), Some("ak1"));
        assert_eq!(fake.raw(TOKEN).as_deref(), Some("tok1"));
        assert!(fake.deletes.lock().unwrap().is_empty());
    }

    #[test]
    fn a_failed_removal_of_old_entries_does_not_lose_the_sign_in() {
        let (fake, secrets) = fresh();
        fake.put(AK, "ak1");
        fake.put(TOKEN, "tok1");
        fake.failing(&fake.fail_delete, AK);
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("tok1"));
        assert!(fake.raw(BUNDLE).is_some());
        // the next run trusts the new entry and does not touch the leftovers
        let next = BundledSecrets::new(fake.clone());
        let before = fake.read_count();
        assert_eq!(next.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(next.get(TOKEN).unwrap().as_deref(), Some("tok1"));
        assert_eq!(fake.read_count() - before, 1);
    }

    #[test]
    fn a_denied_read_of_an_old_entry_changes_nothing_and_can_be_retried() {
        let (fake, secrets) = fresh();
        fake.put(AK, "ak1");
        fake.put(TOKEN, "tok1");
        fake.failing(&fake.fail_get, TOKEN);
        assert!(secrets.get(AK).is_err());
        assert!(fake.raw(BUNDLE).is_none());
        assert!(fake.deletes.lock().unwrap().is_empty());
        fake.fail_get.lock().unwrap().clear();
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("tok1"));
    }

    #[test]
    fn the_new_entry_wins_over_leftovers_which_are_not_even_read() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, &bundle_json(Some("new-ak"), Some("new-tok")));
        fake.put(AK, "old-ak");
        fake.put(TOKEN, "old-tok");
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("new-ak"));
        assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("new-tok"));
        assert_eq!(fake.read_count(), 1);
        assert_eq!(fake.raw(AK).as_deref(), Some("old-ak"));
    }

    #[test]
    fn a_corrupt_new_entry_without_old_ones_is_an_error_and_is_left_alone() {
        for bad in ["not json", "{}", "{\"v\":2,\"account_key\":\"a\"}", "[]"] {
            let (fake, secrets) = fresh();
            fake.put(BUNDLE, bad);
            assert!(secrets.get(AK).is_err(), "{bad}");
            assert_eq!(fake.raw(BUNDLE).as_deref(), Some(bad));
        }
    }

    #[test]
    fn a_corrupt_new_entry_falls_back_to_old_ones_without_touching_anything() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, "garbage");
        fake.put(AK, "ak1");
        fake.put(TOKEN, "tok1");
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(secrets.get(TOKEN).unwrap().as_deref(), Some("tok1"));
        assert_eq!(fake.raw(BUNDLE).as_deref(), Some("garbage"));
        assert_eq!(fake.raw(AK).as_deref(), Some("ak1"));
        assert!(fake.deletes.lock().unwrap().is_empty());
    }

    #[test]
    fn signing_in_again_replaces_a_corrupt_entry() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, "garbage");
        secrets.set(AK, "ak2").unwrap();
        secrets.set(TOKEN, "tok2").unwrap();
        let next = BundledSecrets::new(fake.clone());
        assert_eq!(next.get(AK).unwrap().as_deref(), Some("ak2"));
        assert_eq!(next.get(TOKEN).unwrap().as_deref(), Some("tok2"));
    }

    #[test]
    fn signing_out_a_corrupt_entry_removes_it() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, "garbage");
        secrets.delete(AK).unwrap();
        secrets.delete(TOKEN).unwrap();
        assert!(fake.names().is_empty());
    }

    #[test]
    fn setting_one_secret_keeps_the_other() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, &bundle_json(Some("ak1"), Some("tok1")));
        secrets.set(TOKEN, "tok2").unwrap();
        let next = BundledSecrets::new(fake.clone());
        assert_eq!(next.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(next.get(TOKEN).unwrap().as_deref(), Some("tok2"));
    }

    #[test]
    fn signing_out_removes_the_new_entry_and_any_leftovers() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, &bundle_json(Some("ak1"), Some("tok1")));
        fake.put(AK, "old-ak");
        fake.put(TOKEN, "old-tok");
        secrets.delete(AK).unwrap();
        secrets.delete(TOKEN).unwrap();
        assert!(fake.names().is_empty());
        assert_eq!(secrets.get(AK).unwrap(), None);
        assert_eq!(secrets.get(TOKEN).unwrap(), None);
        let next = BundledSecrets::new(fake.clone());
        assert_eq!(next.get(AK).unwrap(), None);
    }

    #[test]
    fn deleting_one_secret_keeps_the_other_signed_in() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, &bundle_json(Some("ak1"), Some("tok1")));
        secrets.delete(TOKEN).unwrap();
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(secrets.get(TOKEN).unwrap(), None);
        let next = BundledSecrets::new(fake.clone());
        assert_eq!(next.get(AK).unwrap().as_deref(), Some("ak1"));
        assert_eq!(next.get(TOKEN).unwrap(), None);
    }

    #[test]
    fn a_failed_sign_out_keeps_the_sign_in_instead_of_resurrecting_old_entries() {
        let (fake, secrets) = fresh();
        fake.put(BUNDLE, &bundle_json(Some("ak1"), Some("tok1")));
        fake.put(AK, "old-ak");
        fake.failing(&fake.fail_delete, AK);
        secrets.delete(TOKEN).unwrap();
        assert!(secrets.delete(AK).is_err());
        // the new entry was not removed, so a later run cannot fall back to the leftovers
        assert!(fake.raw(BUNDLE).is_some());
        assert_eq!(secrets.get(AK).unwrap().as_deref(), Some("ak1"));
    }

    #[test]
    fn a_failed_write_is_not_remembered_as_stored() {
        let (fake, secrets) = fresh();
        secrets.set(AK, "ak1").unwrap();
        fake.failing(&fake.fail_set, BUNDLE);
        assert!(secrets.set(TOKEN, "tok1").is_err());
        assert_eq!(secrets.get(TOKEN).unwrap(), None);
    }

    #[test]
    fn unknown_names_are_refused() {
        let (fake, secrets) = fresh();
        assert!(secrets.get("something-else").is_err());
        assert!(secrets.set("something-else", "x").is_err());
        assert!(secrets.delete("something-else").is_err());
        assert!(fake.names().is_empty());
    }
}
