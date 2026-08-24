use std::fs;
use std::path::{Path, PathBuf};

use crate::model::{FsMutationResult, PathChange};

use super::notes::{ensure_bundle_path, resolve_item_root, rollback_bundle_promotion};
use super::path_ops::{
    ensure_rename_target_available, file_name, file_stem, rename_path_case_safe,
};
use super::path_string;
use super::planning::{
    bundle_rename_path_changes, collect_refactor_paths, path_changes_for_prefix,
};
use super::scan::is_bundle_main_note;

fn rollback_partial_bundle_rename(
    new_dir: &Path,
    old_dir: &Path,
    renamed_inside_new_dir: &[(PathBuf, PathBuf)],
) -> Result<(), String> {
    for (current, previous) in renamed_inside_new_dir.iter().rev() {
        if current.exists() {
            rename_path_case_safe(current, previous)?;
        }
    }
    rename_path_case_safe(new_dir, old_dir)
}

pub(crate) fn rename_item_impl(path: &Path, new_name: &str) -> Result<FsMutationResult, String> {
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

        let rename_specs = ["md", "canvas", "excalidraw"]
            .into_iter()
            .filter_map(|ext| {
                let old_path = bundle_dir.join(format!("{old_stem}.{ext}"));
                if !old_path.exists() {
                    return None;
                }
                let new_path = bundle_dir.join(format!("{trimmed}.{ext}"));
                Some((old_path, new_path))
            })
            .collect::<Vec<_>>();
        for (old_path, new_path) in &rename_specs {
            ensure_rename_target_available(old_path, new_path)?;
        }

        rename_path_case_safe(bundle_dir, &new_dir)?;

        let mut renamed_inside_new_dir = Vec::new();
        for (old_path, new_path) in rename_specs {
            let old_name = old_path.file_name().ok_or("Bundle file has no name")?;
            let new_name = new_path.file_name().ok_or("Bundle file has no name")?;
            let current = new_dir.join(old_name);
            let renamed = new_dir.join(new_name);
            if current == renamed {
                continue;
            }
            if let Err(error) = rename_path_case_safe(&current, &renamed) {
                return Err(
                    match rollback_partial_bundle_rename(
                        &new_dir,
                        bundle_dir,
                        &renamed_inside_new_dir,
                    ) {
                        Ok(()) => format!("Could not rename bundle file: {error}"),
                        Err(rollback_error) => format!(
                        "Could not rename bundle file: {error}; rollback failed: {rollback_error}"
                    ),
                    },
                );
            }
            renamed_inside_new_dir.push((renamed, current));
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
        ensure_rename_target_available(path, &new_path)?;
        rename_path_case_safe(path, &new_path)?;
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
        let path_changes = path_changes_for_prefix(&old_markdown_paths, path, &new_path);
        rename_path_case_safe(path, &new_path)?;
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

pub(crate) fn move_item_impl(
    source_path: &Path,
    target_path: &Path,
) -> Result<FsMutationResult, String> {
    let target_dir = if target_path.is_file() {
        let promoted_target = !is_bundle_main_note(target_path);
        let (main_note, mut target_changes) = ensure_bundle_path(target_path)?;
        let dir = main_note
            .parent()
            .ok_or_else(|| format!("Bundle note has no parent: {}", path_string(&main_note)))?
            .to_path_buf();
        let mut result = match move_item_to_dir(source_path, &dir) {
            Ok(result) => result,
            Err(error) => {
                if promoted_target {
                    if let Err(rollback_error) = rollback_bundle_promotion(target_path, &main_note)
                    {
                        return Err(format!(
                            "Move failed: {error}; target bundle rollback failed: {rollback_error}"
                        ));
                    }
                }
                return Err(error);
            }
        };
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

    let markdown_paths = collect_refactor_paths(&source_root)?;
    let path_changes = path_changes_for_prefix(&markdown_paths, &source_root, &destination);
    fs::rename(&source_root, &destination).map_err(|e| e.to_string())?;

    let primary_path = if is_bundle_main_note(source_path) {
        let stem = file_stem(source_path)?;
        Some(path_string(&destination.join(format!("{stem}.md"))))
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

// ── Assets ────────────────────────────────────────────────────────────────
