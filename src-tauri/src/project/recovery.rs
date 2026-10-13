//! Cleanup of a project operation that did not reach its commit point.
//!
//! The commit point is the structure file reaching exactly the planned bytes.
//! Before it, the only things the operation may have left are databases it
//! created itself: their manifests are recomputed from the journal and removed
//! only when byte-identical, and a directory is removed only when empty.
//! Anything the user has touched stays, and the operation reports it.

use std::fs;
use std::path::Path;

use super::journal::{
    self, read_journal_file, remove_journal, replace_journal, Journal, STATUS_COMPLETED,
    STATUS_IN_PROGRESS,
};
use super::model::{ProjectError, PROJECT_FILE_NAME};
use super::presets::template_file_bytes;
use crate::database::discovery::manifest_path_for_container;
use crate::database::format::raw_revision;
use crate::database::mutations::{new_database_manifest_bytes, PlannedDatabaseIds};
use crate::durable;
use crate::watcher::is_amby_temporary_file;

const LABEL: &str = "Project recovery";

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
    /// Nothing of the operation remains.
    Clean,
    /// The structure file already has the planned bytes: the operation is done.
    Committed,
    /// Something could not be removed safely and was left in place.
    Leftovers(Vec<String>),
}

pub fn has_committed(vault: &Path, journal: &Journal) -> Result<bool, ProjectError> {
    let project_dir = durable::guarded_path(vault, &journal.plan.project_path, LABEL)
        .map_err(|message| ProjectError::failed("projectJournal", message))?;
    Ok(match fs::read(project_dir.join(PROJECT_FILE_NAME)) {
        Ok(bytes) => raw_revision(&bytes) == journal.plan.project_file_revision,
        Err(_) => false,
    })
}

pub fn rollback(vault: &Path, journal: &Journal) -> Result<Rollback, ProjectError> {
    journal::validate_journal(journal)?;
    if has_committed(vault, journal)? {
        return Ok(Rollback::Committed);
    }
    let project_dir = durable::guarded_path(vault, &journal.plan.project_path, LABEL)
        .map_err(|message| ProjectError::failed("projectJournal", message))?;
    let mut leftovers = Vec::new();

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

    for section in journal.plan.sections.iter().rev() {
        let container = project_dir.join(&section.path);
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
        // The page template of a preset is ours too, when it is the file we wrote.
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
            // Empty service folders go with it; a folder that is not empty stays.
            for service in [directory, container.join(".ambd")] {
                if let Err(error) = fs::remove_dir(&service) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        leftovers
                            .push(format!("{}: the service folder is not empty", section.path));
                    }
                }
            }
            if leftovers
                .iter()
                .any(|entry| entry.starts_with(&format!("{}:", section.path)))
            {
                continue;
            }
        }
        // Temporary files of an interrupted atomic write are ours too.
        if let Ok(entries) = fs::read_dir(&container) {
            for entry in entries.flatten() {
                if is_amby_temporary_file(&entry.path()) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        if let Err(error) = fs::remove_dir(&container) {
            if error.kind() != std::io::ErrorKind::NotFound {
                leftovers.push(format!("{}: the folder is not empty", section.path));
            }
        }
    }

    if journal.plan.creates_project_folder && leftovers.is_empty() {
        if let Ok(entries) = fs::read_dir(&project_dir) {
            for entry in entries.flatten() {
                if is_amby_temporary_file(&entry.path()) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        if let Err(error) = fs::remove_dir(&project_dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                leftovers.push(format!(
                    "{}: the folder is not empty",
                    journal.plan.project_path
                ));
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

/// Runs at vault activation. A journal that cannot be cleaned up or read is
/// moved to `quarantine/` with its evidence and never blocks opening the vault.
pub fn recover_pending_projects(vault: &Path) -> Result<ProjectRecoveryReport, String> {
    let directory = journal::journal_dir(vault);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProjectRecoveryReport::default())
        }
        Err(error) => return Err(format!("Cannot read project recovery: {error}")),
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("json")
        })
        .collect::<Vec<_>>();
    paths.sort();

    let mut report = ProjectRecoveryReport::default();
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
    Ok(report)
}
