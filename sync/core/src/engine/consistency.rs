//! Meaning of the header fields (Ф14 checks only their shape; Д65). The engine treats a
//! violation as tampering (Д14): the item is skipped and nothing is written (С5).

use crate::crypto::header::{Header, ItemKind};

use super::ports::ChangeEntry;

/// What is inconsistent in a header or in an entry against its header (Д65).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderProblem {
    /// `format` is not 1.
    Format,
    /// `version` is 0.
    Version,
    /// A folder or a deleted item has a `body_id`, or a live file has none.
    Body,
    /// A folder or a deleted item has a `content_hash`, or a live file has none.
    Hash,
    /// A folder or a deleted item has a `size` other than 0.
    Size,
    /// A new version changes `kind` of an item.
    KindChanged,
    /// The `blob_id` of the feed entry differs from the `body_id` of the header.
    EntryBlob,
    /// The `blob_size` of the entry is not `sealed_body_len(size)`.
    EntryBlobSize,
}

/// Only these combinations are valid (Д65): a live file has `body_id` and `content_hash`; a
/// deleted file, a folder and a deleted folder have neither and `size = 0`; and `format = 1`,
/// `version >= 1`. Р2, Р13, Ф14, Д65.
pub fn check_header(_header: &Header) -> Result<(), HeaderProblem> {
    todo!("Р2, Ф14, Д65: consistency of header fields")
}

/// A new version must not change the kind of an existing item (Д65).
pub fn check_kind_unchanged(_known: ItemKind, _header: &Header) -> Result<(), HeaderProblem> {
    todo!("Д65: kind of an item is fixed")
}

/// The feed entry against its decrypted header: `blob_id` equals `body_id` (both absent or both
/// equal) and `blob_size` is `sealed_body_len(size)` when there is a body. The open `deleted`
/// mark is **not** compared: only the header is believed (Р6, Д65).
pub fn check_entry(_entry: &ChangeEntry, _header: &Header) -> Result<(), HeaderProblem> {
    todo!("Р6, Д65: the feed entry matches its header")
}
