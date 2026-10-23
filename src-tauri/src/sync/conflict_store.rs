//! The store of the conflicts of a vault, as the interface sees it (docs/sync-plan.md, appendix Г,
//! stage Э4б, К2: Г25–Г36). The interface (К3, К4) asks this port for the list, the versions and
//! the resolution and does not know where the second version lies: today in
//! `.amby/conflicts/<id>/` (a set, Г21), for conflicts made before stage Э4б in a copy
//! `Name.<id>-conflict.ext` beside the file (Г29).
//!
//! The bodies are `todo!()` until the tests of stage Э4б are reviewed (plan, раздел 6).

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Where a conflict is kept (Г29).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSource {
    /// A set in `.amby/conflicts/<id>/` (Г21).
    Bundle,
    /// A copy `Name.<id>-conflict.ext` beside the file, made before stage Э4б.
    LegacyCopy,
}

/// One line of the list (Г32).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    /// The id (twelve hex characters): the folder of the set, or, for a legacy copy, the digest of
    /// its path.
    pub id: String,
    /// `bothEdited` or `bothCreated`.
    pub kind: String,
    /// The current path of the original (Г27).
    pub path: String,
    /// Where the second version lies (information).
    pub other_path: String,
    /// When the set or the copy was made, Unix milliseconds (display only).
    pub created_ms: i64,
    /// Set or legacy copy.
    pub source: ConflictSource,
    /// Both versions can be compared line by line and assembled (Г28).
    pub text: bool,
    /// The set has a common base (Г21).
    pub has_base: bool,
    /// This computer made the set (its entry is in the state, Г25, Г34).
    pub created_here: bool,
}

/// One version of a file for the comparison (Г33).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersion {
    /// Size in bytes (a JSON number, never above 2^53 in practice: files are at most 512 MiB).
    pub size: u32,
    /// BLAKE3, lowercase hex.
    pub hash: String,
    /// The text exactly as the bytes read as UTF-8 (BOM as U+FEFF, `\r\n` kept), only when the
    /// conflict is `text`.
    pub text: Option<String>,
}

/// What `read` answers (Г33).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersions {
    /// The line of the list.
    pub entry: ConflictEntry,
    /// The file at the path now.
    pub current: ConflictVersion,
    /// The second version.
    pub other: ConflictVersion,
    /// The common base, when the set has one.
    pub base: Option<ConflictVersion>,
}

/// How the person resolves a conflict (Г33).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Resolution {
    /// Keep the file as it is.
    Current,
    /// The second version replaces the file.
    Other,
    /// This text is written to the file, byte for byte (UTF-8, nothing added or normalised).
    #[serde(rename_all = "camelCase")]
    Assembled {
        /// The text assembled by the interface from the source text of the chosen blocks.
        text: String,
    },
}

/// Why the store refused (Г35). The interface translates the code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictError {
    /// No conflict with this id.
    NotFound,
    /// The set is incomplete (Г23).
    Incomplete,
    /// The original is not there and cannot be made (Г27).
    OriginalMissing,
    /// `Assembled` for a file that is not text (Г28).
    NotText,
    /// The disk failed.
    Storage(String),
}

impl std::fmt::Display for ConflictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl ConflictError {
    /// The machine code the interface gets (Г35).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::Incomplete => "incomplete",
            Self::OriginalMissing => "original_missing",
            Self::NotText => "not_text",
            Self::Storage(_) => "storage_error",
        }
    }
}

/// The port (Г31).
pub trait ConflictStore {
    /// Every open conflict of the vault, sets and legacy copies, by `created_ms` then `id` (Г25,
    /// Г29, Г32). Nothing is read from the network.
    fn list(&mut self) -> Result<Vec<ConflictEntry>, ConflictError>;

    /// The versions of one conflict (Г33). `NotFound`, `Incomplete`.
    fn read(&mut self, id: &str) -> Result<ConflictVersions, ConflictError>;

    /// Resolves one conflict (Г26): writes the result into the original with a history snapshot,
    /// moves the files of the conflict to the vault trash, and forgets it. Safe to repeat.
    fn resolve(&mut self, id: &str, resolution: Resolution) -> Result<(), ConflictError>;
}

/// The store on the files of a vault.
pub struct FileConflictStore {
    vault: PathBuf,
    /// The current path of each item (hex of the `item_id`), from the state (Г27).
    paths: BTreeMap<String, String>,
    /// The ids the state lists as made here (Г25).
    created_here: BTreeSet<String>,
}

impl FileConflictStore {
    /// A store of the vault `vault`. `paths` maps the hex of an `item_id` to its current path in
    /// the vault; `created_here` is the set of ids in `SyncState.conflicts` (Г25).
    pub fn new(
        vault: PathBuf,
        paths: BTreeMap<String, String>,
        created_here: BTreeSet<String>,
    ) -> Self {
        Self {
            vault,
            paths,
            created_here,
        }
    }
}

impl ConflictStore for FileConflictStore {
    fn list(&mut self) -> Result<Vec<ConflictEntry>, ConflictError> {
        let _ = (&self.vault, &self.paths, &self.created_here);
        todo!("Г25, Г29, Г32: list sets and legacy copies")
    }

    fn read(&mut self, id: &str) -> Result<ConflictVersions, ConflictError> {
        let _ = id;
        todo!("Г33: read the versions of a conflict")
    }

    fn resolve(&mut self, id: &str, resolution: Resolution) -> Result<(), ConflictError> {
        let _ = (id, resolution);
        todo!("Г26: resolve a conflict")
    }
}
