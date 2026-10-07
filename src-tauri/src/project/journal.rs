//! The durable journal of a project operation (`.amby/recovery/projects/`).
//!
//! The journal is data only: IDs, relative paths and one precomputed answer.
//! It is written before the first artifact exists, so a crash can always be
//! cleaned up, and it is untrusted input when read back.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::ProjectError;
use super::presets::PlannedTemplate;
use crate::database::mutations::NewDatabaseExtras;
use crate::durable::{self, valid_operation_id};
use crate::frontmatter;

pub const JOURNAL_FORMAT: &str = "amby-project-operation";
pub const JOURNAL_VERSION: u64 = 1;
pub const STATUS_IN_PROGRESS: &str = "inProgress";
pub const STATUS_COMPLETED: &str = "completed";
pub const OP_CREATE_PROJECT: &str = "createProject";
pub const OP_CREATE_SECTION: &str = "createSection";
const LABEL: &str = "Project recovery";
const MAX_JOURNAL_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedSection {
    pub id: String,
    pub role: Option<String>,
    pub group_id: Option<String>,
    /// Section name, which is also its folder name.
    pub name: String,
    /// Folder relative to the project folder; always equal to `name`.
    pub path: String,
    pub database_id: String,
    pub view_id: String,
    /// What the database is created with beyond an empty table (the text schema, a preset's
    /// properties, view and icon), fixed before the first write so a cleanup recomputes the
    /// exact manifest.
    #[serde(default)]
    pub extras: NewDatabaseExtras,
    /// The page template written next to the manifest (a preset's dossier headings).
    #[serde(default)]
    pub template: Option<PlannedTemplate>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub project_id: String,
    /// Vault-relative project folder.
    pub project_path: String,
    /// The folder does not exist yet and belongs to this operation.
    pub creates_project_folder: bool,
    /// Revision of the structure file once the operation has committed. The
    /// file reaching exactly these bytes is the commit point.
    pub project_file_revision: String,
    pub sections: Vec<PlannedSection>,
    /// The `text` block the structure file gets together with the text database.
    #[serde(default)]
    pub text_block: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub format: String,
    pub format_version: u64,
    pub operation_id: String,
    pub operation: String,
    pub request_revision: String,
    pub status: String,
    pub plan: Plan,
    /// The answer the caller gets, fixed at planning time: every ID and
    /// revision is known before the first write.
    pub expected_result: Value,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub fn journal_dir(vault: &Path) -> PathBuf {
    vault.join(".amby").join("recovery").join("projects")
}

pub fn journal_path(vault: &Path, operation_id: &str) -> PathBuf {
    journal_dir(vault).join(format!("{operation_id}.json"))
}

fn failure(message: impl Into<String>) -> ProjectError {
    ProjectError::failed("projectJournal", message)
}

pub fn journal_bytes(journal: &Journal) -> Result<Vec<u8>, ProjectError> {
    let mut bytes =
        serde_json::to_vec_pretty(journal).map_err(|error| failure(error.to_string()))?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Everything in a journal that a later step turns into a path or an ID.
pub fn validate_journal(journal: &Journal) -> Result<(), ProjectError> {
    if journal.format != JOURNAL_FORMAT || journal.format_version != JOURNAL_VERSION {
        return Err(failure("Unknown project journal format"));
    }
    if !valid_operation_id(&journal.operation_id) {
        return Err(failure("Invalid operation ID in project journal"));
    }
    if !matches!(
        journal.operation.as_str(),
        OP_CREATE_PROJECT | OP_CREATE_SECTION
    ) || !matches!(
        journal.status.as_str(),
        STATUS_IN_PROGRESS | STATUS_COMPLETED
    ) {
        return Err(failure("Unknown project journal state"));
    }
    if !durable::valid_revision(&journal.request_revision)
        || !durable::valid_revision(&journal.plan.project_file_revision)
    {
        return Err(failure("Invalid revision in project journal"));
    }
    durable::relative_components(&journal.plan.project_path, LABEL).map_err(failure)?;
    let id_ok = |value: &str| valid_operation_id(value);
    if !id_ok(&journal.plan.project_id)
        || journal.plan.sections.is_empty() && journal.operation == OP_CREATE_SECTION
    {
        return Err(failure("Invalid project journal plan"));
    }
    for section in &journal.plan.sections {
        let components = durable::relative_components(&section.path, LABEL).map_err(failure)?;
        if components.len() != 1
            || section.path != section.name
            || !id_ok(&section.database_id)
            || !id_ok(&section.view_id)
            || section
                .template
                .as_ref()
                .is_some_and(|template| !id_ok(&template.template_id))
        {
            return Err(failure("Invalid section in project journal"));
        }
    }
    Ok(())
}

pub fn read_journal(vault: &Path, operation_id: &str) -> Result<Option<Journal>, ProjectError> {
    let path = journal_path(vault, operation_id);
    read_journal_file(&path)
        .map(|journal| journal.filter(|journal| journal.operation_id == operation_id))
}

pub fn read_journal_file(path: &Path) -> Result<Option<Journal>, ProjectError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(error.to_string())),
    };
    if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES {
        return Err(failure("Unreadable project journal"));
    }
    let bytes = fs::read(path).map_err(|error| failure(error.to_string()))?;
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|error| failure(format!("Damaged project journal: {error}")))?;
    validate_journal(&journal)?;
    Ok(Some(journal))
}

/// Publishes the journal without replacing an existing one.
pub fn create_journal(vault: &Path, journal: &Journal) -> Result<(), ProjectError> {
    let path = journal_path(vault, &journal.operation_id);
    let bytes = journal_bytes(journal)?;
    durable::create_new(&path, &bytes, LABEL).map_err(failure)?;
    if let Some(parent) = path.parent() {
        durable::sync_directory(parent).map_err(failure)?;
    }
    Ok(())
}

pub fn replace_journal(vault: &Path, journal: &Journal) -> Result<(), ProjectError> {
    let path = journal_path(vault, &journal.operation_id);
    frontmatter::atomic_write_bytes(&path, &journal_bytes(journal)?).map_err(failure)
}

pub fn remove_journal(vault: &Path, operation_id: &str) {
    let _ = fs::remove_file(journal_path(vault, operation_id));
}
