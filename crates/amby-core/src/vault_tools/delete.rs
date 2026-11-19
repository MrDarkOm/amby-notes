//! Deletion for the CLI and MCP: the item goes to the operating system's trash, where the
//! user can restore it. Permanent deletion is not offered to these clients.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::{allowed, relative, Published};
use crate::recycle_bin::preview_move_to_trash;
use crate::self_write::{PathFingerprint, SelfWriteTracker};
use crate::system_recycle_bin::SystemTrash;

/// A visible file or folder at a vault-relative path; never the vault itself or a service path.
fn visible_item(root: &Path, path: &str) -> Result<PathBuf, &'static str> {
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    if path.is_empty() || path == "." {
        return Err("accessDenied");
    }
    match crate::ai_tools::safe_folder(root, path) {
        Ok(folder) => Ok(folder),
        Err("notFound") => crate::ai_tools::resolve_note_path(root, path),
        Err(error) => Err(error),
    }
}

/// What a deletion would remove: the item and the notes inside it, vault-relative.
fn plan(
    root: &Path,
    scope: &Path,
    path: &str,
) -> Result<(PathBuf, Vec<PathBuf>, Vec<String>), &'static str> {
    let item = visible_item(root, path)?;
    let preview = preview_move_to_trash(root, &item).map_err(|_| "accessDenied")?;
    // A note of a bundle takes the whole bundle; the grant must hold what really goes.
    allowed(scope, &preview.original_path)?;
    if preview.original_path == scope {
        return Err("outsideWriteScope");
    }
    let mut affected = vec![relative(root, &preview.original_path)?];
    for path in &preview.deleted_paths {
        affected.push(relative(root, path)?);
    }
    affected.sort_unstable();
    affected.dedup();
    Ok((preview.original_path, preview.deleted_paths, affected))
}

pub fn preview(root: &Path, scope: &Path, path: &str) -> Result<serde_json::Value, &'static str> {
    let (item, _, affected) = plan(root, scope, path)?;
    Ok(
        json!({ "path": relative(root, &item)?, "affectedPaths": affected, "destination": "systemTrash" }),
    )
}

pub fn execute(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    trash: &dyn SystemTrash,
    path: &str,
) -> Result<Published, &'static str> {
    let (item, notes, affected) = plan(root, scope, path)?;
    let mut writes = vec![(item.clone(), PathFingerprint::Missing)];
    writes.extend(
        notes
            .iter()
            .cloned()
            .map(|path| (path, PathFingerprint::Missing)),
    );
    let prepared = watcher.prepare_write(writes);
    if trash.trash(&item).is_err() {
        watcher.cancel_prepared_write(&prepared);
        return Err("trashUnavailable");
    }
    watcher.confirm_prepared_write(&prepared);
    let mut changed = vec![item.clone()];
    changed.extend(notes);
    Ok(Published {
        output: json!({ "path": relative(root, &item)?, "affectedPaths": affected, "destination": "systemTrash" }),
        changed,
        archive_changed: false,
        properties_changed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    /// A trash that moves items into a folder of the test, so no test touches the real one.
    struct FolderTrash {
        folder: PathBuf,
        taken: Mutex<Vec<PathBuf>>,
    }

    impl SystemTrash for FolderTrash {
        fn trash(&self, path: &Path) -> Result<(), String> {
            let name = path.file_name().ok_or("no name")?;
            fs::rename(path, self.folder.join(name)).map_err(|error| error.to_string())?;
            self.taken
                .lock()
                .map_err(|_| "poisoned")?
                .push(path.to_owned());
            Ok(())
        }
    }

    struct RefusingTrash;

    impl SystemTrash for RefusingTrash {
        fn trash(&self, _path: &Path) -> Result<(), String> {
            Err("no trash".into())
        }
    }

    struct Dir(PathBuf);

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn vault() -> (Dir, PathBuf, PathBuf) {
        let dir = Dir(std::env::temp_dir().join(format!("amby-delete-{}", ulid::Ulid::generate())));
        let root = dir.0.join("vault");
        let bin = dir.0.join("bin");
        fs::create_dir_all(root.join("Projects/Sub")).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::write(root.join("Projects/A.md"), "a").unwrap();
        fs::write(root.join("Projects/Sub/B.md"), "b").unwrap();
        fs::write(root.join("Other.md"), "o").unwrap();
        let root = root.canonicalize().unwrap();
        (dir, root, bin)
    }

    /// D2: a deletion moves the item and its notes to the system trash and reports them.
    #[test]
    fn d2_deletes_into_the_system_trash() {
        let (_dir, root, bin) = vault();
        let trash = FolderTrash {
            folder: bin.clone(),
            taken: Mutex::new(Vec::new()),
        };
        let watcher = SelfWriteTracker::default();
        let published = execute(&root, &root, &watcher, &trash, "Projects").unwrap();
        assert_eq!(
            published.output["affectedPaths"],
            json!(["Projects", "Projects/A.md", "Projects/Sub/B.md"])
        );
        assert!(!root.join("Projects").exists());
        assert!(bin.join("Projects/Sub/B.md").exists());
        assert!(root.join("Other.md").exists());
        assert_eq!(trash.taken.lock().unwrap().len(), 1);
    }

    /// D3: a refused trash leaves everything in place; nothing is ever destroyed instead.
    #[test]
    fn d3_refused_trash_keeps_the_item() {
        let (_dir, root, _bin) = vault();
        let watcher = SelfWriteTracker::default();
        let result = execute(&root, &root, &watcher, &RefusingTrash, "Projects/A.md");
        assert_eq!(result.err(), Some("trashUnavailable"));
        assert_eq!(fs::read_to_string(root.join("Projects/A.md")).unwrap(), "a");
    }

    /// D4: the grant, the vault root and service paths confine deletion.
    #[test]
    fn d4_scope_and_service_paths() {
        let (_dir, root, bin) = vault();
        fs::create_dir_all(root.join(".amby")).unwrap();
        let trash = FolderTrash {
            folder: bin,
            taken: Mutex::new(Vec::new()),
        };
        let watcher = SelfWriteTracker::default();
        let scope = root.join("Projects");
        for (path, expected) in [
            ("Other.md", "outsideWriteScope"),
            ("Projects", "outsideWriteScope"),
            (".amby", "accessDenied"),
            (".", "accessDenied"),
            ("../x", "accessDenied"),
            ("Missing.md", "notFound"),
        ] {
            let result = execute(&root, &scope, &watcher, &trash, path);
            assert_eq!(result.err(), Some(expected), "{path}");
        }
        assert!(trash.taken.lock().unwrap().is_empty());
    }
}
