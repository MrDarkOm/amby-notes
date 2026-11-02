use std::fs;
use std::path::Path;

use crate::database::format::{parse_template, PropertyDefinition};
use crate::frontmatter::{self};

use super::*;

pub(super) fn ensure_property_has_no_durable_values(
    vault: &Path,
    database_id: &str,
    container: &Path,
    property: &PropertyDefinition,
) -> Result<(), String> {
    let canonical_vault = vault.canonicalize().map_err(|error| error.to_string())?;
    let vault = canonical_vault.as_path();
    let property_id = property.id().unwrap_or_default();
    let prop_name = property.name();
    let prop_key = property.frontmatter_key();

    let discovery = crate::database::discovery::discover_vault(vault)?;
    let container_relative = container
        .strip_prefix(vault)
        .map_err(|_| "Database container is outside the vault".to_owned())?
        .to_string_lossy()
        .replace('\\', "/");
    let nested_containers = discovery
        .databases
        .iter()
        .filter(|database| {
            database.database_id != database_id && database.container_path.starts_with(container)
        })
        .map(|database| database.container_path.clone())
        .collect::<Vec<_>>();
    for diagnostic in &discovery.diagnostics {
        if !matches!(
            diagnostic.severity,
            crate::database::discovery::DiagnosticSeverity::Error
        ) {
            continue;
        }
        let in_container = container_relative.is_empty()
            || diagnostic.path == container_relative
            || diagnostic
                .path
                .strip_prefix(&container_relative)
                .is_some_and(|suffix| suffix.starts_with('/'));
        let diagnostic_path = vault.join(&diagnostic.path);
        let in_nested = nested_containers.iter().any(|nested| {
            diagnostic_path.starts_with(nested)
                && discovery
                    .databases
                    .iter()
                    .find(|database| database.container_path == *nested)
                    .and_then(|database| database.attached_note_path.as_ref())
                    != Some(&diagnostic_path)
        });
        if in_container && !in_nested {
            return Err(format!(
                "Cannot safely inspect database-owned values at {}: {}",
                diagnostic.path, diagnostic.message
            ));
        }
    }
    for note in discovery
        .notes
        .iter()
        .filter(|note| note.owner_database_id.as_deref() == Some(database_id))
    {
        let content = fs::read_to_string(&note.path).map_err(|error| error.to_string())?;
        let mapping = frontmatter::frontmatter_yaml_mapping(&content)
            .map_err(|error| format!("Invalid YAML in {}: {error}", note.relative_path))?;
        let Some(mapping) = mapping else {
            continue;
        };
        let has_prop = if property.kind() == "relation" {
            relation_targets_from_mapping(&mapping, property)?
        } else {
            mapping.iter().any(|(k, _)| {
                if let serde_yaml::Value::String(k_str) = k {
                    let k_trim = k_str.trim();
                    k_trim.eq_ignore_ascii_case(property_id)
                        || prop_name.is_some_and(|pn| k_trim.eq_ignore_ascii_case(pn))
                        || prop_key.is_some_and(|pk| k_trim.eq_ignore_ascii_case(pk))
                } else {
                    false
                }
            })
        };
        if has_prop {
            return Err(
                "Property type can only be changed after its existing values are cleared"
                    .to_owned(),
            );
        }
    }

    // The legacy record/template stores are scoped to this database
    // container. Read/parse failures are fatal so a conversion cannot
    // silently proceed around an unreadable durable value.
    let records_dir = container.join(".ambd/records");
    let records_present = match fs::symlink_metadata(&records_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Database record store is a symbolic link".to_owned());
        }
        Ok(metadata) if metadata.is_dir() => true,
        Ok(_) => return Err("Database record store is not a directory".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    if records_present {
        for entry in fs::read_dir(&records_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let parsed = crate::database::format::parse_record(
                &fs::read(entry.path()).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            if !parsed.is_writable() {
                return Err("A record is read-only; property type was not changed".to_owned());
            }
            let has_value = parsed.value.values.get(property_id).is_some_and(|value| {
                !matches!(
                    value,
                    crate::database::format::PropertyValue::Relation { target_note_ids, .. }
                        if target_note_ids.is_empty()
                )
            });
            if has_value || parsed.value.yaml_sync_bases.contains_key(property_id) {
                return Err(
                    "Property type can only be changed after its existing values are cleared"
                        .to_owned(),
                );
            }
        }
    }

    let templates_dir = container.join(".ambd/templates");
    let templates_present = match fs::symlink_metadata(&templates_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("Database template store is a symbolic link".to_owned());
        }
        Ok(metadata) if metadata.is_dir() => true,
        Ok(_) => return Err("Database template store is not a directory".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    if templates_present {
        for entry in fs::read_dir(&templates_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let parsed =
                parse_template(&fs::read(entry.path()).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            if !parsed.is_writable() {
                return Err("A template is read-only; property type was not changed".to_owned());
            }
            let has_value = parsed.value.values.get(property_id).is_some_and(|value| {
                !matches!(
                    value,
                    crate::database::format::PropertyValue::Relation { target_note_ids, .. }
                        if target_note_ids.is_empty()
                )
            });
            if has_value {
                return Err(
                    "Property type can only be changed after its template values are cleared"
                        .to_owned(),
                );
            }
        }
    }
    Ok(())
}
