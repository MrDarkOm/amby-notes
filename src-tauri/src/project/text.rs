//! Pages of a story's text: creating one with its level, format, parent and place, and
//! moving one, as single writes into the text database.
//!
//! The text database is an ordinary database. A page is a note whose frontmatter holds the
//! values of the four system properties named by `text.properties`; nothing here keeps a
//! second copy of the tree. A move rewrites only the moved page (parent and order in one
//! write). Cycles are refused before the write; a cycle that reaches the files by other
//! means (an external edit, the relation picker) is the tree's problem to survive.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::create::Env;
use super::discovery::discover_projects;
use super::model::{
    CreateTextPageRequest, CreatedTextPage, MoveTextPageRequest, MovedTextPage, ProjectError,
    ROLE_TEXT,
};
use crate::database::discovery::discover_vault;
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

fn resolve(env: &Env, project_id: &str) -> Result<TextTarget, ProjectError> {
    let project = discover_projects(env.vault)
        .map_err(|message| ProjectError::failed("discoveryFailed", message))?
        .projects
        .into_iter()
        .find(|candidate| candidate.doc.project_id == project_id)
        .ok_or_else(|| ProjectError::ProjectNotFound {
            project_id: project_id.to_owned(),
        })?;
    let doc = project.doc;
    if !doc.is_known_version() {
        return Err(ProjectError::ProjectReadOnly {
            format_version: doc.format_version,
        });
    }
    let block = doc.raw.get("text").ok_or(ProjectError::TextNotConfigured)?;
    let database_id = doc
        .sections
        .iter()
        .find(|section| section.role.as_deref() == Some(ROLE_TEXT))
        .map(|section| section.database_id.clone())
        .ok_or(ProjectError::TextNotConfigured)?;
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

/// The note IDs of the pages of a database.
fn page_ids(vault: &Path, database_id: &str) -> Result<Vec<String>, ProjectError> {
    Ok(discover_vault(vault)
        .map_err(|message| ProjectError::failed("discoveryFailed", message))?
        .notes
        .into_iter()
        .filter(|note| note.owner_database_id.as_deref() == Some(database_id))
        .filter_map(|note| note.note_id)
        .collect())
}

fn require_page(pages: &[String], note_id: &str) -> Result<(), ProjectError> {
    if pages.iter().any(|candidate| candidate == note_id) {
        Ok(())
    } else {
        Err(ProjectError::PageNotFound {
            note_id: note_id.to_owned(),
        })
    }
}

/// The level (option ID) a page holds, from the projection; none when it has no value.
fn level_of(
    connection: &Connection,
    target: &TextTarget,
    note_id: &str,
) -> Result<Option<String>, ProjectError> {
    connection
        .query_row(
            "SELECT option_id FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = ?3",
            params![target.database_id, note_id, target.level],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(|error| ProjectError::failed("projectIndexFailed", error.to_string()))
}

/// A parent sits on a shallower level than its page, by the order of `text.levels`; skipping
/// a level is fine. A level the file does not list (no value, a removed option) cannot be
/// compared and constrains nothing.
fn check_parent_level(
    connection: &Connection,
    target: &TextTarget,
    parent_note_id: &str,
    level_id: Option<&str>,
) -> Result<(), ProjectError> {
    let (Some(level_id), Some(parent_level)) =
        (level_id, level_of(connection, target, parent_note_id)?)
    else {
        return Ok(());
    };
    let depth = |id: &str| {
        target
            .level_ids
            .iter()
            .position(|candidate| candidate == id)
    };
    match (depth(&parent_level), depth(level_id)) {
        (Some(parent), Some(page)) if parent >= page => {
            Err(ProjectError::ParentLevelNotShallower {
                parent_level_id: parent_level,
                level_id: level_id.to_owned(),
            })
        }
        _ => Ok(()),
    }
}

pub fn create_page(
    env: &Env,
    connection: &Connection,
    request: &CreateTextPageRequest,
) -> Result<CreatedTextPage, ProjectError> {
    if !valid_order_key(&request.order_key) {
        return Err(ProjectError::InvalidOrderKey);
    }
    let target = resolve(env, &request.project_id)?;
    if !target.level_ids.contains(&request.level_id)
        || !option_exists(&target.manifest, &target.level, &request.level_id)
    {
        return Err(ProjectError::UnknownTextLevel {
            level_id: request.level_id.clone(),
        });
    }
    let format_id = match &request.format_id {
        Some(id) => {
            if !target.formats.iter().any(|(candidate, _)| candidate == id)
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
            .find(|(id, kind)| {
                kind == "manuscript" && option_exists(&target.manifest, &target.format, id)
            })
            .map(|(id, _)| id.clone()),
    };
    if let Some(parent) = &request.parent_note_id {
        require_page(&page_ids(env.vault, &target.database_id)?, parent)?;
        check_parent_level(connection, &target, parent, Some(&request.level_id))?;
    }

    let mut initial = BTreeMap::new();
    initial.insert(
        target.level.clone(),
        PropertyValue::Select {
            option_id: request.level_id.clone(),
            extra: Default::default(),
        },
    );
    initial.insert(
        target.order.clone(),
        PropertyValue::Text {
            value: request.order_key.clone(),
            extra: Default::default(),
        },
    );
    if let Some(id) = &format_id {
        initial.insert(
            target.format.clone(),
            PropertyValue::Select {
                option_id: id.clone(),
                extra: Default::default(),
            },
        );
    }
    if let Some(parent) = &request.parent_note_id {
        initial.insert(
            target.parent.clone(),
            PropertyValue::Relation {
                target_note_ids: vec![parent.clone()],
                extra: Default::default(),
            },
        );
    }
    let created = create_database_row_with_values(
        env.vault,
        env.watcher,
        &CreateDatabaseRowRequest {
            expected_generation: request.expected_generation,
            database_id: target.database_id.clone(),
            title: request.title.clone(),
            template: DatabaseRowTemplate::Default,
        },
        &initial,
    )
    .map_err(|message| ProjectError::failed("pageCreateFailed", message))?;
    Ok(CreatedTextPage {
        database_id: target.database_id,
        note_id: created.note_id,
        title: created.title,
        note_path: created.note_path,
        level_id: request.level_id.clone(),
        format_id,
        parent_note_id: request.parent_note_id.clone(),
        order_key: request.order_key.clone(),
        warnings: created.warnings,
    })
}

/// Whether making `new_parent` the parent of `note_id` would close a loop, walking the
/// parent edges the projection holds. A loop that is already there ends the walk too.
pub fn would_cycle(
    connection: &Connection,
    database_id: &str,
    parent_property_id: &str,
    note_id: &str,
    new_parent: &str,
) -> Result<bool, ProjectError> {
    let mut current = new_parent.to_owned();
    let mut seen = std::collections::HashSet::new();
    loop {
        if current == note_id {
            return Ok(true);
        }
        if !seen.insert(current.clone()) {
            return Ok(false);
        }
        let next: Option<String> = connection
            .query_row(
                "SELECT target_note_id FROM db_relation_edges WHERE source_database_id = ?1 AND source_note_id = ?2 AND property_id = ?3 ORDER BY position LIMIT 1",
                params![database_id, current, parent_property_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| ProjectError::failed("projectIndexFailed", error.to_string()))?;
        match next {
            Some(parent) => current = parent,
            None => return Ok(false),
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
    let target = resolve(env, &request.project_id)?;
    let pages = page_ids(env.vault, &target.database_id)?;
    require_page(&pages, &request.note_id)?;
    if let Some(parent) = &request.new_parent_note_id {
        require_page(&pages, parent)?;
        // A loop is the more basic fault, so it is reported before a level mismatch.
        if would_cycle(
            connection,
            &target.database_id,
            &target.parent,
            &request.note_id,
            parent,
        )? {
            return Err(ProjectError::ParentCycle);
        }
        check_parent_level(
            connection,
            &target,
            parent,
            level_of(connection, &target, &request.note_id)?.as_deref(),
        )?;
    }
    let parent_value = request
        .new_parent_note_id
        .as_ref()
        .map(|parent| {
            serde_json::to_string(&PropertyValue::Relation {
                target_note_ids: vec![parent.clone()],
                extra: Default::default(),
            })
        })
        .transpose()
        .map_err(|error| ProjectError::failed("serialize", error.to_string()))?;
    let order_value = serde_json::to_string(&PropertyValue::Text {
        value: request.order_key.clone(),
        extra: Default::default(),
    })
    .map_err(|error| ProjectError::failed("serialize", error.to_string()))?;
    let cell = |property_id: &str, value_json: Option<String>| DatabaseValueMutation {
        note_id: request.note_id.clone(),
        property_id: property_id.to_owned(),
        value_json,
        expected_revision: request.expected_revision.clone(),
    };
    // Parent and order of one page go into one write, so it is never half moved.
    let batch = DatabaseValueBatchRequest {
        expected_generation: request.expected_generation,
        database_id: target.database_id.clone(),
        operation_id: request.operation_id.clone(),
        cells: vec![
            cell(&target.parent, parent_value),
            cell(&target.order, Some(order_value)),
        ],
    };
    let result =
        apply_value_batch_typed(env.vault, env.watcher, &batch, history).map_err(|error| {
            match error {
                // The type says the page changed, and the error carries the revision it has now.
                ValueBatchError::RevisionConflict {
                    actual_revision, ..
                } => ProjectError::RevisionConflict { actual_revision },
                ValueBatchError::Failed(message) => ProjectError::failed("pageMoveFailed", message),
            }
        })?;
    let revision = result
        .revisions
        .iter()
        .find(|entry| entry.note_id == request.note_id)
        .map(|entry| entry.revision.clone())
        .unwrap_or_default();
    Ok(MovedTextPage {
        database_id: target.database_id,
        note_id: request.note_id.clone(),
        parent_note_id: request.new_parent_note_id.clone(),
        order_key: request.order_key.clone(),
        revision,
        warnings: result.warnings,
    })
}
