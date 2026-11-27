//! The starting corpus of the fuzz target `body_open_stream` (plan Э3, Ф24): real bodies, a few
//! damaged ones, in the input format of the target (size, hash, sealed body). The files are made
//! by the ignored test `write_the_corpus` and committed; the other test checks that each file does
//! what its name says through the streaming open and `open_body`. Red until the stream is written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Cursor;
use std::path::PathBuf;

use amby_sync_core::crypto::body::{open_body, seal_body};
use amby_sync_core::crypto::keys::{BodyId, SpaceKey};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::stream::open_body_stream;

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fuzz/seeds/body_open_stream")
}

fn input(size: u64, hash: [u8; 32], sealed: &[u8]) -> Vec<u8> {
    let mut out = size.to_le_bytes().to_vec();
    out.extend_from_slice(&hash);
    out.extend_from_slice(sealed);
    out
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| ((i * 31 + (i >> 8) * 7 + 7) % 256) as u8)
        .collect()
}

fn corpus() -> Vec<(String, Vec<u8>, bool)> {
    let vk = SpaceKey::from_bytes([0x21; 32], 1);
    let id = BodyId::from_bytes([0x33; 16]);
    let mut files = vec![];
    for size in [
        0usize, 1, 16, 1000, 65_535, 65_536, 65_537, 131_072, 200_000,
    ] {
        let content = pattern(size);
        let sealed = seal_body(&vk, &id, &content, &mut OsRandom).unwrap();
        files.push((
            format!("valid-{size}"),
            input(size as u64, blake3_hash(&content), &sealed),
            true,
        ));
        if size == 200_000 {
            let mut bad = sealed.clone();
            let at = bad.len() - 5;
            bad[at] ^= 1;
            files.push((
                "damaged-last-chunk".into(),
                input(size as u64, blake3_hash(&content), &bad),
                false,
            ));
            let mut wrong_hash = blake3_hash(&content);
            wrong_hash[3] ^= 1;
            files.push((
                "wrong-hash".into(),
                input(size as u64, wrong_hash, &sealed),
                false,
            ));
            files.push((
                "cut".into(),
                input(
                    size as u64,
                    blake3_hash(&content),
                    &sealed[..sealed.len() / 2],
                ),
                false,
            ));
            files.push((
                "wrong-size".into(),
                input(size as u64 + 1, blake3_hash(&content), &sealed),
                false,
            ));
        }
    }
    files
}

#[test]
#[ignore = "writes the corpus files: run once with --ignored and commit the result"]
fn write_the_corpus() {
    std::fs::create_dir_all(corpus_dir()).unwrap();
    for (name, bytes, _) in corpus() {
        std::fs::write(corpus_dir().join(name), bytes).unwrap();
    }
}

#[test]
fn every_corpus_file_is_what_its_name_says() {
    // Ф24, Д68: the seeds are real: valid ones open, damaged ones do not, and the stream and
    // `open_body` agree on all of them.
    let dir = corpus_dir();
    let expected = corpus();
    assert!(dir.is_dir(), "the corpus is missing: run `cargo test -p amby-sync-core --test engine_fuzz_corpus -- --ignored`; fuzz with `cargo +nightly fuzz run body_open_stream -- fuzz/seeds/body_open_stream`");
    let vk = SpaceKey::from_bytes([0x21; 32], 1);
    let id = BodyId::from_bytes([0x33; 16]);
    for (name, _, valid) in expected {
        let data = std::fs::read(dir.join(&name))
            .unwrap_or_else(|_| panic!("corpus file {name} is missing"));
        let size = u64::from_le_bytes(data[..8].try_into().unwrap());
        let hash: [u8; 32] = data[8..40].try_into().unwrap();
        let sealed = &data[40..];
        let mut sink = Vec::new();
        let streamed = open_body_stream(&vk, &id, size, &hash, &mut Cursor::new(sealed), &mut sink);
        let whole = open_body(&vk, &id, size, &hash, sealed);
        assert_eq!(streamed.is_ok(), valid, "{name}");
        assert_eq!(whole.is_ok(), valid, "{name}");
        if valid {
            assert_eq!(whole.unwrap(), sink, "{name}");
        }
    }
}
