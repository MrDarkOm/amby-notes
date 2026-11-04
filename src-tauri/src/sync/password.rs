//! The rule for the password (Р5): at least 12 characters, a lower and an upper case letter, a
//! digit, a symbol, and a sufficient `zxcvbn` score. It judges new passwords only; signing in with
//! an existing password never asks for it. The
//! interface shows the verdict while the person types; `prepare_account` and `recover` apply the
//! same rule again, so a weak password never reaches Argon2id.

use zeroize::Zeroizing;

use crate::sync::types::PasswordCheck;

/// The least length of a password, in characters (Р5).
pub const MIN_PASSWORD_LENGTH: usize = 12;
/// The least `zxcvbn` score that is accepted (0–4).
pub const MIN_PASSWORD_SCORE: u8 = 3;
/// How much of a password `zxcvbn` reads: it is slow on long texts, and 100 characters of a
/// random text are far beyond the score that is asked for.
const SCORED_CHARACTERS: usize = 100;

/// What `password` lacks, in the fixed order the interface lists it: `length`, `lowercase`,
/// `uppercase`, `digit`, `symbol`. Letters and digits are Unicode (Cyrillic counts); a symbol is
/// anything that is not a letter, a digit or white space.
fn missing_requirements(password: &str, length: usize) -> Vec<String> {
    let has = |test: fn(char) -> bool| password.chars().any(test);
    [
        ("length", length >= MIN_PASSWORD_LENGTH),
        ("lowercase", has(char::is_lowercase)),
        ("uppercase", has(char::is_uppercase)),
        ("digit", has(char::is_numeric)),
        (
            "symbol",
            has(|c| !c.is_alphabetic() && !c.is_numeric() && !c.is_whitespace()),
        ),
    ]
    .into_iter()
    .filter(|(_, present)| !present)
    .map(|(name, _)| name.to_string())
    .collect()
}

/// Judges `password`. `user_inputs` are words the password must not be built from (the user
/// name, the host). Only the first 100 characters are scored, as `zxcvbn` advises, so a very
/// long text cannot hang the interface. Does not log anything.
pub fn check_password(password: &str, user_inputs: &[&str]) -> PasswordCheck {
    let length = password.chars().count();
    let scored: Zeroizing<String> =
        Zeroizing::new(password.chars().take(SCORED_CHARACTERS).collect());
    let entropy = zxcvbn::zxcvbn(&scored, user_inputs);
    let score = u8::from(entropy.score());
    let too_short = length < MIN_PASSWORD_LENGTH;
    let missing = missing_requirements(password, length);
    PasswordCheck {
        ok: missing.is_empty() && score >= MIN_PASSWORD_SCORE,
        score,
        length: u32::try_from(length).unwrap_or(u32::MAX),
        min_length: MIN_PASSWORD_LENGTH as u32,
        too_short,
        missing,
    }
}
