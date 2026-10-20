//! The recovery code: 256 random bits as printable Crockford base32 with a checksum
//! (Р5, О3, Ф27–Ф30).

use core::fmt;

use zeroize::{Zeroize, ZeroizeOnDrop};

use super::error::RecoveryCodeError;
use super::random::Random;

/// The recovery code (Р5). Shown to the user once, in the form `XXXX-XXXX-…` (14 groups).
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct RecoveryCode([u8; 32]);

impl RecoveryCode {
    /// Wraps 32 code bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// The code bytes. Handle with care: copies are not wiped.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// A new code: 32 bytes drawn from `rng` (Р5, Ф27, Ф31).
    pub fn generate(_rng: &mut dyn Random) -> Self {
        todo!("Р5, Ф27, Ф31: 32 random bytes")
    }

    /// The printable form: 56 uppercase symbols in 14 groups of 4 joined by `-`, with a
    /// 20-bit checksum in the last group (О3, Ф28–Ф30).
    pub fn to_display(&self) -> String {
        todo!("О3, Ф28–Ф30: Crockford base32 with checksum")
    }

    /// Reads a code typed or pasted by the user: separators and case are ignored, `O → 0`,
    /// `I` and `L → 1`; any other symbol outside the alphabet, a wrong length, non-zero padding
    /// bits or a wrong checksum is an error (О3, Ф30).
    pub fn parse(_text: &str) -> Result<Self, RecoveryCodeError> {
        todo!("О3, Ф30: parse and verify the recovery code")
    }
}

impl fmt::Debug for RecoveryCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RecoveryCode([redacted])")
    }
}
