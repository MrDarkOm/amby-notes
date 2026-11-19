use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use super::{allowed, relative, Published};
use crate::database::discovery::{discover_vault, DiscoveredDatabase};
use crate::database::failure::{classify, FailureReason};
use crate::database::format::{parse_manifest, PropertyValue};
use crate::database::model::{
    DatabasePageRequest, DatabaseQueryRequest, DatabaseQuerySource, DatabaseQuerySpec,
};
use crate::database::mutations::{
    apply_scoped_value_batch, create_database, create_database_property,
    CreateDatabasePropertyRequest, CreateDatabaseRequest, DatabaseCreateMode,
    DatabaseValueBatchRequest, DatabaseValueMutation, ValueBatchError,
};
use crate::database::rows::{create_database_row, CreateDatabaseRowRequest, DatabaseRowTemplate};
use crate::self_write::SelfWriteTracker;

pub fn list(root: &Path) -> Result<Value, &'static str> {
    let discovery = discover_vault(root).map_err(|_| "unavailable")?;
    let summaries: Vec<_> = discovery
        .databases
        .iter()
        .take(super::MAX_ITEMS)
        .map(summary)
        .collect();
    Ok(json!({"databases": summaries, "truncated": discovery.databases.len() > summaries.len()}))
}

fn summary(database: &DiscoveredDatabase) -> Value {
    json!({
        "databaseId": database.database_id, "name": database.name,
        "path": database.relative_container_path, "revision": database.revision,
        "readOnly": database.read_only
    })
}

fn database(root: &Path, id: &str) -> Result<DiscoveredDatabase, &'static str> {
    let discovery = discover_vault(root).map_err(|_| "unavailable")?;
    let mut matches = discovery
        .databases
        .into_iter()
        .filter(|db| db.database_id == id);
    let database = matches.next().ok_or("notFound")?;
    if matches.next().is_some() {
        return Err("ambiguousDatabase");
    }
    let rel = relative(root, &database.manifest_path)?;
    crate::durable::guarded_path(root, &rel, "database tool").map_err(|_| "accessDenied")?;
    Ok(database)
}

pub fn read(root: &Path, id: &str) -> Result<Value, &'static str> {
    let database = database(root, id)?;
    let bytes = fs::read(&database.manifest_path).map_err(|_| "unavailable")?;
    let manifest = parse_manifest(&bytes).map_err(|_| "invalidDatabase")?;
    Ok(
        json!({"database": summary(&database), "properties": manifest.value.properties, "locked": manifest.value.locked}),
    )
}

pub fn query(
    root: &Path,
    id: &str,
    search: Option<String>,
    cursor: Option<String>,
    limit: u32,
) -> Result<Value, &'static str> {
    database(root, id)?;
    let conn = crate::index::read_only::disk_catalog(root).map_err(|_| "unavailable")?;
    crate::database::projection::rebuild_database_projection(&conn, root)
        .map_err(|_| "unavailable")?;
    let request = DatabaseQueryRequest {
        expected_generation: 0,
        database_id: id.into(),
        search,
        sorts: None,
        filter: None,
        source: DatabaseQuerySource::Inline {
            spec: DatabaseQuerySpec {
                filter: None,
                sorts: Vec::new(),
            },
        },
        page: DatabasePageRequest { limit, cursor },
        context_page_id: None,
        manual_order: None,
    };
    let result =
        crate::database::query::query_database(&conn, &request).map_err(|error| error.code)?;
    let rows: Vec<_> = result
        .rows
        .into_iter()
        .map(|row| {
            json!({
                "noteId": row.note_id,
                "title": row.title,
                "path": row.relative_path,
                "revision": row.row_revision,
                "values": serde_json::from_str::<Value>(&row.values_json).unwrap_or(Value::Null)
            })
        })
        .collect();
    Ok(json!({"rows": rows, "nextCursor": result.next_cursor, "totalCount": result.total_count}))
}

pub(super) fn writable_database(
    root: &Path,
    scope: &Path,
    id: &str,
) -> Result<DiscoveredDatabase, &'static str> {
    let database = database(root, id)?;
    allowed(scope, &database.container_path)?;
    if database.read_only {
        return Err("readOnly");
    }
    let bytes = fs::read(&database.manifest_path).map_err(|_| "unavailable")?;
    if parse_manifest(&bytes)
        .map_err(|_| "invalidDatabase")?
        .value
        .locked
    {
        return Err("locked");
    }
    Ok(database)
}

pub fn create(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    parent: &str,
    name: &str,
) -> Result<Published, &'static str> {
    let parent = crate::index::read_only::visible_folder(root, super::root_folder(parent))?;
    allowed(scope, &parent)?;
    let name = crate::project::names::normalize_entry_name("name", name)
        .map_err(|_| "invalidArguments")?;
    let container = parent.join(&name);
    let path = relative(root, &container)?;
    crate::durable::guarded_path(root, &path, "new database").map_err(|_| "accessDenied")?;
    if fs::symlink_metadata(&container).is_ok() {
        return Err("mutationConflict");
    }
    let result = create_database(
        root,
        watcher,
        &CreateDatabaseRequest {
            expected_generation: 0,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(parent.to_str().ok_or("invalidArguments")?.into()),
            note_path: None,
            name: name.clone(),
        },
    )
    .map_err(domain_error)?;
    Ok(Published::one(
        json!({
            "databaseId": result.database_id, "name": result.title,
            "revision": result.manifest_revision, "viewId": result.view_id,
            "path": path
        }),
        result.manifest_path.into(),
    ))
}

pub fn create_row(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    id: &str,
    title: &str,
) -> Result<Published, &'static str> {
    writable_database(root, scope, id)?;
    let title = crate::project::names::normalize_entry_name("title", title)
        .map_err(|_| "invalidArguments")?;
    let result = create_database_row(
        root,
        watcher,
        &CreateDatabaseRowRequest {
            expected_generation: 0,
            database_id: id.into(),
            title,
            template: DatabaseRowTemplate::Empty,
        },
    )
    .map_err(domain_error)?;
    let path = std::path::PathBuf::from(result.note_path);
    // The legacy record-shard revision can be empty for a Markdown row.
    let revision =
        crate::database::format::raw_revision(&fs::read(&path).map_err(|_| "unavailable")?);
    Ok(Published::one(
        json!({
            "databaseId": id, "noteId": result.note_id, "title": result.title,
            "revision": revision, "path": relative(root, &path)?
        }),
        path,
    ))
}

pub fn add_property(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    request: &CreateDatabasePropertyRequest,
) -> Result<Published, &'static str> {
    let database = writable_database(root, scope, &request.database_id)?;
    if !matches!(
        request.property_type.as_str(),
        "text" | "number" | "checkbox" | "date" | "url" | "select" | "multiSelect" | "status"
    ) {
        return Err("unsupportedProperty");
    }
    let result = create_database_property(root, watcher, request).map_err(domain_error)?;
    Ok(Published::one(
        json!({
            "databaseId": result.database_id, "propertyId": result.property_id,
            "name": result.name, "propertyType": result.property_type, "revision": result.manifest_revision
        }),
        database.manifest_path,
    ))
}

pub fn rename(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    request: &crate::database::mutations::RenameDatabaseRequest,
) -> Result<Published, &'static str> {
    let database = writable_database(root, scope, &request.database_id)?;
    let result = crate::database::mutations::rename_database(root, watcher, request)
        .map_err(domain_error)?;
    Ok(Published::one(
        json!({
            "databaseId":result.database_id, "name":result.title,
            "path":database.relative_container_path, "revision":result.manifest_revision
        }),
        database.manifest_path,
    ))
}

pub fn rename_property(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    request: &crate::database::mutations::RenameDatabasePropertyRequest,
) -> Result<Published, &'static str> {
    let database = writable_database(root, scope, &request.database_id)?;
    let result = crate::database::mutations::rename_database_property(root, watcher, request)
        .map_err(domain_error)?;
    Ok(Published::one(
        json!({
            "databaseId":result.database_id, "propertyId":result.property_id,
            "name":result.name, "revision":result.manifest_revision
        }),
        database.manifest_path,
    ))
}

pub fn set_value(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    request: &super::SetDatabaseValue,
) -> Result<Published, &'static str> {
    let database = writable_database(root, scope, &request.database_id)?;
    let path = crate::database::mutations::resolve_note_path_for_id(
        root,
        &database.container_path,
        &request.note_id,
    )
    .map_err(domain_error)?;
    allowed(scope, &path)?;
    let bytes = fs::read(&database.manifest_path).map_err(|_| "unavailable")?;
    let manifest = parse_manifest(&bytes).map_err(|_| "invalidDatabase")?;
    let property = manifest
        .value
        .properties
        .iter()
        .find(|property| property.id() == Some(&request.property_id))
        .ok_or("notFound")?;
    if matches!(
        property.kind(),
        "relation" | "formula" | "rollup" | "files" | "opaque"
    ) {
        return Err("unsupportedProperty");
    }
    let value = if request.value.is_null() {
        None
    } else {
        let value: PropertyValue =
            serde_json::from_value(request.value.clone()).map_err(|_| "invalidValue")?;
        if !crate::database::validation::is_valid_assignment(&value, property) {
            return Err("invalidValue");
        }
        Some(value)
    };
    let result = apply_scoped_value_batch(
        root,
        watcher,
        &DatabaseValueBatchRequest {
            expected_generation: 0,
            database_id: request.database_id.clone(),
            operation_id: super::operation_id(
                root,
                scope,
                "database-value",
                &request.operation_id,
            )?,
            cells: vec![DatabaseValueMutation {
                note_id: request.note_id.clone(),
                property_id: request.property_id.clone(),
                expected_revision: request.expected_revision.clone(),
                value_json: value
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|_| "invalidValue")?,
            }],
        },
    )
    .map_err(|error| match error {
        ValueBatchError::RevisionConflict { .. } => "revisionConflict",
        ValueBatchError::Failed(message) => domain_error(message),
    })?;
    Ok(Published::one(
        json!({
            "databaseId": result.database_id, "revisions": result.revisions,
            "operationId": request.operation_id, "hasWarnings": !result.warnings.is_empty()
        }),
        path,
    ))
}

pub fn create_relation(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    request: &super::RelationSchema,
) -> Result<Published, &'static str> {
    let source = writable_database(root, scope, &request.database_id)?;
    let target = writable_database(root, scope, &request.target_database_id)?;
    if !matches!(request.max_items, None | Some(1)) {
        return Err("invalidArguments");
    }
    let id = super::operation_id(root, scope, "relation-schema", &request.operation_id)?;
    let result = create_database_property(
        root,
        watcher,
        &CreateDatabasePropertyRequest {
            database_id: request.database_id.clone(),
            expected_manifest_revision: request.expected_revision.clone(),
            name: request.name.clone(),
            property_type: "relation".into(),
            relation_target_database_id: Some(request.target_database_id.clone()),
            relation_max_items: request.max_items,
            relation_two_way: Some(true),
            relation_inverse_property_name: Some(request.inverse_name.clone()),
            operation_id: Some(id),
            expected_target_manifest_revision: Some(request.expected_target_revision.clone()),
            ..Default::default()
        },
    )
    .map_err(domain_error)?;
    let mut changed = vec![source.manifest_path];
    if request.database_id != request.target_database_id {
        changed.push(target.manifest_path);
    }
    Ok(Published {
        output: json!({
            "databaseId":result.database_id, "propertyId":result.property_id,
            "inversePropertyId":result.inverse_property_id, "revisions":result.manifest_revisions,
            "operationId":request.operation_id
        }),
        changed,
        archive_changed: false,
    })
}

pub fn set_relation(
    root: &Path,
    scope: &Path,
    watcher: &SelfWriteTracker,
    request: &super::RelationValue,
    dry_run: bool,
) -> Result<Published, &'static str> {
    writable_database(root, scope, &request.database_id)?;
    if request.target_note_ids.len() > super::MAX_ITEMS {
        return Err("invalidArguments");
    }
    let id = super::operation_id(root, scope, "relation-value", &request.operation_id)?;
    let outcome = crate::database::mutations::update_scoped_relation_value(
        root,
        watcher,
        &crate::database::mutations::UpdateDatabaseRelationValueRequest {
            expected_generation: 0,
            operation_id: id,
            expected_revision: request.expected_revision.clone(),
            database_id: request.database_id.clone(),
            note_id: request.note_id.clone(),
            property_id: request.property_id.clone(),
            target_note_ids: request.target_note_ids.clone(),
        },
        scope,
        dry_run,
    )
    .map_err(domain_error)?;
    let paths = outcome
        .paths
        .iter()
        .map(|path| relative(root, path))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Published {
        output: json!({
            "databaseId":outcome.value.database_id, "noteId":outcome.value.note_id,
            "targetNoteIds":outcome.value.target_note_ids, "affectedNotes":outcome.value.affected_notes,
            "affectedPaths":paths, "revisions":outcome.value.revisions,
            "operationId":request.operation_id, "dryRun":dry_run, "replayed":outcome.replayed,
            "warningCount":outcome.value.warnings.len()
        }),
        changed: if dry_run { Vec::new() } else { outcome.paths },
        archive_changed: false,
    })
}

fn domain_error(message: String) -> &'static str {
    match message.as_str() {
        "outsideWriteScope" => return "outsideWriteScope",
        "accessDenied" => return "accessDenied",
        "invalidRelation" => return "invalidRelation",
        "operationTooLarge" => return "operationTooLarge",
        "tooManyRelationTargets" => return "tooManyRelationTargets",
        "MCP operation ID reused" => return "operationIdReused",
        _ if message.contains("operationId was already used") => return "operationIdReused",
        _ => {}
    }
    match classify(&message) {
        FailureReason::RevisionConflict => "revisionConflict",
        FailureReason::Locked => "locked",
        FailureReason::ReadOnly => "readOnly",
        FailureReason::NotFound => "notFound",
        FailureReason::NameTaken => "mutationConflict",
        FailureReason::InvalidName | FailureReason::InvalidConfig => "invalidArguments",
        FailureReason::InvalidValue => "invalidValue",
        FailureReason::RelationInvalid => "invalidRelation",
        FailureReason::RecoveryRequired => "recoveryRequired",
        FailureReason::RolledBack => "rolledBack",
        _ => "unavailable",
    }
}
