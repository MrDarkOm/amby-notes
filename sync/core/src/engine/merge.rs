//! Three-way merge of a Markdown note (appendix Г, К1: Г4–Г19). A pure function of three byte
//! strings: no files, no network, no clock. Its bodies are `todo!()` until the tests of stage Э4б
//! are reviewed (plan, раздел 6).

/// The largest base, local or remote version that is merged (Г5): 1 MiB. Larger files go straight to
/// a conflict set.
pub const MERGE_MAX_BYTES: usize = 1024 * 1024;

/// The most cells of the line comparison (lines of the base times lines of a version, after the
/// common beginning and end are cut off) the merge tries (Г12): 25 million. More is "too complex".
pub const MERGE_MAX_CELLS: u64 = 25_000_000;

/// Why a file is not merged but goes to a conflict set (Г5, Г12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotMergeable {
    /// The path does not end in `.md`, or it is inside `.amby/`.
    NotMarkdown,
    /// A version is not valid UTF-8.
    NotUtf8,
    /// A version contains a `0x00` byte.
    HasNul,
    /// A version is larger than [`MERGE_MAX_BYTES`].
    TooLarge,
    /// The comparison would take more than [`MERGE_MAX_CELLS`] cells.
    TooComplex,
}

/// A place where the two sides edited the same spot: lines `start..end` of the base (Г12 п. 6).
/// A range is the union of the edits that overlap or touch, widened to whole places (Г11). An
/// insertion has `start == end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    /// First line of the base in the region (0-based).
    pub start: usize,
    /// One past the last line of the base in the region.
    pub end: usize,
}

/// The answer of [`merge_text`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    /// Every edit of both sides is in the bytes: the unchanged lines of the base byte for byte, the
    /// replacements byte for byte (Г14). Never contains a conflict mark (Г15 е).
    Clean(Vec<u8>),
    /// The sides edited the same place, or a check of Г13 failed. The whole file is a conflict
    /// ("all or nothing", Г12 п. 6); the regions are told in lines of the base, ascending. A
    /// conflict found by the checks of Г13 alone has no region.
    Conflict(Vec<Region>),
    /// The versions cannot be merged at all (Г5, Г12).
    NotMergeable(NotMergeable),
}

/// Is a file at `path` a candidate for merging (Г5)? The path ends in `.md` (any case) and is not
/// inside `.amby/`. Says nothing about the content: see [`merge_text`]. Г5.
pub fn is_mergeable_path(path: &str) -> bool {
    let _ = path;
    todo!("Г5: path rule")
}

/// Merges the edits of `local` and `remote` made to `base`: the three-way merge by lines of
/// appendix Г. Checks the content first (UTF-8, no `0x00`, sizes: Г5) and answers
/// [`MergeOutcome::NotMergeable`] when it cannot be merged. Pure and deterministic (Г18). Г4–Г15.
pub fn merge_text(base: &[u8], local: &[u8], remote: &[u8]) -> MergeOutcome {
    let _ = (base, local, remote);
    todo!("Г12: three-way merge")
}
