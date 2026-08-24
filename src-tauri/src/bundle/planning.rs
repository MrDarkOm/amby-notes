use std::fs;
use std::path::{Path, PathBuf};

use crate::model::{FsMutationResult, PathChange};

use super::notes::resolve_item_root;
use super::path_ops::{ensure_rename_target_available, file_name, file_stem};
use super::path_string;
use super::scan::{is_bundle_main_note, is_markdown};

pub(super) fn collect_refactor_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    if root.is_file() {
        return Ok(vec![root.to_path_buf()]);
    }
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        paths.extend(collect_refactor_paths(
            &entry.map_err(|error| error.to_string())?.path(),
        )?);
    }
    Ok(paths)
}

pub(super) fn path_changes_for_prefix(
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

pub(super) fn bundle_rename_path_changes(
    paths: &[PathBuf],
    old_dir: &Path,
    new_dir: &Path,
    old_stem: &str,
    new_stem: &str,
) -> Vec<PathChange> {
    paths
        .iter()
        .filter_map(|old_path| {
            let relative = old_path.strip_prefix(old_dir).ok()?;
            let new_relative = if relative == Path::new(&format!("{old_stem}.md")) {
                PathBuf::from(format!("{new_stem}.md"))
            } else if relative == Path::new(&format!("{old_stem}.canvas")) {
                PathBuf::from(format!("{new_stem}.canvas"))
            } else if relative == Path::new(&format!("{old_stem}.excalidraw")) {
                PathBuf::from(format!("{new_stem}.excalidraw"))
            } else {
                relative.to_path_buf()
            };
            Some(PathChange {
                old_path: path_string(old_path),
                new_path: path_string(&new_dir.join(new_relative)),
            })
        })
        .collect()
}

pub(crate) fn preview_rename_item(path: &Path, new_name: &str) -> Result<FsMutationResult, String> {
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
        ensure_rename_target_available(bundle_dir, &new_dir)?;
        let old_paths = collect_refactor_paths(bundle_dir)?;
        let path_changes =
            bundle_rename_path_changes(&old_paths, bundle_dir, &new_dir, &old_stem, trimmed);
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
        ensure_rename_target_available(path, &new_path)?;
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
        ensure_rename_target_available(path, &new_path)?;
        let old_markdown_paths = collect_refactor_paths(path)?;
        Ok(FsMutationResult {
            primary_id: None,
            primary_path: Some(path_string(&new_path)),
            path_changes: path_changes_for_prefix(&old_markdown_paths, path, &new_path),
            deleted_paths: Vec::new(),
            deleted_ids: Vec::new(),
        })
    } else {
        Err(format!("Path not found: {}", path_string(path)))
    }
}

pub(crate) fn preview_move_item(
    source_path: &Path,
    target_path: &Path,
) -> Result<FsMutationResult, String> {
    let (target_dir, mut target_changes) = if target_path.is_file() {
        if !is_markdown(target_path) {
            return Err(format!("Not a markdown note: {}", path_string(target_path)));
        }
        if is_bundle_main_note(target_path) {
            (
                target_path
                    .parent()
                    .ok_or_else(|| "Bundle note has no parent".to_string())?
                    .to_path_buf(),
                Vec::new(),
            )
        } else {
            let stem = file_stem(target_path)?;
            let parent = target_path
                .parent()
                .ok_or_else(|| "Note has no parent".to_string())?;
            let bundle_dir = parent.join(&stem);
            if bundle_dir.exists() {
                return Err(format!(
                    "Bundle container already exists: {}",
                    path_string(&bundle_dir)
                ));
            }
            let new_note = bundle_dir.join(format!("{stem}.md"));
            (
                bundle_dir,
                vec![PathChange {
                    old_path: path_string(target_path),
                    new_path: path_string(&new_note),
                }],
            )
        }
    } else {
        (target_path.to_path_buf(), Vec::new())
    };
    if !target_path.is_file() && !target_dir.is_dir() {
        return Err(format!(
            "Target is not a directory: {}",
            path_string(&target_dir)
        ));
    }

    let source_root = resolve_item_root(source_path);
    if !source_root.exists() {
        return Err(format!("Source not found: {}", path_string(source_path)));
    }
    if target_dir.starts_with(&source_root) {
        return Err("Cannot move an item into itself".to_string());
    }
    let destination = target_dir.join(file_name(&source_root)?);
    if destination.exists() {
        return Err(format!(
            "Target already exists: {}",
            path_string(&destination)
        ));
    }

    let markdown_paths = collect_refactor_paths(&source_root)?;
    target_changes.extend(path_changes_for_prefix(
        &markdown_paths,
        &source_root,
        &destination,
    ));
    let primary_path = if is_bundle_main_note(source_path) {
        Some(path_string(
            &destination.join(format!("{}.md", file_stem(source_path)?)),
        ))
    } else {
        Some(path_string(&destination))
    };
    Ok(FsMutationResult {
        primary_id: None,
        primary_path,
        path_changes: target_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}
