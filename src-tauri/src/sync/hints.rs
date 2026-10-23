//! Hints about renames (Д70): the application knows the renames and moves the person made
//! through Amby and tells the engine at the next pass, so that "renamed and edited" is not read
//! as "deleted and created" (Д13). A hint is used once.

use std::path::Path;
use std::sync::Mutex;

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
    pub fn record(&self, _vault: &Path, _changes: &[PathChange]) {
        todo!("Э4: RenameHints::record")
    }

    /// Takes everything queued (the queue is empty afterwards).
    pub fn take(&self) -> Vec<RenameHint> {
        todo!("Э4: RenameHints::take")
    }

    /// Puts hints back (a pass did not run); they go before newer ones.
    pub fn restore(&self, _hints: Vec<RenameHint>) {
        todo!("Э4: RenameHints::restore")
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
