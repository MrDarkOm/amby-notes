//! The durable journal of a workshop operation (`.amby/recovery/creative/`).
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

pub const JOURNAL_FORMAT: &str = "amby-creative-operation";
pub const JOURNAL_VERSION: u64 = 1;
pub const STATUS_IN_PROGRESS: &str = "inProgress";
pub const STATUS_COMPLETED: &str = "completed";

pub const OP_CREATE_WORKSHOP: &str = "createWorkshop";
pub const OP_CREATE_STORY: &str = "createStory";
pub const OP_CREATE_SECTION: &str = "createSection";
pub const OP_UPDATE_WORKSHOP: &str = "updateWorkshop";
pub const OP_REMOVE_SECTION: &str = "removeSection";
pub const OP_REORDER_SECTIONS: &str = "reorderSections";
pub const OP_UPDATE_TEXT_LEVELS: &str = "updateTextLevels";
pub const OP_ADD_TEXT_STATUS: &str = "addTextStatus";

const LABEL: &str = "Creative recovery";
const MAX_JOURNAL_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedSection {
    pub id: String,
    pub role: String,
    pub name: String,
    pub path: String,
    pub database_id: String,
    pub view_id: String,
    #[serde(default)]
    pub extras: NewDatabaseExtras,
    #[serde(default)]
    pub template: Option<PlannedTemplate>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedManifestWrite {
    pub manifest_path: String,
    pub pre_revision: String,
    pub post_revision: String,
    pub pre_text: String,
    pub post_text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStory {
    pub story_id: String,
    pub folder_path: String,
    pub card_path: String,
    pub card_bytes: Vec<u8>,
    pub manifest_path: String,
    pub manifest_bytes: Vec<u8>,
    pub story_file_path: String,
    pub story_file_bytes: Vec<u8>,
    pub story_file_revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(default)]
    pub workshop_id: Option<String>,
    #[serde(default)]
    pub workshop_path: Option<String>,
    #[serde(default)]
    pub creates_workshop_folder: bool,
    #[serde(default)]
    pub workshop_file_revision: Option<String>,
    #[serde(default)]
    pub sections: Vec<PlannedSection>,
    #[serde(default)]
    pub story: Option<PlannedStory>,
    #[serde(default)]
    pub story_file_path: Option<String>,
    #[serde(default)]
    pub story_file_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_write: Option<PlannedManifestWrite>,
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
    pub expected_result: Value,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub fn journal_dir(vault: &Path) -> PathBuf {
    vault.join(".amby").join("recovery").join("creative")
}

pub fn legacy_journal_dir(vault: &Path) -> PathBuf {
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

pub fn validate_journal(journal: &Journal) -> Result<(), ProjectError> {
    if (journal.format != JOURNAL_FORMAT && journal.format != "amby-project-operation")
        || journal.format_version != JOURNAL_VERSION
    {
        return Err(failure("Unknown project journal format"));
    }
    if !valid_operation_id(&journal.operation_id) {
        return Err(failure("Invalid operation ID in project journal"));
    }
    if !matches!(
        journal.operation.as_str(),
        OP_CREATE_WORKSHOP
            | OP_CREATE_STORY
            | OP_CREATE_SECTION
            | OP_UPDATE_WORKSHOP
            | OP_REMOVE_SECTION
            | OP_REORDER_SECTIONS
            | OP_UPDATE_TEXT_LEVELS
            | OP_ADD_TEXT_STATUS
            | "createProject"
            | "updateProject"
    ) || !matches!(
        journal.status.as_str(),
        STATUS_IN_PROGRESS | STATUS_COMPLETED
    ) {
        return Err(failure("Unknown project journal state"));
    }
    if !durable::valid_revision(&journal.request_revision) {
        return Err(failure("Invalid revision in project journal"));
    }
    if let Some(path) = &journal.plan.workshop_path {
        durable::relative_components(path, LABEL).map_err(failure)?;
    }
    Ok(())
}

pub fn create_journal(vault: &Path, journal: &Journal) -> Result<(), ProjectError> {
    validate_journal(journal)?;
    let directory = journal_dir(vault);
    fs::create_dir_all(&directory).map_err(|error| failure(error.to_string()))?;
    let path = journal_path(vault, &journal.operation_id);
    let bytes = journal_bytes(journal)?;
    durable::create_new(&path, &bytes, LABEL).map_err(failure)
}

pub fn replace_journal(vault: &Path, journal: &Journal) -> Result<(), ProjectError> {
    validate_journal(journal)?;
    let path = journal_path(vault, &journal.operation_id);
    let bytes = journal_bytes(journal)?;
    frontmatter::atomic_write_bytes(&path, &bytes).map_err(failure)
}

pub fn read_journal_file(path: &Path) -> Result<Option<Journal>, ProjectError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(error.to_string())),
    };
    if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| failure(error.to_string()))?;
    let journal: Journal = match serde_json::from_slice(&bytes) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(None),
    };
    if validate_journal(&journal).is_err() {
        return Ok(None);
    }
    Ok(Some(journal))
}

pub fn read_journal(vault: &Path, operation_id: &str) -> Result<Option<Journal>, ProjectError> {
    if !valid_operation_id(operation_id) {
        return Err(ProjectError::InvalidOperationId);
    }
    let creative_p = journal_path(vault, operation_id);
    if let Some(j) = read_journal_file(&creative_p)? {
        return Ok(Some(j));
    }
    let legacy_p = legacy_journal_dir(vault).join(format!("{operation_id}.json"));
    read_journal_file(&legacy_p)
}

pub fn remove_journal(vault: &Path, operation_id: &str) {
    if valid_operation_id(operation_id) {
        let _ = fs::remove_file(journal_path(vault, operation_id));
        let _ = fs::remove_file(legacy_journal_dir(vault).join(format!("{operation_id}.json")));
    }
}
