use std::fs;
use std::path::Path;

use serde_json::json;

use crate::database::format::{parse_manifest, prepare_json, raw_revision, PropertyDefinition};
use crate::database::validation::validate_manifest;
use crate::frontmatter::{self};
use crate::watcher::{self, WatcherState};

use super::*;

pub fn create_database_property(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabasePropertyRequest,
) -> Result<CreatedDatabaseProperty, String> {
    let two_way = request.property_type == "relation" && request.relation_two_way == Some(true);
    if two_way {
        if let Some(result) = crate::database::relation_schema_recovery::replay(vault, request)? {
            return Ok(result);
        }
    }
    crate::database::relation_schema_recovery::ensure_no_pending(vault)?;
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Property name is required".to_owned());
    }
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = crate::database::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }
    if request.property_type == "relation" {
        ensure_relation_name_available(&parsed.value, name)?;
    }
    if parsed.value.properties.iter().any(|property| {
        serde_json::to_value(property)
            .ok()
            .and_then(|value| {
                value
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .is_some_and(|existing| existing.trim().eq_ignore_ascii_case(name))
    }) {
        return Err("A property with this name already exists".to_owned());
    }

    let (property, config, property_id) =
        build_new_property(vault, &parsed.value, request, name, two_way, None, &[])?;
    let mut manifest = parsed.value.clone();

    // Validate the requested insertion before preparing the reciprocal schema.
    // No target manifest may be published while the source is still fallible.
    if let Some(before_property_id) = request.before_property_id.as_deref() {
        let index = manifest
            .properties
            .iter()
            .position(|candidate| candidate.id() == Some(before_property_id))
            .ok_or_else(|| "Insert position property was not found".to_owned())?;
        manifest.properties.insert(index, property);
    } else {
        manifest.properties.push(property);
    }
    let mut target_write = None;

    // Prepare both schemas without filesystem writes. The durable publisher
    // compares all originals, journals them, then publishes the complete plan.
    if two_way {
        let target_database_id = config
            .get("targetDatabaseId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&request.database_id);
        let inv_id = config
            .get("inversePropertyId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Failed to generate inverse property ID".to_owned())?;

        if target_database_id == request.database_id {
            if request
                .expected_target_manifest_revision
                .as_deref()
                .is_some_and(|revision| revision != request.expected_manifest_revision)
            {
                return Err("Target manifest revision conflict".to_owned());
            }
            let inv_name = request
                .relation_inverse_property_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Обратная связь");
            ensure_relation_name_available(&manifest, inv_name)?;
            let self_inv_prop: PropertyDefinition = serde_json::from_value(json!({
                "type": "relation",
                "id": inv_id,
                "name": inv_name,
                "pageVisibility": "alwaysShow",
                "yamlBinding": null,
                "config": {
                    "targetDatabaseId": request.database_id,
                    "maxItems": null,
                    "inversePropertyId": property_id,
                },
            }))
            .map_err(|error| error.to_string())?;
            manifest.properties.push(self_inv_prop);
        } else {
            let target_container = find_database_container(vault, target_database_id)?;
            let target_manifest_path =
                crate::database::discovery::manifest_path_for_container(&target_container);
            let target_original =
                fs::read(&target_manifest_path).map_err(|error| error.to_string())?;
            let target_parsed =
                parse_manifest(&target_original).map_err(|error| error.to_string())?;
            if request.expected_target_manifest_revision.as_deref() != Some(&target_parsed.revision)
            {
                return Err("Target manifest revision conflict".to_owned());
            }
            if target_parsed.value.locked {
                return Err("Target database is locked".to_owned());
            }
            let inv_name = request
                .relation_inverse_property_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&parsed.value.name);
            ensure_relation_name_available(&target_parsed.value, inv_name)?;
            let target_inv_prop: PropertyDefinition = serde_json::from_value(json!({
                "type": "relation",
                "id": inv_id,
                "name": inv_name,
                "pageVisibility": "alwaysShow",
                "yamlBinding": null,
                "config": {
                    "targetDatabaseId": request.database_id,
                    "maxItems": null,
                    "inversePropertyId": property_id,
                },
            }))
            .map_err(|error| error.to_string())?;

            let mut target_manifest = target_parsed.value.clone();
            target_manifest.properties.push(target_inv_prop);
            let target_report = validate_manifest(&target_manifest);
            if !target_report.errors.is_empty() {
                return Err("Inverse property would make target manifest invalid".to_owned());
            }
            let target_prepared = prepare_json(&target_parsed, &target_manifest)
                .map_err(|error| error.to_string())?;
            target_write = Some(
                crate::database::relation_schema_recovery::SchemaPlannedWrite {
                    database_id: target_database_id.to_owned(),
                    path: target_manifest_path,
                    pre_bytes: target_original,
                    post_bytes: target_prepared.bytes,
                },
            );
        }
    }

    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    let mut result = CreatedDatabaseProperty {
        database_id: request.database_id.clone(),
        property_id,
        name: name.to_owned(),
        property_type: request.property_type.clone(),
        manifest_revision: prepared.revision.clone(),
        operation_id: two_way.then(|| request.operation_id.clone()).flatten(),
        inverse_property_id: config
            .get("inversePropertyId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        manifest_revisions: vec![DatabaseManifestRevision {
            database_id: request.database_id.clone(),
            revision: prepared.revision,
        }],
        warnings: Vec::new(),
    };
    if two_way {
        let mut writes = vec![
            crate::database::relation_schema_recovery::SchemaPlannedWrite {
                database_id: request.database_id.clone(),
                path: manifest_path,
                pre_bytes: original,
                post_bytes: prepared.bytes,
            },
        ];
        if let Some(target_write) = target_write {
            result.manifest_revisions.push(DatabaseManifestRevision {
                database_id: target_write.database_id.clone(),
                revision: raw_revision(&target_write.post_bytes),
            });
            writes.push(target_write);
        }
        crate::database::relation_schema_recovery::publish(
            vault, watcher, request, &writes, &result,
        )?;
        return Ok(result);
    }
    let current = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    if raw_revision(&current) != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    crate::history::snapshot_before_write(
        vault,
        &manifest_path,
        &prepared.bytes,
        "database-schema",
    )?;
    let write = watcher.prepare_write([(
        &manifest_path,
        watcher::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &prepared.bytes) {
        watcher.cancel_prepared_write(&write);
        return Err(error);
    }
    watcher.confirm_prepared_write(&write);
    Ok(result)
}

/// IDs chosen before a property exists, so a repeated or recovered multi-step operation
/// (a creative project's text schema) builds byte-identical manifests. The IDs are the
/// same kind `create_database_property` issues: ULIDs.
#[derive(Clone, Debug)]
pub(crate) struct PlannedPropertyIds {
    pub(crate) property_id: String,
    /// One per option, in the order the options are given (empty names and repeats removed).
    pub(crate) option_ids: Vec<String>,
}

impl PlannedPropertyIds {
    pub(crate) fn generate(option_count: usize) -> Self {
        Self {
            property_id: ulid::Ulid::generate().to_string(),
            option_ids: (0..option_count)
                .map(|_| ulid::Ulid::generate().to_string())
                .collect(),
        }
    }
}

/// Builds the definition of a new property for `manifest` without writing anything. Shared
/// by `create_database_property` and by callers that put properties into a manifest they
/// are about to create. `pending_databases` are the IDs of databases that the calling
/// operation creates itself: a relation to one of them is not looked up on disk. Returns the
/// definition, its config and its ID.
pub(crate) fn build_new_property(
    vault: &Path,
    manifest: &crate::database::format::DatabaseManifest,
    request: &CreateDatabasePropertyRequest,
    name: &str,
    two_way: bool,
    planned: Option<&PlannedPropertyIds>,
    pending_databases: &[String],
) -> Result<(PropertyDefinition, serde_json::Value, String), String> {
    let property_id = planned
        .map(|ids| ids.property_id.clone())
        .unwrap_or_else(|| ulid::Ulid::generate().to_string());
    let config = match request.property_type.as_str() {
        "text" => json!({"multiline": false}),
        "number" => json!({"format": "number", "currency": null}),
        "checkbox" | "url" => json!({}),
        "files" => json!({"mediaOnly": false, "maxItems": null}),
        "date" => json!({"includeTime": false, "allowRange": false}),
        "select" | "multiSelect" | "status" => {
            let mut names = std::collections::HashSet::new();
            let options = request
                .options
                .iter()
                .map(|name| name.trim())
                .filter(|name| !name.is_empty())
                .filter(|name| names.insert(name.to_lowercase()))
                .collect::<Vec<_>>();
            let last = options.len().saturating_sub(1);
            let options = options
                .into_iter()
                .enumerate()
                .map(|(index, name)| {
                    let option_id = planned
                        .and_then(|ids| ids.option_ids.get(index))
                        .cloned()
                        .unwrap_or_else(|| ulid::Ulid::generate().to_string());
                    let mut option = json!({
                        "id": option_id,
                        "name": name,
                        "color": "#94a3b8",
                    });
                    if request.property_type == "status" {
                        // A Status option must belong to a group: first to do, last done.
                        option["group"] = json!(if index == 0 {
                            "notStarted"
                        } else if index == last {
                            "done"
                        } else {
                            "inProgress"
                        });
                    }
                    option
                })
                .collect::<Vec<_>>();
            json!({"options": options})
        }
        "formula" => json!({
            "version": 1,
            "expression": request
                .formula_expression
                .as_deref()
                .unwrap_or("0")
                .trim(),
            "resultType": null,
            "dependencies": [],
        }),
        "relation" => {
            let target_database_id = request
                .relation_target_database_id
                .as_deref()
                .or_else(|| {
                    request
                        .options
                        .first()
                        .filter(|id| !id.trim().is_empty())
                        .map(String::as_str)
                })
                .unwrap_or(&request.database_id);
            // A database the same operation is about to create is not on disk yet, and a
            // property's own database always is. Any other target must exist already.
            if target_database_id != request.database_id
                && !pending_databases.iter().any(|id| id == target_database_id)
            {
                find_database_container(vault, target_database_id)?;
            }
            let max_items = request.relation_max_items.filter(|&limit| limit == 1);
            let inverse_property_id = if two_way {
                Some(ulid::Ulid::generate().to_string())
            } else {
                None
            };
            json!({
                "targetDatabaseId": target_database_id,
                "maxItems": max_items,
                "inversePropertyId": inverse_property_id,
            })
        }
        "rollup" => {
            let (Some(relation), Some(target), Some(aggregation)) = (
                request.rollup_relation_property_id.as_deref(),
                request.rollup_target_property_id.as_deref(),
                request.rollup_aggregation.as_deref(),
            ) else {
                return Err(
                    "Rollup requires a relation, a target property and an aggregation".to_owned(),
                );
            };
            crate::database::rollup_config::rollup_config_json(
                vault,
                manifest,
                None,
                relation,
                target,
                aggregation,
            )?
        }
        _ => return Err("Unsupported property type".to_owned()),
    };
    let storage_key = match request.property_type.as_str() {
        "formula" | "rollup" => None,
        _ => storage_key_for_new_property(manifest, name),
    };
    let property: PropertyDefinition = serde_json::from_value(json!({
        "type": request.property_type,
        "id": property_id,
        "name": name,
        "pageVisibility": "alwaysShow",
        "yamlBinding": storage_key.map(|key| json!({"key": key, "direction": "twoWay"})),
        "config": config,
    }))
    .map_err(|error| error.to_string())?;
    Ok((property, config, property_id))
}

/// The key a new property's values are stored under: its name, unless another property already
/// reads that key (a renamed property keeps its old name as its key). Then the new property gets
/// a numbered key of its own, so any name can be used and two properties never share values.
pub(super) fn storage_key_for_new_property(
    manifest: &crate::database::format::DatabaseManifest,
    name: &str,
) -> Option<String> {
    let taken = |candidate: &str| {
        manifest.properties.iter().any(|property| {
            !matches!(
                property,
                PropertyDefinition::Formula(_) | PropertyDefinition::Rollup(_)
            ) && property
                .frontmatter_key()
                .is_some_and(|key| key.trim().eq_ignore_ascii_case(candidate.trim()))
        })
    };
    if !taken(name) {
        return None;
    }
    (2..)
        .map(|number| format!("{name} {number}"))
        .find(|candidate| !taken(candidate))
}

pub(super) fn ensure_relation_name_available(
    manifest: &crate::database::format::DatabaseManifest,
    name: &str,
) -> Result<(), String> {
    if crate::database::format::is_reserved_system_key(name)
        || manifest.properties.iter().any(|property| {
            let opaque_collision = if let PropertyDefinition::Opaque(value) = property {
                [
                    value.get("name"),
                    value.get("id"),
                    value.pointer("/yamlBinding/key"),
                ]
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .any(|key| key.trim().eq_ignore_ascii_case(name))
            } else {
                false
            };
            opaque_collision
                || property
                    .name()
                    .is_some_and(|existing| existing.trim().eq_ignore_ascii_case(name))
                || property
                    .id()
                    .is_some_and(|id| id.eq_ignore_ascii_case(name))
                || (!matches!(
                    property,
                    PropertyDefinition::Formula(_) | PropertyDefinition::Rollup(_)
                ) && property
                    .frontmatter_key()
                    .is_some_and(|key| key.trim().eq_ignore_ascii_case(name)))
        })
    {
        return Err(
            "Relation property name conflicts with an existing property or YAML key".to_owned(),
        );
    }
    Ok(())
}

pub(super) fn default_property_config(
    property_type: &str,
    database_id: &str,
    relation_target_database_id: Option<&str>,
    relation_max_items: Option<u8>,
    relation_inverse_property_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    match property_type {
        "text" => Ok(json!({"multiline": false})),
        "number" => Ok(json!({"format": "number", "currency": null})),
        "checkbox" | "url" => Ok(json!({})),
        "date" => Ok(json!({"includeTime": false, "allowRange": false})),
        "select" | "multiSelect" | "status" => Ok(json!({"options": []})),
        "formula" => Ok(json!({
            "version": 1,
            "expression": "0",
            "resultType": null,
            "dependencies": [],
        })),
        "relation" => Ok(json!({
            "targetDatabaseId": relation_target_database_id.unwrap_or(database_id),
            "maxItems": relation_max_items.filter(|&limit| limit == 1),
            "inversePropertyId": relation_inverse_property_id,
        })),
        _ => Err("Unsupported property type".to_owned()),
    }
}

pub(super) fn relation_targets_from_mapping(
    mapping: &serde_yaml::Mapping,
    property: &PropertyDefinition,
) -> Result<bool, String> {
    let mut aliases = Vec::new();
    if let Some(key) = property.storage_key() {
        aliases.push(key);
    }
    if let Some(id) = property.id() {
        aliases.push(id);
    }
    if let Some(name) = property.name() {
        aliases.push(name);
    }
    let mut found = false;
    let mut nonempty = false;
    for (key, value) in mapping {
        let serde_yaml::Value::String(key) = key else {
            continue;
        };
        if !aliases
            .iter()
            .any(|alias| alias.trim().eq_ignore_ascii_case(key.trim()))
        {
            continue;
        }
        found = true;
        let items = match value {
            serde_yaml::Value::Sequence(items) => items
                .iter()
                .map(|item| {
                    item.as_str()
                        .ok_or_else(|| "Invalid stored relation value".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?,
            serde_yaml::Value::String(item) => vec![item.as_str()],
            serde_yaml::Value::Null => Vec::new(),
            _ => return Err("Invalid stored relation value".to_owned()),
        };
        for item in items {
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
            nonempty = true;
        }
    }
    Ok(found && nonempty)
}
