//! The rule for the password (Р5): 12 characters and a sufficient zxcvbn score.

use std::time::Instant;

use super::password::{check_password, MIN_PASSWORD_LENGTH};

#[test]
fn a_short_password_is_too_short_whatever_its_strength() {
    // Р5: at least 12 characters
    for password in ["", "a", "Tr0ub4dor&3", "x9!Qz#7"] {
        let verdict = check_password(password, &[]);
        assert!(!verdict.ok, "{password:?}");
        assert!(verdict.too_short, "{password:?}");
        assert_eq!(verdict.min_length, MIN_PASSWORD_LENGTH as u32);
    }
}

#[test]
fn length_is_counted_in_characters_not_bytes() {
    // 11 Cyrillic letters are 22 bytes but 11 characters; 12 are enough in length
    assert!(check_password("ёжикёжикёжи", &[]).too_short);
    assert!(!check_password("ёжикёжикёжик", &[]).too_short);
    assert_eq!(check_password("ёжикёжикёжик", &[]).length, 12);
}

#[test]
fn long_but_guessable_passwords_are_refused() {
    // Р5: the length alone is not enough
    for password in [
        "passwordpassword",
        "123456789012",
        "qwertyuiop12",
        "password123456",
        "abcabcabcabcabc",
    ] {
        let verdict = check_password(password, &[]);
        assert!(!verdict.too_short, "{password}");
        assert!(!verdict.ok, "{password}");
        assert!(verdict.score <= 2, "{password}: {}", verdict.score);
    }
}

#[test]
fn a_weak_password_names_its_weakness() {
    // the interface tells why: a machine name of the warning or of the advice
    let verdict = check_password("password123456", &[]);
    assert!(verdict.warning.is_some() || !verdict.suggestions.is_empty());
    for name in verdict.warning.iter().chain(verdict.suggestions.iter()) {
        assert!(!name.is_empty());
        assert!(
            name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
            "a machine name, not a sentence: {name}"
        );
    }
}

#[test]
fn strong_passwords_are_accepted() {
    // Р5
    for password in [
        "correct horse battery staple 42",
        "Zq7!vN2$kP9@mX4#",
        "мой любимый пароль про синюю луну 9",
    ] {
        let verdict = check_password(password, &[]);
        assert!(verdict.ok, "{password}: score {}", verdict.score);
        assert!(verdict.score >= 3);
        assert!(!verdict.too_short);
        assert_eq!(verdict.warning, None);
    }
}

#[test]
fn words_of_the_account_weaken_the_password() {
    // Р5: the user name must not carry the password
    let without = check_password("longusername01", &[]);
    let with = check_password("longusername01", &["longusername01"]);
    assert!(with.score <= without.score);
    assert!(!with.ok);
}

#[test]
fn a_very_long_text_is_judged_quickly() {
    // only the first 100 characters are scored; a pasted book must not hang the interface
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut text = String::new();
    for _ in 0..20_000 {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        text.push(char::from(b'a' + ((state >> 33) % 26) as u8));
    }
    let started = Instant::now();
    let verdict = check_password(&text, &[]);
    assert!(
        started.elapsed().as_secs() < 2,
        "took {:?}",
        started.elapsed()
    );
    assert!(verdict.ok);
    assert_eq!(verdict.length, 20_000);
}
