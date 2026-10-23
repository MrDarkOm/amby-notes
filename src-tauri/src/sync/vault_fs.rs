//! The local file system of the engine (docs/sync-plan.md, Р4, Р8, Р10; port
//! [`amby_sync_core::engine::LocalFs`]) over the vault on disk and the services of the
//! application. Rules this port keeps:
//!
//! - a write is atomic: a temporary file `.<name>.amby-tmp-*` next to the target, published by a
//!   rename; when a file is replaced, a history snapshot with the reason `sync-overwrite` is made
//!   first, **even when the history is switched off** (Р8), and a failed snapshot fails the write;
//! - a file removed on behalf of the server goes to `.amby/trash/` whatever the delete mode (Р8);
//! - a rename never overwrites (Р12, Д17);
//! - the writes of the engine are **not** registered as writes of the application: the watcher
//!   reports them like any change made by another program, so an open editor treats them as an
//!   external edit and a note with unsaved changes gets the usual conflict dialog (Р7).

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use amby_sync_core::engine::{
    FsError, Listing, LocalEntry, LocalFs, LocalKind, NameRules, RootState, SnapshotReason,
    StagedWrite, TrashReason,
};

use crate::{frontmatter, history, recycle_bin};

/// What the application does around a batch of incoming changes (Р8): merge the events of the
/// watcher and update the index once.
pub trait FsHooks: Send + Sync {
    /// A batch of incoming changes begins.
    fn batch_begin(&self) {}
    /// It ended (also after an error).
    fn batch_end(&self) {}
}

/// The vault as the engine sees it.
pub struct VaultFs {
    root: PathBuf,
    hooks: Option<Arc<dyn FsHooks>>,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Folders of `.amby/` whose files are synchronised (Р4); the rest of `.amby/` is listed by name
/// only.
const AMBY_SYNCED_FOLDERS: [&str; 2] = ["blocks", "property-backups"];

impl VaultFs {
    /// The vault at `root`, with no hooks.
    pub fn new(root: PathBuf) -> Self {
        Self { root, hooks: None }
    }

    /// The vault at `root`; `hooks` are told about batches.
    pub fn with_hooks(root: PathBuf, hooks: Arc<dyn FsHooks>) -> Self {
        Self {
            root,
            hooks: Some(hooks),
        }
    }

    /// The folder of the vault.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The path on disk of `rel` (relative, `/` separators). Nothing but plain names is accepted,
    /// and no folder on the way may be a link: a path the server named must never lead out of the
    /// vault (Р4, Р12).
    fn resolve(&self, rel: &str) -> Result<PathBuf, FsError> {
        if rel.is_empty() {
            return Err(FsError::Io("an empty path".into()));
        }
        let mut path = self.root.clone();
        let parts: Vec<&str> = rel.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            let plain = !part.is_empty()
                && matches!(
                    Path::new(part).components().collect::<Vec<_>>().as_slice(),
                    [Component::Normal(_)]
                )
                && !part.contains('\\');
            if !plain {
                return Err(FsError::Io(format!("an unsafe path: {rel}")));
            }
            path.push(part);
            if index + 1 < parts.len() {
                match fs::symlink_metadata(&path) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(FsError::Io(format!("a link on the way to {rel}")));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(map_io(rel, &error)),
                }
            }
        }
        Ok(path)
    }
}

/// How a failure of the system reads for the engine.
fn map_io(path: &str, error: &std::io::Error) -> FsError {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => FsError::NotFound(path.to_string()),
        ErrorKind::AlreadyExists => FsError::AlreadyExists(path.to_string()),
        ErrorKind::PermissionDenied => FsError::AccessDenied(path.to_string()),
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => FsError::NoSpace,
        _ => FsError::Io(format!("{path}: {error}")),
    }
}

fn mtime_ns(metadata: &fs::Metadata) -> i64 {
    match metadata.modified() {
        Ok(time) => match time.duration_since(UNIX_EPOCH) {
            Ok(after) => i64::try_from(after.as_nanos()).unwrap_or(i64::MAX),
            Err(before) => -i64::try_from(before.duration().as_nanos()).unwrap_or(i64::MAX),
        },
        Err(_) => 0,
    }
}

/// Is a folder named `name` at `rel_parent` (relative, `""` for the root) not entered by the
/// listing? Its entry is listed, its content is not: nothing in it is ever synchronised (Р4).
fn is_not_entered(rel_parent: &str, name: &str) -> bool {
    if name == ".git" {
        return true;
    }
    match (rel_parent, name) {
        ("", ".obsidian" | ".trash") => true,
        (".amby", folder) => !AMBY_SYNCED_FOLDERS.contains(&folder),
        _ => false,
    }
}

fn walk(dir: &Path, rel_parent: &str, listing: &mut Listing) -> Result<(), FsError> {
    let shown = if rel_parent.is_empty() {
        "."
    } else {
        rel_parent
    };
    let entries = fs::read_dir(dir).map_err(|error| map_io(shown, &error))?;
    for entry in entries {
        let entry = entry.map_err(|error| map_io(shown, &error))?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            let lossy = file_name.to_string_lossy();
            listing.not_utf8.push(if rel_parent.is_empty() {
                lossy.into_owned()
            } else {
                format!("{rel_parent}/{lossy}")
            });
            continue;
        };
        let rel = if rel_parent.is_empty() {
            name.to_string()
        } else {
            format!("{rel_parent}/{name}")
        };
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            // Gone between the listing and the look: not there.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(map_io(&rel, &error)),
        };
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            listing.entries.push(LocalEntry {
                path: rel,
                kind: LocalKind::Symlink,
                size: 0,
                mtime_ns: 0,
            });
        } else if file_type.is_dir() {
            listing.entries.push(LocalEntry {
                path: rel.clone(),
                kind: LocalKind::Folder,
                size: 0,
                mtime_ns: 0,
            });
            if !is_not_entered(rel_parent, name) {
                walk(&entry.path(), &rel, listing)?;
            }
        } else if file_type.is_file() {
            listing.entries.push(LocalEntry {
                path: rel,
                kind: LocalKind::File,
                size: metadata.len(),
                mtime_ns: mtime_ns(&metadata),
            });
        }
        // Sockets, pipes and devices are not files of a vault.
    }
    Ok(())
}

/// The folders whose files are journals of multi-file operations, relative to `.amby/`.
const JOURNAL_FOLDERS: [&str; 6] = [
    "recovery/database_relations",
    "recovery/database_relation_schemas",
    "recovery/database_batches",
    "recovery/creative",
    "recovery/projects",
    "migrations",
];

/// Is there an unfinished journal of a multi-file operation in `.amby/` (Р8, Д59)? A journal is
/// unfinished when its `status` is `planned` or `inProgress`, or when it cannot be read: a
/// half-done operation must never leave the computer (the folders `recovery/database_relations`,
/// `database_relation_schemas`, `database_batches`, `creative`, `projects` and `migrations`; the
/// drafts of the editors in `recovery/` are not journals; `quarantine/` is ignored).
pub fn pending_journals(vault: &Path) -> bool {
    JOURNAL_FOLDERS.iter().any(|folder| {
        let dir = vault.join(".amby").join(folder);
        let Ok(entries) = fs::read_dir(&dir) else {
            return false;
        };
        entries.flatten().any(|entry| {
            let path = entry.path();
            let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
            if !is_file || path.extension().is_none_or(|extension| extension != "json") {
                return false;
            }
            match fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            {
                Some(journal) => matches!(
                    journal.get("status").and_then(|status| status.as_str()),
                    Some("planned" | "inProgress")
                ),
                None => true,
            }
        })
    })
}

/// A file being written next to its target (С3, Ф24).
struct VaultStaged {
    vault: PathBuf,
    target: PathBuf,
    rel: String,
    temp: PathBuf,
    file: Option<fs::File>,
}

impl VaultStaged {
    fn remove_temp(&mut self) {
        self.file = None;
        let _ = fs::remove_file(&self.temp);
    }
}

impl StagedWrite for VaultStaged {
    fn write(&mut self, bytes: &[u8]) -> Result<(), FsError> {
        let Some(file) = self.file.as_mut() else {
            return Err(FsError::Io("the write is over".into()));
        };
        file.write_all(bytes)
            .map_err(|error| map_io(&self.rel, &error))
    }

    fn publish(mut self: Box<Self>, snapshot: Option<SnapshotReason>) -> Result<(), FsError> {
        let result = self.publish_inner(snapshot);
        if result.is_err() {
            self.remove_temp();
        }
        result
    }

    fn abort(mut self: Box<Self>) {
        self.remove_temp();
    }
}

impl VaultStaged {
    fn publish_inner(&mut self, snapshot: Option<SnapshotReason>) -> Result<(), FsError> {
        let rel = self.rel.clone();
        let io = |error: std::io::Error| map_io(&rel, &error);
        let mut file = self
            .file
            .take()
            .ok_or_else(|| FsError::Io("the write is over".into()))?;
        file.flush().map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        let existing = match fs::symlink_metadata(&self.target) {
            Ok(metadata) if metadata.is_dir() => {
                return Err(FsError::Io(format!("{rel} is a folder")));
            }
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(map_io(&rel, &error)),
        };
        if existing && snapshot.is_some() {
            // The old content is the only copy of what this write replaces (Р8): without its
            // snapshot nothing is replaced. The history is written even when it is switched off.
            let replacement = fs::read(&self.temp).map_err(io)?;
            history::snapshot_before_write(
                &self.vault,
                &self.target,
                &replacement,
                history::SYNC_OVERWRITE_REASON,
            )
            .map_err(|error| FsError::Io(format!("the snapshot of {rel} failed: {error}")))?;
        }
        if let Some(parent) = self.target.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        frontmatter::atomic_rename_with_retry(&self.temp, &self.target).map_err(io)?;
        if let Some(parent) = self.target.parent() {
            let _ = frontmatter::sync_parent_directory(parent);
        }
        Ok(())
    }
}

impl Drop for VaultStaged {
    fn drop(&mut self) {
        // A write that was neither published nor aborted (a failed pass) leaves nothing behind.
        if self.file.is_some() {
            self.remove_temp();
        }
    }
}

impl LocalFs for VaultFs {
    fn root_state(&mut self) -> Result<RootState, FsError> {
        match fs::metadata(&self.root) {
            Ok(metadata) if metadata.is_dir() => Ok(RootState::Present),
            Ok(_) => Ok(RootState::Missing),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RootState::Missing),
            Err(error) => Err(map_io("the vault folder", &error)),
        }
    }

    fn list(&mut self) -> Result<Listing, FsError> {
        let mut listing = Listing::default();
        walk(&self.root, "", &mut listing)?;
        Ok(listing)
    }

    fn read(&mut self, path: &str) -> Result<Vec<u8>, FsError> {
        let target = self.resolve(path)?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err(FsError::Io(format!("{path} is not a file"))),
            Err(error) => return Err(map_io(path, &error)),
        }
        fs::read(&target).map_err(|error| map_io(path, &error))
    }

    fn begin_write(&mut self, path: &str) -> Result<Box<dyn StagedWrite>, FsError> {
        let target = self.resolve(path)?;
        let name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| FsError::Io(format!("{path} has no name")))?;
        // The temporary file lies in the nearest folder that exists: the folders of the target
        // are made when the write is published, so an aborted write leaves no empty folders
        // (which would look like folders of the user, Р2).
        let mut home = target.parent().map(Path::to_path_buf).unwrap_or_default();
        while !home.exists() && home != self.root {
            home = home.parent().map(Path::to_path_buf).unwrap_or_default();
        }
        let temp = home.join(format!(
            ".{name}.amby-tmp-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| map_io(path, &error))?;
        Ok(Box::new(VaultStaged {
            vault: self.root.clone(),
            target,
            rel: path.to_string(),
            temp,
            file: Some(file),
        }))
    }

    fn create_dir(&mut self, path: &str) -> Result<(), FsError> {
        let target = self.resolve(path)?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => return Ok(()),
            Ok(_) => return Err(FsError::AlreadyExists(path.to_string())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(map_io(path, &error)),
        }
        fs::create_dir_all(&target).map_err(|error| map_io(path, &error))
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), FsError> {
        let source = self.resolve(from)?;
        let target = self.resolve(to)?;
        let source_kind = match fs::symlink_metadata(&source) {
            Ok(metadata) => metadata,
            Err(error) => return Err(map_io(from, &error)),
        };
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                // The same entry under another spelling (a change of case on a case-insensitive
                // system) is a rename of that entry, not a collision.
                let same = matches!(
                    (source.canonicalize(), target.canonicalize()),
                    (Ok(a), Ok(b)) if a == b
                ) && source != target;
                if !same {
                    return Err(FsError::AlreadyExists(to.to_string()));
                }
                return fs::rename(&source, &target).map_err(|error| map_io(to, &error));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(map_io(to, &error)),
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| map_io(to, &error))?;
        }
        if source_kind.is_file() {
            // A file is linked under the new name and then unlinked: `link` never replaces, so
            // a file that appeared at the target in the meantime is never overwritten (Д17).
            match frontmatter::publish_prepared_no_replace(&source, &target) {
                Ok(()) => {
                    fs::remove_file(&source).map_err(|error| map_io(from, &error))?;
                    Ok(())
                }
                Err(frontmatter::AtomicCreateError::AlreadyExists) => {
                    Err(FsError::AlreadyExists(to.to_string()))
                }
                Err(frontmatter::AtomicCreateError::Other(text)) => {
                    Err(FsError::Io(format!("{from}: {text}")))
                }
            }
        } else {
            // A folder has no atomic move that refuses to replace; the target was just found
            // missing, and the system itself refuses to replace a folder that is not empty.
            fs::rename(&source, &target).map_err(|error| map_io(to, &error))
        }
    }

    fn move_to_trash(&mut self, path: &str, _reason: TrashReason) -> Result<(), FsError> {
        let target = self.resolve(path)?;
        fs::symlink_metadata(&target).map_err(|error| map_io(path, &error))?;
        recycle_bin::move_exact_to_trash(&self.root, &target).map_err(|error| map_io(path, &error))
    }

    fn remove_empty_dir(&mut self, path: &str) -> Result<bool, FsError> {
        let target = self.resolve(path)?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(map_io(path, &error)),
        }
        let mut entries = fs::read_dir(&target).map_err(|error| map_io(path, &error))?;
        if entries.next().is_some() {
            return Ok(false);
        }
        match fs::remove_dir(&target) {
            Ok(()) => Ok(true),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.kind() == std::io::ErrorKind::DirectoryNotEmpty =>
            {
                Ok(false)
            }
            Err(error) => Err(map_io(path, &error)),
        }
    }

    fn recovery_pending(&mut self) -> Result<bool, FsError> {
        Ok(pending_journals(&self.root))
    }

    fn cleanup_staged(&mut self) -> Result<(), FsError> {
        let mut folders = vec![self.root.clone()];
        while let Some(folder) = folders.pop() {
            let Ok(entries) = fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                if kind.is_dir() {
                    // The folders the listing does not enter hold no temporary files of ours.
                    let rel_parent = folder
                        .strip_prefix(&self.root)
                        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    if !is_not_entered(&rel_parent, &name) {
                        folders.push(entry.path());
                    }
                } else if kind.is_file() && name.starts_with('.') && name.contains(".amby-tmp-") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }

    fn name_rules(&self) -> NameRules {
        if cfg!(windows) {
            NameRules::windows()
        } else if cfg!(target_os = "macos") {
            NameRules::macos()
        } else {
            NameRules::linux()
        }
    }

    fn batch_begin(&mut self) {
        if let Some(hooks) = &self.hooks {
            hooks.batch_begin();
        }
    }

    fn batch_end(&mut self) {
        if let Some(hooks) = &self.hooks {
            hooks.batch_end();
        }
    }
}
