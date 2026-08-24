use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::frontmatter;
use crate::model::{FsMutationResult, ImportedAsset, LayerResult, PathChange};

static CASE_RENAME_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Tree node used only by the scan-helper tests below (the production tree is
/// built in vault_index). Test-only so it doesn't live in the shared model.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct TreeItem {
    id: String,
    path: String,
    name: String,
    item_type: String,
    icon: String,
    children: Option<Vec<TreeItem>>,
}

pub(crate) fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub(crate) fn file_stem(path: &Path) -> Result<String, String> {
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

/// True only when both spellings resolve to the same existing filesystem entry.
/// On case-sensitive filesystems differently cased names can be distinct user
/// files, so equality is determined by canonical paths (and Unix inode/device
/// identity as a fallback), never by case-folding strings alone.
fn same_filesystem_entry(source: &Path, target: &Path) -> Result<bool, String> {
    if source == target {
        return Ok(true);
    }
    let source_real = source.canonicalize().map_err(|error| error.to_string())?;
    let target_real = match target.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if source_real == target_real {
        return Ok(true);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let source_metadata = fs::metadata(source).map_err(|error| error.to_string())?;
        let target_metadata = fs::metadata(target).map_err(|error| error.to_string())?;
        Ok(source_metadata.dev() == target_metadata.dev()
            && source_metadata.ino() == target_metadata.ino())
    }

    #[cfg(not(unix))]
    Ok(false)
}

fn rename_temp_sibling(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path_string(source)))?;
    let name = source
        .file_name()
        .ok_or_else(|| format!("Path has no name: {}", path_string(source)))?
        .to_string_lossy();
    for _ in 0..128 {
        let counter = CASE_RENAME_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{name}.amby-case-rename-{}-{counter}",
            std::process::id()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not reserve a temporary rename path beside {}",
        path_string(source)
    ))
}

fn ensure_rename_target_available(source: &Path, target: &Path) -> Result<bool, String> {
    let same_entry = same_filesystem_entry(source, target)?;
    if target.exists() && !same_entry {
        return Err(format!("Target already exists: {}", path_string(target)));
    }
    Ok(same_entry)
}

/// Rename without overwriting a distinct target. Case-only renames go through
/// a unique sibling so macOS and Windows do not collapse the operation into a
/// no-op. A failed second rename restores the original spelling.
fn rename_path_case_safe(source: &Path, target: &Path) -> Result<(), String> {
    let same_entry = ensure_rename_target_available(source, target)?;
    if source == target {
        return Ok(());
    }
    if !same_entry {
        return fs::rename(source, target).map_err(|error| error.to_string());
    }

    let temporary = rename_temp_sibling(source)?;
    fs::rename(source, &temporary).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, target) {
        return match fs::rename(&temporary, source) {
            Ok(()) => Err(error.to_string()),
            Err(rollback_error) => Err(format!(
                "Case-only rename failed: {error}; rollback failed: {rollback_error}"
            )),
        };
    }
    Ok(())
}

fn is_markdown(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "md")
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

fn is_bundle_main_path(path: &Path) -> bool {
    if !is_markdown(path) {
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

fn is_bundle_main_note(path: &Path) -> bool {
    path.is_file() && is_bundle_main_path(path)
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

/// Every file whose vault-relative reference may need adjustment after moving
/// a folder or note bundle. Non-Markdown changes are ignored by the index but
/// are useful to the refactor planner (assets, Canvas and Excalidraw).
fn collect_refactor_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
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

fn rollback_bundle_promotion(original_note: &Path, main_note: &Path) -> Result<(), String> {
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

fn bundle_rename_path_changes(
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

/// Calculate the paths a rename will affect without touching the filesystem.
/// The index still describes these old paths, so callers can prepare all
/// reference rewrites before the actual rename begins.
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

/// Calculate a move before it is applied.  In particular, this predicts the
/// bundle conversion used when dropping onto a standalone note.
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

/// Undo a completed rename after a later transaction stage (for example link
/// refactoring) fails.  This never overwrites an existing user path.
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

pub const MAX_ATTACHMENT_FILE_SIZE: u64 = 100 * 1024 * 1024; // 100 MB
pub const MAX_PASTED_BYTES: usize = 25 * 1024 * 1024; // 25 MB
pub const MAX_EXT_LEN: usize = 16;
pub const MAX_STEM_LEN: usize = 128;

pub(crate) const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"];

pub(crate) fn sanitize_ext(ext: &str) -> String {
    let trimmed = ext.trim_start_matches('.').trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.len() > MAX_EXT_LEN {
        return "bin".to_string();
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
        return "bin".to_string();
    }
    trimmed
}

pub(crate) fn sanitize_stem(stem: &str) -> String {
    let mut safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if safe.len() > MAX_STEM_LEN {
        safe.truncate(MAX_STEM_LEN);
    }
    let trimmed = safe.trim_matches('-');
    if trimmed.is_empty() {
        "asset".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn sniff_image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.len() >= 3 && bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("jpg")
    } else if bytes.len() >= 6 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        Some("gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.len() >= 2 && bytes.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

pub(crate) fn classify_ext(ext: &str) -> &'static str {
    let ext = ext.to_ascii_lowercase();
    if IMAGE_EXTS.iter().any(|e| *e == ext) {
        "image"
    } else {
        "file"
    }
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(crate) fn assets_dir_for(vault: &Path, note: &Path) -> PathBuf {
    if is_bundle_main_note(note) {
        if let Some(parent) = note.parent() {
            return parent.join("assets");
        }
    }
    vault.join("assets")
}

pub(crate) fn unique_name(dir: &Path, stem: &str, ext: &str) -> String {
    let safe_stem = sanitize_stem(stem);
    let safe_ext = sanitize_ext(ext);
    let initial = if safe_ext.is_empty() || (safe_ext == "bin" && ext.is_empty()) {
        safe_stem.clone()
    } else {
        format!("{safe_stem}.{safe_ext}")
    };
    if !dir.join(&initial).exists() {
        return initial;
    }
    let suffix = now_millis();
    if safe_ext.is_empty() || (safe_ext == "bin" && ext.is_empty()) {
        format!("{safe_stem}-{suffix}")
    } else {
        format!("{safe_stem}-{suffix}.{safe_ext}")
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

pub(crate) fn build_imported_asset(
    vault: &Path,
    note: &Path,
    abs_path: PathBuf,
    file_name: String,
) -> ImportedAsset {
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
    fn failed_child_creation_does_not_promote_the_parent_note() {
        let vault = temp_vault("child-conflict");
        let parent = vault.join("Untitled.md");
        fs::write(&parent, "parent").unwrap();

        let error = create_note_impl(&parent, "Untitled").err().unwrap();

        assert!(error.contains("same name"));
        assert_eq!(fs::read_to_string(&parent).unwrap(), "parent");
        assert!(!vault.join("Untitled").exists());
    }

    #[test]
    fn standalone_note_cannot_duplicate_a_bundle_name() {
        let vault = temp_vault("bundle-name-conflict");
        fs::create_dir(vault.join("Parent")).unwrap();
        fs::write(vault.join("Parent/Parent.md"), "parent").unwrap();

        let error = create_note_impl(&vault, "Parent").err().unwrap();

        assert!(error.contains("already exists"));
        assert!(!vault.join("Parent.md").exists());
    }

    #[test]
    fn invalid_layer_does_not_promote_a_note() {
        let vault = temp_vault("invalid-layer");
        let note = vault.join("Note.md");
        fs::write(&note, "note").unwrap();

        let error = create_layer_impl(&note, "unknown").err().unwrap();

        assert!(error.contains("Unknown layer kind"));
        assert!(note.exists());
        assert!(!vault.join("Note").exists());
    }

    #[test]
    fn deleting_a_layer_keeps_a_vault_local_recoverable_copy() {
        let vault = temp_vault("delete-layer");
        let bundle = vault.join("Note");
        fs::create_dir(&bundle).unwrap();
        let note = bundle.join("Note.md");
        let layer = bundle.join("Note.canvas");
        fs::write(&note, "note").unwrap();
        fs::write(&layer, "canvas data").unwrap();

        delete_layer_impl(&vault, &note, "canvas").unwrap();

        assert!(!layer.exists());
        let entry = crate::recycle_bin::list(&vault).pop().unwrap();
        crate::recycle_bin::restore(&vault, &entry.id).unwrap();
        assert_eq!(fs::read_to_string(&layer).unwrap(), "canvas data");
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
    fn failed_move_restores_a_promoted_target_note() {
        let vault = temp_vault("failed-move");
        let missing_source = vault.join("Missing.md");
        let target = vault.join("Target.md");
        fs::write(&target, "target").unwrap();

        let error = move_item_impl(&missing_source, &target).err().unwrap();

        assert!(error.contains("Source not found"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "target");
        assert!(!vault.join("Target").exists());
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
        assert!(result.path_changes.iter().any(|change| change.old_path
            == path_string(&vault.join("Old/Old.canvas"))
            && change.new_path == path_string(&vault.join("New/New.canvas"))));
        assert!(result.path_changes.iter().any(|change| change.old_path
            == path_string(&vault.join("Old/Old.excalidraw"))
            && change.new_path == path_string(&vault.join("New/New.excalidraw"))));
    }

    #[test]
    fn rename_rejects_distinct_file_and_folder_collisions() {
        let vault = temp_vault("rename-collisions");
        let first_file = vault.join("First.md");
        let second_file = vault.join("Second.md");
        fs::write(&first_file, "first").unwrap();
        fs::write(&second_file, "second").unwrap();
        let first_folder = vault.join("First");
        let second_folder = vault.join("Second");
        fs::create_dir(&first_folder).unwrap();
        fs::create_dir(&second_folder).unwrap();

        assert!(rename_item_impl(&first_file, "Second").is_err());
        assert!(rename_item_impl(&first_folder, "Second").is_err());
        assert_eq!(fs::read_to_string(&first_file).unwrap(), "first");
        assert_eq!(fs::read_to_string(&second_file).unwrap(), "second");
        assert!(first_folder.is_dir());
        assert!(second_folder.is_dir());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn case_only_file_and_folder_renames_use_a_temporary_sibling() {
        let vault = temp_vault("case-only-items");
        let file = vault.join("Note.md");
        let folder = vault.join("Folder");
        fs::write(&file, "note").unwrap();
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("Child.md"), "child").unwrap();

        rename_item_impl(&file, "note").unwrap();
        rename_item_impl(&folder, "folder").unwrap();

        assert_eq!(fs::read_to_string(vault.join("note.md")).unwrap(), "note");
        assert_eq!(
            fs::read_to_string(vault.join("folder/Child.md")).unwrap(),
            "child"
        );
        let names = fs::read_dir(&vault)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(names.contains(&"note.md".to_string()));
        assert!(names.contains(&"folder".to_string()));
        assert!(!names.contains(&"Note.md".to_string()));
        assert!(!names.contains(&"Folder".to_string()));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn case_only_bundle_rename_keeps_main_and_sidecars_consistent() {
        let vault = temp_vault("case-only-bundle");
        fs::create_dir(vault.join("Note")).unwrap();
        fs::write(vault.join("Note/Note.md"), "main").unwrap();
        fs::write(vault.join("Note/Note.canvas"), "canvas").unwrap();
        fs::write(vault.join("Note/Note.excalidraw"), "excalidraw").unwrap();

        let result = rename_item_impl(&vault.join("Note/Note.md"), "note").unwrap();

        assert_eq!(
            result.primary_path,
            Some(path_string(&vault.join("note/note.md")))
        );
        assert_eq!(
            fs::read_to_string(vault.join("note/note.md")).unwrap(),
            "main"
        );
        assert_eq!(
            fs::read_to_string(vault.join("note/note.canvas")).unwrap(),
            "canvas"
        );
        assert_eq!(
            fs::read_to_string(vault.join("note/note.excalidraw")).unwrap(),
            "excalidraw"
        );
    }

    #[test]
    fn bundle_rename_conflict_is_rejected_before_any_file_moves() {
        let vault = temp_vault("rename-conflict");
        fs::create_dir(vault.join("Old")).unwrap();
        fs::write(vault.join("Old/Old.md"), "main").unwrap();
        fs::write(vault.join("Old/New.md"), "child").unwrap();

        let error = rename_item_impl(&vault.join("Old/Old.md"), "New")
            .err()
            .unwrap();

        assert!(error.contains("Target already exists"));
        assert_eq!(
            fs::read_to_string(vault.join("Old/Old.md")).unwrap(),
            "main"
        );
        assert_eq!(
            fs::read_to_string(vault.join("Old/New.md")).unwrap(),
            "child"
        );
        assert!(!vault.join("New").exists());
    }

    #[test]
    fn rollback_bundle_rename_restores_every_bundle_file() {
        let vault = temp_vault("rollback-rename");
        fs::create_dir(vault.join("Old")).unwrap();
        fs::write(vault.join("Old/Old.md"), "main").unwrap();
        fs::write(vault.join("Old/Old.canvas"), "canvas").unwrap();
        fs::write(vault.join("Old/Child.md"), "child").unwrap();
        let original = vault.join("Old/Old.md");

        let result = rename_item_impl(&original, "New").unwrap();
        rollback_rename_item(&original, &result).unwrap();

        assert_eq!(
            fs::read_to_string(vault.join("Old/Old.md")).unwrap(),
            "main"
        );
        assert_eq!(
            fs::read_to_string(vault.join("Old/Old.canvas")).unwrap(),
            "canvas"
        );
        assert_eq!(
            fs::read_to_string(vault.join("Old/Child.md")).unwrap(),
            "child"
        );
        assert!(!vault.join("New").exists());
    }

    #[test]
    fn rollback_move_restores_standalone_target_from_temporary_bundle() {
        let vault = temp_vault("rollback-move");
        let source = vault.join("A.md");
        let target = vault.join("B.md");
        fs::write(&source, "source").unwrap();
        fs::write(&target, "target").unwrap();

        let result = move_item_impl(&source, &target).unwrap();
        rollback_move_item(&source, &target, &result).unwrap();

        assert_eq!(fs::read_to_string(&source).unwrap(), "source");
        assert_eq!(fs::read_to_string(&target).unwrap(), "target");
        assert!(!vault.join("B").exists());
    }

    #[test]
    fn rollback_move_restores_an_entire_super_note() {
        let vault = temp_vault("rollback-super-note-move");
        let bundle = vault.join("A");
        let target = vault.join("Target");
        fs::create_dir(&bundle).unwrap();
        fs::create_dir(&target).unwrap();
        let main = bundle.join("A.md");
        fs::write(&main, "main").unwrap();
        fs::write(bundle.join("A.canvas"), "canvas").unwrap();
        fs::write(bundle.join("Child.md"), "child").unwrap();

        let result = move_item_impl(&main, &target).unwrap();
        rollback_move_item(&main, &target, &result).unwrap();

        assert_eq!(fs::read_to_string(&main).unwrap(), "main");
        assert_eq!(
            fs::read_to_string(bundle.join("A.canvas")).unwrap(),
            "canvas"
        );
        assert_eq!(
            fs::read_to_string(bundle.join("Child.md")).unwrap(),
            "child"
        );
        assert!(!target.join("A").exists());
    }

    #[test]
    fn rollback_super_note_move_restores_a_promoted_target_note() {
        let vault = temp_vault("rollback-super-note-to-note");
        let bundle = vault.join("A");
        fs::create_dir(&bundle).unwrap();
        let main = bundle.join("A.md");
        let target = vault.join("B.md");
        fs::write(&main, "main").unwrap();
        fs::write(bundle.join("A.canvas"), "canvas").unwrap();
        fs::write(&target, "target").unwrap();

        let result = move_item_impl(&main, &target).unwrap();
        rollback_move_item(&main, &target, &result).unwrap();

        assert_eq!(fs::read_to_string(&main).unwrap(), "main");
        assert_eq!(
            fs::read_to_string(bundle.join("A.canvas")).unwrap(),
            "canvas"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "target");
        assert!(!vault.join("B").exists());
    }

    #[test]
    fn preview_move_matches_bundle_conversion_paths() {
        let vault = temp_vault("move-preview");
        let source = vault.join("A.md");
        let target = vault.join("B.md");
        fs::write(&source, "source").unwrap();
        fs::write(&target, "target").unwrap();

        let preview = preview_move_item(&source, &target).unwrap();

        assert!(preview
            .path_changes
            .iter()
            .any(|change| change.old_path == path_string(&source)
                && change.new_path == path_string(&vault.join("B/A.md"))));
        assert!(preview
            .path_changes
            .iter()
            .any(|change| change.old_path == path_string(&target)
                && change.new_path == path_string(&vault.join("B/B.md"))));
        assert!(source.exists());
        assert!(target.exists());
    }

    #[test]
    fn test_sanitize_ext() {
        assert_eq!(sanitize_ext(".PNG"), "png");
        assert_eq!(sanitize_ext("jpeg"), "jpeg");
        assert_eq!(sanitize_ext("../evil"), "bin");
        assert_eq!(sanitize_ext("..\\evil"), "bin");
        assert_eq!(sanitize_ext("/bin/sh"), "bin");
        assert_eq!(sanitize_ext("verylongextensionexceedinglimit"), "bin");
        assert_eq!(sanitize_ext(""), "bin");
        assert_eq!(sanitize_ext("tar.gz"), "bin");
    }

    #[test]
    fn test_sanitize_stem() {
        assert_eq!(sanitize_stem("My Note Asset"), "My-Note-Asset");
        assert_eq!(sanitize_stem("../../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_stem("   ---   "), "asset");
        assert_eq!(sanitize_stem(""), "asset");
    }

    #[test]
    fn test_svg_is_classified_as_file_attachment() {
        assert_eq!(classify_ext("svg"), "file");
        assert_eq!(classify_ext("png"), "image");
        assert_eq!(classify_ext("jpg"), "image");
        assert_eq!(classify_ext("pdf"), "file");
    }

    #[test]
    fn test_sniff_image_format() {
        assert_eq!(
            sniff_image_format(b"\x89PNG\r\n\x1a\nExtraPayload"),
            Some("png")
        );
        assert_eq!(sniff_image_format(b"\xFF\xD8\xFF\xE0..."), Some("jpg"));
        assert_eq!(sniff_image_format(b"GIF89a..."), Some("gif"));
        assert_eq!(
            sniff_image_format(b"RIFF\x00\x00\x00\x00WEBPVP8..."),
            Some("webp")
        );
        assert_eq!(sniff_image_format(b"BM\x00\x00\x00\x00"), Some("bmp"));
        assert_eq!(sniff_image_format(b"<svg xmlns=..."), None);
        assert_eq!(sniff_image_format(b"plain text"), None);
    }
}
