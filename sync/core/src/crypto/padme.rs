//! Padmé: the padded size of a body (Р6, Ф26).

use super::body::{CHUNK_SIZE, PREAMBLE_LEN};
use super::error::CryptoError;
use super::primitives::TAG_LEN;

/// The largest size the format accepts (Ф26).
pub(crate) const MAX_SIZE: u64 = 1 << 62;

/// Padmé of `len` (Nikitin et al., PETS 2019, algorithm 1): the length the content is padded
/// with zeros to. `padme(len) - len` is at most 12% of `len`. `len` above 2^62 is
/// [`CryptoError::SizeTooLarge`] (no panic, no overflow); 2^62 itself is valid. Р6, Ф26.
pub fn padme(len: u64) -> Result<u64, CryptoError> {
    if len > MAX_SIZE {
        return Err(CryptoError::SizeTooLarge);
    }
    if len < 2 {
        return Ok(len);
    }
    let exponent = len.ilog2();
    let significant_bits = exponent.ilog2() + 1;
    let zeroed_bits = exponent - significant_bits;
    let mask = (1u64 << zeroed_bits) - 1;
    // `len <= 2^62` and `mask < 2^57`: the sum cannot overflow.
    Ok((len + mask) & !mask)
}

/// Length in bytes of the sealed body (preamble, chunks and tags) of a file of `size` bytes.
/// This is what the server sees (О2). `size` above 2^62 is `SizeTooLarge`. Р6, Ф21, Ф26.
pub fn sealed_body_len(size: u64) -> Result<u64, CryptoError> {
    let padded = padme(size)?;
    let chunks = padded.div_ceil(CHUNK_SIZE as u64).max(1);
    // `padded <= 2^62` and `chunks <= 2^46`: no overflow.
    Ok(PREAMBLE_LEN as u64 + padded + TAG_LEN as u64 * chunks)
}
