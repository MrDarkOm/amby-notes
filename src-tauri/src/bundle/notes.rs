use std::fs;
use std::path::{Path, PathBuf};

use crate::frontmatter;
use crate::model::{FsMutationResult, PathChange};

use super::path_ops::file_stem;
use super::path_string;
use super::scan::{is_bundle_main_note, is_markdown};

pub(crate) fn ensure_bundle_path(note_path: &Path) -> Result<(PathBuf, Vec<PathChange>), String> {
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
    if let Err(error) = fs::rename(note_path, &new_note) {
        let cleanup = fs::remove_dir(&bundle_dir);
        return Err(match cleanup {
            Ok(()) => error.to_string(),
            Err(cleanup_error) => format!(
                "Could not promote note: {error}; could not remove empty bundle directory: {cleanup_error}"
            ),
        });
    }

    Ok((
        new_note.clone(),
        vec![PathChange {
            old_path: path_string(note_path),
            new_path: path_string(&new_note),
        }],
    ))
}

pub(super) fn rollback_bundle_promotion(
    original_note: &Path,
    main_note: &Path,
) -> Result<(), String> {
    let bundle_dir = main_note
        .parent()
        .ok_or_else(|| "Bundle note has no parent".to_string())?;
    if original_note.exists() {
        return Err(format!(
            "Cannot restore note because the original path is occupied: {}",
            path_string(original_note)
        ));
    }
    let entries = fs::read_dir(bundle_dir)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if entries.len() != 1 || entries[0].path() != main_note {
        return Err(format!(
            "Cannot roll back a non-empty bundle: {}",
            path_string(bundle_dir)
        ));
    }
    fs::rename(main_note, original_note).map_err(|error| error.to_string())?;
    fs::remove_dir(bundle_dir).map_err(|error| error.to_string())
}

pub(crate) fn resolve_item_root(path: &Path) -> PathBuf {
    if is_bundle_main_note(path) {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    }
}

pub(crate) fn create_note_impl(parent_path: &Path, name: &str) -> Result<FsMutationResult, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Invalid note name".to_string());
    }

    let (prospective_container, should_promote) = if parent_path.is_file() {
        if !is_markdown(parent_path) {
            return Err(format!("Not a markdown note: {}", path_string(parent_path)));
        }
        if is_bundle_main_note(parent_path) {
            (
                parent_path
                    .parent()
                    .ok_or_else(|| {
                        format!("Bundle note has no parent: {}", path_string(parent_path))
                    })?
                    .to_path_buf(),
                false,
            )
        } else {
            let parent = parent_path
                .parent()
                .ok_or_else(|| format!("Note has no parent: {}", path_string(parent_path)))?;
            (parent.join(file_stem(parent_path)?), true)
        }
    } else {
        (parent_path.to_path_buf(), false)
    };

    if should_promote {
        if prospective_container.exists() {
            return Err(format!(
                "Bundle container already exists: {}",
                path_string(&prospective_container)
            ));
        }
    } else if !prospective_container.is_dir() {
        return Err(format!(
            "Not a directory: {}",
            path_string(&prospective_container)
        ));
    }

    let planned_note = prospective_container.join(format!("{trimmed}.md"));
    let sibling_bundle = prospective_container.join(trimmed);
    let planned_main = should_promote.then(|| {
        let parent_stem = file_stem(parent_path).unwrap_or_default();
        prospective_container.join(format!("{parent_stem}.md"))
    });
    if planned_main.as_ref() == Some(&planned_note) {
        return Err("A child note cannot have the same name as its parent note".to_string());
    }
    if planned_note.exists() || sibling_bundle.exists() {
        return Err(format!(
            "Note already exists: {}",
            path_string(&planned_note)
        ));
    }

    let (container, mut path_changes, promoted_main) = if should_promote {
        let (main_note, changes) = ensure_bundle_path(parent_path)?;
        let container = main_note
            .parent()
            .ok_or_else(|| format!("Bundle note has no parent: {}", path_string(&main_note)))?
            .to_path_buf();
        (container, changes, Some(main_note))
    } else {
        (prospective_container, Vec::new(), None)
    };
    let new_note = container.join(format!("{trimmed}.md"));
    if let Err(error) = frontmatter::atomic_write_new(&new_note, "") {
        let error = match error {
            frontmatter::AtomicCreateError::AlreadyExists => {
                format!("Note already exists: {}", path_string(&new_note))
            }
            frontmatter::AtomicCreateError::Other(error) => error,
        };
        if let Some(main_note) = promoted_main {
            if let Err(rollback_error) = rollback_bundle_promotion(parent_path, &main_note) {
                return Err(format!(
                    "Could not create child note: {error}; bundle rollback failed: {rollback_error}"
                ));
            }
        }
        return Err(error);
    }

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
