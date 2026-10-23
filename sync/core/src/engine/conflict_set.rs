//! The set of a conflict in `.amby/conflicts/<id>/` (appendix Г, К2: Г20–Г30): where its files lie,
//! how its identifier is made and what `meta.json` says. Pure functions: the engine, the
//! application and the tests use the same ones. Bodies are `todo!()` until the tests of stage Э4б
//! are reviewed (plan, раздел 6).

use crate::crypto::keys::ItemId;

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
    let _ = (id, original);
    todo!("Г21: paths of a set")
}

/// Is `path` inside `.amby/conflicts/` (Г19, Г24)?
pub fn is_in_conflicts_dir(path: &str) -> bool {
    let _ = path;
    todo!("Г19: inside the conflicts folder")
}

/// The identifier of a set: the first 6 bytes of `BLAKE3("amby-sync/conflict/2" ‖ item_id ‖
/// local_hash ‖ remote_version (8 bytes, BE) ‖ base_hash (32 bytes, 32 zeros when `None`)` and,
/// when `attempt` is not 0, the 4 bytes BE of `attempt`), as 12 lowercase hex characters (Г22).
/// Deterministic, so a repeat after a crash makes the same set (Д4).
pub fn set_id(
    item_id: &ItemId,
    local_hash: &[u8; 32],
    remote_version: u64,
    base_hash: Option<&[u8; 32]>,
    attempt: u32,
) -> String {
    let _ = (item_id, local_hash, remote_version, base_hash, attempt);
    todo!("Г22: identifier of a set")
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
    let _ = meta;
    todo!("Г21: meta.json bytes")
}

/// Reads `meta.json` (Г21, Г23). Unknown extra keys are ignored. A `"v"` above 1 is
/// [`MetaError::UnsupportedVersion`].
pub fn decode_meta(bytes: &[u8]) -> Result<SetMeta, MetaError> {
    let _ = bytes;
    todo!("Г21: read meta.json")
}
