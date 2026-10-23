//! The gate before real notes (decision of the owner, 22 October 2026; docs/sync-plan.md, stage
//! Э4): until one run of the mutation testing of the engine and a long run of the simulation have
//! passed, synchronisation may be switched on only for a vault the person explicitly marked as a
//! test vault. When the owner confirms both runs, [`GATES_PASSED`] becomes `true` in its own
//! commit.

use crate::sync::types::SyncError;

/// Both runs of the gate are done and confirmed by the owner. Not yet.
pub const GATES_PASSED: bool = false;

/// May sync be switched on for a vault marked (or not) as a test vault? `test_vault_required` when
/// the gate is closed and the vault is not marked.
pub fn check_gate(test_vault: bool) -> Result<(), SyncError> {
    check_gate_with(GATES_PASSED, test_vault)
}

/// The same with the state of the gate given (for tests).
pub fn check_gate_with(gates_passed: bool, test_vault: bool) -> Result<(), SyncError> {
    if gates_passed || test_vault {
        Ok(())
    } else {
        Err(SyncError::new("test_vault_required"))
    }
}

/// Is the gate closed for a vault that is not marked as a test vault?
pub fn gate_closed() -> bool {
    !GATES_PASSED
}
