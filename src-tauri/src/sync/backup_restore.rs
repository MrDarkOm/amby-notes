//! Read-only catalog and verified restore into a new, exclusively reserved folder.
//! The original vault and backup are never changed. Partial restores retain their journal.
use super::{
    digest, inventory, no_links, private_dir, read_limited, text, Entry, Manifest, Receipt,
    MAX_MANIFEST_BYTES,
};
use crate::frontmatter::{
    atomic_copy_file_new, atomic_write_bytes, atomic_write_bytes_new, sync_parent_directory,
};
use crate::sync::types::SyncError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub created_ms: u64,
    pub bytes: u64,
    pub files: u64,
    pub status: BackupCondition,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BackupCondition {
    Unchecked,
    Verified,
    Damaged,
    Incomplete,
    Missing,
}
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoredBackup {
    pub path: String,
}

#[derive(Serialize, Deserialize)]
struct RestoreJournal {
    version: u32,
    source: String,
    backup_id: String,
    manifest_sha256: String,
    operation_id: String,
    phase: String,
    archived_sync: String,
    entries: Vec<Entry>,
}
fn err(code: &str) -> SyncError {
    SyncError::new(code)
}
fn fail<T>(_: T) -> SyncError {
    err("backup_failed")
}
fn bad<T>(_: T) -> SyncError {
    err("backup_invalid")
}
fn id(value: &str) -> Result<ulid::Ulid, SyncError> {
    let parsed = ulid::Ulid::from_string(value).map_err(bad)?;
    if parsed.to_string() != value {
        return Err(err("backup_invalid"));
    }
    Ok(parsed)
}
fn container(vault: &Path) -> Result<PathBuf, SyncError> {
    let name = vault
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| err("backup_invalid"))?;
    Ok(vault
        .parent()
        .ok_or_else(|| err("backup_invalid"))?
        .join(format!("{name}.amby-backups")))
}
fn receipt(vault: &Path) -> Result<Option<Receipt>, SyncError> {
    Ok(super::load_receipt(vault)?.filter(|r| r.source_canonical == vault.to_string_lossy()))
}
fn root_for(vault: &Path, backup_id: &str) -> Result<PathBuf, SyncError> {
    id(backup_id)?;
    if let Some(r) = receipt(vault)? {
        let root = PathBuf::from(r.backup_root);
        if root.file_name().is_some_and(|name| name == backup_id) {
            return Ok(root);
        }
    }
    Ok(container(vault)?.join(backup_id))
}
fn read_manifest(vault: &Path, root: &Path) -> Result<(Manifest, String), SyncError> {
    no_links(root)?;
    if root.starts_with(vault)
        || vault.starts_with(root)
        || !root.is_dir()
        || root.join("INCOMPLETE").exists()
    {
        return Err(err("backup_invalid"));
    }
    if root.canonicalize().map_err(bad)? != root {
        return Err(err("backup_invalid"));
    }
    no_links(&root.join("vault"))?;
    if !root.join("vault").is_dir() {
        return Err(err("backup_invalid"));
    }
    let raw = read_limited(&root.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    let hash = hex::encode(Sha256::digest(&raw));
    if let Some(r) = receipt(vault)? {
        if Path::new(&r.backup_root) == root && r.manifest_sha256 != hash {
            return Err(err("backup_invalid"));
        }
    }
    let m: Manifest = serde_json::from_slice(&raw).map_err(bad)?;
    if m.version != 1 || !m.complete || m.source_canonical != text(vault)? {
        return Err(err("backup_invalid"));
    }
    let mut paths = std::collections::HashSet::new();
    for entry in &m.entries {
        let path = Path::new(&entry.path);
        if path.as_os_str().is_empty()
            || entry.path.contains('\\')
            || path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
            || !paths.insert(&entry.path)
        {
            return Err(err("backup_invalid"));
        }
    }
    Ok((m, hash))
}
fn info(vault: &Path, backup_id: &str) -> Result<BackupInfo, SyncError> {
    let created_ms = id(backup_id)?.timestamp_ms();
    let root = root_for(vault, backup_id)?;
    let mut item = BackupInfo {
        id: backup_id.into(),
        created_ms,
        bytes: 0,
        files: 0,
        status: BackupCondition::Unchecked,
    };
    no_links(&root)?;
    if !root.exists() {
        item.status = BackupCondition::Missing;
        return Ok(item);
    }
    if root.join("INCOMPLETE").exists() {
        item.status = BackupCondition::Incomplete;
        return Ok(item);
    }
    match read_manifest(vault, &root) {
        Ok((m, _)) => {
            for e in m.entries.iter().filter(|e| !e.directory) {
                item.files += 1;
                item.bytes = item
                    .bytes
                    .checked_add(e.size)
                    .ok_or_else(|| err("backup_invalid"))?;
            }
        }
        Err(_) => item.status = BackupCondition::Damaged,
    }
    Ok(item)
}
/// Metadata only. A fresh explicit verification is required before claiming integrity.
pub fn list(vault: &Path) -> Result<Vec<BackupInfo>, SyncError> {
    let vault = vault.canonicalize().map_err(fail)?;
    let family = container(&vault)?;
    no_links(&family)?;
    let mut ids = std::collections::BTreeSet::new();
    if family.exists() {
        for entry in fs::read_dir(family).map_err(fail)? {
            let entry = entry.map_err(fail)?;
            if let Some(name) = entry.file_name().to_str().filter(|name| id(name).is_ok()) {
                ids.insert(name.to_owned());
            }
        }
    }
    if let Some(r) = receipt(&vault)? {
        if let Some(name) = Path::new(&r.backup_root)
            .file_name()
            .and_then(|v| v.to_str())
            .filter(|v| id(v).is_ok())
        {
            ids.insert(name.to_owned());
        }
    }
    let mut items = ids
        .into_iter()
        .map(|key| info(&vault, &key))
        .collect::<Result<Vec<_>, _>>()?;
    items.sort_by(|a, b| {
        b.created_ms
            .cmp(&a.created_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(items)
}
fn verified(vault: &Path, backup_id: &str) -> Result<(PathBuf, Manifest, String), SyncError> {
    let root = root_for(vault, backup_id)?;
    let (m, hash) = read_manifest(vault, &root)?;
    if inventory(&root.join("vault"), false).map_err(bad)? != m.entries {
        return Err(err("backup_invalid"));
    }
    Ok((root, m, hash))
}
pub fn verify(vault: &Path, backup_id: &str) -> Result<BackupInfo, SyncError> {
    let vault = vault.canonicalize().map_err(fail)?;
    verified(&vault, backup_id)?;
    let mut item = info(&vault, backup_id)?;
    item.status = BackupCondition::Verified;
    Ok(item)
}
fn mapped(path: &str, archived_sync: &str) -> String {
    if path == ".amby/sync" {
        archived_sync.to_owned()
    } else if let Some(tail) = path.strip_prefix(".amby/sync/") {
        format!("{archived_sync}/{tail}")
    } else {
        path.into()
    }
}
fn expected_entries(m: &Manifest, archive: &str) -> Result<Vec<Entry>, SyncError> {
    id(archive
        .strip_prefix(".amby/sync-before-restore-")
        .ok_or_else(|| err("backup_invalid"))?)?;
    let mut entries: Vec<Entry> = m
        .entries
        .iter()
        .cloned()
        .map(|mut e| {
            e.path = mapped(&e.path, archive);
            e
        })
        .collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}
fn write_journal(root: &Path, journal: &RestoreJournal) -> Result<(), SyncError> {
    atomic_write_bytes(
        &root.join("operation.json"),
        &serde_json::to_vec(journal).map_err(fail)?,
    )
    .map_err(fail)
}
/// A versioned restore operation. `parent` must come from a native folder picker, not a renderer path.
/// A completed replay returns only an unchanged result. Partial work stays marked INCOMPLETE.
pub fn restore(
    vault: &Path,
    backup_id: &str,
    parent: &Path,
    operation_id: &str,
) -> Result<RestoredBackup, SyncError> {
    restore_with_hook(vault, backup_id, parent, operation_id, || Ok(()))
}
fn restore_with_hook(
    vault: &Path,
    backup_id: &str,
    parent: &Path,
    operation_id: &str,
    before_verify: impl FnOnce() -> Result<(), SyncError>,
) -> Result<RestoredBackup, SyncError> {
    let vault = vault.canonicalize().map_err(fail)?;
    if !crate::durable::valid_operation_id(operation_id) || operation_id.len() > 64 {
        return Err(err("backup_invalid"));
    }
    no_links(parent)?;
    let parent = parent.canonicalize().map_err(fail)?;
    let (backup, m, hash) = verified(&vault, backup_id)?;
    if !parent.is_dir()
        || parent.starts_with(&vault)
        || parent.starts_with(&backup)
        || parent.starts_with(container(&vault)?)
    {
        return Err(err("backup_unsafe_destination"));
    }
    let name = vault
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| err("backup_invalid"))?;
    let root = parent.join(format!("{name}-restored-{operation_id}"));
    no_links(&root)?;
    let output = root.join("vault");
    no_links(&output)?;
    if root.exists() {
        let journal: RestoreJournal = serde_json::from_slice(&read_limited(
            &root.join("operation.json"),
            MAX_MANIFEST_BYTES,
        )?)
        .map_err(bad)?;
        if journal.version != 1
            || journal.source != text(&vault)?
            || journal.backup_id != backup_id
            || journal.manifest_sha256 != hash
            || journal.operation_id != operation_id
        {
            return Err(err("backup_invalid"));
        }
        if journal.phase != "complete" || root.join("INCOMPLETE").exists() {
            return Err(err("backup_restore_incomplete"));
        }
        if journal.entries != expected_entries(&m, &journal.archived_sync)? {
            return Err(err("backup_invalid"));
        }
        if inventory(&output, false).map_err(bad)? != journal.entries {
            return Err(err("backup_restore_changed"));
        }
        return Ok(RestoredBackup {
            path: text(&output)?,
        });
    }
    // Select an unused archive name; never overwrite pre-existing user sidecars.
    let archive = loop {
        let candidate = format!(".amby/sync-before-restore-{}", ulid::Ulid::generate());
        if !m
            .entries
            .iter()
            .any(|e| e.path == candidate || e.path.starts_with(&format!("{candidate}/")))
        {
            break candidate;
        }
    };
    let expected = expected_entries(&m, &archive)?;
    let mut journal = RestoreJournal {
        version: 1,
        source: text(&vault)?,
        backup_id: backup_id.into(),
        manifest_sha256: hash,
        operation_id: operation_id.into(),
        phase: "copying".into(),
        archived_sync: archive.clone(),
        entries: expected.clone(),
    };
    private_dir(&root)?;
    let result = (|| {
        atomic_write_bytes_new(
            &root.join("INCOMPLETE"),
            b"Incomplete restore. Do not open the vault folder.",
        )
        .map_err(fail)?;
        write_journal(&root, &journal)?;
        private_dir(&output)?;
        for e in &m.entries {
            let from = backup.join("vault").join(&e.path);
            let to = output.join(mapped(&e.path, &archive));
            no_links(&from)?;
            no_links(&to)?;
            if e.directory {
                private_dir(&to)?;
            } else {
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent).map_err(fail)?;
                }
                atomic_copy_file_new(&from, &to, e.size).map_err(fail)?;
                if digest(&to)? != (e.size, e.sha256.clone()) {
                    return Err(err("backup_invalid"));
                }
            }
        }
        before_verify()?;
        if inventory(&output, false).map_err(bad)? != expected {
            return Err(err("backup_invalid"));
        }
        // Revalidate the immutable source after copying, including its manifest digest.
        if verified(&vault, backup_id)?.2 != journal.manifest_sha256 {
            return Err(err("backup_changed"));
        }
        for e in expected.iter().rev().filter(|e| e.directory) {
            sync_parent_directory(&output.join(&e.path)).map_err(fail)?;
        }
        sync_parent_directory(&output).map_err(fail)?;
        journal.phase = "complete".into();
        write_journal(&root, &journal)?;
        fs::remove_file(root.join("INCOMPLETE")).map_err(fail)?;
        sync_parent_directory(&root).map_err(fail)?;
        sync_parent_directory(&parent).map_err(fail)?;
        Ok(RestoredBackup {
            path: text(&output)?,
        })
    })();
    if result.is_err() && journal.phase != "complete" {
        journal.phase = "failed".into();
        let _ = write_journal(&root, &journal);
    }
    result
}

#[cfg(test)]
#[path = "backup_restore_tests.rs"]
mod tests;
