//! Names of a device and of a space (Ф34, П12, П20): bytes agree with the independent reference,
//! tampering and a wrong AAD are caught, the length is always 105 bytes.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_core::crypto::keys::{AccountKey, SpaceId};
use amby_sync_core::crypto::name::{
    open_device_name, open_space_name, seal_device_name, seal_space_name, NAME_ENVELOPE_LEN,
    NAME_MAX_BYTES,
};
use amby_sync_core::crypto::primitives::{
    hkdf_sha256, xchacha20poly1305_open, xchacha20poly1305_seal,
};
use amby_sync_core::crypto::CryptoError;
use common::{array_of, error_name, format_vectors, text, unhex, Scripted, SeedRandom};
use proptest::prelude::*;

fn ak() -> AccountKey {
    AccountKey::from_bytes([0x11; 32])
}

fn space() -> SpaceId {
    SpaceId::from_bytes([0x22; 16])
}

fn nonce_stream() -> Scripted {
    Scripted::new((0..24).collect())
}

#[test]
fn device_names_match_the_reference() {
    // О1, О2, Ф34, Ф31: the bytes of the reference, one nonce drawn, nothing else
    for case in format_vectors()["names"]["device"].as_array().unwrap() {
        let account_key = AccountKey::from_bytes(array_of(case, "account_key"));
        let mut rng = Scripted::from_hex(text(case, "random"));
        let sealed = seal_device_name(&account_key, text(case, "plain"), &mut rng).unwrap();
        rng.assert_spent();
        assert_eq!(
            hex::encode(&sealed),
            text(case, "sealed"),
            "{}",
            text(case, "name")
        );
        assert_eq!(sealed.len(), NAME_ENVELOPE_LEN);
        assert_eq!(
            open_device_name(&account_key, &sealed).unwrap(),
            text(case, "plain")
        );
    }
}

#[test]
fn space_names_match_the_reference() {
    // О1, О2, Ф34, Ф31: the same for a space, the AAD carries the space_id
    for case in format_vectors()["names"]["space"].as_array().unwrap() {
        let account_key = AccountKey::from_bytes(array_of(case, "account_key"));
        let space_id = SpaceId::from_bytes(array_of(case, "space_id"));
        let mut rng = Scripted::from_hex(text(case, "random"));
        let sealed =
            seal_space_name(&account_key, &space_id, text(case, "plain"), &mut rng).unwrap();
        rng.assert_spent();
        assert_eq!(
            hex::encode(&sealed),
            text(case, "sealed"),
            "{}",
            text(case, "name")
        );
        assert_eq!(sealed.len(), NAME_ENVELOPE_LEN);
        assert_eq!(
            open_space_name(&account_key, &space_id, &sealed).unwrap(),
            text(case, "plain")
        );
    }
}

#[test]
fn authentic_envelopes_that_are_not_names_are_rejected_like_the_reference_says() {
    // Ф34, Ф4: a zero inside the name, bytes that are not UTF-8 and an unknown version are
    // refused, each with the error the reference expects
    for case in format_vectors()["names"]["negative"].as_array().unwrap() {
        let account_key = AccountKey::from_bytes(array_of(case, "account_key"));
        let space_id = SpaceId::from_bytes(array_of(case, "space_id"));
        let label = text(case, "name");
        let expected = text(case, "error");
        let device = unhex(text(case, "device"));
        let in_space = unhex(text(case, "space"));
        assert_eq!(
            error_name(&open_device_name(&account_key, &device).unwrap_err()),
            expected,
            "device: {label}"
        );
        assert_eq!(
            error_name(&open_space_name(&account_key, &space_id, &in_space).unwrap_err()),
            expected,
            "space: {label}"
        );
    }
}

#[test]
fn the_envelope_is_laid_out_as_the_plan_says() {
    // Ф34: 0x01 ‖ nonce ‖ ciphertext(64) ‖ tag(16); the key is HKDF(AK, name-key), not AK itself;
    // the plaintext is the name padded with zeros to 64 bytes. Opened here with the primitives only.
    let sealed = seal_device_name(&ak(), "Кабинет", &mut nonce_stream()).unwrap();
    assert_eq!(sealed[0], 0x01);
    assert_eq!(&sealed[1..25], &(0..24).collect::<Vec<u8>>()[..]);
    let key: [u8; 32] = hkdf_sha256(&[], ak().as_bytes(), b"amby-sync/name-key/1", 32)
        .unwrap()
        .try_into()
        .unwrap();
    let nonce: [u8; 24] = sealed[1..25].try_into().unwrap();
    let plain =
        xchacha20poly1305_open(&key, &nonce, b"amby-sync/device-name/1", &sealed[25..]).unwrap();
    assert_eq!(plain.len(), 64);
    let name = "Кабинет".as_bytes();
    assert_eq!(&plain[..name.len()], name);
    assert!(plain[name.len()..].iter().all(|&byte| byte == 0));
}

#[test]
fn the_account_key_itself_is_not_the_cipher_key() {
    // Ф34: an envelope sealed straight with AK does not open
    let nonce = [5u8; 24];
    let mut plain = b"direct".to_vec();
    plain.resize(64, 0);
    let mut forged = vec![0x01];
    forged.extend_from_slice(&nonce);
    forged.extend_from_slice(&xchacha20poly1305_seal(
        ak().as_bytes(),
        &nonce,
        b"amby-sync/device-name/1",
        &plain,
    ));
    assert_eq!(forged.len(), NAME_ENVELOPE_LEN);
    assert_eq!(
        open_device_name(&ak(), &forged).unwrap_err(),
        CryptoError::Authentication
    );
}

#[test]
fn every_changed_byte_is_caught() {
    // О1, О2, С5: no byte of an envelope can be changed unnoticed. The version byte is told apart
    // (Ф4); every other byte breaks authentication.
    let device = seal_device_name(&ak(), "Ноутбук", &mut nonce_stream()).unwrap();
    let in_space = seal_space_name(&ak(), &space(), "Ноутбук", &mut nonce_stream()).unwrap();
    for index in 0..NAME_ENVELOPE_LEN {
        let expected = if index == 0 {
            CryptoError::UnsupportedVersion(0x01 ^ 0x80)
        } else {
            CryptoError::Authentication
        };
        let mut changed = device.clone();
        changed[index] ^= 0x80;
        assert_eq!(
            open_device_name(&ak(), &changed).unwrap_err(),
            expected,
            "device, byte {index}"
        );
        let mut changed = in_space.clone();
        changed[index] ^= 0x80;
        assert_eq!(
            open_space_name(&ak(), &space(), &changed).unwrap_err(),
            expected,
            "space, byte {index}"
        );
    }
}

#[test]
fn a_wrong_account_key_does_not_open_a_name() {
    // О1, Ф34: the key of another account reads nothing
    let other = AccountKey::from_bytes([0x33; 32]);
    let device = seal_device_name(&ak(), "Дом", &mut nonce_stream()).unwrap();
    let in_space = seal_space_name(&ak(), &space(), "Дом", &mut nonce_stream()).unwrap();
    assert_eq!(
        open_device_name(&other, &device).unwrap_err(),
        CryptoError::Authentication
    );
    assert_eq!(
        open_space_name(&other, &space(), &in_space).unwrap_err(),
        CryptoError::Authentication
    );
}

#[test]
fn a_name_cannot_be_moved_to_another_place() {
    // Ф34 (AAD): a space name only opens for its own space and not as a device name, and a device
    // name does not open as a space name
    let device = seal_device_name(&ak(), "Дом", &mut nonce_stream()).unwrap();
    let in_space = seal_space_name(&ak(), &space(), "Дом", &mut nonce_stream()).unwrap();
    let other_space = SpaceId::from_bytes([0x44; 16]);
    assert_eq!(
        open_space_name(&ak(), &other_space, &in_space).unwrap_err(),
        CryptoError::Authentication
    );
    assert_eq!(
        open_device_name(&ak(), &in_space).unwrap_err(),
        CryptoError::Authentication
    );
    assert_eq!(
        open_space_name(&ak(), &space(), &device).unwrap_err(),
        CryptoError::Authentication
    );
}

#[test]
fn only_exactly_105_bytes_are_an_envelope() {
    // П12, П20, Ф34: a shorter or longer envelope is malformed, not an authentication failure
    let device = seal_device_name(&ak(), "Дом", &mut nonce_stream()).unwrap();
    let in_space = seal_space_name(&ak(), &space(), "Дом", &mut nonce_stream()).unwrap();
    let mut longer = device.clone();
    longer.push(0);
    let mut longer_in_space = in_space.clone();
    longer_in_space.push(0);
    for bad in [&[][..], &device[..104], &longer[..]] {
        assert!(
            matches!(open_device_name(&ak(), bad), Err(CryptoError::Malformed(_))),
            "len {}",
            bad.len()
        );
    }
    for bad in [&[][..], &in_space[..104], &longer_in_space[..]] {
        assert!(
            matches!(
                open_space_name(&ak(), &space(), bad),
                Err(CryptoError::Malformed(_))
            ),
            "len {}",
            bad.len()
        );
    }
}

#[test]
fn a_name_of_64_bytes_fits_and_longer_is_refused_before_any_random_is_drawn() {
    // О2, Ф34: 64 bytes is the limit in bytes, not in characters; a longer name is refused and
    // the random source stays untouched (Ф31)
    let longest = "x".repeat(NAME_MAX_BYTES);
    let sealed = seal_device_name(&ak(), &longest, &mut nonce_stream()).unwrap();
    assert_eq!(sealed.len(), NAME_ENVELOPE_LEN);
    assert_eq!(open_device_name(&ak(), &sealed).unwrap(), longest);
    let longest_multibyte = "Ж".repeat(32);
    assert_eq!(longest_multibyte.len(), 64);
    assert!(seal_space_name(&ak(), &space(), &longest_multibyte, &mut nonce_stream()).is_ok());

    for too_long in ["x".repeat(65), "Ж".repeat(33), "\u{1F4F1}".repeat(17)] {
        let mut untouched = Scripted::new(Vec::new());
        assert!(
            matches!(
                seal_device_name(&ak(), &too_long, &mut untouched),
                Err(CryptoError::InvalidParams(_))
            ),
            "{} bytes",
            too_long.len()
        );
        assert!(matches!(
            seal_space_name(&ak(), &space(), &too_long, &mut untouched),
            Err(CryptoError::InvalidParams(_))
        ));
        untouched.assert_spent();
    }
}

#[test]
fn a_name_with_a_zero_byte_is_refused() {
    // Ф34: the padding is zeros, so a zero inside a name could not be read back unambiguously
    let mut untouched = Scripted::new(Vec::new());
    for bad in ["a\0b", "name\0", "\0"] {
        assert!(matches!(
            seal_device_name(&ak(), bad, &mut untouched),
            Err(CryptoError::InvalidParams(_))
        ));
        assert!(matches!(
            seal_space_name(&ak(), &space(), bad, &mut untouched),
            Err(CryptoError::InvalidParams(_))
        ));
    }
    untouched.assert_spent();
}

#[test]
fn an_empty_name_is_a_valid_name() {
    // Ф34: zeros only
    let sealed = seal_device_name(&ak(), "", &mut nonce_stream()).unwrap();
    assert_eq!(sealed.len(), NAME_ENVELOPE_LEN);
    assert_eq!(open_device_name(&ak(), &sealed).unwrap(), "");
}

#[test]
fn two_seals_of_one_name_differ_only_by_the_nonce() {
    // Ф31, Ф34: a fresh nonce for every envelope
    let first = seal_device_name(&ak(), "Дом", &mut Scripted::new(vec![1; 24])).unwrap();
    let second = seal_device_name(&ak(), "Дом", &mut Scripted::new(vec![2; 24])).unwrap();
    assert_ne!(first, second);
    assert_ne!(first[1..25], second[1..25]);
}

proptest! {
    #[test]
    fn any_name_up_to_64_bytes_round_trips(name in "[^\\x00]{0,20}", seed in any::<u64>()) {
        // Ф34: whatever the name is, up to 64 bytes and without a zero, it comes back unchanged
        prop_assume!(name.len() <= NAME_MAX_BYTES);
        let mut rng = SeedRandom(seed);
        let sealed = seal_device_name(&ak(), &name, &mut rng).unwrap();
        prop_assert_eq!(sealed.len(), NAME_ENVELOPE_LEN);
        prop_assert_eq!(open_device_name(&ak(), &sealed).unwrap(), name.clone());
        let in_space = seal_space_name(&ak(), &space(), &name, &mut rng).unwrap();
        prop_assert_eq!(open_space_name(&ak(), &space(), &in_space).unwrap(), name);
    }
}
