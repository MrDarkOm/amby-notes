//! The encrypted item body, STREAM mode (Р6, О1, О2, О7, С5): byte-exact content, hidden size,
//! and rejection of anything changed, reordered, truncated or mislabelled. Exact bytes are in
//! `crypto_reference_vectors.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_core::crypto::body::{open_body, seal_body, CHUNK_SIZE, PREAMBLE_LEN};
use amby_sync_core::crypto::keys::{BodyId, SpaceKey};
use amby_sync_core::crypto::padme::{padme, sealed_body_len};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::crypto::CryptoError;
use common::{pattern, SeedRandom};
use proptest::prelude::*;

fn vk() -> SpaceKey {
    SpaceKey::from_bytes([0x21; 32], 1)
}

fn body_id() -> BodyId {
    BodyId::from_bytes([0x33; 16])
}

fn seal(content: &[u8]) -> Vec<u8> {
    seal_body(&vk(), &body_id(), content, &mut OsRandom).unwrap()
}

fn open(content: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    open_body(
        &vk(),
        &body_id(),
        content.len() as u64,
        &blake3_hash(content),
        sealed,
    )
}

/// Sealed length of one full chunk: plaintext plus the 16-byte tag.
const FULL: usize = CHUNK_SIZE + 16;

#[test]
fn content_comes_back_byte_for_byte() {
    // О7, Р6: BOM, CRLF, trailing spaces, binary data, empty and chunk-boundary sizes
    let bom_crlf =
        b"\xef\xbb\xbf# Title\r\n\r\nLine with trailing space \r\nlast line, no newline".to_vec();
    let mut samples = vec![bom_crlf, vec![], vec![0], vec![0xFF; 3]];
    for size in [
        1,
        2,
        255,
        1000,
        CHUNK_SIZE - 1,
        CHUNK_SIZE,
        CHUNK_SIZE + 1,
        2 * CHUNK_SIZE,
        2 * CHUNK_SIZE + 1,
        200_000,
    ] {
        samples.push(pattern(size));
    }
    for content in samples {
        let sealed = seal(&content);
        assert_eq!(
            open(&content, &sealed).unwrap(),
            content,
            "size {}",
            content.len()
        );
    }
}

#[test]
fn the_sealed_length_follows_the_padme_layout() {
    // Р6, О2, Ф21, Ф26: 32 + P + 16 per chunk, with at least one chunk even for an empty file
    assert_eq!(seal(&[]).len(), 48);
    for size in [0usize, 1, 100, 1000, 65_535, 65_536, 65_537, 140_000] {
        let content = pattern(size);
        let padded = padme(size as u64);
        let chunks = (padded as usize).div_ceil(CHUNK_SIZE).max(1);
        let expected = PREAMBLE_LEN + padded as usize + 16 * chunks;
        assert_eq!(seal(&content).len(), expected, "size {size}");
        assert_eq!(sealed_body_len(size as u64), expected as u64, "size {size}");
    }
}

#[test]
fn files_of_similar_size_look_alike_to_the_server() {
    // О2, Р6: sizes in one Padmé class give equal sealed lengths; another class differs
    for (a, b) in [(1000usize, 1023usize), (1025, 1087), (65_537, 67_000)] {
        assert_eq!(
            padme(a as u64),
            padme(b as u64),
            "the sample sizes share a class"
        );
        assert_eq!(
            seal(&pattern(a)).len(),
            seal(&pattern(b)).len(),
            "{a} vs {b}"
        );
    }
    assert_ne!(seal(&pattern(1000)).len(), seal(&pattern(2000)).len());
}

#[test]
fn the_server_cannot_read_the_content() {
    // О1, Р6: neither text nor runs of zeros (the padding!) show through
    let marker = b"TOP-SECRET-MARKER-0123456789-abcdef";
    let mut content = marker.to_vec();
    content.extend(std::iter::repeat_n(b'.', 3000));
    let sealed = seal(&content);
    assert_eq!(open(&content, &sealed).unwrap(), content, "control");
    assert!(!sealed.windows(8).any(|window| window == &marker[..8]));
    assert!(!sealed.windows(16).any(|window| window == [b'.'; 16]));

    let zeros = vec![0u8; 4000];
    let sealed_zeros = seal(&zeros);
    assert_eq!(open(&zeros, &sealed_zeros).unwrap(), zeros, "control");
    assert!(
        !sealed_zeros.windows(16).any(|window| window == [0u8; 16]),
        "padding must not show as zeros"
    );
}

#[test]
fn sealing_twice_gives_different_bodies() {
    // Р6, Ф23: a fresh nonce prefix every time
    let content = pattern(5000);
    let first = seal(&content);
    let second = seal(&content);
    assert_ne!(first, second);
    assert_ne!(first[13..32], second[13..32], "the nonce prefix differs");
    assert_eq!(open(&content, &first).unwrap(), content);
    assert_eq!(open(&content, &second).unwrap(), content);
}

#[test]
fn the_body_starts_with_the_documented_preamble() {
    // Р6, Ф23: "AMBYBODY" ‖ 0x01 ‖ epoch (4, big-endian) ‖ nonce prefix (19)
    let sealed = seal(&pattern(10));
    assert_eq!(&sealed[..8], b"AMBYBODY");
    assert_eq!(sealed[8], 1);
    assert_eq!(&sealed[9..13], &1u32.to_be_bytes());
    let second_epoch = SpaceKey::from_bytes([0x21; 32], 0x0102_0304);
    let other = seal_body(&second_epoch, &body_id(), &pattern(10), &mut OsRandom).unwrap();
    assert_eq!(&other[9..13], &[1, 2, 3, 4]);
}

#[test]
fn another_body_id_key_or_epoch_does_not_open_it() {
    // Р6, С5, Ф20, Ф25: the key is bound to body_id and VK; the epoch must match
    let content = pattern(3000);
    let sealed = seal(&content);
    let hash = blake3_hash(&content);
    assert!(
        open_body(&vk(), &body_id(), 3000, &hash, &sealed).is_ok(),
        "control"
    );
    let other_body = BodyId::from_bytes([0x34; 16]);
    assert_eq!(
        open_body(&vk(), &other_body, 3000, &hash, &sealed),
        Err(CryptoError::Authentication)
    );
    let other_key = SpaceKey::from_bytes([0x22; 32], 1);
    assert_eq!(
        open_body(&other_key, &body_id(), 3000, &hash, &sealed),
        Err(CryptoError::Authentication)
    );
    let other_epoch = SpaceKey::from_bytes([0x21; 32], 2);
    assert_eq!(
        open_body(&other_epoch, &body_id(), 3000, &hash, &sealed),
        Err(CryptoError::EpochMismatch)
    );
}

#[test]
fn a_body_of_another_item_does_not_pass_for_this_one() {
    // Р6, С5: the server swaps bodies between items; header data of one with the body of the other
    let a = pattern(2000);
    let b: Vec<u8> = pattern(2000).into_iter().rev().collect();
    let id_a = BodyId::from_bytes([1; 16]);
    let id_b = BodyId::from_bytes([2; 16]);
    let sealed_a = seal_body(&vk(), &id_a, &a, &mut OsRandom).unwrap();
    let sealed_b = seal_body(&vk(), &id_b, &b, &mut OsRandom).unwrap();
    assert_eq!(
        open_body(&vk(), &id_a, 2000, &blake3_hash(&a), &sealed_a).unwrap(),
        a
    );
    assert_eq!(
        open_body(&vk(), &id_b, 2000, &blake3_hash(&b), &sealed_b).unwrap(),
        b
    );
    assert!(open_body(&vk(), &id_a, 2000, &blake3_hash(&a), &sealed_b).is_err());
    assert!(open_body(&vk(), &id_b, 2000, &blake3_hash(&b), &sealed_a).is_err());
}

#[test]
fn every_changed_byte_of_a_small_body_is_rejected() {
    // Р6, С5, Ф23–Ф25: magic, version, epoch, prefix, ciphertext and tag are all checked
    let content = pattern(1000);
    let sealed = seal(&content);
    assert_eq!(open(&content, &sealed).unwrap(), content, "control");
    for position in 0..sealed.len() {
        let mut changed = sealed.clone();
        changed[position] ^= 0x01;
        let error = open(&content, &changed).unwrap_err();
        match position {
            0..=7 => assert!(
                matches!(error, CryptoError::Malformed(_)),
                "byte {position}: {error:?}"
            ),
            8 => assert!(
                matches!(error, CryptoError::UnsupportedVersion(_)),
                "byte {position}: {error:?}"
            ),
            9..=12 => assert_eq!(error, CryptoError::EpochMismatch, "byte {position}"),
            _ => assert_eq!(error, CryptoError::Authentication, "byte {position}"),
        }
    }
}

#[test]
fn a_changed_byte_in_any_chunk_of_a_large_body_is_rejected() {
    // Р6, С5, Ф21: first and last byte of every chunk, including the last short one
    let content = pattern(2 * CHUNK_SIZE + 5000);
    let sealed = seal(&content);
    assert_eq!(open(&content, &sealed).unwrap(), content, "control");
    let first_chunk = PREAMBLE_LEN;
    let second_chunk = first_chunk + FULL;
    let third_chunk = second_chunk + FULL;
    for position in [
        first_chunk,
        second_chunk - 1,
        second_chunk,
        third_chunk - 1,
        third_chunk,
        sealed.len() - 1,
    ] {
        let mut changed = sealed.clone();
        changed[position] ^= 0x80;
        assert_eq!(
            open(&content, &changed).unwrap_err(),
            CryptoError::Authentication,
            "byte {position}"
        );
    }
}

#[test]
fn chunks_cannot_be_reordered_dropped_duplicated_or_cut_off() {
    // Р6, С5, Ф23: the counter and the last-chunk flag are part of the nonce
    let content = pattern(3 * CHUNK_SIZE);
    let sealed = seal(&content);
    assert_eq!(open(&content, &sealed).unwrap(), content, "control");
    let chunk = |n: usize| PREAMBLE_LEN + n * FULL..PREAMBLE_LEN + (n + 1) * FULL;
    let preamble = &sealed[..PREAMBLE_LEN];
    assert_eq!(
        sealed.len(),
        PREAMBLE_LEN + 3 * FULL,
        "three full chunks and no empty extra one"
    );

    let join = |parts: &[&[u8]]| -> Vec<u8> { parts.concat() };
    let swapped = join(&[
        preamble,
        &sealed[chunk(1)],
        &sealed[chunk(0)],
        &sealed[chunk(2)],
    ]);
    assert_eq!(
        open(&content, &swapped),
        Err(CryptoError::Authentication),
        "swapped neighbours"
    );
    let dropped_first = join(&[preamble, &sealed[chunk(1)], &sealed[chunk(2)]]);
    assert!(
        open(&content, &dropped_first).is_err(),
        "first chunk dropped"
    );
    let dropped_middle = join(&[preamble, &sealed[chunk(0)], &sealed[chunk(2)]]);
    assert!(
        open(&content, &dropped_middle).is_err(),
        "middle chunk dropped"
    );
    let duplicated = join(&[
        preamble,
        &sealed[chunk(0)],
        &sealed[chunk(0)],
        &sealed[chunk(1)],
        &sealed[chunk(2)],
    ]);
    assert!(open(&content, &duplicated).is_err(), "chunk repeated");
    let without_last = join(&[preamble, &sealed[chunk(0)], &sealed[chunk(1)]]);
    assert!(
        open(&content, &without_last).is_err(),
        "cut off at a chunk boundary"
    );
    let mut with_tail = sealed.clone();
    with_tail.extend_from_slice(&[0u8; 16]);
    assert!(open(&content, &with_tail).is_err(), "bytes appended");
}

#[test]
fn a_truncated_body_never_opens() {
    // Р6, С5, С1: a cut-off download is an error at every length (and never a panic)
    let content = pattern(70_000);
    let sealed = seal(&content);
    assert_eq!(open(&content, &sealed).unwrap(), content, "control");
    let mut lengths: Vec<usize> = (0..=PREAMBLE_LEN + 20).collect();
    lengths.extend([
        sealed.len() / 2,
        PREAMBLE_LEN + FULL - 1,
        PREAMBLE_LEN + FULL,
        PREAMBLE_LEN + FULL + 15,
        sealed.len() - 17,
        sealed.len() - 1,
    ]);
    for length in lengths {
        assert!(
            open(&content, &sealed[..length]).is_err(),
            "length {length}"
        );
    }
}

#[test]
fn the_header_values_are_checked_against_the_decrypted_body() {
    // Р6, Р2, С5, Ф22: size and hash of the header must agree with the body
    let content = pattern(1000);
    let sealed = seal(&content);
    let hash = blake3_hash(&content);
    assert!(
        open_body(&vk(), &body_id(), 1000, &hash, &sealed).is_ok(),
        "control"
    );
    // wrong hash
    assert_eq!(
        open_body(&vk(), &body_id(), 1000, &blake3_hash(b"other"), &sealed),
        Err(CryptoError::HashMismatch)
    );
    // size 1001 is in the same Padmé class (1024): length fits, the hash does not
    assert_eq!(padme(1001), padme(1000));
    assert_eq!(
        open_body(&vk(), &body_id(), 1001, &hash, &sealed),
        Err(CryptoError::HashMismatch)
    );
    // another class: the length does not fit
    assert_ne!(padme(1100), padme(1000));
    assert_eq!(
        open_body(&vk(), &body_id(), 1100, &hash, &sealed),
        Err(CryptoError::LengthMismatch)
    );
    assert_eq!(
        open_body(&vk(), &body_id(), 0, &hash, &sealed),
        Err(CryptoError::LengthMismatch)
    );
}

#[test]
fn a_larger_file_keeps_its_exact_size() {
    // О7, Р6: the padding is removed and the result is exactly `size` bytes
    for size in [1000usize, 65_537, 70_001] {
        let content = pattern(size);
        let opened = open(&content, &seal(&content)).unwrap();
        assert_eq!(opened.len(), size);
        assert!(
            padme(size as u64) > size as u64,
            "the sample size has padding to remove"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn any_content_roundtrips(content in proptest::collection::vec(any::<u8>(), 0..150_000), seed in any::<u64>()) {
        // О7, Р6: arbitrary bytes come back unchanged; the sealed length depends on the size only
        let sealed = seal_body(&vk(), &body_id(), &content, &mut SeedRandom(seed)).unwrap();
        prop_assert_eq!(sealed.len() as u64, sealed_body_len(content.len() as u64));
        prop_assert_eq!(open(&content, &sealed).unwrap(), content);
    }

    #[test]
    fn any_flipped_byte_is_rejected(
        content in proptest::collection::vec(any::<u8>(), 0..3000),
        position in any::<usize>(),
        mask in 1u8..=255,
        seed in any::<u64>(),
    ) {
        // Р6, С5: tampering anywhere never yields content
        let sealed = seal_body(&vk(), &body_id(), &content, &mut SeedRandom(seed)).unwrap();
        prop_assert!(open(&content, &sealed).is_ok());
        let mut changed = sealed.clone();
        let at = position % changed.len();
        changed[at] ^= mask;
        prop_assert!(open(&content, &changed).is_err());
    }

    #[test]
    fn arbitrary_bytes_are_never_a_body(bytes in proptest::collection::vec(any::<u8>(), 0..2000), size in any::<u64>()) {
        // Р6, С5: what comes from the server is never trusted; no panic, no content
        prop_assert!(open_body(&vk(), &body_id(), size, &[0u8; 32], &bytes).is_err());
    }
}
