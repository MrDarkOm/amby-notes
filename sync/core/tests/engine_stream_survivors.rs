//! Tests written for the mutants of `engine/stream.rs` that survived the trial run of the gates
//! (docs/Road/sync-gates-survivors-report.md): reading a source that fails, and the exact reads
//! of the preamble. A mutant of `read_up_to` makes it ask again for ever, so every run is bounded
//! in time: a loop that does not end is a red test here, not a timeout of the whole run.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Cursor, Read};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    (0..len).map(|i| ((i * 31 + 7) % 256) as u8).collect()
}

/// Opens `source` as the body of `plain` and gives the result back, or panics if it does not end.
fn run_bounded(
    plain: Vec<u8>,
    source: impl Read + Send + 'static,
) -> (Result<(), StreamError>, Vec<u8>) {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut source = source;
        let mut out = Vec::new();
        let result = open_body_stream(
            &vk(),
            &body_id(),
            plain.len() as u64,
            &blake3_hash(&plain),
            &mut source,
            &mut out,
        );
        let _ = tx.send((result, out));
    });
    rx.recv_timeout(Duration::from_secs(20))
        .expect("the stream was not opened in time: an endless loop")
}

fn sealed(plain: &[u8]) -> Vec<u8> {
    seal_body(&vk(), &body_id(), plain, &mut OsRandom).unwrap()
}

/// Gives the bytes, then fails for ever with `kind`.
struct FailsAfter {
    inner: Cursor<Vec<u8>>,
    kind: std::io::ErrorKind,
}

impl Read for FailsAfter {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n == 0 {
            return Err(std::io::Error::from(self.kind));
        }
        Ok(n)
    }
}

#[test]
fn a_source_that_fails_for_ever_is_a_read_error_not_an_endless_wait() {
    let plain = content(150_000);
    let bytes = sealed(&plain);
    for cut in [0, 5, 20, 40_000, bytes.len() - 1] {
        let source = FailsAfter {
            inner: Cursor::new(bytes[..cut].to_vec()),
            kind: std::io::ErrorKind::BrokenPipe,
        };
        let (result, _) = run_bounded(plain.clone(), source);
        assert!(
            matches!(result, Err(StreamError::Read(ref e)) if e.kind() == std::io::ErrorKind::BrokenPipe),
            "cut at {cut}: {result:?}"
        );
    }
}

/// Answers `Interrupted` once before every real read.
struct InterruptedFirst {
    inner: Cursor<Vec<u8>>,
    pending: bool,
}

impl Read for InterruptedFirst {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.pending = !self.pending;
        if self.pending {
            return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
        }
        self.inner.read(buf)
    }
}

#[test]
fn an_interrupted_read_is_not_an_error() {
    let plain = content(70_000);
    let source = InterruptedFirst {
        inner: Cursor::new(sealed(&plain)),
        pending: false,
    };
    let (result, out) = run_bounded(plain.clone(), source);
    result.unwrap();
    assert_eq!(out, plain);
}

/// Counts the reads into an empty buffer.
struct Counting {
    inner: Cursor<Vec<u8>>,
    empty_reads: Arc<Mutex<usize>>,
}

impl Read for Counting {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            *self.empty_reads.lock().unwrap() += 1;
        }
        self.inner.read(buf)
    }
}

#[test]
fn a_full_buffer_is_not_read_into_again() {
    // The preamble and every chunk are read to the byte; the source is never asked to read into
    // nothing.
    for len in [0, 10, 65_519, 65_520, 65_521, 140_000] {
        let plain = content(len);
        let empty_reads = Arc::new(Mutex::new(0));
        let source = Counting {
            inner: Cursor::new(sealed(&plain)),
            empty_reads: empty_reads.clone(),
        };
        let (result, out) = run_bounded(plain.clone(), source);
        result.unwrap();
        assert_eq!(out, plain);
        assert_eq!(*empty_reads.lock().unwrap(), 0, "length {len}");
    }
}
