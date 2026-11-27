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
fn strong_passwords_are_accepted() {
    // Р5
    for password in [
        "Correct-Horse-Battery-Staple-42!",
        "Zq7!vN2$kP9@mX4#",
        "Мой любимый пароль про синюю луну 9!",
    ] {
        let verdict = check_password(password, &[]);
        assert!(verdict.ok, "{password}: score {}", verdict.score);
        assert!(verdict.score >= 3);
        assert!(!verdict.too_short);
        assert!(verdict.missing.is_empty(), "{password}");
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
    let mut text = String::from("Aa1!");
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
    assert_eq!(verdict.length, 20_004);
}

fn missing(password: &str) -> Vec<String> {
    check_password(password, &[]).missing
}

#[test]
fn each_missing_requirement_is_named_on_its_own() {
    // Р5: lower and upper case, a digit and a symbol, in one fixed order
    assert_eq!(missing("ABCDEFGH-1234x"), Vec::<String>::new());
    assert_eq!(missing("ABCDEFGH-1234"), vec!["lowercase"]);
    assert_eq!(missing("abcdefgh-1234x"), vec!["uppercase"]);
    assert_eq!(missing("abcdefgH-xyzwv"), vec!["digit"]);
    assert_eq!(missing("abcdefgH1xyzwv"), vec!["symbol"]);
    assert_eq!(missing("Ab1!x"), vec!["length"]);
}

#[test]
fn missing_requirements_come_in_the_fixed_order() {
    assert_eq!(
        missing("abcdefghijklmno"),
        vec!["uppercase", "digit", "symbol"]
    );
    assert_eq!(
        missing("short"),
        vec!["length", "uppercase", "digit", "symbol"]
    );
    assert_eq!(
        missing(""),
        vec!["length", "lowercase", "uppercase", "digit", "symbol"]
    );
}

#[test]
fn letters_are_unicode_and_a_space_is_not_a_symbol() {
    // Cyrillic counts as lower and upper case; a space is neither a symbol nor a digit
    assert!(missing("Привет-мир-123").is_empty());
    assert_eq!(missing("Привет мир 123 абв"), vec!["symbol"]);
    assert_eq!(missing("ПРИВЕТ-МИР-123"), vec!["lowercase"]);
}

#[test]
fn a_known_password_with_every_class_is_still_refused() {
    // the classes alone do not make a password good: zxcvbn still judges
    let verdict = check_password("Password123!", &[]);
    assert!(verdict.missing.is_empty());
    assert!(verdict.score <= 2);
    assert!(!verdict.ok);
}

#[test]
fn ok_needs_every_requirement_and_the_score() {
    // a long phrase of words without a digit or a symbol is not enough either
    let verdict = check_password("correct horse battery staple", &[]);
    assert!(verdict.score >= 3);
    assert_eq!(verdict.missing, vec!["uppercase", "digit", "symbol"]);
    assert!(!verdict.ok);
    let good = check_password("Correct-Horse-Battery-Staple-42!", &[]);
    assert!(good.missing.is_empty() && good.ok);
}
