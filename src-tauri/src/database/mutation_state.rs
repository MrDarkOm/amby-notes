use std::collections::HashMap;
use std::sync::Mutex;

use super::mutations::{DatabaseValueBatchRequest, DatabaseValueBatchResult};

#[derive(Clone)]
struct CompletedMutation {
    request: DatabaseValueBatchRequest,
    result: DatabaseValueBatchResult,
}

#[derive(Default)]
pub struct DatabaseMutationState {
    completed: Mutex<HashMap<(u64, String), CompletedMutation>>,
}

impl DatabaseMutationState {
    pub fn get(
        &self,
        generation: u64,
        request: &DatabaseValueBatchRequest,
    ) -> Result<Option<DatabaseValueBatchResult>, String> {
        let completed = self
            .completed
            .lock()
            .expect("database mutation state poisoned")
            .get(&(generation, request.operation_id.clone()))
            .cloned();
        match completed {
            Some(completed) if completed.request != *request => {
                Err("operationId was already used for a different batch".to_owned())
            }
            Some(completed) => Ok(Some(completed.result)),
            None => Ok(None),
        }
    }

    pub fn remember(
        &self,
        generation: u64,
        request: DatabaseValueBatchRequest,
        result: DatabaseValueBatchResult,
    ) {
        self.completed
            .lock()
            .expect("database mutation state poisoned")
            .insert(
                (generation, result.operation_id.clone()),
                CompletedMutation { request, result },
            );
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
    fn repeated_operation_id_returns_only_for_the_same_request() {
        let state = DatabaseMutationState::default();
        let request = DatabaseValueBatchRequest {
            expected_generation: 7,
            database_id: "db-1".to_owned(),
            operation_id: "op-1".to_owned(),
            cells: Vec::new(),
        };
        let result = DatabaseValueBatchResult {
            operation_id: "op-1".to_owned(),
            database_id: "db-1".to_owned(),
            revisions: Vec::new(),
            warnings: Vec::new(),
        };
        state.remember(7, request.clone(), result.clone());
        assert_eq!(state.get(7, &request), Ok(Some(result)));
        let mut different = request.clone();
        different.database_id = "db-2".to_owned();
        assert!(state.get(7, &different).is_err());
        state.reset_for_generation(8);
        assert_eq!(state.get(7, &request), Ok(None));
    }
}
