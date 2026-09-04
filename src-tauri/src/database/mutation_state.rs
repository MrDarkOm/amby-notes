use std::collections::HashMap;
use std::sync::Mutex;

use super::mutations::DatabaseValueBatchResult;

#[derive(Default)]
pub struct DatabaseMutationState {
    completed: Mutex<HashMap<(u64, String), DatabaseValueBatchResult>>,
}

impl DatabaseMutationState {
    pub fn get(&self, generation: u64, operation_id: &str) -> Option<DatabaseValueBatchResult> {
        self.completed
            .lock()
            .expect("database mutation state poisoned")
            .get(&(generation, operation_id.to_owned()))
            .cloned()
    }

    pub fn remember(&self, generation: u64, result: DatabaseValueBatchResult) {
        self.completed
            .lock()
            .expect("database mutation state poisoned")
            .insert((generation, result.operation_id.clone()), result);
    }

    pub fn reset_for_generation(&self, generation: u64) {
        self.completed
            .lock()
            .expect("database mutation state poisoned")
            .retain(|(stored_generation, _), _| *stored_generation == generation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_operation_id_returns_the_original_result() {
        let state = DatabaseMutationState::default();
        let result = DatabaseValueBatchResult {
            operation_id: "op-1".to_owned(),
            database_id: "db-1".to_owned(),
            revisions: Vec::new(),
            warnings: Vec::new(),
        };
        state.remember(7, result.clone());
        assert_eq!(state.get(7, "op-1"), Some(result));
        state.reset_for_generation(8);
        assert!(state.get(7, "op-1").is_none());
    }
}
