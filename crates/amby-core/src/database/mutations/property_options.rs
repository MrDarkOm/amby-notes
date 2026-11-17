use std::fs;
use std::path::Path;

use serde_json::json;

use crate::database::format::{parse_manifest, prepare_json, raw_revision, PropertyDefinition};
use crate::database::validation::validate_manifest;
use crate::frontmatter::{self};
use crate::watcher::{self, WatcherState};

use super::*;

/// Records store the option *name* in their frontmatter and find the option by
/// name or alias, so a renamed option keeps its old name as an alias: records
/// written before the rename still resolve to the same option.
pub(super) fn keep_old_name_as_alias(aliases: &mut Vec<String>, old_name: &str, new_name: &str) {
    if old_name.is_empty() || old_name == new_name {
        return;
    }
    if !aliases
        .iter()
        .any(|alias| alias.eq_ignore_ascii_case(old_name))
    {
        aliases.push(old_name.to_owned());
    }
}

/// A name always wins over an alias: an alias that equals any option's current
/// name is dropped so a name resolves to exactly one option.
pub(super) fn drop_aliases_taken_by_names<T>(
    options: &mut [T],
    parts: impl Fn(&mut T) -> (&String, &mut Vec<String>),
) {
    let names: Vec<String> = options
        .iter_mut()
        .map(|option| parts(option).0.to_lowercase())
        .collect();
    for option in options.iter_mut() {
        let (_, aliases) = parts(option);
        aliases.retain(|alias| !names.contains(&alias.to_lowercase()));
    }
}

pub(super) fn is_hex_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Validated names/colors of a requested option list, in the requested order.
/// The options new rows start with, kept next to the option list (`defaultOptionIds`); an older
/// build keeps the field as it is, and a removed option simply drops out of it.
pub(super) fn store_default_options(
    extra: &mut crate::database::format::ExtraFields,
    ids: Vec<String>,
) {
    if ids.is_empty() {
        extra.remove("defaultOptionIds");
    } else {
        extra.insert("defaultOptionIds".to_owned(), json!(ids));
    }
}

pub(super) fn normalize_option_inputs(
    inputs: &[DatabaseOptionInput],
) -> Result<Vec<DatabaseOptionInput>, String> {
    if inputs.len() > crate::database::validation::MAX_OPTIONS_PER_PROPERTY {
        return Err("Too many options".to_owned());
    }
    let mut names = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    let mut normalized = Vec::with_capacity(inputs.len());
    for input in inputs {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("Option name is required".to_owned());
        }
        if !names.insert(name.to_lowercase()) {
            return Err("An option with this name already exists".to_owned());
        }
        if !is_hex_color(&input.color) {
            return Err("Option color must be a #rrggbb value".to_owned());
        }
        if let Some(id) = input.id.as_deref() {
            if !ids.insert(id.to_owned()) {
                return Err("Option ID is repeated".to_owned());
            }
        }
        normalized.push(DatabaseOptionInput {
            id: input.id.clone(),
            name: name.to_owned(),
            color: input.color.to_ascii_lowercase(),
            group: input.group.clone(),
            is_default: input.is_default,
        });
    }
    Ok(normalized)
}

/// Replaces the option list of a Select, Multi-select or Status property.
///
/// Values already stored in records are never rewritten: a removed option stays
/// referenced by its ID and is shown as a missing option (a diagnostic value),
/// so deleting an option can never lose data.
pub fn update_database_property_options(
    vault: &Path,
    watcher: &WatcherState,
    request: &UpdateDatabasePropertyOptionsRequest,
) -> Result<UpdatedDatabasePropertyOptions, String> {
    let inputs = normalize_option_inputs(&request.options)?;
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
    let property = manifest
        .properties
        .iter_mut()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property not found".to_owned())?;
    let mut results = Vec::with_capacity(inputs.len());
    let mut default_ids: Vec<String> = Vec::new();
    let multiple = matches!(property, PropertyDefinition::MultiSelect(_));
    match property {
        PropertyDefinition::Select(fields) | PropertyDefinition::MultiSelect(fields) => {
            let previous = std::mem::take(&mut fields.config.options);
            let mut next = Vec::with_capacity(inputs.len());
            for input in &inputs {
                let existing = match input.id.as_deref() {
                    Some(id) => Some(
                        previous
                            .iter()
                            .find(|option| option.id == id)
                            .ok_or_else(|| "Unknown option".to_owned())?,
                    ),
                    None => None,
                };
                let mut option =
                    existing
                        .cloned()
                        .unwrap_or_else(|| crate::database::format::SelectOption {
                            id: ulid::Ulid::generate().to_string(),
                            name: String::new(),
                            color: String::new(),
                            aliases: Vec::new(),
                            extra: Default::default(),
                        });
                keep_old_name_as_alias(&mut option.aliases, &option.name, &input.name);
                option.name = input.name.clone();
                option.color = input.color.clone();
                if input.is_default {
                    default_ids.push(option.id.clone());
                }
                results.push(DatabaseOptionResult {
                    id: option.id.clone(),
                    name: option.name.clone(),
                    color: option.color.clone(),
                    group: None,
                });
                next.push(option);
            }
            drop_aliases_taken_by_names(&mut next, |option| (&option.name, &mut option.aliases));
            fields.config.options = next;
            if default_ids.len() > 1 && !multiple {
                return Err("Only one option can be the default".to_owned());
            }
            store_default_options(&mut fields.config.extra, default_ids);
        }
        PropertyDefinition::Status(fields) => {
            let previous = std::mem::take(&mut fields.config.options);
            let mut next = Vec::with_capacity(inputs.len());
            for input in &inputs {
                let existing = match input.id.as_deref() {
                    Some(id) => Some(
                        previous
                            .iter()
                            .find(|option| option.id == id)
                            .ok_or_else(|| "Unknown option".to_owned())?,
                    ),
                    None => None,
                };
                let group = input
                    .group
                    .clone()
                    .or_else(|| existing.map(|option| option.group.clone()))
                    .unwrap_or_else(|| "notStarted".to_owned());
                if !matches!(group.as_str(), "notStarted" | "inProgress" | "done") {
                    return Err("Unknown status group".to_owned());
                }
                let mut option =
                    existing
                        .cloned()
                        .unwrap_or_else(|| crate::database::format::StatusOption {
                            id: ulid::Ulid::generate().to_string(),
                            name: String::new(),
                            color: String::new(),
                            group: group.clone(),
                            aliases: Vec::new(),
                            extra: Default::default(),
                        });
                keep_old_name_as_alias(&mut option.aliases, &option.name, &input.name);
                option.name = input.name.clone();
                option.color = input.color.clone();
                option.group = group;
                if input.is_default {
                    default_ids.push(option.id.clone());
                }
                results.push(DatabaseOptionResult {
                    id: option.id.clone(),
                    name: option.name.clone(),
                    color: option.color.clone(),
                    group: Some(option.group.clone()),
                });
                next.push(option);
            }
            drop_aliases_taken_by_names(&mut next, |option| (&option.name, &mut option.aliases));
            fields.config.options = next;
            if default_ids.len() > 1 {
                return Err("Only one option can be the default".to_owned());
            }
            store_default_options(&mut fields.config.extra, default_ids);
        }
        _ => return Err("This property has no options".to_owned()),
    }

    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Option update would make the database manifest invalid".to_owned());
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

    Ok(UpdatedDatabasePropertyOptions {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        manifest_revision: prepared.revision,
        options: results,
        warnings: Vec::new(),
    })
}
