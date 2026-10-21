//! Names (Р7, Р9, Д46, Д61–Д63): what cannot exist on this system, what collides, and how a
//! conflict copy is called. Pure functions: the engine and the tests use the same ones.

use unicode_normalization::UnicodeNormalization;

use crate::crypto::keys::ItemId;
use crate::crypto::primitives::blake3_hash;

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
pub fn check_path_for_system(path: &str, rules: &NameRules) -> Result<(), NameProblem> {
    for segment in path.split('/') {
        if rules.windows_names {
            if let Some(c) = segment.chars().find(|c| WINDOWS_FORBIDDEN.contains(c)) {
                return Err(NameProblem::WindowsForbiddenChar(c));
            }
            if segment.ends_with('.') || segment.ends_with(' ') {
                return Err(NameProblem::TrailingDotOrSpace);
            }
            if is_reserved_windows_name(segment) {
                return Err(NameProblem::ReservedName(segment.to_string()));
            }
        }
        if segment.len() > rules.max_segment_bytes {
            return Err(NameProblem::SegmentTooLong);
        }
    }
    if path.len() > rules.max_path_bytes {
        return Err(NameProblem::PathTooLong);
    }
    Ok(())
}

/// Characters a Windows name may not contain (Р9).
const WINDOWS_FORBIDDEN: [char; 8] = ['<', '>', ':', '"', '\\', '|', '?', '*'];

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, in any case, with or without an
/// extension (everything from the first dot is the extension).
fn is_reserved_windows_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment);
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let bytes = upper.as_bytes();
    bytes.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && (b'1'..=b'9').contains(&bytes[3])
}

/// The key under which two names are "the same file" on this system: NFC, and lowercase when the
/// rules are case-insensitive (Р9, Д61, Д63).
pub fn collision_key(path: &str, rules: &NameRules) -> String {
    let nfc: String = path.nfc().collect();
    if rules.case_insensitive {
        nfc.to_lowercase()
    } else {
        nfc
    }
}

/// The id inside a conflict copy name: the first 6 bytes of
/// `BLAKE3("amby-sync/conflict/1" ‖ item_id ‖ local_hash ‖ remote_version (8 bytes, BE)`, and the
/// 4 bytes big-endian of `attempt` when it is not 0`)`, as 12 lowercase hex characters
/// (Р7, Д46). Deterministic, so a repeat after a crash makes the same name.
pub fn conflict_id(
    item_id: &ItemId,
    local_hash: &[u8; 32],
    remote_version: u64,
    attempt: u32,
) -> String {
    let mut data = b"amby-sync/conflict/1".to_vec();
    data.extend_from_slice(item_id.as_bytes());
    data.extend_from_slice(local_hash);
    data.extend_from_slice(&remote_version.to_be_bytes());
    if attempt != 0 {
        data.extend_from_slice(&attempt.to_be_bytes());
    }
    let digest = blake3_hash(&data);
    let mut id = String::with_capacity(12);
    for byte in &digest[..6] {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

/// The path of a conflict copy: `dir/Name.<id>-conflict.ext` next to `original` (Р7, Д46). The
/// name is split at the last dot; a name without a dot, or one that only starts with a dot
/// (`.env`), has no extension.
pub fn conflict_copy_path(original: &str, id: &str) -> String {
    let (dir, name) = match original.rfind('/') {
        Some(slash) => original.split_at(slash + 1),
        None => ("", original),
    };
    // A dot at position 0 starts the name (`.env`), it does not begin an extension.
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    format!("{dir}{stem}.{id}-conflict{extension}")
}
