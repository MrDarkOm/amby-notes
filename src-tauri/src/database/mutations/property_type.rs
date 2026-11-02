use std::fs;
use std::path::{Path, PathBuf};

use crate::database::format::{parse_manifest, prepare_json, PropertyDefinition};
use crate::database::validation::validate_manifest;
use crate::frontmatter::{self};
use crate::watcher::{self, WatcherState};

use super::*;

pub fn change_database_property_type(
    vault: &Path,
    watcher: &WatcherState,
    request: &ChangeDatabasePropertyTypeRequest,
) -> Result<ChangedDatabasePropertyType, String> {
    let operation_may_be_relation =
        request.property_type == "relation" || request.operation_id.is_some();
    if operation_may_be_relation {
        if let Some(result) =
            crate::database::relation_schema_recovery::replay_type_change(vault, request)?
        {
            return Ok(result);
        }
        crate::database::relation_schema_recovery::ensure_no_pending(vault)?;
        crate::database::relation_recovery::ensure_no_pending(vault)?;
    }

    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = crate::database::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if !parsed.is_writable() {
        return Err("Database manifest is read-only".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }
    let index = parsed
        .value
        .properties
        .iter()
        .position(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property was not found".to_owned())?;
    let current_property = parsed.value.properties[index].clone();
    let old_relation = relation_config(&current_property);
    let new_relation = request.property_type == "relation";
    if (old_relation.is_some() || new_relation)
        && request
            .operation_id
            .as_deref()
            .is_none_or(|id| id.is_empty())
    {
        return Err("Relation property changes require operationId".to_owned());
    }

    if old_relation.is_none() && !new_relation && current_property.kind() == request.property_type {
        return Ok(ChangedDatabasePropertyType {
            database_id: request.database_id.clone(),
            property_id: request.property_id.clone(),
            property_type: request.property_type.clone(),
            manifest_revision: parsed.revision.clone(),
            operation_id: None,
            inverse_property_id: None,
            manifest_revisions: vec![DatabaseManifestRevision {
                database_id: request.database_id.clone(),
                revision: parsed.revision,
            }],
            warnings: Vec::new(),
        });
    }

    let related_revisions = related_revision_map(request)?;
    let old_relation_target = old_relation.map(|(_, target, _, _)| target.to_owned());
    let old_inverse_id = old_relation.and_then(|(_, _, _, inverse)| inverse.map(str::to_owned));
    if old_inverse_id.as_deref() == Some(request.property_id.as_str()) {
        return Err("Relation inverse property cannot be the source property".to_owned());
    }
    let target_database_id = if new_relation {
        request
            .relation_target_database_id
            .as_deref()
            .or(old_relation_target.as_deref())
            .unwrap_or(&request.database_id)
            .to_owned()
    } else {
        request.database_id.clone()
    };
    if new_relation && !frontmatter::is_amby_id(&target_database_id) {
        return Err("Invalid Relation target database ID".to_owned());
    }
    let old_max_items = old_relation.and_then(|(_, _, max_items, _)| max_items);
    let max_items = if new_relation {
        request.relation_max_items.map_or(old_max_items, |value| {
            normalize_relation_max_items(Some(value))
        })
    } else {
        None
    };
    let old_two_way = old_inverse_id.is_some();
    let new_two_way = new_relation && request.relation_two_way.unwrap_or(old_two_way);
    // The limit is a rule for new links, not a change to stored ones: links beyond a new
    // one-page limit stay stored (only the first is used), so it never waits for values to go.
    let topology_changed = old_relation.is_some()
        && (!new_relation
            || old_relation_target.as_deref() != Some(target_database_id.as_str())
            || old_two_way != new_two_way);

    if current_property.kind() != request.property_type && current_property.yaml_binding().is_some()
    {
        return Err("Remove the YAML binding before changing the property type".to_owned());
    }
    for property in &parsed.value.properties {
        let referenced = match property {
            PropertyDefinition::Formula(fields) => {
                fields
                    .config
                    .dependencies
                    .iter()
                    .any(|dependency| dependency == &request.property_id)
                    || crate::database::formula::extract_dependencies(&fields.config.expression)
                        .is_ok_and(|dependencies| {
                            dependencies.iter().any(|dependency| {
                                dependency == &request.property_id
                                    || Some(dependency.as_str()) == current_property.name()
                            })
                        })
            }
            PropertyDefinition::Rollup(fields) => {
                fields.config.relation_property_id == request.property_id
                    || fields.config.target_property_id == request.property_id
            }
            _ => false,
        };
        if referenced {
            return Err(
                "Property type cannot be changed while another property depends on it".to_owned(),
            );
        }
    }

    if old_relation.is_none() || topology_changed {
        ensure_property_has_no_durable_values(
            vault,
            &request.database_id,
            &container,
            &current_property,
        )?;
    }
    let mut related = std::collections::BTreeMap::<
        String,
        (
            PathBuf,
            Vec<u8>,
            crate::database::format::ParsedJson<crate::database::format::DatabaseManifest>,
            crate::database::format::DatabaseManifest,
        ),
    >::new();
    let mut load_related = |database_id: &str| -> Result<(), String> {
        if database_id == request.database_id || related.contains_key(database_id) {
            return Ok(());
        }
        let expected = related_revisions.get(database_id).ok_or_else(|| {
            format!("Expected manifest revision is required for related database {database_id}")
        })?;
        let related_container = find_database_container(vault, database_id)?;
        let related_path =
            crate::database::discovery::manifest_path_for_container(&related_container);
        let related_bytes = fs::read(&related_path).map_err(|error| error.to_string())?;
        let related_parsed = parse_manifest(&related_bytes).map_err(|error| error.to_string())?;
        if related_parsed.revision != *expected {
            return Err("Related manifest revision conflict".to_owned());
        }
        if !related_parsed.is_writable() {
            return Err("Related database manifest is read-only".to_owned());
        }
        if related_parsed.value.locked {
            return Err("Related database is locked".to_owned());
        }
        related.insert(
            database_id.to_owned(),
            (
                related_path,
                related_bytes,
                related_parsed.clone(),
                related_parsed.value.clone(),
            ),
        );
        Ok(())
    };

    if let Some(old_target) = old_relation_target.as_deref() {
        if old_inverse_id.is_some() && old_target != request.database_id {
            load_related(old_target)?;
        }
    }
    if new_relation && target_database_id != request.database_id {
        load_related(&target_database_id)?;
    }
    if related.keys().any(|id| !related_revisions.contains_key(id)) {
        return Err("Related manifest revisions must match every related manifest".to_owned());
    }

    let mut source_manifest = parsed.value.clone();

    // Detach the former counterpart before deciding whether a new target needs
    // an inverse. The counterpart remains in place with all unknown metadata.
    if let Some(old_inverse_id) = old_inverse_id.as_deref() {
        let old_target = old_relation_target
            .as_deref()
            .ok_or_else(|| "Relation inverse has no target database".to_owned())?;
        let old_manifest = if old_target == request.database_id {
            &mut source_manifest
        } else {
            &mut related
                .get_mut(old_target)
                .ok_or_else(|| "Old Relation target was not loaded".to_owned())?
                .3
        };
        let inverse = relation_property_mut(old_manifest, old_inverse_id)?;
        let Some((_, inverse_target, _, inverse_inverse)) = relation_config(inverse) else {
            return Err("Related inverse property is not a Relation".to_owned());
        };
        if inverse_target != request.database_id
            || inverse_inverse != Some(request.property_id.as_str())
        {
            return Err("Related inverse property is not reciprocal".to_owned());
        }
        let inverse_before = inverse.clone();
        if topology_changed {
            let inverse_container = if old_target == request.database_id {
                container.clone()
            } else {
                find_database_container(vault, old_target)?
            };
            ensure_property_has_no_durable_values(
                vault,
                old_target,
                &inverse_container,
                &inverse_before,
            )?;
        }
        if !new_two_way || old_target != target_database_id {
            *inverse = property_with_relation_config(
                &inverse_before,
                request.database_id.as_str(),
                relation_config(&inverse_before).and_then(|(_, _, max, _)| max),
                None,
            )?;
        }
    }

    let inverse_property_id = if new_relation && new_two_way {
        if old_target_matches(old_relation_target.as_deref(), target_database_id.as_str())
            && old_inverse_id.is_some()
        {
            old_inverse_id.clone()
        } else {
            Some(ulid::Ulid::generate().to_string())
        }
    } else {
        None
    };
    let source_property = if new_relation {
        property_with_relation_config(
            &current_property,
            &target_database_id,
            max_items,
            inverse_property_id.as_deref(),
        )?
    } else {
        let config = default_property_config(
            &request.property_type,
            &request.database_id,
            None,
            None,
            None,
        )?;
        property_with_type_and_config(&current_property, &request.property_type, config)?
    };
    source_manifest.properties[index] = source_property;

    if new_relation && new_two_way {
        let inverse_id = inverse_property_id
            .as_deref()
            .ok_or_else(|| "Failed to determine Relation inverse ID".to_owned())?;
        let inverse_exists = if target_database_id == request.database_id {
            source_manifest
                .properties
                .iter()
                .any(|property| property.id() == Some(inverse_id))
        } else {
            related
                .get(&target_database_id)
                .is_some_and(|(_, _, _, manifest)| {
                    manifest
                        .properties
                        .iter()
                        .any(|property| property.id() == Some(inverse_id))
                })
        };
        if !inverse_exists {
            let target_manifest = if target_database_id == request.database_id {
                &mut source_manifest
            } else {
                &mut related
                    .get_mut(&target_database_id)
                    .ok_or_else(|| "New Relation target was not loaded".to_owned())?
                    .3
            };
            let inverse_name = request
                .relation_inverse_property_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| {
                    if target_database_id == request.database_id {
                        "Обратная связь"
                    } else {
                        current_property.name().unwrap_or("Обратная связь")
                    }
                });
            ensure_relation_name_available(target_manifest, inverse_name)?;
            target_manifest.properties.push(relation_inverse_property(
                inverse_id,
                inverse_name,
                &request.database_id,
                &request.property_id,
            )?);
        } else {
            let target_manifest = if target_database_id == request.database_id {
                &mut source_manifest
            } else {
                &mut related
                    .get_mut(&target_database_id)
                    .ok_or_else(|| "New Relation target was not loaded".to_owned())?
                    .3
            };
            let inverse = relation_property_mut(target_manifest, inverse_id)?;
            let inverse_before = inverse.clone();
            if relation_config(&inverse_before).is_none_or(|(_, target, _, inverse)| {
                target != request.database_id || inverse != Some(request.property_id.as_str())
            }) {
                return Err("Existing Relation inverse is not reciprocal".to_owned());
            }
            *inverse = property_with_relation_config(
                &inverse_before,
                &request.database_id,
                relation_config(&inverse_before).and_then(|(_, _, max, _)| max),
                Some(&request.property_id),
            )?;
        }
    }

    let report = validate_manifest(&source_manifest);
    if !report.errors.is_empty() {
        return Err("Property type change would make the database manifest invalid".to_owned());
    }
    for (_, _, _, manifest) in related.values() {
        let report = validate_manifest(manifest);
        if !report.errors.is_empty() {
            return Err("Related property type change would make a manifest invalid".to_owned());
        }
    }

    let read_guard_paths = related
        .values()
        .map(|(path, original, _, manifest)| (path.clone(), original.clone(), manifest.clone()))
        .collect::<Vec<_>>();
    let source_prepared =
        prepare_json(&parsed, &source_manifest).map_err(|error| error.to_string())?;
    let mut writes = vec![
        crate::database::relation_schema_recovery::SchemaPlannedWrite {
            database_id: request.database_id.clone(),
            path: manifest_path,
            pre_bytes: original,
            post_bytes: source_prepared.bytes,
        },
    ];
    let mut manifest_revisions = vec![DatabaseManifestRevision {
        database_id: request.database_id.clone(),
        revision: source_prepared.revision.clone(),
    }];
    for (database_id, (path, original, parsed, manifest)) in related {
        if manifest == parsed.value {
            continue;
        }
        let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
        writes.push(
            crate::database::relation_schema_recovery::SchemaPlannedWrite {
                database_id: database_id.clone(),
                path,
                pre_bytes: original,
                post_bytes: prepared.bytes.clone(),
            },
        );
        manifest_revisions.push(DatabaseManifestRevision {
            database_id,
            revision: prepared.revision,
        });
    }
    if writes.len() > 1 && related_revisions.len() < writes.len() - 1 {
        return Err("Related manifest revisions are incomplete".to_owned());
    }

    let mut result = ChangedDatabasePropertyType {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        property_type: request.property_type.clone(),
        manifest_revision: manifest_revisions[0].revision.clone(),
        operation_id: request.operation_id.clone(),
        inverse_property_id,
        manifest_revisions,
        warnings: Vec::new(),
    };
    for (path, original, _) in read_guard_paths {
        if writes.iter().any(|write| write.path == path) {
            continue;
        }
        check_relation_file_revision(vault, &path, &original, "related manifest")?;
    }
    if writes
        .iter()
        .all(|write| write.pre_bytes == write.post_bytes)
    {
        // No durable operation is published for an unchanged request. Do not
        // report its caller-supplied ID as a persisted replayable outcome.
        result.operation_id = None;
        return Ok(result);
    }
    if old_relation.is_none() && !new_relation {
        let current = fs::read(&writes[0].path).map_err(|error| error.to_string())?;
        if current != writes[0].pre_bytes {
            return Err("Manifest revision conflict".to_owned());
        }
        crate::history::snapshot_before_write(
            vault,
            &writes[0].path,
            &writes[0].post_bytes,
            "database-schema",
        )?;
        let prepared_write = watcher.prepare_write([(
            writes[0].path.clone(),
            watcher::fingerprint_for_bytes(&writes[0].post_bytes),
        )]);
        if let Err(error) = frontmatter::atomic_write_bytes(&writes[0].path, &writes[0].post_bytes)
        {
            watcher.cancel_prepared_write(&prepared_write);
            return Err(error);
        }
        watcher.confirm_prepared_write(&prepared_write);
        return Ok(result);
    }
    crate::database::relation_schema_recovery::publish_type_change(
        vault, watcher, request, &writes, &result,
    )?;
    Ok(result)
}

pub(super) fn old_target_matches(old_target: Option<&str>, new_target: &str) -> bool {
    old_target == Some(new_target)
}
