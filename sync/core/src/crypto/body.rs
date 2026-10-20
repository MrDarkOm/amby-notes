//! The encrypted item body in STREAM mode (Р6; format: Ф20–Ф25).
//!
//! The content is padded with zeros to the Padmé size and encrypted in 64 KiB chunks. After
//! decryption the content is checked against the header; on any error nothing is returned, so
//! nothing reaches the disk (Р6, С5).

use super::error::CryptoError;
use super::keys::{BodyId, SpaceKey};
use super::random::Random;

/// Plaintext size of one chunk except the last (Ф21).
pub const CHUNK_SIZE: usize = 65_536;
/// Length of the preamble: magic, version, epoch, nonce prefix (Ф23).
pub const PREAMBLE_LEN: usize = 32;
/// The magic at the start of every body.
pub const MAGIC: &[u8; 8] = b"AMBYBODY";

/// Encrypts `content` into a body of the key `body_id` of `vk` (Ф20–Ф24). The content is not
/// changed, only padded with zeros after it (О7, Ф22). Draws a 19-byte nonce prefix (Ф31). The
/// length of the result is [`super::padme::sealed_body_len`]. Р6, О1, О7.
pub fn seal_body(
    _vk: &SpaceKey,
    _body_id: &BodyId,
    _content: &[u8],
    _rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    todo!("Р6, О1, О7, Ф20–Ф24: seal body")
}

/// Decrypts a body and verifies it against the header (`size`, `content_hash`).
///
/// In order: magic and version (`Malformed`, `UnsupportedVersion`), epoch (`EpochMismatch`),
/// authenticity of every chunk including order and the last one (`Authentication`), length
/// `padme(size)` (`LengthMismatch`), zero padding (`PaddingNotZero`), BLAKE3 equals
/// `content_hash` (`HashMismatch`). Returns exactly the original bytes (О7). Nothing is returned
/// on error (С5). This is a fuzzing target. Р6, Ф22–Ф25.
pub fn open_body(
    _vk: &SpaceKey,
    _body_id: &BodyId,
    _size: u64,
    _content_hash: &[u8; 32],
    _sealed: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    todo!("Р6, О7, С5, Ф22–Ф25: open body")
}
