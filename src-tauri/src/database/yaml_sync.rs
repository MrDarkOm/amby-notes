//! Pure three-way decisions for the optional YAML binding layer.
//!
//! Filesystem splicing and durable writes belong to the command boundary. This
//! module only decides whether a field can be imported/exported or must remain
//! blocked as a conflict, so a last-writer-wins shortcut cannot be introduced
//! by a UI caller.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::format::{
    parse_manifest, parse_record, prepare_json, raw_revision, PropertyDefinition, PropertyValue,
    RecordShard, YamlSyncBase,
};
use super::validation::{canonical_decimal, validate_record};
use crate::frontmatter::{self, AtomicCreateError};
use crate::watcher::{self, WatcherState};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseYamlSyncRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub note_id: String,
    pub expected_record_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseYamlConflict {
    pub database_id: String,
    pub note_id: String,
    pub property_id: String,
    pub yaml_key: String,
    pub base_json: String,
    pub shard_json: String,
    pub yaml_json: String,
    pub note_revision: String,
    pub record_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseYamlSyncResult {
    pub database_id: String,
    pub note_id: String,
    pub note_revision: String,
    pub record_revision: String,
    pub changed: bool,
    pub conflicts: Vec<DatabaseYamlConflict>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseYamlResolveRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub note_id: String,
    pub property_id: String,
    pub expected_note_revision: String,
    pub expected_record_revision: String,
    pub resolution: DatabaseYamlResolution,
    pub manual_value_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseYamlResolution {
    Shard,
    Yaml,
    Manual,
}

#[derive(Clone, Debug, PartialEq)]
pub enum YamlSyncResolution {
    Unchanged,
    ImportYaml(Value),
    ExportShard(Value),
    Conflict { shard: Value, yaml: Value },
}

pub fn resolve_three_way(base: &Value, shard: &Value, yaml: &Value) -> YamlSyncResolution {
    if shard == yaml {
        YamlSyncResolution::Unchanged
    } else if shard == base {
        YamlSyncResolution::ImportYaml(yaml.clone())
    } else if yaml == base {
        YamlSyncResolution::ExportShard(shard.clone())
    } else {
        YamlSyncResolution::Conflict {
            shard: shard.clone(),
            yaml: yaml.clone(),
        }
    }
}

pub fn is_yaml_sync_supported(property_type: &str) -> bool {
    matches!(
        property_type,
        "text" | "number" | "checkbox" | "date" | "select" | "multiSelect" | "url"
    )
}

/// Convert a durable value to the normalized JSON representation used by the
/// three-way planner and conflict table.
pub fn property_value_json(value: &PropertyValue) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

pub fn base_json(base: Option<&YamlSyncBase>) -> Result<Value, String> {
    match base {
        Some(YamlSyncBase::Value { value, .. }) => property_value_json(value),
        Some(YamlSyncBase::Missing { .. }) | None => Ok(Value::Null),
        Some(YamlSyncBase::Opaque(value)) => Ok(value.clone()),
    }
}

/// Read one YAML scalar/sequence using the property's declared type. IDs are
/// deliberately kept as IDs; option names can change without changing the
/// durable database value.
pub fn property_value_from_yaml(
    property: &PropertyDefinition,
    yaml: &serde_yaml::Value,
) -> Result<PropertyValue, String> {
    let string_value = || {
        yaml.as_str()
            .map(str::to_owned)
            .ok_or_else(|| "YAML binding must contain a string".to_owned())
    };
    match property.kind() {
        "text" => Ok(PropertyValue::Text {
            value: string_value()?,
            extra: Default::default(),
        }),
        "url" => Ok(PropertyValue::Url {
            value: string_value()?,
            extra: Default::default(),
        }),
        "number" => {
            let raw = yaml
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    serde_yaml::to_string(yaml)
                        .ok()
                        .map(|value| value.trim().to_owned())
                })
                .ok_or_else(|| "YAML number is invalid".to_owned())?;
            let decimal = canonical_decimal(&raw)
                .map_err(|error| format!("YAML number is invalid: {error:?}"))?;
            Ok(PropertyValue::Number {
                decimal,
                extra: Default::default(),
            })
        }
        "checkbox" => Ok(PropertyValue::Checkbox {
            checked: yaml
                .as_bool()
                .ok_or_else(|| "YAML checkbox must be boolean".to_owned())?,
            extra: Default::default(),
        }),
        "date" => Ok(PropertyValue::Date {
            start: string_value()?,
            end: None,
            time_zone: None,
            extra: Default::default(),
        }),
        "select" => Ok(PropertyValue::Select {
            option_id: string_value()?,
            extra: Default::default(),
        }),
        "multiSelect" => Ok(PropertyValue::MultiSelect {
            option_ids: yaml
                .as_sequence()
                .ok_or_else(|| "YAML multi-select must be a sequence".to_owned())?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "YAML multi-select items must be strings".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?,
            extra: Default::default(),
        }),
        kind => Err(format!("YAML binding is not supported for {kind}")),
    }
}

/// Convert a property value to a YAML value without exposing internal record
/// envelopes. Date ranges and timezone metadata stay Amby-only until a
/// lossless YAML representation is defined.
pub fn property_value_to_yaml(
    property: &PropertyDefinition,
    value: &PropertyValue,
) -> Result<serde_yaml::Value, String> {
    match (property.kind(), value) {
        ("text", PropertyValue::Text { value, .. })
        | ("url", PropertyValue::Url { value, .. })
        | (
            "select",
            PropertyValue::Select {
                option_id: value, ..
            },
        ) => Ok(serde_yaml::Value::String(value.clone())),
        ("number", PropertyValue::Number { decimal, .. }) => {
            Ok(serde_yaml::Value::String(decimal.clone()))
        }
        ("checkbox", PropertyValue::Checkbox { checked, .. }) => {
            Ok(serde_yaml::Value::Bool(*checked))
        }
        (
            "date",
            PropertyValue::Date {
                start,
                end,
                time_zone,
                ..
            },
        ) if end.is_none() && time_zone.is_none() => Ok(serde_yaml::Value::String(start.clone())),
        ("multiSelect", PropertyValue::MultiSelect { option_ids, .. }) => {
            Ok(serde_yaml::Value::Sequence(
                option_ids
                    .iter()
                    .cloned()
                    .map(serde_yaml::Value::String)
                    .collect(),
            ))
        }
        (kind, _) => Err(format!("value does not match YAML binding type {kind}")),
    }
}

/// Reconcile one Markdown note and its record shard. Resolvable fields are
/// applied independently; a conflicting field is returned to the inspector
/// and remains untouched. Both source files are checked again immediately
/// before publishing, and a failed second write rolls the first one back.
pub fn sync_note(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseYamlSyncRequest,
) -> Result<DatabaseYamlSyncResult, String> {
    sync_note_with_resolution(vault, watcher, request, None, None)
}

pub fn resolve_yaml_conflict(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseYamlResolveRequest,
) -> Result<DatabaseYamlSyncResult, String> {
    let sync_request = DatabaseYamlSyncRequest {
        expected_generation: request.expected_generation,
        database_id: request.database_id.clone(),
        note_id: request.note_id.clone(),
        expected_record_revision: request.expected_record_revision.clone(),
    };
    let forced = ForcedResolution {
        property_id: &request.property_id,
        resolution: &request.resolution,
        manual_value_json: request.manual_value_json.as_deref(),
    };
    sync_note_with_resolution(
        vault,
        watcher,
        &sync_request,
        Some(forced),
        Some(&request.expected_note_revision),
    )
}

struct ForcedResolution<'a> {
    property_id: &'a str,
    resolution: &'a DatabaseYamlResolution,
    manual_value_json: Option<&'a str>,
}

fn sync_note_with_resolution(
    vault: &Path,
    watcher: &WatcherState,
    request: &DatabaseYamlSyncRequest,
    forced_resolution: Option<ForcedResolution<'_>>,
    expected_note_revision: Option<&str>,
) -> Result<DatabaseYamlSyncResult, String> {
    if ulid::Ulid::from_string(&request.database_id).is_err()
        || ulid::Ulid::from_string(&request.note_id).is_err()
    {
        return Err("databaseId and noteId must be canonical ULIDs".to_owned());
    }
    let discovery = super::discovery::discover_vault(vault)?;
    let database = discovery
        .databases
        .iter()
        .find(|database| database.database_id == request.database_id)
        .ok_or_else(|| "Database was not found".to_owned())?;
    if database.read_only {
        return Err("Database is read-only".to_owned());
    }
    let manifest_bytes = fs::read(&database.manifest_path).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_bytes).map_err(|error| error.to_string())?;
    if manifest.value.locked {
        return Err("Database is locked".to_owned());
    }
    if !super::validation::validate_manifest(&manifest.value)
        .errors
        .is_empty()
    {
        return Err("Database manifest is invalid".to_owned());
    }
    let note = discovery
        .notes
        .iter()
        .find(|note| {
            note.note_id.as_deref() == Some(request.note_id.as_str())
                && note.owner_database_id.as_deref() == Some(request.database_id.as_str())
        })
        .ok_or_else(|| "Database row was not found".to_owned())?;
    let note_path = &note.path;
    let original_note_bytes = fs::read(note_path).map_err(|error| error.to_string())?;
    let source = String::from_utf8(original_note_bytes.clone())
        .map_err(|_| "Note source is not valid UTF-8".to_owned())?;
    let initial_note_revision = crate::index::note_index::body_revision(&source);
    if let Some(expected_note_revision) = expected_note_revision {
        if expected_note_revision != initial_note_revision {
            return Err("Note revision changed during YAML sync".to_owned());
        }
    }
    let mapping = crate::frontmatter::frontmatter_yaml_mapping(&source)?
        .ok_or_else(|| "YAML sync requires a closed frontmatter envelope".to_owned())?;

    let record_path = database
        .container_path
        .join(".ambd/records")
        .join(format!("{}.json", request.note_id));
    let (original_record_bytes, parsed_record, record_was_new) = if record_path.exists() {
        let bytes = fs::read(&record_path).map_err(|error| error.to_string())?;
        let parsed = parse_record(&bytes).map_err(|error| error.to_string())?;
        if parsed.value.database_id != request.database_id
            || parsed.value.note_id != request.note_id
        {
            return Err("Record does not belong to the requested database row".to_owned());
        }
        (bytes, Some(parsed), false)
    } else {
        (
            Vec::new(),
            None::<super::format::ParsedJson<RecordShard>>,
            true,
        )
    };
    let expected_record_revision = parsed_record
        .as_ref()
        .map(|record| record.revision.as_str())
        .unwrap_or_default();
    if expected_record_revision != request.expected_record_revision {
        return Err("Record revision conflict".to_owned());
    }
    let mut record = parsed_record
        .as_ref()
        .map(|record| record.value.clone())
        .unwrap_or_else(|| RecordShard {
            format: "amby-database-record".to_owned(),
            format_version: 1,
            database_id: request.database_id.clone(),
            note_id: request.note_id.clone(),
            values: Default::default(),
            yaml_sync_bases: Default::default(),
            extra: Default::default(),
        });
    let mut next_note = source.clone();
    let mut record_changed = false;
    let mut conflicts = Vec::new();
    let mut seen_keys = HashSet::new();
    let mut forced_applied = false;

    for property in &manifest.value.properties {
        let Some(binding) = property.yaml_binding() else {
            continue;
        };
        if binding.direction != "twoWay" || !is_yaml_sync_supported(property.kind()) {
            continue;
        }
        if !seen_keys.insert(binding.key.clone()) {
            return Err(format!("YAML binding key is duplicated: {}", binding.key));
        }
        let property_id = property.id().unwrap_or_default();
        let mut shard = record.values.get(property_id).cloned();
        let mut shard_json = shard
            .as_ref()
            .map(property_value_json)
            .transpose()?
            .unwrap_or(Value::Null);
        let base = base_json(record.yaml_sync_bases.get(property_id))?;
        let yaml_json = match mapping.get(serde_yaml::Value::String(binding.key.clone())) {
            Some(value) => match property_value_from_yaml(property, value) {
                Ok(value) => property_value_json(&value)?,
                Err(error) => serde_json::json!({ "error": error }),
            },
            None => Value::Null,
        };
        let mut effective_shard_json = shard_json.clone();
        let mut effective_yaml_json = yaml_json.clone();
        if let Some(forced) = forced_resolution
            .as_ref()
            .filter(|forced| forced.property_id == property_id)
        {
            forced_applied = true;
            match forced.resolution {
                DatabaseYamlResolution::Shard => effective_yaml_json = base.clone(),
                DatabaseYamlResolution::Yaml => effective_shard_json = base.clone(),
                DatabaseYamlResolution::Manual => {
                    let manual_value = forced
                        .manual_value_json
                        .ok_or_else(|| {
                            "Manual YAML resolution requires a property value".to_owned()
                        })
                        .and_then(|value| {
                            serde_json::from_str::<PropertyValue>(value).map_err(|error| {
                                format!("Manual property value is invalid: {error}")
                            })
                        })?;
                    if manual_value.kind() != property.kind() {
                        return Err(format!(
                            "Manual property value type does not match {}",
                            property.kind()
                        ));
                    }
                    property_value_to_yaml(property, &manual_value)?;
                    record
                        .values
                        .insert(property_id.to_owned(), manual_value.clone());
                    record_changed = true;
                    shard = Some(manual_value);
                    shard_json = property_value_json(shard.as_ref().expect("manual value"))?;
                    effective_shard_json = shard_json.clone();
                    effective_yaml_json = base.clone();
                }
            }
        }
        match resolve_three_way(&base, &effective_shard_json, &effective_yaml_json) {
            YamlSyncResolution::Unchanged => {
                let next_base = shard
                    .as_ref()
                    .map(|value| YamlSyncBase::Value {
                        value: value.clone(),
                        extra: Default::default(),
                    })
                    .unwrap_or(YamlSyncBase::Missing {
                        extra: Default::default(),
                    });
                if record.yaml_sync_bases.get(property_id) != Some(&next_base) {
                    record
                        .yaml_sync_bases
                        .insert(property_id.to_owned(), next_base);
                    record_changed = true;
                }
            }
            YamlSyncResolution::ImportYaml(value) => {
                let imported: PropertyValue = serde_json::from_value(value)
                    .map_err(|error| format!("YAML value could not be imported: {error}"))?;
                record
                    .values
                    .insert(property_id.to_owned(), imported.clone());
                record.yaml_sync_bases.insert(
                    property_id.to_owned(),
                    YamlSyncBase::Value {
                        value: imported,
                        extra: Default::default(),
                    },
                );
                record_changed = true;
            }
            YamlSyncResolution::ExportShard { .. } => {
                let next_base = shard
                    .as_ref()
                    .map(|value| YamlSyncBase::Value {
                        value: value.clone(),
                        extra: Default::default(),
                    })
                    .unwrap_or(YamlSyncBase::Missing {
                        extra: Default::default(),
                    });
                let export_result = match shard.as_ref() {
                    Some(value) => property_value_to_yaml(property, value).and_then(|yaml| {
                        crate::frontmatter::replace_yaml_binding_lossless(
                            &next_note,
                            &binding.key,
                            &yaml,
                        )
                    }),
                    None => {
                        crate::frontmatter::remove_yaml_binding_lossless(&next_note, &binding.key)
                    }
                };
                match export_result {
                    Ok(updated) => {
                        next_note = updated;
                        record
                            .yaml_sync_bases
                            .insert(property_id.to_owned(), next_base);
                        record_changed = true;
                    }
                    Err(error) => conflicts.push(build_conflict(
                        &request.database_id,
                        &request.note_id,
                        ConflictInput {
                            property_id,
                            yaml_key: &binding.key,
                            base: &base,
                            shard: &effective_shard_json,
                            yaml: &serde_json::json!({ "error": error }),
                            note_revision: &initial_note_revision,
                            record_revision: expected_record_revision,
                        },
                    )),
                }
            }
            YamlSyncResolution::Conflict { .. } => conflicts.push(build_conflict(
                &request.database_id,
                &request.note_id,
                ConflictInput {
                    property_id,
                    yaml_key: &binding.key,
                    base: &base,
                    shard: &effective_shard_json,
                    yaml: &effective_yaml_json,
                    note_revision: &initial_note_revision,
                    record_revision: expected_record_revision,
                },
            )),
        }
    }

    if forced_resolution.is_some() && !forced_applied {
        return Err("YAML conflict property is not a supported two-way binding".to_owned());
    }

    if !validate_record(&record, Some(&manifest.value))
        .errors
        .is_empty()
    {
        return Err("YAML sync produced an invalid record".to_owned());
    }
    let note_changed = next_note.as_bytes() != original_note_bytes.as_slice();
    let record_bytes = if record_changed {
        if record_was_new {
            let mut bytes =
                serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
            bytes
        } else {
            prepare_json(parsed_record.as_ref().expect("existing record"), &record)
                .map_err(|error| error.to_string())?
                .bytes
        }
    } else {
        original_record_bytes.clone()
    };
    let changed = note_changed || record_changed;
    if !changed {
        return Ok(DatabaseYamlSyncResult {
            database_id: request.database_id.clone(),
            note_id: request.note_id.clone(),
            note_revision: initial_note_revision,
            record_revision: expected_record_revision.to_owned(),
            changed: false,
            conflicts,
            warnings: Vec::new(),
        });
    }

    if fs::read(note_path).map_err(|error| error.to_string())? != original_note_bytes {
        return Err("Note changed during YAML sync".to_owned());
    }
    if record_was_new {
        if record_path.exists() {
            return Err("Record appeared during YAML sync".to_owned());
        }
    } else if fs::read(&record_path).map_err(|error| error.to_string())? != original_record_bytes {
        return Err("Record changed during YAML sync".to_owned());
    }
    if record_changed {
        crate::history::snapshot_before_write(
            vault,
            &record_path,
            &record_bytes,
            "database-yaml-sync",
        )?;
    }
    if note_changed {
        crate::history::snapshot_before_write(
            vault,
            note_path,
            next_note.as_bytes(),
            "database-yaml-sync",
        )?;
    }
    let prepared = watcher.prepare_write(
        [
            record_changed.then_some((&record_path, watcher::fingerprint_for_bytes(&record_bytes))),
            note_changed.then_some((
                note_path,
                watcher::fingerprint_for_bytes(next_note.as_bytes()),
            )),
        ]
        .into_iter()
        .flatten(),
    );
    let mut wrote_record = false;
    let write_result = (|| {
        if record_changed {
            if record_was_new {
                frontmatter::atomic_write_bytes_new(&record_path, &record_bytes).map_err(
                    |error| match error {
                        AtomicCreateError::AlreadyExists => {
                            "Record appeared during YAML sync".to_owned()
                        }
                        AtomicCreateError::Other(error) => error,
                    },
                )?;
            } else {
                frontmatter::atomic_write_bytes(&record_path, &record_bytes)?;
            }
            wrote_record = true;
        }
        if note_changed {
            frontmatter::atomic_write_bytes(note_path, next_note.as_bytes())?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = write_result {
        if wrote_record {
            if record_was_new {
                let _ = fs::remove_file(&record_path);
            } else {
                let _ = frontmatter::atomic_write_bytes(&record_path, &original_record_bytes);
            }
        }
        watcher.cancel_prepared_write(&prepared);
        return Err(error);
    }
    watcher.confirm_prepared_write(&prepared);
    Ok(DatabaseYamlSyncResult {
        database_id: request.database_id.clone(),
        note_id: request.note_id.clone(),
        note_revision: crate::index::note_index::body_revision(&next_note),
        record_revision: raw_revision(&record_bytes),
        changed: true,
        conflicts,
        warnings: Vec::new(),
    })
}

struct ConflictInput<'a> {
    property_id: &'a str,
    yaml_key: &'a str,
    base: &'a Value,
    shard: &'a Value,
    yaml: &'a Value,
    note_revision: &'a str,
    record_revision: &'a str,
}

fn build_conflict(
    database_id: &str,
    note_id: &str,
    input: ConflictInput<'_>,
) -> DatabaseYamlConflict {
    DatabaseYamlConflict {
        database_id: database_id.to_owned(),
        note_id: note_id.to_owned(),
        property_id: input.property_id.to_owned(),
        yaml_key: input.yaml_key.to_owned(),
        base_json: input.base.to_string(),
        shard_json: input.shard.to_string(),
        yaml_json: input.yaml.to_string(),
        note_revision: input.note_revision.to_owned(),
        record_revision: input.record_revision.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("amby-yaml-sync-{name}-{stamp}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn sync_fixture(
        shard_value: &str,
        base_value: &str,
        yaml_value: &str,
    ) -> (std::path::PathBuf, String, String) {
        let vault = temp_vault("fixture");
        let database_id = "01J00000000000000000000000";
        let note_id = "01J00000000000000000000001";
        let property_id = "01J00000000000000000000004";
        let database = vault.join("Database");
        std::fs::create_dir_all(database.join(".ambd/records")).unwrap();
        std::fs::write(
            database.join("ambd.json"),
            serde_json::to_vec_pretty(&json!({
                "format":"amby-database", "formatVersion":1, "databaseId":database_id,
                "name":"Database", "locked":false,
                "membership":{"kind":"filesystem-descendants","recursive":true},
                "properties":[{"id":property_id,"name":"Count","type":"number",
                    "pageVisibility":"alwaysShow","yamlBinding":{"key":"count","direction":"twoWay"},
                    "config":{"format":"number","currency":null}}],
                "viewOrder":[], "defaultViewId":null, "templateOrder":[], "defaultTemplateId":null
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            database.join("Row.md"),
            format!("---\namby-id: {note_id}\ncount: {yaml_value}\n---\nRow\n"),
        )
        .unwrap();
        let record = json!({
            "format":"amby-database-record", "formatVersion":1,
            "databaseId":database_id, "noteId":note_id,
            "values":{property_id:{"type":"number","decimal":shard_value}},
            "yamlSyncBases":{property_id:{"state":"value","value":{"type":"number","decimal":base_value}}}
        });
        let record_path = database.join(format!(".ambd/records/{note_id}.json"));
        let record_bytes = serde_json::to_vec_pretty(&record).unwrap();
        std::fs::write(&record_path, &record_bytes).unwrap();
        (vault, database_id.to_owned(), raw_revision(&record_bytes))
    }

    #[test]
    fn three_way_matrix_never_overwrites_two_changed_sides() {
        let base = json!("base");
        assert_eq!(
            resolve_three_way(&base, &base, &json!("yaml")),
            YamlSyncResolution::ImportYaml(json!("yaml"))
        );
        assert_eq!(
            resolve_three_way(&base, &json!("shard"), &base),
            YamlSyncResolution::ExportShard(json!("shard"))
        );
        assert!(matches!(
            resolve_three_way(&base, &json!("shard"), &json!("yaml")),
            YamlSyncResolution::Conflict { .. }
        ));
    }

    #[test]
    fn unsupported_relation_and_files_stay_amby_only() {
        assert!(is_yaml_sync_supported("text"));
        assert!(is_yaml_sync_supported("multiSelect"));
        assert!(!is_yaml_sync_supported("relation"));
        assert!(!is_yaml_sync_supported("files"));
    }

    #[test]
    fn converts_supported_values_without_number_precision_loss() {
        let property = PropertyDefinition::Number(super::super::format::PropertyFields {
            id: "01J00000000000000000000001".to_owned(),
            name: "Score".to_owned(),
            page_visibility: "alwaysShow".to_owned(),
            yaml_binding: None,
            config: super::super::format::NumberConfig {
                format: "number".to_owned(),
                currency: None,
                extra: Default::default(),
            },
            extra: Default::default(),
        });
        let yaml = serde_yaml::Value::String("12345678901234567890.005".to_owned());
        let value = property_value_from_yaml(&property, &yaml).unwrap();
        assert_eq!(
            property_value_json(&value).unwrap()["decimal"],
            "12345678901234567890.005"
        );
    }

    #[test]
    fn rejects_lossy_date_ranges_and_unsupported_types() {
        let property = PropertyDefinition::Date(super::super::format::PropertyFields {
            id: "01J00000000000000000000001".to_owned(),
            name: "When".to_owned(),
            page_visibility: "alwaysShow".to_owned(),
            yaml_binding: None,
            config: super::super::format::DateConfig {
                include_time: true,
                allow_range: true,
                extra: Default::default(),
            },
            extra: Default::default(),
        });
        let value = PropertyValue::Date {
            start: "2026-09-04".to_owned(),
            end: Some("2026-09-05".to_owned()),
            time_zone: None,
            extra: Default::default(),
        };
        assert!(property_value_to_yaml(&property, &value).is_err());
    }

    #[test]
    fn imports_yaml_change_and_updates_record_base() {
        let (vault, database_id, revision) = sync_fixture("1", "1", "2");
        let note_id = "01J00000000000000000000001";
        let result = sync_note(
            &vault,
            &WatcherState::new(),
            &DatabaseYamlSyncRequest {
                expected_generation: 1,
                database_id,
                note_id: note_id.to_owned(),
                expected_record_revision: revision,
            },
        )
        .unwrap();
        assert!(result.changed);
        assert!(result.conflicts.is_empty());
        let record: Value = serde_json::from_slice(
            &std::fs::read(vault.join("Database/.ambd/records/01J00000000000000000000001.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            record["values"]["01J00000000000000000000004"]["decimal"],
            "2"
        );
        assert_eq!(
            record["yamlSyncBases"]["01J00000000000000000000004"]["value"]["decimal"],
            "2"
        );
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn exports_shard_change_losslessly_and_detects_dual_change() {
        let (vault, database_id, revision) = sync_fixture("2", "1", "1");
        let note_id = "01J00000000000000000000001";
        let result = sync_note(
            &vault,
            &WatcherState::new(),
            &DatabaseYamlSyncRequest {
                expected_generation: 1,
                database_id,
                note_id: note_id.to_owned(),
                expected_record_revision: revision,
            },
        )
        .unwrap();
        assert!(result.changed);
        assert!(result.conflicts.is_empty());
        let note = std::fs::read_to_string(vault.join("Database/Row.md")).unwrap();
        assert!(note.contains("count: '2'") || note.contains("count: \"2\""));
        std::fs::remove_dir_all(&vault).unwrap();

        let (vault, database_id, revision) = sync_fixture("2", "1", "3");
        let result = sync_note(
            &vault,
            &WatcherState::new(),
            &DatabaseYamlSyncRequest {
                expected_generation: 1,
                database_id,
                note_id: note_id.to_owned(),
                expected_record_revision: revision,
            },
        )
        .unwrap();
        assert!(!result.changed);
        assert_eq!(result.conflicts.len(), 1);
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn resolves_yaml_conflicts_with_shard_yaml_or_manual_value() {
        let note_id = "01J00000000000000000000001";
        let property_id = "01J00000000000000000000004";
        let resolve = |resolution, manual_value_json| {
            let (vault, database_id, revision) = sync_fixture("2", "1", "3");
            let note_path = vault.join("Database/Row.md");
            let note = std::fs::read_to_string(&note_path).unwrap();
            let note_revision = crate::index::note_index::body_revision(&note);
            let result = resolve_yaml_conflict(
                &vault,
                &WatcherState::new(),
                &DatabaseYamlResolveRequest {
                    expected_generation: 1,
                    database_id,
                    note_id: note_id.to_owned(),
                    property_id: property_id.to_owned(),
                    expected_note_revision: note_revision,
                    expected_record_revision: revision,
                    resolution,
                    manual_value_json,
                },
            )
            .unwrap();
            let record: Value = serde_json::from_slice(
                &std::fs::read(
                    vault.join("Database/.ambd/records/01J00000000000000000000001.json"),
                )
                .unwrap(),
            )
            .unwrap();
            let note = std::fs::read_to_string(note_path).unwrap();
            std::fs::remove_dir_all(vault).unwrap();
            (result, record, note)
        };

        let (result, record, note) = resolve(DatabaseYamlResolution::Shard, None);
        assert!(result.changed);
        assert!(result.conflicts.is_empty());
        assert_eq!(record["values"][property_id]["decimal"], "2");
        assert!(note.contains("count: '2'") || note.contains("count: \"2\""));

        let (result, record, note) = resolve(DatabaseYamlResolution::Yaml, None);
        assert!(result.changed);
        assert!(result.conflicts.is_empty());
        assert_eq!(record["values"][property_id]["decimal"], "3");
        assert!(note.contains("count: 3"));

        let (result, record, note) = resolve(
            DatabaseYamlResolution::Manual,
            Some(r#"{"type":"number","decimal":"4"}"#.to_owned()),
        );
        assert!(result.changed);
        assert!(result.conflicts.is_empty());
        assert_eq!(record["values"][property_id]["decimal"], "4");
        assert!(note.contains("count: '4'") || note.contains("count: \"4\""));
    }
}
