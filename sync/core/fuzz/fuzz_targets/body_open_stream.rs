//! Fuzzes the streaming open of a body coming from the server (docs/sync-plan.md, Р6, С5, Ф24,
//! Д68). Input: the claimed size (8 bytes little-endian), the claimed hash (32 bytes), then the
//! sealed body. The seeds in `seeds/body_open_stream/` are real bodies with the right size and
//! hash, so the fuzzer starts inside the chunk loop instead of at the magic string (the older
//! `body_open` target almost never got that far). The stream must never panic, must agree with
//! `open_body` of stage Э1 on every input, and never write more than one chunk at a time.
#![no_main]

use std::io::{Cursor, Write};

use amby_sync_core::crypto::body::open_body;
use amby_sync_core::crypto::keys::{BodyId, SpaceKey};
use amby_sync_core::engine::stream::{open_body_stream, StreamError};
use libfuzzer_sys::fuzz_target;

struct Collect {
    bytes: Vec<u8>,
}

impl Write for Collect {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        assert!(buf.len() <= 65_536, "a write longer than one chunk");
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 40 {
        return;
    }
    let vk = SpaceKey::from_bytes([0x21; 32], 1);
    let body_id = BodyId::from_bytes([0x33; 16]);
    let size = u64::from_le_bytes(data[..8].try_into().unwrap());
    let hash: [u8; 32] = data[8..40].try_into().unwrap();
    let sealed = &data[40..];
    let mut sink = Collect { bytes: Vec::new() };
    let streamed = open_body_stream(&vk, &body_id, size, &hash, &mut Cursor::new(sealed), &mut sink);
    match (open_body(&vk, &body_id, size, &hash, sealed), streamed) {
        (Ok(content), Ok(())) => assert_eq!(content, sink.bytes),
        (Err(expected), Err(StreamError::Crypto(got))) => assert_eq!(expected, got),
        (a, b) => panic!("open_body says {a:?}, the stream says {b:?}"),
    }
});
