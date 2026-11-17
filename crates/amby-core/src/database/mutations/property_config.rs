use std::fs;
use std::path::Path;

use serde_json::json;

use crate::database::format::{parse_manifest, prepare_json, raw_revision, PropertyDefinition};
use crate::database::validation::validate_manifest;
use crate::frontmatter::{self};
use crate::watcher::{self, WatcherState};

use super::*;

pub(super) const DATE_FORMATS: [&str; 5] = [
    "full",
    "monthDayYear",
    "dayMonthYear",
    "yearMonthDay",
    "relative",
];

/// Sets or clears (`full` / `24h` are the defaults) a display-only config key.
pub(super) fn set_display_key(
    extra: &mut std::collections::BTreeMap<String, serde_json::Value>,
    key: &str,
    value: &str,
    default: &str,
) {
    if value == default {
        extra.remove(key);
    } else {
        extra.insert(key.to_owned(), json!(value));
    }
}

pub(super) fn reject_inapplicable(
    request: &UpdateDatabasePropertyConfigRequest,
    kind: &str,
) -> Result<(), String> {
    let applies = match kind {
        "text" => request.multiline.is_some(),
        "number" => request.number_format.is_some() || request.currency.is_some(),
        "date" => {
            request.include_time.is_some()
                || request.allow_range.is_some()
                || request.date_format.is_some()
                || request.time_format.is_some()
        }
        "formula" => request.formula_expression.is_some(),
        _ => false,
    };
    // A request that sets nothing for this type, or sets other types' fields, is a mistake.
    let others = (kind != "text" && request.multiline.is_some())
        || (kind != "number" && (request.number_format.is_some() || request.currency.is_some()))
        || (kind != "date"
            && (request.include_time.is_some()
                || request.allow_range.is_some()
                || request.date_format.is_some()
                || request.time_format.is_some()))
        || (kind != "formula" && request.formula_expression.is_some());
    if others || !applies {
        return Err("These settings do not apply to this property".to_owned());
    }
    Ok(())
}

/// Changes the settings of a Text, Number, Date or Formula property.
///
/// Settings that change what a stored value must look like (a date's time and range)
/// are refused while the property has values, so no record can become invalid; the
/// rest only change how values are shown or computed, and never touch records.
pub fn update_database_property_config(
    vault: &Path,
    watcher: &WatcherState,
    request: &UpdateDatabasePropertyConfigRequest,
) -> Result<UpdatedDatabasePropertyConfig, String> {
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
    let current = parsed
        .value
        .properties
        .iter()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property not found".to_owned())?;
    reject_inapplicable(request, current.kind())?;

    let mut manifest = parsed.value.clone();
    let property = manifest
        .properties
        .iter_mut()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property not found".to_owned())?;
    let mut needs_value_check = false;
    match property {
        PropertyDefinition::Text(fields) => {
            if let Some(multiline) = request.multiline {
                fields.config.multiline = multiline;
            }
        }
        PropertyDefinition::Number(fields) => {
            let format = request
                .number_format
                .clone()
                .unwrap_or_else(|| fields.config.format.clone());
            if !matches!(format.as_str(), "number" | "percent" | "currency") {
                return Err("Unknown number format".to_owned());
            }
            let currency = match (&request.currency, format.as_str()) {
                (_, "number" | "percent") => None,
                (Some(code), _) => {
                    let code = code.trim().to_ascii_uppercase();
                    if code.len() != 3 || !code.bytes().all(|byte| byte.is_ascii_uppercase()) {
                        return Err("Currency must be a three-letter code".to_owned());
                    }
                    Some(code)
                }
                (None, _) => fields.config.currency.clone(),
            };
            if format == "currency" && currency.is_none() {
                return Err("Currency format requires a currency code".to_owned());
            }
            fields.config.format = format;
            fields.config.currency = currency;
        }
        PropertyDefinition::Date(fields) => {
            if let Some(include_time) = request.include_time {
                needs_value_check |= include_time != fields.config.include_time;
                fields.config.include_time = include_time;
            }
            if let Some(allow_range) = request.allow_range {
                // Allowing ranges only widens what is valid; forbidding them can break values.
                needs_value_check |= !allow_range && fields.config.allow_range;
                fields.config.allow_range = allow_range;
            }
            if let Some(format) = request.date_format.as_deref() {
                if !DATE_FORMATS.contains(&format) {
                    return Err("Unknown date format".to_owned());
                }
                set_display_key(&mut fields.config.extra, "dateFormat", format, "full");
            }
            if let Some(format) = request.time_format.as_deref() {
                if !matches!(format, "12h" | "24h") {
                    return Err("Unknown time format".to_owned());
                }
                set_display_key(&mut fields.config.extra, "timeFormat", format, "24h");
            }
        }
        PropertyDefinition::Formula(fields) => {
            if let Some(expression) = request.formula_expression.as_deref() {
                let expression = expression.trim();
                if expression.is_empty() {
                    return Err("Formula expression is required".to_owned());
                }
                crate::database::formula::extract_dependencies(expression)
                    .map_err(|error| format!("Invalid formula: {error}"))?;
                fields.config.expression = expression.to_owned();
            }
        }
        _ => return Err("These settings do not apply to this property".to_owned()),
    }
    if needs_value_check {
        let target = parsed
            .value
            .properties
            .iter()
            .find(|property| property.id() == Some(request.property_id.as_str()))
            .ok_or_else(|| "Property not found".to_owned())?;
        ensure_property_has_no_durable_values(vault, &request.database_id, &container, target)
            .map_err(|error| {
                if error.contains("existing values are cleared") {
                    "Date time and range settings can only change after the existing values are cleared"
                        .to_owned()
                } else {
                    error
                }
            })?;
    }

    let report = validate_manifest(&manifest);
    if !report.errors.is_empty() {
        return Err("Property settings would make the database manifest invalid".to_owned());
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

    Ok(UpdatedDatabasePropertyConfig {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}
