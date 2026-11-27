//! What the interface lists about databases, read from the rebuildable SQLite projection:
//! the database list, the context of a note inside a database, property and option lists, and the
//! two small lookups the refresh commands need. SQL lives here, not in `commands/database.rs`.
//! Every list is best effort: a missing table or row gives an empty list, never a failed command.
use crate::database::discovery::DiscoveryResult;
use crate::database::format::{DatabaseViewFile, FieldRef};
use crate::database::model::{
    DatabaseDiagnostic, DatabaseError, DatabaseFieldRef, DatabaseNoteContext,
    DatabaseOptionSummary, DatabasePropertySummary, DatabaseRow, DatabaseSummary,
    DatabaseTemplateSummary, DatabaseViewSummary,
};
use rusqlite::{Connection, OptionalExtension};

/// The database whose container is `container_path`, if the projection knows it.
pub fn database_id_for_container(
    connection: &Connection,
    container_path: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT database_id FROM db_databases WHERE container_path = ?1",
            [container_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
}

/// The database a note is a member of, if the projection knows it.
pub fn member_database_id(connection: &Connection, note_id: &str) -> Option<String> {
    connection
        .query_row(
            "SELECT database_id FROM db_members WHERE note_id = ?1",
            [note_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

/// One summary per discovered database, with the diagnostics that belong to its container.
pub fn list_database_summaries(
    connection: &Connection,
    discovery: DiscoveryResult,
) -> Vec<DatabaseSummary> {
    let diagnostics = discovery.diagnostics;
    discovery
        .databases
        .into_iter()
        .map(|database| DatabaseSummary {
            database_id: database.database_id.clone(),
            title: database.name,
            icon: database.icon,
            attached_note_id: connection
                .query_row(
                    "SELECT attached_note_id FROM db_databases WHERE database_id = ?1",
                    [database.database_id.as_str()],
                    |row| row.get(0),
                )
                .ok()
                .flatten(),
            manifest_revision: database.revision,
            locked: connection
                .query_row(
                    "SELECT locked FROM db_databases WHERE database_id = ?1",
                    [database.database_id.as_str()],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(database.read_only)
                || std::fs::read(&database.manifest_path)
                    .ok()
                    .and_then(|bytes| crate::database::format::parse_manifest(&bytes).ok())
                    .is_none_or(|manifest| manifest.value.format_version < 2),
            properties: database_properties(connection, &database.database_id),
            views: database_views(connection, &database.database_id),
            templates: database_templates(connection, &database.database_id),
            diagnostics: diagnostics
                .iter()
                .filter(|diagnostic| {
                    diagnostic.path == database.relative_container_path
                        || diagnostic
                            .path
                            .starts_with(&format!("{}/", database.relative_container_path))
                })
                .map(|diagnostic| DatabaseDiagnostic {
                    code: format!("{:?}", diagnostic.code),
                    severity: format!("{:?}", diagnostic.severity),
                    path: diagnostic.path.clone(),
                    message: diagnostic.message.clone(),
                })
                .collect(),
        })
        .collect()
}

fn database_views(connection: &Connection, database_id: &str) -> Vec<DatabaseViewSummary> {
    connection
        .prepare(
            "SELECT view_id, name, layout, revision, query_json FROM db_views WHERE database_id = ?1 ORDER BY position",
        )
        .ok()
        .and_then(|mut statement| {
            statement
                .query_map([database_id], |row| {
                    Ok(DatabaseViewSummary {
                        view_id: row.get(0)?,
                        title: row.get(1)?,
                        layout: row.get(2)?,
                        revision: row.get(3)?,
                        group_field: row
                            .get::<_, String>(4)
                            .ok()
                            .and_then(|json| serde_json::from_str::<DatabaseViewFile>(&json).ok())
                            .and_then(|view| view.group)
                            .and_then(|group| database_field_ref(&group.field)),
                    })
                })
                .ok()
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default()
}

fn database_templates(connection: &Connection, database_id: &str) -> Vec<DatabaseTemplateSummary> {
    connection
        .prepare(
            "SELECT template_id, name, revision FROM db_templates WHERE database_id = ?1 ORDER BY position",
        )
        .ok()
        .and_then(|mut statement| {
            statement
                .query_map([database_id], |row| {
                    Ok(DatabaseTemplateSummary {
                        template_id: row.get(0)?,
                        name: row.get(1)?,
                        revision: row.get(2)?,
                    })
                })
                .ok()
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default()
}

/// The database a note belongs to, its properties and the note's own row; `None` for a note that
/// is not a member of any database.
pub fn database_note_context(
    connection: &Connection,
    vault_generation: u64,
    note_id: &str,
) -> Result<Option<DatabaseNoteContext>, DatabaseError> {
    let failed = |error: rusqlite::Error| {
        DatabaseError::failed("databaseNoteContextFailed", error.to_string())
    };
    let row = connection
        .query_row(
            "SELECT m.database_id, d.name, d.icon, d.manifest_revision, d.locked, m.note_id, n.title, m.relative_path, m.parent_note_id, m.depth, m.category_path, COALESCE(r.revision, '') FROM db_members m JOIN db_databases d ON d.database_id = m.database_id JOIN notes n ON n.id = m.note_id LEFT JOIN db_record_revisions r ON r.database_id = m.database_id AND r.note_id = m.note_id WHERE m.note_id = ?1",
            [note_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?.max(0) as usize,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    let Some((
        database_id,
        database_title,
        database_icon,
        manifest_revision,
        locked,
        note_id,
        title,
        relative_path,
        parent_note_id,
        depth,
        category_path,
        row_revision,
    )) = row
    else {
        return Ok(None);
    };
    let mut statement = connection
        .prepare("SELECT property_id, canonical_json FROM db_values WHERE database_id = ?1 AND note_id = ?2 ORDER BY property_id")
        .map_err(failed)?;
    let values = statement
        .query_map([database_id.as_str(), note_id.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?
        .filter_map(Result::ok)
        .fold(
            serde_json::Map::new(),
            |mut values, (property_id, value)| {
                values.insert(
                    property_id,
                    serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value)),
                );
                values
            },
        );
    let values_json = serde_json::to_string(&values)
        .map_err(|error| DatabaseError::failed("databaseNoteContextFailed", error.to_string()))?;
    Ok(Some(DatabaseNoteContext {
        vault_generation,
        properties: database_properties(connection, &database_id),
        database_id,
        database_title,
        database_icon,
        manifest_revision,
        locked,
        row: DatabaseRow {
            note_id,
            title,
            relative_path,
            parent_note_id,
            depth,
            category_path: serde_json::from_str(&category_path).unwrap_or_default(),
            values_json,
            row_revision,
        },
    }))
}

pub fn database_properties(
    connection: &Connection,
    database_id: &str,
) -> Vec<DatabasePropertySummary> {
    let Ok(mut statement) = connection.prepare(
        "SELECT property_id, name, property_type, config_json FROM db_properties WHERE database_id = ?1 ORDER BY position",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([database_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(
            |(property_id, name, property_type, config_json)| DatabasePropertySummary {
                options: database_options(connection, database_id, &property_id),
                property_id,
                name,
                property_type,
                config_json,
            },
        )
        .collect()
}

fn database_options(
    connection: &Connection,
    database_id: &str,
    property_id: &str,
) -> Vec<DatabaseOptionSummary> {
    let Ok(mut statement) = connection.prepare(
        "SELECT option_id, name, color FROM db_options WHERE database_id = ?1 AND property_id = ?2 ORDER BY position",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([database_id, property_id], |row| {
        Ok(DatabaseOptionSummary {
            option_id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn database_field_ref(field: &FieldRef) -> Option<DatabaseFieldRef> {
    match field {
        FieldRef::System { field, .. } => Some(DatabaseFieldRef::System {
            field: field.clone(),
        }),
        FieldRef::Property { property_id, .. } => Some(DatabaseFieldRef::Property {
            property_id: property_id.clone(),
        }),
        FieldRef::Opaque(_) => None,
    }
}
