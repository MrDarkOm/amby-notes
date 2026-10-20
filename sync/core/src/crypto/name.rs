//! Names of a device and of a space, encrypted with the account key (Ф34, П12, П20).
//!
//! The server stores these envelopes as they are and only checks the length: exactly
//! [`NAME_ENVELOPE_LEN`] bytes. The name key is `HKDF(AK, "amby-sync/name-key/1")`; AK itself is
//! never used as a cipher key.

use zeroize::Zeroizing;

use super::error::CryptoError;
use super::keys::{AccountKey, SpaceId};
use super::primitives::{derive_key, xchacha20poly1305_open, xchacha20poly1305_seal, XNONCE_LEN};
use super::random::Random;

/// Length of every name envelope: `0x01 ‖ nonce (24) ‖ ciphertext (64) ‖ tag (16)` (Ф34).
pub const NAME_ENVELOPE_LEN: usize = 105;
/// The longest name in UTF-8 bytes (Ф34).
pub const NAME_MAX_BYTES: usize = 64;

/// Version byte of a name envelope (Ф4).
const NAME_VERSION: u8 = 1;
const INFO_NAME_KEY: &[u8] = b"amby-sync/name-key/1";
const AAD_DEVICE_NAME: &[u8] = b"amby-sync/device-name/1";
const AAD_SPACE_NAME: &[u8] = b"amby-sync/space-name/1";

/// The AAD of a space name: label and `space_id` (Ф34).
fn space_aad(space: &SpaceId) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_SPACE_NAME.len() + 16);
    aad.extend_from_slice(AAD_SPACE_NAME);
    aad.extend_from_slice(space.as_bytes());
    aad
}

/// Seals `name` under the name key of `ak` with `aad` (Ф34). Draws one nonce, and only after the
/// name has been accepted (Ф31).
fn seal_name(
    ak: &AccountKey,
    aad: &[u8],
    name: &str,
    rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    if name.len() > NAME_MAX_BYTES {
        return Err(CryptoError::InvalidParams("a name is at most 64 bytes"));
    }
    if name.as_bytes().contains(&0) {
        return Err(CryptoError::InvalidParams(
            "a name cannot contain a zero byte",
        ));
    }
    let mut plain = Zeroizing::new([0u8; NAME_MAX_BYTES]);
    plain[..name.len()].copy_from_slice(name.as_bytes());
    let key = derive_key(ak.as_bytes(), INFO_NAME_KEY);
    let mut nonce = [0u8; XNONCE_LEN];
    rng.fill(&mut nonce);
    let sealed = xchacha20poly1305_seal(&key, &nonce, aad, &*plain);
    let mut envelope = Vec::with_capacity(NAME_ENVELOPE_LEN);
    envelope.push(NAME_VERSION);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&sealed);
    Ok(envelope)
}

/// The reverse of [`seal_name`]. Order of checks: length, version byte (told apart from an
/// authentication failure, Ф4), tag, then the content of the name.
fn open_name(ak: &AccountKey, aad: &[u8], envelope: &[u8]) -> Result<String, CryptoError> {
    if envelope.len() != NAME_ENVELOPE_LEN {
        return Err(CryptoError::Malformed("a name envelope is 105 bytes"));
    }
    if envelope[0] != NAME_VERSION {
        return Err(CryptoError::UnsupportedVersion(envelope[0]));
    }
    let key = derive_key(ak.as_bytes(), INFO_NAME_KEY);
    let mut nonce = [0u8; XNONCE_LEN];
    nonce.copy_from_slice(&envelope[1..=XNONCE_LEN]);
    let plain = Zeroizing::new(xchacha20poly1305_open(
        &key,
        &nonce,
        aad,
        &envelope[1 + XNONCE_LEN..],
    )?);
    // The padding is zeros; the name ends at the last non-zero byte and holds no zero (Ф34).
    let end = plain
        .iter()
        .rposition(|&byte| byte != 0)
        .map_or(0, |last| last + 1);
    let name = &plain[..end];
    if name.contains(&0) {
        return Err(CryptoError::Malformed("a zero byte inside a name"));
    }
    String::from_utf8(name.to_vec()).map_err(|_| CryptoError::Malformed("a name is not UTF-8"))
}

/// Encrypts the name of a device (Ф34). Draws one 24-byte nonce (Ф31, Ф34). A name longer than
/// [`NAME_MAX_BYTES`] bytes or with a zero byte inside is `InvalidParams`, and no random byte is
/// drawn then. О1, О2.
pub fn seal_device_name(
    ak: &AccountKey,
    name: &str,
    rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    seal_name(ak, AAD_DEVICE_NAME, name, rng)
}

/// Decrypts the name of a device (Ф34). The version byte is told apart from an authentication
/// failure (Ф4); a wrong length, a zero inside the name or bytes that are not UTF-8 are
/// `Malformed`; a wrong AK, a tampered envelope or an envelope of a space is `Authentication`.
pub fn open_device_name(ak: &AccountKey, envelope: &[u8]) -> Result<String, CryptoError> {
    open_name(ak, AAD_DEVICE_NAME, envelope)
}

/// Encrypts the name of a space; the AAD contains `space_id`, so the name cannot be moved to
/// another space (Ф34, П20). Same errors and the same single nonce as [`seal_device_name`].
pub fn seal_space_name(
    ak: &AccountKey,
    space: &SpaceId,
    name: &str,
    rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    seal_name(ak, &space_aad(space), name, rng)
}

/// Decrypts the name of a space of `space` (Ф34). Errors as in [`open_device_name`]; an envelope
/// of another space is `Authentication`.
pub fn open_space_name(
    ak: &AccountKey,
    space: &SpaceId,
    envelope: &[u8],
) -> Result<String, CryptoError> {
    open_name(ak, &space_aad(space), envelope)
}
