use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use ulid::Ulid;
use walkdir::WalkDir;

use super::scan::*;
use crate::frontmatter;

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultPreflight {
    pub notes: usize,
    pub attachments: usize,
    pub malformed_frontmatter: Vec<String>,
    pub user_managed_ids: Vec<String>,
    pub duplicate_ids: Vec<String>,
    pub planned_id_writes: Vec<String>,
    pub unfinished_migrations: Vec<IdMigrationRecovery>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdMigrationResult {
    pub backup_path: String,
    pub journal_path: String,
    pub modified_paths: Vec<String>,
    pub status: IdMigrationStatus,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum IdMigrationStatus {
    Planned,
    InProgress,
    Completed,
    RolledBack,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum IdMigrationFileStatus {
    Pending,
    BackupCreated,
    Applied,
    RolledBack,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum IdMigrationRecoveryAction {
    Resume,
    Rollback,
    InspectOnly,
}

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdMigrationFile {
    pub path: String,
    pub backup_path: String,
    pub id: String,
    pub status: IdMigrationFileStatus,
}

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdMigrationJournal {
    pub version: u8,
    pub kind: String,
    pub created_at_ms: u128,
    pub backup_path: String,
    pub status: IdMigrationStatus,
    pub files: Vec<IdMigrationFile>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCompletedIdMigrationJournal {
    pub version: u8,
    pub kind: String,
    #[serde(rename = "createdAtMs")]
    pub _created_at_ms: u128,
    #[serde(rename = "backupPath")]
    pub _backup_path: String,
    #[serde(rename = "modifiedPaths")]
    pub _modified_paths: Vec<String>,
}

#[derive(Debug)]
pub enum StoredIdMigrationJournal {
    Recoverable(IdMigrationJournal),
    LegacyCompleted(LegacyCompletedIdMigrationJournal),
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdMigrationRecovery {
    pub journal_path: String,
    pub backup_path: String,
    pub status: IdMigrationStatus,
    pub files: Vec<IdMigrationFile>,
}

pub const ID_MIGRATION_VERSION: u8 = 2;
pub const ID_MIGRATION_KIND: &str = "add-amby-ids";

#[cfg(test)]
thread_local! {
    static MIGRATION_FAILURE_STAGE: Cell<Option<u8>> = const { Cell::new(None) };
}

#[cfg(test)]
pub fn fail_next_migration_stage(stage: u8) {
    MIGRATION_FAILURE_STAGE.with(|configured| configured.set(Some(stage)));
}

#[cfg(test)]
pub fn check_migration_failure(stage: u8) -> Result<(), String> {
    MIGRATION_FAILURE_STAGE.with(|configured| {
        if configured.get() == Some(stage) {
            configured.set(None);
            Err(format!("injected migration failure at stage {stage}"))
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
pub fn check_migration_failure(_stage: u8) -> Result<(), String> {
    Ok(())
}

pub fn migration_directory(vault: &Path) -> PathBuf {
    vault.join(".amby").join("migrations")
}

pub fn write_migration_journal(path: &Path, journal: &IdMigrationJournal) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Migration journal has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let encoded = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    frontmatter::atomic_write_bytes(path, &encoded)
}

pub fn read_migration_journal(path: &Path) -> Result<StoredIdMigrationJournal, String> {
    let encoded = fs::read(path).map_err(|error| error.to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&encoded)
        .map_err(|error| format!("Invalid migration journal: {error}"))?;
    let journal = if value.get("status").is_some() || value.get("files").is_some() {
        StoredIdMigrationJournal::Recoverable(
            serde_json::from_value(value)
                .map_err(|error| format!("Invalid migration journal: {error}"))?,
        )
    } else {
        StoredIdMigrationJournal::LegacyCompleted(
            serde_json::from_value(value)
                .map_err(|error| format!("Invalid migration journal: {error}"))?,
        )
    };
    let (version, kind) = match &journal {
        StoredIdMigrationJournal::Recoverable(journal) => (journal.version, &journal.kind),
        StoredIdMigrationJournal::LegacyCompleted(journal) => (journal.version, &journal.kind),
    };
    if !matches!(version, 1 | ID_MIGRATION_VERSION) || kind != ID_MIGRATION_KIND {
        return Err(format!("Unsupported migration journal: {}", path.display()));
    }
    Ok(journal)
}

pub fn recovery_from_journal(path: &Path, journal: &IdMigrationJournal) -> IdMigrationRecovery {
    IdMigrationRecovery {
        journal_path: path_string(path),
        backup_path: journal.backup_path.clone(),
        status: journal.status.clone(),
        files: journal.files.clone(),
    }
}

pub fn unfinished_id_migrations(vault: &Path) -> Result<Vec<IdMigrationRecovery>, String> {
    let directory = migration_directory(vault);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut recoveries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let StoredIdMigrationJournal::Recoverable(journal) = read_migration_journal(&path)? else {
            continue;
        };
        if matches!(
            journal.status,
            IdMigrationStatus::Planned | IdMigrationStatus::InProgress
        ) {
            recoveries.push(recovery_from_journal(&path, &journal));
        }
    }
    recoveries.sort_by(|left, right| left.journal_path.cmp(&right.journal_path));
    Ok(recoveries)
}

pub fn checked_journal_path(vault: &Path, journal_path: &str) -> Result<PathBuf, String> {
    let directory = migration_directory(vault)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let candidate = PathBuf::from(journal_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if candidate
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("json")
        || candidate.strip_prefix(&directory).is_err()
    {
        return Err("Migration journal is outside this vault".to_string());
    }
    Ok(candidate)
}

pub fn apply_migration_journal(
    vault: &Path,
    journal_path: &Path,
    journal: &mut IdMigrationJournal,
) -> Result<(), String> {
    if matches!(journal.status, IdMigrationStatus::Completed) {
        return Ok(());
    }
    if matches!(journal.status, IdMigrationStatus::RolledBack) {
        return Err("Cannot resume a rolled-back migration".to_string());
    }
    journal.status = IdMigrationStatus::InProgress;
    write_migration_journal(journal_path, journal)?;

    let backup_root = abs_from_rel(vault, &journal.backup_path);
    for index in 0..journal.files.len() {
        let file = &journal.files[index];
        let source = abs_from_rel(vault, &file.path);
        let backup = backup_root.join(&file.backup_path);
        let file_path = file.path.clone();
        let file_id = file.id.clone();
        let status = file.status.clone();
        if matches!(status, IdMigrationFileStatus::Applied) {
            continue;
        }
        if matches!(status, IdMigrationFileStatus::RolledBack) {
            return Err(format!("Cannot resume rolled-back note: {file_path}"));
        }

        if matches!(status, IdMigrationFileStatus::Pending) {
            let original = fs::read(&source).map_err(|error| error.to_string())?;
            if let Some(parent) = backup.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            match frontmatter::atomic_write_bytes_new(&backup, &original) {
                Ok(()) | Err(frontmatter::AtomicCreateError::AlreadyExists) => {}
                Err(frontmatter::AtomicCreateError::Other(error)) => return Err(error),
            }
            check_migration_failure(1)?;
            journal.files[index].status = IdMigrationFileStatus::BackupCreated;
            write_migration_journal(journal_path, journal)?;
        }

        let original = fs::read(&backup).map_err(|error| error.to_string())?;
        let current = fs::read(&source).map_err(|error| error.to_string())?;
        let outputs = migration_outputs(&original, &file_id, journal.version)
            .map_err(|error| format!("{file_path}: {error}"))?;
        if outputs.contains(&current) {
            journal.files[index].status = IdMigrationFileStatus::Applied;
            write_migration_journal(journal_path, journal)?;
            continue;
        }
        if current != original {
            return Err(format!(
                "Refusing to overwrite a note changed after its migration backup: {}",
                file_path
            ));
        }
        let original_text = std::str::from_utf8(&original).map_err(|error| error.to_string())?;
        let next = frontmatter::body_with_id(original_text, &file_id)?;
        frontmatter::atomic_write_bytes(&source, next.as_bytes())?;
        check_migration_failure(2)?;
        journal.files[index].status = IdMigrationFileStatus::Applied;
        write_migration_journal(journal_path, journal)?;
    }

    journal.status = IdMigrationStatus::Completed;
    write_migration_journal(journal_path, journal)
}

fn migration_outputs(original: &[u8], id: &str, version: u8) -> Result<Vec<Vec<u8>>, String> {
    if !is_amby_id(id) {
        return Err("Invalid planned migration ID".into());
    }
    let content = std::str::from_utf8(original).map_err(|e| e.to_string())?;
    let parsed = frontmatter::parse_markdown(content);
    if parsed.migration_id().is_some_and(|existing| existing != id) {
        return Err("Migration would change an existing identity".into());
    }
    let mut outputs = Vec::new();
    match frontmatter::body_with_id(content, id) {
        Ok(next) => outputs.push(next.into_bytes()),
        Err(error) if version != 1 => return Err(error),
        Err(_) => {}
    }
    if version == 1 {
        outputs.extend(frontmatter::legacy_migration_outputs(content, id)?);
    }
    Ok(outputs)
}

pub fn rollback_migration_journal(
    vault: &Path,
    journal_path: &Path,
    journal: &mut IdMigrationJournal,
) -> Result<(), String> {
    if matches!(journal.status, IdMigrationStatus::RolledBack) {
        return Ok(());
    }
    let backup_root = abs_from_rel(vault, &journal.backup_path);
    for index in 0..journal.files.len() {
        let file = &journal.files[index];
        let file_path = file.path.clone();
        let file_id = file.id.clone();
        let backup_path = file.backup_path.clone();
        if matches!(file.status, IdMigrationFileStatus::RolledBack) {
            continue;
        }
        let source = abs_from_rel(vault, &file_path);
        let backup = backup_root.join(&backup_path);
        if !backup.is_file() {
            if matches!(file.status, IdMigrationFileStatus::Pending) {
                // No backup means this file has not reached a write boundary.
                journal.files[index].status = IdMigrationFileStatus::RolledBack;
                write_migration_journal(journal_path, journal)?;
                continue;
            }
            return Err(format!("Migration backup is missing: {}", backup.display()));
        }
        let original = fs::read(&backup).map_err(|error| error.to_string())?;
        let current = fs::read(&source).map_err(|error| error.to_string())?;
        if current != original {
            let outputs = migration_outputs(&original, &file_id, journal.version)?;
            if !outputs.contains(&current) {
                return Err(format!(
                    "Refusing to roll back a note changed after migration: {}",
                    file_path
                ));
            }
            frontmatter::atomic_write_bytes(&source, &original)?;
        }
        journal.files[index].status = IdMigrationFileStatus::RolledBack;
        write_migration_journal(journal_path, journal)?;
    }
    journal.status = IdMigrationStatus::RolledBack;
    write_migration_journal(journal_path, journal)
}

pub fn preflight_vault(vault: &Path) -> Result<VaultPreflight, String> {
    if !vault.is_dir() {
        return Err(format!("Not a directory: {}", path_string(vault)));
    }
    let mut report = VaultPreflight {
        notes: 0,
        attachments: 0,
        malformed_frontmatter: Vec::new(),
        user_managed_ids: Vec::new(),
        duplicate_ids: Vec::new(),
        planned_id_writes: Vec::new(),
        unfinished_migrations: unfinished_id_migrations(vault)?,
    };
    let mut ids = HashMap::<String, String>::new();
    let mut duplicates = HashSet::new();
    let mut planned = Vec::new();

    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(should_descend)
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_markdown(path) || file_name(path) == "Metadata.md" {
            report.attachments += 1;
            continue;
        }
        let rel_path = path
            .strip_prefix(vault)
            .map(normalize_rel_path)
            .map_err(|e| e.to_string())?;
        report.notes += 1;
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        let parsed = frontmatter::parse_markdown(&content);
        if parsed.has_frontmatter && !parsed.yaml_is_map {
            report.malformed_frontmatter.push(rel_path);
            continue;
        }
        if parsed.identity_error.is_some() {
            report.user_managed_ids.push(rel_path);
            continue;
        }
        if let Some(id) = parsed.migration_id() {
            if let Some(first_path) = ids.insert(id.to_string(), rel_path.clone()) {
                duplicates.insert(id.to_string());
                report
                    .duplicate_ids
                    .push(format!("{id}: {first_path}, {rel_path}"));
            }
        }
        if parsed.id.is_none() {
            let id = parsed
                .legacy_id
                .clone()
                .unwrap_or_else(|| Ulid::generate().to_string());
            if frontmatter::body_with_id(&content, &id).is_ok() {
                planned.push((rel_path, id));
            } else {
                report.malformed_frontmatter.push(rel_path);
            }
        }
    }
    report.planned_id_writes = planned
        .into_iter()
        .filter(|(_, id)| !duplicates.contains(id))
        .map(|(path, _)| path)
        .collect();
    report.planned_id_writes.sort();
    Ok(report)
}

pub fn recover_id_migration(
    vault: &Path,
    journal_path: &str,
    action: IdMigrationRecoveryAction,
) -> Result<IdMigrationRecovery, String> {
    let journal_path = checked_journal_path(vault, journal_path)?;
    let StoredIdMigrationJournal::Recoverable(mut journal) = read_migration_journal(&journal_path)?
    else {
        return Err(
            "This legacy migration was already completed and needs no recovery".to_string(),
        );
    };
    match action {
        IdMigrationRecoveryAction::InspectOnly => {}
        IdMigrationRecoveryAction::Resume => {
            apply_migration_journal(vault, &journal_path, &mut journal)?
        }
        IdMigrationRecoveryAction::Rollback => {
            rollback_migration_journal(vault, &journal_path, &mut journal)?
        }
    }
    Ok(recovery_from_journal(&journal_path, &journal))
}

pub fn apply_id_migration(vault: &Path) -> Result<IdMigrationResult, String> {
    if let Some(recovery) = unfinished_id_migrations(vault)?.into_iter().next() {
        return Err(format!(
            "An unfinished ID migration must be recovered first: {}",
            recovery.journal_path
        ));
    }
    let preflight = preflight_vault(vault)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let backup_relative = format!(".amby/backups/id-migration-{stamp}-{}", Ulid::generate());
    let journal_path =
        migration_directory(vault).join(format!("id-migration-{stamp}-{}.json", Ulid::generate()));
    let mut journal = IdMigrationJournal {
        version: ID_MIGRATION_VERSION,
        kind: ID_MIGRATION_KIND.to_string(),
        created_at_ms: stamp,
        backup_path: backup_relative.clone(),
        status: IdMigrationStatus::Planned,
        files: preflight
            .planned_id_writes
            .iter()
            .map(|path| {
                Ok(IdMigrationFile {
                    path: path.clone(),
                    backup_path: path.clone(),
                    id: frontmatter::read_markdown(&abs_from_rel(vault, path))?
                        .legacy_id
                        .unwrap_or_else(|| Ulid::generate().to_string()),
                    status: IdMigrationFileStatus::Pending,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
    };
    write_migration_journal(&journal_path, &journal)?;
    apply_migration_journal(vault, &journal_path, &mut journal)?;
    Ok(IdMigrationResult {
        backup_path: path_string(&abs_from_rel(vault, &backup_relative)),
        journal_path: path_string(&journal_path),
        modified_paths: journal.files.iter().map(|file| file.path.clone()).collect(),
        status: journal.status,
    })
}
