//! Hints about renames (Д70): the application knows the renames and moves the person made
//! through Amby and tells the engine at the next pass, so that "renamed and edited" is not read
//! as "deleted and created" (Д13). A hint is used once.

use std::path::Path;
use std::sync::Mutex;

use unicode_normalization::UnicodeNormalization;

use amby_sync_core::engine::RenameHint;

use crate::model::PathChange;

/// The hints collected since the last pass.
#[derive(Debug, Default)]
pub struct RenameHints {
    pending: Mutex<Vec<RenameHint>>,
    /// What the running pass took, until it ends ([`Self::finish_pass`]).
    in_flight: Mutex<Vec<RenameHint>>,
    /// What the running pass used (see [`Self::mark_applied`]).
    applied: Mutex<Vec<RenameHint>>,
    /// Hints that were carried over once because the pass did not see their rename yet.
    carried: Mutex<Vec<RenameHint>>,
}

impl RenameHints {
    /// An empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Remembers the renames of one command. Paths are made relative to `vault`, with `/`
    /// separators, in NFC. A change outside the vault, a change of a path onto itself and a pair
    /// that is already queued are dropped.
    pub fn record(&self, vault: &Path, changes: &[PathChange]) {
        let canonical = vault.canonicalize().ok();
        let relative = |path: &str| relative_nfc(vault, canonical.as_deref(), path);
        let mut fresh = Vec::new();
        for change in changes {
            let (Some(from), Some(to)) = (relative(&change.old_path), relative(&change.new_path))
            else {
                continue;
            };
            if from != to {
                fresh.push(RenameHint { from, to });
            }
        }
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        for hint in fresh {
            if !pending.contains(&hint) {
                pending.push(hint);
            }
        }
    }

    /// Takes everything queued (the queue is empty afterwards).
    pub fn take(&self) -> Vec<RenameHint> {
        self.pending
            .lock()
            .map(|mut list| std::mem::take(&mut *list))
            .unwrap_or_default()
    }

    /// What a running pass takes, as late as it can: after it has read the vault (a rename it saw
    /// on disk had its hint recorded before, Д70). The hints stay known to the queue until
    /// [`Self::finish_pass`] says what became of them.
    pub fn take_for_pass(&self) -> Vec<RenameHint> {
        let taken = self.take();
        if let Ok(mut flight) = self.in_flight.lock() {
            for hint in &taken {
                if !flight.contains(hint) {
                    flight.push(hint.clone());
                }
            }
        }
        taken
    }

    /// The engine says which hints of the running pass it used: a rename it saw on disk.
    pub fn mark_applied(&self, applied: &[RenameHint]) {
        if let Ok(mut list) = self.applied.lock() {
            for hint in applied {
                if !list.contains(hint) {
                    list.push(hint.clone());
                }
            }
        }
    }

    /// The pass ended. When it did not run to the end, its hints go back. When it did, those it
    /// used are used up (Д70: once). A hint it did not use did not see its rename yet (the hint is
    /// recorded before the rename on disk, and the rename may come after the pass read the
    /// vault): it waits for one more pass, but only one, so a rename that never happens does not
    /// keep it for ever.
    pub fn finish_pass(&self, done: bool) {
        let used = self
            .in_flight
            .lock()
            .map(|mut list| std::mem::take(&mut *list))
            .unwrap_or_default();
        let applied = self
            .applied
            .lock()
            .map(|mut list| std::mem::take(&mut *list))
            .unwrap_or_default();
        if !done {
            self.restore(used);
            return;
        }
        let Ok(mut carried) = self.carried.lock() else {
            return;
        };
        let before = std::mem::take(&mut *carried);
        let mut again = Vec::new();
        for hint in used {
            if !applied.contains(&hint) && !before.contains(&hint) {
                carried.push(hint.clone());
                again.push(hint);
            }
        }
        drop(carried);
        self.restore(again);
    }

    /// Puts hints back (a pass did not run); they go before newer ones.
    pub fn restore(&self, hints: Vec<RenameHint>) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        let newer = std::mem::take(&mut *pending);
        for hint in hints.into_iter().chain(newer) {
            if !pending.contains(&hint) {
                pending.push(hint);
            }
        }
    }

    /// How many hints wait.
    pub fn len(&self) -> usize {
        self.pending.lock().map(|list| list.len()).unwrap_or(0)
    }

    /// Whether none wait.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// `path` relative to the vault, with `/` separators and in NFC; `None` outside the vault.
fn relative_nfc(vault: &Path, canonical: Option<&Path>, path: &str) -> Option<String> {
    let path = Path::new(path);
    let inside = path
        .strip_prefix(vault)
        .ok()
        .or_else(|| canonical.and_then(|root| path.strip_prefix(root).ok()))?;
    let parts: Vec<String> = inside
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/").nfc().collect())
}
