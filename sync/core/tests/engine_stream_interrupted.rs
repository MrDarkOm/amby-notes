//! Opening a body as a stream when the source answers `Interrupted` now and then (carried over
//! from Э3, review of 23.10: the one surviving mutant of `stream.rs`, "retry a read after
//! `ErrorKind::Interrupted`", had no test). A signal that interrupts a read is not a broken
//! connection: the read is repeated and the content comes out whole (Ф24, Д68, С1).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Cursor, Read};

use amby_sync_core::crypto::body::seal_body;
use amby_sync_core::crypto::keys::{BodyId, SpaceKey};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::stream::{open_body_stream, StreamError};

fn vk() -> SpaceKey {
    SpaceKey::from_bytes([0x21; 32], 1)
}

fn body_id() -> BodyId {
    BodyId::from_bytes([0x33; 16])
}

fn content(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| ((i * 31 + (i >> 8) * 7 + 7) % 256) as u8)
        .collect()
}

/// Answers `Interrupted` on every `every`-th call and serves at most `piece` bytes otherwise.
struct Flaky {
    inner: Cursor<Vec<u8>>,
    every: usize,
    piece: usize,
    calls: usize,
    interruptions: usize,
}

impl Read for Flaky {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.calls += 1;
        if self.calls % self.every == 0 {
            self.interruptions += 1;
            return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
        }
        let take = buf.len().min(self.piece);
        self.inner.read(&mut buf[..take])
    }
}

fn run(len: usize, every: usize, piece: usize) -> (Result<(), StreamError>, Vec<u8>, usize) {
    let plain = content(len);
    let sealed = seal_body(&vk(), &body_id(), &plain, &mut OsRandom).unwrap();
    let mut source = Flaky {
        inner: Cursor::new(sealed),
        every,
        piece,
        calls: 0,
        interruptions: 0,
    };
    let mut out = Vec::new();
    let result = open_body_stream(
        &vk(),
        &body_id(),
        len as u64,
        &blake3_hash(&plain),
        &mut source,
        &mut out,
    );
    (result, out, source.interruptions)
}

#[test]
fn an_interrupted_read_is_repeated_and_the_content_arrives_whole() {
    // Several chunks, an interruption every third call, short reads in between.
    let len = 200_000;
    let (result, out, interruptions) = run(len, 3, 10_000);
    assert!(
        interruptions > 5,
        "the source did interrupt: {interruptions}"
    );
    result.unwrap();
    assert_eq!(out, content(len));
}

#[test]
fn an_interruption_inside_the_preamble_is_repeated_too() {
    // The preamble is read before any chunk: the first calls are interrupted as well.
    let (result, out, interruptions) = run(100, 2, 3);
    assert!(interruptions > 0);
    result.unwrap();
    assert_eq!(out, content(100));
}

#[test]
fn a_real_read_error_is_still_a_broken_connection() {
    // Only `Interrupted` is repeated; anything else is `StreamError::Read`, not an
    // authentication failure (С1).
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::from(std::io::ErrorKind::ConnectionReset))
        }
    }
    let plain = content(10);
    let mut out = Vec::new();
    let result = open_body_stream(
        &vk(),
        &body_id(),
        10,
        &blake3_hash(&plain),
        &mut Broken,
        &mut out,
    );
    assert!(matches!(result, Err(StreamError::Read(_))), "{result:?}");
}
