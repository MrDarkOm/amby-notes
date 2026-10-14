//! Cleanup of a creative workshop operation that did not reach its commit point.
//!
//! The commit point is the structure file reaching exactly the planned bytes.
//! Before it, the only things the operation may have left are databases and files
//! it created itself: their manifests are recomputed from the journal and removed
//! only when byte-identical, and a directory is removed only when empty.

use std::fs;
use std::path::Path;

use super::journal::{
    self, read_journal_file, remove_journal, replace_journal, Journal, STATUS_COMPLETED,
    STATUS_IN_PROGRESS,
};
use super::model::{ProjectError, WORKSHOP_FILE_NAME};
use super::presets::template_file_bytes;
use crate::database::discovery::manifest_path_for_container;
use crate::database::format::raw_revision;
use crate::database::mutations::{new_database_manifest_bytes, PlannedDatabaseIds};
use crate::durable;
use crate::watcher::is_amby_temporary_file;

const LABEL: &str = "Creative recovery";

fn remove_temporary_files(directory: &Path) {
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            if is_amby_temporary_file(&entry.path()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Rollback {
    Clean,
    Committed,
    Leftovers(Vec<String>),
}

pub fn has_committed(vault: &Path, journal: &Journal) -> Result<bool, ProjectError> {
    if let (Some(rel_path), Some(expected_rev)) = (
        &journal.plan.story_file_path,
        &journal.plan.story_file_revision,
    ) {
        let story_file = durable::guarded_path(vault, rel_path, LABEL)
            .map_err(|message| ProjectError::failed("projectJournal", message))?;
        if fs::read(&story_file).is_ok_and(|bytes| raw_revision(&bytes) == *expected_rev) {
            return Ok(true);
        }
    }

    if let (Some(w_path), Some(expected_rev)) = (
        &journal.plan.workshop_path,
        &journal.plan.workshop_file_revision,
    ) {
        let workshop_dir = durable::guarded_path(vault, w_path, LABEL)
            .map_err(|message| ProjectError::failed("projectJournal", message))?;
        if fs::read(workshop_dir.join(WORKSHOP_FILE_NAME))
            .is_ok_and(|bytes| raw_revision(&bytes) == *expected_rev)
        {
            return Ok(true);
        }
    }

    Ok(false)
}

pub fn rollback(vault: &Path, journal: &Journal) -> Result<Rollback, ProjectError> {
    journal::validate_journal(journal)?;
    if has_committed(vault, journal)? {
        return Ok(Rollback::Committed);
    }
    let mut leftovers = Vec::new();

    // 1. Roll back manifest modifications (e.g. text levels / status updates)
    if let Some(mw) = &journal.plan.manifest_write {
        let manifest_path = durable::guarded_path(vault, &mw.manifest_path, LABEL)
            .map_err(|message| ProjectError::failed("projectJournal", message))?;
        if let Some(parent) = manifest_path.parent() {
            remove_temporary_files(parent);
        }
        match fs::read(&manifest_path) {
            Ok(bytes) if bytes == mw.pre_text.as_bytes() => {}
            Ok(bytes) if bytes == mw.post_text.as_bytes() => {
                if let Err(error) =
                    crate::frontmatter::atomic_write_bytes(&manifest_path, mw.pre_text.as_bytes())
                {
                    leftovers.push(format!("{}: {error}", mw.manifest_path));
                }
            }
            Ok(_) => {
                leftovers.push(format!("{}: the database was changed", mw.manifest_path));
            }
            Err(error) => {
                leftovers.push(format!("{}: {error}", mw.manifest_path));
            }
        }
    }

    // 2. Roll back created story if present
    if let Some(story) = &journal.plan.story {
        let folder = durable::guarded_path(vault, &story.folder_path, LABEL)
            .map_err(|message| ProjectError::failed("projectJournal", message))?;
        let story_file = durable::guarded_path(vault, &story.story_file_path, LABEL)
            .map_err(|message| ProjectError::failed("projectJournal", message))?;
        let manifest_file = durable::guarded_path(vault, &story.manifest_path, LABEL)
            .map_err(|message| ProjectError::failed("projectJournal", message))?;
        let card_file = durable::guarded_path(vault, &story.card_path, LABEL)
            .map_err(|message| ProjectError::failed("projectJournal", message))?;

        for (file, expected_bytes, desc) in [
            (&story_file, &story.story_file_bytes, "amby-story.json"),
            (&manifest_file, &story.manifest_bytes, "database manifest"),
            (&card_file, &story.card_bytes, "story card note"),
        ] {
            match fs::read(file) {
                Ok(bytes) if bytes == *expected_bytes => {
                    if let Err(error) = fs::remove_file(file) {
                        leftovers.push(format!("{desc}: {error}"));
                    }
                }
                Ok(_) => {
                    leftovers.push(format!("{desc}: modified by user"));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    leftovers.push(format!("{desc}: {e}"));
                }
            }
        }

        remove_temporary_files(&folder);
        if let Err(e) = fs::remove_dir(&folder) {
            if e.kind() != std::io::ErrorKind::NotFound {
                leftovers.push(format!("{}: story folder not empty", story.folder_path));
            }
        }
    }

    // 3. Roll back created sections
    if let Some(w_path) = &journal.plan.workshop_path {
        let workshop_dir = durable::guarded_path(vault, w_path, LABEL)
            .map_err(|message| ProjectError::failed("projectJournal", message))?;

        for section in journal.plan.sections.iter().rev() {
            let container = workshop_dir.join(&section.path);
            match fs::symlink_metadata(&container) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    leftovers.push(format!("{}: not a directory", section.path));
                    continue;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    leftovers.push(format!("{}: {error}", section.path));
                    continue;
                }
            }
            let ids = PlannedDatabaseIds {
                database_id: section.database_id.clone(),
                view_id: section.view_id.clone(),
            };
            let expected =
                new_database_manifest_bytes(&section.name, "standalone", &ids, &section.extras)
                    .map_err(|message| ProjectError::failed("projectJournal", message))?;
            let manifest = manifest_path_for_container(&container);
            let mut clean = true;
            match fs::read(&manifest) {
                Ok(bytes) if bytes == expected => {
                    if let Err(error) = fs::remove_file(&manifest) {
                        leftovers.push(format!("{}: {error}", section.path));
                        clean = false;
                    }
                }
                Ok(_) => {
                    leftovers.push(format!("{}: the database was changed", section.path));
                    clean = false;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    leftovers.push(format!("{}: {error}", section.path));
                    clean = false;
                }
            }
            if !clean {
                continue;
            }

            if let Some(template) = &section.template {
                let directory = container.join(".ambd").join("templates");
                let file = directory.join(format!("{}.json", template.template_id));
                let expected_template = template_file_bytes(&section.database_id, template)
                    .map_err(|message| ProjectError::failed("projectJournal", message))?;
                match fs::read(&file) {
                    Ok(bytes) if bytes == expected_template => {
                        if let Err(error) = fs::remove_file(&file) {
                            leftovers.push(format!("{}: {error}", section.path));
                            continue;
                        }
                    }
                    Ok(_) => {
                        leftovers.push(format!("{}: the template was changed", section.path));
                        continue;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        leftovers.push(format!("{}: {error}", section.path));
                        continue;
                    }
                }
                remove_temporary_files(&directory);
                for service in [directory, container.join(".ambd")] {
                    if let Err(error) = fs::remove_dir(&service) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            leftovers.push(format!("{}: service folder not empty", section.path));
                        }
                    }
                }
            }

            remove_temporary_files(&container);
            if let Err(error) = fs::remove_dir(&container) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    leftovers.push(format!("{}: folder not empty", section.path));
                }
            }
        }

        // 4. Remove workshop marker file if created by this operation
        if journal.plan.creates_workshop_folder {
            let marker = workshop_dir.join(WORKSHOP_FILE_NAME);
            if marker.is_file() {
                let _ = fs::remove_file(marker);
            }
        }

        // 5. Remove workshop folder if created by this operation
        if journal.plan.creates_workshop_folder && leftovers.is_empty() {
            remove_temporary_files(&workshop_dir);
            if let Err(error) = fs::remove_dir(&workshop_dir) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    leftovers.push(format!("{}: workshop folder not empty", w_path));
                }
            }
        }
    }

    Ok(if leftovers.is_empty() {
        Rollback::Clean
    } else {
        Rollback::Leftovers(leftovers)
    })
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ProjectRecoveryReport {
    pub rolled_back: usize,
    pub completed: usize,
    pub quarantined: Vec<String>,
}

fn quarantine(path: &Path) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "journal has no directory".to_owned())?
        .join("quarantine");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "journal has no name".to_owned())?;
    fs::rename(path, directory.join(name)).map_err(|error| error.to_string())
}

pub fn recover_pending_projects(vault: &Path) -> Result<ProjectRecoveryReport, String> {
    let mut report = ProjectRecoveryReport::default();
    for dir in [
        journal::journal_dir(vault),
        journal::legacy_journal_dir(vault),
    ] {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Cannot read recovery: {error}")),
        };
        let mut paths = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("json")
            })
            .collect::<Vec<_>>();
        paths.sort();

        for path in paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let failure = match read_journal_file(&path) {
                Err(error) => Some(error.to_string()),
                Ok(None) => None,
                Ok(Some(journal)) if journal.status == STATUS_COMPLETED => None,
                Ok(Some(mut journal)) => {
                    debug_assert_eq!(journal.status, STATUS_IN_PROGRESS);
                    match rollback(vault, &journal) {
                        Ok(Rollback::Clean) => {
                            remove_journal(vault, &journal.operation_id);
                            report.rolled_back += 1;
                            None
                        }
                        Ok(Rollback::Committed) => {
                            journal.status = STATUS_COMPLETED.to_owned();
                            match replace_journal(vault, &journal) {
                                Ok(()) => {
                                    report.completed += 1;
                                    None
                                }
                                Err(error) => Some(error.to_string()),
                            }
                        }
                        Ok(Rollback::Leftovers(left)) => Some(left.join("; ")),
                        Err(error) => Some(error.to_string()),
                    }
                }
            };
            if let Some(error) = failure {
                quarantine(&path).map_err(|move_error| {
                    format!("{name}: {error}; quarantine failed: {move_error}")
                })?;
                report.quarantined.push(format!("{name}: {error}"));
            }
        }
    }
    Ok(report)
}
