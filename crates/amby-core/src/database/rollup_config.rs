//! Creating and changing a Rollup property: a relation, a field of the related
//! database, and an aggregation that suits that field's kind.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::format::{
    parse_manifest, prepare_json, raw_revision, DatabaseManifest, PropertyDefinition,
};
use super::mutations::find_database_container;
use super::validation::validate_manifest;
use crate::frontmatter;
use crate::watcher::{self, WatcherState};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureDatabaseRollupRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
    pub relation_property_id: String,
    pub target_property_id: String,
    pub aggregation: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredDatabaseRollup {
    pub database_id: String,
    pub property_id: String,
    pub aggregation: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

/// The validated `config` of a rollup. `own_property_id` is the rollup being
/// edited, which cannot aggregate itself.
pub(super) fn rollup_config_json(
    vault: &Path,
    manifest: &DatabaseManifest,
    own_property_id: Option<&str>,
    relation_property_id: &str,
    target_property_id: &str,
    aggregation: &str,
) -> Result<serde_json::Value, String> {
    let relation = manifest
        .properties
        .iter()
        .find_map(|property| match property {
            PropertyDefinition::Relation(fields) if fields.id == relation_property_id => {
                Some(fields)
            }
            _ => None,
        })
        .ok_or_else(|| "The relation property was not found in this database".to_owned())?;
    let target_database_id = &relation.config.target_database_id;
    let target_kind = if *target_database_id == manifest.database_id {
        target_kind(manifest, target_property_id)
    } else {
        let container = find_database_container(vault, target_database_id)?;
        let path = super::discovery::manifest_path_for_container(&container);
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        let target = parse_manifest(&bytes).map_err(|error| error.to_string())?;
        target_kind(&target.value, target_property_id)
    }
    .ok_or_else(|| "The target property was not found in the related database".to_owned())?;
    if own_property_id == Some(target_property_id) && *target_database_id == manifest.database_id {
        return Err("A rollup cannot aggregate itself".to_owned());
    }
    let canonical = super::rollup::canonical(aggregation)
        .ok_or_else(|| format!("Unknown rollup aggregation: {aggregation}"))?;
    if !super::rollup::allowed(&target_kind, canonical) {
        return Err(format!(
            "Aggregation {canonical} does not apply to a {target_kind} property"
        ));
    }
    Ok(serde_json::json!({
        "relationPropertyId": relation_property_id,
        "targetPropertyId": target_property_id,
        "aggregation": canonical,
    }))
}

fn target_kind(manifest: &DatabaseManifest, property_id: &str) -> Option<String> {
    manifest
        .properties
        .iter()
        .find(|property| property.id() == Some(property_id))
        .map(|property| property.kind().to_owned())
}

pub fn configure_database_rollup(
    vault: &Path,
    watcher: &WatcherState,
    request: &ConfigureDatabaseRollupRequest,
) -> Result<ConfiguredDatabaseRollup, String> {
    let container = find_database_container(vault, &request.database_id)?;
    let manifest_path = super::discovery::manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| error.to_string())?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if parsed.revision != request.expected_manifest_revision {
        return Err("Manifest revision conflict".to_owned());
    }
    if parsed.value.locked {
        return Err("Database is locked".to_owned());
    }
    let config = rollup_config_json(
        vault,
        &parsed.value,
        Some(&request.property_id),
        &request.relation_property_id,
        &request.target_property_id,
        &request.aggregation,
    )?;
    let mut manifest = parsed.value.clone();
    let slot = manifest
        .properties
        .iter_mut()
        .find(|property| property.id() == Some(request.property_id.as_str()))
        .ok_or_else(|| "Property was not found".to_owned())?;
    let PropertyDefinition::Rollup(fields) = slot else {
        return Err("The property is not a rollup".to_owned());
    };
    fields.config.relation_property_id = request.relation_property_id.clone();
    fields.config.target_property_id = request.target_property_id.clone();
    fields.config.aggregation = config["aggregation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if !validate_manifest(&manifest).errors.is_empty() {
        return Err("The rollup would make the manifest invalid".to_owned());
    }
    let prepared = prepare_json(&parsed, &manifest).map_err(|error| error.to_string())?;
    if raw_revision(&fs::read(&manifest_path).map_err(|error| error.to_string())?)
        != request.expected_manifest_revision
    {
        return Err("Manifest revision conflict".to_owned());
    }
    crate::history::snapshot_before_write(
        vault,
        &manifest_path,
        &prepared.bytes,
        "database-metadata",
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
    Ok(ConfiguredDatabaseRollup {
        database_id: request.database_id.clone(),
        property_id: request.property_id.clone(),
        aggregation: fields_aggregation(&manifest, &request.property_id),
        manifest_revision: prepared.revision,
        warnings: Vec::new(),
    })
}

fn fields_aggregation(manifest: &DatabaseManifest, property_id: &str) -> String {
    manifest
        .properties
        .iter()
        .find_map(|property| match property {
            PropertyDefinition::Rollup(fields) if fields.id == property_id => {
                Some(fields.config.aggregation.clone())
            }
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "rollup_config_test.rs"]
mod tests;
