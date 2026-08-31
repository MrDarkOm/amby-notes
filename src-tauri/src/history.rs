use crate::frontmatter;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use ulid::Ulid;

const HISTORY_DIR: &str = "history";
const MANIFEST_FILE: &str = "manifest.json";
const SNAPSHOT_JOURNAL_FILE: &str = "snapshot-journal.json";
const CLEANUP_JOURNAL_FILE: &str = "cleanup-journal.json";
const HISTORY_FORMAT_VERSION: u8 = 1;
const AUTOSAVE_SNAPSHOT_INTERVAL_MS: u64 = 10 * 60 * 1_000;

static HISTORY_LOCK: Mutex<()> = Mutex::new(());

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

#[derive(Clone, Debug, Deserialize, Serialize)]
struct HistoryManifest {
    version: u8,
    snapshots: Vec<SnapshotMetadata>,
}

impl Default for HistoryManifest {
    fn default() -> Self {
        Self {
            version: HISTORY_FORMAT_VERSION,
            snapshots: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CleanupJournal {
    version: u8,
    snapshot: SnapshotMetadata,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SnapshotWriteJournal {
    version: u8,
    snapshot: SnapshotMetadata,
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

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStats {
    pub snapshot_count: u64,
    pub note_count: u64,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRetention {
    pub max_snapshots_per_note: u32,
    pub max_age_days: Option<u32>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCleanupResult {
    pub removed_count: u64,
    pub freed_bytes: u64,
    pub remaining: HistoryStats,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCleanupPreview {
    pub removed_count: u64,
    pub freed_bytes: u64,
    pub remaining: HistoryStats,
}

pub struct PreparedSnapshotRestore {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
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

fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_FILE)
}

fn cleanup_journal_path(root: &Path) -> PathBuf {
    root.join(CLEANUP_JOURNAL_FILE)
}

fn snapshot_journal_path(root: &Path) -> PathBuf {
    root.join(SNAPSHOT_JOURNAL_FILE)
}

fn cleanup_staging_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!(".{id}.cleanup"))
}

fn snapshot_data_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.snapshot"))
}

#[cfg(test)]
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

fn read_legacy_metadata(root: &Path) -> Vec<SnapshotMetadata> {
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

fn history_lock() -> MutexGuard<'static, ()> {
    HISTORY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())
        .map(|duration| duration.as_millis() as u64)
}

fn validate_metadata(metadata: &SnapshotMetadata) -> Result<(), String> {
    metadata
        .id
        .parse::<Ulid>()
        .map_err(|_| "Invalid snapshot identifier in history manifest".to_string())?;
    if !matches!(metadata.version, 1 | 2) || metadata.source_path.is_empty() {
        return Err("Invalid snapshot metadata in history manifest".to_string());
    }
    Ok(())
}

fn validate_manifest(manifest: &HistoryManifest) -> Result<(), String> {
    if manifest.version != HISTORY_FORMAT_VERSION {
        return Err(format!(
            "Unsupported history manifest version {}",
            manifest.version
        ));
    }
    let mut ids = HashSet::new();
    for metadata in &manifest.snapshots {
        validate_metadata(metadata)?;
        if !ids.insert(&metadata.id) {
            return Err("Duplicate snapshot identifier in history manifest".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FAIL_MANIFEST_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn write_manifest(root: &Path, manifest: &HistoryManifest) -> Result<(), String> {
    validate_manifest(manifest)?;
    #[cfg(test)]
    if FAIL_MANIFEST_WRITE.with(|fail| fail.get()) {
        return Err("injected history manifest write failure".to_string());
    }
    frontmatter::atomic_write_bytes(
        &manifest_path(root),
        &serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?,
    )
}

fn read_or_migrate_manifest(root: &Path) -> Result<HistoryManifest, String> {
    match fs::read(manifest_path(root)) {
        Ok(raw) => {
            let manifest: HistoryManifest = serde_json::from_slice(&raw)
                .map_err(|error| format!("History manifest is corrupted: {error}"))?;
            validate_manifest(&manifest)?;
            Ok(manifest)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !root.exists() {
                return Ok(HistoryManifest::default());
            }
            // Versions written before DATA-01 stored one JSON document per
            // snapshot. Scan it once, then make subsequent reads O(1) with
            // respect to metadata files.
            let mut snapshots = read_legacy_metadata(root)
                .into_iter()
                .filter(|metadata| {
                    validate_metadata(metadata).is_ok()
                        && snapshot_data_path(root, &metadata.id).is_file()
                })
                .collect::<Vec<_>>();
            snapshots.sort_by_key(|snapshot| snapshot.created_at_ms);
            snapshots.dedup_by(|left, right| left.id == right.id);
            let manifest = HistoryManifest {
                version: HISTORY_FORMAT_VERSION,
                snapshots,
            };
            write_manifest(root, &manifest)?;
            Ok(manifest)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn recover_interrupted_cleanup(root: &Path, manifest: &HistoryManifest) -> Result<(), String> {
    let journal_path = cleanup_journal_path(root);
    let raw = match fs::read(&journal_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let journal: CleanupJournal = serde_json::from_slice(&raw)
        .map_err(|error| format!("History cleanup journal is corrupted: {error}"))?;
    if journal.version != HISTORY_FORMAT_VERSION {
        return Err("Unsupported history cleanup journal version".to_string());
    }
    validate_metadata(&journal.snapshot)?;

    let snapshot_path = snapshot_data_path(root, &journal.snapshot.id);
    let staging_path = cleanup_staging_path(root, &journal.snapshot.id);
    let retained = manifest
        .snapshots
        .iter()
        .any(|snapshot| snapshot.id == journal.snapshot.id);

    if retained {
        if staging_path.exists() && !snapshot_path.exists() {
            fs::rename(&staging_path, &snapshot_path).map_err(|error| error.to_string())?;
        } else if !staging_path.exists() && !snapshot_path.exists() {
            return Err(format!(
                "Interrupted history cleanup lost snapshot {}",
                journal.snapshot.id
            ));
        } else if staging_path.exists() {
            fs::remove_file(&staging_path).map_err(|error| error.to_string())?;
        }
    } else if staging_path.exists() {
        fs::remove_file(&staging_path).map_err(|error| error.to_string())?;
    }

    fs::remove_file(journal_path).map_err(|error| error.to_string())
}

fn recover_interrupted_snapshot_write(
    root: &Path,
    manifest: &HistoryManifest,
) -> Result<(), String> {
    let journal_path = snapshot_journal_path(root);
    let raw = match fs::read(&journal_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let journal: SnapshotWriteJournal = serde_json::from_slice(&raw)
        .map_err(|error| format!("History snapshot journal is corrupted: {error}"))?;
    if journal.version != HISTORY_FORMAT_VERSION {
        return Err("Unsupported history snapshot journal version".to_string());
    }
    validate_metadata(&journal.snapshot)?;
    let data_path = snapshot_data_path(root, &journal.snapshot.id);
    let committed = manifest
        .snapshots
        .iter()
        .any(|snapshot| snapshot.id == journal.snapshot.id);
    if committed {
        if !data_path.is_file() {
            return Err(format!(
                "Committed history snapshot {} is missing its data file",
                journal.snapshot.id
            ));
        }
    } else if data_path.exists() {
        fs::remove_file(&data_path).map_err(|error| error.to_string())?;
    }
    fs::remove_file(journal_path).map_err(|error| error.to_string())
}

fn load_manifest(root: &Path) -> Result<HistoryManifest, String> {
    let manifest = read_or_migrate_manifest(root)?;
    recover_interrupted_snapshot_write(root, &manifest)?;
    recover_interrupted_cleanup(root, &manifest)?;
    Ok(manifest)
}

fn history_stats(manifest: &HistoryManifest) -> HistoryStats {
    let notes = manifest
        .snapshots
        .iter()
        .map(|snapshot| snapshot.source_path.as_str())
        .collect::<HashSet<_>>();
    HistoryStats {
        snapshot_count: manifest.snapshots.len() as u64,
        note_count: notes.len() as u64,
        size_bytes: manifest
            .snapshots
            .iter()
            .map(|snapshot| snapshot.size_bytes)
            .sum(),
    }
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
    snapshot_before_write_at(vault, source, replacement, reason, now_ms()?)
}

fn is_autosave_snapshot(reason: &str) -> bool {
    matches!(reason, "note-save" | "file-save")
}

fn snapshot_before_write_at(
    vault: &Path,
    source: &Path,
    replacement: &[u8],
    reason: &str,
    created_at_ms: u64,
) -> Result<Option<String>, String> {
    let _lock = history_lock();
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
    let mut manifest = load_manifest(&root)?;

    // The source file and recovery draft remain frequent and durable. Only
    // history versions are coalesced: the first autosave in each ten-minute
    // rolling window preserves its pre-write bytes, while structural/refactor/
    // restore reasons always create an explicit recovery point. A future-dated
    // manifest entry must not suppress snapshots after a wall-clock rollback.
    if is_autosave_snapshot(reason)
        && manifest.snapshots.iter().rev().any(|snapshot| {
            snapshot.source_path == source_path
                && is_autosave_snapshot(&snapshot.reason)
                && snapshot.created_at_ms <= created_at_ms
                && created_at_ms.saturating_sub(snapshot.created_at_ms)
                    < AUTOSAVE_SNAPSHOT_INTERVAL_MS
        })
    {
        return Ok(None);
    }

    let id = Ulid::generate().to_string();
    let metadata = SnapshotMetadata {
        version: 2,
        id: id.clone(),
        source_path,
        created_at_ms,
        reason: reason.to_string(),
        size_bytes: current.len() as u64,
        content_hash: Some(content_hash(&current)),
    };

    let data_path = snapshot_data_path(&root, &id);
    frontmatter::atomic_write_bytes(
        &snapshot_journal_path(&root),
        &serde_json::to_vec_pretty(&SnapshotWriteJournal {
            version: HISTORY_FORMAT_VERSION,
            snapshot: metadata.clone(),
        })
        .map_err(|error| error.to_string())?,
    )?;
    if let Err(error) = frontmatter::atomic_write_bytes(&data_path, &current) {
        let cleanup = fs::remove_file(snapshot_journal_path(&root));
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "History snapshot write failed ({error}); recovery journal cleanup failed: {cleanup_error}"
            )),
        };
    }
    manifest.snapshots.push(metadata);
    if let Err(error) = write_manifest(&root, &manifest) {
        // The write journal keeps data-only publication recoverable even if
        // storage refuses cleanup after a quota or I/O failure.
        return match recover_interrupted_snapshot_write(&root, &load_manifest(&root)?) {
            Ok(()) => Err(error),
            Err(recovery_error) => Err(format!(
                "History manifest update failed ({error}); snapshot recovery is pending: {recovery_error}"
            )),
        };
    }
    // A committed snapshot can survive a stale journal; next open simply
    // removes it. Returning an error makes that otherwise invisible I/O fault
    // observable without making the snapshot unavailable.
    fs::remove_file(snapshot_journal_path(&root)).map_err(|error| error.to_string())?;
    Ok(Some(id))
}

pub fn list_snapshots(vault: &Path, source: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let _lock = history_lock();
    let relative = source_relative(vault, source)?;
    let mut snapshots = load_manifest(&history_root(vault))?
        .snapshots
        .into_iter()
        .filter(|snapshot| snapshot.source_path == relative)
        .map(SnapshotEntry::from)
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.created_at_ms));
    Ok(snapshots)
}

pub fn get_history_stats(vault: &Path) -> Result<HistoryStats, String> {
    let _lock = history_lock();
    Ok(history_stats(&load_manifest(&history_root(vault))?))
}

fn should_remove_snapshot(
    snapshot: &SnapshotMetadata,
    retained_for_source: u32,
    retention: &HistoryRetention,
    now: u64,
) -> bool {
    if retained_for_source >= retention.max_snapshots_per_note {
        return true;
    }
    retention.max_age_days.is_some_and(|days| {
        snapshot
            .created_at_ms
            .saturating_add(u64::from(days) * 86_400_000)
            < now
    })
}

fn cleanup_snapshot(
    root: &Path,
    manifest: &mut HistoryManifest,
    snapshot: &SnapshotMetadata,
) -> Result<(), String> {
    let data_path = snapshot_data_path(root, &snapshot.id);
    if !data_path.is_file() {
        return Err(format!(
            "History snapshot {} is missing its data file",
            snapshot.id
        ));
    }

    let journal = CleanupJournal {
        version: HISTORY_FORMAT_VERSION,
        snapshot: snapshot.clone(),
    };
    frontmatter::atomic_write_bytes(
        &cleanup_journal_path(root),
        &serde_json::to_vec_pretty(&journal).map_err(|error| error.to_string())?,
    )?;

    let staging_path = cleanup_staging_path(root, &snapshot.id);
    if let Err(error) = fs::rename(&data_path, &staging_path) {
        let _ = fs::remove_file(cleanup_journal_path(root));
        return Err(error.to_string());
    }

    let before = manifest.clone();
    manifest.snapshots.retain(|entry| entry.id != snapshot.id);
    if let Err(error) = write_manifest(root, manifest) {
        *manifest = before;
        let rollback = fs::rename(&staging_path, &data_path);
        return match rollback {
            Ok(()) => {
                let _ = fs::remove_file(cleanup_journal_path(root));
                Err(error)
            }
            Err(rollback_error) => Err(format!(
                "History cleanup manifest update failed ({error}); rollback failed: {rollback_error}. Recovery journal was preserved."
            )),
        };
    }

    if let Err(error) = fs::remove_file(&staging_path) {
        // The manifest has committed, but the journal makes this recoverable:
        // the next history operation will remove the staged, unreferenced data.
        return Err(format!(
            "History cleanup committed metadata but could not remove staged snapshot: {error}"
        ));
    }
    fs::remove_file(cleanup_journal_path(root)).map_err(|error| error.to_string())
}

fn cleanup_candidates(
    manifest: &HistoryManifest,
    retention: &HistoryRetention,
    now: u64,
) -> Vec<SnapshotMetadata> {
    let mut sorted = manifest.snapshots.clone();
    sorted.sort_by(|left, right| {
        left.source_path
            .cmp(&right.source_path)
            .then_with(|| right.created_at_ms.cmp(&left.created_at_ms))
    });

    let mut retained = BTreeMap::<String, u32>::new();
    let mut remove = Vec::new();
    for snapshot in sorted {
        let count = retained.entry(snapshot.source_path.clone()).or_default();
        if should_remove_snapshot(&snapshot, *count, retention, now) {
            remove.push(snapshot);
        } else {
            *count += 1;
        }
    }
    remove
}

fn cleanup_preview(
    manifest: &HistoryManifest,
    remove: &[SnapshotMetadata],
) -> HistoryCleanupPreview {
    let removed_ids = remove
        .iter()
        .map(|snapshot| snapshot.id.as_str())
        .collect::<HashSet<_>>();
    let remaining = HistoryManifest {
        version: manifest.version,
        snapshots: manifest
            .snapshots
            .iter()
            .filter(|snapshot| !removed_ids.contains(snapshot.id.as_str()))
            .cloned()
            .collect(),
    };
    HistoryCleanupPreview {
        removed_count: remove.len() as u64,
        freed_bytes: remove.iter().map(|snapshot| snapshot.size_bytes).sum(),
        remaining: history_stats(&remaining),
    }
}

pub fn preview_history_cleanup(
    vault: &Path,
    retention: HistoryRetention,
) -> Result<HistoryCleanupPreview, String> {
    let _lock = history_lock();
    let manifest = load_manifest(&history_root(vault))?;
    let remove = cleanup_candidates(&manifest, &retention, now_ms()?);
    Ok(cleanup_preview(&manifest, &remove))
}

pub fn cleanup_history(
    vault: &Path,
    retention: HistoryRetention,
) -> Result<HistoryCleanupResult, String> {
    let _lock = history_lock();
    let root = history_root(vault);
    let mut manifest = load_manifest(&root)?;
    let remove = cleanup_candidates(&manifest, &retention, now_ms()?);

    let mut freed_bytes = 0_u64;
    for snapshot in &remove {
        cleanup_snapshot(&root, &mut manifest, snapshot)?;
        freed_bytes = freed_bytes.saturating_add(snapshot.size_bytes);
    }
    Ok(HistoryCleanupResult {
        removed_count: remove.len() as u64,
        freed_bytes,
        remaining: history_stats(&manifest),
    })
}

/// Restore a snapshot as a new file operation. The current version is first
/// snapshotted too, so users can undo a restore by restoring that newer entry.
pub fn prepare_snapshot_restore(vault: &Path, id: &str) -> Result<PreparedSnapshotRestore, String> {
    let _lock = history_lock();
    id.parse::<Ulid>()
        .map_err(|_| "Invalid snapshot identifier".to_string())?;
    let root = history_root(vault);
    let metadata = load_manifest(&root)?
        .snapshots
        .into_iter()
        .find(|snapshot| snapshot.id == id)
        .ok_or_else(|| "Snapshot is not present in the history manifest".to_string())?;
    if metadata.id != id || !matches!(metadata.version, 1 | 2) {
        return Err("Invalid snapshot metadata".to_string());
    }
    let source = crate::paths::confine_rel(vault, &metadata.source_path)?;
    let bytes = fs::read(snapshot_data_path(&root, id)).map_err(|error| error.to_string())?;
    validate_snapshot_bytes(&metadata, &bytes)?;
    Ok(PreparedSnapshotRestore {
        path: source,
        bytes,
    })
}

pub fn commit_snapshot_restore(
    vault: &Path,
    prepared: PreparedSnapshotRestore,
) -> Result<PathBuf, String> {
    snapshot_before_write(vault, &prepared.path, &prepared.bytes, "restore")?;
    frontmatter::atomic_write_bytes(&prepared.path, &prepared.bytes)?;
    Ok(prepared.path)
}

#[cfg(test)]
pub fn restore_snapshot(vault: &Path, id: &str) -> Result<PathBuf, String> {
    let prepared = prepare_snapshot_restore(vault, id)?;
    commit_snapshot_restore(vault, prepared)
}

/// Load a UTF-8 snapshot for the history comparison UI. Binary snapshots stay
/// preserved byte-for-byte on disk, but are intentionally not rendered as text.
pub fn read_snapshot_text(vault: &Path, id: &str) -> Result<SnapshotText, String> {
    let _lock = history_lock();
    id.parse::<Ulid>()
        .map_err(|_| "Invalid snapshot identifier".to_string())?;
    let root = history_root(vault);
    let metadata = load_manifest(&root)?
        .snapshots
        .into_iter()
        .find(|snapshot| snapshot.id == id)
        .ok_or_else(|| "Snapshot is not present in the history manifest".to_string())?;
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
    fn coalesces_rapid_autosave_history_without_delaying_file_writes() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "initial").unwrap();

        assert!(snapshot_before_write(&vault, &note, b"first", "note-save")
            .unwrap()
            .is_some());
        fs::write(&note, "first").unwrap();
        assert!(snapshot_before_write(&vault, &note, b"second", "note-save")
            .unwrap()
            .is_none());
        fs::write(&note, "second").unwrap();

        assert_eq!(fs::read_to_string(&note).unwrap(), "second");
        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 1);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn autosave_history_opens_a_new_bucket_after_ten_minutes() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        let started_at = 1_000_000;
        fs::write(&note, "initial").unwrap();

        assert!(
            snapshot_before_write_at(&vault, &note, b"first", "note-save", started_at,)
                .unwrap()
                .is_some()
        );
        fs::write(&note, "first").unwrap();
        assert!(snapshot_before_write_at(
            &vault,
            &note,
            b"second",
            "note-save",
            started_at + AUTOSAVE_SNAPSHOT_INTERVAL_MS - 1,
        )
        .unwrap()
        .is_none());
        fs::write(&note, "second").unwrap();
        assert!(snapshot_before_write_at(
            &vault,
            &note,
            b"third",
            "note-save",
            started_at + AUTOSAVE_SNAPSHOT_INTERVAL_MS,
        )
        .unwrap()
        .is_some());

        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 2);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn future_dated_autosave_does_not_suppress_history_after_clock_rollback() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        let current_time = 1_000_000;
        fs::write(&note, "initial").unwrap();

        snapshot_before_write_at(
            &vault,
            &note,
            b"future",
            "note-save",
            current_time + AUTOSAVE_SNAPSHOT_INTERVAL_MS,
        )
        .unwrap()
        .unwrap();
        fs::write(&note, "future").unwrap();

        assert!(snapshot_before_write_at(
            &vault,
            &note,
            b"after rollback",
            "note-save",
            current_time,
        )
        .unwrap()
        .is_some());
        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 2);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn forced_history_reasons_are_never_coalesced_with_autosave() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "initial").unwrap();

        snapshot_before_write_at(&vault, &note, b"first", "note-save", 10)
            .unwrap()
            .unwrap();
        fs::write(&note, "first").unwrap();
        snapshot_before_write_at(&vault, &note, b"refactored", "link-refactor", 11)
            .unwrap()
            .unwrap();

        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 2);
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

    #[test]
    fn migrates_legacy_metadata_once_then_reads_the_manifest() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "current").unwrap();
        let root = history_root(&vault);
        fs::create_dir_all(&root).unwrap();
        let id = Ulid::generate().to_string();
        let bytes = b"legacy";
        let metadata = SnapshotMetadata {
            version: 2,
            id: id.clone(),
            source_path: source_relative(&vault, &note).unwrap(),
            created_at_ms: 1,
            reason: "legacy-save".to_string(),
            size_bytes: bytes.len() as u64,
            content_hash: Some(content_hash(bytes)),
        };
        fs::write(snapshot_data_path(&root, &id), bytes).unwrap();
        fs::write(
            snapshot_meta_path(&root, &id),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();

        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 1);
        assert!(manifest_path(&root).is_file());
        fs::remove_file(snapshot_meta_path(&root, &id)).unwrap();
        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 1);
        assert_eq!(
            get_history_stats(&vault).unwrap().size_bytes,
            bytes.len() as u64
        );
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn manifest_write_failure_rolls_back_the_new_snapshot_data() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "before").unwrap();
        snapshot_before_write(&vault, &note, b"after", "save").unwrap();
        fs::write(&note, "after").unwrap();

        FAIL_MANIFEST_WRITE.with(|fail| fail.set(true));
        let result = snapshot_before_write(&vault, &note, b"later", "save");
        FAIL_MANIFEST_WRITE.with(|fail| fail.set(false));

        assert!(result.is_err());
        let stats = get_history_stats(&vault).unwrap();
        assert_eq!(stats.snapshot_count, 1);
        let root = history_root(&vault);
        assert_eq!(
            fs::read_dir(root)
                .unwrap()
                .flatten()
                .filter(|entry| entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "snapshot"))
                .count(),
            1
        );
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn interrupted_cleanup_is_recovered_before_history_is_read() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "before").unwrap();
        let id = snapshot_before_write(&vault, &note, b"after", "save")
            .unwrap()
            .unwrap();
        let root = history_root(&vault);
        let manifest = load_manifest(&root).unwrap();
        let snapshot = manifest
            .snapshots
            .iter()
            .find(|snapshot| snapshot.id == id)
            .unwrap()
            .clone();
        frontmatter::atomic_write_bytes(
            &cleanup_journal_path(&root),
            &serde_json::to_vec_pretty(&CleanupJournal {
                version: HISTORY_FORMAT_VERSION,
                snapshot,
            })
            .unwrap(),
        )
        .unwrap();
        fs::rename(
            snapshot_data_path(&root, &id),
            cleanup_staging_path(&root, &id),
        )
        .unwrap();

        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 1);
        assert!(snapshot_data_path(&root, &id).is_file());
        assert!(!cleanup_journal_path(&root).exists());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn interrupted_snapshot_publication_removes_uncommitted_data() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "current").unwrap();
        let root = history_root(&vault);
        fs::create_dir_all(&root).unwrap();
        write_manifest(&root, &HistoryManifest::default()).unwrap();
        let id = Ulid::generate().to_string();
        let bytes = b"uncommitted";
        let snapshot = SnapshotMetadata {
            version: 2,
            id: id.clone(),
            source_path: source_relative(&vault, &note).unwrap(),
            created_at_ms: now_ms().unwrap(),
            reason: "save".to_string(),
            size_bytes: bytes.len() as u64,
            content_hash: Some(content_hash(bytes)),
        };
        frontmatter::atomic_write_bytes(
            &snapshot_journal_path(&root),
            &serde_json::to_vec_pretty(&SnapshotWriteJournal {
                version: HISTORY_FORMAT_VERSION,
                snapshot,
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(snapshot_data_path(&root, &id), bytes).unwrap();

        assert!(list_snapshots(&vault, &note).unwrap().is_empty());
        assert!(!snapshot_data_path(&root, &id).exists());
        assert!(!snapshot_journal_path(&root).exists());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn cleanup_keeps_the_requested_number_of_versions_and_updates_stats() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "one").unwrap();
        snapshot_before_write(&vault, &note, b"two", "save").unwrap();
        fs::write(&note, "two").unwrap();
        snapshot_before_write(&vault, &note, b"three", "save").unwrap();
        fs::write(&note, "three").unwrap();
        snapshot_before_write(&vault, &note, b"four", "save").unwrap();

        let retention = HistoryRetention {
            max_snapshots_per_note: 1,
            max_age_days: None,
        };
        let preview = preview_history_cleanup(&vault, retention.clone()).unwrap();
        assert_eq!(preview.removed_count, 2);
        assert!(preview.freed_bytes > 0);
        assert_eq!(preview.remaining.snapshot_count, 1);
        let result = cleanup_history(&vault, retention).unwrap();

        assert_eq!(result.removed_count, 2);
        assert_eq!(result.remaining.snapshot_count, 1);
        assert_eq!(result.remaining.note_count, 1);
        assert_eq!(list_snapshots(&vault, &note).unwrap().len(), 1);
        assert!(!cleanup_journal_path(&history_root(&vault)).exists());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn cleanup_removes_only_versions_older_than_the_requested_age() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "one").unwrap();
        let old_id = snapshot_before_write(&vault, &note, b"two", "save")
            .unwrap()
            .unwrap();
        fs::write(&note, "two").unwrap();
        let recent_id = snapshot_before_write(&vault, &note, b"three", "save")
            .unwrap()
            .unwrap();

        let root = history_root(&vault);
        let mut manifest = load_manifest(&root).unwrap();
        let now = now_ms().unwrap();
        manifest
            .snapshots
            .iter_mut()
            .find(|snapshot| snapshot.id == old_id)
            .unwrap()
            .created_at_ms = now.saturating_sub(31 * 86_400_000);
        write_manifest(&root, &manifest).unwrap();

        let retention = HistoryRetention {
            max_snapshots_per_note: 10,
            max_age_days: Some(30),
        };
        let preview = preview_history_cleanup(&vault, retention.clone()).unwrap();
        assert_eq!(preview.removed_count, 1);
        assert_eq!(preview.remaining.snapshot_count, 1);

        let result = cleanup_history(&vault, retention).unwrap();
        assert_eq!(result.removed_count, 1);
        assert_eq!(result.remaining.snapshot_count, 1);
        assert!(!snapshot_data_path(&root, &old_id).exists());
        assert!(snapshot_data_path(&root, &recent_id).is_file());
        assert_eq!(list_snapshots(&vault, &note).unwrap()[0].id, recent_id);
        assert!(!cleanup_journal_path(&root).exists());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn cleanup_refuses_to_hide_a_manifest_entry_with_missing_data() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "before").unwrap();
        let id = snapshot_before_write(&vault, &note, b"after", "save")
            .unwrap()
            .unwrap();
        fs::remove_file(snapshot_data_path(&history_root(&vault), &id)).unwrap();

        assert!(cleanup_history(
            &vault,
            HistoryRetention {
                max_snapshots_per_note: 0,
                max_age_days: None,
            },
        )
        .is_err());
        assert_eq!(get_history_stats(&vault).unwrap().snapshot_count, 1);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn cleanup_manifest_failure_restores_the_snapshot_and_keeps_metadata() {
        let vault = temp_vault();
        let note = vault.join("Note.md");
        fs::write(&note, "before").unwrap();
        let id = snapshot_before_write(&vault, &note, b"after", "save")
            .unwrap()
            .unwrap();
        let root = history_root(&vault);

        FAIL_MANIFEST_WRITE.with(|fail| fail.set(true));
        let result = cleanup_history(
            &vault,
            HistoryRetention {
                max_snapshots_per_note: 0,
                max_age_days: None,
            },
        );
        FAIL_MANIFEST_WRITE.with(|fail| fail.set(false));

        assert!(result.is_err());
        assert!(snapshot_data_path(&root, &id).is_file());
        assert_eq!(get_history_stats(&vault).unwrap().snapshot_count, 1);
        assert!(!cleanup_journal_path(&root).exists());
        fs::remove_dir_all(vault).unwrap();
    }
}
