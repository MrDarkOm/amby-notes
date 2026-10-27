//! Full, external pre-sync backups for a vault.
//!
//! The implementation is intentionally pending the frozen tests-first contract in
//! `backup_tests.rs`.

use std::path::Path;

use super::types::SyncError;

/// Ensure a complete external backup exists before sync is enabled.
pub fn ensure(_vault: &Path) -> Result<String, SyncError> {
    Err(SyncError::new("storage_error"))
}

/// Return the backup root from a valid local receipt, without rehashing its files.
pub fn read_path(_vault: &Path) -> Option<String> {
    None
}

/// Create a backup using `parent` as the containing directory (test seam for preflight).
pub(crate) fn create_at(_vault: &Path, _parent: &Path) -> Result<String, SyncError> {
    Err(SyncError::new("storage_error"))
}

#[cfg(test)]
pub(crate) fn create_with_hook(
    _vault: &Path,
    _parent: &Path,
    _before_verify: impl FnOnce() -> Result<(), SyncError>,
) -> Result<String, SyncError> {
    Err(SyncError::new("storage_error"))
}
