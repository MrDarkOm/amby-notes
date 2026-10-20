//! Fuzzes the parser of a body coming from the server (docs/sync-plan.md, Р6, С5, С1): arbitrary
//! bytes with a fixed key. It must never panic and never return content, because no arbitrary
//! input authenticates. The first bytes of the input pick the claimed size.
#![no_main]

use amby_sync_core::crypto::body::open_body;
use amby_sync_core::crypto::keys::{BodyId, SpaceKey};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let vk = SpaceKey::from_bytes([0x21; 32], 1);
    let body_id = BodyId::from_bytes([0x33; 16]);
    let (size_bytes, sealed) = data.split_at(data.len().min(8));
    let mut size = [0u8; 8];
    size[..size_bytes.len()].copy_from_slice(size_bytes);
    assert!(open_body(&vk, &body_id, u64::from_le_bytes(size), &[0u8; 32], sealed).is_err());
});
