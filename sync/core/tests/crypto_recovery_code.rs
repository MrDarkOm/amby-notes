//! The recovery code as the user sees it (О3, Р5, Ф27–Ф30).
//!
//! Exact strings for chosen codes are in `crypto_reference_vectors.rs`; here the properties.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use amby_sync_core::crypto::RecoveryCodeError;
use common::Scripted;
use proptest::prelude::*;

const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[test]
fn a_new_code_takes_32_random_bytes() {
    // О3, Р5, Ф27, Ф31: 256 bits straight from the random source
    let mut rng = Scripted::new((100u8..132).collect());
    let code = RecoveryCode::generate(&mut rng);
    rng.assert_spent();
    assert_eq!(code.as_bytes().to_vec(), (100u8..132).collect::<Vec<_>>());
    assert_ne!(
        RecoveryCode::generate(&mut OsRandom),
        RecoveryCode::generate(&mut OsRandom)
    );
}

#[test]
fn the_printed_code_has_14_groups_of_4_crockford_symbols() {
    // О3, Ф28–Ф30: XXXX-XXXX-… with the alphabet that has no I, L, O, U
    for seed in 0u8..20 {
        let code = RecoveryCode::from_bytes([seed.wrapping_mul(37); 32]);
        let shown = code.to_display();
        let groups: Vec<&str> = shown.split('-').collect();
        assert_eq!(groups.len(), 14, "{shown}");
        for group in groups {
            assert_eq!(group.len(), 4, "{shown}");
            assert!(group.chars().all(|c| ALPHABET.contains(c)), "{shown}");
        }
    }
}

#[test]
fn every_single_typo_is_caught() {
    // О3, Ф29, Ф30: replacing any one symbol by any other is rejected for this code (the checksum is
    // a hash, so in general a typo slips through with probability 2^-20; the sample code was checked
    // against the reference for all 1736 replacements)
    let code = RecoveryCode::from_bytes(std::array::from_fn(|i| (i * 7 + 3) as u8));
    let shown = code.to_display();
    assert_eq!(
        RecoveryCode::parse(&shown).unwrap(),
        code,
        "the original reads back"
    );
    let symbols: Vec<char> = shown.chars().filter(|c| *c != '-').collect();
    assert_eq!(symbols.len(), 56);
    for position in 0..symbols.len() {
        for replacement in ALPHABET.chars().filter(|c| *c != symbols[position]) {
            let mut typed = symbols.clone();
            typed[position] = replacement;
            let text: String = typed.iter().collect();
            if let Ok(parsed) = RecoveryCode::parse(&text) {
                panic!("typo at {position} ({replacement}) accepted as {parsed:?}");
            }
        }
    }
}

#[test]
fn two_swapped_neighbours_are_caught() {
    // О3, Ф29: a transposition of two different symbols is not accepted
    let code = RecoveryCode::from_bytes([0xA5; 32]);
    let symbols: Vec<char> = code.to_display().chars().filter(|c| *c != '-').collect();
    assert_eq!(
        RecoveryCode::parse(&symbols.iter().collect::<String>()).unwrap(),
        code
    );
    let mut checked = 0;
    for position in 0..symbols.len() - 1 {
        if symbols[position] == symbols[position + 1] {
            continue;
        }
        let mut swapped = symbols.clone();
        swapped.swap(position, position + 1);
        assert!(
            RecoveryCode::parse(&swapped.iter().collect::<String>()).is_err(),
            "swap at {position}"
        );
        checked += 1;
    }
    assert!(
        checked > 40,
        "the sample code must have enough distinct neighbours"
    );
}

#[test]
fn bad_inputs_get_distinct_errors() {
    // О3, Ф30: length, symbol and checksum errors are told apart for the user
    let shown = RecoveryCode::from_bytes([0x3C; 32]).to_display();
    assert_eq!(RecoveryCode::parse(&shown).unwrap().as_bytes(), &[0x3C; 32]);
    assert_eq!(RecoveryCode::parse(""), Err(RecoveryCodeError::BadLength));
    assert_eq!(
        RecoveryCode::parse(&shown.replace('-', "")[..55]),
        Err(RecoveryCodeError::BadLength)
    );
    assert_eq!(
        RecoveryCode::parse(&format!("{shown}-0000")),
        Err(RecoveryCodeError::BadLength)
    );
    assert_eq!(
        RecoveryCode::parse(&shown.replacen(&shown[..1], "U", 1)),
        Err(RecoveryCodeError::BadSymbol)
    );
    assert_eq!(
        RecoveryCode::parse(&shown.replacen(&shown[..1], "*", 1)),
        Err(RecoveryCodeError::BadSymbol)
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn the_code_roundtrips_through_its_printed_form(bytes in any::<[u8; 32]>()) {
        // О3, Р5, Ф28–Ф30
        let code = RecoveryCode::from_bytes(bytes);
        let shown = code.to_display();
        prop_assert_eq!(shown.len(), 56 + 13);
        prop_assert_eq!(RecoveryCode::parse(&shown).unwrap(), code.clone());
        // tolerant forms: lower case, no separators, spaces
        prop_assert_eq!(RecoveryCode::parse(&shown.to_lowercase()).unwrap(), code.clone());
        prop_assert_eq!(RecoveryCode::parse(&shown.replace('-', "")).unwrap(), code.clone());
        prop_assert_eq!(RecoveryCode::parse(&shown.replace('-', " ")).unwrap(), code);
    }

    #[test]
    fn parsing_never_panics_and_rarely_accepts_noise(text in "\\PC{0,80}") {
        // О3, Ф30: arbitrary user input is an error, not a crash (and a fresh code is not guessed)
        if let Ok(code) = RecoveryCode::parse(&text) {
            // accepted text must be a faithful spelling of its own code
            prop_assert_eq!(RecoveryCode::parse(&code.to_display()).unwrap(), code);
        }
    }
}
