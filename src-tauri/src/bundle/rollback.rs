use std::fs;
use std::path::Path;

use crate::model::FsMutationResult;

use super::path_ops::{file_name, file_stem, rename_path_case_safe};
use super::path_string;
use super::scan::{is_bundle_main_note, is_bundle_main_path, is_markdown};

pub(crate) fn rollback_rename_item(
    original_path: &Path,
    result: &FsMutationResult,
) -> Result<(), String> {
    let current = result
        .primary_path
        .as_deref()
        .map(Path::new)
        .ok_or("Rename result has no primary path")?;
    if is_markdown(original_path)
        && original_path.parent().and_then(|parent| parent.file_name()) == original_path.file_stem()
    {
        let old_dir = original_path.parent().ok_or("Bundle note has no parent")?;
        let old_stem = file_stem(original_path)?;
        let new_dir = current
            .parent()
            .ok_or("Renamed bundle note has no parent")?;
        let new_stem = file_stem(current)?;
        for ext in ["canvas", "excalidraw"] {
            let current_sidecar = new_dir.join(format!("{new_stem}.{ext}"));
            let old_sidecar = new_dir.join(format!("{old_stem}.{ext}"));
            if current_sidecar.exists() {
                rename_path_case_safe(&current_sidecar, &old_sidecar)?;
            }
        }
        let restored_main = new_dir.join(format!("{old_stem}.md"));
        if current != restored_main {
            rename_path_case_safe(current, &restored_main)?;
        }
        rename_path_case_safe(new_dir, old_dir)
    } else {
        rename_path_case_safe(current, original_path)
    }
}

/// Undo a completed move after a later transaction stage fails.
pub(crate) fn rollback_move_item(
    original_source: &Path,
    original_target: &Path,
    result: &FsMutationResult,
) -> Result<(), String> {
    let source_root = if is_bundle_main_path(original_source) {
        original_source
            .parent()
            .ok_or("Bundle note has no parent")?
            .to_path_buf()
    } else {
        original_source.to_path_buf()
    };
    let converted_target = is_markdown(original_target)
        && result.path_changes.iter().any(|change| {
            change.old_path == path_string(original_target)
                && Path::new(&change.new_path).parent()
                    == original_target
                        .parent()
                        .map(|parent| parent.join(file_stem(original_target).unwrap_or_default()))
                        .as_deref()
        });
    let target_dir = if converted_target {
        original_target
            .parent()
            .ok_or("Note has no parent")?
            .join(file_stem(original_target)?)
    } else if original_target.is_file() {
        if is_bundle_main_note(original_target) {
            original_target
                .parent()
                .ok_or("Bundle note has no parent")?
                .to_path_buf()
        } else {
            original_target
                .parent()
                .ok_or("Note has no parent")?
                .join(file_stem(original_target)?)
        }
    } else {
        original_target.to_path_buf()
    };
    let moved_root = target_dir.join(file_name(&source_root)?);
    fs::rename(&moved_root, &source_root).map_err(|error| error.to_string())?;

    // A standalone target was temporarily made into a bundle for the move.
    if converted_target {
        let stem = file_stem(original_target)?;
        let bundled_target = target_dir.join(format!("{stem}.md"));
        fs::rename(&bundled_target, original_target).map_err(|error| error.to_string())?;
        fs::remove_dir(&target_dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}
