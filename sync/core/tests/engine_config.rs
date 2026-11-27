//! Default engine policy owned by the local-first note workspace.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::crypto::keys::{SpaceId, SpaceKey};
use amby_sync_core::engine::EngineConfig;

#[test]
fn default_file_limit_is_thirty_megabytes() {
    // Д71: Amby is a notes workspace, so the default plaintext file limit is 30,000,000 bytes.
    let config = EngineConfig::new(
        SpaceId::from_bytes([0; 16]),
        SpaceKey::from_bytes([0; 32], 1),
    );
    assert_eq!(config.max_file_bytes, 30_000_000);
}
