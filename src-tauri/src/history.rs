use crate::frontmatter;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ulid::Ulid;

const HISTORY_DIR: &str = "history";
const MAX_SNAPSHOTS_PER_FILE: usize = 30;
const MAX_TOTAL_SNAPSHOT_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SnapshotMetadata {
    version: u8,
    id: String,
    source_path: String,
    created_at_ms: u64,
    reason: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub id: String,
    pub created_at_ms: u64,
    pub reason: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotText {
    pub source_path: String,
    pub content: String,
}

impl From<SnapshotMetadata> for SnapshotEntry {
    fn from(snapshot: SnapshotMetadata) -> Self {
        Self {
            id: snapshot.id,
            created_at_ms: snapshot.created_at_ms,
            reason: snapshot.reason,
            size_bytes: snapshot.size_bytes,
        }
    }
}

fn history_root(vault: &Path) -> PathBuf {
    vault.join(".amby").join(HISTORY_DIR)
}

fn snapshot_data_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.snapshot"))
}

fn snapshot_meta_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}

fn source_relative(vault: &Path, source: &Path) -> Result<String, String> {
    let vault_real = vault.canonicalize().map_err(|error| error.to_string())?;
    let source_real = source.canonicalize().map_err(|error| error.to_string())?;
    source_real
        .strip_prefix(vault_real)
        .map_err(|_| format!("Snapshot path is outside the vault: {}", source.display()))
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn read_metadata(root: &Path) -> Vec<SnapshotMetadata> {
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
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|raw| serde_json::from_slice::<SnapshotMetadata>(&raw).ok())
        .collect()
}

fn prune(root: &Path) {
    let mut snapshots = read_metadata(root);
    snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.created_at_ms));

    let mut total_bytes = 0_u64;
    let mut versions_per_file = std::collections::HashMap::<String, usize>::new();
    for snapshot in snapshots {
        let versions = versions_per_file
            .entry(snapshot.source_path.clone())
            .or_default();
        let should_remove = *versions >= MAX_SNAPSHOTS_PER_FILE
            || total_bytes.saturating_add(snapshot.size_bytes) > MAX_TOTAL_SNAPSHOT_BYTES;
        if should_remove {
            let _ = fs::remove_file(snapshot_data_path(root, &snapshot.id));
            let _ = fs::remove_file(snapshot_meta_path(root, &snapshot.id));
        } else {
            *versions += 1;
            total_bytes = total_bytes.saturating_add(snapshot.size_bytes);
        }
    }
}

/// Store the pre-write bytes of an existing vault file. Snapshots use opaque
/// bytes so a later restore is byte-exact, including any BOM or line endings.
/// Returns `Ok(None)` when the file is new or already contains the replacement.
pub fn snapshot_before_write(
    vault: &Path,
    source: &Path,
    replacement: &[u8],
    reason: &str,
) -> Result<Option<String>, String> {
    let current = match fs::read(source) {
        Ok(current) => current,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if current == replacement {
        return Ok(None);
    }
    let source_path = source_relative(vault, source)?;
    let root = history_root(vault);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;

    let id = Ulid::generate().to_string();
    let created_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let metadata = SnapshotMetadata {
        version: 1,
        id: id.clone(),
        source_path,
        created_at_ms,
        reason: reason.to_string(),
        size_bytes: current.len() as u64,
    };

    frontmatter::atomic_write_bytes(&snapshot_data_path(&root, &id), &current)?;
    frontmatter::atomic_write_bytes(
        &snapshot_meta_path(&root, &id),
        &serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
    )?;
    prune(&root);
    Ok(Some(id))
}

pub fn list_snapshots(vault: &Path, source: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let relative = source_relative(vault, source)?;
    let mut snapshots = read_metadata(&history_root(vault))
        .into_iter()
        .filter(|snapshot| snapshot.source_path == relative)
        .map(SnapshotEntry::from)
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.created_at_ms));
    Ok(snapshots)
}

/// Restore a snapshot as a new file operation. The current version is first
/// snapshotted too, so users can undo a restore by restoring that newer entry.
pub fn restore_snapshot(vault: &Path, id: &str) -> Result<PathBuf, String> {
    id.parse::<Ulid>()
        .map_err(|_| "Invalid snapshot identifier".to_string())?;
    let root = history_root(vault);
    let metadata: SnapshotMetadata = serde_json::from_slice(
        &fs::read(snapshot_meta_path(&root, id)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if metadata.id != id || metadata.version != 1 {
        return Err("Invalid snapshot metadata".to_string());
    }
    let source = crate::paths::confine_rel(vault, &metadata.source_path)?;
    let bytes = fs::read(snapshot_data_path(&root, id)).map_err(|error| error.to_string())?;
    snapshot_before_write(vault, &source, &bytes, "restore")?;
    frontmatter::atomic_write_bytes(&source, &bytes)?;
    Ok(source)
}

/// Load a UTF-8 snapshot for the history comparison UI. Binary snapshots stay
/// preserved byte-for-byte on disk, but are intentionally not rendered as text.
pub fn read_snapshot_text(vault: &Path, id: &str) -> Result<SnapshotText, String> {
    id.parse::<Ulid>()
        .map_err(|_| "Invalid snapshot identifier".to_string())?;
    let root = history_root(vault);
    let metadata: SnapshotMetadata = serde_json::from_slice(
        &fs::read(snapshot_meta_path(&root, id)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if metadata.id != id || metadata.version != 1 {
        return Err("Invalid snapshot metadata".to_string());
    }
    let bytes = fs::read(snapshot_data_path(&root, id)).map_err(|error| error.to_string())?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "This historical version is not UTF-8 text".to_string())?;
    Ok(SnapshotText {
        source_path: metadata.source_path,
        content,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> PathBuf {
        let vault = std::env::temp_dir().join(format!("amby-history-{}", Ulid::generate()));
        fs::create_dir_all(&vault).unwrap();
        vault
    }

    #[test]
    fn snapshots_original_bytes_and_skips_noop_writes() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, b"\xEF\xBB\xBFbefore\r\n").unwrap();

        let id = snapshot_before_write(&vault, &note, b"after\n", "note-save")
            .unwrap()
            .unwrap();
        let root = history_root(&vault);
        assert_eq!(
            fs::read(snapshot_data_path(&root, &id)).unwrap(),
            b"\xEF\xBB\xBFbefore\r\n"
        );
        assert!(
            snapshot_before_write(&vault, &note, b"\xEF\xBB\xBFbefore\r\n", "note-save")
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn restores_a_snapshot_and_snapshots_the_replaced_version() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "before").unwrap();
        let id = snapshot_before_write(&vault, &note, b"after", "note-save")
            .unwrap()
            .unwrap();
        fs::write(&note, "after").unwrap();

        restore_snapshot(&vault, &id).unwrap();

        assert_eq!(fs::read_to_string(&note).unwrap(), "before");
        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 2);
        fs::remove_dir_all(vault).unwrap();
    }
}
