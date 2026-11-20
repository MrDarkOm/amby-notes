use std::fs;
use std::path::{Path, PathBuf};

use crate::frontmatter;
use crate::model::{FsMutationResult, PathChange};

use super::path_ops::file_stem;
use super::path_string;
use super::scan::{is_bundle_main_note, is_supported_document};

/// The move `ensure_bundle_path` would make, without making it: `Name.md` into `Name/Name.md`.
/// Empty when the note already is a bundle's main note or is not a plain document. Synchronisation
/// is told about it before the file moves (Д70а), so a super note is a move and not a deletion.
pub fn preview_ensure_bundle_path(note_path: &Path) -> Vec<PathChange> {
    if !note_path.is_file() || !is_supported_document(note_path) || is_bundle_main_note(note_path) {
        return Vec::new();
    }
    let (Ok(stem), Some(parent)) = (file_stem(note_path), note_path.parent()) else {
        return Vec::new();
    };
    let ext = note_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("md");
    let new_note = parent.join(&stem).join(format!("{stem}.{ext}"));
    vec![PathChange {
        old_path: path_string(note_path),
        new_path: path_string(&new_note),
    }]
}

pub fn ensure_bundle_path(note_path: &Path) -> Result<(PathBuf, Vec<PathChange>), String> {
    if note_path.is_dir() {
        if let Some(manifest) = crate::database::discovery::find_manifest_path(note_path) {
            return Ok((manifest, Vec::new()));
        }
    }
    if !note_path.is_file() || !is_supported_document(note_path) {
        return Err(format!(
            "Not a supported document: {}",
            path_string(note_path)
        ));
    }
    if is_bundle_main_note(note_path) {
        return Ok((note_path.to_path_buf(), Vec::new()));
    }

    let stem = file_stem(note_path)?;
    let ext = note_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("md");
    let parent = note_path
        .parent()
        .ok_or_else(|| format!("Document has no parent: {}", path_string(note_path)))?;
    let bundle_dir = parent.join(&stem);
    let new_note = bundle_dir.join(format!("{stem}.{ext}"));

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

pub(crate) fn rollback_bundle_promotion(
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

/// The item a delete, archive or move acts on: the bundle folder for a bundle's main note, the path
/// itself otherwise. Never the vault root (CORE-01).
pub fn resolve_item_root(vault: &Path, path: &Path) -> PathBuf {
    if super::scan::is_bundle_main_note_in(vault, path) {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    }
}

pub struct CreateNotePlan {
    parent_path: PathBuf,
    prospective_container: PathBuf,
    should_promote: bool,
    planned_note: PathBuf,
    initial_source: String,
}

impl CreateNotePlan {
    pub fn planned_note(&self) -> &Path {
        &self.planned_note
    }

    pub fn initial_source(&self) -> &str {
        &self.initial_source
    }

    /// The same plan with `body` (Markdown without an `amby-id`, as a rendered template) as the
    /// new note's text, under a fresh ID.
    pub fn with_body(self, body: &str) -> Result<Self, String> {
        let note_id = ulid::Ulid::generate().to_string();
        Ok(Self {
            initial_source: frontmatter::body_with_id(body, &note_id)?,
            ..self
        })
    }

    pub fn promotion_paths(&self) -> Option<(&Path, &Path, PathBuf)> {
        self.should_promote.then(|| {
            let parent_stem = file_stem(&self.parent_path).unwrap_or_default();
            let ext = self
                .parent_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("md");
            (
                self.parent_path.as_path(),
                self.prospective_container.as_path(),
                self.prospective_container
                    .join(format!("{parent_stem}.{ext}")),
            )
        })
    }

    pub fn commit(self) -> Result<FsMutationResult, String> {
        let Self {
            parent_path,
            prospective_container,
            should_promote,
            planned_note,
            initial_source,
        } = self;

        let (container, mut path_changes, promoted_main) = if should_promote {
            let (main_note, changes) = ensure_bundle_path(&parent_path)?;
            let container = main_note
                .parent()
                .ok_or_else(|| format!("Bundle note has no parent: {}", path_string(&main_note)))?
                .to_path_buf();
            (container, changes, Some(main_note))
        } else {
            (prospective_container, Vec::new(), None)
        };
        let new_note = container.join(
            planned_note
                .file_name()
                .ok_or_else(|| format!("Invalid note path: {}", path_string(&planned_note)))?,
        );
        if let Err(error) = frontmatter::atomic_write_new(&new_note, &initial_source) {
            let error = match error {
                frontmatter::AtomicCreateError::AlreadyExists => {
                    format!("Note already exists: {}", path_string(&new_note))
                }
                frontmatter::AtomicCreateError::Other(error) => error,
            };
            if let Some(main_note) = promoted_main {
                if let Err(rollback_error) = rollback_bundle_promotion(&parent_path, &main_note) {
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
            tree_patch: None,
            also_touched: Vec::new(),
            primary_id: None,
            primary_path: Some(path_string(&new_note)),
            path_changes,
            deleted_paths: Vec::new(),
            deleted_ids: Vec::new(),
        })
    }
}

pub fn prepare_create_note_impl(parent_path: &Path, name: &str) -> Result<CreateNotePlan, String> {
    let trimmed = super::path_ops::validate_item_name("note", name)?;

    let (prospective_container, should_promote) = if parent_path.is_file() {
        if !is_supported_document(parent_path) {
            return Err(format!(
                "Not a supported document: {}",
                path_string(parent_path)
            ));
        }
        if is_bundle_main_note(parent_path) {
            (
                parent_path
                    .parent()
                    .ok_or_else(|| {
                        format!(
                            "Bundle document has no parent: {}",
                            path_string(parent_path)
                        )
                    })?
                    .to_path_buf(),
                false,
            )
        } else {
            let parent = parent_path
                .parent()
                .ok_or_else(|| format!("Document has no parent: {}", path_string(parent_path)))?;
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
        let ext = parent_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("md");
        prospective_container.join(format!("{parent_stem}.{ext}"))
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

    let note_id = ulid::Ulid::generate().to_string();
    let initial_source = frontmatter::body_with_id("", &note_id)?;
    Ok(CreateNotePlan {
        parent_path: parent_path.to_path_buf(),
        prospective_container,
        should_promote,
        planned_note,
        initial_source,
    })
}

#[cfg(any(test, feature = "test-support"))]
pub fn create_note_impl(parent_path: &Path, name: &str) -> Result<FsMutationResult, String> {
    prepare_create_note_impl(parent_path, name)?.commit()
}
