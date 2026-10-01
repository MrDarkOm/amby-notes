//! Durable outcomes and conditional crash rollback for Relation value writes.
//! This namespace is not subject to editor draft retention or SQLite rebuilds.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::format::{raw_revision, ExtraFields, MAX_JSON_BYTES};
use super::mutations::{
    RelationPlannedWrite, UpdateDatabaseRelationValueRequest, UpdateDatabaseRelationValueResult,
};
use crate::frontmatter;

const RECOVERY_ROOT: &str = ".amby/recovery/database_relations";

use crate::durable::{self, valid_operation_id};

const LABEL: &str = "Relation recovery";

fn revision_is_valid(value: &str) -> bool {
    durable::valid_revision(value)
}

fn relative_components(relative: &str) -> Result<Vec<&str>, String> {
    durable::relative_components(relative, LABEL)
}

fn guarded_path(vault: &Path, relative: &str) -> Result<PathBuf, String> {
    durable::guarded_path(vault, relative, LABEL)
}

fn relative_string(vault: &Path, path: &Path) -> Result<String, String> {
    durable::relative_string(vault, path, LABEL)
}

fn create_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    durable::create_new(path, bytes, LABEL)
}

use durable::sync_directory;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelationRecoveryStep {
    database_id: String,
    note_id: String,
    record_path: String,
    backup_path: String,
    original_revision: String,
    target_revision: String,
    status: String,
    #[serde(flatten)]
    extra: ExtraFields,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelationRecoveryJournal {
    format: String,
    format_version: u64,
    operation_id: String,
    request: Value,
    request_revision: String,
    status: String,
    steps: Vec<RelationRecoveryStep>,
    result: Option<Value>,
    #[serde(flatten)]
    extra: ExtraFields,
}

pub(super) struct RelationJournal {
    vault: PathBuf,
    path: PathBuf,
    persisted_revision: String,
    journal: RelationRecoveryJournal,
}

fn request_value(request: &UpdateDatabaseRelationValueRequest) -> Result<Value, String> {
    serde_json::to_value(request).map_err(|error| error.to_string())
}

fn request_revision(request: &Value) -> Result<String, String> {
    let mut semantic = request.clone();
    semantic
        .as_object_mut()
        .ok_or("Invalid Relation recovery request")?
        .remove("expectedGeneration");
    Ok(raw_revision(
        &serde_json::to_vec(&semantic).map_err(|error| error.to_string())?,
    ))
}

fn journal_path(vault: &Path, operation_id: &str) -> Result<PathBuf, String> {
    if !valid_operation_id(operation_id) {
        return Err("Invalid Relation operationId".to_owned());
    }
    guarded_path(vault, &format!("{RECOVERY_ROOT}/{operation_id}.json"))
}

fn journal_bytes(journal: &RelationRecoveryJournal) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_JSON_BYTES {
        return Err("Relation recovery journal is too large".to_owned());
    }
    Ok(bytes)
}

fn validate_journal(journal: &RelationRecoveryJournal, path: &Path) -> Result<(), String> {
    if journal.format != "amby-relation-recovery"
        || journal.format_version != 1
        || !valid_operation_id(&journal.operation_id)
        || path.file_stem().and_then(|name| name.to_str()) != Some(&journal.operation_id)
        || !matches!(
            journal.status.as_str(),
            "planned" | "inProgress" | "completed" | "rolledBack"
        )
        || journal.steps.is_empty()
        || request_revision(&journal.request)? != journal.request_revision
    {
        return Err("Invalid or unsupported Relation recovery journal".to_owned());
    }
    let request: UpdateDatabaseRelationValueRequest =
        serde_json::from_value(journal.request.clone()).map_err(|error| error.to_string())?;
    if request.operation_id != journal.operation_id
        || !frontmatter::is_amby_id(&request.database_id)
        || !frontmatter::is_amby_id(&request.note_id)
        || !frontmatter::is_amby_id(&request.property_id)
        || !revision_is_valid(&request.expected_revision)
        || request
            .target_note_ids
            .iter()
            .any(|id| !frontmatter::is_amby_id(id))
    {
        return Err("Invalid Relation recovery request".to_owned());
    }
    let mut records = BTreeSet::new();
    let mut note_ids = BTreeSet::new();
    let mut affected = BTreeSet::new();
    let mut revisions = BTreeSet::new();
    for (index, step) in journal.steps.iter().enumerate() {
        let components = relative_components(&step.record_path)?;
        if !frontmatter::is_amby_id(&step.database_id)
            || !frontmatter::is_amby_id(&step.note_id)
            || !revision_is_valid(&step.original_revision)
            || !revision_is_valid(&step.target_revision)
            || !matches!(step.status.as_str(), "planned" | "applied" | "rolledBack")
            || (journal.status == "completed" && step.status != "applied")
            || (journal.status == "rolledBack" && step.status != "rolledBack")
            || Path::new(&step.record_path)
                .extension()
                .and_then(|ext| ext.to_str())
                != Some("md")
            || components.iter().any(|part| {
                matches!(
                    *part,
                    ".amby" | ".obsidian" | ".git" | ".trash" | ".ambd" | "assets"
                )
            })
            || step.backup_path != format!("{RECOVERY_ROOT}/{}/{index}.bin", journal.operation_id)
            || !records.insert(step.record_path.as_str())
            || !note_ids.insert(step.note_id.as_str())
        {
            return Err("Invalid Relation recovery step".to_owned());
        }
        affected.insert((&step.database_id, &step.note_id));
        revisions.insert((&step.note_id, &step.target_revision));
    }
    let source = &journal.steps[0];
    if source.database_id != request.database_id
        || source.note_id != request.note_id
        || source.original_revision != request.expected_revision
    {
        return Err("Invalid Relation recovery source".to_owned());
    }
    if let Some(value) = &journal.result {
        let result: UpdateDatabaseRelationValueResult =
            serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        let mut requested_targets = Vec::new();
        for id in &request.target_note_ids {
            if !requested_targets.contains(id) {
                requested_targets.push(id.clone());
            }
        }
        // maxItems=1 retains only the first requested target; other supported
        // Relation configurations retain the whole deduplicated request.
        let first_target = requested_targets
            .first()
            .cloned()
            .into_iter()
            .collect::<Vec<_>>();
        if result.operation_id != journal.operation_id
            || result.database_id != request.database_id
            || result.note_id != request.note_id
            || (result.target_note_ids != requested_targets
                && result.target_note_ids != first_target)
            || result
                .target_note_ids
                .iter()
                .any(|id| !frontmatter::is_amby_id(id))
            || result
                .affected_notes
                .iter()
                .map(|note| (&note.database_id, &note.note_id))
                .collect::<BTreeSet<_>>()
                != affected
            || result.affected_notes.len() != affected.len()
            || result
                .revisions
                .iter()
                .map(|revision| (&revision.note_id, &revision.revision))
                .collect::<BTreeSet<_>>()
                != revisions
            || result.revisions.len() != revisions.len()
        {
            return Err("Invalid Relation recovery outcome".to_owned());
        }
    } else if journal.status == "completed" {
        return Err("Completed Relation recovery outcome is missing".to_owned());
    }
    Ok(())
}

fn read_journal_with_revision(path: &Path) -> Result<(RelationRecoveryJournal, String), String> {
    if fs::metadata(path).map_err(|error| error.to_string())?.len() > MAX_JSON_BYTES as u64 {
        return Err("Relation recovery journal is too large".to_owned());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let journal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid Relation recovery journal: {error}"))?;
    validate_journal(&journal, path)?;
    Ok((journal, raw_revision(&bytes)))
}

fn read_journal(path: &Path) -> Result<RelationRecoveryJournal, String> {
    read_journal_with_revision(path).map(|(journal, _)| journal)
}

pub(super) fn replay(
    vault: &Path,
    request: &UpdateDatabaseRelationValueRequest,
) -> Result<Option<UpdateDatabaseRelationValueResult>, String> {
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let path = journal_path(&vault, &request.operation_id)?;
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Ok(None);
    }
    let journal = read_journal(&path)?;
    if journal.request_revision != request_revision(&request_value(request)?)? {
        return Err("Relation operationId was already used for a different request".to_owned());
    }
    match journal.status.as_str() {
        "completed" => serde_json::from_value(journal.result.unwrap())
            .map(Some)
            .map_err(|error| error.to_string()),
        "rolledBack" => Err("Relation operation was rolled back; use a new operationId".to_owned()),
        _ => Err("Relation operation requires recovery before retrying".to_owned()),
    }
}

pub(super) fn ensure_no_pending(vault: &Path) -> Result<(), String> {
    if journals(vault)?
        .iter()
        .any(|journal| matches!(journal.journal.status.as_str(), "planned" | "inProgress"))
    {
        return Err("An unfinished Relation operation requires vault recovery".to_owned());
    }
    Ok(())
}

pub(super) fn prepare(
    vault: &Path,
    request: &UpdateDatabaseRelationValueRequest,
    writes: &[RelationPlannedWrite],
    result: &UpdateDatabaseRelationValueResult,
) -> Result<RelationJournal, String> {
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let path = journal_path(&vault, &request.operation_id)?;
    let backup_root_relative = format!("{RECOVERY_ROOT}/{}", request.operation_id);
    let backup_root = guarded_path(&vault, &backup_root_relative)?;
    let request = request_value(request)?;
    let steps = writes
        .iter()
        .enumerate()
        .map(|(index, write)| {
            Ok(RelationRecoveryStep {
                database_id: write.affected_note.database_id.clone(),
                note_id: write.affected_note.note_id.clone(),
                record_path: relative_string(&vault, &write.path)?,
                backup_path: format!("{backup_root_relative}/{index}.bin"),
                original_revision: raw_revision(&write.pre_bytes),
                target_revision: raw_revision(&write.post_bytes),
                status: "planned".to_owned(),
                extra: Default::default(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let journal = RelationRecoveryJournal {
        format: "amby-relation-recovery".to_owned(),
        format_version: 1,
        operation_id: result.operation_id.clone(),
        request_revision: request_revision(&request)?,
        request,
        status: "inProgress".to_owned(),
        steps,
        result: Some(serde_json::to_value(result).map_err(|error| error.to_string())?),
        extra: Default::default(),
    };
    validate_journal(&journal, &path)?;
    let bytes = journal_bytes(&journal)?;
    // Validate all paths and source bytes before creating any backups.
    for (step, write) in journal.steps.iter().zip(writes) {
        let record = guarded_path(&vault, &step.record_path)?;
        guarded_path(&vault, &step.backup_path)?;
        if fs::read(record).map_err(|error| error.to_string())? != write.pre_bytes {
            return Err("Relation record changed before journal preparation".to_owned());
        }
    }
    let recovery_root = guarded_path(&vault, RECOVERY_ROOT)?;
    fs::create_dir_all(&recovery_root).map_err(|error| error.to_string())?;
    guarded_path(&vault, RECOVERY_ROOT)?;
    // Publishing a synced file is insufficient if a newly created ancestor's
    // directory entry has not reached disk yet.
    for relative in [".amby", ".amby/recovery", RECOVERY_ROOT] {
        let directory = guarded_path(&vault, relative)?;
        sync_directory(
            directory
                .parent()
                .ok_or("Invalid Relation recovery directory")?,
        )?;
    }
    fs::create_dir(&backup_root)
        .map_err(|error| format!("Cannot create Relation backup directory: {error}"))?;
    guarded_path(&vault, &backup_root_relative)?;
    sync_directory(&recovery_root)?;
    for (step, write) in journal.steps.iter().zip(writes) {
        let backup = guarded_path(&vault, &step.backup_path)?;
        create_new(&backup, &write.pre_bytes)?;
        if fs::read(backup).map_err(|error| error.to_string())? != write.pre_bytes {
            return Err("Relation backup verification failed".to_owned());
        }
    }
    let path = journal_path(&vault, &journal.operation_id)?;
    create_new(&path, &bytes)?;
    Ok(RelationJournal {
        vault,
        path,
        persisted_revision: raw_revision(&bytes),
        journal,
    })
}

impl RelationJournal {
    pub(super) fn check_revision(&self) -> Result<(), String> {
        let path = journal_path(&self.vault, &self.journal.operation_id)?;
        if path != self.path {
            return Err("Relation journal path changed".to_owned());
        }
        let current = fs::read(&path).map_err(|error| error.to_string())?;
        if raw_revision(&current) != self.persisted_revision {
            return Err("Relation recovery journal changed externally".to_owned());
        }
        Ok(())
    }

    fn write(&mut self) -> Result<(), String> {
        self.check_revision()?;
        let bytes = journal_bytes(&self.journal)?;
        frontmatter::atomic_write_bytes(&self.path, &bytes)?;
        self.persisted_revision = raw_revision(&bytes);
        Ok(())
    }

    pub(super) fn applied(&mut self, index: usize) -> Result<(), String> {
        self.journal.steps[index].status = "applied".to_owned();
        self.write()
    }

    pub(super) fn completed(&mut self) -> Result<(), String> {
        self.journal.status = "completed".to_owned();
        self.write()
    }

    pub(super) fn rolled_back(&mut self) -> Result<(), String> {
        for step in &mut self.journal.steps {
            step.status = "rolledBack".to_owned();
        }
        self.journal.status = "rolledBack".to_owned();
        self.journal.result = None;
        self.write()
    }
}

fn journals(vault: &Path) -> Result<Vec<RelationJournal>, String> {
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let root = guarded_path(&vault, RECOVERY_ROOT)?;
    if !root.try_exists().map_err(|error| error.to_string())? {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    let mut journals = Vec::new();
    for path in paths {
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let relative = relative_string(&vault, &path)?;
        guarded_path(&vault, &relative)?;
        let (journal, persisted_revision) = read_journal_with_revision(&path)?;
        journals.push(RelationJournal {
            vault: vault.clone(),
            path,
            persisted_revision,
            journal,
        });
    }
    Ok(journals)
}

struct RestoreStep {
    path: PathBuf,
    original: Vec<u8>,
    current_revision: String,
}

/// Opaque read-only recovery plan shared with vault activation so value and
/// schema journals can both be preflighted before either namespace is
/// restored. The fields intentionally remain private to this module.
pub(crate) struct PendingRelationRecovery {
    journal: RelationJournal,
    restore: Vec<RestoreStep>,
}

fn preflight_restore(journal: &RelationJournal) -> Result<Vec<RestoreStep>, String> {
    journal.check_revision()?;
    let mut restore = Vec::new();
    for step in &journal.journal.steps {
        let path = guarded_path(&journal.vault, &step.record_path)?;
        let backup = guarded_path(&journal.vault, &step.backup_path)?;
        let original =
            fs::read(backup).map_err(|error| format!("Relation backup unavailable: {error}"))?;
        if raw_revision(&original) != step.original_revision {
            return Err(format!(
                "Relation backup is corrupt for note {}",
                step.note_id
            ));
        }
        let content = std::str::from_utf8(&original).map_err(|error| error.to_string())?;
        if frontmatter::parse_markdown(content).note_id() != Some(step.note_id.as_str()) {
            return Err("Relation backup note identity does not match".to_owned());
        }
        let current =
            fs::read(&path).map_err(|error| format!("Relation record unavailable: {error}"))?;
        let current_revision = raw_revision(&current);
        if current_revision != step.original_revision && current_revision != step.target_revision {
            return Err(format!(
                "Relation note {} changed after the operation; recovery refused",
                step.note_id
            ));
        }
        let content = std::str::from_utf8(&current).map_err(|error| error.to_string())?;
        if frontmatter::parse_markdown(content).note_id() != Some(step.note_id.as_str()) {
            return Err("Relation record note identity does not match".to_owned());
        }
        restore.push(RestoreStep {
            path,
            original,
            current_revision,
        });
    }
    journal.check_revision()?;
    Ok(restore)
}

/// Validate every pending operation before any restoration. Restore exact pre
/// bytes, not a reserialized YAML value; completed outcomes remain untouched.
pub(crate) fn prepare_pending_relations(
    vault: &Path,
) -> Result<Vec<PendingRelationRecovery>, String> {
    let journals = journals(vault)?;
    let mut pending = Vec::new();
    let mut records = BTreeSet::new();
    for journal in journals {
        if !matches!(journal.journal.status.as_str(), "planned" | "inProgress") {
            continue;
        }
        let restore = preflight_restore(&journal)?;
        for step in &restore {
            if !records.insert(step.path.clone()) {
                return Err("Overlapping pending Relation journals".to_owned());
            }
        }
        pending.push(PendingRelationRecovery { journal, restore });
    }
    Ok(pending)
}

pub(crate) fn restore_prepared_relations(
    pending: Vec<PendingRelationRecovery>,
) -> Result<usize, String> {
    let count = pending.len();
    for PendingRelationRecovery {
        mut journal,
        restore,
    } in pending
    {
        for (index, step) in restore.into_iter().enumerate().rev() {
            journal.check_revision()?;
            let relative = relative_string(&journal.vault, &step.path)?;
            let path = guarded_path(&journal.vault, &relative)?;
            let current = fs::read(&path).map_err(|error| error.to_string())?;
            if raw_revision(&current) != step.current_revision {
                return Err("Relation record changed during recovery".to_owned());
            }
            if current != step.original {
                frontmatter::atomic_write_bytes(&path, &step.original)?;
            }
            journal.journal.steps[index].status = "rolledBack".to_owned();
            journal.write()?;
        }
        journal.rolled_back()?;
    }
    Ok(count)
}

#[allow(dead_code)]
pub fn recover_pending_relations(vault: &Path) -> Result<usize, String> {
    let pending = prepare_pending_relations(vault)?;
    restore_prepared_relations(pending)
}

#[cfg(test)]
#[path = "relation_recovery_test.rs"]
mod tests;
