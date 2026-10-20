//! The encrypted item header (Р2, Р6, Р13; format: Ф14–Ф19).
//!
//! The header holds everything the server must not see: path, type, size, content hash and the
//! reference to the body. It is encrypted with the key derived from VK and bound to the space,
//! the item, the key epoch and the version, so the server can neither swap headers between items
//! nor present an old header as a new version (Р6).

use std::collections::BTreeMap;

use core::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use unicode_normalization::is_nfc;
use zeroize::Zeroizing;

use super::error::CryptoError;
use super::keys::{BodyId, ItemId, SpaceId, SpaceKey};
use super::primitives::{derive_key, xchacha20poly1305_open, xchacha20poly1305_seal, XNONCE_LEN};
use super::random::Random;

/// Version byte of the envelope (Ф4).
const ENVELOPE_VERSION: u8 = 1;
/// Version byte, epoch and nonce: what precedes the ciphertext (Ф18).
const ENVELOPE_HEAD_LEN: usize = 1 + 4 + XNONCE_LEN;
/// Length of the authentication tag.
const TAG_LEN: usize = 16;
/// The JSON is padded to a multiple of this many bytes (Ф17).
const PADDING_BLOCK: usize = 256;
/// The longest path in bytes (Ф33).
const MAX_PATH_LEN: usize = 4096;
/// The only header format this build understands (Ф14).
const FORMAT: u64 = 1;

const INFO_HEADER_KEY: &[u8] = b"amby-sync/header-key/1";
const AAD_HEADER: &[u8] = b"amby-sync/header/1";

/// Names of the fields with a meaning; the rest are unknown fields of newer versions (Ф14).
const KNOWN_KEYS: [&str; 9] = [
    "body_id",
    "content_hash",
    "deleted",
    "format",
    "kind",
    "mtime_ms",
    "path",
    "size",
    "version",
];

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
pub fn canonical_header_json(header: &Header) -> Result<Vec<u8>, CryptoError> {
    check_path(&header.path)?;
    if let Some(key) = header
        .extra
        .keys()
        .find(|key| KNOWN_KEYS.contains(&key.as_str()))
    {
        return Err(CryptoError::ReservedKey(key.clone()));
    }
    match header.format {
        FORMAT => {}
        0 => return Err(CryptoError::InvalidParams("header format starts at 1")),
        newer => return Err(CryptoError::UnsupportedFormat(newer)),
    }

    let mut fields: BTreeMap<&str, Value> = BTreeMap::new();
    fields.insert("format", Value::from(header.format));
    fields.insert("version", Value::from(header.version));
    fields.insert(
        "kind",
        Value::from(match header.kind {
            ItemKind::File => "file",
            ItemKind::Folder => "folder",
        }),
    );
    fields.insert("path", Value::from(header.path.as_str()));
    fields.insert("size", Value::from(header.size));
    fields.insert("mtime_ms", Value::from(header.mtime_ms));
    fields.insert(
        "content_hash",
        header
            .content_hash
            .as_ref()
            .map_or(Value::Null, |hash| Value::from(hex_encode(hash))),
    );
    fields.insert(
        "body_id",
        header
            .body_id
            .as_ref()
            .map_or(Value::Null, |id| Value::from(hex_encode(id.as_bytes()))),
    );
    fields.insert("deleted", Value::from(header.deleted));
    for (key, value) in &header.extra {
        fields.insert(key.as_str(), value.clone());
    }

    let mut out = Vec::with_capacity(256);
    out.push(b'{');
    for (index, (key, value)) in fields.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        write_string(&mut out, key);
        out.push(b':');
        write_value(&mut out, value)?;
    }
    out.push(b'}');
    Ok(out)
}

/// Path syntax (Ф33) and then NFC (Ф19). Rules of the concrete file system stay with the engine.
fn check_path(path: &str) -> Result<(), CryptoError> {
    let broken = path.is_empty()
        || path.len() > MAX_PATH_LEN
        || path.starts_with('/')
        || path.ends_with('/')
        || path
            .chars()
            .any(|c| c == '\\' || c <= '\u{1f}' || c == '\u{7f}')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..");
    if broken {
        return Err(CryptoError::InvalidPath);
    }
    if !is_nfc(path) {
        return Err(CryptoError::PathNotNfc);
    }
    Ok(())
}

/// Lowercase hex of `bytes` (Ф1).
fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from(DIGITS[usize::from(byte >> 4)]));
        text.push(char::from(DIGITS[usize::from(byte & 0x0F)]));
    }
    text
}

/// Lowercase hex of exactly `N` bytes; anything else is `None` (Ф14).
fn hex_decode<const N: usize>(text: &str) -> Option<[u8; N]> {
    let digits = text.as_bytes();
    if digits.len() != N * 2 {
        return None;
    }
    let value = |digit: u8| match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        _ => None,
    };
    let mut bytes = [0u8; N];
    for (byte, pair) in bytes.iter_mut().zip(digits.chunks_exact(2)) {
        *byte = (value(pair[0])? << 4) | value(pair[1])?;
    }
    Some(bytes)
}

/// Writes one JSON value in canonical form (Ф15). Numbers other than integers are refused.
fn write_value(out: &mut Vec<u8>, value: &Value) -> Result<(), CryptoError> {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(number) => {
            if number.is_f64() {
                return Err(CryptoError::Malformed(
                    "only integers are allowed in a header",
                ));
            }
            out.extend_from_slice(number.to_string().as_bytes());
        }
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_value(out, item)?;
            }
            out.push(b']');
        }
        Value::Object(object) => {
            let mut entries: Vec<(&String, &Value)> = object.iter().collect();
            entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            out.push(b'{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_string(out, key);
                out.push(b':');
                write_value(out, item)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

/// Writes a JSON string with the minimal escapes of Ф15.
fn write_string(out: &mut Vec<u8>, text: &str) {
    out.push(b'"');
    for c in text.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{8}' => out.extend_from_slice(b"\\b"),
            '\t' => out.extend_from_slice(b"\\t"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\u{c}' => out.extend_from_slice(b"\\f"),
            '\r' => out.extend_from_slice(b"\\r"),
            c if c <= '\u{1f}' => {
                out.extend_from_slice(format!("\\u{:04x}", u32::from(c)).as_bytes());
            }
            c => {
                let mut buffer = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    out.push(b'"');
}

/// A JSON value that refuses repeated keys and non-integer numbers while it is read (Ф15, Ф16).
struct Strict(Value);

impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(Strict)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value with integer numbers and no repeated keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_f64<E: serde::de::Error>(self, _value: f64) -> Result<Value, E> {
        Err(E::custom("only integers are allowed"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(Strict(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut object = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if object.contains_key(&key) {
                return Err(serde::de::Error::custom("repeated key"));
            }
            let Strict(value) = map.next_value()?;
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}

/// Parses header JSON (without the padding): checks types, lowercase hex of `content_hash` and
/// `body_id`, `kind`, `format`. A format above 1 is `UnsupportedFormat` (Р13), a bad path is `InvalidPath` (Ф33) or,
/// if only not NFC, `PathNotNfc`; a repeated key in any object (Ф16) and anything else wrong is
/// `Malformed`. Unknown fields go to `extra`. This is a
/// fuzzing target (Р6, С5).
pub fn parse_header_json(json: &[u8]) -> Result<Header, CryptoError> {
    const BAD: CryptoError = CryptoError::Malformed("header JSON is not valid");
    let Strict(value) = serde_json::from_slice(json).map_err(|_| BAD)?;
    let Value::Object(mut object) = value else {
        return Err(CryptoError::Malformed("header JSON is not an object"));
    };

    // A newer format may change the other fields, so it is judged first (Р13).
    let format = object
        .remove("format")
        .and_then(|value| value.as_u64())
        .ok_or(CryptoError::Malformed("header has no valid format"))?;
    if format > FORMAT {
        return Err(CryptoError::UnsupportedFormat(format));
    }
    if format != FORMAT {
        return Err(CryptoError::Malformed("header format starts at 1"));
    }

    let version = object
        .remove("version")
        .and_then(|value| value.as_u64())
        .ok_or(CryptoError::Malformed("header has no valid version"))?;
    let kind = match object.remove("kind").as_ref().and_then(Value::as_str) {
        Some("file") => ItemKind::File,
        Some("folder") => ItemKind::Folder,
        _ => return Err(CryptoError::Malformed("header has no valid kind")),
    };
    let path = match object.remove("path") {
        Some(Value::String(path)) => path,
        _ => return Err(CryptoError::Malformed("header has no valid path")),
    };
    let size = object
        .remove("size")
        .and_then(|value| value.as_u64())
        .ok_or(CryptoError::Malformed("header has no valid size"))?;
    let mtime_ms = object
        .remove("mtime_ms")
        .and_then(|value| value.as_i64())
        .ok_or(CryptoError::Malformed("header has no valid mtime_ms"))?;
    let content_hash = match object.remove("content_hash") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(
            hex_decode::<32>(&text)
                .ok_or(CryptoError::Malformed("content_hash is not 64 hex digits"))?,
        ),
        _ => return Err(CryptoError::Malformed("header has no valid content_hash")),
    };
    let body_id = match object.remove("body_id") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(BodyId::from_bytes(
            hex_decode::<16>(&text).ok_or(CryptoError::Malformed("body_id is not 32 hex digits"))?,
        )),
        _ => return Err(CryptoError::Malformed("header has no valid body_id")),
    };
    let deleted = match object.remove("deleted") {
        Some(Value::Bool(deleted)) => deleted,
        _ => return Err(CryptoError::Malformed("header has no valid deleted flag")),
    };
    check_path(&path)?;

    Ok(Header {
        format,
        version,
        kind,
        path,
        size,
        mtime_ms,
        content_hash,
        body_id,
        deleted,
        extra: object.into_iter().collect(),
    })
}

/// The AAD of an envelope: label, space, item, epoch and version (Ф18).
fn header_aad(space: &SpaceId, item: &ItemId, epoch: u32, version: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_HEADER.len() + 16 + 16 + 4 + 8);
    aad.extend_from_slice(AAD_HEADER);
    aad.extend_from_slice(space.as_bytes());
    aad.extend_from_slice(item.as_bytes());
    aad.extend_from_slice(&epoch.to_be_bytes());
    aad.extend_from_slice(&version.to_be_bytes());
    aad
}

/// Encrypts a header into an envelope: `0x01 ‖ epoch ‖ nonce ‖ ciphertext ‖ tag` (Ф18). The JSON
/// is padded with zeros to a multiple of 256 bytes (Ф17); the AAD binds the space, the item, the
/// epoch of `vk` and `header.version`. Draws one nonce (Ф31). Р2, Р6.
pub fn seal_header(
    vk: &SpaceKey,
    space: &SpaceId,
    item: &ItemId,
    header: &Header,
    rng: &mut dyn Random,
) -> Result<Vec<u8>, CryptoError> {
    let json = Zeroizing::new(canonical_header_json(header)?);
    if vk.epoch() == 0 {
        return Err(CryptoError::InvalidParams("key epoch starts at 1"));
    }
    let mut padded = Zeroizing::new(Vec::with_capacity(
        json.len().div_ceil(PADDING_BLOCK) * PADDING_BLOCK,
    ));
    padded.extend_from_slice(&json);
    padded.resize(json.len().div_ceil(PADDING_BLOCK) * PADDING_BLOCK, 0);

    let mut nonce = [0u8; XNONCE_LEN];
    rng.fill(&mut nonce);
    let key = derive_key(vk.as_bytes(), INFO_HEADER_KEY);
    let aad = header_aad(space, item, vk.epoch(), header.version);
    let sealed = xchacha20poly1305_seal(&key, &nonce, &aad, &padded);

    let mut envelope = Vec::with_capacity(ENVELOPE_HEAD_LEN + sealed.len());
    envelope.push(ENVELOPE_VERSION);
    envelope.extend_from_slice(&vk.epoch().to_be_bytes());
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&sealed);
    Ok(envelope)
}

/// Decrypts the envelope of `item` at `version` (the one the server announced). Fails with
/// `Authentication` for any change of the data, another item, space, version or key; with
/// `EpochMismatch` if the epoch in the envelope is not the epoch of `vk`; `UnsupportedVersion`
/// for another envelope version; `BadPadding`, `VersionMismatch`, `UnsupportedFormat`, `Malformed`,
/// `InvalidPath` and `PathNotNfc` for what is inside (Ф17–Ф19, Ф33). Nothing is returned on error (С5, С6). This is
/// a fuzzing target.
pub fn open_header(
    vk: &SpaceKey,
    space: &SpaceId,
    item: &ItemId,
    version: u64,
    envelope: &[u8],
) -> Result<Header, CryptoError> {
    let epoch = header_envelope_epoch_unchecked(envelope)?;
    if epoch != vk.epoch() {
        return Err(CryptoError::EpochMismatch);
    }
    if envelope.len() < ENVELOPE_HEAD_LEN + TAG_LEN {
        return Err(CryptoError::Malformed("header envelope is too short"));
    }
    let mut nonce = [0u8; XNONCE_LEN];
    nonce.copy_from_slice(&envelope[5..ENVELOPE_HEAD_LEN]);
    let key = derive_key(vk.as_bytes(), INFO_HEADER_KEY);
    let aad = header_aad(space, item, epoch, version);
    let padded = Zeroizing::new(xchacha20poly1305_open(
        &key,
        &nonce,
        &aad,
        &envelope[ENVELOPE_HEAD_LEN..],
    )?);

    if padded.is_empty() || padded.len() % PADDING_BLOCK != 0 {
        return Err(CryptoError::BadPadding);
    }
    // JSON never ends in a zero byte, so every zero at the end is padding (Ф17).
    let end = padded
        .iter()
        .rposition(|byte| *byte != 0)
        .map_or(0, |last| last + 1);
    let header = parse_header_json(&padded[..end])?;
    if header.version != version {
        return Err(CryptoError::VersionMismatch);
    }
    Ok(header)
}

/// The epoch stored in an envelope, to pick the right VK before opening it (Ф18). Epoch 0 is
/// `Malformed`.
pub fn header_envelope_epoch(envelope: &[u8]) -> Result<u32, CryptoError> {
    match header_envelope_epoch_unchecked(envelope)? {
        0 => Err(CryptoError::Malformed("header envelope has epoch 0")),
        epoch => Ok(epoch),
    }
}

/// The version byte is checked, the epoch is returned as it is, zero included (Ф18).
fn header_envelope_epoch_unchecked(envelope: &[u8]) -> Result<u32, CryptoError> {
    let Some((&version, rest)) = envelope.split_first() else {
        return Err(CryptoError::Malformed("header envelope is empty"));
    };
    if version != ENVELOPE_VERSION {
        return Err(CryptoError::UnsupportedVersion(version));
    }
    let epoch: [u8; 4] = rest
        .get(..4)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(CryptoError::Malformed("header envelope is too short"))?;
    Ok(u32::from_be_bytes(epoch))
}
