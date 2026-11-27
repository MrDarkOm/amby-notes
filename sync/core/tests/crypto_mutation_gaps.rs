//! Tests added after the mutation check of stage Э1 (docs/sync-plan.md, раздел 6, шаг 7).
//!
//! Written by the reviewer, not by the author of the code. Each test is red on the mutant that
//! survived the original suite: hand-written `Debug` of the secrets replaced by an empty or a
//! derived one, and `size > 2^62` in `open_body` replaced by `size >= 2^62`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::crypto::account::{create_account, Argon2Params};
use amby_sync_core::crypto::body::{open_body, seal_body};
use amby_sync_core::crypto::keys::{AccountKey, AuthKey, BodyId, Kek, MasterKey, SpaceKey};
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use amby_sync_core::crypto::CryptoError;

/// 0xAB = 171: a derived `Debug` would print `[171, 171, …]`.
const SECRET: [u8; 32] = [0xAB; 32];

fn assert_redacted(text: &str) {
    assert!(text.contains("redacted"), "no redaction marker: {text}");
    assert!(!text.contains("171"), "key bytes in decimal: {text}");
    assert!(
        !text.to_ascii_lowercase().contains("abab"),
        "key bytes in hex: {text}"
    );
}

#[test]
fn secrets_never_show_in_debug_output() {
    // Р6, О1: keys end up in logs and panic messages only as a redaction marker
    assert_redacted(&format!("{:?}", MasterKey::from_bytes(SECRET)));
    assert_redacted(&format!("{:?}", AuthKey::from_bytes(SECRET)));
    assert_redacted(&format!("{:?}", Kek::from_bytes(SECRET)));
    assert_redacted(&format!("{:?}", AccountKey::from_bytes(SECRET)));
    assert_redacted(&format!("{:?}", SpaceKey::from_bytes(SECRET, 1)));
    assert_redacted(&format!("{:?}", RecoveryCode::from_bytes(SECRET)));
}

#[test]
fn a_new_account_does_not_print_its_recovery_code() {
    // Р5, Р6, О3: the structure returned to the app holds the code; its Debug must not reveal it
    let account = create_account(
        "correct horse battery staple",
        &Argon2Params::V1_DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    let text = format!("{account:?}");
    let shown = account.recovery_code.to_display();
    for group in shown.split('-') {
        assert!(
            !text.contains(group),
            "recovery code group {group} in {text}"
        );
    }
    // a derived Debug would print the raw bytes as `[b0, b1, …]`
    let raw = format!("{:?}", account.recovery_code.as_bytes());
    assert!(
        !text.contains(&raw[1..raw.len() - 1]),
        "recovery code bytes in {text}"
    );
    assert!(text.contains("RecoveryCode([redacted])"), "{text}");
}

#[test]
fn a_size_of_exactly_2_pow_62_is_accepted_as_a_size() {
    // Р6, С5, Ф26: 2^62 itself is allowed, so a real body opened with that claimed size fails on
    // its length, not as too large; one more is too large
    let vk = SpaceKey::from_bytes([0x11; 32], 1);
    let body_id = BodyId::from_bytes([0x22; 16]);
    let content = b"small body".to_vec();
    let sealed = seal_body(&vk, &body_id, &content, &mut OsRandom).unwrap();
    let hash = blake3_hash(&content);
    assert_eq!(
        open_body(&vk, &body_id, content.len() as u64, &hash, &sealed).unwrap(),
        content,
        "control"
    );
    assert_eq!(
        open_body(&vk, &body_id, 1 << 62, &hash, &sealed),
        Err(CryptoError::LengthMismatch)
    );
    assert_eq!(
        open_body(&vk, &body_id, (1 << 62) + 1, &hash, &sealed),
        Err(CryptoError::SizeTooLarge)
    );
}
