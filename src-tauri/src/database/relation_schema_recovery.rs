//! Durable recovery for reciprocal Relation schema creation.
//!
//! A reciprocal Relation changes one or two user-owned manifest files.  The
//! journal in this module is deliberately separate from value journals: a
//! pending schema operation must never be interpreted as a pending note-value
//! operation, and vice versa.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::format::{parse_manifest, raw_revision, MAX_JSON_BYTES};
use super::mutations::{
    ChangeDatabasePropertyTypeRequest, ChangedDatabasePropertyType, CreateDatabasePropertyRequest,
    CreatedDatabaseProperty,
};
use crate::frontmatter;
use crate::watcher::WatcherState;

const RECOVERY_ROOT: &str = ".amby/recovery/database_relation_schemas";

use crate::durable::{self, valid_operation_id};

const LABEL: &str = "Relation schema recovery";

fn valid_revision(value: &str) -> bool {
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

const RECOVERY_FORMAT: &str = "amby-relation-schema-recovery";
const RECOVERY_VERSION: u64 = 1;
const MAX_STEPS: usize = 2;
const TYPE_CHANGE_VERSION: u64 = 2;
const TYPE_CHANGE_MAX_STEPS: usize = 3;

/// A complete manifest replacement prepared by the schema planner.  The
/// fields stay visible to the sibling mutations module, while the journal
/// remains the only durable publication mechanism for reciprocal Relations.
pub(super) struct SchemaPlannedWrite {
    pub(super) database_id: String,
    pub(super) path: PathBuf,
    pub(super) pre_bytes: Vec<u8>,
    pub(super) post_bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaRecoveryStep {
    database_id: String,
    manifest_path: String,
    backup_path: String,
    original_revision: String,
    target_revision: String,
    status: String,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaRecoveryJournal {
    format: String,
    format_version: u64,
    operation_id: String,
    request_revision: String,
    request: Value,
    status: String,
    steps: Vec<SchemaRecoveryStep>,
    result: Option<Value>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

struct SchemaJournal {
    vault: PathBuf,
    path: PathBuf,
    persisted_revision: String,
    journal: SchemaRecoveryJournal,
}

#[derive(Clone)]
struct RestoreStep {
    path: PathBuf,
    original: Vec<u8>,
    current_revision: String,
}

struct ReadOnlySchemaGuard {
    database_id: String,
    path: PathBuf,
    revision: String,
}

fn type_change_readonly_guards(
    vault: &Path,
    request: &ChangeDatabasePropertyTypeRequest,
    writes: &[SchemaPlannedWrite],
) -> Result<Vec<ReadOnlySchemaGuard>, String> {
    if request
        .expected_related_manifest_revisions
        .iter()
        .all(|revision| {
            writes
                .iter()
                .any(|write| write.database_id == revision.database_id)
        })
    {
        return Ok(Vec::new());
    }
    let discovery = super::discovery::discover_vault(vault)?;
    request
        .expected_related_manifest_revisions
        .iter()
        .filter(|revision| {
            !writes
                .iter()
                .any(|write| write.database_id == revision.database_id)
        })
        .map(|revision| {
            let matches = discovery
                .databases
                .iter()
                .filter(|database| database.database_id == revision.database_id)
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err("Related Relation database identity is missing or ambiguous".to_owned());
            }
            Ok(ReadOnlySchemaGuard {
                database_id: revision.database_id.clone(),
                path: matches[0].manifest_path.clone(),
                revision: revision.revision.clone(),
            })
        })
        .collect()
}

fn recheck_readonly_guards(vault: &Path, guards: &[ReadOnlySchemaGuard]) -> Result<(), String> {
    for guard in guards {
        let relative = relative_string(vault, &guard.path)?;
        let path = guarded_path(vault, &relative)?;
        resolve_manifest_path(vault, &guard.database_id, &path)?;
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        if raw_revision(&bytes) != guard.revision {
            return Err("Related manifest revision conflict before publication".to_owned());
        }
        parse_manifest_identity(&bytes, &guard.database_id)?;
    }
    Ok(())
}

pub(crate) struct PendingSchemaRecovery {
    journal: SchemaJournal,
    restore: Vec<RestoreStep>,
}

fn request_value(request: &CreateDatabasePropertyRequest) -> Result<Value, String> {
    serde_json::to_value(request).map_err(|error| error.to_string())
}

/// Generation is an in-memory command guard and is intentionally excluded
/// from the durable operation identity. Every other request field remains part
/// of the fingerprint, including both manifest revisions.
fn request_revision(request: &Value) -> Result<String, String> {
    let mut value = request.clone();
    value
        .as_object_mut()
        .ok_or_else(|| "Invalid Relation schema request".to_owned())?
        .remove("expectedGeneration");
    let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    Ok(raw_revision(&bytes))
}

fn journal_path(vault: &Path, operation_id: &str) -> Result<PathBuf, String> {
    if !valid_operation_id(operation_id) {
        return Err("Invalid Relation schema operationId".to_owned());
    }
    guarded_path(vault, &format!("{RECOVERY_ROOT}/{operation_id}.json"))
}

fn journal_bytes(journal: &SchemaRecoveryJournal) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_JSON_BYTES {
        return Err("Relation schema recovery journal is too large".to_owned());
    }
    Ok(bytes)
}

fn manifest_path_shape(relative: &str) -> Result<(), String> {
    let components = relative_components(relative)?;
    if components.len() < 2
        || components
            .iter()
            .any(|part| crate::vault::scan::is_service_directory(part))
    {
        return Err("Invalid Relation schema manifest path".to_owned());
    }
    let parent = components[components.len() - 2];
    let file = components[components.len() - 1];
    if file == "ambd.json" {
        return Ok(());
    }
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return Err("Invalid Relation schema manifest path".to_owned());
    };
    if stem != parent || !matches!(extension, "json" | "database") {
        return Err("Invalid Relation schema manifest path".to_owned());
    }
    Ok(())
}

fn target_database_id(request: &CreateDatabasePropertyRequest) -> Option<&str> {
    request
        .relation_target_database_id
        .as_deref()
        .or_else(|| {
            request
                .options
                .first()
                .filter(|id| !id.trim().is_empty())
                .map(String::as_str)
        })
        .or(Some(request.database_id.as_str()))
}

fn validate_request(request: &CreateDatabasePropertyRequest) -> Result<&str, String> {
    if request.property_type != "relation" || request.relation_two_way != Some(true) {
        return Err("Relation schema recovery requires a reciprocal Relation request".to_owned());
    }
    if !frontmatter::is_amby_id(&request.database_id)
        || !valid_revision(&request.expected_manifest_revision)
    {
        return Err("Invalid Relation schema source database or revision".to_owned());
    }
    let operation_id = request
        .operation_id
        .as_deref()
        .filter(|value| valid_operation_id(value))
        .ok_or_else(|| "Reciprocal Relation operationId is required".to_owned())?;
    let target = target_database_id(request)
        .ok_or_else(|| "Relation target database is required".to_owned())?;
    if !frontmatter::is_amby_id(target) {
        return Err("Invalid Relation target database ID".to_owned());
    }
    if target == request.database_id {
        if request
            .expected_target_manifest_revision
            .as_deref()
            .is_some_and(|revision| revision != request.expected_manifest_revision)
        {
            return Err("Self Relation target revision conflicts with source".to_owned());
        }
    } else if request
        .expected_target_manifest_revision
        .as_deref()
        .is_none_or(|revision| !valid_revision(revision))
    {
        return Err("Cross-database Relation target revision is required".to_owned());
    }
    Ok(operation_id)
}

fn validate_result(
    result: &CreatedDatabaseProperty,
    request: &CreateDatabasePropertyRequest,
    operation_id: &str,
    steps: &[SchemaRecoveryStep],
) -> Result<(), String> {
    if result.database_id != request.database_id
        || result.property_type != "relation"
        || result.operation_id.as_deref() != Some(operation_id)
        || !frontmatter::is_amby_id(&result.property_id)
        || !result
            .inverse_property_id
            .as_deref()
            .is_some_and(frontmatter::is_amby_id)
        || result.name != request.name.trim()
        || result.manifest_revision != steps[0].target_revision
    {
        return Err("Invalid Relation schema recovery outcome".to_owned());
    }
    if result.inverse_property_id.as_deref() == Some(result.property_id.as_str()) {
        return Err("Relation schema outcome reuses its property ID".to_owned());
    }
    if result.manifest_revisions.len() != steps.len() {
        return Err("Relation schema outcome revisions do not match steps".to_owned());
    }
    let expected = steps
        .iter()
        .map(|step| (step.database_id.as_str(), step.target_revision.as_str()))
        .collect::<BTreeMap<_, _>>();
    let actual = result
        .manifest_revisions
        .iter()
        .map(|revision| {
            if !frontmatter::is_amby_id(&revision.database_id)
                || !valid_revision(&revision.revision)
            {
                return Err("Invalid Relation schema manifest revision".to_owned());
            }
            Ok((revision.database_id.as_str(), revision.revision.as_str()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    if actual != expected {
        return Err("Relation schema outcome revisions do not match steps".to_owned());
    }
    Ok(())
}

fn validate_v1_journal(journal: &SchemaRecoveryJournal, path: &Path) -> Result<(), String> {
    if journal.format != RECOVERY_FORMAT
        || journal.format_version != RECOVERY_VERSION
        || !valid_operation_id(&journal.operation_id)
        || path.file_stem().and_then(|name| name.to_str()) != Some(&journal.operation_id)
        || !matches!(
            journal.status.as_str(),
            "planned" | "inProgress" | "completed" | "rolledBack"
        )
        || journal.steps.is_empty()
        || journal.steps.len() > MAX_STEPS
        || request_revision(&journal.request)? != journal.request_revision
    {
        return Err("Invalid or unsupported Relation schema recovery journal".to_owned());
    }
    let request: CreateDatabasePropertyRequest =
        serde_json::from_value(journal.request.clone()).map_err(|error| error.to_string())?;
    let operation_id = validate_request(&request)?;
    if operation_id != journal.operation_id {
        return Err("Relation schema operationId does not match journal".to_owned());
    }
    let target =
        target_database_id(&request).ok_or_else(|| "Missing Relation target".to_owned())?;
    let mut databases = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for (index, step) in journal.steps.iter().enumerate() {
        if !frontmatter::is_amby_id(&step.database_id)
            || !valid_revision(&step.original_revision)
            || !valid_revision(&step.target_revision)
            || step.original_revision == step.target_revision
            || !matches!(step.status.as_str(), "planned" | "applied" | "rolledBack")
            || (journal.status == "completed" && step.status != "applied")
            || (journal.status == "rolledBack" && step.status != "rolledBack")
            || step.backup_path != format!("{RECOVERY_ROOT}/{}/{index}.bin", journal.operation_id)
        {
            return Err("Invalid Relation schema recovery step".to_owned());
        }
        manifest_path_shape(&step.manifest_path)?;
        if !databases.insert(step.database_id.as_str())
            || !paths.insert(step.manifest_path.as_str())
        {
            return Err("Duplicate Relation schema recovery step".to_owned());
        }
    }
    let source = &journal.steps[0];
    if source.database_id != request.database_id
        || source.original_revision != request.expected_manifest_revision
        || (target == request.database_id && journal.steps.len() != 1)
        || (target != request.database_id
            && (journal.steps.len() != 2 || journal.steps[1].database_id != target))
    {
        return Err("Invalid Relation schema recovery source or target".to_owned());
    }
    if target != request.database_id
        && journal.steps[1].original_revision
            != request
                .expected_target_manifest_revision
                .as_deref()
                .unwrap_or_default()
    {
        return Err("Invalid Relation schema target revision".to_owned());
    }
    if let Some(result) = journal.result.as_ref() {
        let result: CreatedDatabaseProperty =
            serde_json::from_value(result.clone()).map_err(|error| error.to_string())?;
        validate_result(
            &result,
            &request,
            journal.operation_id.as_str(),
            &journal.steps,
        )?;
    } else if journal.status != "rolledBack" {
        return Err("Relation schema recovery outcome is missing".to_owned());
    }
    Ok(())
}

fn validate_journal(journal: &SchemaRecoveryJournal, path: &Path) -> Result<(), String> {
    match journal.format_version {
        RECOVERY_VERSION => validate_v1_journal(journal, path),
        TYPE_CHANGE_VERSION => validate_v2_journal(journal, path),
        _ => Err("Invalid or unsupported Relation schema recovery journal".to_owned()),
    }
}

fn type_change_request_value(request: &ChangeDatabasePropertyTypeRequest) -> Result<Value, String> {
    serde_json::to_value(request).map_err(|error| error.to_string())
}

fn type_change_journal_request(
    request: &ChangeDatabasePropertyTypeRequest,
) -> Result<Value, String> {
    Ok(serde_json::json!({
        "kind": "changePropertyType",
        "payload": type_change_request_value(request)?,
    }))
}

fn type_change_request_revision(request: &Value) -> Result<String, String> {
    let mut request = request.clone();
    let payload = request
        .as_object_mut()
        .and_then(|object| object.get_mut("payload"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Invalid Relation property-type request".to_owned())?;
    payload.remove("expectedGeneration");
    let bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    Ok(raw_revision(&bytes))
}

fn validate_v2_result(
    result: &ChangedDatabasePropertyType,
    request: &ChangeDatabasePropertyTypeRequest,
    operation_id: &str,
    steps: &[SchemaRecoveryStep],
) -> Result<(), String> {
    if result.database_id != request.database_id
        || result.property_id != request.property_id
        || result.property_type != request.property_type
        || result.operation_id.as_deref() != Some(operation_id)
        || !frontmatter::is_amby_id(&result.property_id)
        || result.manifest_revision != steps[0].target_revision
        || result.manifest_revisions.len() != steps.len()
    {
        return Err("Invalid Relation property-type recovery outcome".to_owned());
    }
    if let Some(inverse) = result.inverse_property_id.as_deref() {
        if !frontmatter::is_amby_id(inverse) || inverse == result.property_id {
            return Err("Invalid Relation property-type inverse ID".to_owned());
        }
    }
    let expected = steps
        .iter()
        .map(|step| (step.database_id.as_str(), step.target_revision.as_str()))
        .collect::<BTreeMap<_, _>>();
    let actual = result
        .manifest_revisions
        .iter()
        .map(|revision| {
            if !frontmatter::is_amby_id(&revision.database_id)
                || !valid_revision(&revision.revision)
            {
                return Err("Invalid Relation property-type manifest revision".to_owned());
            }
            Ok((revision.database_id.as_str(), revision.revision.as_str()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    if actual != expected {
        return Err("Relation property-type outcome revisions do not match steps".to_owned());
    }
    Ok(())
}

fn validate_v2_journal(journal: &SchemaRecoveryJournal, path: &Path) -> Result<(), String> {
    if journal.format != RECOVERY_FORMAT
        || journal.format_version != TYPE_CHANGE_VERSION
        || !valid_operation_id(&journal.operation_id)
        || path.file_stem().and_then(|name| name.to_str()) != Some(&journal.operation_id)
        || !matches!(
            journal.status.as_str(),
            "planned" | "inProgress" | "completed" | "rolledBack"
        )
        || journal.steps.is_empty()
        || journal.steps.len() > TYPE_CHANGE_MAX_STEPS
        || type_change_request_revision(&journal.request)? != journal.request_revision
    {
        return Err("Invalid or unsupported Relation property-type recovery journal".to_owned());
    }
    let object = journal
        .request
        .as_object()
        .ok_or_else(|| "Invalid Relation property-type request".to_owned())?;
    if object.get("kind").and_then(Value::as_str) != Some("changePropertyType") {
        return Err("Invalid Relation property-type request kind".to_owned());
    }
    let request: ChangeDatabasePropertyTypeRequest = serde_json::from_value(
        object
            .get("payload")
            .cloned()
            .ok_or_else(|| "Missing Relation property-type request payload".to_owned())?,
    )
    .map_err(|error| error.to_string())?;
    let operation_id = request
        .operation_id
        .as_deref()
        .filter(|id| valid_operation_id(id))
        .ok_or_else(|| "Relation property-type operationId is required".to_owned())?;
    if operation_id != journal.operation_id
        || !frontmatter::is_amby_id(&request.database_id)
        || !frontmatter::is_amby_id(&request.property_id)
        || !valid_revision(&request.expected_manifest_revision)
    {
        return Err("Invalid Relation property-type request".to_owned());
    }
    let mut expected_related = BTreeMap::new();
    for revision in &request.expected_related_manifest_revisions {
        if !frontmatter::is_amby_id(&revision.database_id)
            || revision.database_id == request.database_id
            || !valid_revision(&revision.revision)
            || expected_related
                .insert(revision.database_id.as_str(), revision.revision.as_str())
                .is_some()
        {
            return Err("Invalid related Relation manifest revision".to_owned());
        }
    }
    let mut database_ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for (index, step) in journal.steps.iter().enumerate() {
        if !frontmatter::is_amby_id(&step.database_id)
            || !valid_revision(&step.original_revision)
            || !valid_revision(&step.target_revision)
            || step.original_revision == step.target_revision
            || !matches!(step.status.as_str(), "planned" | "applied" | "rolledBack")
            || (journal.status == "completed" && step.status != "applied")
            || (journal.status == "rolledBack" && step.status != "rolledBack")
            || step.backup_path != format!("{RECOVERY_ROOT}/{}/{index}.bin", journal.operation_id)
            || !database_ids.insert(step.database_id.as_str())
            || !paths.insert(step.manifest_path.as_str())
        {
            return Err("Invalid Relation property-type recovery step".to_owned());
        }
        manifest_path_shape(&step.manifest_path)?;
    }
    let source = &journal.steps[0];
    if source.database_id != request.database_id
        || source.original_revision != request.expected_manifest_revision
    {
        return Err("Invalid Relation property-type recovery source".to_owned());
    }
    let actual_related = journal
        .steps
        .iter()
        .skip(1)
        .map(|step| (step.database_id.as_str(), step.original_revision.as_str()))
        .collect::<BTreeMap<_, _>>();
    for (database_id, revision) in actual_related {
        if expected_related.get(database_id).copied() != Some(revision) {
            return Err("Related Relation manifest revisions do not match steps".to_owned());
        }
    }
    if let Some(result) = journal.result.as_ref() {
        let result: ChangedDatabasePropertyType =
            serde_json::from_value(result.clone()).map_err(|error| error.to_string())?;
        validate_v2_result(&result, &request, operation_id, &journal.steps)?;
    } else if journal.status != "rolledBack" {
        return Err("Relation property-type recovery outcome is missing".to_owned());
    }
    Ok(())
}

fn read_journal_with_revision(path: &Path) -> Result<(SchemaRecoveryJournal, String), String> {
    if fs::metadata(path).map_err(|error| error.to_string())?.len() > MAX_JSON_BYTES as u64 {
        return Err("Relation schema recovery journal is too large".to_owned());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let journal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid Relation schema recovery journal: {error}"))?;
    validate_journal(&journal, path)?;
    Ok((journal, raw_revision(&bytes)))
}

fn read_journal(path: &Path) -> Result<SchemaRecoveryJournal, String> {
    read_journal_with_revision(path).map(|(journal, _)| journal)
}

fn journals(vault: &Path) -> Result<Vec<SchemaJournal>, String> {
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let root = guarded_path(&vault, RECOVERY_ROOT)?;
    if !root.try_exists().map_err(|error| error.to_string())? {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(&root)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    let mut result = Vec::new();
    for path in paths {
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let relative = relative_string(&vault, &path)?;
        guarded_path(&vault, &relative)?;
        let (journal, persisted_revision) = read_journal_with_revision(&path)?;
        result.push(SchemaJournal {
            vault: vault.clone(),
            path,
            persisted_revision,
            journal,
        });
    }
    Ok(result)
}

fn resolve_manifest_path(
    vault: &Path,
    database_id: &str,
    expected_path: &Path,
) -> Result<(), String> {
    let discovery = super::discovery::discover_vault(vault)?;
    let matches = discovery
        .databases
        .iter()
        .filter(|database| database.database_id == database_id)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(format!(
            "Relation schema database identity is ambiguous for {database_id}"
        ));
    }
    let actual = matches[0]
        .manifest_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let expected = expected_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if actual != expected {
        return Err("Relation schema manifest path no longer resolves to its database".to_owned());
    }
    Ok(())
}

fn parse_manifest_identity(bytes: &[u8], database_id: &str) -> Result<(), String> {
    let parsed = parse_manifest(bytes).map_err(|error| error.to_string())?;
    if parsed.value.database_id != database_id {
        return Err("Relation schema manifest database identity mismatch".to_owned());
    }
    Ok(())
}

impl SchemaJournal {
    fn check_revision(&self) -> Result<(), String> {
        let path = journal_path(&self.vault, &self.journal.operation_id)?;
        if path != self.path {
            return Err("Relation schema journal path changed".to_owned());
        }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        if raw_revision(&bytes) != self.persisted_revision {
            return Err("Relation schema recovery journal changed externally".to_owned());
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

    fn applied(&mut self, index: usize) -> Result<(), String> {
        self.journal.steps[index].status = "applied".to_owned();
        self.write()
    }

    fn completed(&mut self) -> Result<(), String> {
        self.journal.status = "completed".to_owned();
        self.write()
    }

    fn rolled_back(&mut self) -> Result<(), String> {
        for step in &mut self.journal.steps {
            step.status = "rolledBack".to_owned();
        }
        self.journal.status = "rolledBack".to_owned();
        self.journal.result = None;
        self.write()
    }
}

fn build_journal(
    vault: &Path,
    request: &CreateDatabasePropertyRequest,
    writes: &[SchemaPlannedWrite],
    result: &CreatedDatabaseProperty,
) -> Result<(SchemaRecoveryJournal, PathBuf), String> {
    let operation_id = validate_request(request)?;
    if writes.is_empty() || writes.len() > MAX_STEPS {
        return Err("Invalid Relation schema write plan".to_owned());
    }
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let journal_path = journal_path(&vault, operation_id)?;
    let request_value = request_value(request)?;
    let mut seen_database_ids = BTreeSet::new();
    let mut seen_paths = BTreeSet::new();
    let steps = writes
        .iter()
        .enumerate()
        .map(|(index, write)| {
            if !frontmatter::is_amby_id(&write.database_id)
                || !seen_database_ids.insert(write.database_id.as_str())
                || crate::paths::confine(&vault, &write.path)? != write.path
            {
                return Err("Invalid Relation schema write plan".to_owned());
            }
            let relative = relative_string(&vault, &write.path)?;
            manifest_path_shape(&relative)?;
            if !seen_paths.insert(relative.clone()) {
                return Err("Duplicate Relation schema manifest path".to_owned());
            }
            Ok(SchemaRecoveryStep {
                database_id: write.database_id.clone(),
                manifest_path: relative,
                backup_path: format!("{RECOVERY_ROOT}/{operation_id}/{index}.bin"),
                original_revision: raw_revision(&write.pre_bytes),
                target_revision: raw_revision(&write.post_bytes),
                status: "planned".to_owned(),
                extra: Default::default(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let journal = SchemaRecoveryJournal {
        format: RECOVERY_FORMAT.to_owned(),
        format_version: RECOVERY_VERSION,
        operation_id: operation_id.to_owned(),
        request_revision: request_revision(&request_value)?,
        request: request_value,
        status: "inProgress".to_owned(),
        steps,
        result: Some(serde_json::to_value(result).map_err(|error| error.to_string())?),
        extra: Default::default(),
    };
    validate_journal(&journal, &journal_path)?;
    validate_result(result, request, operation_id, &journal.steps)?;
    Ok((journal, journal_path))
}

fn build_type_change_journal(
    vault: &Path,
    request: &ChangeDatabasePropertyTypeRequest,
    writes: &[SchemaPlannedWrite],
    result: &ChangedDatabasePropertyType,
) -> Result<(SchemaRecoveryJournal, PathBuf), String> {
    let operation_id = request
        .operation_id
        .as_deref()
        .filter(|id| valid_operation_id(id))
        .ok_or_else(|| "Relation property-type operationId is required".to_owned())?;
    if writes.is_empty() || writes.len() > TYPE_CHANGE_MAX_STEPS {
        return Err("Invalid Relation property-type write plan".to_owned());
    }
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let journal_path = journal_path(&vault, operation_id)?;
    let request_value = type_change_journal_request(request)?;
    let mut seen_database_ids = BTreeSet::new();
    let mut seen_paths = BTreeSet::new();
    let steps = writes
        .iter()
        .enumerate()
        .map(|(index, write)| {
            if !frontmatter::is_amby_id(&write.database_id)
                || !seen_database_ids.insert(write.database_id.as_str())
                || crate::paths::confine(&vault, &write.path)? != write.path
            {
                return Err("Invalid Relation property-type write plan".to_owned());
            }
            let relative = relative_string(&vault, &write.path)?;
            manifest_path_shape(&relative)?;
            if !seen_paths.insert(relative.clone()) {
                return Err("Duplicate Relation property-type manifest path".to_owned());
            }
            Ok(SchemaRecoveryStep {
                database_id: write.database_id.clone(),
                manifest_path: relative,
                backup_path: format!("{RECOVERY_ROOT}/{operation_id}/{index}.bin"),
                original_revision: raw_revision(&write.pre_bytes),
                target_revision: raw_revision(&write.post_bytes),
                status: "planned".to_owned(),
                extra: Default::default(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let journal = SchemaRecoveryJournal {
        format: RECOVERY_FORMAT.to_owned(),
        format_version: TYPE_CHANGE_VERSION,
        operation_id: operation_id.to_owned(),
        request_revision: type_change_request_revision(&request_value)?,
        request: request_value,
        status: "inProgress".to_owned(),
        steps,
        result: Some(serde_json::to_value(result).map_err(|error| error.to_string())?),
        extra: Default::default(),
    };
    validate_journal(&journal, &journal_path)?;
    validate_v2_result(result, request, operation_id, &journal.steps)?;
    Ok((journal, journal_path))
}

fn preflight_publication(
    vault: &Path,
    request: &CreateDatabasePropertyRequest,
    writes: &[SchemaPlannedWrite],
    journal: &SchemaRecoveryJournal,
) -> Result<(), String> {
    preflight_schema_writes(vault, writes, journal)?;
    let target = target_database_id(request).ok_or_else(|| "Missing Relation target".to_owned())?;
    if journal.steps[0].database_id != request.database_id
        || journal.steps.len() != if target == request.database_id { 1 } else { 2 }
    {
        return Err("Relation schema write plan does not match request".to_owned());
    }
    Ok(())
}

fn preflight_schema_writes(
    vault: &Path,
    writes: &[SchemaPlannedWrite],
    journal: &SchemaRecoveryJournal,
) -> Result<(), String> {
    if writes.len() != journal.steps.len() || writes.is_empty() {
        return Err("Relation schema write plan does not match journal".to_owned());
    }
    for (step, write) in journal.steps.iter().zip(writes) {
        let path = guarded_path(vault, &step.manifest_path)?;
        if path != write.path {
            return Err("Relation schema manifest path changed".to_owned());
        }
        resolve_manifest_path(vault, &step.database_id, &path)?;
        let current = fs::read(&path).map_err(|error| error.to_string())?;
        if current != write.pre_bytes || raw_revision(&current) != step.original_revision {
            return Err("Relation schema manifest revision conflict".to_owned());
        }
        parse_manifest_identity(&current, &step.database_id)?;
        parse_manifest_identity(&write.post_bytes, &step.database_id)?;
    }
    Ok(())
}

fn prepare_journal(
    vault: &Path,
    request: &CreateDatabasePropertyRequest,
    writes: &[SchemaPlannedWrite],
    result: &CreatedDatabaseProperty,
) -> Result<SchemaJournal, String> {
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let (journal, path) = build_journal(&vault, request, writes, result)?;
    preflight_publication(&vault, request, writes, &journal)?;
    let bytes = journal_bytes(&journal)?;
    let backup_root_relative = format!("{RECOVERY_ROOT}/{}", journal.operation_id);
    let backup_root = guarded_path(&vault, &backup_root_relative)?;
    let recovery_root = guarded_path(&vault, RECOVERY_ROOT)?;
    fs::create_dir_all(&recovery_root).map_err(|error| error.to_string())?;
    fs::create_dir(&backup_root)
        .map_err(|error| format!("Cannot create Relation schema backup directory: {error}"))?;
    guarded_path(&vault, &backup_root_relative)?;
    // Preserve the same raw history snapshots as ordinary schema writes. A
    // snapshot is created only after every planned manifest has passed its
    // preflight check and before any manifest replacement.
    for write in writes {
        crate::history::snapshot_before_write(
            &vault,
            &write.path,
            &write.post_bytes,
            "database-schema",
        )?;
    }
    // Flush newly-created recovery ancestors before publishing backup files.
    for relative in [".amby", ".amby/recovery", RECOVERY_ROOT] {
        let directory = guarded_path(&vault, relative)?;
        sync_directory(
            directory
                .parent()
                .ok_or("Invalid Relation schema recovery directory")?,
        )?;
    }
    sync_directory(&backup_root)?;
    for (step, write) in journal.steps.iter().zip(writes) {
        let backup = guarded_path(&vault, &step.backup_path)?;
        create_new(&backup, &write.pre_bytes)?;
        if fs::read(&backup).map_err(|error| error.to_string())? != write.pre_bytes {
            return Err("Relation schema backup verification failed".to_owned());
        }
    }
    sync_directory(&backup_root)?;
    // The durable operation outcome is visible before any manifest can be
    // replaced. A crash while creating a backup leaves no journal and only
    // orphaned recovery bytes; a crash after this point is recoverable.
    create_new(&path, &bytes)?;
    sync_directory(&recovery_root)?;
    let persisted_revision = raw_revision(&bytes);
    Ok(SchemaJournal {
        vault,
        path,
        persisted_revision,
        journal,
    })
}

fn prepare_type_change_journal(
    vault: &Path,
    request: &ChangeDatabasePropertyTypeRequest,
    writes: &[SchemaPlannedWrite],
    result: &ChangedDatabasePropertyType,
) -> Result<SchemaJournal, String> {
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let (journal, path) = build_type_change_journal(&vault, request, writes, result)?;
    preflight_schema_writes(&vault, writes, &journal)?;
    let bytes = journal_bytes(&journal)?;
    let backup_root_relative = format!("{RECOVERY_ROOT}/{}", journal.operation_id);
    let backup_root = guarded_path(&vault, &backup_root_relative)?;
    let recovery_root = guarded_path(&vault, RECOVERY_ROOT)?;
    fs::create_dir_all(&recovery_root).map_err(|error| error.to_string())?;
    fs::create_dir(&backup_root)
        .map_err(|error| format!("Cannot create Relation schema backup directory: {error}"))?;
    guarded_path(&vault, &backup_root_relative)?;
    for write in writes {
        crate::history::snapshot_before_write(
            &vault,
            &write.path,
            &write.post_bytes,
            "database-schema",
        )?;
    }
    for relative in [".amby", ".amby/recovery", RECOVERY_ROOT] {
        let directory = guarded_path(&vault, relative)?;
        sync_directory(
            directory
                .parent()
                .ok_or("Invalid Relation schema recovery directory")?,
        )?;
    }
    sync_directory(&backup_root)?;
    for (step, write) in journal.steps.iter().zip(writes) {
        let backup = guarded_path(&vault, &step.backup_path)?;
        create_new(&backup, &write.pre_bytes)?;
        if fs::read(&backup).map_err(|error| error.to_string())? != write.pre_bytes {
            return Err("Relation schema backup verification failed".to_owned());
        }
    }
    sync_directory(&backup_root)?;
    create_new(&path, &bytes)?;
    sync_directory(&recovery_root)?;
    Ok(SchemaJournal {
        vault,
        path,
        persisted_revision: raw_revision(&bytes),
        journal,
    })
}

fn rollback_written(
    journal: &SchemaJournal,
    writes: &[SchemaPlannedWrite],
    written: &[usize],
) -> Vec<String> {
    let mut errors = Vec::new();
    for index in written.iter().rev().copied() {
        let write = &writes[index];
        let result = (|| {
            journal.check_revision()?;
            let relative = relative_string(&journal.vault, &write.path)?;
            let path = guarded_path(&journal.vault, &relative)?;
            if path != write.path {
                return Err("manifest path changed; rollback refused".to_owned());
            }
            let current = fs::read(&path).map_err(|error| error.to_string())?;
            if current == write.pre_bytes {
                return Ok(());
            }
            if current != write.post_bytes {
                return Err("manifest changed externally; rollback refused".to_owned());
            }
            frontmatter::atomic_write_bytes(&path, &write.pre_bytes)
        })();
        if let Err(error) = result {
            errors.push(format!("{}: {error}", write.database_id));
        }
    }
    errors
}

fn recheck_publication_state(
    journal: &SchemaJournal,
    writes: &[SchemaPlannedWrite],
    written: &[usize],
) -> Result<(), String> {
    journal.check_revision()?;
    for (index, (step, write)) in journal.journal.steps.iter().zip(writes).enumerate() {
        let path = guarded_path(&journal.vault, &step.manifest_path)?;
        if path != write.path {
            return Err("Relation schema manifest path changed before publication".to_owned());
        }
        resolve_manifest_path(&journal.vault, &step.database_id, &path)?;
        let current = fs::read(&path).map_err(|error| error.to_string())?;
        let expected = if written.contains(&index) {
            &write.post_bytes
        } else {
            &write.pre_bytes
        };
        if &current != expected {
            return Err("Relation schema manifest changed before publication".to_owned());
        }
        parse_manifest_identity(&current, &step.database_id)?;
    }
    journal.check_revision()
}

fn publish_error(
    mut journal: SchemaJournal,
    writes: &[SchemaPlannedWrite],
    written: &[usize],
    watcher: &WatcherState,
    prepared: &crate::watcher::PreparedSelfWrite,
    error: String,
) -> Result<(), String> {
    watcher.cancel_prepared_write(prepared);
    let rollback_errors = rollback_written(&journal, writes, written);
    if rollback_errors.is_empty() {
        if let Err(journal_error) = journal.rolled_back() {
            return Err(format!(
                "Relation schema publication failed: {error}; rollback completed but journal update failed: {journal_error}"
            ));
        }
        return Err(format!(
            "Relation schema publication failed and rolled back: {error}"
        ));
    }
    Err(format!(
        "Relation schema publication failed: {error}; rollback incomplete: {}",
        rollback_errors.join("; ")
    ))
}

/// Publish all reciprocal Relation manifests with a durable, conditional
/// rollback journal.  The completed outcome is committed before watcher
/// confirmation; callers may record history only after this returns success.
fn publish_prepared(
    watcher: &WatcherState,
    operation_id: &str,
    mut journal: SchemaJournal,
    writes: &[SchemaPlannedWrite],
    publication_guard: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let prepared = watcher.prepare_write(writes.iter().map(|write| {
        (
            write.path.clone(),
            crate::watcher::fingerprint_for_bytes(&write.post_bytes),
        )
    }));
    let mut written = Vec::new();
    for (index, write) in writes.iter().enumerate() {
        if let Err(error) = (|| {
            publication_guard()?;
            recheck_publication_state(&journal, writes, &written)?;
            let path = guarded_path(&journal.vault, &journal.journal.steps[index].manifest_path)?;
            if path != write.path {
                return Err("Relation schema manifest path changed before publication".to_owned());
            }
            let current = fs::read(&path).map_err(|error| error.to_string())?;
            if current != write.pre_bytes {
                return Err("Relation schema manifest changed before publication".to_owned());
            }
            written.push(index);
            frontmatter::atomic_write_bytes(&path, &write.post_bytes)?;
            let after = fs::read(&path).map_err(|error| error.to_string())?;
            if after != write.post_bytes {
                return Err("Relation schema manifest write verification failed".to_owned());
            }
            journal.applied(index)
        })() {
            return publish_error(journal, writes, &written, watcher, &prepared, error);
        }
    }
    if let Err(error) =
        publication_guard().and_then(|()| recheck_publication_state(&journal, writes, &written))
    {
        return publish_error(journal, writes, &written, watcher, &prepared, error);
    }
    if let Err(error) = journal.completed() {
        watcher.cancel_prepared_write(&prepared);
        return Err(format!(
            "Relation schema files were written but completion could not be recorded for operation {operation_id}: {error}; recovery journal retained"
        ));
    }
    watcher.confirm_prepared_write(&prepared);
    Ok(())
}

pub(super) fn publish(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabasePropertyRequest,
    writes: &[SchemaPlannedWrite],
    result: &CreatedDatabaseProperty,
) -> Result<(), String> {
    let operation_id = validate_request(request)?;
    if request.operation_id.as_deref() != Some(operation_id) {
        return Err("Invalid Relation schema operationId".to_owned());
    }
    super::relation_recovery::ensure_no_pending(vault)?;
    ensure_no_pending(vault)?;
    let journal = prepare_journal(vault, request, writes, result)?;
    publish_prepared(watcher, operation_id, journal, writes, || Ok(()))
}

/// Return a durable completed result before the caller performs a source CAS.
/// Completed replay intentionally does not inspect current manifests or
/// backups: those are user-owned and may have changed after a successful run.
pub(super) fn replay(
    vault: &Path,
    request: &CreateDatabasePropertyRequest,
) -> Result<Option<CreatedDatabaseProperty>, String> {
    let operation_id = validate_request(request)?;
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let path = journal_path(&vault, operation_id)?;
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Ok(None);
    }
    let journal = read_journal(&path)?;
    if journal.request_revision != request_revision(&request_value(request)?)? {
        return Err(
            "Relation schema operationId was already used for a different request".to_owned(),
        );
    }
    match journal.status.as_str() {
        "completed" => {
            let result = journal
                .result
                .ok_or_else(|| "Completed Relation schema outcome is missing".to_owned())?;
            let result: CreatedDatabaseProperty =
                serde_json::from_value(result).map_err(|error| error.to_string())?;
            validate_result(&result, request, operation_id, &journal.steps)?;
            Ok(Some(result))
        }
        "rolledBack" => {
            Err("Relation schema operation was rolled back; use a new operationId".to_owned())
        }
        _ => Err("Relation schema operation requires recovery before retrying".to_owned()),
    }
}

pub(super) fn replay_type_change(
    vault: &Path,
    request: &ChangeDatabasePropertyTypeRequest,
) -> Result<Option<ChangedDatabasePropertyType>, String> {
    let operation_id = request
        .operation_id
        .as_deref()
        .filter(|id| valid_operation_id(id))
        .ok_or_else(|| "Relation property-type operationId is required".to_owned())?;
    let vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let path = journal_path(&vault, operation_id)?;
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Ok(None);
    }
    let journal = read_journal(&path)?;
    if journal.format_version != TYPE_CHANGE_VERSION {
        return Err("Relation operationId belongs to a different operation kind".to_owned());
    }
    let request_value = type_change_journal_request(request)?;
    if journal.request_revision != type_change_request_revision(&request_value)? {
        return Err(
            "Relation property-type operationId was already used for a different request"
                .to_owned(),
        );
    }
    match journal.status.as_str() {
        "completed" => {
            let result = journal
                .result
                .ok_or_else(|| "Completed Relation property-type outcome is missing".to_owned())?;
            let result: ChangedDatabasePropertyType =
                serde_json::from_value(result).map_err(|error| error.to_string())?;
            validate_v2_result(&result, request, operation_id, &journal.steps)?;
            Ok(Some(result))
        }
        "rolledBack" => Err(
            "Relation property-type operation was rolled back; use a new operationId".to_owned(),
        ),
        _ => Err("Relation property-type operation requires recovery before retrying".to_owned()),
    }
}

pub(super) fn publish_type_change(
    vault: &Path,
    watcher: &WatcherState,
    request: &ChangeDatabasePropertyTypeRequest,
    writes: &[SchemaPlannedWrite],
    result: &ChangedDatabasePropertyType,
) -> Result<(), String> {
    let canonical_vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let vault = canonical_vault.as_path();
    let operation_id = request
        .operation_id
        .as_deref()
        .filter(|id| valid_operation_id(id))
        .ok_or_else(|| "Relation property-type operationId is required".to_owned())?;
    super::relation_recovery::ensure_no_pending(vault)?;
    ensure_no_pending(vault)?;
    let readonly_guards = type_change_readonly_guards(vault, request, writes)?;
    recheck_readonly_guards(vault, &readonly_guards)?;
    let journal = prepare_type_change_journal(vault, request, writes, result)?;
    publish_prepared(watcher, operation_id, journal, writes, || {
        recheck_readonly_guards(vault, &readonly_guards)
    })
}

pub(super) fn ensure_no_pending(vault: &Path) -> Result<(), String> {
    if journals(vault)?
        .iter()
        .any(|journal| matches!(journal.journal.status.as_str(), "planned" | "inProgress"))
    {
        return Err("An unfinished Relation schema operation requires vault recovery".to_owned());
    }
    Ok(())
}

fn preflight_restore(journal: &SchemaJournal) -> Result<Vec<RestoreStep>, String> {
    journal.check_revision()?;
    let mut restore = Vec::new();
    for step in &journal.journal.steps {
        let path = guarded_path(&journal.vault, &step.manifest_path)?;
        let backup = guarded_path(&journal.vault, &step.backup_path)?;
        resolve_manifest_path(&journal.vault, &step.database_id, &path)?;
        let original = fs::read(&backup)
            .map_err(|error| format!("Relation schema backup unavailable: {error}"))?;
        if raw_revision(&original) != step.original_revision {
            return Err("Relation schema backup is corrupt".to_owned());
        }
        parse_manifest_identity(&original, &step.database_id)?;
        let current = fs::read(&path)
            .map_err(|error| format!("Relation schema manifest unavailable: {error}"))?;
        let current_revision = raw_revision(&current);
        if current_revision != step.original_revision && current_revision != step.target_revision {
            return Err(
                "Relation schema manifest changed after the operation; recovery refused".to_owned(),
            );
        }
        parse_manifest_identity(&current, &step.database_id)?;
        restore.push(RestoreStep {
            path,
            original,
            current_revision,
        });
    }
    journal.check_revision()?;
    Ok(restore)
}

pub(crate) fn prepare_pending_relation_schemas(
    vault: &Path,
) -> Result<Vec<PendingSchemaRecovery>, String> {
    let mut pending = Vec::new();
    let mut paths = BTreeSet::new();
    for journal in journals(vault)? {
        if !matches!(journal.journal.status.as_str(), "planned" | "inProgress") {
            continue;
        }
        let restore = preflight_restore(&journal)?;
        for step in &restore {
            if !paths.insert(step.path.clone()) {
                return Err("Overlapping pending Relation schema journals".to_owned());
            }
        }
        pending.push(PendingSchemaRecovery { journal, restore });
    }
    Ok(pending)
}

pub(crate) fn restore_prepared_relation_schemas(
    pending: Vec<PendingSchemaRecovery>,
) -> Result<usize, String> {
    let count = pending.len();
    for PendingSchemaRecovery {
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
                return Err("Relation schema manifest changed during recovery".to_owned());
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
pub(crate) fn recover_pending_relation_schemas(vault: &Path) -> Result<usize, String> {
    let pending = prepare_pending_relation_schemas(vault)?;
    restore_prepared_relation_schemas(pending)
}

#[cfg(test)]
#[path = "relation_schema_recovery_test.rs"]
mod tests;
