//! Rebuildable SQLite projection of creative workshops and stories.
//!
//! The structure files are the only source of truth. Sections are matched to
//! databases at read time through `db_databases`, so a database that moved or
//! was renamed is reflected without rewriting any cache row.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use ulid::Ulid;

use super::discovery::{discover_projects, WorkshopDiscovery};
use super::model::{
    ProjectCatalog, ProjectDiagnostic, ProjectTextSummary, SectionState, StorySummary,
    TextEntryState, TextFormatSummary, TextLevelSummary, TextPropertyIds, TextStatusOptionSummary,
    WorkshopSectionSummary, WorkshopSummary,
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

/// Replaces the whole workshop projection from the current files. Returns the
/// new epoch. One transaction: readers see the old or the new catalog, never a mix.
pub fn rebuild_project_index(conn: &Connection, vault: &Path) -> Result<String, String> {
    init_schema(conn)?;
    let discovery = discover_projects(vault)?;
    publish(conn, &discovery)
}

fn publish(conn: &Connection, discovery: &WorkshopDiscovery) -> Result<String, String> {
    let epoch = Ulid::generate().to_string();
    let tx = conn.unchecked_transaction().map_err(sql_error)?;
    for table in [
        "project_diagnostics",
        "project_stories",
        "project_sections",
        "project_workshops",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(sql_error)?;
    }
    for (pos, workshop) in discovery.workshops.iter().enumerate() {
        let doc = &workshop.doc;
        tx.execute(
            "INSERT INTO project_workshops (workshop_id, path, name, icon, tags_json, file_revision, format_version, read_only, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                doc.workshop_id,
                workshop.path,
                doc.name,
                doc.icon,
                serde_json::to_string(&doc.tags).map_err(|error| error.to_string())?,
                doc.revision,
                doc.format_version as i64,
                !doc.is_known_version(),
                pos as i64,
            ],
        )
        .map_err(sql_error)?;

        for (s_idx, section) in doc.sections.iter().enumerate() {
            tx.execute(
                "INSERT INTO project_sections (workshop_id, section_id, position, role, name, database_id, path_hint, stories_property_id, universe_property_id, arcs_property_id, characters_property_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    doc.workshop_id,
                    section.id,
                    s_idx as i64,
                    section.role,
                    section.name,
                    section.database_id,
                    section.path,
                    section.stories_property_id,
                    section.universe_property_id,
                    section.arcs_property_id,
                    section.characters_property_id,
                ],
            )
            .map_err(sql_error)?;
        }

        for (st_idx, story) in workshop.stories.iter().enumerate() {
            tx.execute(
                "INSERT INTO project_stories (story_id, workshop_id, name, folder_path, card_path, card_note_id, database_id, file_revision, text_json, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    story.story_id,
                    doc.workshop_id,
                    story.name,
                    story.folder_path,
                    story.card_path,
                    story.card_note_id,
                    story.database_id,
                    story.file_revision,
                    story.text_json.as_deref().unwrap_or("{}"),
                    st_idx as i64,
                ],
            )
            .map_err(sql_error)?;
        }
    }

    for (position, entry) in discovery.diagnostics.iter().enumerate() {
        tx.execute(
            "INSERT INTO project_diagnostics (position, code, severity, path, workshop_id, story_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                position as i64,
                entry.code,
                entry.severity,
                entry.path,
                entry.workshop_id,
                entry.story_id,
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

fn status_options_of(
    conn: &Connection,
    database_id: &str,
    property_id: &str,
) -> Result<Vec<TextStatusOptionSummary>, String> {
    let mut statement = conn
        .prepare(
            "SELECT option_id, name, color, status_group FROM db_options WHERE database_id = ?1 AND property_id = ?2 ORDER BY position",
        )
        .map_err(sql_error)?;
    let rows = statement
        .query_map(params![database_id, property_id], |row| {
            let group: Option<String> = row.get(3)?;
            Ok(TextStatusOptionSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                group: group.unwrap_or_else(|| "notStarted".to_owned()),
            })
        })
        .map_err(sql_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)
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

/// Compares the `text` block with the story's text database.
fn resolve_text(
    conn: &Connection,
    database_id: Option<&str>,
    story_path: &str,
    text_json: Option<&str>,
    diagnostics: &mut Vec<ProjectDiagnostic>,
) -> Result<Option<ProjectTextSummary>, String> {
    let Some(block) =
        text_json.and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
    else {
        return Ok(None);
    };

    let mut properties = TextPropertyIds::default();

    let Some(database_id) = database_id else {
        let mut levels = Vec::new();
        for entry in block
            .get("levels")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = entry.get("id").and_then(serde_json::Value::as_str) {
                levels.push(TextLevelSummary {
                    id: id.to_owned(),
                    icon: entry
                        .get("icon")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                    name: None,
                    color: None,
                    state: TextEntryState::Unresolved,
                });
            }
        }
        let mut formats = Vec::new();
        for entry in block
            .get("formats")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(id), Some(kind)) = (
                entry.get("id").and_then(serde_json::Value::as_str),
                entry.get("kind").and_then(serde_json::Value::as_str),
            ) {
                formats.push(TextFormatSummary {
                    id: id.to_owned(),
                    kind: kind.to_owned(),
                    name: None,
                    color: None,
                    state: TextEntryState::Unresolved,
                });
            }
        }
        return Ok(Some(ProjectTextSummary {
            database_id: None,
            properties,
            levels,
            formats,
            status_options: Vec::new(),
        }));
    };

    let diagnose = |code: &str, detail: String, diagnostics: &mut Vec<ProjectDiagnostic>| {
        diagnostics.push(ProjectDiagnostic {
            code: code.to_owned(),
            severity: "warning".to_owned(),
            path: story_path.to_owned(),
            workshop_id: None,
            story_id: None,
            detail: Some(detail),
        });
    };

    let declared = |key: &str| -> Option<String> {
        block
            .pointer(&format!("/properties/{key}"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };

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
        if property_exists(conn, database_id, &id)? {
            *slot = Some(id);
        } else {
            diagnose("missingTextProperty", key.to_owned(), diagnostics);
        }
    }

    let mut status_options = Vec::new();
    if let Some(id) = declared("status") {
        if property_exists(conn, database_id, &id)? {
            status_options = status_options_of(conn, database_id, &id)?;
            properties.status = Some(id);
        } else {
            diagnose("missingTextProperty", "status".to_owned(), diagnostics);
        }
    }

    for (key, slot) in [
        ("anchors", &mut properties.anchors),
        ("arcs", &mut properties.arcs),
    ] {
        if let Some(id) = declared(key) {
            if property_exists(conn, database_id, &id)? {
                *slot = Some(id);
            }
        }
    }

    let state_of =
        |entry: Option<(String, String)>| -> (TextEntryState, Option<String>, Option<String>) {
            match entry {
                Some((name, color)) => (TextEntryState::Ok, Some(name), Some(color)),
                None => (TextEntryState::Dangling, None, None),
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
        let found = match &properties.level {
            Some(property) => option_of(conn, database_id, property, id)?,
            None => None,
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
        let found = match &properties.format {
            Some(property) => option_of(conn, database_id, property, id)?,
            None => None,
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
        database_id: Some(database_id.to_owned()),
        properties,
        levels,
        formats,
        status_options,
    }))
}

/// Reads the catalog from the projection.
pub fn load_catalog(
    conn: &Connection,
    vault: &Path,
    vault_generation: u64,
) -> Result<ProjectCatalog, String> {
    if !is_built(conn)? {
        rebuild_project_index(conn, vault)?;
    }
    let index_epoch = metadata(conn, EPOCH_KEY)?.unwrap_or_default();

    let mut section_stmt = conn
        .prepare(
            "SELECT s.section_id, s.role, s.name, s.database_id, s.path_hint, d.container_path, d.name,
                    s.stories_property_id, s.universe_property_id, s.arcs_property_id, s.characters_property_id
             FROM project_sections s
             LEFT JOIN db_databases d ON d.database_id = s.database_id
             WHERE s.workshop_id = ?1
             ORDER BY s.position",
        )
        .map_err(sql_error)?;

    let mut story_stmt = conn
        .prepare(
            "SELECT story_id, workshop_id, name, folder_path, card_path, card_note_id, database_id, file_revision, text_json
             FROM project_stories
             WHERE workshop_id = ?1
             ORDER BY position",
        )
        .map_err(sql_error)?;

    let mut workshop_stmt = conn
        .prepare(
            "SELECT workshop_id, path, name, icon, tags_json, file_revision, format_version, read_only
             FROM project_workshops ORDER BY position",
        )
        .map_err(sql_error)?;

    let workshop_rows = workshop_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, bool>(7)?,
            ))
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;

    let mut workshops = Vec::with_capacity(workshop_rows.len());
    let mut text_diagnostics = Vec::new();

    for (workshop_id, path, name, icon, tags_json, file_revision, format_version, read_only) in
        workshop_rows
    {
        let sections = section_stmt
            .query_map([workshop_id.as_str()], |row| {
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
                Ok(WorkshopSectionSummary {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    name: row.get(2)?,
                    database_id: row.get(3)?,
                    path_hint,
                    stories_property_id: row.get(7)?,
                    universe_property_id: row.get(8)?,
                    arcs_property_id: row.get(9)?,
                    characters_property_id: row.get(10)?,
                    state,
                    resolved_path: resolved,
                    database_name: row.get(6)?,
                })
            })
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?;

        let story_rows = story_stmt
            .query_map([workshop_id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            })
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?;

        let mut stories = Vec::with_capacity(story_rows.len());
        for (
            story_id,
            workshop_id,
            st_name,
            folder_path,
            card_path,
            card_note_id,
            database_id,
            story_revision,
            text_json,
        ) in story_rows
        {
            let text = resolve_text(
                conn,
                database_id.as_deref(),
                &card_path,
                Some(&text_json),
                &mut text_diagnostics,
            )?;
            stories.push(StorySummary {
                story_id,
                workshop_id,
                name: st_name,
                folder_path,
                card_path,
                card_note_id,
                database_id,
                file_revision: story_revision,
                format_version: 3,
                text_json: Some(text_json),
                text,
            });
        }

        workshops.push(WorkshopSummary {
            workshop_id,
            name,
            icon,
            tags: parse_list(&tags_json),
            path,
            file_revision,
            format_version: format_version as u64,
            read_only,
            sections,
            stories,
        });
    }

    let mut diagnostics = conn
        .prepare(
            "SELECT code, severity, path, workshop_id, story_id, detail FROM project_diagnostics ORDER BY position",
        )
        .map_err(sql_error)?
        .query_map([], |row| {
            Ok(ProjectDiagnostic {
                code: row.get(0)?,
                severity: row.get(1)?,
                path: row.get(2)?,
                workshop_id: row.get(3)?,
                story_id: row.get(4)?,
                detail: row.get(5)?,
            })
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;

    diagnostics.extend(text_diagnostics);

    Ok(ProjectCatalog {
        vault_generation,
        index_epoch,
        workshops,
        diagnostics,
    })
}
