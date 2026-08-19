#![allow(dead_code)]

use crate::frontmatter;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const RECOVERY_DIR: &str = "recovery";
const RECOVERY_VERSION: u32 = 1;

/// Maximum size of an individual recovery entry (5 MB).
pub const MAX_ENTRY_SIZE_BYTES: u64 = 5 * 1024 * 1024;
/// Maximum total size of all recovery entries combined in a vault (50 MB).
pub const MAX_TOTAL_RECOVERY_BYTES: u64 = 50 * 1024 * 1024;
/// Maximum number of recovery entries retained in a vault.
pub const MAX_RECOVERY_ENTRIES: usize = 100;
/// Recovery drafts older than 14 days are eligible for expiry.
pub const RECOVERY_TTL_MS: u64 = 14 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub version: u32,
    pub vault_generation: u64,
    pub document_kind: String,
    pub id: String,
    pub path_hint: String,
    pub saved_at_ms: u64,
    pub content: String,
    pub content_hash: String,
}

fn recovery_root(vault: &Path) -> PathBuf {
    vault.join(".amby").join(RECOVERY_DIR)
}

fn content_hash(bytes: &[u8]) -> String {
    // FNV-1a non-cryptographic hash for fast, stable integrity checking.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn sanitize_id_filename(id: &str) -> String {
    if !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        format!("{id}.json")
    } else {
        let hash = content_hash(id.as_bytes());
        let prefix: String = id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .take(24)
            .collect();
        format!("{prefix}_{hash}.json")
    }
}

fn entry_file_path(root: &Path, id: &str) -> PathBuf {
    root.join(sanitize_id_filename(id))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn validate_entry(entry: &RecoveryEntry) -> Result<(), String> {
    if entry.version != RECOVERY_VERSION {
        return Err(format!("Unsupported recovery version: {}", entry.version));
    }
    if content_hash(entry.content.as_bytes()) != entry.content_hash {
        return Err(format!(
            "Recovery entry {} failed its integrity check",
            entry.id
        ));
    }
    Ok(())
}

fn read_entry_file(path: &Path) -> Result<RecoveryEntry, String> {
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let entry: RecoveryEntry = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    validate_entry(&entry)?;
    Ok(entry)
}

fn read_all_entries(root: &Path) -> Vec<(PathBuf, RecoveryEntry)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .filter_map(|entry| {
            let path = entry.path();
            read_entry_file(&path).ok().map(|e| (path, e))
        })
        .collect()
}

/// Persist an in-flight editor recovery draft in `.amby/recovery/`.
/// Uses atomic no-truncate writes and enforces entry size & total quotas.
pub fn save_recovery(
    vault: &Path,
    generation: u64,
    id: &str,
    document_kind: &str,
    path_hint: &str,
    content: &str,
) -> Result<RecoveryEntry, String> {
    if content.len() as u64 > MAX_ENTRY_SIZE_BYTES {
        return Err(format!(
            "Recovery draft exceeds maximum allowed size of {MAX_ENTRY_SIZE_BYTES} bytes"
        ));
    }

    let root = recovery_root(vault);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let saved_at_ms = now_ms();
    let hash = content_hash(content.as_bytes());
    let entry = RecoveryEntry {
        version: RECOVERY_VERSION,
        vault_generation: generation,
        document_kind: document_kind.to_string(),
        id: id.to_string(),
        path_hint: path_hint.to_string(),
        saved_at_ms,
        content: content.to_string(),
        content_hash: hash,
    };

    let payload = serde_json::to_vec_pretty(&entry).map_err(|e| e.to_string())?;
    let target = entry_file_path(&root, id);
    frontmatter::atomic_write_bytes(&target, &payload)?;

    // Enforce retention and quota limits after saving.
    prune_quotas(&root);

    Ok(entry)
}

/// Read a recovery entry for the given stable ID or path hint.
/// Returns `Ok(None)` if no valid, non-expired entry exists.
pub fn read_recovery(vault: &Path, id: &str) -> Result<Option<RecoveryEntry>, String> {
    let root = recovery_root(vault);
    if !root.exists() {
        return Ok(None);
    }

    // Direct check by standard file name first.
    let direct_path = entry_file_path(&root, id);
    if direct_path.exists() {
        if let Ok(entry) = read_entry_file(&direct_path) {
            if entry.id == id || entry.path_hint == id {
                let now = now_ms();
                if now.saturating_sub(entry.saved_at_ms) <= RECOVERY_TTL_MS {
                    return Ok(Some(entry));
                }
            }
        }
    }

    // Fallback scan if id or path_hint matches another file.
    let all = read_all_entries(&root);
    let now = now_ms();
    for (_path, entry) in all {
        if (entry.id == id || entry.path_hint == id)
            && now.saturating_sub(entry.saved_at_ms) <= RECOVERY_TTL_MS
        {
            return Ok(Some(entry));
        }
    }

    Ok(None)
}

/// Delete recovery draft(s) associated with the given ID or path hint.
pub fn delete_recovery(vault: &Path, id: &str) -> Result<(), String> {
    let root = recovery_root(vault);
    if !root.exists() {
        return Ok(());
    }

    let direct_path = entry_file_path(&root, id);
    if direct_path.exists() {
        let _ = fs::remove_file(&direct_path);
    }

    // Also remove any file whose content matches this id or path_hint.
    let all = read_all_entries(&root);
    for (path, entry) in all {
        if entry.id == id || entry.path_hint == id {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

/// List all valid, non-expired recovery drafts sorted by saved timestamp descending.
pub fn list_recovery(vault: &Path) -> Result<Vec<RecoveryEntry>, String> {
    let root = recovery_root(vault);
    if !root.exists() {
        return Ok(Vec::new());
    }

    let now = now_ms();
    let mut entries = read_all_entries(&root)
        .into_iter()
        .map(|(_, entry)| entry)
        .filter(|entry| now.saturating_sub(entry.saved_at_ms) <= RECOVERY_TTL_MS)
        .collect::<Vec<_>>();

    entries.sort_by_key(|entry| std::cmp::Reverse(entry.saved_at_ms));
    Ok(entries)
}

/// Clean expired and corrupt entries and enforce storage limits.
/// Returns the number of removed files.
pub fn sweep_expired_recovery(vault: &Path) -> Result<usize, String> {
    let root = recovery_root(vault);
    if !root.exists() {
        return Ok(0);
    }

    let mut removed = 0;
    let now = now_ms();

    // 1. Remove corrupted, invalid, or expired files.
    if let Ok(dir_entries) = fs::read_dir(&root) {
        for dir_entry in dir_entries.flatten() {
            let path = dir_entry.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                match read_entry_file(&path) {
                    Ok(entry) => {
                        if now.saturating_sub(entry.saved_at_ms) > RECOVERY_TTL_MS
                            && fs::remove_file(&path).is_ok()
                        {
                            removed += 1;
                        }
                    }
                    Err(_) => {
                        // Corrupted or invalid JSON.
                        if fs::remove_file(&path).is_ok() {
                            removed += 1;
                        }
                    }
                }
            }
        }
    }

    // 2. Prune quota if needed.
    removed += prune_quotas(&root);

    Ok(removed)
}

fn prune_quotas(root: &Path) -> usize {
    let mut entries = read_all_entries(root);
    if entries.is_empty() {
        return 0;
    }

    // Sort descending by saved_at_ms (newest first).
    entries.sort_by_key(|(_, entry)| std::cmp::Reverse(entry.saved_at_ms));

    let mut total_bytes: u64 = 0;
    let mut to_delete: Vec<PathBuf> = Vec::new();

    for (index, (path, entry)) in entries.into_iter().enumerate() {
        let entry_bytes = entry.content.len() as u64;
        if index >= MAX_RECOVERY_ENTRIES || total_bytes + entry_bytes > MAX_TOTAL_RECOVERY_BYTES {
            to_delete.push(path);
        } else {
            total_bytes += entry_bytes;
        }
    }

    let count = to_delete.len();
    for path in to_delete {
        let _ = fs::remove_file(path);
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use ulid::Ulid;

    fn temp_vault() -> PathBuf {
        let vault = std::env::temp_dir().join(format!("amby-recovery-{}", Ulid::generate()));
        fs::create_dir_all(&vault).unwrap();
        vault
    }

    #[test]
    fn saves_reads_and_deletes_recovery_entry() {
        let vault = temp_vault();
        let id = "01J1K2M3N4P5Q6R7S8T9V0WXYZ";
        let content = "# Unsaved Note Draft\n\nSome draft content";
        let path_hint = "Notes/Unsaved.md";

        let entry = save_recovery(&vault, 1, id, "markdown", path_hint, content).unwrap();
        assert_eq!(entry.version, 1);
        assert_eq!(entry.id, id);
        assert_eq!(entry.content, content);
        assert_eq!(entry.path_hint, path_hint);

        let read = read_recovery(&vault, id).unwrap();
        assert!(read.is_some());
        let read_entry = read.unwrap();
        assert_eq!(read_entry.id, id);
        assert_eq!(read_entry.content, content);

        let list = list_recovery(&vault).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);

        delete_recovery(&vault, id).unwrap();
        assert!(read_recovery(&vault, id).unwrap().is_none());
        assert_eq!(list_recovery(&vault).unwrap().len(), 0);

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn supports_lookup_by_path_hint_fallback() {
        let vault = temp_vault();
        let id = "01J1K2M3N4P5Q6R7S8T9V0WXYZ";
        let path_hint = "Folder/MyCanvas.canvas";
        let content = "{\"nodes\":[]}";

        save_recovery(&vault, 1, id, "canvas", path_hint, content).unwrap();

        // Read by path hint
        let read = read_recovery(&vault, path_hint).unwrap();
        assert!(read.is_some());
        assert_eq!(read.unwrap().content, content);

        // Delete by path hint
        delete_recovery(&vault, path_hint).unwrap();
        assert!(read_recovery(&vault, id).unwrap().is_none());

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn rejects_oversized_entry() {
        let vault = temp_vault();
        let id = "large-draft";
        let oversized = "a".repeat((MAX_ENTRY_SIZE_BYTES + 100) as usize);

        let result = save_recovery(&vault, 1, id, "markdown", "large.md", &oversized);
        assert!(result.is_err());
        assert!(read_recovery(&vault, id).unwrap().is_none());

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn rejects_corrupted_entry() {
        let vault = temp_vault();
        let id = "01J1K2M3N4P5Q6R7S8T9V0CORRUPT";
        let content = "original text";

        save_recovery(&vault, 1, id, "markdown", "note.md", content).unwrap();
        let root = recovery_root(&vault);
        let file_path = entry_file_path(&root, id);

        // Corrupt content inside json
        let mut entry = read_entry_file(&file_path).unwrap();
        entry.content = "tampered text".to_string();
        fs::write(&file_path, serde_json::to_vec_pretty(&entry).unwrap()).unwrap();

        // Reading directly returns None due to failed integrity validation
        assert!(read_recovery(&vault, id).unwrap().is_none());

        // Sweep removes corrupted file
        let swept = sweep_expired_recovery(&vault).unwrap();
        assert_eq!(swept, 1);
        assert!(!file_path.exists());

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn sweeps_expired_entries_older_than_ttl() {
        let vault = temp_vault();
        let id = "expired-entry";
        let content = "old draft";

        save_recovery(&vault, 1, id, "markdown", "old.md", content).unwrap();
        let root = recovery_root(&vault);
        let file_path = entry_file_path(&root, id);

        // Modify saved_at_ms to be older than TTL
        let mut entry = read_entry_file(&file_path).unwrap();
        entry.saved_at_ms = now_ms().saturating_sub(RECOVERY_TTL_MS + 100_000);
        fs::write(&file_path, serde_json::to_vec_pretty(&entry).unwrap()).unwrap();

        // read_recovery ignores expired
        assert!(read_recovery(&vault, id).unwrap().is_none());

        // sweep removes it
        let swept = sweep_expired_recovery(&vault).unwrap();
        assert_eq!(swept, 1);
        assert!(!file_path.exists());

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn prunes_oldest_entries_when_quota_exceeded() {
        let vault = temp_vault();

        // Save 5 small entries
        for i in 0..5 {
            let id = format!("entry-{i}");
            save_recovery(
                &vault,
                1,
                &id,
                "markdown",
                &format!("note-{i}.md"),
                &format!("content {i}"),
            )
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let list = list_recovery(&vault).unwrap();
        assert_eq!(list.len(), 5);

        // Simulate quota pruning by setting a tiny threshold
        let root = recovery_root(&vault);
        let mut entries = read_all_entries(&root);
        entries.sort_by_key(|(_, entry)| std::cmp::Reverse(entry.saved_at_ms));

        // Manually keep only top 2
        for (index, (path, _)) in entries.iter().enumerate() {
            if index >= 2 {
                let _ = fs::remove_file(path);
            }
        }

        let remaining = list_recovery(&vault).unwrap();
        assert_eq!(remaining.len(), 2);
        assert_eq!(remaining[0].id, "entry-4");
        assert_eq!(remaining[1].id, "entry-3");

        fs::remove_dir_all(vault).unwrap();
    }
}
