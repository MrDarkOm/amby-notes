//! Pages of a story's text: creating one with its level, format, parent and place, and
//! moving one, as single writes into the text database.
//!
//! The text database is an ordinary database. A page is a note whose frontmatter holds the
//! values of the system properties named by `text.properties`; nothing here keeps a
//! second copy of the tree. A move rewrites only the moved page (parent and order in one
//! write). Cycles are refused before the write.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::create::Env;
use super::discovery::discover_projects;
use super::format::parse_story_file;
use super::model::{
    CreateTextPageRequest, CreatedTextPage, MoveTextPageRequest, MovedTextPage, ProjectError,
    STORY_FILE_NAME,
};
use crate::database::format::{parse_manifest, DatabaseManifest, PropertyValue};
use crate::database::history::DatabaseHistoryState;
use crate::database::mutations::{
    apply_value_batch_typed, find_database_container, DatabaseValueBatchRequest,
    DatabaseValueMutation, ValueBatchError,
};
use crate::database::rows::{
    create_database_row_with_values, CreateDatabaseRowRequest, DatabaseRowTemplate,
};
use crate::durable::valid_operation_id;

/// The text database of a story with the IDs its `text` block names, checked against the
/// manifest as it is on disk.
struct TextTarget {
    database_id: String,
    manifest: DatabaseManifest,
    level: String,
    parent: String,
    order: String,
    format: String,
    level_ids: Vec<String>,
    /// `(option id, kind)` in file order.
    formats: Vec<(String, String)>,
}

fn broken(detail: impl Into<String>) -> ProjectError {
    ProjectError::failed("textSchemaBroken", detail)
}

fn option_exists(manifest: &DatabaseManifest, property_id: &str, option_id: &str) -> bool {
    manifest
        .properties
        .iter()
        .find(|property| property.id() == Some(property_id))
        .is_some_and(|property| property.find_option_name(option_id).is_some())
}

fn resolve(env: &Env, story_id: &str) -> Result<TextTarget, ProjectError> {
    let discovery = discover_projects(env.vault)
        .map_err(|message| ProjectError::failed("discoveryFailed", message))?;

    let mut found_story = None;
    for workshop in &discovery.workshops {
        for story in &workshop.stories {
            if story.story_id == story_id {
                found_story = Some(story.clone());
                break;
            }
        }
        if found_story.is_some() {
            break;
        }
    }

    let story = found_story.ok_or_else(|| ProjectError::StoryNotFound {
        story_id: story_id.to_owned(),
    })?;

    let story_folder = env.vault.join(&story.folder_path);
    let story_file = story_folder.join(STORY_FILE_NAME);
    let story_bytes = std::fs::read(&story_file)
        .map_err(|error| ProjectError::failed("readStoryFile", error.to_string()))?;
    let story_doc = parse_story_file(&story_bytes)
        .map_err(|problem| ProjectError::failed("storyFormat", problem.detail))?;

    if !story_doc.is_known_version() {
        return Err(ProjectError::StoryReadOnly {
            format_version: story_doc.format_version,
        });
    }

    let block = story_doc
        .raw
        .get("text")
        .ok_or(ProjectError::TextNotConfigured)?;
    let database_id = story.database_id.ok_or(ProjectError::TextNotConfigured)?;
    let container = find_database_container(env.vault, &database_id)
        .map_err(|_| ProjectError::TextNotConfigured)?;
    let manifest_path = crate::database::discovery::manifest_path_for_container(&container);
    let bytes = std::fs::read(&manifest_path)
        .map_err(|error| ProjectError::failed("readManifest", error.to_string()))?;
    let manifest = parse_manifest(&bytes)
        .map_err(|error| broken(error.to_string()))?
        .value;

    let property = |key: &str| -> Result<String, ProjectError> {
        let id = block
            .pointer(&format!("/properties/{key}"))
            .and_then(Value::as_str)
            .ok_or_else(|| broken(format!("text.properties.{key} is missing")))?;
        if manifest
            .properties
            .iter()
            .any(|candidate| candidate.id() == Some(id))
        {
            Ok(id.to_owned())
        } else {
            Err(broken(format!("the {key} property was deleted")))
        }
    };

    let level = property("level")?;
    let parent = property("parent")?;
    let order = property("order")?;
    let format = property("format")?;
    let ids = |key: &str| -> Vec<(String, Option<String>)> {
        block
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                Some((
                    entry.get("id")?.as_str()?.to_owned(),
                    entry.get("kind").and_then(Value::as_str).map(str::to_owned),
                ))
            })
            .collect()
    };

    Ok(TextTarget {
        database_id,
        level_ids: ids("levels").into_iter().map(|(id, _)| id).collect(),
        formats: ids("formats")
            .into_iter()
            .filter_map(|(id, kind)| Some((id, kind?)))
            .collect(),
        manifest,
        level,
        parent,
        order,
        format,
    })
}

/// 1-64 characters of `0-9A-Za-z`, so keys compare the same bytewise and as text.
pub fn valid_order_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn note_belongs_to_database(
    connection: &Connection,
    database_id: &str,
    note_id: &str,
) -> Result<bool, ProjectError> {
    connection
        .query_row(
            "SELECT 1 FROM db_members WHERE database_id = ?1 AND note_id = ?2",
            params![database_id, note_id],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
        .map_err(|error| ProjectError::failed("projectIndexFailed", error.to_string()))
}

fn level_of(
    connection: &Connection,
    database_id: &str,
    level_property_id: &str,
    note_id: &str,
) -> Result<Option<String>, ProjectError> {
    connection
        .query_row(
            "SELECT option_id FROM db_values WHERE database_id = ?1 AND property_id = ?2 AND note_id = ?3",
            params![database_id, level_property_id, note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| ProjectError::failed("projectIndexFailed", error.to_string()))
}

fn check_parent_level(
    levels: &[String],
    parent_level: Option<&str>,
    page_level: &str,
) -> Result<(), ProjectError> {
    let Some(parent_level) = parent_level else {
        return Ok(());
    };
    let parent_depth = levels
        .iter()
        .position(|id| id == parent_level)
        .ok_or_else(|| ProjectError::UnknownTextLevel {
            level_id: parent_level.to_owned(),
        })?;
    let page_depth = levels
        .iter()
        .position(|id| id == page_level)
        .ok_or_else(|| ProjectError::UnknownTextLevel {
            level_id: page_level.to_owned(),
        })?;
    if parent_depth >= page_depth {
        return Err(ProjectError::ParentLevelNotShallower {
            parent_level_id: parent_level.to_owned(),
            level_id: page_level.to_owned(),
        });
    }
    Ok(())
}

pub fn create_page(
    env: &Env,
    connection: &Connection,
    request: &CreateTextPageRequest,
) -> Result<CreatedTextPage, ProjectError> {
    if !valid_order_key(&request.order_key) {
        return Err(ProjectError::InvalidOrderKey);
    }
    let target = resolve(env, &request.story_id)?;
    if !target.level_ids.contains(&request.level_id)
        || !option_exists(&target.manifest, &target.level, &request.level_id)
    {
        return Err(ProjectError::UnknownTextLevel {
            level_id: request.level_id.clone(),
        });
    }
    let chosen_format = match &request.format_id {
        Some(id) => {
            if !target.formats.iter().any(|(option, _)| option == id)
                || !option_exists(&target.manifest, &target.format, id)
            {
                return Err(ProjectError::UnknownTextFormat {
                    format_id: id.clone(),
                });
            }
            Some(id.clone())
        }
        None => target
            .formats
            .iter()
            .find(|(_, kind)| kind == "manuscript")
            .map(|(id, _)| id.clone())
            .or_else(|| target.formats.first().map(|(id, _)| id.clone())),
    };

    if let Some(parent) = &request.parent_note_id {
        if !note_belongs_to_database(connection, &target.database_id, parent)? {
            return Err(ProjectError::PageNotFound {
                note_id: parent.clone(),
            });
        }
        let parent_level = level_of(connection, &target.database_id, &target.level, parent)?;
        check_parent_level(
            &target.level_ids,
            parent_level.as_deref(),
            &request.level_id,
        )?;
    }

    let mut values = BTreeMap::new();
    values.insert(
        target.level.clone(),
        PropertyValue::Select {
            option_id: request.level_id.clone(),
            extra: BTreeMap::new(),
        },
    );
    values.insert(
        target.order.clone(),
        PropertyValue::Text {
            value: request.order_key.clone(),
            extra: BTreeMap::new(),
        },
    );
    if let Some(parent) = &request.parent_note_id {
        values.insert(
            target.parent.clone(),
            PropertyValue::Relation {
                target_note_ids: vec![parent.clone()],
                extra: BTreeMap::new(),
            },
        );
    }
    if let Some(format_id) = &chosen_format {
        values.insert(
            target.format.clone(),
            PropertyValue::Select {
                option_id: format_id.clone(),
                extra: BTreeMap::new(),
            },
        );
    }

    let created = create_database_row_with_values(
        env.vault,
        env.watcher,
        &CreateDatabaseRowRequest {
            expected_generation: 0,
            database_id: target.database_id.clone(),
            title: request.title.clone(),
            template: DatabaseRowTemplate::Empty,
        },
        &values,
    )
    .map_err(|error| ProjectError::failed("createPageFailed", error.to_string()))?;

    Ok(CreatedTextPage {
        database_id: target.database_id,
        note_id: created.note_id,
        title: created.title,
        note_path: created.note_path,
        level_id: request.level_id.clone(),
        format_id: chosen_format,
        parent_note_id: request.parent_note_id.clone(),
        order_key: request.order_key.clone(),
        warnings: created.warnings,
    })
}

fn load_parent_edges(
    connection: &Connection,
    database_id: &str,
    parent_property_id: &str,
) -> Result<BTreeMap<String, String>, ProjectError> {
    let mut statement = connection
        .prepare(
            "SELECT source_note_id, target_note_id FROM db_relation_edges WHERE source_database_id = ?1 AND property_id = ?2",
        )
        .map_err(|error| ProjectError::failed("projectIndexFailed", error.to_string()))?;
    let rows = statement
        .query_map(params![database_id, parent_property_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| ProjectError::failed("projectIndexFailed", error.to_string()))?;
    let mut map = BTreeMap::new();
    for row in rows {
        let (source, target) =
            row.map_err(|error| ProjectError::failed("projectIndexFailed", error.to_string()))?;
        map.insert(source, target);
    }
    Ok(map)
}

fn causes_cycle(
    parents: &BTreeMap<String, String>,
    page_id: &str,
    new_parent_id: Option<&str>,
) -> bool {
    let mut current = match new_parent_id {
        Some(parent) => parent,
        None => return false,
    };
    let mut seen = std::collections::HashSet::new();
    seen.insert(current);
    loop {
        if current == page_id {
            return true;
        }
        match parents.get(current) {
            Some(next) => {
                if !seen.insert(next.as_str()) {
                    return false;
                }
                current = next;
            }
            None => return false,
        }
    }
}

pub fn move_page(
    env: &Env,
    connection: &Connection,
    history: Option<&DatabaseHistoryState>,
    request: &MoveTextPageRequest,
) -> Result<MovedTextPage, ProjectError> {
    if !valid_operation_id(&request.operation_id) {
        return Err(ProjectError::InvalidOperationId);
    }
    if !valid_order_key(&request.order_key) {
        return Err(ProjectError::InvalidOrderKey);
    }
    let target = resolve(env, &request.story_id)?;
    if !note_belongs_to_database(connection, &target.database_id, &request.note_id)? {
        return Err(ProjectError::PageNotFound {
            note_id: request.note_id.clone(),
        });
    }
    let page_level = level_of(
        connection,
        &target.database_id,
        &target.level,
        &request.note_id,
    )?
    .ok_or_else(|| broken("the page has no level assigned"))?;

    let edges = load_parent_edges(connection, &target.database_id, &target.parent)?;
    if causes_cycle(
        &edges,
        &request.note_id,
        request.new_parent_note_id.as_deref(),
    ) {
        return Err(ProjectError::ParentCycle);
    }

    if let Some(parent) = &request.new_parent_note_id {
        if parent == &request.note_id {
            return Err(ProjectError::ParentCycle);
        }
        if !note_belongs_to_database(connection, &target.database_id, parent)? {
            return Err(ProjectError::PageNotFound {
                note_id: parent.clone(),
            });
        }
        let parent_level = level_of(connection, &target.database_id, &target.level, parent)?;
        check_parent_level(&target.level_ids, parent_level.as_deref(), &page_level)?;
    }

    let parent_json = match &request.new_parent_note_id {
        Some(parent) => Some(
            serde_json::to_string(&PropertyValue::Relation {
                target_note_ids: vec![parent.clone()],
                extra: BTreeMap::new(),
            })
            .map_err(|e| ProjectError::failed("serializeValue", e.to_string()))?,
        ),
        None => None,
    };

    let order_json = Some(
        serde_json::to_string(&PropertyValue::Text {
            value: request.order_key.clone(),
            extra: BTreeMap::new(),
        })
        .map_err(|e| ProjectError::failed("serializeValue", e.to_string()))?,
    );

    let batch = DatabaseValueBatchRequest {
        expected_generation: 0,
        operation_id: request.operation_id.clone(),
        database_id: target.database_id.clone(),
        cells: vec![
            DatabaseValueMutation {
                note_id: request.note_id.clone(),
                property_id: target.parent.clone(),
                value_json: parent_json,
                expected_revision: request.expected_revision.clone(),
            },
            DatabaseValueMutation {
                note_id: request.note_id.clone(),
                property_id: target.order.clone(),
                value_json: order_json,
                expected_revision: request.expected_revision.clone(),
            },
        ],
    };

    let applied =
        apply_value_batch_typed(env.vault, env.watcher, &batch, history).map_err(|error| {
            match error {
                ValueBatchError::RevisionConflict {
                    actual_revision, ..
                } => ProjectError::RevisionConflict { actual_revision },
                other => ProjectError::failed("movePageFailed", other.to_string()),
            }
        })?;

    let note_revision = applied
        .revisions
        .iter()
        .find(|r| r.note_id == request.note_id)
        .map(|r| r.revision.clone())
        .unwrap_or_default();

    Ok(MovedTextPage {
        database_id: target.database_id,
        note_id: request.note_id.clone(),
        parent_note_id: request.new_parent_note_id.clone(),
        order_key: request.order_key.clone(),
        revision: note_revision,
        warnings: applied.warnings,
    })
}
