//! Names (Р7, Р9, Д46, Д61–Д63): what cannot exist on this system, what collides, and how a
//! conflict copy is called. Pure functions: the engine and the tests use the same ones.

use crate::crypto::keys::ItemId;

use super::ports::NameRules;

/// Why a name cannot be created on this system (Р9, Д62).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameProblem {
    /// One of `<>:"\|?*` (Windows rules).
    WindowsForbiddenChar(char),
    /// A segment ends with a dot or a space (Windows rules).
    TrailingDotOrSpace,
    /// A reserved device name such as `CON` or `LPT1`, with or without an extension (Windows
    /// rules). Holds the segment.
    ReservedName(String),
    /// A segment is longer than the limit.
    SegmentTooLong,
    /// The path is longer than the limit.
    PathTooLong,
}

/// Can `path` (NFC, `/` separators, already valid by Ф33) be created under `rules`? Р9, Д62. The
/// first problem found, segments from the left; within a segment, a forbidden character comes
/// before the trailing dot or space, which comes before a reserved name.
pub fn check_path_for_system(_path: &str, _rules: &NameRules) -> Result<(), NameProblem> {
    todo!("Р9, Д62: names that cannot exist on this system")
}

/// The key under which two names are "the same file" on this system: NFC, and lowercase when the
/// rules are case-insensitive (Р9, Д61, Д63).
pub fn collision_key(_path: &str, _rules: &NameRules) -> String {
    todo!("Р9, Д61, Д63: collision key of a name")
}

/// The id inside a conflict copy name: the first 6 bytes of
/// `BLAKE3("amby-sync/conflict/1" ‖ item_id ‖ local_hash ‖ remote_version (8 bytes, BE)`, and the
/// 4 bytes big-endian of `attempt` when it is not 0`)`, as 12 lowercase hex characters
/// (Р7, Д46). Deterministic, so a repeat after a crash makes the same name.
pub fn conflict_id(
    _item_id: &ItemId,
    _local_hash: &[u8; 32],
    _remote_version: u64,
    _attempt: u32,
) -> String {
    todo!("Р7, Д46: conflict copy id")
}

/// The path of a conflict copy: `dir/Name.<id>-conflict.ext` next to `original` (Р7, Д46). The
/// name is split at the last dot; a name without a dot, or one that only starts with a dot
/// (`.env`), has no extension.
pub fn conflict_copy_path(_original: &str, _id: &str) -> String {
    todo!("Р7, Д46: conflict copy path")
}
