//! The memory of a stream open is bounded (Ф24, Д68). The workspace forbids `unsafe`, so there is
//! no counting allocator; the test samples the resident memory of the process (`ps`) while a
//! 48 MiB body goes through. Opening it whole would add about 100 MiB (the padded copy and the
//! content); a stream adds a few chunks. Unix only.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Cursor, Write};
use std::process::Command;

use amby_sync_core::crypto::body::seal_body;
use amby_sync_core::crypto::keys::{BodyId, SpaceKey};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::stream::open_body_stream;

fn rss_kib() -> u64 {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("a number")
}

struct Sampling {
    hasher: blake3::Hasher,
    written: u64,
    writes: u64,
    peak_kib: u64,
}
impl Write for Sampling {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.hasher.update(buf);
        self.written += buf.len() as u64;
        self.writes += 1;
        if self.writes % 48 == 1 {
            self.peak_kib = self.peak_kib.max(rss_kib());
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn opening_a_48_mib_body_adds_only_a_few_mib_of_resident_memory() {
    // Ф24, Д68, Р6: the extra memory does not grow with the size of the file.
    let vk = SpaceKey::from_bytes([0x21; 32], 1);
    let id = BodyId::from_bytes([0x33; 16]);
    let size = 48 * 1024 * 1024;
    let content: Vec<u8> = (0..size)
        .map(|i: usize| ((i * 31 + (i >> 8) * 7 + 7) % 256) as u8)
        .collect();
    let hash = blake3_hash(&content);
    let sealed = seal_body(&vk, &id, &content, &mut OsRandom).unwrap();
    drop(content);
    let mut source = Cursor::new(sealed);
    let before = rss_kib();
    let mut sink = Sampling {
        hasher: blake3::Hasher::new(),
        written: 0,
        writes: 0,
        peak_kib: before,
    };
    open_body_stream(&vk, &id, size as u64, &hash, &mut source, &mut sink).unwrap();
    assert_eq!(sink.written, size as u64);
    assert_eq!(*sink.hasher.finalize().as_bytes(), hash);
    let extra_mib = sink.peak_kib.saturating_sub(before) / 1024;
    assert!(
        extra_mib < 16,
        "the stream open added about {extra_mib} MiB for a 48 MiB body"
    );
}
