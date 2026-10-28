//! Fuzzes everything that parses a header coming from the server (docs/sync-plan.md, Р6, С5, С13):
//! the envelope with a fixed key, the JSON parser, and the epoch reader. It must never panic and,
//! because the key is fixed and the data is arbitrary, must never return a header from an
//! envelope (the tag cannot verify), while the JSON parser may accept valid JSON.
#![no_main]

use amby_sync_core::crypto::header::{header_envelope_epoch, open_header, parse_header_json};
use amby_sync_core::crypto::keys::{ItemId, SpaceId, SpaceKey};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let vk = SpaceKey::from_bytes([0x11; 32], 1);
    let space = SpaceId::from_bytes([0xA1; 16]);
    let item = ItemId::from_bytes([0xB2; 16]);
    let _ = header_envelope_epoch(data);
    let _ = parse_header_json(data);
    assert!(open_header(&vk, &space, &item, 1, data).is_err());
});
