use std::path::Path;

use serde_json::{json, Value};

use super::{allowed, operation_id, relative, Published};
use crate::project::create::{create_story, create_workshop_section, init_workshop, Env};
use crate::project::discovery::{discover_projects, DiscoveredStory, DiscoveredWorkshop};
use crate::project::model::{
    CreateStoryRequest, CreateWorkshopSectionRequest, InitWorkshopRequest, ProjectError,
    ROLE_CUSTOM,
};

pub fn list(root: &Path) -> Result<Value, &'static str> {
    let catalog = discover_projects(root).map_err(|_| "unavailable")?;
    let workshops: Vec<_> = catalog
        .workshops
        .iter()
        .take(super::MAX_ITEMS)
        .map(summary)
        .collect();
    Ok(json!({"workshops": workshops, "truncated": catalog.workshops.len() > workshops.len()}))
}

fn summary(workshop: &DiscoveredWorkshop) -> Value {
    json!({
        "workshopId": workshop.doc.workshop_id,
        "name": workshop.doc.name,
        "path": workshop.path,
        "revision": workshop.doc.revision,
        "readOnly": !workshop.doc.is_known_version()
    })
}

fn workshop(root: &Path, id: &str) -> Result<DiscoveredWorkshop, &'static str> {
    let catalog = discover_projects(root).map_err(|_| "unavailable")?;
    catalog
        .workshops
        .into_iter()
        .find(|workshop| workshop.doc.workshop_id == id)
        .ok_or("notFound")
}

pub fn read(root: &Path, id: &str) -> Result<Value, &'static str> {
    let workshop = workshop(root, id)?;
    let stories: Vec<_> = workshop.stories.iter().take(super::MAX_ITEMS).map(|story| json!({
        "storyId": story.story_id, "name": story.name, "path": story.folder_path,
        "cardPath": story.card_path, "databaseId": story.database_id, "revision": story.file_revision
    })).collect();
    let sections: Vec<_> = workshop.doc.sections.iter().take(super::MAX_ITEMS).map(|section| json!({
        "sectionId": section.id, "name": section.name, "role": section.role,
        "path": crate::vault::scan::normalize_rel_path(&Path::new(&workshop.path).join(&section.path)), "databaseId": section.database_id
    })).collect();
    Ok(json!({
        "workshop": summary(&workshop), "stories": stories, "sections": sections,
        "truncated": workshop.stories.len() > stories.len() || workshop.doc.sections.len() > sections.len()
    }))
}

fn find_story(
    root: &Path,
    id: &str,
) -> Result<(DiscoveredWorkshop, DiscoveredStory), &'static str> {
    let catalog = discover_projects(root).map_err(|_| "unavailable")?;
    for workshop in catalog.workshops {
        if let Some(story) = workshop
            .stories
            .iter()
            .find(|story| story.story_id == id)
            .cloned()
        {
            return Ok((workshop, story));
        }
    }
    Err("notFound")
}

pub fn read_story(root: &Path, id: &str) -> Result<Value, &'static str> {
    let (workshop, story) = find_story(root, id)?;
    let text = story
        .text_json
        .as_deref()
        .and_then(|data| serde_json::from_str::<Value>(data).ok());
    Ok(json!({
        "workshopId":workshop.doc.workshop_id, "storyId":story.story_id, "name":story.name,
        "path":story.folder_path, "cardPath":story.card_path, "databaseId":story.database_id,
        "revision":story.file_revision, "text":text
    }))
}

pub fn update(
    env: &Env,
    scope: &Path,
    request: &super::WorkshopUpdate,
) -> Result<Published, &'static str> {
    if request.name.is_none() && request.tags.is_none() {
        return Err("invalidArguments");
    }
    let workshop = writable_workshop(env.vault, scope, &request.workshop_id)?;
    let operation = operation_id(env.vault, scope, "update-workshop", &request.operation_id)?;
    crate::project::require_completed_or_new(env.vault, &operation).map_err(project_error)?;
    let result = crate::project::settings::update_workshop(
        env,
        &crate::project::model::UpdateWorkshopRequest {
            expected_generation: 0,
            operation_id: operation,
            workshop_id: request.workshop_id.clone(),
            expected_workshop_revision: request.expected_revision.clone(),
            name: request.name.clone(),
            icon: None,
            tags: request.tags.clone(),
        },
    )
    .map_err(project_error)?;
    Ok(Published::one(
        json!({
            "workshopId":result.workshop_id, "name":result.name, "tags":result.tags,
            "path":workshop.path, "revision":result.workshop_revision,
            "operationId":request.operation_id, "replayed":result.replayed
        }),
        env.vault
            .join(&workshop.path)
            .join(crate::project::model::WORKSHOP_FILE_NAME),
    ))
}

pub fn create_text_page(
    env: &Env,
    scope: &Path,
    request: &super::TextPage,
) -> Result<Published, &'static str> {
    let (workshop, story) = find_story(env.vault, &request.story_id)?;
    if !workshop.doc.is_known_version() {
        return Err("readOnly");
    }
    let folder = crate::index::read_only::visible_folder(env.vault, &story.folder_path)?;
    allowed(scope, &folder)?;
    let database_id = story.database_id.ok_or("textNotConfigured")?;
    let database = super::database::writable_database(env.vault, scope, &database_id)?;
    // The exact attached container must belong to this story, even if a
    // malformed file or duplicate database ID points at another directory.
    if database.container_path != folder {
        return Err("accessDenied");
    }
    let title = crate::project::names::normalize_entry_name("title", &request.title)
        .map_err(project_error)?;
    let connection = crate::index::read_only::disk_catalog(env.vault).map_err(|_| "unavailable")?;
    crate::database::projection::rebuild_database_projection(&connection, env.vault)
        .map_err(|_| "unavailable")?;
    let result = crate::project::text::create_page(
        env,
        &connection,
        &crate::project::model::CreateTextPageRequest {
            expected_generation: 0,
            story_id: request.story_id.clone(),
            title,
            level_id: request.level_id.clone(),
            order_key: request.order_key.clone(),
            parent_note_id: request.parent_note_id.clone(),
            format_id: request.format_id.clone(),
        },
    )
    .map_err(project_error)?;
    let path = std::path::PathBuf::from(&result.note_path);
    Ok(Published::one(
        json!({
            "storyId":request.story_id, "databaseId":result.database_id, "noteId":result.note_id,
            "title":result.title, "path":relative(env.vault, &path)?, "levelId":result.level_id,
            "formatId":result.format_id, "parentNoteId":result.parent_note_id, "orderKey":result.order_key
        }),
        path,
    ))
}

pub fn create(
    env: &Env,
    scope: &Path,
    parent: &str,
    name: &str,
    key: &str,
) -> Result<Published, &'static str> {
    let parent = crate::index::read_only::visible_folder(env.vault, super::root_folder(parent))?;
    allowed(scope, &parent)?;
    let name = crate::project::names::normalize_entry_name("name", name).map_err(project_error)?;
    let folder = parent.join(name);
    let operation = operation_id(env.vault, scope, "create-workshop", key)?;
    crate::project::require_completed_or_new(env.vault, &operation).map_err(project_error)?;
    let result = init_workshop(
        env,
        &InitWorkshopRequest {
            expected_generation: 0,
            operation_id: operation,
            path: relative(env.vault, &folder)?,
            labels: Default::default(),
        },
    )
    .map_err(project_error)?;
    Ok(Published::one(
        json!({
            "workshopId": result.workshop_id, "name": result.name, "path": result.path, "revision": result.file_revision,
            "sections": result.sections, "operationId": key, "replayed": result.replayed
        }),
        folder,
    ))
}

fn writable_workshop(
    root: &Path,
    scope: &Path,
    id: &str,
) -> Result<DiscoveredWorkshop, &'static str> {
    let workshop = workshop(root, id)?;
    let folder = crate::index::read_only::visible_folder(root, &workshop.path)?;
    allowed(scope, &folder)?;
    if !workshop.doc.is_known_version() {
        return Err("readOnly");
    }
    Ok(workshop)
}

pub fn story(
    env: &Env,
    scope: &Path,
    id: &str,
    title: &str,
    key: &str,
) -> Result<Published, &'static str> {
    let workshop = writable_workshop(env.vault, scope, id)?;
    let operation = operation_id(env.vault, scope, "create-story", key)?;
    crate::project::require_completed_or_new(env.vault, &operation).map_err(project_error)?;
    let result = create_story(
        env,
        &CreateStoryRequest {
            expected_generation: 0,
            operation_id: operation,
            workshop_id: id.into(),
            title: title.into(),
            text_levels: None,
            labels: Default::default(),
        },
    )
    .map_err(project_error)?;
    Ok(Published::one(
        json!({
            "workshopId": id, "storyId": result.story_id, "name": result.title, "path": result.folder_path,
            "cardPath": result.card_path, "databaseId": result.database_id, "revision": result.story_file_revision,
            "operationId": key, "replayed": result.replayed
        }),
        env.vault.join(workshop.path),
    ))
}

pub fn section(
    env: &Env,
    scope: &Path,
    id: &str,
    name: &str,
    revision: &str,
    key: &str,
) -> Result<Published, &'static str> {
    let workshop = writable_workshop(env.vault, scope, id)?;
    let operation = operation_id(env.vault, scope, "create-section", key)?;
    crate::project::require_completed_or_new(env.vault, &operation).map_err(project_error)?;
    let result = create_workshop_section(
        env,
        &CreateWorkshopSectionRequest {
            expected_generation: 0,
            operation_id: operation,
            workshop_id: id.into(),
            expected_workshop_revision: revision.into(),
            role: ROLE_CUSTOM.into(),
            name: name.into(),
            labels: Default::default(),
        },
    )
    .map_err(project_error)?;
    Ok(Published::one(
        json!({
            "workshopId": id, "section": result.section, "revision": result.workshop_revision, "operationId": key,
            "replayed": result.replayed
        }),
        env.vault.join(workshop.path),
    ))
}

fn project_error(error: ProjectError) -> &'static str {
    match error {
        ProjectError::RevisionConflict { .. } => "revisionConflict",
        ProjectError::RecoveryRequired { .. } => "recoveryRequired",
        ProjectError::OperationIdReused { .. } => "operationIdReused",
        ProjectError::RolledBack { .. } => "rolledBack",
        ProjectError::WorkshopNotFound { .. } | ProjectError::StoryNotFound { .. } => "notFound",
        ProjectError::WorkshopReadOnly { .. } | ProjectError::StoryReadOnly { .. } => "readOnly",
        ProjectError::PathCollision { .. } => "mutationConflict",
        ProjectError::TextNotConfigured => "textNotConfigured",
        ProjectError::InvalidOrderKey
        | ProjectError::UnknownTextLevel { .. }
        | ProjectError::UnknownTextFormat { .. }
        | ProjectError::ParentLevelNotShallower { .. } => "invalidArguments",
        ProjectError::PageNotFound { .. } => "notFound",
        ProjectError::Failed { code, .. } if code == "invalidPath" => "accessDenied",
        ProjectError::InvalidName { .. }
        | ProjectError::InvalidParent { .. }
        | ProjectError::InvalidOperationId => "invalidArguments",
        _ => "unavailable",
    }
}
