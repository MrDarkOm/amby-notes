use crate::lock_util::LockExt;
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

pub fn is_amby_temporary_file(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().contains(".amby-tmp-"))
}

/// Records writes made by this process so filesystem events can reconcile them.
pub struct SelfWriteTracker {
    /// Exact results of our own filesystem writes. Unrelated ancestor
    /// directories are not recorded, while compound mutations register the
    /// specific directories they actually create, remove, or touch.
    pub own_writes: Arc<Mutex<HashMap<PathBuf, SelfWriteRecord>>>,
    /// The active watcher's vault generation. A callback from a dropped prior
    /// watcher is ignored even if the OS delivers it late.
    pub active_generation: Arc<AtomicU64>,
    /// Monotonically increasing operation identity. A later failed operation
    /// must never remove another writer's record for the same path.
    next_operation_token: AtomicU64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelfWriteOperation {
    Write,
    Create,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathFingerprint {
    File {
        size: u64,
        content_hash: u64,
    },
    /// Metadata-only identity of a file that is moved or renamed, never
    /// rewritten: size, modification time and (where the platform exposes it)
    /// the file id. Computing it does not read the file, so moving a folder of
    /// large attachments stays O(file count). It is only compared with another
    /// identity of the same kind (see `path_fingerprint_like`).
    MovedFile {
        size: u64,
        modified_nanos: u128,
        file_id: Option<(u64, u64)>,
    },
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
    pub operation_token: u64,
}

/// A pre-registered exact filesystem result. It is installed before a write
/// publishes its atomic rename, so watcher callbacks can reconcile an event
/// that arrives before the command returns.
#[derive(Clone, Debug)]
pub struct PreparedSelfWrite {
    records: Vec<(PathBuf, u64)>,
}

pub fn fingerprint_for_bytes(bytes: &[u8]) -> PathFingerprint {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    PathFingerprint::File {
        size: bytes.len() as u64,
        content_hash: hasher.finish(),
    }
}

thread_local! {
    /// Test seam: how many file contents `path_fingerprint` hashed on this thread.
    #[cfg(any(test, feature = "test-support"))]
    static CONTENT_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Test seam: number of file contents hashed by `path_fingerprint` on this thread.
#[cfg(any(test, feature = "test-support"))]
pub fn content_reads_for_test() -> usize {
    CONTENT_READS.with(|count| count.get())
}

/// Exact content fingerprint. The file is hashed as a stream, so memory use
/// does not depend on its size; the hash equals `fingerprint_for_bytes`.
pub fn path_fingerprint(path: &Path) -> PathFingerprint {
    use std::io::Read;
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return PathFingerprint::Missing;
        }
        Err(_) => return PathFingerprint::Unavailable,
    };
    if metadata.is_dir() {
        return PathFingerprint::Directory;
    }
    if !metadata.is_file() {
        return PathFingerprint::Unavailable;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return PathFingerprint::Unavailable;
    };
    #[cfg(any(test, feature = "test-support"))]
    CONTENT_READS.with(|count| count.set(count.get() + 1));
    // Hashes exactly like `bytes.hash(..)` for a slice: length prefix, then bytes.
    let mut hasher = DefaultHasher::new();
    hasher.write_usize(metadata.len() as usize);
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                hasher.write(&buffer[..read]);
                size += read as u64;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return PathFingerprint::Unavailable,
        }
    }
    if size != metadata.len() {
        // The file changed while it was read; there is no stable fingerprint.
        return PathFingerprint::Unavailable;
    }
    PathFingerprint::File {
        size,
        content_hash: hasher.finish(),
    }
}

/// Fingerprint for a file that is only moved or renamed. Reads no content.
/// Falls back to the content fingerprint when the platform gives no
/// modification time.
pub fn path_fingerprint_for_move(path: &Path) -> PathFingerprint {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return PathFingerprint::Missing;
        }
        Err(_) => return PathFingerprint::Unavailable,
    };
    if metadata.is_dir() {
        return PathFingerprint::Directory;
    }
    if !metadata.is_file() {
        return PathFingerprint::Unavailable;
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok());
    match modified {
        Some(modified) => PathFingerprint::MovedFile {
            size: metadata.len(),
            modified_nanos: modified.as_nanos(),
            file_id: file_id(&metadata),
        },
        None => path_fingerprint(path),
    }
}

#[cfg(unix)]
fn file_id(metadata: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

// `file_index` is not stable on Windows; size + mtime is what remains there.
#[cfg(not(unix))]
fn file_id(_metadata: &fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// The fingerprint of `path` of the same kind as `expected`, so that a
/// metadata record is checked by metadata and a content record by content.
fn path_fingerprint_like(path: &Path, expected: &PathFingerprint) -> PathFingerprint {
    match expected {
        PathFingerprint::MovedFile { .. } => path_fingerprint_for_move(path),
        _ => path_fingerprint(path),
    }
}

fn operation_for_fingerprint(fingerprint: &PathFingerprint) -> SelfWriteOperation {
    match fingerprint {
        PathFingerprint::Missing => SelfWriteOperation::Delete,
        PathFingerprint::Directory => SelfWriteOperation::Create,
        PathFingerprint::File { .. }
        | PathFingerprint::MovedFile { .. }
        | PathFingerprint::Unavailable => SelfWriteOperation::Write,
    }
}

fn event_matches_operation(kind: &str, record: &SelfWriteRecord) -> bool {
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

impl Default for SelfWriteTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl SelfWriteTracker {
    pub fn new() -> Self {
        Self {
            own_writes: Arc::new(Mutex::new(HashMap::new())),
            active_generation: Arc::new(AtomicU64::new(0)),
            next_operation_token: AtomicU64::new(1),
        }
    }

    /// Register the exact intended results *before* the filesystem operation.
    /// `confirm_prepared_write` validates those results after success; callers
    /// must call `cancel_prepared_write` on every error path.
    pub fn prepare_write<I, P>(&self, writes: I) -> PreparedSelfWrite
    where
        I: IntoIterator<Item = (P, PathFingerprint)>,
        P: AsRef<Path>,
    {
        let mut guard = self.own_writes.lock_or_recover();
        let now = Instant::now();
        let generation = self.active_generation.load(Ordering::Acquire);
        let mut records = Vec::new();
        for (path, expected) in writes {
            let path = path.as_ref().to_path_buf();
            let token = self.next_operation_token.fetch_add(1, Ordering::Relaxed);
            guard.insert(
                path.clone(),
                SelfWriteRecord {
                    operation: operation_for_fingerprint(&expected),
                    expected,
                    recorded_at: now,
                    expires_at: now + SELF_WRITE_RECORD_TTL,
                    generation,
                    operation_token: token,
                },
            );
            records.push((path, token));
        }
        guard.retain(|_, record| record.expires_at > now);
        PreparedSelfWrite { records }
    }

    /// Keep only records whose actual target still equals their pre-registered
    /// fingerprint. If an external writer won the race, remove the record so
    /// its watcher event cannot be mistaken for an Amby write.
    pub fn confirm_prepared_write(&self, prepared: &PreparedSelfWrite) {
        let mut guard = self.own_writes.lock_or_recover();
        for (path, token) in &prepared.records {
            let should_remove = guard.get(path).is_some_and(|record| {
                record.operation_token == *token
                    && path_fingerprint_like(path, &record.expected) != record.expected
            });
            if should_remove {
                guard.remove(path);
            }
        }
    }

    /// Remove only this operation's speculative records. This preserves a
    /// newer operation that registered the same path after us.
    pub fn cancel_prepared_write(&self, prepared: &PreparedSelfWrite) {
        let mut guard = self.own_writes.lock_or_recover();
        for (path, token) in &prepared.records {
            if guard
                .get(path)
                .is_some_and(|record| record.operation_token == *token)
            {
                guard.remove(path);
            }
        }
    }

    /// Record a completed write's exact on-disk result.
    ///
    /// This remains for compound filesystem mutations whose affected paths are
    /// only discoverable after completion. Atomic text/create paths use
    /// `prepare_write` instead, because a post-write-only record races notify.
    pub fn mark_write<I, P>(&self, paths: I)
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        // Transitional helper for complex legacy mutations. New writes must
        // use prepare_write before publishing their filesystem operation.
        let prepared = self.prepare_write(
            paths
                .into_iter()
                .map(|path| (path.as_ref().to_path_buf(), path_fingerprint(path.as_ref()))),
        );
        self.confirm_prepared_write(&prepared);
    }
}

pub fn reconcile_self_write(
    own_writes: &Mutex<HashMap<PathBuf, SelfWriteRecord>>,
    path: &Path,
    kind: &str,
    generation: u64,
) -> bool {
    let now = Instant::now();
    let mut guard = own_writes.lock_or_recover();
    let Some(record) = guard.get(path).cloned() else {
        return false;
    };
    let age = now.saturating_duration_since(record.recorded_at);
    if record.generation != generation || record.expires_at <= now || age >= SELF_WRITE_RECORD_TTL {
        guard.remove(path);
        return false;
    }
    event_matches_operation(kind, &record)
        && path_fingerprint_like(path, &record.expected) == record.expected
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
        let state = SelfWriteTracker::new();
        state.active_generation.store(1, Ordering::Release);
        state.mark_write([&note]);

        assert!(reconcile_self_write(&state.own_writes, &note, "modify", 1));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn pre_registered_write_suppresses_an_event_before_the_writer_returns() {
        let vault = temp_vault("pre-registered-write");
        let note = vault.join("Note.md");
        fs::write(&note, "before").unwrap();
        let state = SelfWriteTracker::new();
        state.active_generation.store(1, Ordering::Release);
        let prepared =
            state.prepare_write([(&note, fingerprint_for_bytes(b"published by atomic write"))]);

        // Models notify observing the atomic rename before the command gets to
        // its success path and calls confirm_prepared_write.
        fs::write(&note, "published by atomic write").unwrap();
        assert!(reconcile_self_write(&state.own_writes, &note, "modify", 1));
        state.confirm_prepared_write(&prepared);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn failed_pre_registered_write_does_not_leave_a_grace_window() {
        let vault = temp_vault("cancel-prepared-write");
        let note = vault.join("Note.md");
        fs::write(&note, "before").unwrap();
        let state = SelfWriteTracker::new();
        state.active_generation.store(1, Ordering::Release);
        let prepared = state.prepare_write([(&note, fingerprint_for_bytes(b"never written"))]);
        state.cancel_prepared_write(&prepared);
        fs::write(&note, "external content").unwrap();

        assert!(!reconcile_self_write(&state.own_writes, &note, "modify", 1));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn cancelling_an_older_operation_does_not_remove_a_newer_record() {
        let vault = temp_vault("operation-token");
        let note = vault.join("Note.md");
        let state = SelfWriteTracker::new();
        state.active_generation.store(1, Ordering::Release);
        let older = state.prepare_write([(&note, fingerprint_for_bytes(b"older"))]);
        let newer = state.prepare_write([(&note, fingerprint_for_bytes(b"newer"))]);

        state.cancel_prepared_write(&older);
        fs::write(&note, "newer").unwrap();
        assert!(reconcile_self_write(&state.own_writes, &note, "create", 1));
        state.confirm_prepared_write(&newer);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn external_write_inside_the_old_grace_window_is_emitted() {
        let vault = temp_vault("external-write");
        let note = vault.join("Note.md");
        fs::write(&note, "own content").unwrap();
        let state = SelfWriteTracker::new();
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
        let state = SelfWriteTracker::new();
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
        let state = SelfWriteTracker::new();
        state.active_generation.store(1, Ordering::Release);
        let prepared = state.prepare_write([
            (&old, PathFingerprint::Missing),
            (&new, path_fingerprint(&old)),
        ]);
        fs::rename(&old, &new).unwrap();

        assert!(reconcile_self_write(&state.own_writes, &old, "rename", 1));
        assert!(reconcile_self_write(&state.own_writes, &new, "rename", 1));
        state.confirm_prepared_write(&prepared);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn old_watcher_generation_is_ignored() {
        let vault = temp_vault("generation");
        let note = vault.join("Note.md");
        fs::write(&note, "content").unwrap();
        let state = SelfWriteTracker::new();
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
    fn streamed_content_fingerprint_equals_the_in_memory_one() {
        let vault = std::env::temp_dir().join(format!("amby-stream-eq-{}", std::process::id()));
        fs::create_dir_all(&vault).unwrap();
        let big = vault.join("big.bin");
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&big, &bytes).unwrap();
        assert_eq!(path_fingerprint(&big), fingerprint_for_bytes(&bytes));
        let empty = vault.join("empty");
        fs::write(&empty, b"").unwrap();
        assert_eq!(path_fingerprint(&empty), fingerprint_for_bytes(b""));
        fs::remove_dir_all(vault).unwrap();
    }
}
