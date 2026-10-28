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
