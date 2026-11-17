//! Recovery journal for database value batches.
//!
//! `apply_value_batch` publishes an `inProgress` journal and raw backups before
//! it touches a note, so an interrupted batch can be rolled back at vault
//! activation. Every step that creates that recovery point must succeed before
//! the first source byte changes; only the final bookkeeping may degrade to a
//! warning, and it never deletes the backups.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::format::raw_revision;
use super::mutations::{json_bytes, DatabaseValueBatchResult};
use crate::durable::valid_operation_id;
use crate::frontmatter;

/// One note the batch is about to write: path, new bytes, old bytes, note ID.
pub(super) type PlannedValueWrite = (PathBuf, Vec<u8>, Vec<u8>, String);

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BatchRecoveryStep {
    pub(super) record_path: String,
    pub(super) backup_path: String,
    pub(super) original_revision: String,
    pub(super) target_revision: String,
    pub(super) status: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BatchRecoveryJournal {
    pub(super) format: String,
    pub(super) format_version: u64,
    pub(super) operation_id: String,
    pub(super) database_id: String,
    pub(super) request_revision: String,
    pub(super) status: String,
    pub(super) steps: Vec<BatchRecoveryStep>,
    pub(super) result: Option<DatabaseValueBatchResult>,
}

pub(super) fn journal_bytes(journal: &BatchRecoveryJournal) -> Result<Vec<u8>, String> {
    json_bytes(&serde_json::to_value(journal).map_err(|error| error.to_string())?)
}

pub(super) fn read_batch_journal(path: &Path) -> Result<BatchRecoveryJournal, String> {
    let journal: BatchRecoveryJournal =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid database recovery journal: {error}"))?;
    if journal.format != "amby-database-recovery"
        || journal.format_version != 1
        || !valid_operation_id(&journal.operation_id)
        || ulid::Ulid::from_string(&journal.database_id).is_err()
        || journal.result.as_ref().is_some_and(|result| {
            result.operation_id != journal.operation_id || result.database_id != journal.database_id
        })
    {
        return Err("Invalid database recovery journal header".to_owned());
    }
    Ok(journal)
}

pub(super) fn write_batch_journal(
    path: &Path,
    journal: &BatchRecoveryJournal,
) -> Result<(), String> {
    frontmatter::atomic_write_bytes(path, &journal_bytes(journal)?)
}

fn recover_other_value_batches(
    container: &Path,
    recovery_root: &Path,
    current_operation_id: &str,
) -> Result<(), String> {
    let entries = fs::read_dir(recovery_root).map_err(|error| error.to_string())?;
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json")
            || path.file_stem().and_then(|stem| stem.to_str()) == Some(current_operation_id)
        {
            continue;
        }
        let journal = read_batch_journal(&path)?;
        if journal.status == "planned" || journal.status == "inProgress" {
            rollback_batch_journal(container, &path, journal)?;
        }
    }
    Ok(())
}

/// Outcome of startup recovery for interrupted batch operations.
#[derive(Debug, Default)]
pub struct BatchRecoveryReport {
    pub recovered: usize,
    /// Journals that could not be read or rolled back. They are moved, not
    /// deleted, to `quarantine/` beside the journals together with their
    /// backups, so the evidence survives and the vault still opens.
    pub quarantined: Vec<String>,
}

/// Rolls back every interrupted batch. Every journal is attempted. A journal
/// that is unreadable (corrupt, newer format) or cannot be rolled back (a note
/// changed after the crash, missing backup) must neither disappear nor lock the
/// user out of the vault, so it is quarantined and reported to the caller.
pub fn recover_pending_batches(vault: &Path) -> Result<BatchRecoveryReport, String> {
    let recovery_root = vault
        .join(".amby")
        .join("recovery")
        .join("database_batches");
    let entries = match fs::read_dir(&recovery_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BatchRecoveryReport::default())
        }
        Err(error) => return Err(format!("Cannot read database batch recovery: {error}")),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|error| format!("Cannot read database batch recovery: {error}"))?
            .path();
        if path.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("json")
        {
            paths.push(path);
        }
    }
    paths.sort();
    let mut report = BatchRecoveryReport::default();
    for path in paths {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let failure = match read_batch_journal(&path) {
            Err(error) => Some(error),
            Ok(journal) if journal.status == "planned" || journal.status == "inProgress" => {
                match rollback_batch_journal(vault, &path, journal) {
                    Ok(()) => {
                        report.recovered += 1;
                        None
                    }
                    Err(error) => Some(error),
                }
            }
            Ok(_) => None,
        };
        if let Some(error) = failure {
            quarantine_batch_journal(&recovery_root, &path).map_err(|move_error| {
                format!("{name}: {error}; quarantine failed: {move_error}")
            })?;
            report.quarantined.push(format!("{name}: {error}"));
        }
    }
    Ok(report)
}

/// Moves a stuck journal (and its backup directory, when present) under
/// `quarantine/`. Nothing is deleted. A name collision gets a numeric suffix.
pub(super) fn quarantine_batch_journal(root: &Path, journal: &Path) -> Result<(), String> {
    let quarantine = root.join("quarantine");
    fs::create_dir_all(&quarantine).map_err(|error| error.to_string())?;
    let stem = journal
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .ok_or("Journal has no name")?;
    let mut suffix = 0u32;
    let dir_name = |suffix: u32| {
        if suffix == 0 {
            stem.clone()
        } else {
            format!("{stem}.{suffix}")
        }
    };
    // Pick a suffix free for BOTH the journal file and its backup directory.
    let target_json = loop {
        let candidate = quarantine.join(format!("{}.json", dir_name(suffix)));
        if !candidate.exists() && !quarantine.join(dir_name(suffix)).exists() {
            break candidate;
        }
        suffix += 1;
    };
    let backups = root.join(&stem);
    // A journal literally named `quarantine` would own the quarantine folder
    // itself; never move that directory into itself.
    if backups.is_dir() && stem != "quarantine" {
        fs::rename(&backups, quarantine.join(dir_name(suffix)))
            .map_err(|error| error.to_string())?;
    }
    fs::rename(journal, target_json).map_err(|error| error.to_string())
}

/// All-or-nothing: every step is checked (record revision, backup hash) before
/// the first byte is restored, so a failure can never leave a batch half
/// reverted. Only then are the backups written back.
pub(super) fn rollback_batch_journal(
    container: &Path,
    journal_path: &Path,
    mut journal: BatchRecoveryJournal,
) -> Result<(), String> {
    // Phase 1: read-only preflight.
    let mut restores: Vec<(usize, PathBuf, Vec<u8>)> = Vec::new();
    let mut already_original: Vec<usize> = Vec::new();
    for (index, step) in journal.steps.iter().enumerate() {
        let (record_path, backup_path) =
            recovery_step_paths(container, &journal.operation_id, step)?;
        if !record_path.is_file() {
            continue;
        }
        let current = fs::read(&record_path).map_err(|error| error.to_string())?;
        let current_revision = raw_revision(&current);
        if current_revision == step.original_revision {
            already_original.push(index);
            continue;
        }
        if current_revision != step.target_revision {
            return Err(format!(
                "record changed after the batch: {}",
                record_path.display()
            ));
        }
        let backup = fs::read(&backup_path).map_err(|error| error.to_string())?;
        if raw_revision(&backup) != step.original_revision {
            return Err(format!(
                "recovery backup is corrupt: {}",
                backup_path.display()
            ));
        }
        restores.push((index, record_path, backup));
    }
    // Phase 2: write.
    for index in already_original {
        journal.steps[index].status = "rolledBack".to_owned();
    }
    for (index, record_path, backup) in restores {
        frontmatter::atomic_write_bytes(&record_path, &backup)?;
        journal.steps[index].status = "rolledBack".to_owned();
    }
    journal.status = "rolledBack".to_owned();
    journal.result = None;
    write_batch_journal(journal_path, &journal)
}

pub(super) fn recovery_step_paths(
    container: &Path,
    _operation_id: &str,
    step: &BatchRecoveryStep,
) -> Result<(PathBuf, PathBuf), String> {
    if step.record_path.contains("..") || step.backup_path.contains("..") {
        return Err("Unsafe path in database recovery journal".to_owned());
    }
    let record_path = crate::paths::confine(container, &container.join(&step.record_path))?;
    let backup_path = crate::paths::confine(container, &container.join(&step.backup_path))?;
    Ok((record_path, backup_path))
}

/// Directory that holds value-batch journals and their per-operation backups.
fn recovery_root(vault: &Path) -> PathBuf {
    vault
        .join(".amby")
        .join("recovery")
        .join("database_batches")
}

/// Result stored by an already completed operation, for idempotent replay.
pub(super) fn completed_result(
    vault: &Path,
    operation_id: &str,
) -> Option<DatabaseValueBatchResult> {
    let journal_path = recovery_root(vault).join(format!("{operation_id}.json"));
    let journal = read_batch_journal(&journal_path).ok()?;
    if journal.status == "completed" {
        journal.result
    } else {
        None
    }
}

/// A published recovery point for one batch: journal plus raw backups.
pub(super) struct BatchRecovery {
    vault: PathBuf,
    journal_path: PathBuf,
    backup_dir: PathBuf,
    journal: BatchRecoveryJournal,
}

impl BatchRecovery {
    /// Creates the recovery directory, writes a backup of every note and
    /// publishes the `inProgress` journal. Any failure leaves the notes
    /// untouched and removes the partial recovery state, so the caller can
    /// abort the operation before changing a source file.
    pub(super) fn publish(
        vault: &Path,
        operation_id: &str,
        database_id: &str,
        request_revision: String,
        planned: &[PlannedValueWrite],
    ) -> Result<Self, String> {
        let root = recovery_root(vault);
        fs::create_dir_all(&root)
            .map_err(|error| format!("Cannot create database batch recovery directory: {error}"))?;
        let journal_path = root.join(format!("{operation_id}.json"));
        if let Ok(existing) = read_batch_journal(&journal_path) {
            if existing.status == "planned" || existing.status == "inProgress" {
                // Its backups are the only way back for that operation.
                return Err(format!(
                    "Database operation {operation_id} has an unfinished recovery journal; \
                     reopen the vault to recover it before retrying"
                ));
            }
        }
        // Journals of other interrupted batches are rolled back best-effort. A
        // stuck or unreadable one is quarantined by vault activation and must
        // not block ordinary edits.
        let _ = recover_other_value_batches(vault, &root, operation_id);

        let backup_dir = root.join(operation_id);
        let discard_partial = |backup_dir: &Path| {
            let _ = fs::remove_dir_all(backup_dir);
        };
        fs::create_dir_all(&backup_dir)
            .map_err(|error| format!("Cannot create database batch backup directory: {error}"))?;

        let mut steps = Vec::new();
        for (path, post_bytes, pre_bytes, note_id) in planned {
            let backup_file = backup_dir.join(format!("{note_id}.md"));
            if let Err(error) = frontmatter::atomic_write_bytes(&backup_file, pre_bytes) {
                discard_partial(&backup_dir);
                return Err(format!(
                    "Cannot back up {} before the batch; nothing was changed: {error}",
                    path.display()
                ));
            }
            steps.push(BatchRecoveryStep {
                record_path: relative_to(vault, path),
                backup_path: relative_to(vault, &backup_file),
                original_revision: raw_revision(pre_bytes),
                target_revision: raw_revision(post_bytes),
                status: "planned".to_owned(),
            });
        }

        let journal = BatchRecoveryJournal {
            format: "amby-database-recovery".to_owned(),
            format_version: 1,
            operation_id: operation_id.to_owned(),
            database_id: database_id.to_owned(),
            request_revision,
            status: "inProgress".to_owned(),
            steps,
            result: None,
        };
        if let Err(error) = write_batch_journal(&journal_path, &journal) {
            discard_partial(&backup_dir);
            return Err(format!(
                "Cannot publish the batch recovery journal; nothing was changed: {error}"
            ));
        }
        Ok(Self {
            vault: vault.to_path_buf(),
            journal_path,
            backup_dir,
            journal,
        })
    }

    /// Restores the original bytes after a failed source write. The error
    /// names the journal when the restore itself was incomplete.
    pub(super) fn roll_back(self) -> Result<(), String> {
        rollback_batch_journal(&self.vault, &self.journal_path, self.journal)
    }

    /// Records the outcome and drops the backups. The notes are already written
    /// and confirmed, so a failure to record that is a warning, never an error.
    /// An `inProgress` journal left behind would make the next vault activation
    /// roll the confirmed write back, so it is moved with its backups to
    /// `quarantine/`: kept for manual recovery, never applied automatically.
    pub(super) fn complete(
        mut self,
        mut result: DatabaseValueBatchResult,
    ) -> DatabaseValueBatchResult {
        for step in &mut self.journal.steps {
            step.status = "applied".to_owned();
        }
        self.journal.status = "completed".to_owned();
        self.journal.result = Some(result.clone());
        let Err(error) = write_batch_journal(&self.journal_path, &self.journal) else {
            // A leftover backup directory is harmless: the completed journal
            // no longer references it.
            let _ = fs::remove_dir_all(&self.backup_dir);
            return result;
        };
        let root = recovery_root(&self.vault);
        result
            .warnings
            .push(match quarantine_batch_journal(&root, &self.journal_path) {
                Ok(()) => format!(
                    "The batch was applied but its recovery journal could not be finalized \
                 ({error}); the journal and backups were moved to {}",
                    root.join("quarantine").display()
                ),
                Err(quarantine_error) => format!(
                    "The batch was applied but its recovery journal could not be finalized \
                 ({error}) or quarantined ({quarantine_error}); reopening the vault may roll \
                 this batch back from {}",
                    self.journal_path.display()
                ),
            });
        result
    }
}

fn relative_to(vault: &Path, path: &Path) -> String {
    path.strip_prefix(vault)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
#[path = "value_batch_recovery_test.rs"]
mod tests;
