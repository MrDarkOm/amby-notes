//! The encrypted item body in STREAM mode (Р6; format: Ф20–Ф25).
//!
//! The content is padded with zeros to the Padmé size and encrypted in 64 KiB chunks. After
//! decryption the content is checked against the header; on any error nothing is returned, so
//! nothing reaches the disk (Р6, С5).

use chacha20poly1305::aead::stream::{DecryptorBE32, EncryptorBE32};
use chacha20poly1305::aead::{KeyInit, Payload};
use chacha20poly1305::XChaCha20Poly1305;
use zeroize::Zeroizing;

use super::error::CryptoError;
use super::keys::{BodyId, SpaceKey};
use super::padme::{padme, sealed_body_len, MAX_SIZE};
use super::primitives::{blake3_hash, derive_key, TAG_LEN};
use super::random::Random;

/// Plaintext size of one chunk except the last (Ф21).
pub const CHUNK_SIZE: usize = 65_536;
/// Length of the preamble: magic, version, epoch, nonce prefix (Ф23).
pub const PREAMBLE_LEN: usize = 32;
/// The magic at the start of every body.
pub const MAGIC: &[u8; 8] = b"AMBYBODY";

/// Version byte of the body (Ф4).
const BODY_VERSION: u8 = 1;
/// Length of the random nonce prefix of the STREAM construction (Ф23).
const NONCE_PREFIX_LEN: usize = 19;
/// Length of a sealed chunk that is not the last one (Ф24).
const SEALED_CHUNK_LEN: usize = CHUNK_SIZE + TAG_LEN;
const INFO_BODY: &[u8] = b"amby-sync/body/1";

/// The key of one body: `HKDF(VK, "amby-sync/body/1" ‖ body_id)` (Ф20).
fn body_cipher(vk: &SpaceKey, body_id: &BodyId) -> XChaCha20Poly1305 {
    let mut info = Vec::with_capacity(INFO_BODY.len() + 16);
    info.extend_from_slice(INFO_BODY);
    info.extend_from_slice(body_id.as_bytes());
    let key = derive_key(vk.as_bytes(), &info);
    XChaCha20Poly1305::new((&*key).into())
}

/// Encrypts `content` into a body of the key `body_id` of `vk` (Ф20–Ф24). The content is not
/// changed, only padded with zeros after it (О7, Ф22). Draws a 19-byte nonce prefix (Ф31). The
/// length of the result is [`super::padme::sealed_body_len`]. Р6, О1, О7.
pub fn seal_body(
    vk: &SpaceKey,
    body_id: &BodyId,
    content: &[u8],
    rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    if vk.epoch() == 0 {
        return Err(CryptoError::InvalidParams("key epoch starts at 1"));
    }
    let size = u64::try_from(content.len()).map_err(|_| CryptoError::SizeTooLarge)?;
    let padded_len = usize::try_from(padme(size)?).map_err(|_| CryptoError::SizeTooLarge)?;
    let sealed_len =
        usize::try_from(sealed_body_len(size)?).map_err(|_| CryptoError::SizeTooLarge)?;

    let mut prefix = [0u8; NONCE_PREFIX_LEN];
    rng.fill(&mut prefix);
    let mut preamble = Vec::with_capacity(PREAMBLE_LEN);
    preamble.extend_from_slice(MAGIC);
    preamble.push(BODY_VERSION);
    preamble.extend_from_slice(&vk.epoch().to_be_bytes());
    preamble.extend_from_slice(&prefix);

    let mut encryptor = EncryptorBE32::from_aead(body_cipher(vk, body_id), (&prefix).into());
    let mut sealed = Vec::with_capacity(sealed_len);
    sealed.extend_from_slice(&preamble);
    // At least one chunk, even for an empty file (Ф21); the last one carries the flag.
    let chunks = padded_len.div_ceil(CHUNK_SIZE).max(1);
    // The padded content is the content followed by zeros (Ф22); a chunk is assembled when it
    // is needed, so the padded copy of the whole file never exists.
    let chunk = |index: usize| {
        let start = index * CHUNK_SIZE;
        let end = (start + CHUNK_SIZE).min(padded_len);
        let mut plain = Zeroizing::new(vec![0u8; end - start]);
        let from = start.min(content.len());
        let to = end.min(content.len());
        plain[..to - from].copy_from_slice(&content[from..to]);
        plain
    };
    let too_many = CryptoError::InvalidParams("body has too many chunks");
    for index in 0..chunks - 1 {
        let plain = chunk(index);
        let sealed_chunk = encryptor
            .encrypt_next(Payload {
                msg: &plain,
                aad: &preamble,
            })
            .map_err(|_| too_many.clone())?;
        sealed.extend_from_slice(&sealed_chunk);
    }
    let plain = chunk(chunks - 1);
    let sealed_chunk = encryptor
        .encrypt_last(Payload {
            msg: &plain,
            aad: &preamble,
        })
        .map_err(|_| too_many)?;
    sealed.extend_from_slice(&sealed_chunk);
    Ok(sealed)
}

/// Decrypts a body and verifies it against the header (`size`, `content_hash`).
///
/// In order: `size` above 2^62 (`SizeTooLarge`, checked first), magic and version (`Malformed`,
/// `UnsupportedVersion`), epoch, zero included (`EpochMismatch`),
/// authenticity of every chunk including order and the last one (`Authentication`), length
/// `padme(size)` (`LengthMismatch`), zero padding (`PaddingNotZero`), BLAKE3 equals
/// `content_hash` (`HashMismatch`). Returns exactly the original bytes (О7). Nothing is returned
/// on error (С5). This is a fuzzing target. Р6, Ф22–Ф25.
pub fn open_body(
    vk: &SpaceKey,
    body_id: &BodyId,
    size: u64,
    content_hash: &[u8; 32],
    sealed: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if size > MAX_SIZE {
        return Err(CryptoError::SizeTooLarge);
    }
    // Ф25: magic, version, epoch, in this order and before any decryption.
    if sealed.get(..MAGIC.len()) != Some(MAGIC.as_slice()) {
        return Err(CryptoError::Malformed("body has no AMBYBODY magic"));
    }
    let Some(&version) = sealed.get(MAGIC.len()) else {
        return Err(CryptoError::Malformed("body is cut off in the preamble"));
    };
    if version != BODY_VERSION {
        return Err(CryptoError::UnsupportedVersion(version));
    }
    let epoch: [u8; 4] = sealed
        .get(9..13)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(CryptoError::Malformed("body is cut off in the preamble"))?;
    if u32::from_be_bytes(epoch) != vk.epoch() {
        return Err(CryptoError::EpochMismatch);
    }
    let (preamble, mut rest) = sealed
        .split_at_checked(PREAMBLE_LEN)
        .ok_or(CryptoError::Malformed("body is cut off in the preamble"))?;
    let mut prefix = [0u8; NONCE_PREFIX_LEN];
    prefix.copy_from_slice(&preamble[13..]);

    let mut decryptor = DecryptorBE32::from_aead(body_cipher(vk, body_id), (&prefix).into());
    let mut padded = Zeroizing::new(Vec::with_capacity(sealed.len() - PREAMBLE_LEN));
    // Ф24: full chunks while more than one full chunk remains, the rest is the last chunk.
    while rest.len() > SEALED_CHUNK_LEN {
        let (chunk, tail) = rest.split_at(SEALED_CHUNK_LEN);
        let plain = Zeroizing::new(
            decryptor
                .decrypt_next(Payload {
                    msg: chunk,
                    aad: preamble,
                })
                .map_err(|_| CryptoError::Authentication)?,
        );
        padded.extend_from_slice(&plain);
        rest = tail;
    }
    if rest.len() < TAG_LEN {
        return Err(CryptoError::Authentication);
    }
    let plain = Zeroizing::new(
        decryptor
            .decrypt_last(Payload {
                msg: rest,
                aad: preamble,
            })
            .map_err(|_| CryptoError::Authentication)?,
    );
    padded.extend_from_slice(&plain);

    // Ф22: length, zero padding, hash.
    if u64::try_from(padded.len()).ok() != Some(padme(size)?) {
        return Err(CryptoError::LengthMismatch);
    }
    // `size <= padme(size) == padded.len()`, so the split cannot fail.
    let (content, padding) = padded.split_at(size as usize);
    if padding.iter().any(|byte| *byte != 0) {
        return Err(CryptoError::PaddingNotZero);
    }
    if blake3_hash(content) != *content_hash {
        return Err(CryptoError::HashMismatch);
    }
    Ok(content.to_vec())
}
