use std::collections::{hash_map::DefaultHasher, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a precise self-write fingerprint remains available to reconcile
/// delayed notify events. It is never a time-only suppression rule: the
/// current filesystem fingerprint must still exactly match the record.
pub const SELF_WRITE_RECORD_TTL: Duration = Duration::from_secs(8);

/// Payload emitted to the frontend when an external file-system change is
/// detected in the vault (creates, modifies, deletes).
#[derive(serde::Serialize, Clone)]
pub struct VaultFileChangedPayload {
    pub kind: String, // "create" | "modify" | "remove" | "rename"
    pub path: String,
}

pub fn watched_event_kind(kind: &notify::EventKind) -> Option<&'static str> {
    match kind {
        notify::EventKind::Create(_) => Some("create"),
        notify::EventKind::Modify(notify::event::ModifyKind::Data(_)) => Some("modify"),
        notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => Some("rename"),
        notify::EventKind::Remove(_) => Some("remove"),
        _ => None,
    }
}

pub fn is_amby_temporary_file(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().contains(".amby-tmp-"))
}

/// Manages the active `notify` watcher for the open vault. Stored in
/// `tauri::State` so it lives for the whole app lifetime.
pub struct WatcherState {
    /// The active watcher (dropped → OS unregisters the watch).
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Exact results of our own filesystem writes. Parent directories are not
    /// recorded: a sibling file change must never be hidden by a broad marker.
    pub own_writes: Arc<Mutex<HashMap<PathBuf, SelfWriteRecord>>>,
    /// The active watcher's vault generation. A callback from a dropped prior
    /// watcher is ignored even if the OS delivers it late.
    pub active_generation: Arc<AtomicU64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelfWriteOperation {
    Write,
    Create,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathFingerprint {
    File { size: u64, content_hash: u64 },
    Directory,
    Missing,
    Unavailable,
}

#[derive(Clone, Debug)]
pub struct SelfWriteRecord {
    pub operation: SelfWriteOperation,
    pub expected: PathFingerprint,
    pub recorded_at: Instant,
    pub expires_at: Instant,
    pub generation: u64,
}

pub fn path_fingerprint(path: &Path) -> PathFingerprint {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return PathFingerprint::Missing
        }
        Err(_) => return PathFingerprint::Unavailable,
    };
    if metadata.is_dir() {
        return PathFingerprint::Directory;
    }
    if !metadata.is_file() {
        return PathFingerprint::Unavailable;
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return PathFingerprint::Unavailable,
    };
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    PathFingerprint::File {
        size: metadata.len(),
        content_hash: hasher.finish(),
    }
}

pub fn operation_for_fingerprint(fingerprint: &PathFingerprint) -> SelfWriteOperation {
    match fingerprint {
        PathFingerprint::Missing => SelfWriteOperation::Delete,
        PathFingerprint::Directory => SelfWriteOperation::Create,
        PathFingerprint::File { .. } | PathFingerprint::Unavailable => SelfWriteOperation::Write,
    }
}

pub fn event_matches_operation(kind: &str, record: &SelfWriteRecord) -> bool {
    match kind {
        "rename" => matches!(
            record.operation,
            SelfWriteOperation::Create | SelfWriteOperation::Delete | SelfWriteOperation::Write
        ),
        "remove" => matches!(record.operation, SelfWriteOperation::Delete),
        "create" => matches!(
            record.operation,
            SelfWriteOperation::Create | SelfWriteOperation::Write
        ),
        "modify" => matches!(
            record.operation,
            SelfWriteOperation::Write | SelfWriteOperation::Create
        ),
        _ => false,
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watcher: Mutex::new(None),
            own_writes: Arc::new(Mutex::new(HashMap::new())),
            active_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Record a completed write's exact on-disk result. Callers invoke this
    /// after the filesystem operation succeeds, never as a speculative marker.
    pub fn mark_write<I, P>(&self, paths: I)
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let mut guard = self.own_writes.lock().unwrap();
        let now = Instant::now();
        let generation = self.active_generation.load(Ordering::Acquire);
        for p in paths {
            let path = p.as_ref().to_path_buf();
            let expected = path_fingerprint(&path);
            guard.insert(
                path,
                SelfWriteRecord {
                    operation: operation_for_fingerprint(&expected),
                    expected,
                    recorded_at: now,
                    expires_at: now + SELF_WRITE_RECORD_TTL,
                    generation,
                },
            );
        }
        guard.retain(|_, record| record.expires_at > now);
    }
}

pub fn reconcile_self_write(
    own_writes: &Mutex<HashMap<PathBuf, SelfWriteRecord>>,
    path: &Path,
    kind: &str,
    generation: u64,
) -> bool {
    let now = Instant::now();
    let mut guard = own_writes.lock().unwrap();
    let Some(record) = guard.get(path).cloned() else {
        return false;
    };
    let age = now.saturating_duration_since(record.recorded_at);
    if record.generation != generation || record.expires_at <= now || age >= SELF_WRITE_RECORD_TTL {
        let _ = path_fingerprint(path);
        guard.remove(path);
        return false;
    }
    event_matches_operation(kind, &record) && path_fingerprint(path) == record.expected
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("amby-watcher-{name}-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn own_write_with_matching_fingerprint_is_suppressed() {
        let vault = temp_vault("own-write");
        let note = vault.join("Note.md");
        fs::write(&note, "own content").unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&note]);

        assert!(reconcile_self_write(&state.own_writes, &note, "modify", 1));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn external_write_inside_the_old_grace_window_is_emitted() {
        let vault = temp_vault("external-write");
        let note = vault.join("Note.md");
        fs::write(&note, "own content").unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&note]);
        fs::write(&note, "external content").unwrap();

        assert!(!reconcile_self_write(&state.own_writes, &note, "modify", 1));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn sibling_change_is_not_suppressed_by_a_self_write() {
        let vault = temp_vault("sibling");
        let own = vault.join("Own.md");
        let sibling = vault.join("Sibling.md");
        fs::write(&own, "own").unwrap();
        fs::write(&sibling, "external").unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&own]);

        assert!(!reconcile_self_write(
            &state.own_writes,
            &sibling,
            "modify",
            1
        ));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn atomic_rename_reconciles_old_and_new_paths() {
        let vault = temp_vault("rename");
        let old = vault.join("Old.md");
        let new = vault.join("New.md");
        fs::write(&old, "content").unwrap();
        fs::rename(&old, &new).unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&old, &new]);

        assert!(reconcile_self_write(&state.own_writes, &old, "rename", 1));
        assert!(reconcile_self_write(&state.own_writes, &new, "rename", 1));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn old_watcher_generation_is_ignored() {
        let vault = temp_vault("generation");
        let note = vault.join("Note.md");
        fs::write(&note, "content").unwrap();
        let state = WatcherState::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&note]);

        assert!(!reconcile_self_write(&state.own_writes, &note, "modify", 2));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn watcher_ignores_atomic_write_temporary_files() {
        assert!(is_amby_temporary_file(Path::new(
            "/vault/.Note.md.amby-tmp-123-0"
        )));
        assert!(!is_amby_temporary_file(Path::new("/vault/Note.md")));
    }

    #[test]
    fn watcher_keeps_rename_events() {
        let kind = notify::EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Any,
        ));
        assert_eq!(watched_event_kind(&kind), Some("rename"));
    }
}
