use crate::lock_util::LockExt;
use std::sync::Mutex;

use super::model::{DatabaseModuleState, ProjectionVersion};

#[derive(Default)]
struct RuntimeSnapshot {
    enabled: bool,
    vault_generation: Option<u64>,
    projection: Option<ProjectionVersion>,
}

/// Process-local database state. It is intentionally scoped to the active
/// vault generation and contains no durable data or paths.
#[derive(Default)]
pub struct DatabaseRuntimeState {
    snapshot: Mutex<RuntimeSnapshot>,
}

impl DatabaseRuntimeState {
    pub fn reset_for_generation(&self, generation: Option<u64>) {
        let mut snapshot = self.snapshot.lock_or_recover();
        if snapshot.vault_generation != generation {
            snapshot.enabled = false;
            snapshot.vault_generation = generation;
            snapshot.projection = None;
        }
    }

    pub fn set_enabled(&self, generation: u64, enabled: bool) -> DatabaseModuleState {
        self.reset_for_generation(Some(generation));
        let mut snapshot = self.snapshot.lock_or_recover();
        snapshot.enabled = enabled;
        snapshot_state(&snapshot)
    }

    pub fn set_projection(
        &self,
        generation: u64,
        projection: Option<ProjectionVersion>,
    ) -> DatabaseModuleState {
        self.reset_for_generation(Some(generation));
        let mut snapshot = self.snapshot.lock_or_recover();
        snapshot.projection = projection;
        snapshot_state(&snapshot)
    }

    pub fn state(&self, generation: Option<u64>) -> DatabaseModuleState {
        self.reset_for_generation(generation);
        let snapshot = self.snapshot.lock_or_recover();
        snapshot_state(&snapshot)
    }
}

fn snapshot_state(snapshot: &RuntimeSnapshot) -> DatabaseModuleState {
    DatabaseModuleState {
        enabled: snapshot.enabled,
        vault_generation: snapshot.vault_generation,
        projection: snapshot.projection.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::DatabaseRuntimeState;

    #[test]
    fn changing_vault_generation_clears_enabled_state_and_projection() {
        let runtime = DatabaseRuntimeState::default();
        let state = runtime.set_enabled(7, true);
        assert!(state.enabled);
        assert_eq!(state.vault_generation, Some(7));

        let next = runtime.state(Some(8));
        assert!(!next.enabled);
        assert_eq!(next.vault_generation, Some(8));
        assert!(next.projection.is_none());
    }

    #[test]
    fn resetting_to_no_vault_disables_the_module() {
        let runtime = DatabaseRuntimeState::default();
        runtime.set_enabled(3, true);

        let state = runtime.state(None);
        assert!(!state.enabled);
        assert_eq!(state.vault_generation, None);
    }

    #[test]
    fn state_survives_a_snapshot_mutex_poisoned_by_a_panic() {
        let runtime = std::sync::Arc::new(DatabaseRuntimeState::default());
        runtime.set_enabled(3, true);
        let clone = std::sync::Arc::clone(&runtime);
        let _ = std::thread::spawn(move || {
            let _guard = clone.snapshot.lock().unwrap();
            panic!("poison the snapshot mutex");
        })
        .join();
        assert!(runtime.snapshot.is_poisoned());

        let state = runtime.state(Some(3));
        assert!(state.enabled);
        assert_eq!(runtime.set_enabled(3, false).enabled, false);
    }
}
