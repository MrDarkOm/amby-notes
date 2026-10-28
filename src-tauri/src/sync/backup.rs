//! A verified, external copy before the first sync pass. The immutable manifest is
//! the completion boundary; the vault receipt is written only after it is durable.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::types::SyncError;
use crate::frontmatter::{
    atomic_copy_file_new, atomic_write_bytes, atomic_write_bytes_new, sync_parent_directory,
};

const RECEIPT: &str = ".amby/sync/pre-sync-backup.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const DATABASES: [&str; 2] = [".amby/notes.db", ".amby/sync/state.db"];
const RESTORE: &str = "Amby — восстановление / restore\n\nВыключите синхронизацию и закройте Amby. Скопируйте подпапку vault в НОВУЮ папку, не поверх рабочего хранилища. В новой папке переименуйте .amby/sync в .amby/sync-before-restore (если есть), чтобы не возобновлять прежнюю сессию автоматически. Затем откройте новую папку в Amby, проверьте заметки и подключите синхронизацию заново только после проверки. Исходную папку и эту копию сохраните.\n\nTurn sync off and close Amby. Copy the vault subfolder to a NEW folder, never over the working vault. In the new folder rename .amby/sync to .amby/sync-before-restore if present, to prevent automatic session resumption. Open the new folder in Amby, check your notes, then explicitly reconnect sync. Keep both the original folder and this backup.\n\nOnly a directory with manifest.json and without INCOMPLETE is a completed backup. Known SQLite databases are consistent online snapshots; their WAL/SHM files are not needed. Other files retain their original bytes. This copy is on the same disk unless you move it to another disk.\n";

#[derive(Serialize, Deserialize)]
struct Receipt {
    version: u32,
    source_canonical: String,
    backup_root: String,
    manifest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    path: String,
    directory: bool,
    size: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u32,
    complete: bool,
    source_canonical: String,
    entries: Vec<Entry>,
}

fn error(code: &str) -> SyncError {
    SyncError::new(code)
}
fn failed<T>(_: T) -> SyncError {
    error("backup_failed")
}
fn invalid<T>(_: T) -> SyncError {
    error("backup_invalid")
}

fn text(path: &Path) -> Result<String, SyncError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| error("backup_unsafe_entry"))
}

fn no_links(path: &Path) -> Result<(), SyncError> {
    let mut part = PathBuf::new();
    for component in path.components() {
        part.push(component);
        match fs::symlink_metadata(&part) {
            Ok(m) if m.file_type().is_symlink() => return Err(error("backup_unsafe_entry")),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(failed(e)),
        }
    }
    Ok(())
}

fn digest(path: &Path) -> Result<(u64, String), SyncError> {
    no_links(path)?;
    let mut input = File::open(path).map_err(failed)?;
    let mut hash = Sha256::new();
    let mut total = 0;
    let mut bytes = [0u8; 65536];
    loop {
        let n = input.read(&mut bytes).map_err(failed)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hash.update(&bytes[..n]);
    }
    Ok((total, hex::encode(hash.finalize())))
}

fn private_dir(path: &Path) -> Result<(), SyncError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(failed)
}

fn ignored(vault: &Path, relative: &str) -> bool {
    relative == RECEIPT
        || DATABASES.iter().any(|db| {
            (relative == format!("{db}-wal") || relative == format!("{db}-shm"))
                && vault.join(db).is_file()
        })
}

// SQLite uses an online snapshot instead of its mutable physical pages. For the
// source inventory we compare its presence, while ordinary files are compared by hash.
fn inventory(vault: &Path, source: bool) -> Result<Vec<Entry>, SyncError> {
    let mut entries = Vec::new();
    for item in walkdir::WalkDir::new(vault)
        .min_depth(1)
        .follow_links(false)
    {
        let item = item.map_err(failed)?;
        let kind = item.file_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(error("backup_unsafe_entry"));
        }
        let relative = item
            .path()
            .strip_prefix(vault)
            .map_err(failed)?
            .components()
            .map(|part| text(Path::new(part.as_os_str())))
            .collect::<Result<Vec<_>, _>>()?
            .join("/");
        if source && ignored(vault, &relative) {
            continue;
        }
        let (size, sha256) = if kind.is_dir() || (source && DATABASES.contains(&relative.as_str()))
        {
            (0, String::new())
        } else {
            digest(item.path())?
        };
        entries.push(Entry {
            path: relative,
            directory: kind.is_dir(),
            size,
            sha256,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

fn load_receipt(vault: &Path) -> Result<Option<Receipt>, SyncError> {
    let path = vault.join(RECEIPT);
    no_links(&path)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = read_limited(&path, 65536)?;
    let receipt: Receipt = serde_json::from_slice(&data).map_err(invalid)?;
    if receipt.version != 1 {
        return Err(error("backup_invalid"));
    }
    Ok(Some(receipt))
}

fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>, SyncError> {
    no_links(path)?;
    let file = File::open(path).map_err(invalid)?;
    if file.metadata().map_err(invalid)?.len() > max {
        return Err(error("backup_invalid"));
    }
    let mut data = Vec::new();
    file.take(max + 1).read_to_end(&mut data).map_err(invalid)?;
    if data.len() as u64 > max {
        return Err(error("backup_invalid"));
    }
    Ok(data)
}

fn manifest(vault: &Path, receipt: &Receipt) -> Result<(PathBuf, Manifest), SyncError> {
    if receipt.source_canonical != text(vault)? {
        return Err(error("backup_invalid"));
    }
    let root = PathBuf::from(&receipt.backup_root);
    no_links(&root)?;
    if root.canonicalize().map_err(invalid)? != root
        || root.starts_with(vault)
        || vault.starts_with(&root)
        || root.join("INCOMPLETE").exists()
    {
        return Err(error("backup_invalid"));
    }
    let bytes = read_limited(&root.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    if hex::encode(Sha256::digest(&bytes)) != receipt.manifest_sha256 {
        return Err(error("backup_invalid"));
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(invalid)?;
    no_links(&root.join("vault"))?;
    if manifest.version != 1
        || !manifest.complete
        || manifest.source_canonical != receipt.source_canonical
    {
        return Err(error("backup_invalid"));
    }
    for entry in &manifest.entries {
        let path = Path::new(&entry.path);
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(error("backup_invalid"));
        }
    }
    Ok((root, manifest))
}

/// Ensure a complete external copy exists. A damaged existing copy is reported,
/// not silently replaced. A vault copied to another path gets its own receipt.
pub fn ensure(vault: &Path) -> Result<String, SyncError> {
    let vault = vault.canonicalize().map_err(failed)?;
    if let Some(receipt) = load_receipt(&vault)? {
        if receipt.source_canonical == text(&vault)? {
            let (root, manifest) = manifest(&vault, &receipt)?;
            if inventory(&root.join("vault"), false).map_err(invalid)? != manifest.entries {
                return Err(error("backup_invalid"));
            }
            return text(&root);
        }
    }
    create_at(
        &vault,
        vault.parent().ok_or_else(|| error("backup_invalid"))?,
    )
}

/// Fast receipt validation for status/automatic resumption. Does not rehash all
/// backup files on every status event; explicit enable calls ensure for that check.
pub fn read_path(vault: &Path) -> Option<String> {
    let vault = vault.canonicalize().ok()?;
    let receipt = load_receipt(&vault).ok()??;
    let (root, _) = manifest(&vault, &receipt).ok()?;
    root.join("vault").is_dir().then_some(receipt.backup_root)
}

pub(crate) fn create_at(vault: &Path, parent: &Path) -> Result<String, SyncError> {
    create(vault, parent, || Ok(()))
}

#[cfg(test)]
pub(crate) fn create_with_hook(
    vault: &Path,
    parent: &Path,
    before_verify: impl FnOnce() -> Result<(), SyncError>,
) -> Result<String, SyncError> {
    create(vault, parent, before_verify)
}

fn sqlite_copy(source: &Path, target: &Path) -> Result<(), SyncError> {
    no_links(source)?;
    let db =
        Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(failed)?;
    db.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(failed)?;
    db.execute("VACUUM main INTO ?1", [text(target)?])
        .map_err(failed)?;
    let copy =
        Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(failed)?;
    let check: String = copy
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(failed)?;
    if check != "ok" {
        return Err(error("backup_failed"));
    }
    File::open(target)
        .and_then(|file| file.sync_all())
        .map_err(failed)?;
    Ok(())
}

fn create(
    vault: &Path,
    parent: &Path,
    before_verify: impl FnOnce() -> Result<(), SyncError>,
) -> Result<String, SyncError> {
    let vault = vault.canonicalize().map_err(failed)?;
    let parent = parent.canonicalize().map_err(failed)?;
    if !parent.is_dir() {
        return Err(error("backup_failed"));
    }
    if parent.starts_with(&vault) {
        return Err(error("backup_invalid"));
    }
    let source = text(&vault)?;
    let before = inventory(&vault, true)?;
    let name = vault
        .file_name()
        .ok_or_else(|| error("backup_invalid"))?
        .to_str()
        .ok_or_else(|| error("backup_unsafe_entry"))?;
    let container = parent.join(format!("{name}.amby-backups"));
    no_links(&container)?;
    if !container.exists() {
        private_dir(&container)?;
        sync_parent_directory(&parent).map_err(failed)?;
    }
    if !container.is_dir() {
        return Err(error("backup_failed"));
    }
    let root = container.join(ulid::Ulid::generate().to_string());
    private_dir(&root)?; // exclusive reservation; nothing existing can be overwritten
    let result = (|| {
        atomic_write_bytes_new(
            &root.join("INCOMPLETE"),
            b"Incomplete backup; do not restore.",
        )
        .map_err(failed)?;
        let copy = root.join("vault");
        private_dir(&copy)?;
        for entry in &before {
            let from = vault.join(&entry.path);
            let to = copy.join(&entry.path);
            no_links(&from)?;
            if entry.directory {
                private_dir(&to)?;
            } else {
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent).map_err(failed)?;
                }
                if DATABASES.contains(&entry.path.as_str()) {
                    sqlite_copy(&from, &to)?;
                } else {
                    atomic_copy_file_new(&from, &to, u64::MAX).map_err(failed)?;
                }
            }
        }
        before_verify()?;
        if inventory(&vault, true)? != before {
            return Err(error("backup_changed"));
        }
        let entries = inventory(&copy, false)?;
        if entries.len() != before.len() {
            return Err(error("backup_changed"));
        }
        for (original, copied) in before.iter().zip(&entries) {
            if original.path != copied.path
                || original.directory != copied.directory
                || (!original.directory
                    && !DATABASES.contains(&original.path.as_str())
                    && original != copied)
            {
                return Err(error("backup_changed"));
            }
        }
        // Sync directories bottom-up before publishing the completion marker.
        for entry in before.iter().rev().filter(|entry| entry.directory) {
            sync_parent_directory(&copy.join(&entry.path)).map_err(failed)?;
        }
        sync_parent_directory(&copy).map_err(failed)?;
        atomic_write_bytes_new(&root.join("RESTORE.txt"), RESTORE.as_bytes()).map_err(failed)?;
        let manifest = Manifest {
            version: 1,
            complete: true,
            source_canonical: source.clone(),
            entries,
        };
        let bytes = serde_json::to_vec(&manifest).map_err(failed)?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(error("backup_failed"));
        }
        atomic_write_bytes_new(&root.join("manifest.json"), &bytes).map_err(failed)?;
        fs::remove_file(root.join("INCOMPLETE")).map_err(failed)?;
        sync_parent_directory(&root).map_err(failed)?;
        sync_parent_directory(&container).map_err(failed)?;
        let receipt = Receipt {
            version: 1,
            source_canonical: source,
            backup_root: text(&root)?,
            manifest_sha256: hex::encode(Sha256::digest(&bytes)),
        };
        let receipt_path = vault.join(RECEIPT);
        no_links(&receipt_path)?;
        let receipt_bytes = serde_json::to_vec(&receipt).map_err(failed)?;
        if receipt_bytes.len() > 65536 {
            return Err(error("backup_failed"));
        }
        atomic_write_bytes(&receipt_path, &receipt_bytes).map_err(failed)?;
        text(&root)
    })();
    if result.is_err() {
        // Publication may succeed before a directory fsync reports a failure.
        // Never remove the complete copy that a visible receipt points to.
        let published = load_receipt(&vault)
            .ok()
            .flatten()
            .is_some_and(|receipt| Path::new(&receipt.backup_root) == root);
        if !published {
            let _ = fs::remove_dir_all(&root);
        }
    }
    result
}

#[path = "backup_restore.rs"]
pub mod restore;
