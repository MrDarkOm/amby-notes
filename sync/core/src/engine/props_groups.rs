//! Merge of the note-properties groups `.amby/properties/<g>.json` (docs/sync-plan.md, appendix З:
//! З5, З14–З17, З30–З33). Interfaces only (раздел 6, шаг 1): the bodies are `todo!()` until the
//! tests of `sync/core/tests/engine_props_groups*.rs` and `sync/sim/tests/props_groups.rs` are
//! reviewed. The unit of the merge is the whole record of a note (`notes.<amby-id>`), by the
//! meaning of the JSON and not by its bytes.

use std::collections::BTreeMap;

/// The largest version of a group the merge accepts, in bytes (decimal) (З30).
pub const PROPS_MERGE_MAX_BYTES: usize = 16_000_000;

/// The deepest nesting of an unknown value the merge accepts (З30).
pub const PROPS_MAX_DEPTH: usize = 32;

/// Number of groups of the layout version 1 (З5, З6).
pub const GROUP_COUNT: usize = 256;

/// Fewest vanishing properties of a pass that stop it (З32, пороги Д54), with 10% of all.
pub const PROPS_LOSS_MIN: usize = 20;

/// Percentage of all properties of the device that stops a pass with [`PROPS_LOSS_MIN`] (З32).
pub const PROPS_LOSS_PERCENT: usize = 10;

/// The group of a note: two lowercase hexadecimal digits of the first byte of BLAKE3 of the
/// `amby-id` as UTF-8 (З5). `"ab"`, not the start of the ULID.
pub fn group_of(amby_id: &str) -> String {
    let _ = amby_id;
    todo!("З5")
}

/// The vault-relative path of the group file of a note: `.amby/properties/<g>.json` (З5).
pub fn group_path_of(amby_id: &str) -> String {
    let _ = amby_id;
    todo!("З5")
}

/// Is `path` a group file the merge applies to: exactly `.amby/properties/<two lowercase hex>.json`
/// (З30). `layout.json` and everything else in the folder is synchronised but not merged.
pub fn is_group_path(path: &str) -> bool {
    let _ = path;
    todo!("З30")
}

/// Why a version of a group is not merged but goes to a conflict set (З30).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotMergeable {
    /// A version is not valid UTF-8.
    NotUtf8,
    /// A version contains a `0x00` byte.
    HasNul,
    /// A version is larger than [`PROPS_MERGE_MAX_BYTES`].
    TooLarge,
    /// Not JSON, or not a JSON object at the root.
    NotAnObject,
    /// A key repeats in some object, at any level.
    DuplicateKey,
    /// `version` is not 1 (or missing, or not a number).
    BadVersion,
    /// The shape is wrong: `notes`, a record, `properties`, a known field, `id`, names (З30).
    BadShape,
    /// An unknown value is nested deeper than [`PROPS_MAX_DEPTH`].
    TooDeep,
}

/// A conflict of a group (З16, З17): the notes whose records the sides changed differently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupConflict {
    /// `amby-id` of every conflicting note, ascending. Empty when only an unknown top-level field
    /// conflicts.
    pub notes: Vec<String>,
    /// How many records the merge settled by itself (taken from the only side that changed them).
    pub auto_merged: usize,
}

/// The answer of [`merge_group`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupMergeOutcome {
    /// Every change of both sides, in the canonical form of З8, with the BOM and line ending by
    /// the rules of Ж14. Short paths return the bytes of a side unchanged (З30, Ж11).
    Clean(Vec<u8>),
    /// All or nothing (З17): nothing is written, a conflict set is made.
    Conflict(GroupConflict),
    /// The versions cannot be merged at all (З30).
    NotMergeable(NotMergeable),
}

/// The admission check of З30 for one version of a group.
pub fn check_group(bytes: &[u8]) -> Result<(), NotMergeable> {
    let _ = bytes;
    todo!("З30")
}

/// The canonical form of a group (З8): keys of `notes` ascending, fields in the order of the
/// structure, two-space indent, one line feed at the end; BOM and line endings of `bytes` stay.
/// Idempotent. Fails like [`check_group`].
pub fn canonicalize_group(bytes: &[u8]) -> Result<Vec<u8>, NotMergeable> {
    let _ = bytes;
    todo!("З8, З30")
}

/// Three-way merge of a group by the records of the notes (З16, З30, З31). `hint` and
/// `dismissedRenames` take no part in the decision of a conflict (З31). Symmetric, deterministic.
pub fn merge_group(base: &[u8], local: &[u8], remote: &[u8]) -> GroupMergeOutcome {
    let _ = (base, local, remote);
    todo!("З16, З30, З31")
}

/// Which version of a conflicting note the user keeps (З17).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// «С этого компьютера»: the record as it is in the file on the path.
    Local,
    /// «С другого»: the record of the second version of the conflict set.
    Other,
}

/// Why a resolution of a conflicting group is refused and nothing is written (З17).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// Some conflicting note has no pick.
    IncompletePicks,
    /// The file on the path or the second version changed since the conflict was shown.
    Stale,
    /// A version does not pass [`check_group`].
    NotMergeable(NotMergeable),
}

/// Resolves a conflicting group: for every conflicting note a pick; everything else from the clean
/// merge; the result in the canonical form. `now_local` and `now_other` are the bytes on disk and
/// in the set at this moment; if either differs from `local`/`other` that were compared, the
/// answer is [`ResolveError::Stale`] (К4). З17.
pub fn resolve_group(
    base: &[u8],
    local: &[u8],
    other: &[u8],
    picks: &BTreeMap<String, Side>,
    now_local: &[u8],
    now_other: &[u8],
) -> Result<Vec<u8>, ResolveError> {
    let _ = (base, local, other, picks, now_local, now_other);
    todo!("З17")
}

/// One group file of a pass as the pass is about to write or send it (З32): what it holds now
/// (empty when it does not exist) and what it will hold.
#[derive(Debug, Clone, Copy)]
pub struct GroupWrite<'a> {
    /// Vault-relative path of the group.
    pub path: &'a str,
    /// The bytes now (incoming: on disk; outgoing: the server version). Empty: no file.
    pub before: &'a [u8],
    /// The bytes after (incoming: the version to write; outgoing: the file to send). Empty: the
    /// file is gone.
    pub after: &'a [u8],
}

/// What a pass would make vanish (З32).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MassLoss {
    /// Elements of `properties[]` that are in `before` and not in `after`, summed over the pass.
    pub properties: usize,
    /// Notes that lose at least one.
    pub notes: usize,
}

/// Elements of `properties[]` (by note and property `id`) that `before` has and `after` does not.
/// A property that only moved or changed its fields does not vanish; a whole removed note record
/// loses all of its properties. Unreadable bytes count nothing. З32.
pub fn vanishing_properties(before: &[u8], after: &[u8]) -> usize {
    let _ = (before, after);
    todo!("З32")
}

/// The check of a whole pass (З32): over **all** groups of the pass, merged and replaced from one
/// side, incoming and outgoing, sums the vanishing properties; `Some` if the sum is at least
/// [`PROPS_LOSS_MIN`] and more than [`PROPS_LOSS_PERCENT`] per cent of `total_properties`, all
/// elements of all groups on the device. Then no group of the pass is written or sent.
pub fn pass_mass_loss(writes: &[GroupWrite<'_>], total_properties: usize) -> Option<MassLoss> {
    let _ = (writes, total_properties);
    todo!("З32")
}
