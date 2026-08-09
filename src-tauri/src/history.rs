use crate::frontmatter;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ulid::Ulid;

const HISTORY_DIR: &str = "history";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SnapshotMetadata {
    version: u8,
    id: String,
    source_path: String,
    created_at_ms: u64,
    reason: String,
    size_bytes: u64,
    /// Non-cryptographic integrity check for accidental disk corruption. This
    /// is deliberately stored with the snapshot, not inferred from its file
    /// name, so a damaged version can never be restored silently.
    #[serde(default)]
    content_hash: Option<String>,
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

fn content_hash(bytes: &[u8]) -> String {
    // FNV-1a is compact and stable across platforms. It is not a security
    // boundary; it detects accidental corruption before a restore operation.
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn validate_snapshot_bytes(metadata: &SnapshotMetadata, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != metadata.size_bytes {
        return Err(format!(
            "Historical version {} is incomplete (expected {} bytes, found {})",
            metadata.id,
            metadata.size_bytes,
            bytes.len()
        ));
    }
    if let Some(expected) = &metadata.content_hash {
        if content_hash(bytes) != *expected {
            return Err(format!(
                "Historical version {} failed its integrity check",
                metadata.id
            ));
        }
    }
    Ok(())
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
        version: 2,
        id: id.clone(),
        source_path,
        created_at_ms,
        reason: reason.to_string(),
        size_bytes: current.len() as u64,
        content_hash: Some(content_hash(&current)),
    };

    frontmatter::atomic_write_bytes(&snapshot_data_path(&root, &id), &current)?;
    frontmatter::atomic_write_bytes(
        &snapshot_meta_path(&root, &id),
        &serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
    )?;
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
    if metadata.id != id || !matches!(metadata.version, 1 | 2) {
        return Err("Invalid snapshot metadata".to_string());
    }
    let source = crate::paths::confine_rel(vault, &metadata.source_path)?;
    let bytes = fs::read(snapshot_data_path(&root, id)).map_err(|error| error.to_string())?;
    validate_snapshot_bytes(&metadata, &bytes)?;
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
    if metadata.id != id || !matches!(metadata.version, 1 | 2) {
        return Err("Invalid snapshot metadata".to_string());
    }
    let bytes = fs::read(snapshot_data_path(&root, id)).map_err(|error| error.to_string())?;
    validate_snapshot_bytes(&metadata, &bytes)?;
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

    #[test]
    fn rejects_a_corrupted_snapshot_before_restore() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "before").unwrap();
        let id = snapshot_before_write(&vault, &note, b"after", "note-save")
            .unwrap()
            .unwrap();
        let root = history_root(&vault);
        fs::write(snapshot_data_path(&root, &id), "damaged").unwrap();

        assert!(restore_snapshot(&vault, &id).is_err());
        assert_eq!(fs::read_to_string(&note).unwrap(), "before");
        fs::remove_dir_all(vault).unwrap();
    }
}
