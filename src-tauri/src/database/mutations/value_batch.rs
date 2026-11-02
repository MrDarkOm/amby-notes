use std::fs;
use std::path::{Path, PathBuf};

use crate::database::format::{parse_manifest, raw_revision, PropertyDefinition, PropertyValue};
use crate::database::value_batch_recovery::BatchRecovery;
use crate::durable::valid_operation_id;
use crate::frontmatter::{self};
use crate::watcher::{self, WatcherState};

use super::*;

pub(super) fn relation_targets_from_content(
    content: &str,
    property: &PropertyDefinition,
) -> Result<Vec<String>, String> {
    let Some(mapping) = frontmatter::frontmatter_yaml_mapping(content)? else {
        return Ok(Vec::new());
    };
    let Some(value) = crate::database::format::resolve_property_yaml_value(&mapping, property)
    else {
        return Ok(Vec::new());
    };
    let items = match value {
        serde_yaml::Value::String(item) => vec![item.as_str()],
        serde_yaml::Value::Sequence(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .ok_or_else(|| "Invalid stored relation value".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("Invalid stored relation value".to_owned()),
    };
    items
        .into_iter()
        .map(|item| {
            let item = item.trim();
            let id = match item.strip_prefix("[[") {
                Some(inner) => inner
                    .strip_suffix("]]")
                    .ok_or_else(|| "Invalid stored relation target ID".to_owned())?
                    .trim(),
                None => item,
            };
            if !frontmatter::is_amby_id(id) {
                return Err("Invalid stored relation target ID".to_owned());
            }
            Ok(id.to_owned())
        })
        .collect()
}

/// Validate the complete batch and write property values directly into each
/// note's frontmatter using raw-byte CAS.
pub fn apply_value_batch(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseValueBatchRequest,
    history: Option<&crate::database::history::DatabaseHistoryState>,
) -> Result<DatabaseValueBatchResult, String> {
    apply_value_batch_typed(vault, watcher, request, history).map_err(|error| error.to_string())
}

/// Why a value batch was refused. A stale revision is told apart by type, so callers do not
/// have to read a message to learn that the page changed and which revision it has now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValueBatchError {
    RevisionConflict {
        note_id: String,
        /// The revision of the note's bytes on disk when the conflict was found.
        actual_revision: String,
        path: PathBuf,
    },
    Failed(String),
}

impl From<String> for ValueBatchError {
    fn from(message: String) -> Self {
        ValueBatchError::Failed(message)
    }
}

impl std::fmt::Display for ValueBatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValueBatchError::RevisionConflict { path, .. } => {
                write!(formatter, "Record revision conflict for {}", path.display())
            }
            ValueBatchError::Failed(message) => write!(formatter, "{message}"),
        }
    }
}

/// [`apply_value_batch`] with a typed error.
pub fn apply_value_batch_typed(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseValueBatchRequest,
    history: Option<&crate::database::history::DatabaseHistoryState>,
) -> Result<DatabaseValueBatchResult, ValueBatchError> {
    if !valid_operation_id(&request.operation_id) || request.cells.is_empty() {
        return Err("operationId and at least one cell are required"
            .to_owned()
            .into());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = crate::database::discovery::manifest_path_for_container(&container);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes).map_err(|error| error.to_string())?;

    let mut cells_by_note =
        std::collections::BTreeMap::<String, Vec<&DatabaseValueMutation>>::new();
    for cell in &request.cells {
        if ulid::Ulid::from_string(&cell.note_id).is_err()
            || ulid::Ulid::from_string(&cell.property_id).is_err()
        {
            return Err("noteId and propertyId must be canonical ULIDs"
                .to_owned()
                .into());
        }
        if !manifest
            .value
            .properties
            .iter()
            .any(|p| p.id() == Some(cell.property_id.as_str()))
        {
            return Err(
                format!("Property does not belong to database: {}", cell.property_id).into(),
            );
        }
        cells_by_note
            .entry(cell.note_id.clone())
            .or_default()
            .push(cell);
    }

    let mut planned_writes = Vec::new();
    let mut revisions = Vec::new();

    for (note_id, cells) in cells_by_note {
        let note_path = resolve_note_path_for_id(vault, &container, &note_id)?;
        let original_bytes = fs::read(&note_path).map_err(|error| error.to_string())?;
        let original_rev = raw_revision(&original_bytes);
        let mut content =
            String::from_utf8(original_bytes.clone()).map_err(|error| error.to_string())?;

        // Ensure frontmatter envelope and amby-id exist
        if frontmatter::frontmatter_yaml_mapping(&content)
            .ok()
            .flatten()
            .is_none()
        {
            content = format!("---\namby-id: {note_id}\n---\n{content}");
        } else if frontmatter::read_markdown(&note_path)
            .ok()
            .and_then(|p| p.id)
            .is_none()
        {
            if let Ok(updated) = frontmatter::replace_yaml_binding_lossless(
                &content,
                "amby-id",
                &serde_yaml::Value::String(note_id.clone()),
            ) {
                content = updated;
            }
        }

        let mut all_already_matched = true;
        let mut updated_content = content.clone();

        for cell in &cells {
            let prop_def = manifest
                .value
                .properties
                .iter()
                .find(|p| p.id() == Some(cell.property_id.as_str()))
                .ok_or_else(|| {
                    format!("Property does not belong to database: {}", cell.property_id)
                })?;
            let prop_name = prop_def
                .frontmatter_key()
                .ok_or_else(|| "Property has no storage key or name".to_owned())?;

            if let Some(raw_val) = cell.value_json.as_deref() {
                let prop_val = serde_json::from_str::<PropertyValue>(raw_val)
                    .map_err(|error| format!("Invalid value for {}: {error}", cell.property_id))?;
                if let Some(yaml_val) = crate::database::format::property_value_to_frontmatter_value(
                    &prop_val, prop_def,
                ) {
                    let next = frontmatter::replace_yaml_binding_lossless(
                        &updated_content,
                        prop_name,
                        &yaml_val,
                    )?;
                    if next != updated_content {
                        all_already_matched = false;
                        updated_content = next;
                    }
                } else {
                    let next =
                        frontmatter::remove_yaml_binding_lossless(&updated_content, prop_name)?;
                    if next != updated_content {
                        all_already_matched = false;
                        updated_content = next;
                    }
                }
            } else {
                let next = frontmatter::remove_yaml_binding_lossless(&updated_content, prop_name)?;
                if next != updated_content {
                    all_already_matched = false;
                    updated_content = next;
                }
            }
        }

        // Check revision conflict only if changes are actually needed
        if !all_already_matched {
            for cell in &cells {
                if !cell.expected_revision.is_empty() && cell.expected_revision != original_rev {
                    return Err(ValueBatchError::RevisionConflict {
                        note_id: note_id.clone(),
                        actual_revision: original_rev,
                        path: note_path,
                    });
                }
            }
            planned_writes.push((
                note_path,
                updated_content.into_bytes(),
                original_bytes,
                note_id,
            ));
        } else {
            revisions.push(DatabaseNoteRevision {
                note_id,
                revision: original_rev,
            });
        }
    }

    if let Some(result) =
        crate::database::value_batch_recovery::completed_result(vault, &request.operation_id)
    {
        return Ok(result);
    }
    if planned_writes.is_empty() {
        return Ok(DatabaseValueBatchResult {
            operation_id: request.operation_id.clone(),
            database_id: request.database_id.clone(),
            revisions,
            warnings: Vec::new(),
        });
    }

    // The recovery point (backups + journal) must exist before the first note
    // changes; any failure here aborts the operation with the notes untouched.
    let recovery = BatchRecovery::publish(
        vault,
        &request.operation_id,
        &request.database_id,
        raw_revision(&manifest_bytes),
        &planned_writes,
    )?;

    for (path, bytes, _, _) in &planned_writes {
        crate::history::snapshot_before_write(vault, path, bytes, "database-value")?;
    }

    let prepared_writes = watcher.prepare_write(
        planned_writes
            .iter()
            .map(|(path, bytes, _, _)| (path.as_path(), watcher::fingerprint_for_bytes(bytes))),
    );

    let mut write_error = None;
    for (path, bytes, _, _) in &planned_writes {
        if let Err(error) = frontmatter::atomic_write_bytes(path, bytes) {
            write_error = Some(error);
            break;
        }
    }

    if let Some(error) = write_error {
        watcher.cancel_prepared_write(&prepared_writes);
        return Err(match recovery.roll_back() {
            Ok(()) => format!("Batch write failed; rolled back written notes: {error}"),
            Err(rollback_error) => format!(
                "Batch write failed ({error}) and the rollback is incomplete; the recovery \
                 journal and backups were kept: {rollback_error}"
            ),
        }
        .into());
    }
    watcher.confirm_prepared_write(&prepared_writes);

    if let Some(history) = history {
        let files = planned_writes
            .iter()
            .map(|(path, post_bytes, pre_bytes, note_id)| {
                crate::database::history::DatabaseHistoryFile {
                    path: path.clone(),
                    note_id: note_id.clone(),
                    pre_bytes: pre_bytes.clone(),
                    pre_revision: raw_revision(pre_bytes),
                    post_bytes: post_bytes.clone(),
                    post_revision: raw_revision(post_bytes),
                }
            })
            .collect();
        history.push(crate::database::history::DatabaseHistoryEntry {
            database_id: request.database_id.clone(),
            description: format!("Update {} cell(s)", request.cells.len()),
            files,
        });
    }

    for (_, bytes, _, note_id) in &planned_writes {
        revisions.push(DatabaseNoteRevision {
            note_id: note_id.clone(),
            revision: raw_revision(bytes),
        });
    }

    Ok(recovery.complete(DatabaseValueBatchResult {
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        revisions,
        warnings: Vec::new(),
    }))
}
