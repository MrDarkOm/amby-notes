use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

use crate::{model::IndexState, property_store, vault_index};

pub struct ActiveVault {
    pub root: PathBuf,
    pub connection: Connection,
    pub generation: u64,
    pub watcher_identity: Option<u64>,
    pub index_health: IndexState,
}

impl Deref for ActiveVault {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

pub struct PreparedVault {
    root: PathBuf,
    connection: Connection,
    loaded: vault_index::LoadVaultResult,
}

/// The only managed backend state for an open vault. Root and SQLite
/// connection are always read under one mutex, so a command cannot observe a
/// new root paired with the prior vault's index connection.
#[derive(Default)]
pub struct VaultContext {
    /// Kept as `conn` during the transition so all database command call sites
    /// lock this single context rather than a separate connection mutex.
    pub conn: Mutex<Option<ActiveVault>>,
}

impl VaultContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self) -> Result<PathBuf, String> {
        self.root()
    }

    pub fn generation(&self) -> Result<u64, String> {
        self.conn
            .lock()
            .unwrap()
            .as_ref()
            .map(|active| active.generation)
            .ok_or_else(|| "No vault is open".to_string())
    }

    pub fn root(&self) -> Result<PathBuf, String> {
        let active = self.conn.lock().unwrap();
        let active = active
            .as_ref()
            .ok_or_else(|| "No vault is open".to_string())?;
        Ok(active.root.clone())
    }

    #[cfg(test)]
    pub fn with_active<T>(
        &self,
        operation: impl FnOnce(&ActiveVault) -> Result<T, String>,
    ) -> Result<T, String> {
        let active = self.conn.lock().unwrap();
        operation(active.as_ref().ok_or("No vault is open")?)
    }

    pub fn prepare_activation(candidate: &str) -> Result<PreparedVault, String> {
        let root = Path::new(candidate)
            .canonicalize()
            .map_err(|error| format!("Vault not accessible: {error}"))?;
        if !root.is_dir() {
            return Err(format!("Vault is not a directory: {}", root.display()));
        }

        // Preflight is read-only and must complete before the active state can
        // change. Opening the connection verifies schema initialization too.
        let preflight = vault_index::preflight_vault(&root)?;
        if let Some(recovery) = preflight.unfinished_migrations.first() {
            return Err(format!(
                "An unfinished ID migration must be recovered before opening this vault: {}",
                recovery.journal_path
            ));
        }
        let connection = vault_index::open_connection(&root)?;
        property_store::restore_cache(&connection, &root)?;
        let _ = crate::recovery::sweep_expired_recovery(&root);
        let loaded = vault_index::load_vault(&connection, &root)?;

        Ok(PreparedVault {
            root,
            connection,
            loaded,
        })
    }

    /// Commit a fully prepared vault in one replacement, then run the
    /// post-commit setup while the context remains locked. If setup fails, the
    /// prior active vault is restored before any command can observe the new
    /// context.
    pub fn commit_activation(
        &self,
        prepared: PreparedVault,
        after_commit: impl FnOnce(&ActiveVault) -> Result<(), String>,
    ) -> Result<(vault_index::LoadVaultResult, u64), String> {
        let mut active = self.conn.lock().unwrap();
        let generation = active
            .as_ref()
            .map(|current| current.generation.saturating_add(1))
            .unwrap_or(1);
        let previous = active.take();
        *active = Some(ActiveVault {
            root: prepared.root,
            connection: prepared.connection,
            generation,
            watcher_identity: None,
            index_health: IndexState::Healthy,
        });
        if let Err(error) = after_commit(active.as_ref().expect("active vault was just set")) {
            *active = previous;
            return Err(error);
        }
        Ok((prepared.loaded, generation))
    }

    pub fn activate<T>(
        &self,
        candidate: &str,
        update_scopes: impl FnOnce(&Path) -> Result<(), String>,
        result: impl FnOnce(vault_index::LoadVaultResult, u64) -> T,
    ) -> Result<T, String> {
        let prepared = Self::prepare_activation(candidate)?;
        let (loaded, generation) =
            self.commit_activation(prepared, |active| update_scopes(&active.root))?;
        Ok(result(loaded, generation))
    }

    pub fn set_watcher_identity(&self, watcher_identity: Option<u64>) -> Result<(), String> {
        let mut active = self.conn.lock().unwrap();
        let active = active.as_mut().ok_or("No vault is open")?;
        if active.watcher_identity == watcher_identity {
            return Ok(());
        }
        active.watcher_identity = watcher_identity;
        Ok(())
    }

    pub fn mark_index_rebuild_required(&self) -> Result<(), String> {
        let mut active = self.conn.lock().unwrap();
        let active = active.as_mut().ok_or("No vault is open")?;
        active.index_health = IndexState::RebuildRequired;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("amby-context-{name}-{nanos}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Note.md"), "# Note").unwrap();
        root
    }

    #[test]
    fn failed_database_open_keeps_the_previous_active_vault() {
        let context = VaultContext::default();
        let first = temp_dir("first");
        context
            .activate(first.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .unwrap();
        let original_root = context.root().unwrap();

        let broken = temp_dir("broken");
        fs::write(broken.join(".amby"), "not a directory").unwrap();
        assert!(context
            .activate(broken.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .is_err());

        assert_eq!(context.root().unwrap(), original_root);
    }

    #[test]
    fn failed_scope_update_does_not_commit_a_half_active_vault() {
        let context = VaultContext::default();
        let first = temp_dir("scope-first");
        context
            .activate(first.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .unwrap();
        let original_root = context.root().unwrap();
        let second = temp_dir("scope-second");

        assert!(context
            .activate(
                second.to_str().unwrap(),
                |_| Err("scope rejected".to_string()),
                |_, _| ()
            )
            .is_err());

        assert_eq!(context.root().unwrap(), original_root);
    }

    #[test]
    fn generation_advances_only_after_a_successful_commit() {
        let context = VaultContext::default();
        let first = temp_dir("generation-first");
        let first_generation = context
            .activate(
                first.to_str().unwrap(),
                |_| Ok(()),
                |_, generation| generation,
            )
            .unwrap();
        let failed = temp_dir("generation-failed");
        assert!(context
            .activate(
                failed.to_str().unwrap(),
                |_| Err("scope rejected".to_string()),
                |_, _| ()
            )
            .is_err());
        let second = temp_dir("generation-second");
        let second_generation = context
            .activate(
                second.to_str().unwrap(),
                |_| Ok(()),
                |_, generation| generation,
            )
            .unwrap();

        assert_eq!(first_generation, 1);
        assert_eq!(second_generation, 2);
    }

    #[test]
    fn index_failure_marks_the_active_context_for_rebuild() {
        let context = VaultContext::default();
        let vault = temp_dir("index-rebuild");
        context
            .activate(vault.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .unwrap();

        context.mark_index_rebuild_required().unwrap();
        context
            .with_active(|active| {
                assert_eq!(active.index_health, IndexState::RebuildRequired);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn root_and_connection_are_observed_from_the_same_active_vault() {
        let context = VaultContext::default();
        let vault = temp_dir("consistent");
        context
            .activate(vault.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .unwrap();

        context
            .with_active(|active| {
                let database: String = active
                    .connection
                    .query_row("PRAGMA database_list", [], |row| row.get(2))
                    .map_err(|error| error.to_string())?;
                assert!(Path::new(&database).starts_with(&active.root));
                assert_eq!(active.index_health, IndexState::Healthy);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn concurrent_commands_observe_a_consistent_root_and_connection() {
        let context = Arc::new(VaultContext::default());
        let vault = temp_dir("concurrent-first");
        let alternate_vault = temp_dir("concurrent-second");
        context
            .activate(vault.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .unwrap();

        let switcher_context = Arc::clone(&context);
        let switcher = std::thread::spawn(move || {
            for index in 0..16 {
                let target = if index % 2 == 0 {
                    &alternate_vault
                } else {
                    &vault
                };
                switcher_context
                    .activate(target.to_str().unwrap(), |_| Ok(()), |_, _| ())
                    .unwrap();
            }
        });
        let commands = (0..8)
            .map(|_| {
                let context = Arc::clone(&context);
                std::thread::spawn(move || {
                    for _ in 0..16 {
                        context.with_active(|active| {
                            let database: String = active
                                .connection
                                .query_row("PRAGMA database_list", [], |row| row.get(2))
                                .map_err(|error| error.to_string())?;
                            assert!(Path::new(&database).starts_with(&active.root));
                            Ok(())
                        })?;
                    }
                    Ok::<(), String>(())
                })
            })
            .collect::<Vec<_>>();

        switcher.join().unwrap();
        for command in commands {
            command.join().unwrap().unwrap();
        }
    }
}
