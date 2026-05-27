mod frontmatter;
mod paths;
mod vault_index;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct TreeItem {
    pub id: String,
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeItem>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathChange {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsMutationResult {
    pub primary_id: Option<String>,
    pub primary_path: Option<String>,
    pub path_changes: Vec<PathChange>,
    pub deleted_paths: Vec<String>,
    pub deleted_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerResult {
    pub note_path: String,
    pub layer_path: String,
    pub kind: String,
    pub path_changes: Vec<PathChange>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoteLayers {
    pub canvas: bool,
    pub sketch: bool,
    pub database: bool,
}

#[derive(Serialize)]
pub struct FileMetadata {
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub word_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadata {
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub word_count: usize,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn file_stem(path: &Path) -> Result<String, String> {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Invalid note path: {}", path_string(path)))
}

fn file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Invalid path: {}", path_string(path)))
}

fn is_markdown(path: &Path) -> bool {
    path.extension().map_or(false, |ext| ext == "md")
}

#[cfg(test)]
fn is_bundle_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let Some(name) = dir.file_name().map(|s| s.to_string_lossy().to_string()) else {
        return false;
    };
    dir.join(format!("{name}.md")).is_file()
}

fn is_bundle_main_note(path: &Path) -> bool {
    if !path.is_file() || !is_markdown(path) {
        return false;
    }
    let Ok(stem) = file_stem(path) else {
        return false;
    };
    path.parent()
        .and_then(|p| p.file_name())
        .map(|name| name.to_string_lossy() == stem)
        .unwrap_or(false)
}

#[cfg(test)]
fn bundle_main_note(dir: &Path) -> Result<PathBuf, String> {
    let name = file_name(dir)?;
    Ok(dir.join(format!("{name}.md")))
}

#[cfg(test)]
fn sort_entries(entries: &mut Vec<fs::DirEntry>) {
    entries.sort_by_key(|e| {
        let path = e.path();
        let is_file = path.is_file() as u8;
        let name = e.file_name().to_string_lossy().to_lowercase();
        (is_file, name)
    });
}

#[cfg(test)]
fn read_visible_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .collect();
    sort_entries(&mut entries);
    Ok(entries)
}

#[cfg(test)]
fn tree_item_for_note(path: &Path, children: Option<Vec<TreeItem>>) -> TreeItem {
    let name = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    TreeItem {
        id: path_string(path),
        path: path_string(path),
        name,
        item_type: "file".to_string(),
        icon: "file".to_string(),
        children,
    }
}

#[cfg(test)]
fn scan_bundle_children(bundle_dir: &Path) -> Result<Vec<TreeItem>, String> {
    let main_note = bundle_main_note(bundle_dir)?;
    let mut items = Vec::new();

    for entry in read_visible_entries(bundle_dir)? {
        let path = entry.path();
        let raw_name = entry.file_name().to_string_lossy().to_string();

        if path == main_note || raw_name == "assets" {
            continue;
        }

        if path.is_dir() {
            if is_bundle_dir(&path) {
                let main = bundle_main_note(&path)?;
                let children = scan_bundle_children(&path)?;
                items.push(tree_item_for_note(
                    &main,
                    if children.is_empty() {
                        None
                    } else {
                        Some(children)
                    },
                ));
            } else {
                let children = scan_dir(&path)?;
                if !children.is_empty() {
                    items.push(TreeItem {
                        id: path_string(&path),
                        path: path_string(&path),
                        name: raw_name,
                        item_type: "folder".to_string(),
                        icon: "folder".to_string(),
                        children: Some(children),
                    });
                }
            }
        } else if is_markdown(&path) && raw_name != "Metadata.md" {
            items.push(tree_item_for_note(&path, None));
        }
    }

    Ok(items)
}

#[cfg(test)]
fn scan_dir(dir: &Path) -> Result<Vec<TreeItem>, String> {
    let mut items = Vec::new();

    for entry in read_visible_entries(dir)? {
        let path = entry.path();
        let raw_name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            if is_bundle_dir(&path) {
                let main = bundle_main_note(&path)?;
                let children = scan_bundle_children(&path)?;
                items.push(tree_item_for_note(
                    &main,
                    if children.is_empty() {
                        None
                    } else {
                        Some(children)
                    },
                ));
            } else {
                items.push(TreeItem {
                    id: path_string(&path),
                    path: path_string(&path),
                    name: raw_name,
                    item_type: "folder".to_string(),
                    icon: "folder".to_string(),
                    children: Some(scan_dir(&path)?),
                });
            }
        } else if is_markdown(&path) {
            items.push(tree_item_for_note(&path, None));
        } else if is_canvas_file(&path) {
            // Standalone canvas (bundle layer sidecars are hidden by scan_bundle_children).
            items.push(TreeItem {
                id: format!("canvas:{}", path_string(&path)),
                path: path_string(&path),
                name: file_stem(&path).unwrap_or_else(|_| raw_name.clone()),
                item_type: "canvas".to_string(),
                icon: "canvas".to_string(),
                children: None,
            });
        }
    }

    Ok(items)
}

fn collect_markdown_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    if root.is_file() {
        if is_markdown(root) {
            paths.push(root.to_path_buf());
        }
        return Ok(paths);
    }
    if !root.is_dir() {
        return Ok(paths);
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            paths.extend(collect_markdown_paths(&path)?);
        } else if is_markdown(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn path_changes_for_prefix(
    paths: &[PathBuf],
    old_prefix: &Path,
    new_prefix: &Path,
) -> Vec<PathChange> {
    paths
        .iter()
        .filter_map(|old_path| {
            let relative = old_path.strip_prefix(old_prefix).ok()?;
            let new_path = if relative.as_os_str().is_empty() {
                new_prefix.to_path_buf()
            } else {
                new_prefix.join(relative)
            };
            Some(PathChange {
                old_path: path_string(old_path),
                new_path: path_string(&new_path),
            })
        })
        .collect()
}

fn ensure_bundle_path(note_path: &Path) -> Result<(PathBuf, Vec<PathChange>), String> {
    if !note_path.is_file() || !is_markdown(note_path) {
        return Err(format!("Not a markdown note: {}", path_string(note_path)));
    }
    if is_bundle_main_note(note_path) {
        return Ok((note_path.to_path_buf(), Vec::new()));
    }

    let stem = file_stem(note_path)?;
    let parent = note_path
        .parent()
        .ok_or_else(|| format!("Note has no parent: {}", path_string(note_path)))?;
    let bundle_dir = parent.join(&stem);
    let new_note = bundle_dir.join(format!("{stem}.md"));

    if bundle_dir.exists() {
        return Err(format!(
            "Bundle container already exists: {}",
            path_string(&bundle_dir)
        ));
    }

    fs::create_dir(&bundle_dir).map_err(|e| e.to_string())?;
    fs::rename(note_path, &new_note).map_err(|e| e.to_string())?;

    Ok((
        new_note.clone(),
        vec![PathChange {
            old_path: path_string(note_path),
            new_path: path_string(&new_note),
        }],
    ))
}

fn resolve_item_root(path: &Path) -> PathBuf {
    if is_bundle_main_note(path) {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    }
}

fn create_note_impl(parent_path: &Path, name: &str) -> Result<FsMutationResult, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Invalid note name".to_string());
    }

    let (container, mut path_changes) = if parent_path.is_file() {
        let (main_note, changes) = ensure_bundle_path(parent_path)?;
        let parent = main_note
            .parent()
            .ok_or_else(|| format!("Bundle note has no parent: {}", path_string(&main_note)))?
            .to_path_buf();
        (parent, changes)
    } else {
        (parent_path.to_path_buf(), Vec::new())
    };

    if !container.is_dir() {
        return Err(format!("Not a directory: {}", path_string(&container)));
    }

    let new_note = container.join(format!("{trimmed}.md"));
    if new_note.exists() {
        return Err(format!("Note already exists: {}", path_string(&new_note)));
    }
    fs::write(&new_note, "").map_err(|e| e.to_string())?;

    path_changes.push(PathChange {
        old_path: String::new(),
        new_path: path_string(&new_note),
    });

    Ok(FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&new_note)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}

fn create_layer_impl(note_path: &Path, kind: &str) -> Result<LayerResult, String> {
    let (main_note, path_changes) = ensure_bundle_path(note_path)?;
    let bundle_dir = main_note
        .parent()
        .ok_or_else(|| format!("Bundle note has no parent: {}", path_string(&main_note)))?;
    let stem = file_stem(&main_note)?;

    let (layer_path, default_content) = match kind {
        "canvas" => (bundle_dir.join(format!("{stem}.canvas")), "{}\n"),
        "database" => (
            bundle_dir.join("Metadata.md"),
            "# Metadata\n\n```amby-db\n[]\n```\n",
        ),
        "sketch" => (bundle_dir.join(format!("{stem}.excalidraw")), "{}\n"),
        other => return Err(format!("Unknown layer kind: {other}")),
    };

    if !layer_path.exists() {
        fs::write(&layer_path, default_content).map_err(|e| e.to_string())?;
    }

    Ok(LayerResult {
        note_path: path_string(&main_note),
        layer_path: path_string(&layer_path),
        kind: kind.to_string(),
        path_changes,
    })
}

fn layer_file_path(note_path: &Path, kind: &str) -> Result<PathBuf, String> {
    let bundle_dir = note_path
        .parent()
        .ok_or_else(|| "Bundle note has no parent".to_string())?;
    let stem = file_stem(note_path)?;
    let parent_name = bundle_dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if parent_name != stem {
        return Err(format!("Note is not a bundle: {}", path_string(note_path)));
    }
    Ok(match kind {
        "canvas" => bundle_dir.join(format!("{stem}.canvas")),
        "sketch" => bundle_dir.join(format!("{stem}.excalidraw")),
        "database" => bundle_dir.join("Metadata.md"),
        other => return Err(format!("Unknown layer kind: {other}")),
    })
}

fn is_canvas_file(path: &Path) -> bool {
    path.extension().map_or(false, |ext| ext == "canvas")
}

/// Create a standalone `.canvas` file inside the given container (or next to a note).
fn create_canvas_impl(parent_path: &Path, name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Invalid canvas name".to_string());
    }
    let container = if parent_path.is_dir() {
        parent_path.to_path_buf()
    } else if parent_path.is_file() {
        parent_path
            .parent()
            .ok_or_else(|| format!("Path has no parent: {}", path_string(parent_path)))?
            .to_path_buf()
    } else {
        parent_path.to_path_buf()
    };
    if !container.is_dir() {
        return Err(format!("Not a directory: {}", path_string(&container)));
    }
    let path = unique_path(&container, trimmed, "canvas");
    fs::write(&path, "{}\n").map_err(|e| e.to_string())?;
    Ok(path)
}

/// Promote a standalone `.canvas` into a freshly-created note's bundle as its canvas layer.
fn attach_canvas_impl(canvas_path: &Path) -> Result<FsMutationResult, String> {
    if !canvas_path.is_file() || !is_canvas_file(canvas_path) {
        return Err(format!("Not a canvas file: {}", path_string(canvas_path)));
    }
    let dir = canvas_path
        .parent()
        .ok_or_else(|| format!("Canvas has no parent: {}", path_string(canvas_path)))?;
    let stem = file_stem(canvas_path)?;

    // Create a sibling note (unique name), then turn it into a bundle that owns the canvas.
    let note_path = unique_path(dir, &stem, "md");
    fs::write(&note_path, "").map_err(|e| e.to_string())?;
    let (main_note, mut path_changes) = ensure_bundle_path(&note_path)?;
    let bundle_dir = main_note
        .parent()
        .ok_or_else(|| "Bundle note has no parent".to_string())?;
    let note_stem = file_stem(&main_note)?;
    let target = bundle_dir.join(format!("{note_stem}.canvas"));
    fs::rename(canvas_path, &target).map_err(|e| e.to_string())?;

    path_changes.push(PathChange {
        old_path: path_string(canvas_path),
        new_path: path_string(&target),
    });
    path_changes.push(PathChange {
        old_path: String::new(),
        new_path: path_string(&main_note),
    });

    Ok(FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&main_note)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}

fn unique_path(base_dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = base_dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    let mut i = 2;
    loop {
        let candidate = base_dir.join(format!("{stem}_{i}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

fn unlink_layer_impl(note_path: &Path, kind: &str) -> Result<FsMutationResult, String> {
    let layer_path = layer_file_path(note_path, kind)?;
    if !layer_path.exists() {
        return Err(format!("Layer file not found: {}", path_string(&layer_path)));
    }
    let bundle_dir = layer_path
        .parent()
        .ok_or_else(|| "Layer file has no parent".to_string())?;
    let target_dir = bundle_dir
        .parent()
        .ok_or_else(|| "Bundle has no parent dir".to_string())?;
    let stem = file_stem(note_path)?;
    let ext = layer_path
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let new_stem = match kind {
        "database" => format!("{stem}_metadata_ul"),
        _ => format!("{stem}_ul"),
    };
    let new_path = unique_path(target_dir, &new_stem, &ext);
    fs::rename(&layer_path, &new_path).map_err(|e| e.to_string())?;

    let mut path_changes = Vec::new();
    if is_markdown(&layer_path) {
        path_changes.push(PathChange {
            old_path: path_string(&layer_path),
            new_path: path_string(&new_path),
        });
    }
    Ok(FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(note_path)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}

fn delete_layer_impl(note_path: &Path, kind: &str) -> Result<FsMutationResult, String> {
    let layer_path = layer_file_path(note_path, kind)?;
    if !layer_path.exists() {
        return Err(format!("Layer file not found: {}", path_string(&layer_path)));
    }
    let deleted_paths = if is_markdown(&layer_path) {
        vec![path_string(&layer_path)]
    } else {
        Vec::new()
    };
    trash::delete(&layer_path).map_err(|e| e.to_string())?;
    Ok(FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(note_path)),
        path_changes: Vec::new(),
        deleted_paths,
        deleted_ids: Vec::new(),
    })
}

fn rename_item_impl(path: &Path, new_name: &str) -> Result<FsMutationResult, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Invalid item name".to_string());
    }

    if is_bundle_main_note(path) {
        let bundle_dir = path
            .parent()
            .ok_or_else(|| "Bundle note has no parent".to_string())?;
        let parent = bundle_dir
            .parent()
            .ok_or_else(|| "Bundle has no parent".to_string())?;
        let old_stem = file_stem(path)?;
        let new_dir = parent.join(trimmed);
        let new_main = new_dir.join(format!("{trimmed}.md"));

        if new_dir.exists() {
            return Err(format!("Target already exists: {}", path_string(&new_dir)));
        }

        let old_markdown_paths = collect_markdown_paths(bundle_dir)?;
        let mut path_changes = path_changes_for_prefix(&old_markdown_paths, bundle_dir, &new_dir);

        fs::rename(bundle_dir, &new_dir).map_err(|e| e.to_string())?;

        let renamed_main = new_dir.join(format!("{old_stem}.md"));
        if renamed_main != new_main {
            if new_main.exists() {
                return Err(format!("Target already exists: {}", path_string(&new_main)));
            }
            fs::rename(&renamed_main, &new_main).map_err(|e| e.to_string())?;
        }

        for ext in ["canvas", "excalidraw"] {
            let old_sidecar = new_dir.join(format!("{old_stem}.{ext}"));
            if old_sidecar.exists() {
                let new_sidecar = new_dir.join(format!("{trimmed}.{ext}"));
                if new_sidecar.exists() {
                    return Err(format!(
                        "Target already exists: {}",
                        path_string(&new_sidecar)
                    ));
                }
                fs::rename(old_sidecar, new_sidecar).map_err(|e| e.to_string())?;
            }
        }

        for change in &mut path_changes {
            if change.old_path == path_string(path) {
                change.new_path = path_string(&new_main);
            }
        }

        Ok(FsMutationResult {
            primary_id: None,
            primary_path: Some(path_string(&new_main)),
            path_changes,
            deleted_paths: Vec::new(),
            deleted_ids: Vec::new(),
        })
    } else if path.is_file() {
        let parent = path
            .parent()
            .ok_or_else(|| "File has no parent".to_string())?;
        let ext = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let new_path = parent.join(format!("{trimmed}{ext}"));
        if new_path.exists() {
            return Err(format!("Target already exists: {}", path_string(&new_path)));
        }
        fs::rename(path, &new_path).map_err(|e| e.to_string())?;
        Ok(FsMutationResult {
            primary_id: None,
            primary_path: Some(path_string(&new_path)),
            path_changes: vec![PathChange {
                old_path: path_string(path),
                new_path: path_string(&new_path),
            }],
            deleted_paths: Vec::new(),
            deleted_ids: Vec::new(),
        })
    } else if path.is_dir() {
        let parent = path
            .parent()
            .ok_or_else(|| "Folder has no parent".to_string())?;
        let new_path = parent.join(trimmed);
        if new_path.exists() {
            return Err(format!("Target already exists: {}", path_string(&new_path)));
        }
        let old_markdown_paths = collect_markdown_paths(path)?;
        let path_changes = path_changes_for_prefix(&old_markdown_paths, path, &new_path);
        fs::rename(path, &new_path).map_err(|e| e.to_string())?;
        Ok(FsMutationResult {
            primary_id: None,
            primary_path: Some(path_string(&new_path)),
            path_changes,
            deleted_paths: Vec::new(),
            deleted_ids: Vec::new(),
        })
    } else {
        Err(format!("Path not found: {}", path_string(path)))
    }
}

fn move_item_impl(source_path: &Path, target_path: &Path) -> Result<FsMutationResult, String> {
    let target_dir = if target_path.is_file() {
        let (main_note, mut target_changes) = ensure_bundle_path(target_path)?;
        let dir = main_note
            .parent()
            .ok_or_else(|| format!("Bundle note has no parent: {}", path_string(&main_note)))?
            .to_path_buf();
        let mut result = move_item_to_dir(source_path, &dir)?;
        result.path_changes.splice(0..0, target_changes.drain(..));
        return Ok(result);
    } else {
        target_path.to_path_buf()
    };

    move_item_to_dir(source_path, &target_dir)
}

fn move_item_to_dir(source_path: &Path, target_dir: &Path) -> Result<FsMutationResult, String> {
    if !target_dir.is_dir() {
        return Err(format!(
            "Target is not a directory: {}",
            path_string(target_dir)
        ));
    }

    let source_root = resolve_item_root(source_path);
    if !source_root.exists() {
        return Err(format!("Source not found: {}", path_string(source_path)));
    }
    if target_dir.starts_with(&source_root) {
        return Err("Cannot move an item into itself".to_string());
    }

    let source_name = file_name(&source_root)?;
    let destination = target_dir.join(source_name);
    if destination.exists() {
        return Err(format!(
            "Target already exists: {}",
            path_string(&destination)
        ));
    }

    let markdown_paths = collect_markdown_paths(&source_root)?;
    let path_changes = path_changes_for_prefix(&markdown_paths, &source_root, &destination);
    fs::rename(&source_root, &destination).map_err(|e| e.to_string())?;

    let primary_path = if is_bundle_main_note(source_path) {
        let stem = file_stem(source_path)?;
        Some(path_string(&destination.join(format!("{stem}.md"))))
    } else if source_path.is_file() {
        Some(path_string(&destination))
    } else {
        Some(path_string(&destination))
    };

    Ok(FsMutationResult {
        primary_id: None,
        primary_path,
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}

fn delete_item_impl(path: &Path) -> Result<FsMutationResult, String> {
    let delete_root = resolve_item_root(path);
    if !delete_root.exists() {
        return Err(format!("Path not found: {}", path_string(path)));
    }

    let deleted_paths = collect_markdown_paths(&delete_root)?
        .into_iter()
        .map(|p| path_string(&p))
        .collect();
    trash::delete(&delete_root).map_err(|e| e.to_string())?;

    Ok(FsMutationResult {
        primary_id: None,
        primary_path: None,
        path_changes: Vec::new(),
        deleted_paths,
        deleted_ids: Vec::new(),
    })
}

fn deleted_ids_for_paths(vault_path: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let conn = vault_index::open_connection(vault_path)?;
    let notes = vault_index::list_notes(&conn, vault_path)?;
    let by_path: std::collections::HashMap<_, _> =
        notes.into_iter().map(|note| (note.path, note.id)).collect();
    Ok(paths
        .iter()
        .filter_map(|path| by_path.get(path).cloned())
        .collect())
}

fn sync_mutation_result(vault_path: &Path, mut result: FsMutationResult) -> Result<FsMutationResult, String> {
    let loaded = vault_index::load_vault(vault_path)?;
    result.primary_id = result.primary_path.as_ref().and_then(|primary_path| {
        loaded
            .notes
            .iter()
            .find(|note| &note.path == primary_path)
            .map(|note| note.id.clone())
    });
    Ok(result)
}

/// Mark `vault_path` as the active vault: record it for path guards and grant
/// the fs + asset-protocol scopes dynamically (instead of a static recursive
/// scope over the whole home directory).
fn activate_vault(
    app: &tauri::AppHandle,
    scope: &paths::VaultScope,
    vault_path: &str,
) -> Result<PathBuf, String> {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    let canonical = Path::new(vault_path)
        .canonicalize()
        .map_err(|e| format!("Vault not accessible: {e}"))?;
    scope.set(canonical.clone());
    let _ = app.fs_scope().allow_directory(&canonical, true);
    let _ = app.asset_protocol_scope().allow_directory(&canonical, true);
    Ok(canonical)
}

#[tauri::command]
async fn load_vault(
    app: tauri::AppHandle,
    scope: tauri::State<'_, paths::VaultScope>,
    vault_path: String,
) -> Result<vault_index::LoadVaultResult, String> {
    activate_vault(&app, &scope, &vault_path)?;
    tauri::async_runtime::spawn_blocking(move || vault_index::load_vault(Path::new(&vault_path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_files(vault_path: String) -> Result<Vec<vault_index::TreeItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vault_index::load_vault(Path::new(&vault_path)).map(|loaded| loaded.tree)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn read_file(scope: tauri::State<paths::VaultScope>, path: String) -> Result<String, String> {
    paths::guard(&scope, &path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(
    scope: tauri::State<paths::VaultScope>,
    path: String,
    content: String,
) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_note(vault_path: String, note_id: String) -> Result<String, String> {
    vault_index::read_note(Path::new(&vault_path), &note_id)
}

#[tauri::command]
fn write_note(vault_path: String, note_id: String, content: String) -> Result<(), String> {
    vault_index::write_note(Path::new(&vault_path), &note_id, &content)
}

#[tauri::command]
fn get_note_metadata(vault_path: String, note_id: String) -> Result<NoteMetadata, String> {
    let note = vault_index::note_metadata(Path::new(&vault_path), &note_id)?;
    Ok(NoteMetadata {
        created: None,
        modified: note.modified,
        word_count: note.word_count,
    })
}

#[tauri::command]
async fn list_tags(vault_path: String) -> Result<Vec<vault_index::TagEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || vault_index::list_tags(Path::new(&vault_path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_notes(vault_path: String, query: String) -> Result<Vec<vault_index::SearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vault_index::search_notes(Path::new(&vault_path), &query)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_link_graph(vault_path: String) -> Result<vault_index::LinkGraph, String> {
    tauri::async_runtime::spawn_blocking(move || vault_index::link_graph(Path::new(&vault_path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn ensure_bundle(vault_path: String, path: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let (primary, path_changes) = ensure_bundle_path(Path::new(&path))?;
    sync_mutation_result(Path::new(&vault_path), FsMutationResult {
        primary_id: None,
        primary_path: Some(path_string(&primary)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}

#[tauri::command]
fn create_note(vault_path: String, parent_path: String, name: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &parent_path)?;
    let result = create_note_impl(Path::new(&parent_path), &name)?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn create_layer(
    scope: tauri::State<paths::VaultScope>,
    note_path: String,
    kind: String,
) -> Result<LayerResult, String> {
    paths::guard(&scope, &note_path)?;
    create_layer_impl(Path::new(&note_path), &kind)
}

#[tauri::command]
fn create_canvas(vault_path: String, parent_path: String, name: String) -> Result<String, String> {
    paths::guard_in(&vault_path, &parent_path)?;
    let path = create_canvas_impl(Path::new(&parent_path), &name)?;
    vault_index::load_vault(Path::new(&vault_path))?;
    Ok(path_string(&path))
}

#[tauri::command]
fn attach_canvas_to_note(vault_path: String, canvas_path: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &canvas_path)?;
    let result = attach_canvas_impl(Path::new(&canvas_path))?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn unlink_layer(vault_path: String, note_path: String, kind: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let result = unlink_layer_impl(Path::new(&note_path), &kind)?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn delete_layer(vault_path: String, note_path: String, kind: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let mut result = delete_layer_impl(Path::new(&note_path), &kind)?;
    if !result.deleted_paths.is_empty() {
        result.deleted_ids = deleted_ids_for_paths(Path::new(&vault_path), &result.deleted_paths)?;
    }
    vault_index::load_vault(Path::new(&vault_path))?;
    Ok(result)
}

#[tauri::command]
fn note_layers(
    scope: tauri::State<paths::VaultScope>,
    note_path: String,
) -> Result<NoteLayers, String> {
    paths::guard(&scope, &note_path)?;
    let path = Path::new(&note_path);
    let mut layers = NoteLayers::default();
    if !path.is_file() {
        return Ok(layers);
    }
    let Some(parent) = path.parent() else {
        return Ok(layers);
    };
    let Some(parent_name) = parent.file_name().map(|s| s.to_string_lossy().to_string()) else {
        return Ok(layers);
    };
    let stem = file_stem(path)?;
    if parent_name != stem {
        return Ok(layers);
    }
    layers.canvas = parent.join(format!("{stem}.canvas")).is_file();
    layers.sketch = parent.join(format!("{stem}.excalidraw")).is_file();
    layers.database = parent.join("Metadata.md").is_file();
    Ok(layers)
}

#[tauri::command]
fn move_item(vault_path: String, source_path: String, target_path: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &source_path)?;
    paths::guard_in(&vault_path, &target_path)?;
    let result = move_item_impl(Path::new(&source_path), Path::new(&target_path))?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn create_file(scope: tauri::State<paths::VaultScope>, path: String) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if Path::new(&path).exists() {
        return Err(format!("File already exists: {path}"));
    }
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_folder(scope: tauri::State<paths::VaultScope>, path: String) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    if Path::new(&path).exists() {
        return Err(format!("Folder already exists: {path}"));
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_item(vault_path: String, path: String, new_name: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let result = rename_item_impl(Path::new(&path), &new_name)?;
    sync_mutation_result(Path::new(&vault_path), result)
}

#[tauri::command]
fn delete_item(vault_path: String, path: String) -> Result<FsMutationResult, String> {
    paths::guard_in(&vault_path, &path)?;
    let mut result = delete_item_impl(Path::new(&path))?;
    result.deleted_ids = deleted_ids_for_paths(Path::new(&vault_path), &result.deleted_paths)?;
    vault_index::load_vault(Path::new(&vault_path))?;
    Ok(result)
}

#[tauri::command]
fn get_file_metadata(
    scope: tauri::State<paths::VaultScope>,
    path: String,
) -> Result<FileMetadata, String> {
    paths::guard(&scope, &path)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;

    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    Ok(FileMetadata {
        created,
        modified,
        word_count: content.split_whitespace().count(),
    })
}

#[tauri::command]
fn open_in_explorer(
    scope: tauri::State<paths::VaultScope>,
    path: String,
) -> Result<(), String> {
    paths::guard(&scope, &path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let arg = format!("/select,\"{}\"", path);
        std::process::Command::new("explorer")
            .raw_arg(&arg)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAsset {
    pub rel_path: String,
    pub abs_path: String,
    pub file_name: String,
    pub kind: String,
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

fn classify_ext(ext: &str) -> &'static str {
    let ext = ext.to_lowercase();
    if IMAGE_EXTS.iter().any(|e| *e == ext) {
        "image"
    } else {
        "file"
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn assets_dir_for(vault: &Path, note: &Path) -> PathBuf {
    if is_bundle_main_note(note) {
        if let Some(parent) = note.parent() {
            return parent.join("assets");
        }
    }
    vault.join("assets")
}

fn unique_name(dir: &Path, stem: &str, ext: &str) -> String {
    let safe_stem: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let safe_stem = if safe_stem.is_empty() { "asset".to_string() } else { safe_stem };
    let initial = if ext.is_empty() {
        safe_stem.clone()
    } else {
        format!("{safe_stem}.{ext}")
    };
    if !dir.join(&initial).exists() {
        return initial;
    }
    let suffix = now_millis();
    if ext.is_empty() {
        format!("{safe_stem}-{suffix}")
    } else {
        format!("{safe_stem}-{suffix}.{ext}")
    }
}

fn relative_for_markdown(vault: &Path, note: &Path, asset_abs: &Path) -> String {
    // Prefer note-relative path (works for bundle assets like `assets/foo.png`).
    if let Some(note_dir) = note.parent() {
        if let Ok(rel) = asset_abs.strip_prefix(note_dir) {
            return path_string(rel).replace('\\', "/");
        }
    }
    if let Ok(rel) = asset_abs.strip_prefix(vault) {
        return path_string(rel).replace('\\', "/");
    }
    path_string(asset_abs)
}

fn build_imported_asset(vault: &Path, note: &Path, abs_path: PathBuf, file_name: String) -> ImportedAsset {
    let ext = abs_path
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let kind = classify_ext(&ext).to_string();
    let rel_path = relative_for_markdown(vault, note, &abs_path);
    ImportedAsset {
        rel_path,
        abs_path: path_string(&abs_path),
        file_name,
        kind,
    }
}

#[tauri::command]
fn import_asset(
    vault_path: String,
    note_path: String,
    source_path: String,
) -> Result<ImportedAsset, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let vault = Path::new(&vault_path);
    let note = Path::new(&note_path);
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("Source is not a file: {source_path}"));
    }
    let dir = assets_dir_for(vault, note);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".to_string());
    let ext = source
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = unique_name(&dir, &stem, &ext);
    let dest = dir.join(&name);
    fs::copy(source, &dest).map_err(|e| e.to_string())?;
    Ok(build_imported_asset(vault, note, dest, name))
}

#[tauri::command]
fn import_asset_bytes(
    vault_path: String,
    note_path: String,
    bytes: Vec<u8>,
    suggested_ext: String,
) -> Result<ImportedAsset, String> {
    paths::guard_in(&vault_path, &note_path)?;
    let vault = Path::new(&vault_path);
    let note = Path::new(&note_path);
    let dir = assets_dir_for(vault, note);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = suggested_ext.trim_start_matches('.').to_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    let stem = format!("pasted-{}", now_millis());
    let name = unique_name(&dir, &stem, &ext);
    let dest = dir.join(&name);
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(build_imported_asset(vault, note, dest, name))
}

#[tauri::command]
async fn pick_asset_file(
    app: tauri::AppHandle,
    images_only: bool,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    let mut builder = app.dialog().file();
    if images_only {
        builder = builder.add_filter("Image", IMAGE_EXTS);
    }
    builder.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let result = rx.await.map_err(|e| e.to_string())?;
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
async fn open_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result = rx.await.map_err(|e| e.to_string())?;
    Ok(result.map(|p| p.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(paths::VaultScope::default())
        .invoke_handler(tauri::generate_handler![
            load_vault,
            list_files,
            read_file,
            write_file,
            read_note,
            write_note,
            get_note_metadata,
            list_tags,
            search_notes,
            get_link_graph,
            ensure_bundle,
            create_note,
            create_layer,
            create_canvas,
            attach_canvas_to_note,
            unlink_layer,
            delete_layer,
            note_layers,
            move_item,
            create_file,
            create_folder,
            rename_item,
            delete_item,
            get_file_metadata,
            open_vault,
            open_in_explorer,
            import_asset,
            import_asset_bytes,
            pick_asset_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("amby-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_hides_bundle_sidecars_and_exposes_child_notes() {
        let vault = temp_vault("scan");
        fs::write(vault.join("Loose.md"), "").unwrap();
        fs::create_dir(vault.join("Parent")).unwrap();
        fs::write(vault.join("Parent/Parent.md"), "").unwrap();
        fs::write(vault.join("Parent/Child.md"), "").unwrap();
        fs::write(vault.join("Parent/Parent.canvas"), "{}").unwrap();
        fs::write(vault.join("Parent/Metadata.md"), "").unwrap();
        fs::create_dir(vault.join("Parent/assets")).unwrap();
        fs::write(vault.join("Parent/assets/image.png"), "").unwrap();
        // Standalone canvas (not a note's layer sidecar) should surface in the tree.
        fs::write(vault.join("Board.canvas"), "{}").unwrap();

        let tree = scan_dir(&vault).unwrap();
        let parent = tree.iter().find(|item| item.name == "Parent").unwrap();
        assert_eq!(parent.item_type, "file");
        assert_eq!(parent.id, path_string(&vault.join("Parent/Parent.md")));
        let children = parent.children.as_ref().unwrap();
        // Only Child.md is exposed; Parent.canvas (layer sidecar) stays hidden.
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "Child");

        let board = tree.iter().find(|item| item.name == "Board").unwrap();
        assert_eq!(board.item_type, "canvas");
        assert_eq!(board.icon, "canvas");
    }

    #[test]
    fn ensure_bundle_transforms_simple_note() {
        let vault = temp_vault("ensure");
        let note = vault.join("Doc.md");
        fs::write(&note, "hello").unwrap();

        let (main, changes) = ensure_bundle_path(&note).unwrap();

        assert!(!note.exists());
        assert_eq!(main, vault.join("Doc/Doc.md"));
        assert_eq!(fs::read_to_string(&main).unwrap(), "hello");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].old_path, path_string(&note));
        assert_eq!(changes[0].new_path, path_string(&main));
    }

    #[test]
    fn moving_note_onto_note_creates_target_bundle() {
        let vault = temp_vault("move");
        let source = vault.join("A.md");
        let target = vault.join("B.md");
        fs::write(&source, "a").unwrap();
        fs::write(&target, "b").unwrap();

        let result = move_item_impl(&source, &target).unwrap();

        assert!(vault.join("B/B.md").exists());
        assert!(vault.join("B/A.md").exists());
        assert!(result
            .path_changes
            .iter()
            .any(|change| change.old_path == path_string(&target)
                && change.new_path == path_string(&vault.join("B/B.md"))));
        assert!(result
            .path_changes
            .iter()
            .any(|change| change.old_path == path_string(&source)
                && change.new_path == path_string(&vault.join("B/A.md"))));
    }

    #[test]
    fn renaming_bundle_renames_container_main_note_and_sidecars() {
        let vault = temp_vault("rename");
        fs::create_dir(vault.join("Old")).unwrap();
        fs::write(vault.join("Old/Old.md"), "").unwrap();
        fs::write(vault.join("Old/Old.canvas"), "").unwrap();
        fs::write(vault.join("Old/Old.excalidraw"), "").unwrap();
        fs::write(vault.join("Old/Child.md"), "").unwrap();

        let result = rename_item_impl(&vault.join("Old/Old.md"), "New").unwrap();

        assert!(vault.join("New/New.md").exists());
        assert!(vault.join("New/New.canvas").exists());
        assert!(vault.join("New/New.excalidraw").exists());
        assert!(vault.join("New/Child.md").exists());
        assert!(!vault.join("Old").exists());
        assert_eq!(
            result.primary_path,
            Some(path_string(&vault.join("New/New.md")))
        );
        assert!(result.path_changes.iter().any(|change| change.old_path
            == path_string(&vault.join("Old/Child.md"))
            && change.new_path == path_string(&vault.join("New/Child.md"))));
    }
}
