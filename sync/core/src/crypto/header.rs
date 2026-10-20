//! The encrypted item header (Р2, Р6, Р13; format: Ф14–Ф19).
//!
//! The header holds everything the server must not see: path, type, size, content hash and the
//! reference to the body. It is encrypted with the key derived from VK and bound to the space,
//! the item, the key epoch and the version, so the server can neither swap headers between items
//! nor present an old header as a new version (Р6).

use std::collections::BTreeMap;

use serde_json::Value;

use super::error::CryptoError;
use super::keys::{BodyId, ItemId, SpaceId, SpaceKey};
use super::random::Random;

/// File or folder (Р2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    /// A file with a body.
    File,
    /// A folder: no body, kept so that empty folders arrive (Р2).
    Folder,
}

/// The decrypted header (Р2, Ф14).
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    /// Header format; `1` (Ф14). Newer formats are not understood (Р13).
    pub format: u64,
    /// Version of the item on the server; equals the version in the AAD (Ф19).
    pub version: u64,
    /// File or folder.
    pub kind: ItemKind,
    /// Path relative to the vault root, NFC, `/` separators (Р9, Ф19).
    pub path: String,
    /// Size of the content in bytes (0 for folders).
    pub size: u64,
    /// Modification time, informational only (Р3: time never decides).
    pub mtime_ms: i64,
    /// BLAKE3 of the content; `None` for folders.
    pub content_hash: Option<[u8; 32]>,
    /// The body this version points to; `None` for folders.
    pub body_id: Option<BodyId>,
    /// The item is deleted (Р6, «Удаление»).
    pub deleted: bool,
    /// Fields written by newer versions of Amby: kept as they are (Р13, Ф14). Integers only.
    pub extra: BTreeMap<String, Value>,
}

/// Canonical JSON of a header (Ф14, Ф15): known and unknown fields sorted by key, no spaces,
/// minimal escapes. A known key in `extra` is [`CryptoError::ReservedKey`], a path that breaks
/// the syntax rules of Ф33 is `InvalidPath` (checked first), a non-NFC path is `PathNotNfc`, a non-integer number in `extra` is `Malformed`. Р2, Р6, Р13.
pub fn canonical_header_json(_header: &Header) -> Result<Vec<u8>, CryptoError> {
    todo!("Р6, Ф14–Ф16: canonical header JSON")
}

/// Parses header JSON (without the padding): checks types, lowercase hex of `content_hash` and
/// `body_id`, `kind`, `format`. A format above 1 is `UnsupportedFormat` (Р13), a bad path is `InvalidPath` (Ф33) or,
/// if only not NFC, `PathNotNfc`; a repeated key in any object (Ф16) and anything else wrong is
/// `Malformed`. Unknown fields go to `extra`. This is a
/// fuzzing target (Р6, С5).
pub fn parse_header_json(_json: &[u8]) -> Result<Header, CryptoError> {
    todo!("Р6, Р13, Ф14–Ф19: parse header JSON")
}

/// Encrypts a header into an envelope: `0x01 ‖ epoch ‖ nonce ‖ ciphertext ‖ tag` (Ф18). The JSON
/// is padded with zeros to a multiple of 256 bytes (Ф17); the AAD binds the space, the item, the
/// epoch of `vk` and `header.version`. Draws one nonce (Ф31). Р2, Р6.
pub fn seal_header(
    _vk: &SpaceKey,
    _space: &SpaceId,
    _item: &ItemId,
    _header: &Header,
    _rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    todo!("Р2, Р6, Ф17, Ф18: seal header")
}

/// Decrypts the envelope of `item` at `version` (the one the server announced). Fails with
/// `Authentication` for any change of the data, another item, space, version or key; with
/// `EpochMismatch` if the epoch in the envelope is not the epoch of `vk`; `UnsupportedVersion`
/// for another envelope version; `BadPadding`, `VersionMismatch`, `UnsupportedFormat`, `Malformed`,
/// `InvalidPath` and `PathNotNfc` for what is inside (Ф17–Ф19, Ф33). Nothing is returned on error (С5, С6). This is
/// a fuzzing target.
pub fn open_header(
    _vk: &SpaceKey,
    _space: &SpaceId,
    _item: &ItemId,
    _version: u64,
    _envelope: &[u8],
) -> Result<Header, CryptoError> {
    todo!("Р6, Р13, С5, С6, Ф17–Ф19: open header")
}

/// The epoch stored in an envelope, to pick the right VK before opening it (Ф18). Epoch 0 is
/// `Malformed`.
pub fn header_envelope_epoch(_envelope: &[u8]) -> Result<u32, CryptoError> {
    todo!("Ф18: read the epoch of an envelope")
}
