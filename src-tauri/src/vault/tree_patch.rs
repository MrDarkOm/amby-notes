//! A patch of the sidebar tree: what changes after a mutation or a watcher event, computed from
//! the disk, so the renderer does not reload the whole vault for one file.
//!
//! The patch is built with the same entry builder as the full tree (`tree_item_for_entry`), so a
//! patched tree and a freshly built one are the same by construction. Anything the patch cannot
//! express makes `patch_for_paths` return `None`, and the caller reloads everything.

use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

use super::tree::TreeItem;

/// One change of the tree. Operations are applied in order: removals first, then insertions of
/// parents before their children.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TreePatchOp {
    /// Remove every child of the item at `parentPath` whose `path` is one of `paths`
    /// (`parentPath` is `null` for the vault root). The paths are alternatives for one entry
    /// that may have been listed under either: the entry itself or its main layer file.
    #[serde(rename_all = "camelCase")]
    Remove {
        parent_path: Option<String>,
        paths: Vec<String>,
    },
    /// Put `item` among the children of the item at `parentPath`, in its sorted place. An item
    /// with the same path is replaced; with `replaceChildren` off it keeps the children it has.
    #[serde(rename_all = "camelCase")]
    Upsert {
        parent_path: Option<String>,
        item: TreeItem,
        replace_children: bool,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TreePatch {
    pub ops: Vec<TreePatchOp>,
}

/// The patch for what changed at `touched` (absolute paths of files and folders, existing or
/// not), or `None` when the whole tree has to be reloaded.
pub fn patch_for_paths(
    _conn: &Connection,
    _vault: &Path,
    _touched: &[PathBuf],
) -> Result<Option<TreePatch>, String> {
    Ok(None)
}
