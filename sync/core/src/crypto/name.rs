//! Names of a device and of a space, encrypted with the account key (Ф34, П12, П20).
//!
//! The server stores these envelopes as they are and only checks the length: exactly
//! [`NAME_ENVELOPE_LEN`] bytes. The name key is `HKDF(AK, "amby-sync/name-key/1")`; AK itself is
//! never used as a cipher key.

use super::error::CryptoError;
use super::keys::{AccountKey, SpaceId};
use super::random::Random;

/// Length of every name envelope: `0x01 ‖ nonce (24) ‖ ciphertext (64) ‖ tag (16)` (Ф34).
pub const NAME_ENVELOPE_LEN: usize = 105;
/// The longest name in UTF-8 bytes (Ф34).
pub const NAME_MAX_BYTES: usize = 64;

/// Encrypts the name of a device (Ф34). Draws one 24-byte nonce (Ф31, Ф34). A name longer than
/// [`NAME_MAX_BYTES`] bytes or with a zero byte inside is `InvalidParams`, and no random byte is
/// drawn then. О1, О2.
pub fn seal_device_name(
    ak: &AccountKey,
    name: &str,
    rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    let _ = (ak, name, rng);
    todo!("Ф34")
}

/// Decrypts the name of a device (Ф34). The version byte is told apart from an authentication
/// failure (Ф4); a wrong length, a zero inside the name or bytes that are not UTF-8 are
/// `Malformed`; a wrong AK, a tampered envelope or an envelope of a space is `Authentication`.
pub fn open_device_name(ak: &AccountKey, envelope: &[u8]) -> Result<String, CryptoError> {
    let _ = (ak, envelope);
    todo!("Ф34")
}

/// Encrypts the name of a space; the AAD contains `space_id`, so the name cannot be moved to
/// another space (Ф34, П20). Same errors and the same single nonce as [`seal_device_name`].
pub fn seal_space_name(
    ak: &AccountKey,
    space: &SpaceId,
    name: &str,
    rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    let _ = (ak, space, name, rng);
    todo!("Ф34")
}

/// Decrypts the name of a space of `space` (Ф34). Errors as in [`open_device_name`]; an envelope
/// of another space is `Authentication`.
pub fn open_space_name(
    ak: &AccountKey,
    space: &SpaceId,
    envelope: &[u8],
) -> Result<String, CryptoError> {
    let _ = (ak, space, envelope);
    todo!("Ф34")
}
