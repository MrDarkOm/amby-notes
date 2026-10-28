//! The gate before real notes (decision of the owner, 22 October 2026): while it is closed, sync
//! may be switched on only for a vault the person explicitly marked as a test vault.

use super::gate::{check_gate_with, gate_closed, GATES_PASSED};

#[test]
fn a_closed_gate_refuses_a_vault_that_is_not_marked_as_a_test_vault() {
    let error = check_gate_with(false, false).unwrap_err();
    assert_eq!(error.code, "test_vault_required");
    assert_eq!(error.retry_after_secs, None);
}

#[test]
fn a_closed_gate_lets_a_marked_test_vault_through() {
    assert!(check_gate_with(false, true).is_ok());
}

#[test]
fn an_open_gate_lets_every_vault_through() {
    assert!(check_gate_with(true, false).is_ok());
    assert!(check_gate_with(true, true).is_ok());
}

#[test]
fn the_real_gate_follows_the_constant() {
    assert_eq!(gate_closed(), !GATES_PASSED);
    assert_eq!(
        super::gate::check_gate(false).is_ok(),
        GATES_PASSED,
        "an unmarked vault passes exactly when the gate is open"
    );
    assert!(super::gate::check_gate(true).is_ok());
}
