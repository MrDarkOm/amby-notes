//! A patch of the sidebar tree: what changes after a mutation or a watcher event, computed from
//! the disk, so the renderer does not reload the whole vault for one file.
//!
//! The patch is built with the same entry builder as the full tree (`tree_item_for_entry`), so a
//! patched tree and a freshly built one are the same by construction. Anything the patch cannot
//! express makes `patch_for_paths` return `None`, and the caller reloads everything.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::scan::{file_name, file_stem, is_canvas, is_markdown, is_sketch};
use super::tree::{is_hidden_tree_name, tree_item_for_entry, NoteLookup, TreeItem};

/// More touched entries than this are cheaper, and safer, to reload than to patch.
const MAX_PATCHED_ENTRIES: usize = 400;

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

/// Notes are looked up in the index one at a time, as the entries are built.
struct IndexLookup<'a>(&'a Connection);

impl NoteLookup for IndexLookup<'_> {
    fn find(&self, rel_path: &str) -> Option<(String, Option<u64>)> {
        let mut statement = self
            .0
            .prepare_cached("SELECT id, mtime FROM notes WHERE path = ?1")
            .ok()?;
        statement
            .query_row([rel_path], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?.map(|value| value as u64),
                ))
            })
            .optional()
            .ok()
            .flatten()
    }
}

/// Where the children of a directory sit in the tree.
enum DirContext {
    Root,
    /// The directory is a listed item: its tree path, and whether its children are listed as the
    /// children of a bundle or a database (rather than of a plain folder).
    Listed {
        tree_path: String,
        children_in_bundle: bool,
    },
    /// The directory exists but the tree does not list it (nor anything under it).
    Unlisted,
    Missing,
}

fn dir_context(vault: &Path, dir: &Path, lookup: &dyn NoteLookup) -> DirContext {
    if dir == vault {
        return DirContext::Root;
    }
    if !dir.is_dir() {
        return DirContext::Missing;
    }
    let Some(parent) = dir.parent() else {
        return DirContext::Missing;
    };
    let in_bundle = match dir_context(vault, parent, lookup) {
        DirContext::Root => false,
        DirContext::Listed {
            children_in_bundle, ..
        } => children_in_bundle,
        other => return other,
    };
    match tree_item_for_entry(vault, parent, dir, lookup, in_bundle, false) {
        Ok(Some(item)) => DirContext::Listed {
            children_in_bundle: item.item_type != "folder",
            tree_path: item.path,
        },
        Ok(None) => DirContext::Unlisted,
        Err(_) => DirContext::Missing,
    }
}

fn is_layer_extension(path: &Path) -> bool {
    is_markdown(path) || is_canvas(path) || is_sketch(path)
}

/// The paths one entry may have been listed under: itself, or, for a bundle, its main layer file.
fn listed_paths(entry: &Path) -> Vec<String> {
    let name = file_name(entry);
    let mut paths = vec![entry.to_string_lossy().to_string()];
    for extension in ["md", "canvas", "excalidraw"] {
        paths.push(
            entry
                .join(format!("{name}.{extension}"))
                .to_string_lossy()
                .to_string(),
        );
    }
    paths
}

/// The patch for what changed at `touched` (absolute paths of files and folders, existing or
/// not), or `None` when the whole tree has to be reloaded.
///
/// Every touched path maps to the directory entry that holds it. An entry is rebuilt from the
/// disk with the builder of the full tree, so a folder that was moved arrives with its whole
/// subtree, and entries inside a rebuilt entry need no operation of their own. The directories
/// that lost or gained an entry are refreshed too, because their own times changed.
pub fn patch_for_paths(
    conn: &Connection,
    vault: &Path,
    touched: &[PathBuf],
) -> Result<Option<TreePatch>, String> {
    let lookup = IndexLookup(conn);
    let mut entries = BTreeSet::<PathBuf>::new();
    for path in touched {
        let Ok(relative) = path.strip_prefix(vault) else {
            return Ok(None);
        };
        if relative.as_os_str().is_empty() {
            return Ok(None);
        }
        if relative
            .components()
            .any(|part| is_hidden_tree_name(&part.as_os_str().to_string_lossy()))
        {
            continue;
        }
        if !path.exists() {
            // Whatever vanished vanished with its topmost missing folder.
            let mut gone = path.as_path();
            while let Some(parent) = gone
                .parent()
                .filter(|parent| *parent != vault && !parent.exists())
            {
                gone = parent;
            }
            entries.insert(gone.to_path_buf());
            continue;
        }
        if path.is_dir() || is_layer_extension(path) {
            entries.insert(path.clone());
        }
        // A file named like its folder, or a database manifest, decides what the folder is.
        if let Some(parent) = path.parent().filter(|parent| *parent != vault) {
            let name = file_name(path);
            if file_stem(path) == file_name(parent) || name == "ambd.json" || name == "Metadata.md"
            {
                entries.insert(parent.to_path_buf());
            }
        }
    }
    let entries = entries
        .iter()
        .filter(|entry| {
            !entry
                .ancestors()
                .skip(1)
                .any(|ancestor| entries.contains(ancestor))
        })
        .cloned()
        .collect::<Vec<_>>();
    if entries.len() > MAX_PATCHED_ENTRIES {
        return Ok(None);
    }

    let mut removals = Vec::new();
    let mut upserts = Vec::new();
    let mut parent_refresh = BTreeSet::<PathBuf>::new();
    for entry in &entries {
        let Some(directory) = entry.parent() else {
            return Ok(None);
        };
        let (parent_path, in_bundle) = match dir_context(vault, directory, &lookup) {
            DirContext::Root => (None, false),
            DirContext::Listed {
                tree_path,
                children_in_bundle,
            } => (Some(tree_path), children_in_bundle),
            DirContext::Unlisted => continue,
            // The folder that held the entry is gone too: only a full reload knows what else went.
            DirContext::Missing => return Ok(None),
        };
        removals.push(TreePatchOp::Remove {
            parent_path: parent_path.clone(),
            paths: listed_paths(entry),
        });
        if entry.exists() {
            if let Some(item) =
                tree_item_for_entry(vault, directory, entry, &lookup, in_bundle, true)?
            {
                upserts.push(TreePatchOp::Upsert {
                    parent_path,
                    item,
                    replace_children: true,
                });
            }
        }
        if directory != vault {
            parent_refresh.insert(directory.to_path_buf());
        }
    }

    // The directories an entry left or entered have new times, unless they are rebuilt anyway.
    let mut refreshes = Vec::new();
    for directory in parent_refresh {
        if directory
            .ancestors()
            .any(|ancestor| entries.iter().any(|entry| entry == ancestor))
        {
            continue;
        }
        let Some(grandparent) = directory.parent() else {
            continue;
        };
        let (parent_path, in_bundle) = match dir_context(vault, grandparent, &lookup) {
            DirContext::Root => (None, false),
            DirContext::Listed {
                tree_path,
                children_in_bundle,
            } => (Some(tree_path), children_in_bundle),
            _ => continue,
        };
        if let Some(item) =
            tree_item_for_entry(vault, grandparent, &directory, &lookup, in_bundle, false)?
        {
            refreshes.push(TreePatchOp::Upsert {
                parent_path,
                item,
                replace_children: false,
            });
        }
    }

    let mut ops = removals;
    ops.extend(upserts);
    ops.extend(refreshes);
    Ok(Some(TreePatch { ops }))
}
