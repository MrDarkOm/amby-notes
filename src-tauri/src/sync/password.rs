//! The rule for the password (Р5): at least 12 characters and a sufficient `zxcvbn` score. The
//! interface shows the verdict while the person types; `prepare_account` and `recover` apply the
//! same rule again, so a weak password never reaches Argon2id.

use crate::sync::types::PasswordCheck;

/// The least length of a password, in characters (Р5).
pub const MIN_PASSWORD_LENGTH: usize = 12;
/// The least `zxcvbn` score that is accepted (0–4).
pub const MIN_PASSWORD_SCORE: u8 = 3;

/// Judges `password`. `user_inputs` are words the password must not be built from (the user
/// name, the host). Only the first 100 characters are scored, as `zxcvbn` advises, so a very
/// long text cannot hang the interface. Does not log anything.
pub fn check_password(password: &str, user_inputs: &[&str]) -> PasswordCheck {
    let _ = (password, user_inputs);
    todo!("Р5")
}
