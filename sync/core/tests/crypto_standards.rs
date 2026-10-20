//! Primitives against the vectors of the standards (Р6, раздел 6 плана).
//!
//! The expected bytes come from RFC 9106, RFC 5869, the IRTF XChaCha draft, FIPS 180-4 and the
//! official BLAKE3 vectors (`sync/vectors/standards.json`, each group names its source), never
//! from this code. Padmé values follow the paper's algorithm.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_core::crypto::account::Argon2Params;
use amby_sync_core::crypto::padme::{padme, sealed_body_len};
use amby_sync_core::crypto::primitives::{
    argon2id_raw, blake3_hash, hkdf_sha256, sha256, xchacha20poly1305_open, xchacha20poly1305_seal,
    Argon2Input,
};
use amby_sync_core::crypto::CryptoError;
use common::{array_of, bytes_of, number, standard_vectors, text, unhex};
use proptest::prelude::*;

#[test]
fn argon2id_matches_rfc9106_vector() {
    // Р6, Р5: Argon2id v0x13 of RFC 9106 section 5.3 (with secret and associated data)
    let v = &standard_vectors()["argon2id_rfc9106"];
    let byte = |key: &str, len: &str| vec![unhex(text(v, key))[0]; number(v, len) as usize];
    let password = byte("password_byte", "password_len");
    let salt = byte("salt_byte", "salt_len");
    let secret = byte("secret_byte", "secret_len");
    let ad = byte("ad_byte", "ad_len");
    let params = Argon2Params {
        memory_kib: number(v, "memory_kib") as u32,
        iterations: number(v, "iterations") as u32,
        parallelism: number(v, "parallelism") as u32,
    };
    let input = Argon2Input {
        password: &password,
        salt: &salt,
        secret: &secret,
        associated_data: &ad,
    };
    let tag = argon2id_raw(&input, &params, number(v, "tag_len") as usize).unwrap();
    assert_eq!(hex::encode(tag), text(v, "tag"));
}

#[test]
fn hkdf_sha256_matches_rfc5869_vectors() {
    // Р5, Р6: HKDF with SHA-256, appendix A.1–A.3 of RFC 5869 (A.3 has an empty salt: Ф9)
    for case in standard_vectors()["hkdf_sha256_rfc5869"]["cases"]
        .as_array()
        .unwrap()
    {
        let okm = hkdf_sha256(
            &common::bytes_of(case, "salt"),
            &bytes_of(case, "ikm"),
            &bytes_of(case, "info"),
            number(case, "len") as usize,
        )
        .unwrap();
        assert_eq!(
            hex::encode(okm),
            text(case, "okm"),
            "case {}",
            text(case, "name")
        );
    }
}

#[test]
fn hkdf_sha256_refuses_output_longer_than_the_rfc_allows() {
    // Р6: RFC 5869 limits the output to 255 blocks of the hash
    let too_long = 255 * 32 + 1;
    assert!(hkdf_sha256(b"", &[1u8; 32], b"info", 32).is_ok());
    assert!(hkdf_sha256(b"", &[1u8; 32], b"info", too_long).is_err());
}

#[test]
fn xchacha20poly1305_matches_irtf_draft_vector() {
    // Р6: draft-irtf-cfrg-xchacha-03, appendix A.3.1; the sealed form is ciphertext ‖ tag
    let v = &standard_vectors()["xchacha20poly1305_irtf"];
    let key = array_of::<32>(v, "key");
    let nonce = array_of::<24>(v, "nonce");
    let aad = bytes_of(v, "aad");
    let plaintext = bytes_of(v, "plaintext");
    let expected = format!("{}{}", text(v, "ciphertext"), text(v, "tag"));

    let sealed = xchacha20poly1305_seal(&key, &nonce, &aad, &plaintext);
    assert_eq!(hex::encode(&sealed), expected);
    assert_eq!(
        xchacha20poly1305_open(&key, &nonce, &aad, &sealed).unwrap(),
        plaintext
    );
}

#[test]
fn xchacha20poly1305_rejects_any_change_of_key_nonce_aad_or_data() {
    // Р6, С5: authentication covers key, nonce, AAD, ciphertext and tag
    let v = &standard_vectors()["xchacha20poly1305_irtf"];
    let key = array_of::<32>(v, "key");
    let nonce = array_of::<24>(v, "nonce");
    let aad = bytes_of(v, "aad");
    let sealed = xchacha20poly1305_seal(&key, &nonce, &aad, &bytes_of(v, "plaintext"));
    // positive control: the untouched input opens
    assert!(xchacha20poly1305_open(&key, &nonce, &aad, &sealed).is_ok());

    let mut other_key = key;
    other_key[0] ^= 1;
    let mut other_nonce = nonce;
    other_nonce[23] ^= 1;
    let mut other_aad = aad.clone();
    other_aad[0] ^= 1;
    assert_eq!(
        xchacha20poly1305_open(&other_key, &nonce, &aad, &sealed),
        Err(CryptoError::Authentication)
    );
    assert_eq!(
        xchacha20poly1305_open(&key, &other_nonce, &aad, &sealed),
        Err(CryptoError::Authentication)
    );
    assert_eq!(
        xchacha20poly1305_open(&key, &nonce, &other_aad, &sealed),
        Err(CryptoError::Authentication)
    );
    for position in 0..sealed.len() {
        let mut changed = sealed.clone();
        changed[position] ^= 0x01;
        assert_eq!(
            xchacha20poly1305_open(&key, &nonce, &aad, &changed),
            Err(CryptoError::Authentication),
            "byte {position}"
        );
    }
    assert!(xchacha20poly1305_open(&key, &nonce, &aad, &sealed[..sealed.len() - 1]).is_err());
}

#[test]
fn blake3_matches_official_vectors() {
    // Р6: BLAKE3 content hash; official vectors, input byte i = i mod 251
    for case in standard_vectors()["blake3_official"]["cases"]
        .as_array()
        .unwrap()
    {
        let len = number(case, "input_len") as usize;
        let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        assert_eq!(
            hex::encode(blake3_hash(&data)),
            text(case, "hash"),
            "length {len}"
        );
    }
}

#[test]
fn sha256_matches_fips_vectors() {
    // Р5, Ф5: the server stores SHA-256 of the auth keys
    for case in standard_vectors()["sha256_fips180"]["cases"]
        .as_array()
        .unwrap()
    {
        assert_eq!(
            hex::encode(sha256(&bytes_of(case, "input_hex"))),
            text(case, "hash")
        );
    }
}

#[test]
fn padme_matches_the_papers_algorithm() {
    // Р6, Ф26: values computed by hand from algorithm 1 of the Padmé paper
    for case in standard_vectors()["padme"]["cases"].as_array().unwrap() {
        let pair = case.as_array().unwrap();
        let (length, expected) = (pair[0].as_u64().unwrap(), pair[1].as_u64().unwrap());
        assert_eq!(padme(length), expected, "padme({length})");
    }
}

#[test]
fn padme_never_costs_more_than_twelve_percent() {
    // Р6, О2: the size is hidden within Padmé, and the waste is at most 12%
    for length in 2u64..20_000 {
        let padded = padme(length);
        assert!(padded >= length, "padme({length}) = {padded} is smaller");
        assert!(
            (padded - length) * 100 <= length * 12,
            "padme({length}) = {padded} wastes too much"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn padme_is_idempotent_monotone_and_bounded(length in 0u64..(1 << 40)) {
        // Р6, Ф26: padme(padme(L)) = padme(L), L <= padme(L) <= 1.12 L, monotone
        let padded = padme(length);
        prop_assert!(padded >= length);
        prop_assert_eq!(padme(padded), padded);
        prop_assert!(padme(length + 1) >= padded);
        prop_assert!((padded - length) * 100 <= length * 12);
    }

    #[test]
    fn sealed_body_len_follows_the_layout(size in 0u64..(1 << 30)) {
        // Р6, О2, Ф21, Ф26: 32 + P + 16 * max(1, ceil(P / 65536)) with P = padme(size)
        let padded = padme(size);
        let chunks = padded.div_ceil(65_536).max(1);
        prop_assert_eq!(sealed_body_len(size), 32 + padded + 16 * chunks);
    }
}
