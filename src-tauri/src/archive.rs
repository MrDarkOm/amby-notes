//! The archive: what the person put away but wants to keep (docs/sync-plan.md, appendix К).
//!
//! INTERFACE ONLY (section 6, step 1): every function body is `todo!()` and the tests in
//! `archive_tests.rs` are red until the code is written. The archive is the hidden synchronised
//! folder `.amby/archive/` that repeats the paths of the vault (К1); each file has a record
//! `.amby/archive/.meta/<id>.json` `{path, archivedAtMs}` (К8).
#![allow(dead_code, unused_variables, clippy::needless_pass_by_value)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::FsMutationResult;
use crate::recycle_bin::{DeleteMode, TrashPreview};
use crate::system_recycle_bin::SystemTrash;

/// Where the archive lies: `<vault>/.amby/archive` (К1).
pub fn archive_root(vault: &Path) -> PathBuf {
    vault.join(".amby").join("archive")
}

/// Where the records of the times lie: `<vault>/.amby/archive/.meta` (К8).
pub fn meta_root(vault: &Path) -> PathBuf {
    archive_root(vault).join(".meta")
}

/// A file of the archive as the panel shows it (К6): one row per file, with its folders.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// An identifier for `restore` / `purge` / `read_preview`; its form is not part of the contract.
    pub id: String,
    /// The path in the vault the file is restored to: the path inside `.amby/archive/` (К1).
    pub original_path: String,
    /// The time of the move to the archive: `archivedAtMs` of the record, and the time of the file
    /// itself when there is no record (К8).
    pub archived_at_ms: u64,
    /// The name of the file.
    pub name: String,
}

/// The record `.amby/archive/.meta/<id>.json` (К8). Fields the code does not know are kept.
#[derive(Clone, Debug, PartialEq)]
pub struct ArchiveMeta {
    pub path: String,
    pub archived_at_ms: u64,
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ArchiveMeta {
    /// Reads a record; the key names on disk are `path` and `archivedAtMs` (К8).
    ///
    /// Requirement: К8.
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        todo!("К8")
    }

    /// The bytes of the record: `path`, `archivedAtMs` and every unknown field as it was (К8).
    ///
    /// Requirement: К8.
    pub fn to_bytes(&self) -> Vec<u8> {
        todo!("К8")
    }
}

/// «В архив» (К1): moves the file or folder (a note of a bundle takes its folder, as the old trash
/// did) to `.amby/archive/<its path in the vault>` by renaming, and writes the record of every
/// file moved (К8). A path outside the vault or inside `.amby/` is refused. When the place in the
/// archive is taken, the item goes next to it under a free name and nothing in the archive is
/// replaced.
///
/// Requirements: К1, К8.
pub fn move_to_archive(vault: &Path, path: &Path) -> Result<FsMutationResult, String> {
    todo!("К1, К8")
}

/// The files of the archive (К6): everything under `.amby/archive/` except `.meta/`.
///
/// Requirements: К6, К8.
pub fn list(vault: &Path) -> Vec<ArchiveEntry> {
    todo!("К6, К8")
}

/// «Вернуть» (К6): renames the file to its path in the vault **without replacing** anything; a
/// taken path gives a free name next to it (`Name 2.md`, the rule of `free_path`); missing folders
/// are created. `primary_path` of the result is the final absolute path.
///
/// Requirement: К6.
pub fn restore(vault: &Path, id: &str) -> Result<FsMutationResult, String> {
    todo!("К6")
}

/// «Удалить из архива» (К6) by the setting of К4: `System` and `Archive` (the setting «Переносить в
/// архив» means here the system trash) hand the file to `system_trash`, `Permanent` removes it. A
/// refusal of the trash is an error and the file stays in the archive. The record is removed with
/// the file.
///
/// Requirements: К4, К6.
pub fn purge(
    vault: &Path,
    id: &str,
    mode: DeleteMode,
    system_trash: &dyn SystemTrash,
) -> Result<(), String> {
    todo!("К4, К6")
}

/// A read-only look at an archived file (the panel's preview).
///
/// Requirement: К6.
pub fn read_preview(vault: &Path, id: &str, relative_path: &str) -> Result<TrashPreview, String> {
    todo!("К6")
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "archive_test_support.rs"]
pub(crate) mod test_support;
