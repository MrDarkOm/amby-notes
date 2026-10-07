//! Rebuildable SQLite projection of creative projects.
//!
//! The structure files are the only source of truth. Sections are matched to
//! databases at read time through `db_databases`, so a database that moved or
//! was renamed is reflected without rewriting any project cache row.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use ulid::Ulid;

use super::discovery::{discover_projects, ProjectDiscovery};
use super::model::{
    ProjectCatalog, ProjectDiagnostic, ProjectGroupSummary, ProjectKind, ProjectSectionSummary,
    ProjectSummary, ProjectTextSummary, SectionState, TextEntryState, TextFormatSummary,
    TextLevelSummary, TextPropertyIds, PROJECT_FILE_NAME, ROLE_TEXT,
};
use crate::index::schema::init_schema;

const EPOCH_KEY: &str = "project_index_epoch";

fn sql_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn metadata(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM index_metadata WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(sql_error)
}

/// Replaces the whole project projection from the current files. Returns the
/// new epoch. One transaction: readers see the old or the new catalog, never a mix.
pub fn rebuild_project_index(conn: &Connection, vault: &Path) -> Result<String, String> {
    init_schema(conn)?;
    let discovery = discover_projects(vault)?;
    publish(conn, &discovery)
}

fn publish(conn: &Connection, discovery: &ProjectDiscovery) -> Result<String, String> {
    let epoch = Ulid::generate().to_string();
    let tx = conn.unchecked_transaction().map_err(sql_error)?;
    for table in [
        "project_sections",
        "project_projects",
        "project_diagnostics",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(sql_error)?;
    }
    for (position, project) in discovery.projects.iter().enumerate() {
        let doc = &project.doc;
        let groups = serde_json::to_string(
            &doc.groups
                .iter()
                .map(|group| serde_json::json!({"id": group.id, "name": group.name}))
                .collect::<Vec<_>>(),
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO project_projects (project_id, path, kind, name, icon, tags_json, groups_json, text_json, file_revision, format_version, read_only, collection_id, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                doc.project_id,
                project.path,
                doc.kind.as_str(),
                doc.name,
                doc.icon,
                serde_json::to_string(&doc.tags).map_err(|error| error.to_string())?,
                groups,
                doc.text_json,
                doc.revision,
                doc.format_version as i64,
                !doc.is_known_version(),
                project.collection_id,
                position as i64,
            ],
        )
        .map_err(sql_error)?;
        for (index, section) in doc.sections.iter().enumerate() {
            tx.execute(
                "INSERT INTO project_sections (project_id, section_id, position, role, group_id, database_id, path_hint) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    doc.project_id,
                    section.id,
                    index as i64,
                    section.role,
                    section.group_id,
                    section.database_id,
                    section.path_hint,
                ],
            )
            .map_err(sql_error)?;
        }
    }
    for (position, entry) in discovery.diagnostics.iter().enumerate() {
        tx.execute(
            "INSERT INTO project_diagnostics (position, code, severity, path, project_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                position as i64,
                entry.code,
                entry.severity,
                entry.path,
                entry.project_id,
                entry.detail,
            ],
        )
        .map_err(sql_error)?;
    }
    tx.execute(
        "INSERT INTO index_metadata (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![EPOCH_KEY, epoch],
    )
    .map_err(sql_error)?;
    tx.commit().map_err(sql_error)?;
    Ok(epoch)
}

/// True once the projection was published for this index file at least once.
pub fn is_built(conn: &Connection) -> Result<bool, String> {
    init_schema(conn)?;
    Ok(metadata(conn, EPOCH_KEY)?.is_some())
}

fn parse_list<T: serde::de::DeserializeOwned>(json: &str) -> Vec<T> {
    serde_json::from_str(json).unwrap_or_default()
}

fn option_of(
    conn: &Connection,
    database_id: &str,
    property_id: &str,
    option_id: &str,
) -> Result<Option<(String, String)>, String> {
    conn.query_row(
        "SELECT name, color FROM db_options WHERE database_id = ?1 AND property_id = ?2 AND option_id = ?3",
        params![database_id, property_id, option_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(sql_error)
}

fn property_exists(
    conn: &Connection,
    database_id: &str,
    property_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM db_properties WHERE database_id = ?1 AND property_id = ?2",
        params![database_id, property_id],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(sql_error)
}

/// Compares the `text` block with the text database. A level or format whose option is gone
/// is dangling: it stays in the file and is reported, never repaired here.
fn resolve_text(
    conn: &Connection,
    project: &str,
    path: &str,
    sections: &[ProjectSectionSummary],
    text_json: Option<&str>,
    diagnostics: &mut Vec<ProjectDiagnostic>,
) -> Result<Option<ProjectTextSummary>, String> {
    let Some(block) =
        text_json.and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
    else {
        return Ok(None);
    };
    let file = if path.is_empty() {
        PROJECT_FILE_NAME.to_owned()
    } else {
        format!("{path}/{PROJECT_FILE_NAME}")
    };
    let diagnose = |code: &str, detail: String, diagnostics: &mut Vec<ProjectDiagnostic>| {
        diagnostics.push(ProjectDiagnostic {
            code: code.to_owned(),
            severity: "warning".to_owned(),
            path: file.clone(),
            project_id: Some(project.to_owned()),
            detail: Some(detail),
        });
    };
    // Resolved only when the text database was found.
    let database_id = sections
        .iter()
        .find(|section| {
            section.role.as_deref() == Some(ROLE_TEXT) && section.state != SectionState::Missing
        })
        .map(|section| section.database_id.clone());

    let declared = |key: &str| -> Option<String> {
        block
            .pointer(&format!("/properties/{key}"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let mut properties = TextPropertyIds::default();
    for (key, slot) in [
        ("level", &mut properties.level),
        ("parent", &mut properties.parent),
        ("order", &mut properties.order),
        ("format", &mut properties.format),
    ] {
        let Some(id) = declared(key) else {
            diagnose("missingTextProperty", key.to_owned(), diagnostics);
            continue;
        };
        match &database_id {
            Some(database) if property_exists(conn, database, &id)? => *slot = Some(id),
            Some(_) => diagnose("missingTextProperty", key.to_owned(), diagnostics),
            None => {}
        }
    }

    let state_of =
        |entry: Option<(String, String)>| -> (TextEntryState, Option<String>, Option<String>) {
            match (&database_id, entry) {
                (None, _) => (TextEntryState::Unresolved, None, None),
                (Some(_), Some((name, color))) => (TextEntryState::Ok, Some(name), Some(color)),
                (Some(_), None) => (TextEntryState::Dangling, None, None),
            }
        };

    let mut levels = Vec::new();
    for entry in block
        .get("levels")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = entry.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let found = match (&database_id, &properties.level) {
            (Some(database), Some(property)) => option_of(conn, database, property, id)?,
            _ => None,
        };
        let (state, name, color) = state_of(found);
        if state == TextEntryState::Dangling {
            diagnose("danglingTextLevel", id.to_owned(), diagnostics);
        }
        levels.push(TextLevelSummary {
            id: id.to_owned(),
            icon: entry
                .get("icon")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            name,
            color,
            state,
        });
    }
    let mut formats = Vec::new();
    for entry in block
        .get("formats")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(id), Some(kind)) = (
            entry.get("id").and_then(serde_json::Value::as_str),
            entry.get("kind").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        let found = match (&database_id, &properties.format) {
            (Some(database), Some(property)) => option_of(conn, database, property, id)?,
            _ => None,
        };
        let (state, name, color) = state_of(found);
        if state == TextEntryState::Dangling {
            diagnose("danglingTextFormat", id.to_owned(), diagnostics);
        }
        formats.push(TextFormatSummary {
            id: id.to_owned(),
            kind: kind.to_owned(),
            name,
            color,
            state,
        });
    }
    Ok(Some(ProjectTextSummary {
        database_id,
        properties,
        levels,
        formats,
    }))
}

/// Reads the catalog from the projection, building it first when the index has
/// never held one.
pub fn load_catalog(
    conn: &Connection,
    vault: &Path,
    vault_generation: u64,
) -> Result<ProjectCatalog, String> {
    if !is_built(conn)? {
        rebuild_project_index(conn, vault)?;
    }
    let index_epoch = metadata(conn, EPOCH_KEY)?.unwrap_or_default();

    let mut section_statement = conn
        .prepare(
            "SELECT s.section_id, s.role, s.group_id, s.database_id, s.path_hint, d.container_path, d.name
             FROM project_sections s
             LEFT JOIN db_databases d ON d.database_id = s.database_id
             WHERE s.project_id = ?1
             ORDER BY s.position",
        )
        .map_err(sql_error)?;
    let mut project_statement = conn
        .prepare(
            "SELECT project_id, path, kind, name, icon, tags_json, groups_json, text_json, file_revision, format_version, read_only, collection_id
             FROM project_projects ORDER BY position",
        )
        .map_err(sql_error)?;
    let rows = project_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, bool>(10)?,
                row.get::<_, Option<String>>(11)?,
            ))
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;

    let mut projects = Vec::with_capacity(rows.len());
    let mut text_diagnostics = Vec::new();
    for (
        project_id,
        path,
        kind,
        name,
        icon,
        tags_json,
        groups_json,
        text_json,
        file_revision,
        format_version,
        read_only,
        collection_id,
    ) in rows
    {
        let Some(kind) = ProjectKind::parse(&kind) else {
            continue;
        };
        let sections = section_statement
            .query_map([project_id.as_str()], |row| {
                let path_hint: String = row.get(4)?;
                let resolved: Option<String> = row.get(5)?;
                let state = match &resolved {
                    None => SectionState::Missing,
                    Some(found) => {
                        let expected = if path.is_empty() {
                            path_hint.clone()
                        } else {
                            format!("{path}/{path_hint}")
                        };
                        if path_hint.is_empty() || *found == expected {
                            SectionState::Ok
                        } else {
                            SectionState::Moved
                        }
                    }
                };
                Ok(ProjectSectionSummary {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    group_id: row.get(2)?,
                    database_id: row.get(3)?,
                    path_hint,
                    state,
                    resolved_path: resolved,
                    database_name: row.get(6)?,
                })
            })
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?;
        let groups: Vec<serde_json::Value> = parse_list(&groups_json);
        let text = resolve_text(
            conn,
            &project_id,
            &path,
            &sections,
            text_json.as_deref(),
            &mut text_diagnostics,
        )?;
        projects.push(ProjectSummary {
            project_id,
            kind,
            name,
            icon,
            tags: parse_list(&tags_json),
            path,
            file_revision,
            format_version: format_version as u64,
            read_only,
            collection_id,
            groups: groups
                .iter()
                .filter_map(|group| {
                    Some(ProjectGroupSummary {
                        id: group.get("id")?.as_str()?.to_owned(),
                        name: group.get("name")?.as_str()?.to_owned(),
                    })
                })
                .collect(),
            sections,
            text_json,
            text,
        });
    }

    let diagnostics = conn
        .prepare(
            "SELECT code, severity, path, project_id, detail FROM project_diagnostics ORDER BY position",
        )
        .map_err(sql_error)?
        .query_map([], |row| {
            Ok(ProjectDiagnostic {
                code: row.get(0)?,
                severity: row.get(1)?,
                path: row.get(2)?,
                project_id: row.get(3)?,
                detail: row.get(4)?,
            })
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;

    let mut diagnostics = diagnostics;
    diagnostics.extend(text_diagnostics);
    Ok(ProjectCatalog {
        vault_generation,
        index_epoch,
        projects,
        diagnostics,
    })
}
