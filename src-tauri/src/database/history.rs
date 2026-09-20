use crate::database::format::raw_revision;
use crate::frontmatter;
use crate::watcher::{self, WatcherState};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHistoryFile {
    pub path: PathBuf,
    pub note_id: String,
    pub pre_bytes: Vec<u8>,
    pub pre_revision: String,
    pub post_bytes: Vec<u8>,
    pub post_revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHistoryEntry {
    pub database_id: String,
    pub description: String,
    pub files: Vec<DatabaseHistoryFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseUndoRedoResult {
    pub database_id: String,
    pub can_undo: bool,
    pub can_redo: bool,
    pub affected_notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHistoryStatus {
    pub database_id: String,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Default)]
pub struct DatabaseHistoryState {
    undo_stacks: Mutex<HashMap<String, Vec<DatabaseHistoryEntry>>>,
    redo_stacks: Mutex<HashMap<String, Vec<DatabaseHistoryEntry>>>,
}

impl DatabaseHistoryState {
    pub fn push(&self, entry: DatabaseHistoryEntry) {
        let mut undo = self.undo_stacks.lock().expect("history poisoned");
        let mut redo = self.redo_stacks.lock().expect("history poisoned");
        redo.remove(&entry.database_id); // New mutation clears redo stack
        let stack = undo.entry(entry.database_id.clone()).or_default();
        stack.push(entry);
        if stack.len() > 100 {
            stack.remove(0);
        }
    }

    pub fn can_undo(&self, database_id: &str) -> bool {
        self.undo_stacks
            .lock()
            .expect("history poisoned")
            .get(database_id)
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }

    pub fn can_redo(&self, database_id: &str) -> bool {
        self.redo_stacks
            .lock()
            .expect("history poisoned")
            .get(database_id)
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }

    pub fn status(&self, database_id: &str) -> DatabaseHistoryStatus {
        DatabaseHistoryStatus {
            database_id: database_id.to_owned(),
            can_undo: self.can_undo(database_id),
            can_redo: self.can_redo(database_id),
        }
    }

    #[allow(dead_code)]
    pub fn clear(&self, database_id: Option<&str>) {
        let mut undo = self.undo_stacks.lock().expect("history poisoned");
        let mut redo = self.redo_stacks.lock().expect("history poisoned");
        if let Some(db_id) = database_id {
            undo.remove(db_id);
            redo.remove(db_id);
        } else {
            undo.clear();
            redo.clear();
        }
    }

    pub fn undo(
        &self,
        vault_root: &std::path::Path,
        watcher: &WatcherState,
        database_id: &str,
    ) -> Result<DatabaseUndoRedoResult, String> {
        let entry = {
            let mut undo = self.undo_stacks.lock().expect("history poisoned");
            let stack = undo
                .get_mut(database_id)
                .ok_or_else(|| "No undo history for database".to_owned())?;
            stack
                .pop()
                .ok_or_else(|| "No mutations to undo".to_owned())?
        };

        // 0. Confinement check: all files must belong to active vault
        for file in &entry.files {
            crate::paths::confine(vault_root, &file.path)
                .map_err(|e| format!("File does not belong to active vault: {e}"))?;
        }

        // 1. CAS check: every file must match its post_revision
        for file in &entry.files {
            let current = std::fs::read(&file.path)
                .map_err(|e| format!("Failed to read {}: {e}", file.path.display()))?;
            let current_rev = raw_revision(&current);
            if current_rev != file.post_revision {
                let err = format!(
                    "CAS conflict on undo: {} has revision {current_rev}, expected {}",
                    file.path.display(),
                    file.post_revision
                );
                let mut undo = self.undo_stacks.lock().expect("history poisoned");
                undo.entry(database_id.to_owned()).or_default().push(entry);
                return Err(err);
            }
        }

        // 2. Prepare writes with watcher
        let prepared_writes = watcher.prepare_write(entry.files.iter().map(|f| {
            (
                f.path.as_path(),
                watcher::fingerprint_for_bytes(&f.pre_bytes),
            )
        }));

        // 3. Atomic writes with rollback
        let mut written = Vec::new();
        let mut err = None;
        for file in &entry.files {
            if let Err(e) = frontmatter::atomic_write_bytes(&file.path, &file.pre_bytes) {
                err = Some(e);
                break;
            }
            written.push(file);
        }

        if let Some(e) = err {
            watcher.cancel_prepared_write(&prepared_writes);
            for file in written {
                let _ = frontmatter::atomic_write_bytes(&file.path, &file.post_bytes);
            }
            let mut undo = self.undo_stacks.lock().expect("history poisoned");
            undo.entry(database_id.to_owned()).or_default().push(entry);
            return Err(format!("Undo failed during atomic write; rolled back: {e}"));
        }
        watcher.confirm_prepared_write(&prepared_writes);

        let affected_notes = entry
            .files
            .iter()
            .map(|f| f.note_id.clone())
            .collect::<Vec<_>>();

        // 4. Push to redo stack
        {
            let mut redo = self.redo_stacks.lock().expect("history poisoned");
            redo.entry(database_id.to_owned()).or_default().push(entry);
        }

        Ok(DatabaseUndoRedoResult {
            database_id: database_id.to_owned(),
            can_undo: self.can_undo(database_id),
            can_redo: self.can_redo(database_id),
            affected_notes,
        })
    }

    pub fn redo(
        &self,
        vault_root: &std::path::Path,
        watcher: &WatcherState,
        database_id: &str,
    ) -> Result<DatabaseUndoRedoResult, String> {
        let entry = {
            let mut redo = self.redo_stacks.lock().expect("history poisoned");
            let stack = redo
                .get_mut(database_id)
                .ok_or_else(|| "No redo history for database".to_owned())?;
            stack
                .pop()
                .ok_or_else(|| "No mutations to redo".to_owned())?
        };

        // 0. Confinement check: all files must belong to active vault
        for file in &entry.files {
            crate::paths::confine(vault_root, &file.path)
                .map_err(|e| format!("File does not belong to active vault: {e}"))?;
        }

        // 1. CAS check: every file must match its pre_revision
        for file in &entry.files {
            let current = std::fs::read(&file.path)
                .map_err(|e| format!("Failed to read {}: {e}", file.path.display()))?;
            let current_rev = raw_revision(&current);
            if current_rev != file.pre_revision {
                let err = format!(
                    "CAS conflict on redo: {} has revision {current_rev}, expected {}",
                    file.path.display(),
                    file.pre_revision
                );
                let mut redo = self.redo_stacks.lock().expect("history poisoned");
                redo.entry(database_id.to_owned()).or_default().push(entry);
                return Err(err);
            }
        }

        // 2. Prepare writes with watcher
        let prepared_writes = watcher.prepare_write(entry.files.iter().map(|f| {
            (
                f.path.as_path(),
                watcher::fingerprint_for_bytes(&f.post_bytes),
            )
        }));

        // 3. Atomic writes with rollback
        let mut written = Vec::new();
        let mut err = None;
        for file in &entry.files {
            if let Err(e) = frontmatter::atomic_write_bytes(&file.path, &file.post_bytes) {
                err = Some(e);
                break;
            }
            written.push(file);
        }

        if let Some(e) = err {
            watcher.cancel_prepared_write(&prepared_writes);
            for file in written {
                let _ = frontmatter::atomic_write_bytes(&file.path, &file.pre_bytes);
            }
            let mut redo = self.redo_stacks.lock().expect("history poisoned");
            redo.entry(database_id.to_owned()).or_default().push(entry);
            return Err(format!("Redo failed during atomic write; rolled back: {e}"));
        }
        watcher.confirm_prepared_write(&prepared_writes);

        let affected_notes = entry
            .files
            .iter()
            .map(|f| f.note_id.clone())
            .collect::<Vec<_>>();

        // 4. Push to undo stack
        {
            let mut undo = self.undo_stacks.lock().expect("history poisoned");
            undo.entry(database_id.to_owned()).or_default().push(entry);
        }

        Ok(DatabaseUndoRedoResult {
            database_id: database_id.to_owned(),
            can_undo: self.can_undo(database_id),
            can_redo: self.can_redo(database_id),
            affected_notes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> PathBuf {
        let path = std::env::temp_dir().join(format!("amby-db-history-{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn st11_undo_single_cell_and_redo() {
        let temp = temp_vault();
        let file_path = temp.join("note.md");
        let pre_bytes =
            b"---\namby-id: 01J00000000000000000000001\nstatus: todo\n---\nHello".to_vec();
        let post_bytes =
            b"---\namby-id: 01J00000000000000000000001\nstatus: done\n---\nHello".to_vec();
        let pre_rev = raw_revision(&pre_bytes);
        let post_rev = raw_revision(&post_bytes);

        std::fs::write(&file_path, &post_bytes).unwrap();

        let history = DatabaseHistoryState::default();
        let watcher = WatcherState::default();
        let db_id = "01J00000000000000000000000";

        history.push(DatabaseHistoryEntry {
            database_id: db_id.to_owned(),
            description: "Edit status".to_owned(),
            files: vec![DatabaseHistoryFile {
                path: file_path.clone(),
                note_id: "01J00000000000000000000001".to_owned(),
                pre_bytes: pre_bytes.clone(),
                pre_revision: pre_rev.clone(),
                post_bytes: post_bytes.clone(),
                post_revision: post_rev.clone(),
            }],
        });

        assert!(history.can_undo(db_id));
        assert!(!history.can_redo(db_id));

        // Perform undo
        let undo_res = history.undo(&temp, &watcher, db_id).unwrap();
        assert!(!undo_res.can_undo);
        assert!(undo_res.can_redo);
        assert_eq!(std::fs::read(&file_path).unwrap(), pre_bytes);

        // Perform redo
        let redo_res = history.redo(&temp, &watcher, db_id).unwrap();
        assert!(redo_res.can_undo);
        assert!(!redo_res.can_redo);
        assert_eq!(std::fs::read(&file_path).unwrap(), post_bytes);
    }

    #[test]
    fn st11_undo_multi_cell_batch() {
        let temp = temp_vault();
        let f1 = temp.join("note1.md");
        let f2 = temp.join("note2.md");

        let pre1 = b"---\namby-id: 01J00000000000000000000001\nv: 1\n---\n".to_vec();
        let post1 = b"---\namby-id: 01J00000000000000000000001\nv: 10\n---\n".to_vec();
        let pre2 = b"---\namby-id: 01J00000000000000000000002\nv: 2\n---\n".to_vec();
        let post2 = b"---\namby-id: 01J00000000000000000000002\nv: 20\n---\n".to_vec();

        std::fs::write(&f1, &post1).unwrap();
        std::fs::write(&f2, &post2).unwrap();

        let history = DatabaseHistoryState::default();
        let watcher = WatcherState::default();
        let db_id = "01J00000000000000000000000";

        history.push(DatabaseHistoryEntry {
            database_id: db_id.to_owned(),
            description: "Batch edit".to_owned(),
            files: vec![
                DatabaseHistoryFile {
                    path: f1.clone(),
                    note_id: "01J00000000000000000000001".to_owned(),
                    pre_bytes: pre1.clone(),
                    pre_revision: raw_revision(&pre1),
                    post_bytes: post1.clone(),
                    post_revision: raw_revision(&post1),
                },
                DatabaseHistoryFile {
                    path: f2.clone(),
                    note_id: "01J00000000000000000000002".to_owned(),
                    pre_bytes: pre2.clone(),
                    pre_revision: raw_revision(&pre2),
                    post_bytes: post2.clone(),
                    post_revision: raw_revision(&post2),
                },
            ],
        });

        let undo_res = history.undo(&temp, &watcher, db_id).unwrap();
        assert_eq!(undo_res.affected_notes.len(), 2);
        assert_eq!(std::fs::read(&f1).unwrap(), pre1);
        assert_eq!(std::fs::read(&f2).unwrap(), pre2);
    }

    #[test]
    fn st11_undo_relation_link_both_sides() {
        let temp = temp_vault();
        let source_path = temp.join("source.md");
        let target_path = temp.join("target.md");

        let pre_source = b"---\namby-id: 01J00000000000000000000001\n---\n".to_vec();
        let post_source = b"---\namby-id: 01J00000000000000000000001\nrel:\n  - 01J00000000000000000000002\n---\n".to_vec();
        let pre_target = b"---\namby-id: 01J00000000000000000000002\n---\n".to_vec();
        let post_target = b"---\namby-id: 01J00000000000000000000002\ninv_rel:\n  - 01J00000000000000000000001\n---\n".to_vec();

        std::fs::write(&source_path, &post_source).unwrap();
        std::fs::write(&target_path, &post_target).unwrap();

        let history = DatabaseHistoryState::default();
        let watcher = WatcherState::default();
        let db_id = "01J00000000000000000000000";

        history.push(DatabaseHistoryEntry {
            database_id: db_id.to_owned(),
            description: "Link relation".to_owned(),
            files: vec![
                DatabaseHistoryFile {
                    path: source_path.clone(),
                    note_id: "01J00000000000000000000001".to_owned(),
                    pre_bytes: pre_source.clone(),
                    pre_revision: raw_revision(&pre_source),
                    post_bytes: post_source.clone(),
                    post_revision: raw_revision(&post_source),
                },
                DatabaseHistoryFile {
                    path: target_path.clone(),
                    note_id: "01J00000000000000000000002".to_owned(),
                    pre_bytes: pre_target.clone(),
                    pre_revision: raw_revision(&pre_target),
                    post_bytes: post_target.clone(),
                    post_revision: raw_revision(&post_target),
                },
            ],
        });

        let undo_res = history.undo(&temp, &watcher, db_id).unwrap();
        assert_eq!(undo_res.affected_notes.len(), 2);
        assert_eq!(std::fs::read(&source_path).unwrap(), pre_source);
        assert_eq!(std::fs::read(&target_path).unwrap(), pre_target);
    }

    #[test]
    fn st11_cas_conflict_rejection_on_undo_when_external_edit_occurred() {
        let temp = temp_vault();
        let file_path = temp.join("note.md");
        let pre_bytes = b"---\namby-id: 01J00000000000000000000001\nv: 1\n---\n".to_vec();
        let post_bytes = b"---\namby-id: 01J00000000000000000000001\nv: 2\n---\n".to_vec();
        let external_bytes = b"---\namby-id: 01J00000000000000000000001\nv: 3\n---\n".to_vec();

        // Simulate external edit
        std::fs::write(&file_path, &external_bytes).unwrap();

        let history = DatabaseHistoryState::default();
        let watcher = WatcherState::default();
        let db_id = "01J00000000000000000000000";

        history.push(DatabaseHistoryEntry {
            database_id: db_id.to_owned(),
            description: "Edit v".to_owned(),
            files: vec![DatabaseHistoryFile {
                path: file_path.clone(),
                note_id: "01J00000000000000000000001".to_owned(),
                pre_bytes: pre_bytes.clone(),
                pre_revision: raw_revision(&pre_bytes),
                post_bytes: post_bytes.clone(),
                post_revision: raw_revision(&post_bytes),
            }],
        });

        let err = history.undo(&temp, &watcher, db_id).unwrap_err();
        assert!(err.contains("CAS conflict on undo"));
        // File remains unchanged with external bytes
        assert_eq!(std::fs::read(&file_path).unwrap(), external_bytes);
        // History entry was preserved
        assert!(history.can_undo(db_id));
    }
}
