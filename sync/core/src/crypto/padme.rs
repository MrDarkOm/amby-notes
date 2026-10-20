//! Padmé: the padded size of a body (Р6, Ф26).

use super::body::{CHUNK_SIZE, PREAMBLE_LEN};
use super::error::CryptoError;
use super::primitives::TAG_LEN;

/// Padmé of `len` (Nikitin et al., PETS 2019, algorithm 1): the length the content is padded
/// with zeros to. `padme(len) - len` is at most 12% of `len`. `len` above 2^62 is
/// [`CryptoError::SizeTooLarge`] (no panic, no overflow); 2^62 itself is valid. Р6, Ф26.
pub fn padme(_len: u64) -> Result<u64, CryptoError> {
    todo!("Р6, Ф26: Padmé")
}

/// Length in bytes of the sealed body (preamble, chunks and tags) of a file of `size` bytes.
/// This is what the server sees (О2). `size` above 2^62 is `SizeTooLarge`. Р6, Ф21, Ф26.
pub fn sealed_body_len(_size: u64) -> Result<u64, CryptoError> {
    let _ = (CHUNK_SIZE, PREAMBLE_LEN, TAG_LEN);
    todo!("Р6, Ф21, Ф26: 32 + P + 16 * max(1, ceil(P / 65536))")
}
