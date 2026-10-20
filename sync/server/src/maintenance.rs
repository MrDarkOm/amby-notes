//! Cleanup (П37): bodies without a commit after 24 hours (П25), old versions and deleted items
//! after 30 days (П35, П36), expired enrolment codes and old attempt counters.

use crate::state::AppState;

/// What one cleanup removed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MaintenanceReport {
    /// Bodies deleted because no commit refers to them (П25).
    pub orphan_blobs: u64,
    /// Versions deleted by age (П35).
    pub versions: u64,
    /// Whole items deleted after their deletion aged out (П36).
    pub items: u64,
}

/// Why a cleanup failed.
#[derive(Debug, thiserror::Error)]
pub enum MaintenanceError {
    /// A stub (stage Э2, step 1).
    #[error("not_implemented: maintenance")]
    NotImplemented,
    /// Anything else.
    #[error("{0}")]
    Other(String),
}

/// One cleanup (П37): idempotent, touches only what is already past its time, reads the time
/// from the clock of `state` only.
pub fn run(_state: &AppState) -> Result<MaintenanceReport, MaintenanceError> {
    Err(MaintenanceError::NotImplemented)
}
