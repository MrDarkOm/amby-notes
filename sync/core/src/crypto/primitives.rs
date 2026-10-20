//! Thin wrappers of the standard primitives (Р6). They exist so that the primitives can be
//! checked against the vectors of the standards through the same code the format uses.

use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

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
    input: &Argon2Input<'_>,
    params: &Argon2Params,
    output_len: usize,
) -> Result<Vec<u8>, CryptoError> {
    const BAD: CryptoError = CryptoError::InvalidParams("Argon2id parameters are not usable");
    let associated_data = AssociatedData::new(input.associated_data).map_err(|_| BAD)?;
    let built = ParamsBuilder::new()
        .m_cost(params.memory_kib)
        .t_cost(params.iterations)
        .p_cost(params.parallelism)
        .data(associated_data)
        .output_len(output_len)
        .build()
        .map_err(|_| BAD)?;
    let argon2 = Argon2::new_with_secret(input.secret, Algorithm::Argon2id, Version::V0x13, built)
        .map_err(|_| BAD)?;
    let mut output = vec![0u8; output_len];
    if argon2
        .hash_password_into(input.password, input.salt, &mut output)
        .is_err()
    {
        return Err(BAD);
    }
    Ok(output)
}

/// HKDF with SHA-256 (RFC 5869): extract with `salt` (empty = `HashLen` zeros) then expand with
/// `info` to `len` bytes. Р5, Р6, Ф9.
pub fn hkdf_sha256(
    salt: &[u8],
    ikm: &[u8],
    info: &[u8],
    len: usize,
) -> Result<Vec<u8>, CryptoError> {
    // An empty salt and `None` mean the same in RFC 5869: `HashLen` zero bytes.
    let hkdf = Hkdf::<Sha256>::new((!salt.is_empty()).then_some(salt), ikm);
    let mut output = vec![0u8; len];
    hkdf.expand(info, &mut output)
        .map_err(|_| CryptoError::InvalidParams("HKDF output is too long"))?;
    Ok(output)
}

/// HKDF-SHA-256 with an empty salt to one 32-byte key (Ф9, Ф10), wiped on drop.
pub(crate) fn derive_key(ikm: &[u8], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    // 32 bytes is far below the limit of 255 blocks: expansion cannot fail.
    if let Ok(okm) = hkdf_sha256(&[], ikm, info, 32).map(Zeroizing::new) {
        key.copy_from_slice(&okm);
    }
    key
}

/// XChaCha20-Poly1305 encryption; returns `ciphertext ‖ tag`. Р6.
pub fn xchacha20poly1305_seal(
    key: &[u8; 32],
    nonce: &[u8; XNONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.into());
    // Fails only for a plaintext of more than 2^36 bytes, which no in-memory caller reaches.
    cipher
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("plaintext is too long for XChaCha20-Poly1305")
}

/// XChaCha20-Poly1305 decryption of `ciphertext ‖ tag`; any change of key, nonce, AAD or data
/// is [`CryptoError::Authentication`]. Р6, С5.
pub fn xchacha20poly1305_open(
    key: &[u8; 32],
    nonce: &[u8; XNONCE_LEN],
    aad: &[u8],
    ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext_and_tag,
                aad,
            },
        )
        .map_err(|_| CryptoError::Authentication)
}

/// BLAKE3 hash (32 bytes) of the content (Р6, Ф14).
pub fn blake3_hash(data: &[u8]) -> [u8; 32] {
    *blake3::hash(data).as_bytes()
}

/// SHA-256 (32 bytes). Р5, Ф5.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}
