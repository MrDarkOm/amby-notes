//! Audit record of the completed pre-release checks (docs/sync-plan.md, stage Э4).
//! The helpers retain compatibility with historical state; the product no longer asks
//! the person to classify a vault before enabling sync.

use crate::sync::types::SyncError;

/// Confirmed by the owner on 27 October 2026: run 40383686825 (all 64 mutation
/// shards, explained survivors, all 64,000 scenarios and simulator self-checks).
pub const GATES_PASSED: bool = true;

/// Compatibility check against the confirmed gate state of this build.
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

/// Legacy gate status, false in the confirmed build.
pub fn gate_closed() -> bool {
    !GATES_PASSED
}
