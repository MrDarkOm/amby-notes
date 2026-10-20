//! Padmé: the padded size of a body (Р6, Ф26).

use super::body::{CHUNK_SIZE, PREAMBLE_LEN};
use super::primitives::TAG_LEN;

/// Padmé of `len` (Nikitin et al., PETS 2019, algorithm 1): the length the content is padded
/// with zeros to. `padme(len) - len` is at most 12% of `len`. Р6, Ф26.
pub fn padme(_len: u64) -> u64 {
    todo!("Р6, Ф26: Padmé")
}

/// Length in bytes of the sealed body (preamble, chunks and tags) of a file of `size` bytes.
/// This is what the server sees (О2). Р6, Ф21, Ф26.
pub fn sealed_body_len(_size: u64) -> u64 {
    let _ = (CHUNK_SIZE, PREAMBLE_LEN, TAG_LEN);
    todo!("Р6, Ф21, Ф26: 32 + P + 16 * max(1, ceil(P / 65536))")
}
