//! Rebuildable SQLite projection for discovered database files.
//!
//! All filesystem reads and JSON parsing happen before the publish transaction.
//! The transaction only replaces the db_* projection, so a durable-file error
//! cannot turn into a destructive source-file write or a partial SQLite view.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use ulid::Ulid;

use super::discovery::{
    discover_vault, DiagnosticCode, DiagnosticSeverity, DiscoveredDatabase, DiscoveredNote,
    DiscoveryDiagnostic, DiscoveryResult,
};
use super::format::{
    parse_manifest, parse_record, parse_template, parse_view, DatabaseManifest, FileValue,
    ParsedJson, PropertyDefinition, PropertyValue, RecordShard,
};
use super::validation::canonical_decimal;
use crate::index::schema::init_schema;

const HEALTHY: &str = "healthy";
const STALE_READ_ONLY: &str = "staleReadOnly";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectionReport {
    pub published: bool,
    pub state: String,
    pub epoch: String,
    pub seq: u64,
    pub diagnostics: usize,
}

struct DatabaseInput {
    database: DiscoveredDatabase,
    manifest: ParsedJson<DatabaseManifest>,
    records: Vec<ParsedJson<RecordShard>>,
}

#[derive(Default)]
struct TypedValueColumns {
    text_value: Option<String>,
    text_sort_key: Option<Vec<u8>>,
    decimal_value: Option<String>,
    decimal_sort_key: Option<Vec<u8>>,
    bool_value: Option<i64>,
    date_start: Option<String>,
    date_end: Option<String>,
    date_start_key: Option<i64>,
    date_end_key: Option<i64>,
    date_precision: Option<String>,
    option_id: Option<String>,
}

/// Rebuild all database tables from the current durable filesystem snapshot.
pub fn rebuild_database_projection(
    conn: &Connection,
    vault: &Path,
) -> Result<ProjectionReport, String> {
    init_schema(conn)?;
    let discovery = discover_vault(vault)?;
    let inputs = load_inputs(&discovery)?;
    let has_errors = discovery
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error);
    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM db_databases", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    if has_errors && existing > 0 {
        let epoch = metadata_value(conn, "database_projection_epoch")?
            .unwrap_or_else(|| Ulid::generate().to_string());
        let seq = metadata_value(conn, "database_projection_seq")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        replace_diagnostics(&tx, &discovery.diagnostics)?;
        set_metadata(&tx, "database_projection_status", STALE_READ_ONLY)?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(ProjectionReport {
            published: false,
            state: STALE_READ_ONLY.to_owned(),
            epoch,
            seq,
            diagnostics: discovery.diagnostics.len(),
        });
    }

    let epoch = Ulid::generate().to_string();
    let state = if has_errors || inputs.iter().any(|input| input.database.read_only) {
        STALE_READ_ONLY
    } else {
        HEALTHY
    };
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    replace_projection(&tx, &discovery, &inputs, state)?;
    set_metadata(&tx, "database_projection_epoch", &epoch)?;
    set_metadata(&tx, "database_projection_seq", "0")?;
    set_metadata(&tx, "database_projection_status", state)?;
    tx.commit().map_err(|error| error.to_string())?;

    Ok(ProjectionReport {
        published: true,
        state: state.to_owned(),
        epoch,
        seq: 0,
        diagnostics: discovery.diagnostics.len(),
    })
}

fn load_inputs(discovery: &DiscoveryResult) -> Result<Vec<DatabaseInput>, String> {
    let mut inputs = Vec::new();
    for database in &discovery.databases {
        let bytes = fs::read(&database.manifest_path).map_err(|error| error.to_string())?;
        let manifest = parse_manifest(&bytes).map_err(|error| error.to_string())?;
        let records = load_records(database, &manifest.value)?;
        inputs.push(DatabaseInput {
            database: database.clone(),
            manifest,
            records,
        });
    }
    Ok(inputs)
}

fn load_records(
    database: &DiscoveredDatabase,
    manifest: &DatabaseManifest,
) -> Result<Vec<ParsedJson<RecordShard>>, String> {
    let directory = database.container_path.join(".ambd/records");
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(Vec::new());
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let path = entry.path();
            (file_type.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("json"))
            .then_some(path)
        })
        .collect::<Vec<_>>();
    paths.sort();

    let mut records = Vec::new();
    for path in paths {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        let parsed = match parse_record(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if parsed.value.database_id != manifest.database_id
            || parsed.value.note_id
                != path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or_default()
        {
            continue;
        }
        if !super::validation::validate_record(&parsed.value, Some(manifest))
            .errors
            .is_empty()
        {
            continue;
        }
        records.push(parsed);
    }
    Ok(records)
}

fn replace_projection(
    tx: &Transaction<'_>,
    discovery: &DiscoveryResult,
    inputs: &[DatabaseInput],
    state: &str,
) -> Result<(), String> {
    for table in [
        "db_value_files",
        "db_value_options",
        "db_relation_edges",
        "db_values_fts",
        "db_values",
        "db_record_revisions",
        "db_yaml_conflicts",
        "db_members",
        "db_options",
        "db_properties",
        "db_views",
        "db_templates",
        "db_databases",
        "db_diagnostics",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|error| error.to_string())?;
    }

    let note_by_path = discovery
        .notes
        .iter()
        .map(|note| (note.relative_path.as_str(), note))
        .collect::<HashMap<_, _>>();
    let note_by_id = discovery
        .notes
        .iter()
        .filter_map(|note| note.note_id.as_deref().map(|id| (id, note)))
        .collect::<HashMap<_, _>>();
    let mut known_note_ids = HashSet::new();
    let mut owner_by_note_id = HashMap::new();
    for note in &discovery.notes {
        if let (Some(note_id), Some(database_id)) =
            (note.note_id.as_deref(), note.owner_database_id.as_deref())
        {
            owner_by_note_id.insert(note_id.to_owned(), database_id.to_owned());
        }
    }

    for input in inputs {
        insert_database(tx, input, state, &note_by_path)?;
        insert_properties(tx, input)?;
        insert_views_and_templates(tx, input, state)?;
        for note in discovery.notes.iter().filter(|note| {
            note.owner_database_id.as_deref() == Some(input.manifest.value.database_id.as_str())
        }) {
            if let Some(note_id) = note.note_id.as_deref() {
                if note_exists(tx, note_id)? && known_note_ids.insert(note_id.to_owned()) {
                    insert_member(tx, input, note)?;
                }
            }
        }
        for record in &input.records {
            let Some(note) = note_by_id.get(record.value.note_id.as_str()) else {
                continue;
            };
            if note.owner_database_id.as_deref() != Some(input.manifest.value.database_id.as_str())
                || !note_exists(tx, &record.value.note_id)?
            {
                continue;
            }
            tx.execute(
                "INSERT INTO db_record_revisions (database_id, note_id, revision) VALUES (?1, ?2, ?3)",
                params![
                    input.manifest.value.database_id,
                    record.value.note_id,
                    record.revision,
                ],
            )
            .map_err(|error| error.to_string())?;
            insert_record_values(tx, input, record, &owner_by_note_id, &note_by_id)?;
            insert_yaml_conflicts(tx, input, record, note)?;
        }
    }
    replace_diagnostics(tx, &discovery.diagnostics)?;
    append_yaml_conflict_diagnostics(tx)?;
    Ok(())
}

fn insert_yaml_conflicts(
    tx: &Transaction<'_>,
    input: &DatabaseInput,
    record: &ParsedJson<RecordShard>,
    note: &DiscoveredNote,
) -> Result<(), String> {
    let bindings = input
        .manifest
        .value
        .properties
        .iter()
        .filter_map(|property| {
            let binding = property.yaml_binding()?;
            super::yaml_sync::is_yaml_sync_supported(property.kind()).then_some((property, binding))
        })
        .collect::<Vec<_>>();
    if bindings.is_empty() {
        return Ok(());
    }

    let source = match fs::read_to_string(&note.path) {
        Ok(source) => source,
        Err(error) => {
            for (property, binding) in bindings {
                insert_yaml_conflict(
                    tx,
                    input,
                    record,
                    property,
                    &binding.key,
                    serde_json::json!({ "error": error.to_string() }),
                    "",
                )?;
            }
            return Ok(());
        }
    };
    let note_revision = crate::index::note_index::body_revision(&source);
    let mapping = match crate::frontmatter::frontmatter_yaml_mapping(&source) {
        Ok(Some(mapping)) => mapping,
        Ok(None) => serde_yaml::Mapping::new(),
        Err(error) => {
            for (property, binding) in bindings {
                insert_yaml_conflict(
                    tx,
                    input,
                    record,
                    property,
                    &binding.key,
                    serde_json::json!({ "error": error }),
                    &note_revision,
                )?;
            }
            return Ok(());
        }
    };
    for (property, binding) in bindings {
        let shard = record.value.values.get(property.id().unwrap_or_default());
        let shard_json = shard
            .map(super::yaml_sync::property_value_json)
            .transpose()?
            .unwrap_or(serde_json::Value::Null);
        let base_json = super::yaml_sync::base_json(
            record
                .value
                .yaml_sync_bases
                .get(property.id().unwrap_or_default()),
        )?;
        let yaml_json = match mapping.get(serde_yaml::Value::String(binding.key.clone())) {
            Some(value) => match super::yaml_sync::property_value_from_yaml(property, value) {
                Ok(value) => super::yaml_sync::property_value_json(&value)?,
                Err(error) => serde_json::json!({ "error": error }),
            },
            None => serde_json::Value::Null,
        };
        if matches!(
            super::yaml_sync::resolve_three_way(&base_json, &shard_json, &yaml_json),
            super::yaml_sync::YamlSyncResolution::Conflict { .. }
        ) {
            insert_yaml_conflict(
                tx,
                input,
                record,
                property,
                &binding.key,
                yaml_json,
                &note_revision,
            )?;
        }
    }
    Ok(())
}

fn insert_yaml_conflict(
    tx: &Transaction<'_>,
    input: &DatabaseInput,
    record: &ParsedJson<RecordShard>,
    property: &super::format::PropertyDefinition,
    yaml_key: &str,
    yaml_json: serde_json::Value,
    note_revision: &str,
) -> Result<(), String> {
    let property_id = property.id().unwrap_or_default();
    let shard_json = record
        .value
        .values
        .get(property_id)
        .map(super::yaml_sync::property_value_json)
        .transpose()?
        .unwrap_or(serde_json::Value::Null);
    let base_json = super::yaml_sync::base_json(record.value.yaml_sync_bases.get(property_id))?;
    tx.execute(
        "INSERT OR REPLACE INTO db_yaml_conflicts (database_id, note_id, property_id, base_json, shard_json, yaml_json, note_revision, record_revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            input.manifest.value.database_id,
            record.value.note_id,
            property_id,
            base_json.to_string(),
            shard_json.to_string(),
            yaml_json.to_string(),
            note_revision,
            record.revision,
        ],
    )
    .map_err(|error| error.to_string())?;
    let _ = yaml_key;
    Ok(())
}

fn append_yaml_conflict_diagnostics(tx: &Transaction<'_>) -> Result<(), String> {
    let mut statement = tx
        .prepare(
            "SELECT database_id, note_id, property_id FROM db_yaml_conflicts ORDER BY database_id, note_id, property_id",
        )
        .map_err(|error| error.to_string())?;
    let conflicts = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (database_id, note_id, property_id) in conflicts {
        let path = format!("{database_id}/{note_id}/{property_id}");
        tx.execute(
            "INSERT INTO db_diagnostics (diagnostic_id, scope_kind, scope_key, code, severity, details_json, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%s','now'), strftime('%s','now'))",
            params![
                Ulid::generate().to_string(),
                "database",
                database_id,
                "yamlConflict",
                "error",
                serde_json::json!({
                    "path": path,
                    "message": "YAML and database values changed independently; choose a field value",
                })
                .to_string(),
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn insert_database(
    tx: &Transaction<'_>,
    input: &DatabaseInput,
    state: &str,
    note_by_path: &HashMap<&str, &DiscoveredNote>,
) -> Result<(), String> {
    let manifest = &input.manifest.value;
    let attached_relative = input
        .database
        .attached_note_path
        .as_ref()
        .map(|path| relative_path_from_container(&input.database, path));
    let attached_note_id = attached_relative
        .as_deref()
        .and_then(|path| note_by_path.get(path))
        .and_then(|note| note.note_id.as_deref())
        .filter(|note_id| note_exists(tx, note_id).unwrap_or(false));
    let cover_json = manifest
        .cover
        .as_ref()
        .map(|cover| serde_json::to_string(cover).map_err(|error| error.to_string()))
        .transpose()?;
    tx.execute(
        "INSERT INTO db_databases (database_id, container_path, attached_note_id, name, icon, cover_json, locked, format_version, manifest_revision, projection_state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            manifest.database_id,
            input.database.relative_container_path,
            attached_note_id,
            manifest.name,
            manifest.icon,
            cover_json,
            manifest.locked as i64,
            manifest.format_version as i64,
            input.database.revision,
            if input.database.read_only { STALE_READ_ONLY } else { state },
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn relative_path_from_container(database: &DiscoveredDatabase, path: &Path) -> String {
    path.strip_prefix(&database.container_path)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map(|path| {
            if database.relative_container_path.is_empty() {
                path
            } else {
                format!("{}/{}", database.relative_container_path, path)
            }
        })
        .unwrap_or_default()
}

fn insert_properties(tx: &Transaction<'_>, input: &DatabaseInput) -> Result<(), String> {
    for (position, property) in input.manifest.value.properties.iter().enumerate() {
        let Some(property_id) = property.id() else {
            continue;
        };
        let object = serde_json::to_value(property)
            .map_err(|error| error.to_string())?
            .as_object()
            .cloned()
            .ok_or_else(|| "property must serialize as an object".to_owned())?;
        let config_json = object
            .get("config")
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| "{}".to_owned());
        let binding = property.yaml_binding();
        tx.execute(
            "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json, yaml_key, yaml_direction) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.manifest.value.database_id,
                property_id,
                position as i64,
                object.get("name").and_then(Value::as_str).unwrap_or_default(),
                property.kind(),
                object
                    .get("pageVisibility")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                config_json,
                binding.map(|binding| binding.key.as_str()),
                binding.map(|binding| binding.direction.as_str()),
            ],
        )
        .map_err(|error| error.to_string())?;
        insert_options(tx, &input.manifest.value.database_id, property)?;
    }
    Ok(())
}

fn insert_options(
    tx: &Transaction<'_>,
    database_id: &str,
    property: &PropertyDefinition,
) -> Result<(), String> {
    let options = match property {
        PropertyDefinition::Select(fields) | PropertyDefinition::MultiSelect(fields) => fields
            .config
            .options
            .iter()
            .map(|option| {
                (
                    option.id.clone(),
                    option.name.clone(),
                    option.color.clone(),
                    None,
                )
            })
            .collect::<Vec<_>>(),
        PropertyDefinition::Status(fields) => fields
            .config
            .options
            .iter()
            .map(|option| {
                (
                    option.id.clone(),
                    option.name.clone(),
                    option.color.clone(),
                    Some(option.group.clone()),
                )
            })
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    for (position, (id, name, color, group)) in options.into_iter().enumerate() {
        tx.execute(
            "INSERT INTO db_options (database_id, property_id, option_id, position, name, color, status_group) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                database_id,
                property.id().unwrap_or_default(),
                id,
                position as i64,
                name,
                color,
                group,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn insert_member(
    tx: &Transaction<'_>,
    input: &DatabaseInput,
    note: &DiscoveredNote,
) -> Result<(), String> {
    let parent_note_id = note
        .parent_note_id
        .as_deref()
        .filter(|parent| note_exists(tx, parent).unwrap_or(false));
    tx.execute(
        "INSERT INTO db_members (database_id, note_id, parent_note_id, relative_path, category_path, depth, title_sort_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            input.manifest.value.database_id,
            note.note_id.as_deref().unwrap_or_default(),
            parent_note_id,
            note.relative_path,
            serde_json::to_string(&note.category_path).map_err(|error| error.to_string())?,
            note.depth as i64,
            text_sort_key(&note.title),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_views_and_templates(
    tx: &Transaction<'_>,
    input: &DatabaseInput,
    state: &str,
) -> Result<(), String> {
    let database_id = &input.manifest.value.database_id;
    let view_dir = input.database.container_path.join(".ambd/views");
    for (position, view_id) in input.manifest.value.view_order.iter().enumerate() {
        let path = view_dir.join(format!("{view_id}.json"));
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let Ok(view) = parse_view(&bytes) else {
            continue;
        };
        let query_json = serde_json::to_string(&view.value).map_err(|error| error.to_string())?;
        let layout_json =
            serde_json::to_string(&view.value.layout_config).map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO db_views (database_id, view_id, position, name, layout, revision, query_json, layout_json, projection_state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                database_id,
                view.value.view_id,
                position as i64,
                view.value.name,
                view.value.layout,
                view.revision,
                query_json,
                layout_json,
                if input.database.read_only { STALE_READ_ONLY } else { state },
            ],
        )
        .map_err(|error| error.to_string())?;
    }

    let template_dir = input.database.container_path.join(".ambd/templates");
    for (position, template_id) in input.manifest.value.template_order.iter().enumerate() {
        let path = template_dir.join(format!("{template_id}.json"));
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let Ok(template) = parse_template(&bytes) else {
            continue;
        };
        insert_template(tx, database_id, position, &template, state)?;
    }
    Ok(())
}

fn insert_template(
    tx: &Transaction<'_>,
    database_id: &str,
    position: usize,
    template: &ParsedJson<super::format::DatabaseTemplateFile>,
    state: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO db_templates (database_id, template_id, position, name, revision, body, values_json, projection_state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            database_id,
            template.value.template_id,
            position as i64,
            template.value.name,
            template.revision,
            template.value.body,
            serde_json::to_string(&template.value.values).map_err(|error| error.to_string())?,
            state,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_record_values(
    tx: &Transaction<'_>,
    input: &DatabaseInput,
    record: &ParsedJson<RecordShard>,
    owner_by_note_id: &HashMap<String, String>,
    note_by_id: &HashMap<&str, &DiscoveredNote>,
) -> Result<(), String> {
    let property_ids = input
        .manifest
        .value
        .properties
        .iter()
        .filter_map(|property| property.id())
        .collect::<HashSet<_>>();
    for (property_id, value) in &record.value.values {
        if !property_ids.contains(property_id.as_str()) {
            continue;
        }
        let canonical_json = serde_json::to_string(value).map_err(|error| error.to_string())?;
        let columns = typed_columns(value);
        tx.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, text_value, text_sort_key, decimal_value, decimal_sort_key, bool_value, date_start, date_end, date_start_key, date_end_key, date_precision, option_id, source_revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                input.manifest.value.database_id,
                record.value.note_id,
                property_id,
                value.kind(),
                canonical_json,
                columns.text_value,
                columns.text_sort_key,
                columns.decimal_value,
                columns.decimal_sort_key,
                columns.bool_value,
                columns.date_start,
                columns.date_end,
                columns.date_start_key,
                columns.date_end_key,
                columns.date_precision,
                columns.option_id,
                record.revision,
            ],
        )
        .map_err(|error| error.to_string())?;
        insert_value_children(
            tx,
            input,
            &record.value.note_id,
            property_id,
            value,
            owner_by_note_id,
            note_by_id,
        )?;
        let searchable = searchable_text(value);
        if !searchable.is_empty() {
            tx.execute(
                "INSERT INTO db_values_fts (database_id, note_id, property_id, searchable_text) VALUES (?1, ?2, ?3, ?4)",
                params![
                    input.manifest.value.database_id,
                    record.value.note_id,
                    property_id,
                    searchable,
                ],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn insert_value_children(
    tx: &Transaction<'_>,
    input: &DatabaseInput,
    note_id: &str,
    property_id: &str,
    value: &PropertyValue,
    owner_by_note_id: &HashMap<String, String>,
    note_by_id: &HashMap<&str, &DiscoveredNote>,
) -> Result<(), String> {
    match value {
        PropertyValue::MultiSelect { option_ids, .. } => {
            for (position, option_id) in option_ids.iter().enumerate() {
                tx.execute(
                    "INSERT INTO db_value_options (database_id, note_id, property_id, option_id, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        input.manifest.value.database_id,
                        note_id,
                        property_id,
                        option_id,
                        position as i64,
                    ],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        PropertyValue::Files { items, .. } => {
            for (position, item) in items.iter().enumerate() {
                insert_file_value(tx, input, note_id, property_id, position, item)?;
            }
        }
        PropertyValue::Relation {
            target_note_ids, ..
        } => {
            let target_database_id =
                input
                    .manifest
                    .value
                    .properties
                    .iter()
                    .find_map(|property| match property {
                        PropertyDefinition::Relation(fields) if fields.id == property_id => {
                            Some(fields.config.target_database_id.as_str())
                        }
                        _ => None,
                    });
            for (position, target_note_id) in target_note_ids.iter().enumerate() {
                let target_state = match note_by_id.get(target_note_id.as_str()) {
                    Some(_note)
                        if owner_by_note_id
                            .get(target_note_id)
                            .is_some_and(|owner| Some(owner.as_str()) == target_database_id) =>
                    {
                        "resolved"
                    }
                    Some(_) => "outsideDatabase",
                    None => "missing",
                };
                tx.execute(
                    "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        input.manifest.value.database_id,
                        note_id,
                        property_id,
                        target_note_id,
                        position as i64,
                        target_state,
                    ],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn insert_file_value(
    tx: &Transaction<'_>,
    input: &DatabaseInput,
    note_id: &str,
    property_id: &str,
    position: usize,
    item: &FileValue,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO db_value_files (database_id, note_id, property_id, asset_id, position, relative_path, name, mime_type, size_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            input.manifest.value.database_id,
            note_id,
            property_id,
            item.asset_id,
            position as i64,
            item.relative_path,
            item.name,
            item.mime_type,
            item.size_bytes as i64,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn typed_columns(value: &PropertyValue) -> TypedValueColumns {
    match value {
        PropertyValue::Text { value, .. } | PropertyValue::Url { value, .. } => TypedValueColumns {
            text_value: Some(value.clone()),
            text_sort_key: Some(text_sort_key(value)),
            ..Default::default()
        },
        PropertyValue::Number { decimal, .. } => TypedValueColumns {
            decimal_value: Some(decimal.clone()),
            decimal_sort_key: decimal_sort_key(decimal),
            ..Default::default()
        },
        PropertyValue::Checkbox { checked, .. } => TypedValueColumns {
            bool_value: Some(*checked as i64),
            ..Default::default()
        },
        PropertyValue::Date { start, end, .. } => {
            let (start_key, precision) = date_key(start);
            let end_key = end.as_deref().and_then(|end| date_key(end).0);
            TypedValueColumns {
                date_start: Some(start.clone()),
                date_end: end.clone(),
                date_start_key: start_key,
                date_end_key: end_key,
                date_precision: precision.map(str::to_owned),
                ..Default::default()
            }
        }
        PropertyValue::Select { option_id, .. } | PropertyValue::Status { option_id, .. } => {
            TypedValueColumns {
                option_id: Some(option_id.clone()),
                ..Default::default()
            }
        }
        _ => Default::default(),
    }
}

fn searchable_text(value: &PropertyValue) -> String {
    match value {
        PropertyValue::Text { value, .. } | PropertyValue::Url { value, .. } => value.clone(),
        PropertyValue::Select { option_id, .. } | PropertyValue::Status { option_id, .. } => {
            option_id.clone()
        }
        PropertyValue::MultiSelect { option_ids, .. } => option_ids.join(" "),
        _ => String::new(),
    }
}

fn text_sort_key(value: &str) -> Vec<u8> {
    value.to_lowercase().into_bytes()
}

pub(crate) fn decimal_sort_key(value: &str) -> Option<Vec<u8>> {
    let canonical = canonical_decimal(value).ok()?;
    if canonical == "0" {
        return Some(vec![0x80]);
    }
    let negative = canonical.starts_with('-');
    let unsigned = canonical.strip_prefix('-').unwrap_or(&canonical);
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let mut digits = format!("{whole}{fraction}");
    let leading = digits.bytes().take_while(|byte| *byte == b'0').count();
    digits.drain(..leading);
    let position = i64::try_from(whole.len())
        .ok()?
        .checked_sub(i64::try_from(leading).ok()?)?;
    let mut key = Vec::with_capacity(1 + 8 + digits.len());
    key.push(if negative { 0x01 } else { 0x81 });
    let sortable_position = (position ^ i64::MIN).to_be_bytes();
    if negative {
        key.extend(sortable_position.map(|byte| !byte));
        key.extend(digits.bytes().map(|byte| !byte));
        // Reverse prefix ordering too: -1.23 must precede -1.2.
        key.push(0xff);
    } else {
        key.extend(sortable_position);
        key.extend(digits.bytes());
    }
    Some(key)
}

fn date_key(value: &str) -> (Option<i64>, Option<&'static str>) {
    if value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
    {
        let year = parse_digits(value, 0, 4);
        let month = parse_digits(value, 5, 2);
        let day = parse_digits(value, 8, 2);
        return match (year, month, day) {
            (Some(year), Some(month), Some(day)) => {
                (days_from_civil(year, month, day), Some("date"))
            }
            _ => (None, None),
        };
    }
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return (None, None);
    }
    let (year, month, day, hour, minute, second) = (
        parse_digits(value, 0, 4),
        parse_digits(value, 5, 2),
        parse_digits(value, 8, 2),
        parse_digits(value, 11, 2),
        parse_digits(value, 14, 2),
        parse_digits(value, 17, 2),
    );
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) =
        (year, month, day, hour, minute, second)
    else {
        return (None, None);
    };
    let timezone_start = value
        .find('Z')
        .or_else(|| value.rfind('+'))
        .or_else(|| value.rfind('-').filter(|index| *index > 10));
    let Some(timezone_start) = timezone_start else {
        return (None, None);
    };
    let offset = &value[timezone_start..];
    let offset_minutes = if offset == "Z" {
        0
    } else if offset.len() == 6 && offset.as_bytes().get(3) == Some(&b':') {
        let Some(hours) = parse_digits(offset, 1, 2) else {
            return (None, None);
        };
        let Some(minutes) = parse_digits(offset, 4, 2) else {
            return (None, None);
        };
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        sign * (hours * 60 + minutes)
    } else {
        return (None, None);
    };
    let Some(days) = days_from_civil(year, month, day) else {
        return (None, None);
    };
    let Some(seconds) = days
        .checked_mul(86_400)
        .and_then(|seconds| seconds.checked_add(hour * 3_600 + minute * 60 + second))
        .and_then(|seconds| seconds.checked_sub(offset_minutes * 60))
    else {
        return (None, None);
    };
    (Some(seconds), Some("instant"))
}

fn parse_digits(value: &str, start: usize, length: usize) -> Option<i64> {
    let bytes = value.as_bytes().get(start..start + length)?;
    bytes.iter().all(u8::is_ascii_digit).then(|| {
        bytes
            .iter()
            .fold(0_i64, |total, byte| total * 10 + i64::from(byte - b'0'))
    })
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_from_march = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn note_exists(tx: &Transaction<'_>, note_id: &str) -> Result<bool, String> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM notes WHERE id = ?1)",
        [note_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn replace_diagnostics(
    tx: &Transaction<'_>,
    diagnostics: &[DiscoveryDiagnostic],
) -> Result<(), String> {
    tx.execute("DELETE FROM db_diagnostics", [])
        .map_err(|error| error.to_string())?;
    for diagnostic in diagnostics {
        tx.execute(
            "INSERT INTO db_diagnostics (diagnostic_id, scope_kind, scope_key, code, severity, details_json, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%s','now'), strftime('%s','now'))",
            params![
                Ulid::generate().to_string(),
                "vault",
                diagnostic.path,
                diagnostic_code(diagnostic.code),
                diagnostic_severity(diagnostic.severity),
                serde_json::json!({
                    "path": diagnostic.path,
                    "message": diagnostic.message,
                })
                .to_string(),
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn diagnostic_code(code: DiagnosticCode) -> &'static str {
    match code {
        DiagnosticCode::BrokenManifest => "brokenManifest",
        DiagnosticCode::UnsupportedManifest => "unsupportedManifest",
        DiagnosticCode::InvalidManifest => "invalidManifest",
        DiagnosticCode::DuplicateDatabaseId => "duplicateDatabaseId",
        DiagnosticCode::DuplicateDatabaseTitle => "duplicateDatabaseTitle",
        DiagnosticCode::BrokenNote => "brokenNote",
        DiagnosticCode::InvalidNoteId => "invalidNoteId",
        DiagnosticCode::DuplicateNoteId => "duplicateNoteId",
        DiagnosticCode::DuplicateNoteTitle => "duplicateNoteTitle",
        DiagnosticCode::BrokenShard => "brokenShard",
        DiagnosticCode::OrphanShard => "orphanShard",
        DiagnosticCode::MissingShard => "missingShard",
        DiagnosticCode::DatabaseIdMismatch => "databaseIdMismatch",
        DiagnosticCode::InvalidShardFilename => "invalidShardFilename",
        DiagnosticCode::SymlinkEscape => "symlinkEscape",
        DiagnosticCode::NestedBoundary => "nestedBoundary",
    }
}

fn diagnostic_severity(severity: DiagnosticSeverity) -> &'static str {
    match severity {
        DiagnosticSeverity::Warning => "warning",
        DiagnosticSeverity::Error => "error",
    }
}

fn set_metadata(tx: &Transaction<'_>, key: &str, value: &str) -> Result<(), String> {
    tx.execute(
        "INSERT INTO index_metadata (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn metadata_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM index_metadata WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{open_connection, sync_vault};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("amby-projection-{name}-{nanos}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn manifest(id: &str, view_id: Option<&str>) -> Value {
        json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": id,
            "name": "Database",
            "locked": false,
            "membership": {"kind": "filesystem-descendants", "recursive": true},
            "properties": [{
                "id": "01J00000000000000000000004",
                "name": "Count",
                "type": "number",
                "pageVisibility": "alwaysShow",
                "yamlBinding": null,
                "config": {"format": "number", "currency": null}
            }],
            "viewOrder": view_id.into_iter().collect::<Vec<_>>(),
            "defaultViewId": view_id,
            "templateOrder": [],
            "defaultTemplateId": null
        })
    }

    #[test]
    fn exact_decimal_keys_order_negative_prefixes_and_normalize_equal_values() {
        let ordered = [
            "-90071992547409931234567890.125",
            "-90071992547409931234567890.12",
            "-100",
            "-10.01",
            "-10",
            "-1.23",
            "-1.2",
            "-1.001",
            "-1",
            "-0.001",
            "0",
            "0.001",
            "1",
            "1.001",
            "1.2",
            "1.23",
            "10",
            "90071992547409931234567890.12",
            "90071992547409931234567890.125",
        ];
        for pair in ordered.windows(2) {
            assert!(
                decimal_sort_key(pair[0]).unwrap() < decimal_sort_key(pair[1]).unwrap(),
                "{} must precede {}",
                pair[0],
                pair[1]
            );
        }
        for (left, right) in [
            ("-1.200", "-1.2"),
            ("-0", "0"),
            ("1.2e3", "1200"),
            ("+001.00", "1"),
        ] {
            assert_eq!(decimal_sort_key(left), decimal_sort_key(right));
        }
    }

    #[test]
    fn relations_resolve_against_the_declared_target_and_rebuild_without_source_changes() {
        let vault = temp_vault("relation-target");
        let source_id = "01J00000000000000000000000";
        let target_id = "01J00000000000000000000010";
        let row_id = "01J00000000000000000000001";
        let target_note_id = "01J00000000000000000000011";
        let missing_id = "01J00000000000000000000012";
        let property_id = "01J00000000000000000000004";
        let mut sources = Vec::new();
        for (name, database_id, note_id) in [
            ("Source", source_id, row_id),
            ("Target", target_id, target_note_id),
        ] {
            let container = vault.join(name);
            fs::create_dir_all(container.join(".ambd/records")).unwrap();
            let mut definition = manifest(database_id, None);
            definition["name"] = json!(name);
            definition["properties"] = if database_id == source_id {
                json!([{
                    "id": property_id, "name": "Related", "type": "relation",
                    "pageVisibility": "alwaysShow", "yamlBinding": null,
                    "config": {"targetDatabaseId": target_id, "maxItems": null, "inversePropertyId": null}
                }])
            } else {
                json!([])
            };
            sources.push((
                container.join("ambd.json"),
                serde_json::to_vec_pretty(&definition).unwrap(),
            ));
            sources.push((
                container.join("Row.md"),
                format!("---\namby-id: {note_id}\n---\n# Row\n").into_bytes(),
            ));
        }
        sources.push((vault.join(format!("Source/.ambd/records/{row_id}.json")),
            serde_json::to_vec_pretty(&json!({
                "format": "amby-database-record", "formatVersion": 1,
                "databaseId": source_id, "noteId": row_id,
                "values": {property_id: {"type":"relation", "targetNoteIds":[target_note_id, row_id, missing_id]}}
            })).unwrap()));
        for (path, bytes) in &sources {
            fs::write(path, bytes).unwrap();
        }

        // Two independent, empty indexes must reconstruct the same links.
        for _ in 0..2 {
            let conn = Connection::open_in_memory().unwrap();
            init_schema(&conn).unwrap();
            sync_vault(&conn, &vault).unwrap();
            let report = rebuild_database_projection(&conn, &vault).unwrap();
            assert_eq!(report.state, HEALTHY);
            let mut statement = conn
                .prepare(
                    "SELECT target_note_id, target_state FROM db_relation_edges ORDER BY position",
                )
                .unwrap();
            let edges = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(
                edges,
                [
                    (target_note_id, "resolved"),
                    (row_id, "outsideDatabase"),
                    (missing_id, "missing")
                ]
                .map(|(id, state)| (id.to_owned(), state.to_owned()))
            );
            for (path, bytes) in &sources {
                assert_eq!(fs::read(path).unwrap(), *bytes);
            }
        }
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn rebuild_publishes_complete_projection_and_exact_decimal_columns() {
        let vault = temp_vault("publish");
        let database = vault.join("Database");
        fs::create_dir_all(database.join(".ambd/records")).unwrap();
        fs::write(
            database.join("ambd.json"),
            serde_json::to_vec_pretty(&manifest("01J00000000000000000000000", None)).unwrap(),
        )
        .unwrap();
        fs::write(
            database.join("Row.md"),
            "---\namby-id: 01J00000000000000000000001\n---\n# Row\n",
        )
        .unwrap();
        fs::write(
            database.join(".ambd/records/01J00000000000000000000001.json"),
            serde_json::to_vec_pretty(&json!({
                "format": "amby-database-record",
                "formatVersion": 1,
                "databaseId": "01J00000000000000000000000",
                "noteId": "01J00000000000000000000001",
                "values": {
                    "01J00000000000000000000004": {"type":"number", "decimal":"90071992547409931234567890.125"}
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let conn = open_connection(&vault).unwrap();
        sync_vault(&conn, &vault).unwrap();
        let report = rebuild_database_projection(&conn, &vault).unwrap();
        assert!(report.published);
        assert_eq!(report.state, HEALTHY);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM db_databases", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let decimal: String = conn
            .query_row("SELECT decimal_value FROM db_values", [], |row| row.get(0))
            .unwrap();
        assert_eq!(decimal, "90071992547409931234567890.125");
        let real_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('db_values') WHERE type = 'REAL'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(real_columns, 0);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn rebuild_projects_yaml_field_conflicts_without_mutating_sources() {
        let vault = temp_vault("yaml-conflict");
        let database = vault.join("Database");
        let note_id = "01J00000000000000000000001";
        let database_id = "01J00000000000000000000000";
        let property_id = "01J00000000000000000000004";
        fs::create_dir_all(database.join(".ambd/records")).unwrap();
        let mut manifest = manifest(database_id, None);
        manifest["properties"][0]["yamlBinding"] = json!({
            "key": "count",
            "direction": "twoWay"
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        fs::write(database.join("ambd.json"), &manifest_bytes).unwrap();
        let note_source = format!("---\namby-id: {note_id}\ncount: 3\n---\n# Row\n");
        fs::write(database.join("Row.md"), &note_source).unwrap();
        fs::write(
            database.join(format!(".ambd/records/{note_id}.json")),
            serde_json::to_vec_pretty(&json!({
                "format": "amby-database-record",
                "formatVersion": 1,
                "databaseId": database_id,
                "noteId": note_id,
                "values": {
                    property_id: {"type":"number", "decimal":"2"}
                },
                "yamlSyncBases": {
                    property_id: {
                        "state":"value",
                        "value":{"type":"number", "decimal":"1"}
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let conn = open_connection(&vault).unwrap();
        sync_vault(&conn, &vault).unwrap();
        rebuild_database_projection(&conn, &vault).unwrap();
        let conflicts: i64 = conn
            .query_row("SELECT COUNT(*) FROM db_yaml_conflicts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(conflicts, 1);
        let diagnostic: String = conn
            .query_row(
                "SELECT code FROM db_diagnostics WHERE code = 'yamlConflict'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(diagnostic, "yamlConflict");
        assert_eq!(
            fs::read(database.join("Row.md")).unwrap(),
            note_source.as_bytes()
        );
        assert_eq!(
            fs::read(database.join("ambd.json")).unwrap(),
            manifest_bytes
        );
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn broken_rebuild_preserves_existing_projection_and_marks_stale() {
        let vault = temp_vault("stale");
        let database = vault.join("Database");
        fs::create_dir_all(&database).unwrap();
        fs::write(
            database.join("ambd.json"),
            serde_json::to_vec_pretty(&manifest("01J00000000000000000000000", None)).unwrap(),
        )
        .unwrap();
        let conn = open_connection(&vault).unwrap();
        let first = rebuild_database_projection(&conn, &vault).unwrap();
        assert!(first.published);
        fs::write(database.join("ambd.json"), b"{broken").unwrap();
        let second = rebuild_database_projection(&conn, &vault).unwrap();
        assert!(!second.published);
        assert_eq!(second.state, STALE_READ_ONLY);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM db_databases", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn foreign_keys_and_projection_metadata_are_present() {
        let vault = temp_vault("schema");
        let conn = open_connection(&vault).unwrap();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'db_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(tables >= 12);
        let version: String = conn
            .query_row(
                "SELECT value FROM index_metadata WHERE key = 'database_schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "1");
        fs::remove_dir_all(vault).unwrap();
    }
}
