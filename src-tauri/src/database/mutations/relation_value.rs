use std::fs;
use std::path::Path;

use crate::database::format::{parse_manifest, raw_revision, PropertyDefinition, PropertyValue};
use crate::frontmatter::{self};
use crate::watcher::{self, WatcherState};

use super::*;

pub fn update_database_relation_value(
    vault: &Path,
    watcher: &WatcherState,
    request: &UpdateDatabaseRelationValueRequest,
    history: Option<&crate::database::history::DatabaseHistoryState>,
) -> Result<UpdateDatabaseRelationValueResult, String> {
    #[cfg(test)]
    let before_publish_hook = RELATION_BEFORE_PUBLISH_HOOK.with(|hook| hook.borrow_mut().take());
    #[cfg(test)]
    let mut before_write_hook = RELATION_BEFORE_WRITE_HOOK.with(|hook| hook.borrow_mut().take());
    if request.expected_revision.is_empty() {
        return Err("expectedRevision is required for relation updates".to_owned());
    }
    if !frontmatter::is_amby_id(&request.note_id) || !frontmatter::is_amby_id(&request.property_id)
    {
        return Err("noteId and propertyId must be canonical ULIDs".to_owned());
    }
    if let Some(result) = crate::database::relation_recovery::replay(vault, request)? {
        return Ok(result);
    }
    crate::database::relation_recovery::ensure_no_pending(vault)?;
    crate::database::relation_schema_recovery::ensure_no_pending(vault)?;
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = crate::database::discovery::manifest_path_for_container(&container);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes).map_err(|error| error.to_string())?;
    let mut manifest_inputs = vec![(manifest_path, manifest_bytes)];
    if manifest.value.locked {
        return Err("Database is locked".to_owned());
    }

    let rel_prop = manifest
        .value
        .properties
        .iter()
        .find_map(|p| match p {
            PropertyDefinition::Relation(fields) if fields.id == request.property_id => {
                Some(fields.clone())
            }
            _ => None,
        })
        .ok_or_else(|| format!("Relation property not found: {}", request.property_id))?;

    let target_database_id = rel_prop.config.target_database_id.clone();
    let max_items = rel_prop.config.max_items;
    let inverse_property_id = rel_prop.config.inverse_property_id.clone();

    // Respect max_items == Some(1)
    if request
        .target_note_ids
        .iter()
        .any(|id| !frontmatter::is_amby_id(id))
    {
        return Err("targetNoteIds must be canonical ULIDs".to_owned());
    }
    let mut clean_targets = Vec::new();
    for id in &request.target_note_ids {
        if !clean_targets.contains(id) {
            clean_targets.push(id.clone());
            if max_items == Some(1) {
                break;
            }
        }
    }

    // 1. Update source note frontmatter
    let note_path = crate::paths::confine(
        vault,
        &resolve_note_path_for_id(vault, &container, &request.note_id)?,
    )?;
    let original_bytes = fs::read(&note_path).map_err(|e| e.to_string())?;
    if raw_revision(&original_bytes) != request.expected_revision {
        return Err("Relation source revision conflict".to_owned());
    }
    let content = String::from_utf8(original_bytes.clone()).map_err(|e| e.to_string())?;
    let prop_def = PropertyDefinition::Relation(rel_prop.clone());
    let prop_name = prop_def
        .frontmatter_key()
        .ok_or_else(|| "Relation property has no storage key or name".to_owned())?;

    // Get previous targets from frontmatter if any
    let prev_targets = relation_targets_from_content(&content, &prop_def)?;
    let mut warnings = Vec::new();

    let mut planned_writes = Vec::<RelationPlannedWrite>::new();

    let mut source_content = content;
    if clean_targets.is_empty() {
        source_content = frontmatter::remove_yaml_binding_lossless(&source_content, prop_name)?;
    } else {
        let val = PropertyValue::Relation {
            target_note_ids: clean_targets.clone(),
            extra: Default::default(),
        };
        if let Some(yaml_val) = crate::database::format::property_value_to_frontmatter_value(
            &val,
            &PropertyDefinition::Relation(rel_prop.clone()),
        ) {
            source_content =
                frontmatter::replace_yaml_binding_lossless(&source_content, prop_name, &yaml_val)?;
        }
    }

    if let Some(inv_prop_id) = inverse_property_id {
        let target_container = find_database_container(vault, &target_database_id)?;
        let target_manifest_path =
            crate::database::discovery::manifest_path_for_container(&target_container);
        let target_bytes = fs::read(&target_manifest_path).map_err(|e| e.to_string())?;
        let target_manifest = parse_manifest(&target_bytes).map_err(|e| e.to_string())?;
        manifest_inputs.push((target_manifest_path, target_bytes));
        if target_manifest.value.locked {
            return Err("Target database is locked".to_owned());
        }
        let inv_prop_def = target_manifest
            .value
            .properties
            .iter()
            .find(|p| p.id() == Some(inv_prop_id.as_str()))
            .ok_or_else(|| {
                format!("Inverse property {inv_prop_id} not found in target database")
            })?;
        if !matches!(inv_prop_def, PropertyDefinition::Relation(_)) {
            return Err("Inverse property is not a relation".to_owned());
        }
        let inv_prop_name = inv_prop_def
            .frontmatter_key()
            .ok_or_else(|| "Inverse property has no storage key or name".to_owned())?;

        let added_targets = clean_targets
            .iter()
            .filter(|id| !prev_targets.contains(id))
            .collect::<Vec<_>>();
        let removed_targets = prev_targets
            .iter()
            .filter(|id| !clean_targets.contains(id))
            .collect::<std::collections::BTreeSet<_>>();

        for target_id in added_targets {
            if target_id == &request.note_id {
                // Self-relation: update source_content directly
                let mut list = relation_targets_from_content(&source_content, inv_prop_def)?;
                if !list.contains(&request.note_id) {
                    list.push(request.note_id.clone());
                    let r_val = PropertyValue::Relation {
                        target_note_ids: list,
                        extra: Default::default(),
                    };
                    if let Some(y_val) =
                        crate::database::format::property_value_to_frontmatter_value(
                            &r_val,
                            inv_prop_def,
                        )
                    {
                        source_content = frontmatter::replace_yaml_binding_lossless(
                            &source_content,
                            inv_prop_name,
                            &y_val,
                        )?;
                    }
                }
            } else {
                let t_path = crate::paths::confine(
                    vault,
                    &resolve_note_path_for_id(vault, &target_container, target_id)?,
                )?;
                let t_orig = fs::read(&t_path)
                    .map_err(|e| format!("Target note not readable {target_id}: {e}"))?;
                let t_content = String::from_utf8(t_orig.clone()).map_err(|e| e.to_string())?;
                let mut list = relation_targets_from_content(&t_content, inv_prop_def)?;
                if !list.contains(&request.note_id) {
                    list.push(request.note_id.clone());
                    let r_val = PropertyValue::Relation {
                        target_note_ids: list,
                        extra: Default::default(),
                    };
                    if let Some(y_val) =
                        crate::database::format::property_value_to_frontmatter_value(
                            &r_val,
                            inv_prop_def,
                        )
                    {
                        let t_next = frontmatter::replace_yaml_binding_lossless(
                            &t_content,
                            inv_prop_name,
                            &y_val,
                        )?;
                        planned_writes.push(RelationPlannedWrite {
                            path: t_path,
                            post_bytes: t_next.into_bytes(),
                            pre_bytes: t_orig,
                            affected_note: DatabaseAffectedNote {
                                database_id: target_database_id.clone(),
                                note_id: target_id.clone(),
                            },
                        });
                    }
                }
            }
        }

        for target_id in removed_targets {
            if target_id == &request.note_id {
                // Self-relation: update source_content directly
                let mut list = relation_targets_from_content(&source_content, inv_prop_def)?;
                if list.contains(&request.note_id) {
                    list.retain(|id| id != &request.note_id);
                    if list.is_empty() {
                        source_content = frontmatter::remove_yaml_binding_lossless(
                            &source_content,
                            inv_prop_name,
                        )?;
                    } else {
                        let r_val = PropertyValue::Relation {
                            target_note_ids: list,
                            extra: Default::default(),
                        };
                        if let Some(y_val) =
                            crate::database::format::property_value_to_frontmatter_value(
                                &r_val,
                                inv_prop_def,
                            )
                        {
                            source_content = frontmatter::replace_yaml_binding_lossless(
                                &source_content,
                                inv_prop_name,
                                &y_val,
                            )?;
                        }
                    }
                }
            } else {
                let Some(t_path) =
                    resolve_note_path_for_id_optional(vault, &target_container, target_id)?
                else {
                    warnings.push(format!(
                        "Previous relation target {target_id} was not found; inverse value could not be updated"
                    ));
                    continue;
                };
                let t_path = crate::paths::confine(vault, &t_path)?;
                let t_orig = fs::read(&t_path)
                    .map_err(|error| format!("Target note not readable {target_id}: {error}"))?;
                let t_content =
                    String::from_utf8(t_orig.clone()).map_err(|error| error.to_string())?;
                let mut list = relation_targets_from_content(&t_content, inv_prop_def)?;
                if list.contains(&request.note_id) {
                    list.retain(|id| id != &request.note_id);
                    let t_next = if list.is_empty() {
                        frontmatter::remove_yaml_binding_lossless(&t_content, inv_prop_name)?
                    } else {
                        let r_val = PropertyValue::Relation {
                            target_note_ids: list,
                            extra: Default::default(),
                        };
                        let y_val = crate::database::format::property_value_to_frontmatter_value(
                            &r_val,
                            inv_prop_def,
                        )
                        .ok_or_else(|| "Failed to serialize relation".to_owned())?;
                        frontmatter::replace_yaml_binding_lossless(
                            &t_content,
                            inv_prop_name,
                            &y_val,
                        )?
                    };
                    planned_writes.push(RelationPlannedWrite {
                        path: t_path,
                        post_bytes: t_next.into_bytes(),
                        pre_bytes: t_orig,
                        affected_note: DatabaseAffectedNote {
                            database_id: target_database_id.clone(),
                            note_id: target_id.clone(),
                        },
                    });
                }
            }
        }
    }

    // Source note is included in planned writes
    planned_writes.insert(
        0,
        RelationPlannedWrite {
            path: note_path,
            post_bytes: source_content.into_bytes(),
            pre_bytes: original_bytes,
            affected_note: DatabaseAffectedNote {
                database_id: request.database_id.clone(),
                note_id: request.note_id.clone(),
            },
        },
    );

    #[cfg(test)]
    if let Some(hook) = before_publish_hook {
        hook();
    }
    check_relation_manifest_revisions(vault, &manifest_inputs)?;
    for planned in &planned_writes {
        check_relation_file_revision(vault, &planned.path, &planned.pre_bytes, "record")?;
    }

    let affected_notes = planned_writes
        .iter()
        .map(|planned| {
            (
                planned.affected_note.database_id.clone(),
                planned.affected_note.note_id.clone(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|(database_id, note_id)| DatabaseAffectedNote {
            database_id,
            note_id,
        })
        .collect();
    let result = UpdateDatabaseRelationValueResult {
        operation_id: request.operation_id.clone(),
        database_id: request.database_id.clone(),
        note_id: request.note_id.clone(),
        target_note_ids: clean_targets,
        affected_notes,
        revisions: planned_writes
            .iter()
            .map(|planned| DatabaseNoteRevision {
                note_id: planned.affected_note.note_id.clone(),
                revision: raw_revision(&planned.post_bytes),
            })
            .collect(),
        warnings,
    };

    // Snapshot and execute atomic writes with rollback
    for planned in &planned_writes {
        crate::history::snapshot_before_write(
            vault,
            &planned.path,
            &planned.post_bytes,
            "database-value",
        )?;
    }
    let mut journal =
        crate::database::relation_recovery::prepare(vault, request, &planned_writes, &result)?;
    let write = watcher.prepare_write(planned_writes.iter().map(|planned| {
        (
            planned.path.as_path(),
            watcher::fingerprint_for_bytes(&planned.post_bytes),
        )
    }));

    let mut written = Vec::new();
    let mut write_err = None;
    for planned in &planned_writes {
        #[cfg(test)]
        if let Some(hook) = before_write_hook.as_mut() {
            hook(written.len());
        }
        if let Err(error) = journal
            .check_revision()
            .and_then(|()| check_relation_manifest_revisions(vault, &manifest_inputs))
            .and_then(|()| {
                check_relation_file_revision(vault, &planned.path, &planned.pre_bytes, "record")
            })
        {
            write_err = Some(error);
            break;
        }
        // Even an atomic write that reports a post-rename sync failure may
        // have published its bytes. Conditional rollback verifies what remains.
        written.push(planned);
        if let Err(error) = frontmatter::atomic_write_bytes(&planned.path, &planned.post_bytes) {
            write_err = Some(error);
            break;
        }
        if let Err(error) = journal.applied(written.len() - 1) {
            write_err = Some(error);
            break;
        }
    }

    if let Some(error) = write_err {
        watcher.cancel_prepared_write(&write);
        let rollback_errors = rollback_relation_writes(vault, &written);
        if !rollback_errors.is_empty() {
            return Err(format!(
                "Relation write failed: {error}; rollback incomplete: {}",
                rollback_errors.join("; ")
            ));
        }
        if let Err(outcome_error) = journal.rolled_back() {
            return Err(format!(
                "Relation write failed: {error}; notes rolled back but journal outcome could not be recorded: {outcome_error}"
            ));
        }
        return Err(format!(
            "Relation write failed; rolled back written files: {error}"
        ));
    }
    if let Err(error) = journal.completed() {
        watcher.cancel_prepared_write(&write);
        return Err(format!(
            "Relation files were written but completion could not be recorded for operation {}: {error}; recovery journal retained",
            request.operation_id
        ));
    }
    watcher.confirm_prepared_write(&write);

    if let Some(history) = history {
        if !planned_writes.is_empty() {
            let files = planned_writes
                .iter()
                .map(|planned| crate::database::history::DatabaseHistoryFile {
                    path: planned.path.clone(),
                    note_id: planned.affected_note.note_id.clone(),
                    pre_bytes: planned.pre_bytes.clone(),
                    pre_revision: raw_revision(&planned.pre_bytes),
                    post_bytes: planned.post_bytes.clone(),
                    post_revision: raw_revision(&planned.post_bytes),
                })
                .collect();
            history.push(crate::database::history::DatabaseHistoryEntry {
                database_id: request.database_id.clone(),
                description: format!("Update relation for note {}", request.note_id),
                files,
            });
        }
    }

    Ok(result)
}
