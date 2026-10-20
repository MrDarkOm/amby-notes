//! Thin wrappers of the standard primitives (Р6). They exist so that the primitives can be
//! checked against the vectors of the standards through the same code the format uses.

use super::account::Argon2Params;
use super::error::CryptoError;

/// Length of the XChaCha20-Poly1305 nonce.
pub const XNONCE_LEN: usize = 24;
/// Length of the Poly1305 authentication tag.
pub const TAG_LEN: usize = 16;

/// Inputs of one Argon2id computation (RFC 9106).
#[derive(Debug, Clone, Copy)]
pub struct Argon2Input<'a> {
    /// The password.
    pub password: &'a [u8],
    /// The salt (16 bytes in the format, Ф7).
    pub salt: &'a [u8],
    /// The optional secret; empty in the format.
    pub secret: &'a [u8],
    /// The optional associated data; empty in the format.
    pub associated_data: &'a [u8],
}

/// Argon2id version `0x13` (RFC 9106). Р5, Р6, Ф7.
///
/// Unlike the format (which has no `secret` and no associated data), this wrapper accepts both,
/// so that the RFC 9106 section 5.3 vector can run. The limits of Ф8 do not apply here; they are
/// in [`Argon2Params::validate`].
pub fn argon2id_raw(
    _input: &Argon2Input<'_>,
    _params: &Argon2Params,
    _output_len: usize,
) -> Result<Vec<u8>, CryptoError> {
    todo!("Р6, Ф7: Argon2id")
}

/// HKDF with SHA-256 (RFC 5869): extract with `salt` (empty = `HashLen` zeros) then expand with
/// `info` to `len` bytes. Р5, Р6, Ф9.
pub fn hkdf_sha256(
    _salt: &[u8],
    _ikm: &[u8],
    _info: &[u8],
    _len: usize,
) -> Result<Vec<u8>, CryptoError> {
    todo!("Р6, Ф9: HKDF-SHA-256")
}

/// XChaCha20-Poly1305 encryption; returns `ciphertext ‖ tag`. Р6.
pub fn xchacha20poly1305_seal(
    _key: &[u8; 32],
    _nonce: &[u8; XNONCE_LEN],
    _aad: &[u8],
    _plaintext: &[u8],
) -> Vec<u8> {
    todo!("Р6: XChaCha20-Poly1305 seal")
}

/// XChaCha20-Poly1305 decryption of `ciphertext ‖ tag`; any change of key, nonce, AAD or data
/// is [`CryptoError::Authentication`]. Р6, С5.
pub fn xchacha20poly1305_open(
    _key: &[u8; 32],
    _nonce: &[u8; XNONCE_LEN],
    _aad: &[u8],
    _ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    todo!("Р6, С5: XChaCha20-Poly1305 open")
}

/// BLAKE3 hash (32 bytes) of the content (Р6, Ф14).
pub fn blake3_hash(_data: &[u8]) -> [u8; 32] {
    todo!("Р6: BLAKE3")
}

/// SHA-256 (32 bytes). Р5, Ф5.
pub fn sha256(_data: &[u8]) -> [u8; 32] {
    todo!("Р5, Ф5: SHA-256")
}
