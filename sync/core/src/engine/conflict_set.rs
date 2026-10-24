//! The set of a conflict in `.amby/conflicts/<id>/` (appendix Г, К2: Г20–Г30): where its files lie,
//! how its identifier is made and what `meta.json` says. Pure functions: the engine, the
//! application and the tests use the same ones.

use serde_json::Value;

use crate::crypto::keys::ItemId;
use crate::crypto::primitives::blake3_hash;

use super::model::ConflictKind;

/// The folder of all conflict sets, relative to the vault (Г21, Г24).
pub const CONFLICTS_DIR: &str = ".amby/conflicts";

/// Where the files of one set lie, relative to the vault (Г21).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetPaths {
    /// `.amby/conflicts/<id>`.
    pub dir: String,
    /// `.amby/conflicts/<id>/other<ext>`: the second version.
    pub other: String,
    /// `.amby/conflicts/<id>/base<ext>`: the common base (it may not be there).
    pub base: String,
    /// `.amby/conflicts/<id>/meta.json`, written last.
    pub meta: String,
}

/// The paths of the set `id` of the file `original` (Г21). `<ext>` is the extension of the last
/// segment of `original`, with its dot, when it has 1–8 characters of `A–Z a–z 0–9` after the dot;
/// otherwise empty. A name that only starts with a dot (`.env`) has no extension. Г21.
pub fn set_paths(id: &str, original: &str) -> SetPaths {
    let last = original.rsplit('/').next().unwrap_or(original);
    let ext = match last.rfind('.') {
        // A dot at position 0 starts the name (`.env`), it does not begin an extension.
        Some(dot) if dot > 0 => {
            let tail = &last[dot + 1..];
            let plain =
                (1..=8).contains(&tail.len()) && tail.bytes().all(|b| b.is_ascii_alphanumeric());
            if plain {
                &last[dot..]
            } else {
                ""
            }
        }
        _ => "",
    };
    let dir = format!("{CONFLICTS_DIR}/{id}");
    SetPaths {
        other: format!("{dir}/other{ext}"),
        base: format!("{dir}/base{ext}"),
        meta: format!("{dir}/meta.json"),
        dir,
    }
}

/// Is `path` inside `.amby/conflicts/` (Г19, Г24)?
pub fn is_in_conflicts_dir(path: &str) -> bool {
    path == CONFLICTS_DIR
        || path
            .strip_prefix(CONFLICTS_DIR)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// The identifier of a set: the first 6 bytes of `BLAKE3("amby-sync/conflict/2" ‖ item_id ‖
/// other_hash ‖ remote_version (8 bytes, BE) ‖ base_hash (32 bytes, 32 zeros when `None`)` and,
/// when `attempt` is not 0, the 4 bytes BE of `attempt`), as 12 lowercase hex characters (Г22).
/// Deterministic, so a repeat after a crash makes the same set (Д4).
pub fn set_id(
    item_id: &ItemId,
    other_hash: &[u8; 32],
    remote_version: u64,
    base_hash: Option<&[u8; 32]>,
    attempt: u32,
) -> String {
    let mut data = b"amby-sync/conflict/2".to_vec();
    data.extend_from_slice(item_id.as_bytes());
    data.extend_from_slice(other_hash);
    data.extend_from_slice(&remote_version.to_be_bytes());
    data.extend_from_slice(base_hash.unwrap_or(&[0u8; 32]));
    if attempt != 0 {
        data.extend_from_slice(&attempt.to_be_bytes());
    }
    hex_encode(&blake3_hash(&data)[..6])
}

/// What `meta.json` says (Г21). Nothing here depends on the device or on time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetMeta {
    /// The identifier (the name of the folder).
    pub id: String,
    /// What happened.
    pub kind: ConflictKind,
    /// The item whose content kept the name.
    pub item_id: ItemId,
    /// The path of the original (NFC) when the set was made.
    pub path: String,
    /// The file name of the second version inside the folder (`other<ext>`).
    pub other: String,
    /// BLAKE3 of the second version.
    pub other_hash: [u8; 32],
    /// Size of the second version.
    pub other_size: u64,
    /// The file name of the base inside the folder, when the set has one.
    pub base: Option<String>,
    /// BLAKE3 of the base.
    pub base_hash: Option<[u8; 32]>,
}

/// Why `meta.json` cannot be used (Г21, Г23).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetaError {
    /// Not JSON, a field is missing or has the wrong type, an id or hash is not hex of the right
    /// length.
    Malformed,
    /// `"v"` is a number this build does not know (Р13): the set is not listed.
    UnsupportedVersion(u64),
}

/// The exact bytes of `meta.json` (Г21): compact JSON in UTF-8, keys in the order `v`, `id`,
/// `kind` (`"bothEdited"` or `"bothCreated"`), `item_id`, `path`, `other`, `other_hash`,
/// `other_size`, `base`, `base_hash` (hashes and ids as lowercase hex, absent values as `null`),
/// no spaces, no final newline. Г21.
pub fn encode_meta(meta: &SetMeta) -> Vec<u8> {
    let kind = match meta.kind {
        ConflictKind::BothEdited => "bothEdited",
        ConflictKind::BothCreated => "bothCreated",
    };
    let text = |value: &str| Value::String(value.to_owned()).to_string();
    let opt_text = |value: &Option<String>| value.as_deref().map_or("null".to_owned(), text);
    let base_hash = meta
        .base_hash
        .as_ref()
        .map_or("null".to_owned(), |h| text(&hex_encode(h)));
    format!(
        "{{\"v\":1,\"id\":{},\"kind\":\"{kind}\",\"item_id\":{},\"path\":{},\"other\":{},\"other_hash\":{},\"other_size\":{},\"base\":{},\"base_hash\":{}}}",
        text(&meta.id),
        text(&hex_encode(meta.item_id.as_bytes())),
        text(&meta.path),
        text(&meta.other),
        text(&hex_encode(&meta.other_hash)),
        meta.other_size,
        opt_text(&meta.base),
        base_hash,
    )
    .into_bytes()
}

/// Reads `meta.json` (Г21, Г23). Unknown extra keys are ignored. A `"v"` above 1 is
/// [`MetaError::UnsupportedVersion`].
pub fn decode_meta(bytes: &[u8]) -> Result<SetMeta, MetaError> {
    let json: Value = serde_json::from_slice(bytes).map_err(|_| MetaError::Malformed)?;
    let object = json.as_object().ok_or(MetaError::Malformed)?;
    let field = |key: &str| object.get(key).ok_or(MetaError::Malformed);
    let string = |key: &str| {
        field(key)?
            .as_str()
            .map(str::to_owned)
            .ok_or(MetaError::Malformed)
    };
    let hash = |key: &str| -> Result<[u8; 32], MetaError> {
        hex_decode(field(key)?.as_str().ok_or(MetaError::Malformed)?).ok_or(MetaError::Malformed)
    };

    let version = field("v")?.as_u64().ok_or(MetaError::Malformed)?;
    if version > 1 {
        return Err(MetaError::UnsupportedVersion(version));
    }
    if version == 0 {
        return Err(MetaError::Malformed);
    }
    let id = string("id")?;
    if id.len() != 12 || hex_decode::<6>(&id).is_none() {
        return Err(MetaError::Malformed);
    }
    let kind = match field("kind")?.as_str() {
        Some("bothEdited") => ConflictKind::BothEdited,
        Some("bothCreated") => ConflictKind::BothCreated,
        _ => return Err(MetaError::Malformed),
    };
    let item_id = ItemId::from_bytes(
        hex_decode(field("item_id")?.as_str().ok_or(MetaError::Malformed)?)
            .ok_or(MetaError::Malformed)?,
    );
    let (base, base_hash) = match (field("base")?, field("base_hash")?) {
        (Value::Null, Value::Null) => (None, None),
        (Value::String(name), Value::String(_)) => (Some(name.clone()), Some(hash("base_hash")?)),
        _ => return Err(MetaError::Malformed),
    };
    Ok(SetMeta {
        id,
        kind,
        item_id,
        path: string("path")?,
        other: string("other")?,
        other_hash: hash("other_hash")?,
        other_size: field("other_size")?.as_u64().ok_or(MetaError::Malformed)?,
        base,
        base_hash,
    })
}

/// Lowercase hex of `bytes`.
fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from(DIGITS[usize::from(byte >> 4)]));
        text.push(char::from(DIGITS[usize::from(byte & 0x0F)]));
    }
    text
}

/// Lowercase hex of exactly `N` bytes; anything else is `None`.
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
