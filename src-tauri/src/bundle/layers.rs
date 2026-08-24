use std::fs;
use std::path::{Path, PathBuf};

use crate::frontmatter;
use crate::model::{FsMutationResult, LayerResult, PathChange};

use super::notes::{ensure_bundle_path, rollback_bundle_promotion};
use super::path_ops::file_stem;
use super::path_string;
use super::scan::is_markdown;

pub(crate) fn create_layer_impl(note_path: &Path, kind: &str) -> Result<LayerResult, String> {
    if !matches!(kind, "canvas" | "database" | "sketch") {
        return Err(format!("Unknown layer kind: {kind}"));
    }
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
        _ => unreachable!("layer kind was validated before bundle promotion"),
    };

    if !layer_path.exists() {
        if let Err(error) = frontmatter::atomic_write_new(&layer_path, default_content) {
            // Another process may have created the layer after the existence
            // check. Its file is now the authoritative layer; never replace it.
            if matches!(error, frontmatter::AtomicCreateError::AlreadyExists) {
                return Ok(LayerResult {
                    note_path: path_string(&main_note),
                    layer_path: path_string(&layer_path),
                    kind: kind.to_string(),
                    path_changes,
                });
            }
            let frontmatter::AtomicCreateError::Other(error) = error else {
                unreachable!("AlreadyExists was handled above");
            };
            if !path_changes.is_empty() {
                if let Err(rollback_error) = rollback_bundle_promotion(note_path, &main_note) {
                    return Err(format!(
                        "Could not create layer: {error}; bundle rollback failed: {rollback_error}"
                    ));
                }
            }
            return Err(error);
        }
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
    path.extension().is_some_and(|ext| ext == "canvas")
}

fn unique_note_path(base_dir: &Path, stem: &str) -> PathBuf {
    let mut index = 1;
    loop {
        let candidate_stem = if index == 1 {
            stem.to_string()
        } else {
            format!("{stem}_{index}")
        };
        let note = base_dir.join(format!("{candidate_stem}.md"));
        let bundle = base_dir.join(&candidate_stem);
        if !note.exists() && !bundle.exists() {
            return note;
        }
        index += 1;
    }
}

fn unique_canvas_path(base_dir: &Path, stem: &str) -> PathBuf {
    let mut index = 1;
    loop {
        let candidate_stem = if index == 1 {
            stem.to_string()
        } else {
            format!("{stem}_{index}")
        };
        let canvas = base_dir.join(format!("{candidate_stem}.canvas"));
        let note = base_dir.join(format!("{candidate_stem}.md"));
        let bundle = base_dir.join(&candidate_stem);
        if !canvas.exists() && !note.exists() && !bundle.exists() {
            return canvas;
        }
        index += 1;
    }
}

/// Create a standalone `.canvas` file inside the given container (or next to a note).
pub(crate) fn create_canvas_impl(parent_path: &Path, name: &str) -> Result<PathBuf, String> {
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
    let path = unique_canvas_path(&container, trimmed);
    match frontmatter::atomic_write_new(&path, "{}\n") {
        Ok(()) => {}
        Err(frontmatter::AtomicCreateError::AlreadyExists) => {
            return Err(format!("Canvas already exists: {}", path_string(&path)));
        }
        Err(frontmatter::AtomicCreateError::Other(error)) => return Err(error),
    }
    Ok(path)
}

/// Promote a standalone `.canvas` into a freshly-created note's bundle as its canvas layer.
pub(crate) fn attach_canvas_impl(canvas_path: &Path) -> Result<FsMutationResult, String> {
    if !canvas_path.is_file() || !is_canvas_file(canvas_path) {
        return Err(format!("Not a canvas file: {}", path_string(canvas_path)));
    }
    let dir = canvas_path
        .parent()
        .ok_or_else(|| format!("Canvas has no parent: {}", path_string(canvas_path)))?;
    let stem = file_stem(canvas_path)?;

    // Create a sibling note (unique name), then turn it into a bundle that owns the canvas.
    let note_path = unique_note_path(dir, &stem);
    match frontmatter::atomic_write_new(&note_path, "") {
        Ok(()) => {}
        Err(frontmatter::AtomicCreateError::AlreadyExists) => {
            return Err(format!("Note already exists: {}", path_string(&note_path)));
        }
        Err(frontmatter::AtomicCreateError::Other(error)) => return Err(error),
    }
    let (main_note, mut path_changes) = match ensure_bundle_path(&note_path) {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&note_path);
            return Err(error);
        }
    };
    let bundle_dir = main_note
        .parent()
        .ok_or_else(|| "Bundle note has no parent".to_string())?;
    let note_stem = file_stem(&main_note)?;
    let target = bundle_dir.join(format!("{note_stem}.canvas"));
    if let Err(error) = fs::rename(canvas_path, &target) {
        if let Err(rollback_error) = rollback_bundle_promotion(&note_path, &main_note) {
            return Err(format!(
                "Could not attach canvas: {error}; bundle rollback failed: {rollback_error}"
            ));
        }
        if let Err(cleanup_error) = fs::remove_file(&note_path) {
            return Err(format!(
                "Could not attach canvas: {error}; temporary note cleanup failed: {cleanup_error}"
            ));
        }
        return Err(error.to_string());
    }

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

pub(crate) fn unlink_layer_impl(note_path: &Path, kind: &str) -> Result<FsMutationResult, String> {
    let layer_path = layer_file_path(note_path, kind)?;
    if !layer_path.exists() {
        return Err(format!(
            "Layer file not found: {}",
            path_string(&layer_path)
        ));
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

/// Move a layer to Amby's vault-local recycle bin. Layer data is often binary
/// (Canvas/Excalidraw), so relying on the OS recycle bin made recovery depend
/// on a separate, user-emptyable store and left no entry in the app history.
pub(crate) fn delete_layer_impl(
    vault: &Path,
    note_path: &Path,
    kind: &str,
) -> Result<FsMutationResult, String> {
    let layer_path = layer_file_path(note_path, kind)?;
    if !layer_path.exists() {
        return Err(format!(
            "Layer file not found: {}",
            path_string(&layer_path)
        ));
    }
    let mut result = crate::recycle_bin::move_to_trash(vault, &layer_path)?;
    result.primary_path = Some(path_string(note_path));
    Ok(result)
}
