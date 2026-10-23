//! Small helpers shared by the parts of the engine (private).

use unicode_normalization::UnicodeNormalization;

use crate::crypto::primitives::blake3_hash;
use crate::crypto::random::Random;

use super::merge::{is_mergeable_path, MERGE_MAX_BYTES};
use super::model::ItemRecord;

/// `mtime_ns` of a base that was never written to this disk: the server's record is known, the
/// file is not here (a name this system cannot hold, a path the rules exclude, a file over the
/// memory limit; Д11, Д62–Д64, Д71). Such a base is retried by every pass and never read as a
/// deletion. It is a private convention inside [`ItemRecord`], the public types stay as they are.
pub(super) const UNMATERIALISED: i64 = i64::MIN;

/// The base was never materialised on this disk.
pub(super) fn is_unmaterialised(record: &ItemRecord) -> bool {
    record.mtime_ns == UNMATERIALISED
}

/// NFC form of a path (Д61).
pub(super) fn nfc(path: &str) -> String {
    path.nfc().collect()
}

/// The folder part of a path, if any.
pub(super) fn parent(path: &str) -> Option<&str> {
    path.rfind('/').map(|at| &path[..at])
}

/// Every parent folder of a path, nearest first: `a/b/c.md` → `a/b`, `a`.
pub(super) fn ancestors(path: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = path;
    while let Some(up) = parent(rest) {
        out.push(up);
        rest = up;
    }
    out
}

/// How deep a path is (number of segments).
pub(super) fn depth(path: &str) -> usize {
    path.matches('/').count()
}

/// BLAKE3 of the content.
pub(super) fn hash_of(bytes: &[u8]) -> [u8; 32] {
    blake3_hash(bytes)
}

/// A source of randomness that gives back fixed bytes: the same nonce prefix again (Д6).
pub(super) struct FixedRandom {
    bytes: Vec<u8>,
    at: usize,
}

impl FixedRandom {
    /// Gives `bytes` out in order, then zeros.
    pub(super) fn new(bytes: &[u8]) -> Self {
        Self {
            bytes: bytes.to_vec(),
            at: 0,
        }
    }
}

impl Random for FixedRandom {
    fn fill(&mut self, dest: &mut [u8]) {
        for byte in dest {
            *byte = self.bytes.get(self.at).copied().unwrap_or(0);
            self.at += 1;
        }
    }
}

/// May `bytes` at `path` be kept as the base of a merge (Г5, Г6): a note of at most 1 MiB, valid
/// UTF-8, without a `0x00` byte.
pub(super) fn base_eligible(path: &str, bytes: &[u8]) -> bool {
    is_mergeable_path(path)
        && bytes.len() <= MERGE_MAX_BYTES
        && !bytes.contains(&0)
        && std::str::from_utf8(bytes).is_ok()
}
