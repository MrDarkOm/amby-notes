//! Serialize OS key store access: macOS's interaction switch is process-wide. Background
//! sync must never open a password dialog, and must not suppress an AI credential prompt.

pub fn access<T>(
    interactive: bool,
    action: impl FnOnce() -> keyring::Result<T>,
) -> keyring::Result<T> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::os::macos::keychain::SecKeychain;
        static ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _access = ACCESS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let was_allowed = SecKeychain::user_interaction_allowed()
            .map_err(|error| keyring::Error::PlatformFailure(Box::new(error)))?;
        // Only disable a permitted UI. The guard restores it on every return (and unwind).
        // Never enable interaction if the caller or system had already disabled it.
        let _silent = if !interactive && was_allowed {
            Some(
                SecKeychain::disable_user_interaction()
                    .map_err(|error| keyring::Error::PlatformFailure(Box::new(error)))?,
            )
        } else {
            None
        };
        action()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = interactive;
        action()
    }
}

thread_local! {
    static SYNC_INTERACTIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn sync_access<T>(action: impl FnOnce() -> keyring::Result<T>) -> keyring::Result<T> {
    access(SYNC_INTERACTIVE.get(), action)
}

/// A synchronous, explicit account action; never hold this scope across an await.
pub fn account_action<T>(action: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            SYNC_INTERACTIVE.set(self.0);
        }
    }
    let _restore = Restore(SYNC_INTERACTIVE.replace(true));
    action()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_account_actions_allow_sync_interaction() {
        assert!(!SYNC_INTERACTIVE.get());
        account_action(|| {
            assert!(SYNC_INTERACTIVE.get());
            account_action(|| assert!(SYNC_INTERACTIVE.get()));
            assert!(SYNC_INTERACTIVE.get());
        });
        assert!(!SYNC_INTERACTIVE.get());
        let _ = std::panic::catch_unwind(|| account_action(|| panic!("test unwind")));
        assert!(!SYNC_INTERACTIVE.get());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn background_scope_disables_dialogs_and_restores_the_previous_policy() {
        use security_framework::os::macos::keychain::SecKeychain;
        access(true, || {
            let before = SecKeychain::user_interaction_allowed().unwrap();
            // Test the guard separately: calling access recursively would take the lock twice.
            let silent = before.then(|| SecKeychain::disable_user_interaction().unwrap());
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
            drop(silent);
            assert_eq!(SecKeychain::user_interaction_allowed().unwrap(), before);
            Ok(())
        })
        .unwrap();
        access(false, || {
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
            Ok(())
        })
        .unwrap();
    }
}
