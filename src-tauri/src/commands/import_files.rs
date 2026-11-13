//! Files and folders dropped from the system onto the tree are copied into a vault folder.
//!
//! The copy never replaces anything: a name that is taken gets ` 2`, ` 3`, ... before its
//! extension. The copies are not registered as the application's own writes, so the watcher
//! reports them like files that arrived from a file manager and the index picks them up.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::bundle::MAX_ATTACHMENT_FILE_SIZE;
use crate::frontmatter::{self, AtomicCreateError};
use crate::lock_util::LockExt;
use crate::paths;
use crate::vault_context::VaultContext;

/// One drop may bring a whole folder; this bounds the work of a single call.
const MAX_IMPORTED_FILES: usize = 5_000;
const MAX_FOLDER_DEPTH: usize = 32;
const MAX_NAME_TRIES: u32 = 1_000;

#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportFilesResult {
    /// Absolute paths of the copies that were made (a folder counts once, as its own path).
    pub imported: Vec<String>,
    pub skipped: Vec<ImportSkipped>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkipped {
    pub name: String,
    /// A machine code: `hidden`, `too_large`, `unreadable`, `link`, `into_itself`, `too_many`.
    pub reason: String,
}

#[tauri::command]
#[specta::specta]
pub fn import_files(
    context: tauri::State<'_, VaultContext>,
    target_dir: Option<String>,
    sources: Vec<String>,
) -> Result<ImportFilesResult, String> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let vault = context.root()?;
    let dir = match target_dir {
        Some(path) => paths::guard(&context, &path)?,
        None => vault.clone(),
    };
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", dir.display()));
    }
    // The tree never shows `.amby`, `.obsidian` and the like, so nothing may be dropped there.
    if is_hidden_inside(&vault, &dir) {
        return Err("The target folder is not part of the notes".to_string());
    }
    let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    Ok(import_into(&vault, &dir, &sources))
}

fn is_hidden_inside(vault: &Path, dir: &Path) -> bool {
    dir.strip_prefix(vault).is_ok_and(|rel| {
        rel.components()
            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    })
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn import_into(vault: &Path, dir: &Path, sources: &[PathBuf]) -> ImportFilesResult {
    let mut result = ImportFilesResult::default();
    let mut budget = MAX_IMPORTED_FILES;
    for source in sources {
        let name = name_of(source);
        if name.is_empty() || name.starts_with('.') {
            result.skipped.push(skipped(&name, "hidden"));
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(source) else {
            result.skipped.push(skipped(&name, "unreadable"));
            continue;
        };
        if meta.file_type().is_symlink() {
            result.skipped.push(skipped(&name, "link"));
        } else if meta.is_dir() {
            if dir.starts_with(source) {
                result.skipped.push(skipped(&name, "into_itself"));
                continue;
            }
            copy_folder(vault, source, dir, &name, 0, &mut budget, &mut result, true);
        } else if meta.is_file() {
            copy_file(
                vault,
                source,
                dir,
                &name,
                meta.len(),
                &mut budget,
                &mut result,
                true,
            );
        } else {
            result.skipped.push(skipped(&name, "unreadable"));
        }
    }
    result
}

fn skipped(name: &str, reason: &str) -> ImportSkipped {
    ImportSkipped {
        name: name.to_string(),
        reason: reason.to_string(),
    }
}

/// `name`, or `stem 2.ext`, `stem 3.ext`... for the first one that is free in `dir`.
pub(crate) fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    };
    for number in 2..MAX_NAME_TRIES {
        let candidate = dir.join(format!("{stem} {number}{ext}"));
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    dir.join(format!("{stem} {}{ext}", paths_unique_suffix()))
}

fn paths_unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn copy_file(
    vault: &Path,
    source: &Path,
    dir: &Path,
    name: &str,
    len: u64,
    budget: &mut usize,
    result: &mut ImportFilesResult,
    top_level: bool,
) {
    if *budget == 0 {
        result.skipped.push(skipped(name, "too_many"));
        return;
    }
    if len > MAX_ATTACHMENT_FILE_SIZE {
        result.skipped.push(skipped(name, "too_large"));
        return;
    }
    for _ in 0..8 {
        let dest = free_path(dir, name);
        let Ok(dest) = paths::confine(vault, &dest) else {
            result.skipped.push(skipped(name, "unreadable"));
            return;
        };
        match frontmatter::atomic_copy_file_new(source, &dest, MAX_ATTACHMENT_FILE_SIZE) {
            Ok(_) => {
                *budget -= 1;
                if top_level {
                    result.imported.push(dest.to_string_lossy().to_string());
                }
                return;
            }
            // Someone took the name between the check and the copy: pick the next one.
            Err(AtomicCreateError::AlreadyExists) => continue,
            Err(AtomicCreateError::Other(_)) => {
                result.skipped.push(skipped(name, "unreadable"));
                return;
            }
        }
    }
    result.skipped.push(skipped(name, "unreadable"));
}

#[allow(clippy::too_many_arguments)]
fn copy_folder(
    vault: &Path,
    source: &Path,
    dir: &Path,
    name: &str,
    depth: usize,
    budget: &mut usize,
    result: &mut ImportFilesResult,
    top_level: bool,
) {
    if depth > MAX_FOLDER_DEPTH {
        result.skipped.push(skipped(name, "too_many"));
        return;
    }
    let dest = free_path(dir, name);
    let Ok(dest) = paths::confine(vault, &dest) else {
        result.skipped.push(skipped(name, "unreadable"));
        return;
    };
    // `create_dir` (not `create_dir_all`) refuses a name that appeared meanwhile.
    if fs::create_dir(&dest).is_err() {
        result.skipped.push(skipped(name, "unreadable"));
        return;
    }
    if top_level {
        result.imported.push(dest.to_string_lossy().to_string());
    }
    let Ok(entries) = fs::read_dir(source) else {
        result.skipped.push(skipped(name, "unreadable"));
        return;
    };
    let mut children: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    children.sort();
    for child in children {
        let child_name = name_of(&child);
        if child_name.starts_with('.') {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&child) else {
            result.skipped.push(skipped(&child_name, "unreadable"));
            continue;
        };
        if meta.file_type().is_symlink() {
            result.skipped.push(skipped(&child_name, "link"));
        } else if meta.is_dir() {
            copy_folder(
                vault,
                &child,
                &dest,
                &child_name,
                depth + 1,
                budget,
                result,
                false,
            );
        } else if meta.is_file() {
            copy_file(
                vault,
                &child,
                &dest,
                &child_name,
                meta.len(),
                budget,
                result,
                false,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("amby-import-{label}-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    #[test]
    fn copies_a_file_and_keeps_the_original() {
        let vault = temp("vault");
        let outside = temp("outside");
        fs::write(outside.join("Light novels.md"), "a\nb\n").unwrap();
        let result = import_into(&vault, &vault, &[outside.join("Light novels.md")]);
        assert!(result.skipped.is_empty());
        assert_eq!(result.imported.len(), 1);
        assert_eq!(fs::read(vault.join("Light novels.md")).unwrap(), b"a\nb\n");
        assert!(outside.join("Light novels.md").exists());
    }

    #[test]
    fn never_replaces_a_name_that_is_taken() {
        let vault = temp("vault");
        let outside = temp("outside");
        fs::write(vault.join("note.md"), "mine").unwrap();
        fs::write(outside.join("note.md"), "theirs").unwrap();
        let first = import_into(&vault, &vault, &[outside.join("note.md")]);
        let second = import_into(&vault, &vault, &[outside.join("note.md")]);
        assert_eq!(fs::read_to_string(vault.join("note.md")).unwrap(), "mine");
        assert_eq!(
            fs::read_to_string(vault.join("note 2.md")).unwrap(),
            "theirs"
        );
        assert_eq!(
            fs::read_to_string(vault.join("note 3.md")).unwrap(),
            "theirs"
        );
        assert_eq!(first.imported.len() + second.imported.len(), 2);
    }

    #[test]
    fn copies_a_folder_with_its_content_and_skips_hidden_entries() {
        let vault = temp("vault");
        let outside = temp("outside");
        let folder = outside.join("Ideas");
        fs::create_dir_all(folder.join("sub")).unwrap();
        fs::create_dir_all(folder.join(".obsidian")).unwrap();
        fs::write(folder.join("a.md"), "a").unwrap();
        fs::write(folder.join("sub").join("b.md"), "b").unwrap();
        fs::write(folder.join(".obsidian").join("app.json"), "{}").unwrap();
        fs::write(folder.join(".hidden"), "x").unwrap();
        let result = import_into(&vault, &vault, std::slice::from_ref(&folder));
        assert_eq!(result.imported.len(), 1);
        assert!(vault.join("Ideas/a.md").is_file());
        assert!(vault.join("Ideas/sub/b.md").is_file());
        assert!(!vault.join("Ideas/.obsidian").exists());
        assert!(!vault.join("Ideas/.hidden").exists());
    }

    #[test]
    fn refuses_hidden_sources_and_a_folder_dropped_into_itself() {
        let vault = temp("vault");
        let outside = temp("outside");
        fs::write(outside.join(".secret"), "x").unwrap();
        let inner = outside.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let hidden = import_into(&vault, &vault, &[outside.join(".secret")]);
        assert_eq!(hidden.skipped[0].reason, "hidden");
        let itself = import_into(&vault, &inner, std::slice::from_ref(&outside));
        assert_eq!(itself.skipped[0].reason, "into_itself");
        assert!(!vault.join(".secret").exists());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_links() {
        let vault = temp("vault");
        let outside = temp("outside");
        fs::write(outside.join("real.md"), "x").unwrap();
        std::os::unix::fs::symlink(outside.join("real.md"), outside.join("link.md")).unwrap();
        let result = import_into(&vault, &vault, &[outside.join("link.md")]);
        assert_eq!(result.skipped[0].reason, "link");
        assert!(!vault.join("link.md").exists());
    }

    #[test]
    fn names_inside_hidden_folders_are_recognised() {
        let vault = Path::new("/v");
        assert!(is_hidden_inside(vault, Path::new("/v/.amby/trash")));
        assert!(is_hidden_inside(vault, Path::new("/v/a/.git")));
        assert!(!is_hidden_inside(vault, Path::new("/v/a/b")));
        assert!(!is_hidden_inside(vault, vault));
    }
}
