//! The archive: what the person put away but wants to keep (docs/sync-plan.md, appendix К).
//!
//! The archive is the hidden synchronised folder `.amby/archive/` that repeats the paths of the
//! vault (К1); each file has a record `.amby/archive/.meta/<id>.json` `{path, archivedAtMs}` (К8).
//! An entry of the list is identified by its path inside the archive (К6).

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::model::FsMutationResult;
use crate::recycle_bin::{DeleteMode, TrashPreview};
use crate::system_recycle_bin::SystemTrash;

/// Where the archive lies: `<vault>/.amby/archive` (К1).
pub fn archive_root(vault: &Path) -> PathBuf {
    vault.join(".amby").join("archive")
}

/// Where the records of the times lie: `<vault>/.amby/archive/.meta` (К8).
pub fn meta_root(vault: &Path) -> PathBuf {
    archive_root(vault).join(".meta")
}

/// A file of the archive as the panel shows it (К6): one row per file, with its folders.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// An identifier for `restore` / `purge` / `read_preview`; its form is not part of the contract.
    pub id: String,
    /// The path in the vault the file is restored to: the path inside `.amby/archive/` (К1).
    pub original_path: String,
    /// The time of the move to the archive: `archivedAtMs` of the record, and the time of the file
    /// itself when there is no record (К8).
    pub archived_at_ms: u64,
    /// The name of the file.
    pub name: String,
}

/// The record `.amby/archive/.meta/<id>.json` (К8). Fields the code does not know are kept.
#[derive(Clone, Debug, PartialEq)]
pub struct ArchiveMeta {
    pub path: String,
    pub archived_at_ms: u64,
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ArchiveMeta {
    /// Reads a record; the key names on disk are `path` and `archivedAtMs` (К8).
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        let serde_json::Value::Object(mut map) = value else {
            return Err("An archive record is not an object".to_string());
        };
        let path = match map.remove("path") {
            Some(serde_json::Value::String(path)) => path,
            _ => return Err("An archive record has no `path`".to_string()),
        };
        let archived_at_ms = map
            .remove("archivedAtMs")
            .and_then(|value| value.as_u64())
            .ok_or_else(|| "An archive record has no `archivedAtMs`".to_string())?;
        Ok(Self {
            path,
            archived_at_ms,
            extra: map,
        })
    }

    /// The bytes of the record: `path`, `archivedAtMs` and every unknown field as it was (К8).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut map = self.extra.clone();
        map.insert(
            "path".to_string(),
            serde_json::Value::String(self.path.clone()),
        );
        map.insert(
            "archivedAtMs".to_string(),
            serde_json::Value::from(self.archived_at_ms),
        );
        serde_json::to_vec_pretty(&serde_json::Value::Object(map)).unwrap_or_default()
    }
}

const MAX_LISTED_FILES: usize = 20_000;
const MAX_RECORDS: usize = 100_000;
const RECORD_MAX_BYTES: u64 = 64 * 1024;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// A plain relative path of `/`-separated normal components: nothing that leads out of the
/// archive or the vault (К1, К6).
pub(crate) fn is_plain_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn archive_file_path(vault: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_plain_relative(id) || id == ".meta" || id.starts_with(".meta/") {
        return Err("Invalid archive identifier".to_string());
    }
    let path = crate::paths::confine_rel_no_symlinks(vault, &format!(".amby/archive/{id}"))?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => Ok(path),
        _ => Err("Archive entry not found".to_string()),
    }
}

fn meta_files(vault: &Path) -> Vec<PathBuf> {
    fs::read_dir(meta_root(vault))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .take(MAX_RECORDS)
        .collect()
}

fn read_meta(path: &Path) -> Option<ArchiveMeta> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(RECORD_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > RECORD_MAX_BYTES {
        return None;
    }
    ArchiveMeta::parse(&bytes).ok()
}

/// Writes the record of the file at `archive_path` (К8, К11 (а)): `id` names the record.
pub(crate) fn write_meta(
    vault: &Path,
    id: &str,
    archive_path: &str,
    archived_at_ms: u64,
) -> Result<(), String> {
    let meta = ArchiveMeta {
        path: archive_path.to_string(),
        archived_at_ms,
        extra: serde_json::Map::new(),
    };
    crate::frontmatter::atomic_write_bytes(
        &meta_root(vault).join(format!("{id}.json")),
        &meta.to_bytes(),
    )
}

/// Removes the records of the file at `archive_path` (К11 (г)). Records are ours, not the
/// person's: a record that cannot be removed is left (a stale time does no harm).
fn remove_metas_for(vault: &Path, archive_path: &str) {
    for path in meta_files(vault) {
        if read_meta(&path).is_some_and(|meta| meta.path == archive_path) {
            let _ = fs::remove_file(path);
        }
    }
}

/// Every file under `dir` (not following links), as `/`-paths relative to `base`.
pub(crate) fn files_below(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        if out.len() >= MAX_RECORDS {
            return;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            files_below(base, &entry.path(), out);
        } else if kind.is_file() {
            if let Ok(rel) = entry.path().strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// «В архив» (К1): moves the file or folder (a note of a bundle takes its folder, as the old trash
/// did) to `.amby/archive/<its path in the vault>` by renaming, and writes the record of every
/// file moved (К8). A path outside the vault or inside `.amby/` is refused. When the place in the
/// archive is taken, the item goes next to it under a free name and nothing in the archive is
/// replaced.
pub fn move_to_archive(vault: &Path, path: &Path) -> Result<FsMutationResult, String> {
    let preview = crate::recycle_bin::preview_move_to_trash(vault, path)?;
    let vault_path = vault.canonicalize().map_err(|error| error.to_string())?;
    let relative = preview
        .original_path
        .strip_prefix(&vault_path)
        .map_err(|_| "Cannot determine the vault-relative archive path".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    if relative.is_empty() {
        return Err("The vault itself cannot be archived".to_string());
    }
    if amby_sync_core::engine::history::is_service_path(&relative) {
        return Err("Service files cannot be archived".to_string());
    }
    let deleted_paths = preview
        .deleted_paths
        .iter()
        .map(|path| crate::bundle::path_string(path))
        .collect();
    let wanted = archive_root(&vault_path).join(&relative);
    let parent = wanted
        .parent()
        .ok_or("Archive target has no parent")?
        .to_path_buf();
    fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    let name = wanted
        .file_name()
        .ok_or("Archive target has no name")?
        .to_string_lossy()
        .into_owned();
    // `free_path` takes the place itself when it is free and never a taken one: nothing in the
    // archive is replaced.
    let target = crate::commands::import_files::free_path(&parent, &name);
    fs::rename(&preview.original_path, &target).map_err(|error| error.to_string())?;
    let archived_at = now_ms();
    let mut files = Vec::new();
    if fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_dir()) {
        files_below(&archive_root(&vault_path), &target, &mut files);
    } else if let Ok(rel) = target.strip_prefix(archive_root(&vault_path)) {
        files.push(rel.to_string_lossy().replace('\\', "/"));
    }
    for file in files {
        let id = ulid::Ulid::generate().to_string();
        if let Err(error) = write_meta(&vault_path, &id, &file, archived_at) {
            // The file is safely in the archive; without a record the list shows its own time.
            tracing::warn!(event = "archive_record_failed", path = %file, error = %error);
        }
    }
    Ok(FsMutationResult {
        tree_patch: None,
        also_touched: Vec::new(),
        primary_id: None,
        primary_path: None,
        path_changes: Vec::new(),
        deleted_paths,
        deleted_ids: Vec::new(),
    })
}

/// The files of the archive (К6): everything under `.amby/archive/` except `.meta/`, newest first.
pub fn list(vault: &Path) -> Vec<ArchiveEntry> {
    let root = archive_root(vault);
    let mut paths = Vec::new();
    files_below(&root, &root, &mut paths);
    paths.retain(|path| !path.starts_with(".meta/"));
    paths.retain(|path| {
        // The litter the synchronisation never carries is not shown either (Р4).
        !amby_sync_core::engine::rules::is_excluded_path(&format!(".amby/archive/{path}"))
    });
    paths.truncate(MAX_LISTED_FILES);
    let mut times = std::collections::HashMap::<String, u64>::new();
    for record in meta_files(vault) {
        if let Some(meta) = read_meta(&record) {
            let slot = times.entry(meta.path).or_default();
            *slot = (*slot).max(meta.archived_at_ms);
        }
    }
    let mut entries: Vec<ArchiveEntry> = paths
        .into_iter()
        .map(|path| {
            let archived_at_ms = times.get(&path).copied().unwrap_or_else(|| {
                fs::metadata(root.join(&path))
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_millis() as u64)
                    .unwrap_or_default()
            });
            ArchiveEntry {
                name: path.rsplit('/').next().unwrap_or(&path).to_string(),
                id: path.clone(),
                original_path: path,
                archived_at_ms,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.archived_at_ms
            .cmp(&a.archived_at_ms)
            .then_with(|| a.original_path.cmp(&b.original_path))
    });
    entries
}

fn prune_empty_archive_dirs(vault: &Path, mut dir: PathBuf) {
    let root = archive_root(vault);
    while dir != root && dir.starts_with(&root) {
        // `remove_dir` refuses a folder that holds anything.
        if fs::remove_dir(&dir).is_err() {
            break;
        }
        let Some(parent) = dir.parent() else { break };
        dir = parent.to_path_buf();
    }
}

/// Where «Вернуть» (К6) would put the file: the archived file and its final place, which is its
/// path in the vault, or a free name next to it when that is taken. Creates nothing.
pub fn restore_places(vault: &Path, id: &str) -> Result<(PathBuf, PathBuf), String> {
    let source = archive_file_path(vault, id)?;
    let vault_path = vault.canonicalize().map_err(|error| error.to_string())?;
    let wanted = crate::paths::confine_rel_no_symlinks(&vault_path, id)?;
    let parent = wanted.parent().ok_or("Restore target has no parent")?;
    let name = wanted
        .file_name()
        .ok_or("Restore target has no name")?
        .to_string_lossy()
        .into_owned();
    Ok((
        source,
        crate::commands::import_files::free_path(parent, &name),
    ))
}

/// «Вернуть» (К6): renames the file to its path in the vault **without replacing** anything; a
/// taken path gives a free name next to it (`Name 2.md`, the rule of `free_path`); missing folders
/// are created. `primary_path` of the result is the final absolute path.
pub fn restore(vault: &Path, id: &str) -> Result<FsMutationResult, String> {
    let (source, target) = restore_places(vault, id)?;
    let vault_path = vault.canonicalize().map_err(|error| error.to_string())?;
    fs::create_dir_all(target.parent().ok_or("Restore target has no parent")?)
        .map_err(|error| error.to_string())?;
    fs::rename(&source, &target).map_err(|error| error.to_string())?;
    remove_metas_for(&vault_path, id);
    if let Some(dir) = source.parent() {
        prune_empty_archive_dirs(&vault_path, dir.to_path_buf());
    }
    let path_changes = crate::recycle_bin::markdown_like(&target)
        .then(|| crate::model::PathChange {
            old_path: String::new(),
            new_path: crate::bundle::path_string(&target),
        })
        .into_iter()
        .collect();
    Ok(FsMutationResult {
        tree_patch: None,
        also_touched: Vec::new(),
        primary_id: None,
        primary_path: Some(crate::bundle::path_string(&target)),
        path_changes,
        deleted_paths: Vec::new(),
        deleted_ids: Vec::new(),
    })
}

/// «Удалить из архива» (К6) by the setting of К4: `System` and `Archive` (the setting «Переносить в
/// архив» means here the system trash) hand the file to `system_trash`, `Permanent` removes it. A
/// refusal of the trash is an error and the file stays in the archive (К11 (в)). The record is
/// removed with the file.
pub fn purge(
    vault: &Path,
    id: &str,
    mode: DeleteMode,
    system_trash: &dyn SystemTrash,
) -> Result<(), String> {
    let path = archive_file_path(vault, id)?;
    match mode {
        DeleteMode::System | DeleteMode::Archive => system_trash.trash(&path)?,
        DeleteMode::Permanent => fs::remove_file(&path).map_err(|error| error.to_string())?,
    }
    let vault_path = vault.canonicalize().map_err(|error| error.to_string())?;
    remove_metas_for(&vault_path, id);
    if let Some(dir) = path.parent() {
        prune_empty_archive_dirs(&vault_path, dir.to_path_buf());
    }
    Ok(())
}

/// A read-only look at an archived file (the panel's preview).
pub fn read_preview(vault: &Path, id: &str, relative_path: &str) -> Result<TrashPreview, String> {
    let path = archive_file_path(vault, id)?;
    if !relative_path.is_empty() {
        return Err("An archived file has nothing below it".to_string());
    }
    crate::recycle_bin::preview_payload(&path, relative_path)
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "archive_test_support.rs"]
pub(crate) mod test_support;
