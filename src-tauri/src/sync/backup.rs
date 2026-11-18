//! A verified, external copy before the first sync pass. The immutable manifest is
//! the completion boundary; the receipt is written only after it is durable.
//!
//! The copy and its receipt live in Amby's app data (`<app data>/backups/<vault key>/`),
//! never beside the vault. Receipts written by older versions stay in the vault
//! (`.amby/sync/pre-sync-backup.json`, pointing at `<vault>.amby-backups/<ULID>/`); they are
//! still read but never written, and their copies are never removed automatically.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::types::SyncError;
use crate::frontmatter::{
    atomic_copy_file_new, atomic_write_bytes, atomic_write_bytes_new, sync_parent_directory,
};

/// The receipt that older versions wrote into the vault. Read-only now.
const RECEIPT: &str = ".amby/sync/pre-sync-backup.json";
/// The receipt of the current scheme, inside `<home>/<vault key>/`.
const APP_RECEIPT: &str = "receipt.json";
/// How long a copy is kept after the first successful sync pass of the vault.
pub const RETENTION_MS: u64 = 14 * 24 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const DATABASES: [&str; 2] = [".amby/notes.db", ".amby/sync/state.db"];
const RESTORE: &str = "Amby — восстановление / restore\n\nВыключите синхронизацию и закройте Amby. Скопируйте подпапку vault в НОВУЮ папку, не поверх рабочего хранилища. В новой папке переименуйте .amby/sync в .amby/sync-before-restore (если есть), чтобы не возобновлять прежнюю сессию автоматически. Затем откройте новую папку в Amby, проверьте заметки и подключите синхронизацию заново только после проверки. Исходную папку и эту копию сохраните.\n\nTurn sync off and close Amby. Copy the vault subfolder to a NEW folder, never over the working vault. In the new folder rename .amby/sync to .amby/sync-before-restore if present, to prevent automatic session resumption. Open the new folder in Amby, check your notes, then explicitly reconnect sync. Keep both the original folder and this backup.\n\nOnly a directory with manifest.json and without INCOMPLETE is a completed backup. Known SQLite databases are consistent online snapshots; their WAL/SHM files are not needed. Other files retain their original bytes. This copy is on the same disk unless you move it to another disk.\n";

#[derive(Clone, Serialize, Deserialize)]
struct Receipt {
    version: u32,
    source_canonical: String,
    backup_root: String,
    manifest_sha256: String,
    /// When the first sync pass of this vault ended well; starts the retention period.
    #[serde(default)]
    first_sync_ms: Option<u64>,
    /// When the copy was deleted (expired or by the person). The record stays so that an
    /// automatic restart does not make a new copy.
    #[serde(default)]
    removed_ms: Option<u64>,
    /// Copies of earlier attempts that this one replaced (a damaged or missing copy).
    #[serde(default)]
    superseded: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Origin {
    AppData,
    Legacy,
}

/// What is known about the copy of a vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Standing {
    /// No copy was made (or it was deleted before the first successful sync).
    Never,
    /// A complete copy exists; the path of its root.
    Ready(String),
    /// A copy was made, the vault synced, and the copy was deleted on purpose or expired.
    Gone,
    /// A copy was recorded but is missing, incomplete or damaged.
    Lost,
}

static HOME: OnceLock<PathBuf> = OnceLock::new();
static RECEIPT_LOCK: Mutex<()> = Mutex::new(());

/// Sets the folder that holds all copies (`<app data>/backups`). The first call wins.
pub fn set_home(dir: PathBuf) {
    let _ = HOME.set(dir);
}

pub(crate) fn home() -> Result<PathBuf, SyncError> {
    if let Some(dir) = HOME.get() {
        return Ok(dir.clone());
    }
    #[cfg(test)]
    {
        Ok(test_home())
    }
    #[cfg(not(test))]
    {
        Err(error("backup_failed"))
    }
}

#[cfg(test)]
fn test_home() -> PathBuf {
    static TEST_HOME: OnceLock<PathBuf> = OnceLock::new();
    TEST_HOME
        .get_or_init(|| {
            let dir = std::env::temp_dir().join("amby-test-backups-home");
            let _ = fs::create_dir_all(&dir);
            // Copies of earlier test runs are not needed any more.
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let old = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age.as_secs() > 24 * 3600);
                    if old {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                }
            }
            dir
        })
        .clone()
}

fn lock_receipts() -> MutexGuard<'static, ()> {
    RECEIPT_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// `<home>/<key>/`: the key is a hash of the canonical vault path, so a vault never reads
/// another vault's receipt, and a vault folder synced between computers does not share one.
pub(crate) fn key_dir_in(home: &Path, vault: &Path) -> Result<PathBuf, SyncError> {
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let digest = Sha256::digest(text(vault)?.as_bytes());
    Ok(home.join(hex::encode(&digest[..16])))
}

pub(crate) fn key_dir(vault: &Path, _create: bool) -> Result<PathBuf, SyncError> {
    let vault = vault.canonicalize().unwrap_or_else(|_| vault.to_path_buf());
    key_dir_in(&home()?, &vault)
}

pub(crate) fn legacy_container(vault: &Path) -> Result<PathBuf, SyncError> {
    let name = vault
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| error("backup_invalid"))?;
    Ok(vault
        .parent()
        .ok_or_else(|| error("backup_invalid"))?
        .join(format!("{name}.amby-backups")))
}

pub(crate) fn valid_id(value: &str) -> bool {
    ulid::Ulid::from_string(value).is_ok_and(|parsed| parsed.to_string() == value)
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
        // A Windows drive or verbatim prefix is not a path on its own. Inspect
        // it only after the root separator has been appended.
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
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

fn load_receipt_at(path: &Path) -> Result<Option<Receipt>, SyncError> {
    no_links(path)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = read_limited(path, 65536)?;
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

/// What the vault's receipts say: the app-data receipt wins over a legacy one in the vault.
enum Found {
    Nothing,
    /// A receipt file that cannot be read or does not belong to this vault.
    Unreadable,
    Receipt(Receipt, Origin),
}

fn lookup(vault: &Path) -> Result<Found, SyncError> {
    let source = text(vault)?;
    let candidates = [
        (key_dir(vault, false)?.join(APP_RECEIPT), Origin::AppData),
        (vault.join(RECEIPT), Origin::Legacy),
    ];
    for (path, origin) in candidates {
        match load_receipt_at(&path) {
            Ok(None) => {}
            Ok(Some(receipt)) if receipt.source_canonical == source => {
                return Ok(Found::Receipt(receipt, origin))
            }
            // A receipt that came along with a copied vault folder names another path.
            Ok(Some(_)) if origin == Origin::Legacy => {}
            Ok(Some(_)) => return Ok(Found::Unreadable),
            Err(e) if e.code == "backup_invalid" => return Ok(Found::Unreadable),
            Err(e) => return Err(e),
        }
    }
    Ok(Found::Nothing)
}

/// The id of a copy root that sits directly inside `parent`.
fn root_id(parent: &Path, root: &str) -> Option<String> {
    let root = Path::new(root);
    let name = root.file_name()?.to_str()?;
    (valid_id(name) && root.parent() == Some(parent)).then(|| name.to_owned())
}

fn manifest(
    vault: &Path,
    receipt: &Receipt,
    origin: Origin,
) -> Result<(PathBuf, Manifest), SyncError> {
    if receipt.source_canonical != text(vault)? {
        return Err(error("backup_invalid"));
    }
    let root = PathBuf::from(&receipt.backup_root);
    // A receipt is data: an app-data receipt may only name a copy in its own folder.
    if origin == Origin::AppData && root_id(&key_dir(vault, false)?, &receipt.backup_root).is_none()
    {
        return Err(error("backup_invalid"));
    }
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

/// Ensure a complete external copy exists and return its root. A copy that is missing, incomplete
/// or damaged is never repaired or overwritten: a new copy is made in a new folder and the
/// app-data receipt names it from then on (the old one is kept in `superseded`).
pub fn ensure(vault: &Path) -> Result<String, SyncError> {
    let vault = vault.canonicalize().map_err(failed)?;
    create_or_reuse(&vault)
}

fn create_or_reuse(vault: &Path) -> Result<String, SyncError> {
    if let Found::Receipt(receipt, origin) = lookup(vault)? {
        if receipt.removed_ms.is_none() {
            if let Ok((root, manifest)) = manifest(vault, &receipt, origin) {
                if inventory(&root.join("vault"), false).is_ok_and(|e| e == manifest.entries) {
                    return text(&root);
                }
            }
        }
    }
    create_in(&home()?, vault, || Ok(()))
}

/// What switching sync on (or resuming it) needs from the copy: a complete one exists, unless
/// the vault was already synced and its copy was deleted on purpose.
pub fn prepare(vault: &Path) -> Result<(), SyncError> {
    let vault = vault.canonicalize().map_err(failed)?;
    if standing_of(&vault) == Standing::Gone {
        return Ok(());
    }
    create_or_reuse(&vault).map(drop)
}

pub fn standing(vault: &Path) -> Standing {
    match vault.canonicalize() {
        Ok(vault) => standing_of(&vault),
        Err(_) => Standing::Never,
    }
}

fn standing_of(vault: &Path) -> Standing {
    match lookup(vault) {
        Ok(Found::Nothing) => Standing::Never,
        Ok(Found::Unreadable) | Err(_) => Standing::Lost,
        Ok(Found::Receipt(receipt, origin)) => {
            if receipt.removed_ms.is_some() {
                return if receipt.first_sync_ms.is_some() {
                    Standing::Gone
                } else {
                    Standing::Never
                };
            }
            match manifest(vault, &receipt, origin) {
                Ok((root, _)) if root.join("vault").is_dir() => {
                    Standing::Ready(receipt.backup_root)
                }
                _ => Standing::Lost,
            }
        }
    }
}

/// Fast receipt validation for status/automatic resumption. Does not rehash all
/// backup files on every status event; explicit enable calls ensure for that check.
pub fn read_path(vault: &Path) -> Option<String> {
    match standing(vault) {
        Standing::Ready(path) => Some(path),
        _ => None,
    }
}

fn write_receipt(vault: &Path, receipt: &Receipt) -> Result<(), SyncError> {
    let bytes = serde_json::to_vec(receipt).map_err(failed)?;
    if bytes.len() > 65536 {
        return Err(error("backup_failed"));
    }
    let dir = key_dir(vault, true)?;
    write_receipt_at(&dir, &bytes)
}

fn write_receipt_at(dir: &Path, bytes: &[u8]) -> Result<(), SyncError> {
    no_links(dir)?;
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(failed)?;
    }
    let path = dir.join(APP_RECEIPT);
    no_links(&path)?;
    atomic_write_bytes(&path, bytes).map_err(failed)
}

/// Remembers when the first sync pass of the vault ended well. The 14 days start there.
/// Only an app-data receipt is changed; a legacy copy has no expiry.
pub fn record_first_sync(vault: &Path, now_ms: u64) -> Result<(), SyncError> {
    let vault = vault.canonicalize().map_err(failed)?;
    let _guard = lock_receipts();
    if let Found::Receipt(mut receipt, Origin::AppData) = lookup(&vault)? {
        if receipt.removed_ms.is_none() && receipt.first_sync_ms.is_none() {
            receipt.first_sync_ms = Some(now_ms);
            write_receipt(&vault, &receipt)?;
        }
    }
    Ok(())
}

/// Deletes the copy 14 days after the first successful sync. Returns whether it was deleted.
pub fn cleanup_expired(vault: &Path, now_ms: u64) -> Result<bool, SyncError> {
    let vault = vault.canonicalize().map_err(failed)?;
    let _guard = lock_receipts();
    let Found::Receipt(mut receipt, Origin::AppData) = lookup(&vault)? else {
        return Ok(false);
    };
    let Some(first) = receipt.first_sync_ms else {
        return Ok(false);
    };
    if receipt.removed_ms.is_some() || now_ms < first.saturating_add(RETENTION_MS) {
        return Ok(false);
    }
    let key = key_dir(&vault, false)?;
    let mut ids = std::mem::take(&mut receipt.superseded);
    if let Some(current) = root_id(&key, &receipt.backup_root) {
        ids.push(current);
    }
    receipt.removed_ms = Some(now_ms);
    write_receipt(&vault, &receipt)?;
    for id in ids {
        remove_copy(&key, &id)?;
    }
    Ok(true)
}

/// Deletes one copy by id on the person's request: a copy of the app-data scheme, or the
/// older copy that a legacy receipt in the vault names. Anything else is refused.
pub fn delete(vault: &Path, id: &str, now_ms: u64) -> Result<(), SyncError> {
    let vault = vault.canonicalize().map_err(failed)?;
    if !valid_id(id) {
        return Err(error("backup_invalid"));
    }
    let _guard = lock_receipts();
    let key = key_dir(&vault, false)?;
    let found = lookup(&vault)?;
    if fs::symlink_metadata(key.join(id)).is_ok() {
        // An app-data copy: the current one, an earlier one, or one left without a receipt.
        if let Found::Receipt(mut receipt, Origin::AppData) = found {
            if root_id(&key, &receipt.backup_root).as_deref() == Some(id) {
                receipt.removed_ms = Some(now_ms);
            }
            receipt.superseded.retain(|old| old != id);
            write_receipt(&vault, &receipt)?;
        }
        return remove_copy(&key, id);
    }
    match found {
        Found::Receipt(mut receipt, Origin::AppData)
            if root_id(&key, &receipt.backup_root).as_deref() == Some(id) =>
        {
            // The record names a copy that is already gone: close it.
            receipt.removed_ms = Some(now_ms);
            write_receipt(&vault, &receipt)
        }
        Found::Receipt(receipt, Origin::Legacy) => {
            let container = legacy_container(&vault)?;
            if root_id(&container, &receipt.backup_root).as_deref() != Some(id) {
                return Err(error("backup_invalid"));
            }
            // Record the deletion in app data first; the legacy receipt stays as it is.
            let record = Receipt {
                removed_ms: Some(now_ms),
                first_sync_ms: None,
                superseded: Vec::new(),
                ..receipt
            };
            write_receipt(&vault, &record)?;
            remove_copy(&container, id)
        }
        _ => Err(error("backup_invalid")),
    }
}

/// The one place where a copy is removed. `parent` is the folder that owns the copies (the
/// vault's app-data folder or, for an old copy, the legacy sibling folder), `id` a ULID.
fn remove_copy(parent: &Path, id: &str) -> Result<(), SyncError> {
    if !valid_id(id) {
        return Err(error("backup_invalid"));
    }
    let root = parent.join(id);
    no_links(&root)?;
    match fs::symlink_metadata(&root) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(error("backup_invalid")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(failed(e)),
    }
    if root.canonicalize().map_err(failed)? != root {
        return Err(error("backup_invalid"));
    }
    fs::remove_dir_all(&root).map_err(failed)?;
    sync_parent_directory(parent).map_err(failed)
}

#[cfg(test)]
pub(crate) fn create_with_hook(
    vault: &Path,
    before_verify: impl FnOnce() -> Result<(), SyncError>,
) -> Result<String, SyncError> {
    create_in(
        &home()?,
        &vault.canonicalize().map_err(failed)?,
        before_verify,
    )
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
    drop(copy);
    drop(db);
    // Windows FlushFileBuffers requires a writable file handle. SQLite has
    // finished and closed the snapshot before we open it for durability.
    fs::OpenOptions::new()
        .write(true)
        .open(target)
        .and_then(|file| file.sync_all())
        .map_err(failed)?;
    Ok(())
}

/// Makes a new copy in `<home>/<vault key>/<ULID>/` and publishes it in the app-data receipt.
/// Nothing is created in or beside the vault.
pub(crate) fn create_in(
    home: &Path,
    vault: &Path,
    before_verify: impl FnOnce() -> Result<(), SyncError>,
) -> Result<String, SyncError> {
    let vault = vault.canonicalize().map_err(failed)?;
    fs::create_dir_all(home).map_err(failed)?;
    let parent = home.canonicalize().map_err(failed)?;
    if !parent.is_dir() {
        return Err(error("backup_failed"));
    }
    if parent.starts_with(&vault) {
        return Err(error("backup_invalid"));
    }
    let source = text(&vault)?;
    let before = inventory(&vault, true)?;
    let container = key_dir_in(&parent, &vault)?;
    no_links(&container)?;
    if !container.exists() {
        private_dir(&container)?;
        sync_parent_directory(&parent).map_err(failed)?;
    }
    if !container.is_dir() {
        return Err(error("backup_failed"));
    }
    // What the new receipt replaces: its copy (if any) stays on disk and is remembered.
    let _guard = lock_receipts();
    let previous = match load_receipt_at(&container.join(APP_RECEIPT)) {
        Ok(found) => found.filter(|r| r.source_canonical == source),
        Err(e) if e.code == "backup_invalid" => {
            // Keep an unreadable receipt for inspection instead of overwriting it.
            let aside = container.join(format!(
                "receipt.unreadable-{}.json",
                ulid::Ulid::generate()
            ));
            fs::rename(container.join(APP_RECEIPT), aside).map_err(failed)?;
            None
        }
        Err(e) => return Err(e),
    };
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
        let mut superseded = previous
            .as_ref()
            .map(|p| p.superseded.clone())
            .unwrap_or_default();
        if let Some(old) = previous.as_ref().filter(|p| p.removed_ms.is_none()) {
            if let Some(id) = root_id(&container, &old.backup_root) {
                superseded.push(id);
            }
        }
        let receipt = Receipt {
            version: 1,
            source_canonical: source,
            backup_root: text(&root)?,
            manifest_sha256: hex::encode(Sha256::digest(&bytes)),
            first_sync_ms: None,
            removed_ms: None,
            superseded,
        };
        let receipt_bytes = serde_json::to_vec(&receipt).map_err(failed)?;
        if receipt_bytes.len() > 65536 {
            return Err(error("backup_failed"));
        }
        // The receipt is replaced atomically: it names the old copy or the new one, never neither.
        write_receipt_at(&container, &receipt_bytes)?;
        text(&root)
    })();
    if result.is_err() {
        // Publication may succeed before a directory fsync reports a failure.
        // Never remove the complete copy that a visible receipt points to.
        let published = load_receipt_at(&container.join(APP_RECEIPT))
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
