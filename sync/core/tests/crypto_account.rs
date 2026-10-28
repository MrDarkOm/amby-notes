//! Password, recovery code and key wrapping seen from outside (Р5, О3, О8, С12).
//!
//! Vectors of the exact bytes are in `crypto_reference_vectors.rs`; here the behaviour is checked:
//! who can unwrap what, what is rejected and why.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_core::crypto::account::{
    change_password, create_account, derive_password_keys, derive_recovery_keys,
    generate_space_key, reset_password, seal_account_key_for_password, server_auth_hash,
    unwrap_account_key, unwrap_space_key, wrap_account_key, wrap_space_key, Argon2Params,
};
use amby_sync_core::crypto::keys::{AccountKey, Kek, SpaceId, SpaceKey};
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use amby_sync_core::crypto::CryptoError;
use common::{Scripted, SeedRandom};
use proptest::prelude::*;
use sha2::{Digest, Sha256};

const DEFAULT: Argon2Params = Argon2Params::V1_DEFAULT;

#[test]
fn argon2_parameters_inside_the_limits_are_accepted() {
    // О8, Р5, Ф8: the defaults, higher values and the upper limits are valid
    for (memory_kib, iterations, parallelism) in [
        (65_536, 3, 4),
        (131_072, 3, 4),
        (65_536, 12, 1),
        (1_048_576, 12, 16),
        (65_536, 4, 16),
    ] {
        let params = Argon2Params {
            memory_kib,
            iterations,
            parallelism,
        };
        assert_eq!(params.validate(), Ok(()), "{params:?}");
    }
}

#[test]
fn argon2_parameters_outside_the_limits_are_rejected() {
    // О8, Ф8: a server must not be able to weaken the password check or hang the client
    for (memory_kib, iterations, parallelism) in [
        (65_535, 3, 4),
        (8_192, 3, 4),
        (1_048_577, 3, 4),
        (u32::MAX, 3, 4),
        (65_536, 2, 4),
        (65_536, 0, 4),
        (65_536, 13, 4),
        (65_536, 3, 0),
        (65_536, 3, 17),
    ] {
        let params = Argon2Params {
            memory_kib,
            iterations,
            parallelism,
        };
        assert!(
            matches!(params.validate(), Err(CryptoError::InvalidParams(_))),
            "{params:?}"
        );
    }
}

#[test]
fn key_derivation_refuses_weak_or_huge_parameters_before_any_work() {
    // О8, Ф8: refusal is immediate (a 4 GiB request would otherwise take long or abort)
    let salt = [1u8; 16];
    let weak = Argon2Params {
        memory_kib: 1_024,
        iterations: 1,
        parallelism: 1,
    };
    let huge = Argon2Params {
        memory_kib: 4_194_304,
        iterations: 3,
        parallelism: 4,
    };
    assert!(matches!(
        derive_password_keys("a long enough password", &salt, &weak),
        Err(CryptoError::InvalidParams(_))
    ));
    assert!(matches!(
        derive_password_keys("a long enough password", &salt, &huge),
        Err(CryptoError::InvalidParams(_))
    ));
    // positive control: the same call with the defaults works
    assert!(derive_password_keys("a long enough password", &salt, &DEFAULT).is_ok());
}

#[test]
fn password_login_and_account_key_unwrap() {
    // О3, Р5, С12: the right password unwraps AK, the wrong one does not
    let password = "correct horse battery staple";
    let account = create_account(password, &DEFAULT, &mut OsRandom).unwrap();
    let keys =
        derive_password_keys(password, &account.password.salt, &account.password.params).unwrap();
    assert_eq!(keys.auth_key, account.password.auth_key);
    assert_eq!(
        unwrap_account_key(&keys.kek, &account.password.wrapped_account_key).unwrap(),
        account.account_key
    );

    let wrong = derive_password_keys(
        "correct horse battery stapl3",
        &account.password.salt,
        &DEFAULT,
    )
    .unwrap();
    assert_ne!(
        wrong.auth_key, keys.auth_key,
        "a wrong password gives another auth key"
    );
    assert_eq!(
        unwrap_account_key(&wrong.kek, &account.password.wrapped_account_key),
        Err(CryptoError::Authentication)
    );
}

#[test]
fn recovery_code_unwraps_the_same_account_key() {
    // О3, Р5: the code shown to the user restores access without the password
    let account = create_account("correct horse battery staple", &DEFAULT, &mut OsRandom).unwrap();
    let typed = RecoveryCode::parse(&account.recovery_code.to_display().to_lowercase()).unwrap();
    let keys = derive_recovery_keys(&typed);
    assert_eq!(keys.auth_key, account.recovery_auth_key);
    assert_eq!(
        unwrap_account_key(&keys.kek, &account.wrapped_account_key_recovery).unwrap(),
        account.account_key
    );

    let other = derive_recovery_keys(&RecoveryCode::generate(&mut OsRandom));
    assert_ne!(other.auth_key, keys.auth_key);
    assert_eq!(
        unwrap_account_key(&other.kek, &account.wrapped_account_key_recovery),
        Err(CryptoError::Authentication)
    );
}

#[test]
fn password_and_recovery_keys_are_independent() {
    // О3, Р5, Ф10, Ф11: auth key and KEK differ; password and code cannot unwrap each other's blob
    let account = create_account("correct horse battery staple", &DEFAULT, &mut OsRandom).unwrap();
    let password = derive_password_keys(
        "correct horse battery staple",
        &account.password.salt,
        &DEFAULT,
    )
    .unwrap();
    let recovery = derive_recovery_keys(&account.recovery_code);
    assert_ne!(password.auth_key.as_bytes(), password.kek.as_bytes());
    assert_ne!(recovery.auth_key.as_bytes(), recovery.kek.as_bytes());
    assert_ne!(password.auth_key, recovery.auth_key);
    assert_ne!(password.kek.as_bytes(), recovery.kek.as_bytes());
    // positive controls
    assert!(unwrap_account_key(&password.kek, &account.password.wrapped_account_key).is_ok());
    assert!(unwrap_account_key(&recovery.kek, &account.wrapped_account_key_recovery).is_ok());
    // crossed
    assert_eq!(
        unwrap_account_key(&password.kek, &account.wrapped_account_key_recovery),
        Err(CryptoError::Authentication)
    );
    assert_eq!(
        unwrap_account_key(&recovery.kek, &account.password.wrapped_account_key),
        Err(CryptoError::Authentication)
    );
}

#[test]
fn server_stores_only_the_sha256_of_the_auth_key() {
    // Р5, Ф5: the hash is SHA-256 of the 32 key bytes and is not the key itself
    let keys = derive_password_keys("correct horse battery staple", &[3u8; 16], &DEFAULT).unwrap();
    let expected: [u8; 32] = Sha256::digest(keys.auth_key.as_bytes()).into();
    assert_eq!(server_auth_hash(&keys.auth_key), expected);
    assert_ne!(&server_auth_hash(&keys.auth_key), keys.auth_key.as_bytes());
}

#[test]
fn a_new_account_uses_fresh_random_values() {
    // Р5, Р6, Ф31: two accounts never share salt, AK or recovery code
    let first = create_account("correct horse battery staple", &DEFAULT, &mut OsRandom).unwrap();
    let second = create_account("correct horse battery staple", &DEFAULT, &mut OsRandom).unwrap();
    assert_ne!(first.password.salt, second.password.salt);
    assert_ne!(first.account_key, second.account_key);
    assert_ne!(first.recovery_code, second.recovery_code);
    assert_ne!(first.password.auth_key, second.password.auth_key);
}

#[test]
fn forgotten_password_is_reset_with_the_recovery_code() {
    // О3, Р5: new password, new salt, the same AK — so the data on the server stays readable
    let old_password = "correct horse battery staple";
    let new_password = "a brand new passphrase";
    let account = create_account(old_password, &DEFAULT, &mut OsRandom).unwrap();
    let (ak, envelope) = reset_password(
        &account.recovery_code,
        &account.wrapped_account_key_recovery,
        new_password,
        &DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    assert_eq!(ak, account.account_key);
    assert_ne!(envelope.salt, account.password.salt);

    let new_keys = derive_password_keys(new_password, &envelope.salt, &envelope.params).unwrap();
    assert_eq!(new_keys.auth_key, envelope.auth_key);
    assert_eq!(
        unwrap_account_key(&new_keys.kek, &envelope.wrapped_account_key).unwrap(),
        account.account_key
    );
    // the old password does not open the new envelope
    let old_keys = derive_password_keys(old_password, &envelope.salt, &envelope.params).unwrap();
    assert_eq!(
        unwrap_account_key(&old_keys.kek, &envelope.wrapped_account_key),
        Err(CryptoError::Authentication)
    );
}

#[test]
fn reset_with_a_wrong_recovery_code_fails() {
    // О3, С12: a wrong code reveals nothing and produces no new envelope
    let account = create_account("correct horse battery staple", &DEFAULT, &mut OsRandom).unwrap();
    let wrong = RecoveryCode::generate(&mut OsRandom);
    let result = reset_password(
        &wrong,
        &account.wrapped_account_key_recovery,
        "a brand new passphrase",
        &DEFAULT,
        &mut OsRandom,
    );
    assert_eq!(result.unwrap_err(), CryptoError::Authentication);
}

#[test]
fn changing_the_password_needs_the_old_one() {
    // Р5, О3: the old password unwraps AK, the new one wraps it again; a wrong old one fails
    let account = create_account("correct horse battery staple", &DEFAULT, &mut OsRandom).unwrap();
    let wrong_old = change_password(
        "not the old password",
        &account.password.salt,
        &account.password.params,
        &account.password.wrapped_account_key,
        "another passphrase",
        &DEFAULT,
        &mut OsRandom,
    );
    assert_eq!(wrong_old.unwrap_err(), CryptoError::Authentication);

    let (ak, envelope) = change_password(
        "correct horse battery staple",
        &account.password.salt,
        &account.password.params,
        &account.password.wrapped_account_key,
        "another passphrase",
        &DEFAULT,
        &mut OsRandom,
    )
    .unwrap();
    assert_eq!(ak, account.account_key);
    let keys =
        derive_password_keys("another passphrase", &envelope.salt, &envelope.params).unwrap();
    assert_eq!(
        unwrap_account_key(&keys.kek, &envelope.wrapped_account_key).unwrap(),
        account.account_key
    );
}

#[test]
fn account_key_can_be_sealed_for_a_password_with_a_new_salt() {
    // Р5, Ф31: new salt and nonce, auth key that matches the password
    let ak = AccountKey::from_bytes([0x42; 32]);
    let mut rng = Scripted::new([vec![0x11; 16], vec![0x22; 24]].concat());
    let envelope =
        seal_account_key_for_password("some long passphrase", &ak, &DEFAULT, &mut rng).unwrap();
    rng.assert_spent();
    assert_eq!(envelope.salt, [0x11; 16]);
    let keys = derive_password_keys("some long passphrase", &envelope.salt, &DEFAULT).unwrap();
    assert_eq!(keys.auth_key, envelope.auth_key);
    assert_eq!(
        unwrap_account_key(&keys.kek, &envelope.wrapped_account_key).unwrap(),
        ak
    );
}

#[test]
fn password_is_normalised_before_hashing() {
    // Р5, Ф6: NFC and NFD forms of the same password give the same keys (macOS vs Windows)
    let nfc = "caf\u{00e9} s\u{00e4}ngare \u{2603}";
    let nfd = "cafe\u{0301} sa\u{0308}ngare \u{2603}";
    assert_ne!(nfc, nfd);
    let salt = [5u8; 16];
    let a = derive_password_keys(nfc, &salt, &DEFAULT).unwrap();
    let b = derive_password_keys(nfd, &salt, &DEFAULT).unwrap();
    assert_eq!(a, b);
    // positive control: another password gives other keys
    assert_ne!(
        a,
        derive_password_keys("cafe s\u{00e4}ngare \u{2603}", &salt, &DEFAULT).unwrap()
    );
}

#[test]
fn wrapped_keys_are_73_bytes_and_use_a_fresh_nonce() {
    // Р5, Р6, Ф13: 0x01 ‖ nonce(24) ‖ ciphertext(32) ‖ tag(16); a new nonce every time
    let kek = Kek::from_bytes([1; 32]);
    let ak = AccountKey::from_bytes([2; 32]);
    let first = wrap_account_key(&kek, &ak, &mut OsRandom);
    let second = wrap_account_key(&kek, &ak, &mut OsRandom);
    assert_eq!(first.len(), 73);
    assert_eq!(first[0], 1);
    assert_ne!(first, second);
    assert_eq!(unwrap_account_key(&kek, &first).unwrap(), ak);
    assert_eq!(unwrap_account_key(&kek, &second).unwrap(), ak);
    // the secret is not visible in the wrapped form
    assert!(!first.windows(32).any(|window| window == [2u8; 32]));
}

#[test]
fn any_changed_byte_of_a_wrapped_account_key_is_rejected() {
    // Р6, С5, Ф13: version byte, nonce, ciphertext and tag are all authenticated
    let kek = Kek::from_bytes([1; 32]);
    let ak = AccountKey::from_bytes([2; 32]);
    let wrapped = wrap_account_key(&kek, &ak, &mut OsRandom);
    assert!(unwrap_account_key(&kek, &wrapped).is_ok());
    for position in 0..wrapped.len() {
        let mut changed = wrapped.clone();
        changed[position] ^= 0x01;
        let error = unwrap_account_key(&kek, &changed).unwrap_err();
        let expected = if position == 0 {
            CryptoError::UnsupportedVersion(0)
        } else {
            CryptoError::Authentication
        };
        assert_eq!(error, expected, "byte {position}");
    }
    assert!(unwrap_account_key(&kek, &wrapped[..72]).is_err());
    assert!(unwrap_account_key(&kek, &[wrapped.clone(), vec![0]].concat()).is_err());
    assert!(unwrap_account_key(&kek, &[]).is_err());
}

#[test]
fn space_key_is_bound_to_its_space_epoch_and_account_key() {
    // Р5, Р6, Ф12: the server cannot hand out the VK of one space or epoch as another
    let ak = AccountKey::from_bytes([3; 32]);
    let space = SpaceId::from_bytes([4; 16]);
    let vk = generate_space_key(1, &mut OsRandom).unwrap();
    let wrapped = wrap_space_key(&ak, &space, &vk, &mut OsRandom);
    assert_eq!(wrapped.len(), 73);
    let opened = unwrap_space_key(&ak, &space, 1, &wrapped).unwrap();
    assert_eq!(opened.as_bytes(), vk.as_bytes());
    assert_eq!(opened.epoch(), 1);

    let other_space = SpaceId::from_bytes([5; 16]);
    assert_eq!(
        unwrap_space_key(&ak, &other_space, 1, &wrapped).unwrap_err(),
        CryptoError::Authentication
    );
    assert_eq!(
        unwrap_space_key(&ak, &space, 2, &wrapped).unwrap_err(),
        CryptoError::Authentication
    );
    let other_ak = AccountKey::from_bytes([6; 32]);
    assert_eq!(
        unwrap_space_key(&other_ak, &space, 1, &wrapped).unwrap_err(),
        CryptoError::Authentication
    );
    // AK-wrapped and VK-wrapped blobs are not interchangeable (Ф11, Ф12)
    let as_account = wrap_account_key(
        &Kek::from_bytes(*ak.as_bytes()),
        &AccountKey::from_bytes(*vk.as_bytes()),
        &mut OsRandom,
    );
    assert_eq!(
        unwrap_space_key(&ak, &space, 1, &as_account).unwrap_err(),
        CryptoError::Authentication
    );
}

#[test]
fn new_space_key_takes_32_random_bytes_and_refuses_epoch_zero() {
    // Р5, Р14, Ф3, Ф31
    let mut rng = Scripted::new((0u8..32).collect());
    let vk = generate_space_key(1, &mut rng).unwrap();
    rng.assert_spent();
    assert_eq!(vk.as_bytes().to_vec(), (0u8..32).collect::<Vec<_>>());
    assert_eq!(vk.epoch(), 1);
    assert!(matches!(
        generate_space_key(0, &mut OsRandom),
        Err(CryptoError::InvalidParams(_))
    ));
    assert_eq!(generate_space_key(7, &mut OsRandom).unwrap().epoch(), 7);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn account_key_wrap_roundtrips_for_any_keys(kek in any::<[u8; 32]>(), ak in any::<[u8; 32]>(), seed in any::<u64>()) {
        // Р5, Р6: wrap then unwrap gives AK back; a different KEK does not
        let kek = Kek::from_bytes(kek);
        let ak = AccountKey::from_bytes(ak);
        let wrapped = wrap_account_key(&kek, &ak, &mut SeedRandom(seed));
        prop_assert_eq!(unwrap_account_key(&kek, &wrapped).unwrap(), ak.clone());
        let mut other = *kek.as_bytes();
        other[0] ^= 1;
        prop_assert_eq!(unwrap_account_key(&Kek::from_bytes(other), &wrapped).unwrap_err(), CryptoError::Authentication);
    }

    #[test]
    fn space_key_wrap_roundtrips_for_any_keys(
        ak in any::<[u8; 32]>(),
        vk in any::<[u8; 32]>(),
        space in any::<[u8; 16]>(),
        epoch in 1u32..u32::MAX,
        seed in any::<u64>(),
    ) {
        // Р5, Р6, Ф12
        let ak = AccountKey::from_bytes(ak);
        let space = SpaceId::from_bytes(space);
        let vk = SpaceKey::from_bytes(vk, epoch);
        let wrapped = wrap_space_key(&ak, &space, &vk, &mut SeedRandom(seed));
        let opened = unwrap_space_key(&ak, &space, epoch, &wrapped).unwrap();
        prop_assert_eq!(opened.as_bytes(), vk.as_bytes());
        prop_assert_eq!(opened.epoch(), epoch);
        prop_assert!(unwrap_space_key(&ak, &space, epoch + 1, &wrapped).is_err());
    }
}

proptest! {
    // Argon2id with 64 MiB is slow on purpose (О8): few cases, each derives the key three times.
    #![proptest_config(ProptestConfig::with_cases(4))]

    #[test]
    fn any_password_logs_in_and_no_other_password_does(password in "\\PC{1,40}", seed in any::<u64>()) {
        // О3, О8, Р5, С12, Ф6: the same password opens AK, a different one does not
        let account = create_account(&password, &DEFAULT, &mut SeedRandom(seed)).unwrap();
        let keys = derive_password_keys(&password, &account.password.salt, &DEFAULT).unwrap();
        prop_assert_eq!(keys.auth_key.clone(), account.password.auth_key.clone());
        prop_assert_eq!(
            unwrap_account_key(&keys.kek, &account.password.wrapped_account_key).unwrap(),
            account.account_key.clone()
        );
        let different = format!("{password}!");
        let wrong = derive_password_keys(&different, &account.password.salt, &DEFAULT).unwrap();
        prop_assert!(unwrap_account_key(&wrong.kek, &account.password.wrapped_account_key).is_err());
    }
}
