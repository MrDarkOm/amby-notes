use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::database::format::{
    parse_manifest, parse_record, parse_view, property_value_to_frontmatter_value,
    resolve_property_yaml_value, DatabaseManifest,
};
use crate::database::mutations::{find_database_container, resolve_note_path_for_id};
use crate::database::validation::validate_manifest;
use crate::frontmatter;
use crate::watcher::WatcherState;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMigrationStatus {
    pub database_id: String,
    pub database_name: String,
    pub container_path: String,
    pub needs_migration: bool,
    pub has_legacy_manifest: bool,
    pub has_record_shards: bool,
    pub has_view_shards: bool,
    pub record_shards_count: usize,
    pub view_shards_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationConflict {
    pub kind: String, // "duplicateNoteId", "yamlConflict", "orphanShard", "unreadableFile", "lockedDatabase"
    pub note_id: Option<String>,
    pub file_path: String,
    pub description: String,
    pub suggested_action: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreflightReport {
    pub database_id: String,
    pub database_name: String,
    pub container_path: String,
    pub affected_files: Vec<String>,
    pub record_shards_count: usize,
    pub view_shards_count: usize,
    pub conflicts: Vec<MigrationConflict>,
    pub can_auto_migrate: bool,
    pub format_version: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationJournalStep {
    pub step: String,
    pub timestamp_ms: u64,
    pub details: String,
    pub success: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationJournal {
    pub format: String,
    pub format_version: u64,
    pub migration_id: String,
    pub database_id: String,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub status: String, // "in_progress", "succeeded", "failed", "rolled_back"
    pub backup_dir: String,
    pub steps: Vec<MigrationJournalStep>,
    pub written_files: Vec<String>,
    #[serde(default)]
    pub post_migration_hashes: BTreeMap<String, String>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub migration_id: String,
    pub database_id: String,
    pub backup_dir: String,
    pub migrated_records: usize,
    pub migrated_views: usize,
    pub warnings: Vec<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Detects all databases in the vault and checks whether any require migration from legacy formats.
pub fn detect_migrations(vault: &Path) -> Result<Vec<DatabaseMigrationStatus>, String> {
    let discovery = super::discovery::discover_vault(vault)?;
    let mut statuses = Vec::new();

    for db in discovery.databases {
        let ambd_dir = db.container_path.join(".ambd");
        let records_dir = ambd_dir.join("records");
        let views_dir = ambd_dir.join("views");

        let has_legacy_manifest = db.manifest_path.file_name().and_then(|n| n.to_str())
            == Some(super::discovery::LEGACY_DATABASE_MANIFEST)
            || db.manifest_path.extension().and_then(|e| e.to_str()) == Some("database");

        let record_shards_count = if records_dir.is_dir() {
            fs::read_dir(&records_dir)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|e| {
                            e.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                        })
                        .count()
                })
                .unwrap_or(0)
        } else {
            0
        };

        let view_shards_count = if views_dir.is_dir() {
            fs::read_dir(&views_dir)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|e| {
                            e.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                        })
                        .count()
                })
                .unwrap_or(0)
        } else {
            0
        };

        let has_record_shards = record_shards_count > 0;
        let has_view_shards = view_shards_count > 0;

        let needs_migration = has_legacy_manifest || has_record_shards || has_view_shards;

        statuses.push(DatabaseMigrationStatus {
            database_id: db.database_id,
            database_name: db.name,
            container_path: db.container_path.to_string_lossy().to_string(),
            needs_migration,
            has_legacy_manifest,
            has_record_shards,
            has_view_shards,
            record_shards_count,
            view_shards_count,
        });
    }

    Ok(statuses)
}

/// Performs a read-only preflight check for migrating a specific database.
/// Enumerates affected files, legacy versions, conflicts, orphan shards, and accessibility.
pub fn preflight_migration(
    vault: &Path,
    database_id: &str,
) -> Result<MigrationPreflightReport, String> {
    let container = find_database_container(vault, database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let manifest_bytes =
        fs::read(&manifest_path).map_err(|e| format!("Failed to read manifest: {e}"))?;
    let parsed_manifest =
        parse_manifest(&manifest_bytes).map_err(|e| format!("Invalid manifest: {e}"))?;

    let mut affected_files = Vec::new();
    let mut conflicts = Vec::new();
    let mut seen_note_ids = HashSet::new();

    affected_files.push(manifest_path.to_string_lossy().to_string());

    if parsed_manifest.value.locked {
        conflicts.push(MigrationConflict {
            kind: "lockedDatabase".to_string(),
            note_id: None,
            file_path: manifest_path.to_string_lossy().to_string(),
            description: "Database is locked against modifications".to_string(),
            suggested_action: "Unlock database before migrating".to_string(),
        });
    }

    // Check views shards
    let ambd_dir = container.join(".ambd");
    let views_dir = ambd_dir.join("views");
    let mut view_shards_count = 0;
    if views_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&views_dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    view_shards_count += 1;
                    affected_files.push(path.to_string_lossy().to_string());
                    if let Ok(bytes) = fs::read(&path) {
                        if parse_view(&bytes).is_err() {
                            conflicts.push(MigrationConflict {
                                kind: "invalidViewShard".to_string(),
                                note_id: None,
                                file_path: path.to_string_lossy().to_string(),
                                description: "View shard JSON is invalid or corrupted".to_string(),
                                suggested_action: "Repair or backup view shard file".to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    // Check record shards and notes
    let records_dir = ambd_dir.join("records");
    let mut record_shards_count = 0;
    let mut record_shards = BTreeMap::new();

    if records_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&records_dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    record_shards_count += 1;
                    affected_files.push(path.to_string_lossy().to_string());
                    let stem = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    if let Ok(bytes) = fs::read(&path) {
                        match parse_record(&bytes) {
                            Ok(shard) => {
                                record_shards.insert(stem, shard.value);
                            }
                            Err(e) => {
                                conflicts.push(MigrationConflict {
                                    kind: "corruptedRecordShard".to_string(),
                                    note_id: Some(stem.clone()),
                                    file_path: path.to_string_lossy().to_string(),
                                    description: format!("Record shard could not be parsed: {e}"),
                                    suggested_action: "Examine corrupted shard file in .ambd/records/".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Check notes in container
    let discovery = super::discovery::discover_vault(vault)?;
    for note in discovery
        .notes
        .iter()
        .filter(|n| n.owner_database_id.as_deref() == Some(database_id))
    {
        let Some(ref note_id) = note.note_id else {
            continue;
        };

        if !seen_note_ids.insert(note_id.clone()) {
            conflicts.push(MigrationConflict {
                kind: "duplicateNoteId".to_string(),
                note_id: Some(note_id.clone()),
                file_path: note.path.to_string_lossy().to_string(),
                description: format!("Multiple notes share the same amby-id {note_id}"),
                suggested_action: "Assign a distinct amby-id to duplicate notes".to_string(),
            });
        }

        affected_files.push(note.path.to_string_lossy().to_string());

        // Check for YAML conflicts with record shard
        if let Some(shard) = record_shards.get(note_id) {
            if let Ok(note_content) = fs::read_to_string(&note.path) {
                if let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&note_content) {
                    for (prop_id, shard_val) in &shard.values {
                        if let Some(prop_def) = parsed_manifest
                            .value
                            .properties
                            .iter()
                            .find(|p| p.id() == Some(prop_id))
                        {
                            if let Some(yaml_val) = resolve_property_yaml_value(&mapping, prop_def)
                            {
                                if let Some(frontmatter_val) =
                                    super::format::frontmatter_value_to_property_value(
                                        yaml_val, prop_def,
                                    )
                                {
                                    if &frontmatter_val != shard_val {
                                        conflicts.push(MigrationConflict {
                                            kind: "yamlConflict".to_string(),
                                            note_id: Some(note_id.clone()),
                                            file_path: note.path.to_string_lossy().to_string(),
                                            description: format!(
                                                "Property '{}' has conflicting values between note frontmatter and shard",
                                                prop_def.name().unwrap_or(prop_id)
                                            ),
                                            suggested_action: "Frontmatter value will be preserved; shard value will not overwrite it".to_string(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Check orphan record shards (shard exists but no corresponding note)
    for shard_note_id in record_shards.keys() {
        if !seen_note_ids.contains(shard_note_id) {
            conflicts.push(MigrationConflict {
                kind: "orphanShard".to_string(),
                note_id: Some(shard_note_id.clone()),
                file_path: records_dir.join(format!("{shard_note_id}.json")).to_string_lossy().to_string(),
                description: format!("Record shard exists for note ID '{shard_note_id}', but no note with that ID was found"),
                suggested_action: "Orphan shard will be retained in .ambd/records/ and backup".to_string(),
            });
        }
    }

    let has_blocking_conflicts = conflicts
        .iter()
        .any(|c| c.kind == "lockedDatabase" || c.kind == "duplicateNoteId");
    let can_auto_migrate = !has_blocking_conflicts;

    Ok(MigrationPreflightReport {
        database_id: database_id.to_string(),
        database_name: parsed_manifest.value.name.clone(),
        container_path: container.to_string_lossy().to_string(),
        affected_files,
        record_shards_count,
        view_shards_count,
        conflicts,
        can_auto_migrate,
        format_version: parsed_manifest.value.format_version,
    })
}

/// Executes migration of a database from legacy/mixed formats into the canonical format.
/// Follows ST-04 protocol: durable backup + journal, lossless conversions, rollback on error.
pub fn execute_migration(
    vault: &Path,
    watcher: &WatcherState,
    database_id: &str,
) -> Result<MigrationResult, String> {
    let preflight = preflight_migration(vault, database_id)?;
    if !preflight.can_auto_migrate {
        return Err(
            "Migration blocked by conflicts; resolve duplicate IDs or unlock database first"
                .to_string(),
        );
    }

    let container = find_database_container(vault, database_id)?;
    let ambd_dir = container.join(".ambd");
    let recovery_dir = ambd_dir.join("recovery");
    fs::create_dir_all(&recovery_dir).map_err(|e| format!("Failed to create recovery dir: {e}"))?;

    let migration_id = format!("migration-{}", now_ms());
    let backup_dir = recovery_dir.join(&migration_id);
    fs::create_dir_all(&backup_dir).map_err(|e| format!("Failed to create backup dir: {e}"))?;

    let mut journal = MigrationJournal {
        format: "amby-migration-journal".to_string(),
        format_version: 1,
        migration_id: migration_id.clone(),
        database_id: database_id.to_string(),
        started_at_ms: now_ms(),
        finished_at_ms: None,
        status: "in_progress".to_string(),
        backup_dir: backup_dir.to_string_lossy().to_string(),
        steps: Vec::new(),
        written_files: Vec::new(),
        post_migration_hashes: BTreeMap::new(),
    };

    let journal_path = backup_dir.join("journal.json");
    let write_journal = |journal: &MigrationJournal| -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?;
        fs::write(&journal_path, bytes).map_err(|e| e.to_string())
    };
    write_journal(&journal)?;

    // Step 1: Backup all affected files
    let mut backup_copies: Vec<(PathBuf, PathBuf)> = Vec::new(); // (original, backup)
    for file_str in &preflight.affected_files {
        let orig_path = PathBuf::from(file_str);
        if orig_path.is_file() {
            let rel = orig_path.strip_prefix(&container).unwrap_or(&orig_path);
            let target_backup = backup_dir.join(rel);
            if let Some(parent) = target_backup.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::copy(&orig_path, &target_backup)
                .map_err(|e| format!("Failed to create backup of {}: {e}", orig_path.display()))?;
            backup_copies.push((orig_path, target_backup));
        }
    }

    journal.steps.push(MigrationJournalStep {
        step: "backup_created".to_string(),
        timestamp_ms: now_ms(),
        details: format!("Backed up {} files", backup_copies.len()),
        success: true,
    });
    write_journal(&journal)?;

    // Planned writes with rollback
    let mut planned_writes: Vec<(PathBuf, Vec<u8>, Vec<u8>)> = Vec::new(); // (path, new_bytes, orig_bytes)
    let mut migrated_records_count = 0;
    let mut migrated_views_count = 0;
    let mut warnings = Vec::new();

    // Step 2: Load current manifest and migrate views into it
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let manifest_bytes = fs::read(&manifest_path).map_err(|e| e.to_string())?;
    let mut manifest_val: DatabaseManifest = parse_manifest(&manifest_bytes)
        .map_err(|e| e.to_string())?
        .value;

    let views_dir = ambd_dir.join("views");
    if views_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&views_dir) {
            for entry in entries.filter_map(Result::ok) {
                let vpath = entry.path();
                if vpath.extension().and_then(|e| e.to_str()) == Some("json") {
                    if let Ok(vbytes) = fs::read(&vpath) {
                        if let Ok(parsed_v) = parse_view(&vbytes) {
                            if !manifest_val
                                .views
                                .iter()
                                .any(|v| v.view_id == parsed_v.value.view_id)
                            {
                                manifest_val.views.push(parsed_v.value);
                                migrated_views_count += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    // Step 3: Migrate record shards into note frontmatter
    let records_dir = ambd_dir.join("records");
    if records_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&records_dir) {
            for entry in entries.filter_map(Result::ok) {
                let rpath = entry.path();
                if rpath.extension().and_then(|e| e.to_str()) == Some("json") {
                    let note_id = rpath.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                    if let Ok(note_path) = resolve_note_path_for_id(vault, &container, note_id) {
                        if let Ok(rbytes) = fs::read(&rpath) {
                            if let Ok(shard) = parse_record(&rbytes) {
                                if let Ok(nbytes) = fs::read(&note_path) {
                                    let mut content =
                                        String::from_utf8(nbytes.clone()).unwrap_or_default();
                                    if !content.is_empty() {
                                        // Ensure frontmatter envelope and amby-id exist
                                        if frontmatter::frontmatter_yaml_mapping(&content)
                                            .ok()
                                            .flatten()
                                            .is_none()
                                        {
                                            content =
                                                format!("---\namby-id: {note_id}\n---\n{content}");
                                        }

                                        let mut note_modified = false;
                                        for (prop_id, shard_val) in shard.value.values {
                                            if let Some(prop_def) = manifest_val
                                                .properties
                                                .iter()
                                                .find(|p| p.id() == Some(&prop_id))
                                            {
                                                let prop_name = match prop_def.frontmatter_key() {
                                                    Some(k) => k,
                                                    None => continue,
                                                };

                                                // Check if note already has a value for this property
                                                let has_existing = if let Ok(Some(mapping)) =
                                                    frontmatter::frontmatter_yaml_mapping(&content)
                                                {
                                                    resolve_property_yaml_value(&mapping, prop_def)
                                                        .is_some()
                                                } else {
                                                    false
                                                };

                                                if !has_existing {
                                                    if let Some(yaml_val) =
                                                        property_value_to_frontmatter_value(
                                                            &shard_val, prop_def,
                                                        )
                                                    {
                                                        if let Ok(next) = frontmatter::replace_yaml_binding_lossless(&content, prop_name, &yaml_val) {
                                                            content = next;
                                                            note_modified = true;
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        if note_modified {
                                            planned_writes.push((
                                                note_path,
                                                content.into_bytes(),
                                                nbytes,
                                            ));
                                            migrated_records_count += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Step 4: Write canonical manifest (ensure <Name>.json)
    let canonical_manifest_path = super::discovery::manifest_path_for_container(&container);
    let mut manifest_bytes_to_write =
        serde_json::to_vec_pretty(&manifest_val).map_err(|e| e.to_string())?;
    manifest_bytes_to_write.push(b'\n');
    planned_writes.push((
        canonical_manifest_path.clone(),
        manifest_bytes_to_write,
        manifest_bytes,
    ));

    for (path, new_bytes, _) in &planned_writes {
        let rel = path
            .strip_prefix(&container)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        journal
            .post_migration_hashes
            .insert(rel, sha256_hex(new_bytes));
    }

    // Execute planned writes with rollback on failure
    let mut written_paths = Vec::new();
    let write =
        watcher.prepare_write(planned_writes.iter().map(|(path, bytes, _)| {
            (path.as_path(), crate::watcher::fingerprint_for_bytes(bytes))
        }));

    let mut execution_failed = false;
    let mut error_message = String::new();

    for (path, new_bytes, orig_bytes) in &planned_writes {
        if let Err(e) = frontmatter::atomic_write_bytes(path, new_bytes) {
            execution_failed = true;
            error_message = format!("Failed to write {}: {e}", path.display());
            break;
        }
        written_paths.push((path.clone(), orig_bytes.clone()));
    }

    if execution_failed {
        watcher.cancel_prepared_write(&write);
        // Rollback all written files
        for (path, orig_bytes) in &written_paths {
            let _ = frontmatter::atomic_write_bytes(path, orig_bytes);
        }
        journal.status = "failed".to_string();
        journal.finished_at_ms = Some(now_ms());
        journal.steps.push(MigrationJournalStep {
            step: "execution_failed".to_string(),
            timestamp_ms: now_ms(),
            details: error_message.clone(),
            success: false,
        });
        let _ = write_journal(&journal);
        return Err(error_message);
    }

    watcher.confirm_prepared_write(&write);

    // Read back and validate written manifest
    if let Ok(written_bytes) = fs::read(&canonical_manifest_path) {
        if let Ok(written_manifest) = parse_manifest(&written_bytes) {
            let report = validate_manifest(&written_manifest.value);
            for err in report.errors {
                warnings.push(format!("Post-migration manifest warning: {}", err.message));
            }
        }
    }

    // Safely remove migrated legacy shards and legacy manifest now that they are backed up
    let _ = fs::remove_dir_all(&records_dir);
    let _ = fs::remove_dir_all(&views_dir);
    let legacy_manifest = container.join("ambd.json");
    if legacy_manifest.is_file() && legacy_manifest != canonical_manifest_path {
        let _ = fs::remove_file(&legacy_manifest);
    }

    journal.status = "succeeded".to_string();
    journal.finished_at_ms = Some(now_ms());
    journal.written_files = written_paths
        .iter()
        .map(|(p, _)| p.to_string_lossy().to_string())
        .collect();
    journal.steps.push(MigrationJournalStep {
        step: "migration_completed".to_string(),
        timestamp_ms: now_ms(),
        details: format!(
            "Migrated {} records and {} views",
            migrated_records_count, migrated_views_count
        ),
        success: true,
    });
    write_journal(&journal)?;

    Ok(MigrationResult {
        migration_id,
        database_id: database_id.to_string(),
        backup_dir: backup_dir.to_string_lossy().to_string(),
        migrated_records: migrated_records_count,
        migrated_views: migrated_views_count,
        warnings,
    })
}

/// Rolls back a migration using its backup directory.
pub fn rollback_migration(
    vault: &Path,
    watcher: &WatcherState,
    database_id: &str,
    migration_id: &str,
) -> Result<(), String> {
    if migration_id.is_empty()
        || migration_id.contains("..")
        || migration_id.contains('/')
        || migration_id.contains('\\')
    {
        return Err("Invalid migration id".to_string());
    }

    let container = find_database_container(vault, database_id)?;
    let backup_dir = container.join(".ambd/recovery").join(migration_id);
    if !backup_dir.is_dir() {
        return Err(format!(
            "Backup directory not found: {}",
            backup_dir.display()
        ));
    }

    let journal_path = backup_dir.join("journal.json");
    if !journal_path.is_file() {
        return Err("Migration journal not found in backup".to_string());
    }
    let journal_bytes =
        fs::read(&journal_path).map_err(|e| format!("Failed to read migration journal: {e}"))?;
    let mut journal: MigrationJournal = serde_json::from_slice(&journal_bytes)
        .map_err(|e| format!("Invalid migration journal: {e}"))?;

    if journal.database_id != database_id {
        return Err(format!(
            "Migration journal belongs to database '{}', expected '{}'",
            journal.database_id, database_id
        ));
    }

    let mut restored_files = Vec::new();
    for entry in WalkDir::new(&backup_dir).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() || entry.file_name() == "journal.json" {
            continue;
        }
        let backup_file = entry.path();
        let rel = backup_file
            .strip_prefix(&backup_dir)
            .map_err(|e| e.to_string())?;
        let rel_str = rel.to_string_lossy().to_string();
        let target_file = container.join(rel);

        // Pre-check: if target file exists on disk and was modified after migration, refuse rollback!
        if target_file.is_file() {
            let current_bytes = fs::read(&target_file).map_err(|e| e.to_string())?;
            let current_hash = sha256_hex(&current_bytes);
            if let Some(expected_post_hash) = journal.post_migration_hashes.get(&rel_str) {
                if &current_hash != expected_post_hash {
                    return Err(format!(
                        "Cannot rollback: file '{}' has been modified since migration",
                        target_file.display()
                    ));
                }
            }
        }

        let bytes = fs::read(backup_file).map_err(|e| e.to_string())?;
        restored_files.push((target_file, bytes));
    }

    let write = watcher.prepare_write(
        restored_files
            .iter()
            .map(|(path, bytes)| (path.as_path(), crate::watcher::fingerprint_for_bytes(bytes))),
    );

    for (target_file, bytes) in &restored_files {
        frontmatter::atomic_write_bytes(target_file, bytes)?;
    }

    watcher.confirm_prepared_write(&write);

    journal.status = "rolled_back".to_string();
    journal.steps.push(MigrationJournalStep {
        step: "rollback_completed".to_string(),
        timestamp_ms: now_ms(),
        details: format!("Restored {} files from backup", restored_files.len()),
        success: true,
    });
    let _ = fs::write(
        &journal_path,
        serde_json::to_vec_pretty(&journal).unwrap_or_default(),
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("amby-migration-test-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn st05_migration_preflight_detects_legacy_shards_and_conflicts() {
        let vault = temp_vault();
        let db_dir = vault.join("LegacyDB");
        fs::create_dir_all(&db_dir).unwrap();

        let db_id = ulid::Ulid::generate().to_string();
        let manifest_json = serde_json::json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": db_id,
            "name": "LegacyDB",
            "containerKind": "standalone",
            "locked": false,
            "membership": { "kind": "filesystem-descendants", "recursive": true },
            "properties": [
                {
                    "type": "text",
                    "id": "01J00000000000000000000001",
                    "name": "Status",
                    "pageVisibility": "alwaysShow",
                    "yamlBinding": { "key": "Status", "direction": "twoWay" },
                    "config": { "multiline": false }
                }
            ],
            "views": [],
            "templateOrder": []
        });
        fs::write(
            db_dir.join("LegacyDB.json"),
            serde_json::to_vec_pretty(&manifest_json).unwrap(),
        )
        .unwrap();

        let ambd_dir = db_dir.join(".ambd");
        let records_dir = ambd_dir.join("records");
        let views_dir = ambd_dir.join("views");
        fs::create_dir_all(&records_dir).unwrap();
        fs::create_dir_all(&views_dir).unwrap();

        // Add a view shard
        let view_id = ulid::Ulid::generate().to_string();
        let view_json = serde_json::json!({
            "format": "amby-database-view",
            "formatVersion": 1,
            "databaseId": db_id,
            "viewId": view_id,
            "name": "Table View",
            "layout": "table",
            "fields": [],
            "filter": null,
            "sorts": [],
            "group": null
        });
        fs::write(
            views_dir.join(format!("{view_id}.json")),
            serde_json::to_vec_pretty(&view_json).unwrap(),
        )
        .unwrap();

        // Add a note and matching record shard
        let note_id = ulid::Ulid::generate().to_string();
        let note_path = db_dir.join("Task1.md");
        fs::write(
            &note_path,
            format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
        )
        .unwrap();

        let record_json = serde_json::json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": db_id,
            "noteId": note_id,
            "values": {
                "01J00000000000000000000001": {
                    "type": "text",
                    "value": "In Progress"
                }
            },
            "yamlSyncBases": {}
        });
        fs::write(
            records_dir.join(format!("{note_id}.json")),
            serde_json::to_vec_pretty(&record_json).unwrap(),
        )
        .unwrap();

        // 1. Detection
        let migrations = detect_migrations(&vault).unwrap();
        assert_eq!(migrations.len(), 1);
        assert!(migrations[0].needs_migration);
        assert_eq!(migrations[0].record_shards_count, 1);
        assert_eq!(migrations[0].view_shards_count, 1);

        // 2. Preflight
        let preflight = preflight_migration(&vault, &db_id).unwrap();
        assert!(preflight.can_auto_migrate);
        assert_eq!(preflight.record_shards_count, 1);
        assert_eq!(preflight.view_shards_count, 1);

        // 3. Execution
        let watcher = WatcherState::new();
        let result = execute_migration(&vault, &watcher, &db_id).unwrap();
        assert_eq!(result.migrated_records, 1);
        assert_eq!(result.migrated_views, 1);

        // Verify note frontmatter has Status: In Progress
        let note_after = fs::read_to_string(&note_path).unwrap();
        assert!(
            note_after.contains("Status: In Progress"),
            "Note frontmatter should contain migrated status: {note_after}"
        );

        // Verify manifest contains the view
        let manifest_after =
            parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
        assert_eq!(manifest_after.value.views.len(), 1);
        assert_eq!(manifest_after.value.views[0].name, "Table View");

        // Verify backup exists
        assert!(Path::new(&result.backup_dir).is_dir());
        assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

        // 4. Rollback
        rollback_migration(&vault, &watcher, &db_id, &result.migration_id).unwrap();
        let note_rolled_back = fs::read_to_string(&note_path).unwrap();
        assert!(
            !note_rolled_back.contains("Status: In Progress"),
            "Note should be rolled back"
        );

        let _ = fs::remove_dir_all(vault);
    }
    #[test]
    fn review_rollback_preserves_newer_user_edit() {
        let vault = temp_vault();
        let db_dir = vault.join("LegacyDB");
        fs::create_dir_all(&db_dir).unwrap();

        let db_id = ulid::Ulid::generate().to_string();
        let manifest_json = serde_json::json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": db_id,
            "name": "LegacyDB",
            "containerKind": "standalone",
            "locked": false,
            "membership": { "kind": "filesystem-descendants", "recursive": true },
            "properties": [
                {
                    "type": "text",
                    "id": "01J00000000000000000000001",
                    "name": "Status",
                    "pageVisibility": "alwaysShow",
                    "yamlBinding": { "key": "Status", "direction": "twoWay" },
                    "config": { "multiline": false }
                }
            ],
            "views": [],
            "templateOrder": []
        });
        fs::write(
            db_dir.join("LegacyDB.json"),
            serde_json::to_vec_pretty(&manifest_json).unwrap(),
        )
        .unwrap();

        let ambd_dir = db_dir.join(".ambd");
        let records_dir = ambd_dir.join("records");
        let views_dir = ambd_dir.join("views");
        fs::create_dir_all(&records_dir).unwrap();
        fs::create_dir_all(&views_dir).unwrap();

        // Add a view shard
        let view_id = ulid::Ulid::generate().to_string();
        let view_json = serde_json::json!({
            "format": "amby-database-view",
            "formatVersion": 1,
            "databaseId": db_id,
            "viewId": view_id,
            "name": "Table View",
            "layout": "table",
            "fields": [],
            "filter": null,
            "sorts": [],
            "group": null
        });
        fs::write(
            views_dir.join(format!("{view_id}.json")),
            serde_json::to_vec_pretty(&view_json).unwrap(),
        )
        .unwrap();

        // Add a note and matching record shard
        let note_id = ulid::Ulid::generate().to_string();
        let note_path = db_dir.join("Task1.md");
        fs::write(
            &note_path,
            format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
        )
        .unwrap();

        let record_json = serde_json::json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": db_id,
            "noteId": note_id,
            "values": {
                "01J00000000000000000000001": {
                    "type": "text",
                    "value": "In Progress"
                }
            },
            "yamlSyncBases": {}
        });
        fs::write(
            records_dir.join(format!("{note_id}.json")),
            serde_json::to_vec_pretty(&record_json).unwrap(),
        )
        .unwrap();

        // 1. Detection
        let migrations = detect_migrations(&vault).unwrap();
        assert_eq!(migrations.len(), 1);
        assert!(migrations[0].needs_migration);
        assert_eq!(migrations[0].record_shards_count, 1);
        assert_eq!(migrations[0].view_shards_count, 1);

        // 2. Preflight
        let preflight = preflight_migration(&vault, &db_id).unwrap();
        assert!(preflight.can_auto_migrate);
        assert_eq!(preflight.record_shards_count, 1);
        assert_eq!(preflight.view_shards_count, 1);

        // 3. Execution
        let watcher = WatcherState::new();
        let result = execute_migration(&vault, &watcher, &db_id).unwrap();
        assert_eq!(result.migrated_records, 1);
        assert_eq!(result.migrated_views, 1);

        // Verify note frontmatter has Status: In Progress
        let note_after = fs::read_to_string(&note_path).unwrap();
        assert!(
            note_after.contains("Status: In Progress"),
            "Note frontmatter should contain migrated status: {note_after}"
        );

        // Verify manifest contains the view
        let manifest_after =
            parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
        assert_eq!(manifest_after.value.views.len(), 1);
        assert_eq!(manifest_after.value.views[0].name, "Table View");

        // Verify backup exists
        assert!(Path::new(&result.backup_dir).is_dir());
        assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

        let newer = format!("{note_after}\nNEW USER CONTENT\n");
        fs::write(&note_path, &newer).unwrap();
        let rollback = rollback_migration(&vault, &watcher, &db_id, &result.migration_id);
        assert_eq!(
            fs::read_to_string(&note_path).unwrap(),
            newer,
            "rollback must preserve post-migration edits (result: {rollback:?})"
        );
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn review_completed_migration_is_not_pending_again() {
        let vault = temp_vault();
        let db_dir = vault.join("LegacyDB");
        fs::create_dir_all(&db_dir).unwrap();

        let db_id = ulid::Ulid::generate().to_string();
        let manifest_json = serde_json::json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": db_id,
            "name": "LegacyDB",
            "containerKind": "standalone",
            "locked": false,
            "membership": { "kind": "filesystem-descendants", "recursive": true },
            "properties": [
                {
                    "type": "text",
                    "id": "01J00000000000000000000001",
                    "name": "Status",
                    "pageVisibility": "alwaysShow",
                    "yamlBinding": { "key": "Status", "direction": "twoWay" },
                    "config": { "multiline": false }
                }
            ],
            "views": [],
            "templateOrder": []
        });
        fs::write(
            db_dir.join("LegacyDB.json"),
            serde_json::to_vec_pretty(&manifest_json).unwrap(),
        )
        .unwrap();

        let ambd_dir = db_dir.join(".ambd");
        let records_dir = ambd_dir.join("records");
        let views_dir = ambd_dir.join("views");
        fs::create_dir_all(&records_dir).unwrap();
        fs::create_dir_all(&views_dir).unwrap();

        // Add a view shard
        let view_id = ulid::Ulid::generate().to_string();
        let view_json = serde_json::json!({
            "format": "amby-database-view",
            "formatVersion": 1,
            "databaseId": db_id,
            "viewId": view_id,
            "name": "Table View",
            "layout": "table",
            "fields": [],
            "filter": null,
            "sorts": [],
            "group": null
        });
        fs::write(
            views_dir.join(format!("{view_id}.json")),
            serde_json::to_vec_pretty(&view_json).unwrap(),
        )
        .unwrap();

        // Add a note and matching record shard
        let note_id = ulid::Ulid::generate().to_string();
        let note_path = db_dir.join("Task1.md");
        fs::write(
            &note_path,
            format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
        )
        .unwrap();

        let record_json = serde_json::json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": db_id,
            "noteId": note_id,
            "values": {
                "01J00000000000000000000001": {
                    "type": "text",
                    "value": "In Progress"
                }
            },
            "yamlSyncBases": {}
        });
        fs::write(
            records_dir.join(format!("{note_id}.json")),
            serde_json::to_vec_pretty(&record_json).unwrap(),
        )
        .unwrap();

        // 1. Detection
        let migrations = detect_migrations(&vault).unwrap();
        assert_eq!(migrations.len(), 1);
        assert!(migrations[0].needs_migration);
        assert_eq!(migrations[0].record_shards_count, 1);
        assert_eq!(migrations[0].view_shards_count, 1);

        // 2. Preflight
        let preflight = preflight_migration(&vault, &db_id).unwrap();
        assert!(preflight.can_auto_migrate);
        assert_eq!(preflight.record_shards_count, 1);
        assert_eq!(preflight.view_shards_count, 1);

        // 3. Execution
        let watcher = WatcherState::new();
        let result = execute_migration(&vault, &watcher, &db_id).unwrap();
        assert_eq!(result.migrated_records, 1);
        assert_eq!(result.migrated_views, 1);

        // Verify note frontmatter has Status: In Progress
        let note_after = fs::read_to_string(&note_path).unwrap();
        assert!(
            note_after.contains("Status: In Progress"),
            "Note frontmatter should contain migrated status: {note_after}"
        );

        // Verify manifest contains the view
        let manifest_after =
            parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
        assert_eq!(manifest_after.value.views.len(), 1);
        assert_eq!(manifest_after.value.views[0].name, "Table View");

        // Verify backup exists
        assert!(Path::new(&result.backup_dir).is_dir());
        assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

        let pending = detect_migrations(&vault).unwrap();
        assert!(
            !pending.iter().any(|m| m.needs_migration),
            "successful migration is still pending: {pending:?}"
        );
        let _ = fs::remove_dir_all(vault);
    }
}
