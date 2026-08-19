use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use super::scan::*;
use crate::index::IndexedNote;

#[derive(Serialize, Clone, Debug, PartialEq, Eq, specta::Type)]
pub struct TreeItem {
    pub id: String,
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeItem>>,
}

pub fn filesystem_timestamps(path: &Path) -> (Option<u64>, Option<u64>) {
    let Ok(metadata) = fs::metadata(path) else {
        return (None, None);
    };
    let to_unix_seconds = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
    };
    (
        to_unix_seconds(metadata.created()),
        to_unix_seconds(metadata.modified()),
    )
}

fn note_map(notes: &[IndexedNote], vault: &Path) -> HashMap<String, IndexedNote> {
    notes
        .iter()
        .filter_map(|note| {
            let rel = Path::new(&note.path).strip_prefix(vault).ok()?;
            Some((normalize_rel_path(rel), note.clone()))
        })
        .collect()
}

fn read_visible_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            !name.starts_with('.') && name != "assets"
        })
        .collect();
    entries.sort_by_key(|e| {
        let path = e.path();
        let is_file = path.is_file() as u8;
        let name = e.file_name().to_string_lossy().to_lowercase();
        (is_file, name)
    });
    Ok(entries)
}

fn tree_item_for_note(path: &Path, note: &IndexedNote, children: Vec<TreeItem>) -> TreeItem {
    let (created, filesystem_modified) = filesystem_timestamps(path);
    TreeItem {
        id: note.id.clone(),
        path: path_string(path),
        name: file_stem(path),
        item_type: "file".to_string(),
        icon: "file".to_string(),
        created,
        modified: note.modified.or(filesystem_modified),
        children: if children.is_empty() {
            None
        } else {
            Some(children)
        },
    }
}

fn scan_tree_dir(
    vault: &Path,
    dir: &Path,
    notes: &HashMap<String, IndexedNote>,
    in_bundle: bool,
) -> Result<Vec<TreeItem>, String> {
    let mut items = Vec::new();
    let bundle_main = if in_bundle {
        Some(dir.join(format!("{}.md", file_name(dir))))
    } else {
        None
    };

    for entry in read_visible_entries(dir)? {
        let path = entry.path();
        let raw_name = entry.file_name().to_string_lossy().to_string();
        if Some(path.as_path()) == bundle_main.as_deref() || raw_name == "Metadata.md" {
            continue;
        }
        if path.is_dir() {
            if is_bundle_dir(&path) {
                let main = path.join(format!("{}.md", file_name(&path)));
                let rel = main
                    .strip_prefix(vault)
                    .map(normalize_rel_path)
                    .map_err(|e| e.to_string())?;
                if let Some(note) = notes.get(&rel) {
                    let children = scan_tree_dir(vault, &path, notes, true)?;
                    items.push(tree_item_for_note(&main, note, children));
                }
            } else {
                let children = scan_tree_dir(vault, &path, notes, false)?;
                let (created, modified) = filesystem_timestamps(&path);
                items.push(TreeItem {
                    id: format!("folder:{}", path_string(&path)),
                    path: path_string(&path),
                    name: raw_name,
                    item_type: "folder".to_string(),
                    icon: "folder".to_string(),
                    created,
                    modified,
                    children: Some(children),
                });
            }
        } else if is_markdown(&path) {
            let rel = path
                .strip_prefix(vault)
                .map(normalize_rel_path)
                .map_err(|e| e.to_string())?;
            if let Some(note) = notes.get(&rel) {
                items.push(tree_item_for_note(&path, note, Vec::new()));
            }
        } else if is_canvas(&path) {
            let is_layer_sidecar = in_bundle && file_stem(&path) == file_name(dir);
            if !is_layer_sidecar {
                let (created, modified) = filesystem_timestamps(&path);
                items.push(TreeItem {
                    id: format!("canvas:{}", path_string(&path)),
                    path: path_string(&path),
                    name: file_stem(&path),
                    item_type: "canvas".to_string(),
                    icon: "canvas".to_string(),
                    created,
                    modified,
                    children: None,
                });
            }
        }
    }
    Ok(items)
}

pub fn build_tree(vault: &Path, notes: &[IndexedNote]) -> Result<Vec<TreeItem>, String> {
    scan_tree_dir(vault, vault, &note_map(notes, vault), false)
}
