use crate::lock_util::LockExt;
#[cfg(test)]
pub use amby_core::self_write::content_reads_for_test;
use amby_core::self_write::SelfWriteTracker;
pub use amby_core::self_write::{
    fingerprint_for_bytes, is_amby_temporary_file, path_fingerprint, path_fingerprint_for_move,
    reconcile_self_write, PathFingerprint, PreparedSelfWrite, SelfWriteRecord,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Payload emitted to the frontend when an external file-system change is
/// detected in the vault (creates, modifies, deletes).
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct VaultFileChangedPayload {
    pub kind: String, // "create" | "modify" | "remove" | "rename"
    pub path: String,
    #[serde(skip)]
    pub generation: u64,
}

/// Explicit notifications for successful writes hidden by own-write suppression.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublishedFiles {
    pub generation: u64,
    pub paths: Vec<String>,
    pub origin_window: Option<String>,
}

pub fn notify_published_files(
    app: &tauri::AppHandle,
    vault: &Path,
    generation: u64,
    paths: &[PathBuf],
    origin_window: Option<&str>,
) {
    use tauri::Emitter;
    if paths.is_empty() {
        return;
    }
    let payload = PublishedFiles {
        generation,
        paths: paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        origin_window: origin_window.map(str::to_owned),
    };
    if let Err(error) = app.emit("amby:files-changed", payload) {
        tracing::warn!(event = "published_files_event_failed", %error);
    }
    for path in paths {
        if let Some(change) = crate::database::events::classify_path(vault, path, generation) {
            if let Err(error) = app.emit("database:changed", change) {
                tracing::warn!(event = "database_change_event_failed", %error);
            }
        }
        if let Some(change) =
            crate::project::events::classify_path(vault, path, "modify", generation)
        {
            if let Err(error) = app.emit("project:changed", change) {
                tracing::warn!(event = "project_change_event_failed", %error);
            }
        }
    }
}

/// Emit one watcher change and its database/project classifications together.
/// During a sync batch the caller invokes this only after the batch is released.
pub fn emit_external_change(
    app: &tauri::AppHandle,
    vault: &Path,
    generation: u64,
    change: VaultFileChangedPayload,
) {
    use tauri::Emitter;
    let path = Path::new(&change.path);
    if !path.starts_with(vault) {
        return;
    }
    if let Some(database_change) = crate::database::events::classify_path(vault, path, generation) {
        let summary = crate::database::events::coalesce(std::iter::once(database_change.clone()));
        tracing::debug!(
            changed_paths = summary.changed_paths.len(),
            containers = summary.containers.len(),
            requires_full_rebuild = summary.requires_full_rebuild,
            "database watcher invalidation"
        );
        let _ = app.emit("database:changed", database_change);
    }
    if let Some(project_change) =
        crate::project::events::classify_path(vault, path, &change.kind, generation)
    {
        let _ = app.emit("project:changed", project_change);
    }
    let _ = app.emit("vault-file-changed", change);
}

pub fn watched_event_kind(kind: &notify::EventKind) -> Option<&'static str> {
    match kind {
        notify::EventKind::Create(_) => Some("create"),
        notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => Some("rename"),
        notify::EventKind::Modify(_) | notify::EventKind::Any => Some("modify"),
        notify::EventKind::Remove(_) => Some("remove"),
        _ => None,
    }
}

/// Queue invalidations before notifying renderers. Missing event detail or OS
/// overflow requires a content rescan, not a metadata-only refresh.
pub fn queue_external_changes(
    event: notify::Result<notify::Event>,
    vault: &Path,
    own_writes: &Mutex<HashMap<PathBuf, SelfWriteRecord>>,
    generation: u64,
    index_changes: &Mutex<HashSet<PathBuf>>,
) -> Vec<VaultFileChangedPayload> {
    let changes = match event {
        Ok(event) if !event.need_rescan() => {
            let Some(kind) = watched_event_kind(&event.kind) else {
                return Vec::new();
            };
            if event.paths.is_empty() {
                vec![VaultFileChangedPayload {
                    kind: "modify".into(),
                    path: vault.to_string_lossy().into(),
                    generation,
                }]
            } else {
                event
                    .paths
                    .iter()
                    .filter(|path| {
                        path.starts_with(vault)
                            && !path.components().any(|c| c.as_os_str() == ".amby")
                            && !is_amby_temporary_file(path)
                            && !reconcile_self_write(own_writes, path, kind, generation)
                    })
                    .map(|path| VaultFileChangedPayload {
                        kind: kind.into(),
                        path: path.to_string_lossy().into(),
                        generation,
                    })
                    .collect()
            }
        }
        _ => vec![VaultFileChangedPayload {
            kind: "modify".into(),
            path: vault.to_string_lossy().into(),
            generation,
        }],
    };
    index_changes
        .lock_or_recover()
        .extend(changes.iter().map(|change| PathBuf::from(&change.path)));
    changes
}

/// Merges the events of the watcher while a batch of changes from synchronisation is applied
/// (docs/sync-plan.md, Р8): the renderer gets each path once, after the batch, instead of a storm
/// of events in the middle of it. Outside a batch events pass through at once.
#[derive(Debug, Default)]
pub struct EventBatch {
    state: Mutex<BatchState>,
}

#[derive(Debug, Default)]
struct BatchState {
    depth: u32,
    held: Vec<VaultFileChangedPayload>,
}

impl EventBatch {
    /// A batch begins (batches nest).
    pub fn begin(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.depth += 1;
        }
    }

    /// The events to send now: all of `events` outside a batch, none inside one (they are held).
    pub fn push(&self, events: Vec<VaultFileChangedPayload>) -> Vec<VaultFileChangedPayload> {
        let Ok(mut state) = self.state.lock() else {
            return events;
        };
        if state.depth == 0 {
            return events;
        }
        state.held.extend(events);
        Vec::new()
    }

    /// A batch ends; when the outermost one ends, the held events are returned, each path once
    /// with its latest kind in the order the paths first appeared.
    pub fn end(&self) -> Vec<VaultFileChangedPayload> {
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        if state.depth == 0 {
            return Vec::new();
        }
        state.depth -= 1;
        if state.depth > 0 {
            return Vec::new();
        }
        let mut merged: Vec<VaultFileChangedPayload> = Vec::new();
        for event in std::mem::take(&mut state.held) {
            match merged
                .iter_mut()
                .find(|seen| seen.path == event.path && seen.generation == event.generation)
            {
                Some(seen) => seen.kind = event.kind,
                None => merged.push(event),
            }
        }
        merged
    }
}

/// Owns the active OS watcher and the state shared with its callbacks.
pub struct WatcherState {
    /// Dropping the watcher unregisters the OS watch.
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pub self_writes: SelfWriteTracker,
    pub batch: Arc<EventBatch>,
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
            self_writes: SelfWriteTracker::new(),
            batch: Arc::new(EventBatch::default()),
        }
    }
}

#[cfg(test)]
mod event_batch_tests {
    use super::*;

    fn event(kind: &str, path: &str) -> VaultFileChangedPayload {
        VaultFileChangedPayload {
            kind: kind.into(),
            path: path.into(),
            generation: 1,
        }
    }

    #[test]
    fn outside_a_batch_events_pass_at_once() {
        // Р8: only the batch of synchronisation holds events back
        let batch = EventBatch::default();
        let events = vec![event("modify", "/v/a.md"), event("create", "/v/b.md")];
        assert_eq!(batch.push(events.clone()), events);
        assert!(batch.end().is_empty(), "no batch was open");
    }

    #[test]
    fn inside_a_batch_events_are_held_and_sent_once_afterwards() {
        // Р8: the renderer gets each path once, after the batch
        let batch = EventBatch::default();
        batch.begin();
        assert!(batch
            .push(vec![event("create", "/v/a.md"), event("modify", "/v/b.md")])
            .is_empty());
        assert!(batch
            .push(vec![event("modify", "/v/a.md"), event("modify", "/v/c.md")])
            .is_empty());
        assert_eq!(
            batch.end(),
            vec![
                event("modify", "/v/a.md"),
                event("modify", "/v/b.md"),
                event("modify", "/v/c.md"),
            ],
            "each path once, the latest kind, in order of first appearance"
        );
        // And the batch is closed: events pass again.
        assert_eq!(
            batch.push(vec![event("modify", "/v/d.md")]),
            vec![event("modify", "/v/d.md")]
        );
    }

    #[test]
    fn batch_keeps_events_from_different_vault_generations_separate() {
        let batch = EventBatch::default();
        batch.begin();
        batch.push(vec![event("modify", "/v/a.md")]);
        let mut newer = event("remove", "/v/a.md");
        newer.generation = 2;
        batch.push(vec![newer.clone()]);
        assert_eq!(batch.end(), vec![event("modify", "/v/a.md"), newer]);
    }

    #[test]
    fn batches_nest_and_only_the_outermost_end_releases_the_events() {
        let batch = EventBatch::default();
        batch.begin();
        batch.begin();
        batch.push(vec![event("modify", "/v/a.md")]);
        assert!(batch.end().is_empty(), "the inner end releases nothing");
        assert!(batch.push(vec![event("modify", "/v/b.md")]).is_empty());
        assert_eq!(
            batch.end(),
            vec![event("modify", "/v/a.md"), event("modify", "/v/b.md")]
        );
    }

    #[test]
    fn an_end_without_a_begin_is_harmless() {
        let batch = EventBatch::default();
        assert!(batch.end().is_empty());
        batch.begin();
        batch.push(vec![event("remove", "/v/a.md")]);
        assert_eq!(batch.end().len(), 1);
    }

    #[test]
    fn watcher_keeps_rename_events() {
        let kind = notify::EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Any,
        ));
        assert_eq!(watched_event_kind(&kind), Some("rename"));
    }
    #[test]
    fn queueing_changes_survives_an_index_queue_poisoned_by_a_panic() {
        let queue = std::sync::Arc::new(Mutex::new(HashSet::new()));
        let clone = std::sync::Arc::clone(&queue);
        let _ = std::thread::spawn(move || {
            let _guard = clone.lock().unwrap();
            panic!("poison the index queue");
        })
        .join();
        assert!(queue.is_poisoned());
        let own_writes = Mutex::new(HashMap::new());

        let changes = queue_external_changes(
            Err(notify::Error::generic("overflow")),
            Path::new("/vault"),
            &own_writes,
            1,
            &queue,
        );

        assert_eq!(changes.len(), 1);
        assert_eq!(queue.lock().unwrap().len(), 1);
    }
}
