use std::fs;
use std::path::Path;

use crate::database::format::{
    parse_manifest, prepare_json, raw_revision, PropertyDefinition, PropertyFields, YamlBinding,
};
use crate::database::validation::validate_manifest;
use crate::frontmatter::{self};
use crate::watcher::{self, WatcherState};

use super::*;

pub fn delete_database_property(
    vault: &Path,
    watcher: &WatcherState,
    request: &DeleteDatabasePropertyRequest,
) -> Result<DeletedDatabaseProperty, String> {
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
    let mut manifest = parsed.value.clone();
    let Some(index) = manifest
        .properties
        .iter()
        .position(|property| property.id() == Some(request.property_id.as_str()))
    else {
        return Err("Property was not found".to_owned());
    };
    manifest.properties.remove(index);
    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property deletion would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
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
    Ok(DeletedDatabaseProperty {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

pub fn reorder_database_properties(
    vault: &Path,
    watcher: &WatcherState,
    request: &ReorderDatabasePropertiesRequest,
) -> Result<ReorderedDatabaseProperties, String> {
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
    let known_ids = parsed
        .value
        .properties
        .iter()
        .filter_map(|property| property.id().map(str::to_owned))
        .collect::<Vec<_>>();
    let requested = request
        .property_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    if request.property_ids.len() != known_ids.len()
        || requested.len() != request.property_ids.len()
        || known_ids.iter().any(|id| !requested.contains(id))
    {
        return Err("Property order must contain every editable property exactly once".to_owned());
    }
    if request.property_ids == known_ids {
        return Ok(ReorderedDatabaseProperties {
            database_id: request.database_id.clone(),
            property_ids: request.property_ids.clone(),
            manifest_revision: parsed.revision,
            warnings: Vec::new(),
        });
    }
    let mut by_id = parsed
        .value
        .properties
        .iter()
        .filter_map(|property| property.id().map(|id| (id.to_owned(), property.clone())))
        .collect::<std::collections::HashMap<_, _>>();
    let mut ordered = request.property_ids.iter();
    let mut manifest = parsed.value.clone();
    for property in &mut manifest.properties {
        if property.id().is_none() {
            continue;
        }
        let id = ordered
            .next()
            .ok_or_else(|| "Property order ended unexpectedly".to_owned())?;
        *property = by_id
            .remove(id)
            .ok_or_else(|| "Property order references a missing property".to_owned())?;
    }
    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property reorder would make the database manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
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
    Ok(ReorderedDatabaseProperties {
        database_id: request.database_id.clone(),
        property_ids: request.property_ids.clone(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

/// Pin a legacy field's existing YAML key before changing its display name.
/// Renaming is a manifest-only operation; note bytes remain user-owned.
pub(super) fn rename_stored_property<C>(fields: &mut PropertyFields<C>, name: &str) {
    if fields.yaml_binding.is_none() {
        fields.yaml_binding = Some(YamlBinding {
            key: fields.name.clone(),
            direction: "twoWay".to_owned(),
            extra: Default::default(),
        });
    }
    fields.name = name.to_owned();
}

pub(super) fn preflight_renamed_property_values(
    container: &Path,
    before: &PropertyDefinition,
    after: &PropertyDefinition,
) -> Result<(), String> {
    let discovery = crate::database::discovery::discover_vault(container)?;
    for note in discovery
        .notes
        .iter()
        .filter(|note| note.owner_container_path.as_deref() == Some(""))
    {
        let content = fs::read_to_string(&note.path).map_err(|error| error.to_string())?;
        // Invalid YAML has no projected property values; it remains untouched.
        let Ok(Some(mapping)) = frontmatter::frontmatter_yaml_mapping(&content) else {
            continue;
        };
        if crate::database::format::resolve_property_yaml_value(&mapping, before)
            != crate::database::format::resolve_property_yaml_value(&mapping, after)
        {
            return Err(format!(
                "Property rename would change a legacy YAML value in {}",
                note.relative_path
            ));
        }
    }
    Ok(())
}

pub fn rename_database_property(
    vault: &Path,
    watcher: &WatcherState,
    request: &RenameDatabasePropertyRequest,
) -> Result<RenamedDatabaseProperty, String> {
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

    let duplicate = parsed.value.properties.iter().any(|property| {
        if property.id() == Some(request.property_id.as_str()) {
            return false;
        }
        serde_json::to_value(property)
            .ok()
            .and_then(|value| {
                value
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .is_some_and(|existing| existing.trim().eq_ignore_ascii_case(name))
    });
    if duplicate {
        return Err("A property with this name already exists".to_owned());
    }

    let previous_property = parsed
        .value
        .properties
        .iter()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property cannot be renamed".to_owned())?;
    if previous_property.name() != Some(name) {
        for property in &parsed.value.properties {
            if let PropertyDefinition::Formula(fields) = property {
                if crate::database::formula::extract_dependencies(&fields.config.expression)
                    .is_ok_and(|dependencies| {
                        dependencies
                            .iter()
                            .any(|dependency| Some(dependency.as_str()) == previous_property.name())
                    })
                {
                    return Err(format!(
                        "Property rename would break formula dependencies in {}",
                        fields.name
                    ));
                }
            }
        }
    }

    let mut manifest = parsed.value.clone();
    let property = manifest
        .properties
        .iter_mut()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property cannot be renamed".to_owned())?;
    match property {
        PropertyDefinition::Text(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Number(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Checkbox(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Date(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Select(fields) | PropertyDefinition::MultiSelect(fields) => {
            rename_stored_property(fields, name);
        }
        PropertyDefinition::Status(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Url(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Files(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Relation(fields) => rename_stored_property(fields, name),
        PropertyDefinition::Formula(fields) => fields.name = name.to_owned(),
        PropertyDefinition::Rollup(fields) => fields.name = name.to_owned(),
        PropertyDefinition::Opaque(_) => return Err("Property cannot be renamed".to_owned()),
    }

    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property rename would make the database manifest invalid".to_owned());
    }
    let renamed_property = manifest
        .properties
        .iter()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property cannot be renamed".to_owned())?;
    if let Some(binding) = renamed_property.yaml_binding() {
        let collision = manifest.properties.iter().any(|property| {
            property.id() != renamed_property.id()
                && (property
                    .id()
                    .is_some_and(|id| id.trim().eq_ignore_ascii_case(binding.key.trim()))
                    || (!matches!(
                        property,
                        PropertyDefinition::Formula(_) | PropertyDefinition::Rollup(_)
                    ) && property
                        .frontmatter_key()
                        .is_some_and(|key| key.trim().eq_ignore_ascii_case(binding.key.trim()))))
        });
        if collision {
            return Err("Property rename would create an ambiguous YAML binding".to_owned());
        }
        preflight_renamed_property_values(&container, previous_property, renamed_property)?;
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
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

    Ok(RenamedDatabaseProperty {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        name: name.to_owned(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}
