//! Opening a body as a stream (Ф24, Д68, С5): the requirement of Э3 on top of `open_body`.

use std::io::{Read, Write};

use chacha20poly1305::aead::stream::DecryptorBE32;
use chacha20poly1305::aead::Payload;
use zeroize::Zeroizing;

use crate::crypto::body::{
    body_cipher, BODY_VERSION, MAGIC, NONCE_PREFIX_LEN, PREAMBLE_LEN, SEALED_CHUNK_LEN,
};
use crate::crypto::error::CryptoError;
use crate::crypto::keys::{BodyId, SpaceKey};
use crate::crypto::padme::{padme, MAX_SIZE};
use crate::crypto::primitives::TAG_LEN;

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
    vk: &SpaceKey,
    body_id: &BodyId,
    size: u64,
    content_hash: &[u8; 32],
    source: &mut dyn Read,
    sink: &mut dyn Write,
) -> Result<(), StreamError> {
    let crypto = StreamError::Crypto;
    if size > MAX_SIZE {
        return Err(crypto(CryptoError::SizeTooLarge));
    }
    // Ф25: magic, version, epoch, in this order and before any decryption.
    let mut preamble = [0u8; PREAMBLE_LEN];
    let got = read_up_to(source, &mut preamble)?;
    let head = &preamble[..got];
    if head.get(..MAGIC.len()) != Some(MAGIC.as_slice()) {
        return Err(crypto(CryptoError::Malformed("body has no AMBYBODY magic")));
    }
    let Some(&version) = head.get(MAGIC.len()) else {
        return Err(crypto(CryptoError::Malformed(
            "body is cut off in the preamble",
        )));
    };
    if version != BODY_VERSION {
        return Err(crypto(CryptoError::UnsupportedVersion(version)));
    }
    let epoch: [u8; 4] = head
        .get(9..13)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(crypto(CryptoError::Malformed(
            "body is cut off in the preamble",
        )))?;
    if u32::from_be_bytes(epoch) != vk.epoch() {
        return Err(crypto(CryptoError::EpochMismatch));
    }
    if got < PREAMBLE_LEN {
        return Err(crypto(CryptoError::Malformed(
            "body is cut off in the preamble",
        )));
    }
    let mut prefix = [0u8; NONCE_PREFIX_LEN];
    prefix.copy_from_slice(&preamble[13..]);
    let mut decryptor = Some(DecryptorBE32::from_aead(
        body_cipher(vk, body_id),
        (&prefix).into(),
    ));
    let no_decryptor = || crypto(CryptoError::Authentication);

    // `buffer` holds at most one full chunk plus one byte: the extra byte tells whether the chunk
    // is the last one (Ф24: full chunks while more than one full chunk remains).
    let mut buffer = Zeroizing::new(vec![0u8; SEALED_CHUNK_LEN + 1]);
    let mut filled = 0usize;
    let mut hasher = blake3::Hasher::new();
    let mut offset = 0u64; // position in the padded content
    let mut padding_is_zero = true;
    loop {
        filled += read_up_to(source, &mut buffer[filled..])?;
        let last = filled <= SEALED_CHUNK_LEN;
        let plain = if last {
            if filled < TAG_LEN {
                return Err(crypto(CryptoError::Authentication));
            }
            Zeroizing::new(
                decryptor
                    .take()
                    .ok_or_else(no_decryptor)?
                    .decrypt_last(Payload {
                        msg: &buffer[..filled],
                        aad: &preamble,
                    })
                    .map_err(|_| crypto(CryptoError::Authentication))?,
            )
        } else {
            Zeroizing::new(
                decryptor
                    .as_mut()
                    .ok_or_else(no_decryptor)?
                    .decrypt_next(Payload {
                        msg: &buffer[..SEALED_CHUNK_LEN],
                        aad: &preamble,
                    })
                    .map_err(|_| crypto(CryptoError::Authentication))?,
            )
        };
        // Only authenticated bytes go further. The content part goes to the sink, the rest must
        // be zeros (Ф22); the checks come after the last chunk, as in `open_body`.
        let in_content = size.saturating_sub(offset).min(plain.len() as u64) as usize;
        let (content, padding) = plain.split_at(in_content);
        if !content.is_empty() {
            hasher.update(content);
            sink.write_all(content).map_err(StreamError::Write)?;
        }
        if padding.iter().any(|byte| *byte != 0) {
            padding_is_zero = false;
        }
        offset += plain.len() as u64;
        if last {
            break;
        }
        buffer.copy_within(SEALED_CHUNK_LEN..filled, 0);
        filled -= SEALED_CHUNK_LEN;
    }
    if padme(size).ok() != Some(offset) {
        return Err(crypto(CryptoError::LengthMismatch));
    }
    if !padding_is_zero {
        return Err(crypto(CryptoError::PaddingNotZero));
    }
    if hasher.finalize().as_bytes() != content_hash {
        return Err(crypto(CryptoError::HashMismatch));
    }
    Ok(())
}

/// Reads until `buffer` is full or the source ends; a failing source is [`StreamError::Read`].
fn read_up_to(source: &mut dyn Read, buffer: &mut [u8]) -> Result<usize, StreamError> {
    let mut filled = 0;
    while filled < buffer.len() {
        match source.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(StreamError::Read(e)),
        }
    }
    Ok(filled)
}
