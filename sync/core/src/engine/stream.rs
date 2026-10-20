//! Opening a body as a stream (Ф24, Д68, С5): the requirement of Э3 on top of `open_body`.

use std::io::{Read, Write};

use crate::crypto::error::CryptoError;
use crate::crypto::keys::{BodyId, SpaceKey};

/// Why a stream open failed (Д68).
#[derive(Debug, thiserror::Error)]
pub enum StreamError {
    /// The data did not pass a check of Ф22–Ф25: the same kind of error as `open_body` gives
    /// (С5). Whatever was already written to the sink must be thrown away.
    #[error("body rejected: {0}")]
    Crypto(CryptoError),
    /// Reading the source failed (a cut connection): not an authentication error (С1).
    #[error("reading the body failed: {0}")]
    Read(std::io::Error),
    /// Writing the sink failed (a full disk, С4).
    #[error("writing the content failed: {0}")]
    Write(std::io::Error),
}

/// Reads a sealed body from `source` chunk by chunk and writes the **content** (without the
/// padding) to `sink` (Ф24, Д68). `Ok` means everything was verified: authenticity of every chunk
/// and the last one, length `padme(size)`, zero padding, BLAKE3 equals `content_hash`. After an
/// error the sink may hold a prefix of the content and the caller throws it away. Memory is
/// bounded by two chunks whatever the size, and no write to the sink is longer than 64 KiB. It
/// agrees with `open_body` of Э1 on every input: same content where that answers `Ok`, the same
/// kind of error where it fails. Р6, О7, С5, Ф22–Ф25, Д68.
pub fn open_body_stream(
    _vk: &SpaceKey,
    _body_id: &BodyId,
    _size: u64,
    _content_hash: &[u8; 32],
    _source: &mut dyn Read,
    _sink: &mut dyn Write,
) -> Result<(), StreamError> {
    todo!("Р6, О7, С5, Ф24, Д68: open a body as a stream")
}
