//! Creative workshop settings and story text-schema mutations (`update_workshop`,
//! `remove_workshop_section`, `reorder_workshop_sections`, `update_text_levels`,
//! `add_text_status`).
//!
//! Every operation validates and preflights before any write, publishes a journal in
//! `.amby/recovery/creative/`, snapshots modified manifests and structure files into history,
//! and treats the structure file reaching its planned bytes as the commit point.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

use super::create::{
    io_failure, join_relative, replay, request_revision, validate_operation_id, Env, Replay,
};
use super::discovery::discover_projects;
use super::format::{
    document_bytes, parse_story_file, with_section_removed, with_sections_reordered,
    with_text_levels_updated, with_text_status_property, with_workshop_metadata, StoryDoc,
    WorkshopDoc,
};
use super::journal::{
    create_journal, replace_journal, Journal, Plan, PlannedManifestWrite, JOURNAL_FORMAT,
    JOURNAL_VERSION, OP_ADD_TEXT_STATUS, OP_REMOVE_SECTION, OP_REORDER_SECTIONS,
    OP_UPDATE_TEXT_LEVELS, OP_UPDATE_WORKSHOP, STATUS_COMPLETED, STATUS_IN_PROGRESS,
};
use super::model::{
    AddTextStatusRequest, AddedTextStatus, ProjectError, RemoveWorkshopSectionRequest,
    RemovedWorkshopSection, ReorderWorkshopSectionsRequest, ReorderedWorkshopSections,
    UpdateTextLevelsRequest, UpdateWorkshopRequest, UpdatedTextLevels, UpdatedWorkshop,
    ROLE_STORIES, STORY_FILE_NAME, WORKSHOP_FILE_NAME,
};
use super::names::{normalize_entry_name, normalize_icon, normalize_tags, normalize_title};
use super::text_schema::{resolve_status_labels, MAX_TEXT_LEVELS};
use crate::database::format::{
    parse_manifest, raw_revision, DatabaseManifest, PropertyDefinition, SelectOption,
};
use crate::durable;
use crate::frontmatter;
use crate::watcher;

const LABEL: &str = "Creative settings";

fn guarded(vault: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
    durable::guarded_path(vault, relative, LABEL)
        .map_err(|message| ProjectError::failed("invalidPath", message))
}

fn check_writable_workshop(doc: &WorkshopDoc, expected_revision: &str) -> Result<(), ProjectError> {
    if !doc.is_known_version() {
        return Err(ProjectError::WorkshopReadOnly {
            format_version: doc.format_version,
        });
    }
    if doc.revision != expected_revision {
        return Err(ProjectError::RevisionConflict {
            actual_revision: doc.revision.clone(),
        });
    }
    Ok(())
}

fn check_writable_story(doc: &StoryDoc, expected_revision: &str) -> Result<(), ProjectError> {
    if !doc.is_known_version() {
        return Err(ProjectError::StoryReadOnly {
            format_version: doc.format_version,
        });
    }
    if doc.revision != expected_revision {
        return Err(ProjectError::RevisionConflict {
            actual_revision: doc.revision.clone(),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Update workshop metadata (name, icon, tags)
// ---------------------------------------------------------------------------

pub fn update_workshop(
    env: &Env,
    request: &UpdateWorkshopRequest,
) -> Result<UpdatedWorkshop, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let name = request
        .name
        .as_deref()
        .map(|raw| normalize_entry_name("name", raw))
        .transpose()?;
    let icon = request
        .icon
        .as_deref()
        .map(|raw| normalize_icon(Some(raw)))
        .transpose()?;
    let tags = request.tags.as_deref().map(normalize_tags).transpose()?;

    let revision = request_revision(&json!({
        "workshopId": request.workshop_id,
        "expectedWorkshopRevision": request.expected_workshop_revision,
        "name": name,
        "icon": icon,
        "tags": tags,
    }))?;

    match replay(env, &request.operation_id, OP_UPDATE_WORKSHOP, &revision)? {
        Replay::Fresh | Replay::Resume(_) => {}
        Replay::Done(value) => {
            let mut updated: UpdatedWorkshop =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            updated.replayed = true;
            return Ok(updated);
        }
    }

    let discovery = discover_projects(env.vault).map_err(|e| io_failure("discovery", e))?;
    let workshop = discovery
        .workshops
        .iter()
        .find(|w| w.doc.workshop_id == request.workshop_id)
        .ok_or_else(|| ProjectError::WorkshopNotFound {
            workshop_id: request.workshop_id.clone(),
        })?;

    check_writable_workshop(&workshop.doc, &request.expected_workshop_revision)?;

    let after = with_workshop_metadata(
        &workshop.doc.raw,
        name.as_deref(),
        icon.as_ref().map(|opt| opt.as_deref()),
        tags.as_deref(),
    )
    .map_err(|message| ProjectError::failed("invalidWorkshopFile", message))?;

    let bytes = document_bytes(&after, workshop.doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidWorkshopFile", message))?;
    let workshop_revision = raw_revision(&bytes);

    let final_name = name.unwrap_or_else(|| workshop.doc.name.clone());
    let final_icon = icon.unwrap_or_else(|| workshop.doc.icon.clone());
    let final_tags = tags.unwrap_or_else(|| workshop.doc.tags.clone());

    let expected = UpdatedWorkshop {
        operation_id: request.operation_id.clone(),
        workshop_id: workshop.doc.workshop_id.clone(),
        name: final_name,
        icon: final_icon,
        tags: final_tags,
        workshop_revision: workshop_revision.clone(),
        replayed: false,
        warnings: Vec::new(),
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_UPDATE_WORKSHOP.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: Some(workshop.doc.workshop_id.clone()),
            workshop_path: Some(workshop.path.clone()),
            creates_workshop_folder: false,
            workshop_file_revision: Some(workshop_revision.clone()),
            sections: Vec::new(),
            story: None,
            story_file_path: None,
            story_file_revision: None,
            manifest_write: None,
        },
        expected_result: serde_json::to_value(&expected).unwrap(),
        extra: BTreeMap::new(),
    };

    create_journal(env.vault, &journal)?;

    let workshop_dir = guarded(env.vault, &workshop.path)?;
    let file_path = workshop_dir.join(WORKSHOP_FILE_NAME);

    // Apply
    crate::history::snapshot_before_write(env.vault, &file_path, &bytes, "workshop-structure")
        .map_err(|e| io_failure("snapshot", e))?;
    let prepared = env
        .watcher
        .prepare_write([(&file_path, watcher::fingerprint_for_bytes(&bytes))]);
    if let Err(e) = frontmatter::atomic_write_bytes(&file_path, &bytes) {
        env.watcher.cancel_prepared_write(&prepared);
        return Err(io_failure("write", e));
    }
    env.watcher.confirm_prepared_write(&prepared);

    let mut j = journal;
    j.status = STATUS_COMPLETED.to_owned();
    let _ = replace_journal(env.vault, &j);

    Ok(expected)
}

// ---------------------------------------------------------------------------
// Remove workshop section
// ---------------------------------------------------------------------------

pub fn remove_workshop_section(
    env: &Env,
    request: &RemoveWorkshopSectionRequest,
) -> Result<RemovedWorkshopSection, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let revision = request_revision(&json!({
        "workshopId": request.workshop_id,
        "expectedWorkshopRevision": request.expected_workshop_revision,
        "sectionId": request.section_id,
    }))?;

    match replay(env, &request.operation_id, OP_REMOVE_SECTION, &revision)? {
        Replay::Fresh | Replay::Resume(_) => {}
        Replay::Done(value) => {
            let mut removed: RemovedWorkshopSection =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            removed.replayed = true;
            return Ok(removed);
        }
    }

    let discovery = discover_projects(env.vault).map_err(|e| io_failure("discovery", e))?;
    let workshop = discovery
        .workshops
        .iter()
        .find(|w| w.doc.workshop_id == request.workshop_id)
        .ok_or_else(|| ProjectError::WorkshopNotFound {
            workshop_id: request.workshop_id.clone(),
        })?;

    check_writable_workshop(&workshop.doc, &request.expected_workshop_revision)?;

    let section = workshop
        .doc
        .sections
        .iter()
        .find(|s| s.id == request.section_id)
        .ok_or_else(|| ProjectError::SectionNotFound {
            section_id: request.section_id.clone(),
        })?;

    if section.role == ROLE_STORIES {
        return Err(ProjectError::CannotRemoveStoriesSection);
    }

    let after = with_section_removed(&workshop.doc.raw, &request.section_id)
        .map_err(|message| ProjectError::failed("invalidWorkshopFile", message))?;
    let bytes = document_bytes(&after, workshop.doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidWorkshopFile", message))?;
    let workshop_revision = raw_revision(&bytes);

    let expected = RemovedWorkshopSection {
        operation_id: request.operation_id.clone(),
        workshop_id: workshop.doc.workshop_id.clone(),
        section_id: request.section_id.clone(),
        workshop_revision: workshop_revision.clone(),
        replayed: false,
        warnings: Vec::new(),
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_REMOVE_SECTION.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: Some(workshop.doc.workshop_id.clone()),
            workshop_path: Some(workshop.path.clone()),
            creates_workshop_folder: false,
            workshop_file_revision: Some(workshop_revision.clone()),
            sections: Vec::new(),
            story: None,
            story_file_path: None,
            story_file_revision: None,
            manifest_write: None,
        },
        expected_result: serde_json::to_value(&expected).unwrap(),
        extra: BTreeMap::new(),
    };

    create_journal(env.vault, &journal)?;

    let workshop_dir = guarded(env.vault, &workshop.path)?;
    let file_path = workshop_dir.join(WORKSHOP_FILE_NAME);

    crate::history::snapshot_before_write(env.vault, &file_path, &bytes, "workshop-structure")
        .map_err(|e| io_failure("snapshot", e))?;
    let prepared = env
        .watcher
        .prepare_write([(&file_path, watcher::fingerprint_for_bytes(&bytes))]);
    if let Err(e) = frontmatter::atomic_write_bytes(&file_path, &bytes) {
        env.watcher.cancel_prepared_write(&prepared);
        return Err(io_failure("write", e));
    }
    env.watcher.confirm_prepared_write(&prepared);

    let mut j = journal;
    j.status = STATUS_COMPLETED.to_owned();
    let _ = replace_journal(env.vault, &j);

    Ok(expected)
}

// ---------------------------------------------------------------------------
// Reorder workshop sections
// ---------------------------------------------------------------------------

pub fn reorder_workshop_sections(
    env: &Env,
    request: &ReorderWorkshopSectionsRequest,
) -> Result<ReorderedWorkshopSections, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let revision = request_revision(&json!({
        "workshopId": request.workshop_id,
        "expectedWorkshopRevision": request.expected_workshop_revision,
        "sectionIds": request.section_ids,
    }))?;

    match replay(env, &request.operation_id, OP_REORDER_SECTIONS, &revision)? {
        Replay::Fresh | Replay::Resume(_) => {}
        Replay::Done(value) => {
            let mut reordered: ReorderedWorkshopSections =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            reordered.replayed = true;
            return Ok(reordered);
        }
    }

    let discovery = discover_projects(env.vault).map_err(|e| io_failure("discovery", e))?;
    let workshop = discovery
        .workshops
        .iter()
        .find(|w| w.doc.workshop_id == request.workshop_id)
        .ok_or_else(|| ProjectError::WorkshopNotFound {
            workshop_id: request.workshop_id.clone(),
        })?;

    check_writable_workshop(&workshop.doc, &request.expected_workshop_revision)?;

    let after = with_sections_reordered(&workshop.doc.raw, &request.section_ids)
        .map_err(|message| ProjectError::failed("invalidWorkshopFile", message))?;
    let bytes = document_bytes(&after, workshop.doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidWorkshopFile", message))?;
    let workshop_revision = raw_revision(&bytes);

    let expected = ReorderedWorkshopSections {
        operation_id: request.operation_id.clone(),
        workshop_id: workshop.doc.workshop_id.clone(),
        section_ids: request.section_ids.clone(),
        workshop_revision: workshop_revision.clone(),
        replayed: false,
        warnings: Vec::new(),
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_REORDER_SECTIONS.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: Some(workshop.doc.workshop_id.clone()),
            workshop_path: Some(workshop.path.clone()),
            creates_workshop_folder: false,
            workshop_file_revision: Some(workshop_revision.clone()),
            sections: Vec::new(),
            story: None,
            story_file_path: None,
            story_file_revision: None,
            manifest_write: None,
        },
        expected_result: serde_json::to_value(&expected).unwrap(),
        extra: BTreeMap::new(),
    };

    create_journal(env.vault, &journal)?;

    let workshop_dir = guarded(env.vault, &workshop.path)?;
    let file_path = workshop_dir.join(WORKSHOP_FILE_NAME);

    crate::history::snapshot_before_write(env.vault, &file_path, &bytes, "workshop-structure")
        .map_err(|e| io_failure("snapshot", e))?;
    let prepared = env
        .watcher
        .prepare_write([(&file_path, watcher::fingerprint_for_bytes(&bytes))]);
    if let Err(e) = frontmatter::atomic_write_bytes(&file_path, &bytes) {
        env.watcher.cancel_prepared_write(&prepared);
        return Err(io_failure("write", e));
    }
    env.watcher.confirm_prepared_write(&prepared);

    let mut j = journal;
    j.status = STATUS_COMPLETED.to_owned();
    let _ = replace_journal(env.vault, &j);

    Ok(expected)
}

// ---------------------------------------------------------------------------
// Helpers for Story Text Mutations
// ---------------------------------------------------------------------------

struct FoundStory {
    story_file_path: PathBuf,
    manifest_file_path: PathBuf,
    story_file_rel: String,
    manifest_rel: String,
    story_doc: StoryDoc,
    manifest: DatabaseManifest,
    manifest_raw_text: String,
}

fn find_story(env: &Env, story_id: &str) -> Result<FoundStory, ProjectError> {
    let discovery = discover_projects(env.vault).map_err(|e| io_failure("discovery", e))?;
    for workshop in &discovery.workshops {
        for story in &workshop.stories {
            if story.story_id == story_id {
                let story_folder = guarded(env.vault, &story.folder_path)?;
                let story_file_path = story_folder.join(STORY_FILE_NAME);
                let story_bytes = fs::read(&story_file_path)
                    .map_err(|e| ProjectError::failed("readStoryFile", e.to_string()))?;
                let story_doc = parse_story_file(&story_bytes)
                    .map_err(|p| ProjectError::failed("parseStoryFile", p.detail))?;

                let manifest_file_path =
                    guarded(env.vault, &story.folder_path)?.join(format!("{}.json", story.name));
                let manifest_bytes = fs::read(&manifest_file_path)
                    .map_err(|e| ProjectError::failed("readManifest", e.to_string()))?;
                let manifest_raw_text = String::from_utf8(manifest_bytes.clone())
                    .map_err(|e| ProjectError::failed("readManifest", e.to_string()))?;
                let manifest = parse_manifest(&manifest_bytes)
                    .map_err(|p| ProjectError::failed("parseManifest", p.to_string()))?
                    .value;

                return Ok(FoundStory {
                    story_file_path,
                    manifest_file_path,
                    story_file_rel: join_relative(&story.folder_path, STORY_FILE_NAME),
                    manifest_rel: join_relative(
                        &story.folder_path,
                        &format!("{}.json", story.name),
                    ),
                    story_doc,
                    manifest,
                    manifest_raw_text,
                });
            }
        }
    }
    Err(ProjectError::StoryNotFound {
        story_id: story_id.to_owned(),
    })
}

// ---------------------------------------------------------------------------
// Update text levels
// ---------------------------------------------------------------------------

struct NormalizedLevelInput {
    id: Option<String>,
    name: String,
    icon: Option<String>,
}

fn normalize_level_updates(
    raw: &[super::model::TextLevelUpdateInput],
) -> Result<Vec<NormalizedLevelInput>, ProjectError> {
    let invalid = |reason: &str| ProjectError::InvalidName {
        field: "textLevels".to_owned(),
        reason: reason.to_owned(),
    };
    if raw.is_empty() {
        return Err(invalid("empty"));
    }
    if raw.len() > MAX_TEXT_LEVELS {
        return Err(invalid("too many"));
    }
    let mut names = Vec::with_capacity(raw.len());
    let mut ids = HashSet::new();
    let mut result = Vec::with_capacity(raw.len());
    for entry in raw {
        let name = normalize_title("textLevels", &entry.name)?;
        if names
            .iter()
            .any(|existing: &String| existing.to_lowercase() == name.to_lowercase())
        {
            return Err(invalid("duplicate"));
        }
        names.push(name.clone());
        let id = entry
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if let Some(ref existing_id) = id {
            if !ids.insert(existing_id.clone()) {
                return Err(invalid("duplicate id"));
            }
        }
        let icon = normalize_icon(entry.icon.as_deref())?;
        result.push(NormalizedLevelInput { id, name, icon });
    }
    Ok(result)
}

pub fn update_text_levels(
    env: &Env,
    _conn: Option<&Connection>,
    request: &UpdateTextLevelsRequest,
) -> Result<UpdatedTextLevels, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let normalized = normalize_level_updates(&request.levels)?;

    let revision = request_revision(&json!({
        "storyId": request.story_id,
        "expectedStoryRevision": request.expected_story_revision,
        "levels": normalized
            .iter()
            .map(|entry| json!({"id": entry.id, "name": entry.name, "icon": entry.icon}))
            .collect::<Vec<_>>(),
    }))?;

    match replay(env, &request.operation_id, OP_UPDATE_TEXT_LEVELS, &revision)? {
        Replay::Fresh | Replay::Resume(_) => {}
        Replay::Done(value) => {
            let mut updated: UpdatedTextLevels =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            updated.replayed = true;
            return Ok(updated);
        }
    }

    let found = find_story(env, &request.story_id)?;
    check_writable_story(&found.story_doc, &request.expected_story_revision)?;

    let level_property_id = found
        .story_doc
        .raw
        .pointer("/text/properties/level")
        .and_then(Value::as_str)
        .ok_or(ProjectError::TextNotConfigured)?
        .to_owned();

    let existing_level_ids: Vec<String> = found
        .story_doc
        .raw
        .pointer("/text/levels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();

    // Level removal is not part of settings: every existing level must remain in the list,
    // and no unknown level ID may be supplied.
    for input in &normalized {
        if let Some(ref id) = input.id {
            if !existing_level_ids.contains(id) {
                return Err(ProjectError::UnknownTextLevel {
                    level_id: id.clone(),
                });
            }
        }
    }
    if let Some(missing) = existing_level_ids.iter().find(|existing| {
        !normalized
            .iter()
            .any(|input| input.id.as_ref() == Some(*existing))
    }) {
        return Err(ProjectError::UnknownTextLevel {
            level_id: missing.clone(),
        });
    }

    // Build next level options
    let mut level_prop_def = found
        .manifest
        .properties
        .iter()
        .find(|p| p.id() == Some(level_property_id.as_str()))
        .cloned()
        .ok_or(ProjectError::TextNotConfigured)?;

    let mut next_options = Vec::new();
    let mut next_level_tuples = Vec::new();
    let mut next_level_ids = Vec::new();

    let existing_select_options = match &level_prop_def {
        PropertyDefinition::Select(fields) => fields.config.options.clone(),
        _ => Vec::new(),
    };

    for input in &normalized {
        let (id, color) = match &input.id {
            Some(existing_id) => {
                let existing_opt = existing_select_options
                    .iter()
                    .find(|o| o.id == *existing_id);
                let col = existing_opt
                    .map(|o| o.color.clone())
                    .unwrap_or_else(|| "blue".to_owned());
                (existing_id.clone(), col)
            }
            None => (ulid::Ulid::generate().to_string(), "blue".to_owned()),
        };
        next_options.push(SelectOption {
            id: id.clone(),
            name: input.name.clone(),
            color,
            aliases: Vec::new(),
            extra: BTreeMap::new(),
        });
        next_level_tuples.push((id.clone(), input.icon.clone()));
        next_level_ids.push(id);
    }

    if let PropertyDefinition::Select(ref mut fields) = level_prop_def {
        fields.config.options = next_options;
    }

    // Update manifest
    let mut next_manifest = found.manifest.clone();
    if let Some(slot) = next_manifest
        .properties
        .iter_mut()
        .find(|p| p.id() == Some(level_property_id.as_str()))
    {
        *slot = level_prop_def;
    }

    let mut manifest_bytes =
        serde_json::to_vec_pretty(&next_manifest).map_err(|e| io_failure("serialize", e))?;
    manifest_bytes.push(b'\n');
    let manifest_post_text = String::from_utf8(manifest_bytes.clone()).unwrap();
    let manifest_rev = raw_revision(&manifest_bytes);

    // Update amby-story.json
    let story_after = with_text_levels_updated(&found.story_doc.raw, &next_level_tuples)
        .map_err(|e| io_failure("storyFormat", e))?;
    let story_bytes = document_bytes(&story_after, found.story_doc.has_bom)
        .map_err(|e| io_failure("serialize", e))?;
    let story_rev = raw_revision(&story_bytes);

    let expected = UpdatedTextLevels {
        operation_id: request.operation_id.clone(),
        story_id: request.story_id.clone(),
        story_revision: story_rev.clone(),
        manifest_revision: manifest_rev.clone(),
        level_ids: next_level_ids,
        replayed: false,
        warnings: Vec::new(),
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_UPDATE_TEXT_LEVELS.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: None,
            workshop_path: None,
            creates_workshop_folder: false,
            workshop_file_revision: None,
            sections: Vec::new(),
            story: None,
            story_file_path: Some(found.story_file_rel.clone()),
            story_file_revision: Some(story_rev.clone()),
            manifest_write: Some(PlannedManifestWrite {
                manifest_path: found.manifest_rel.clone(),
                pre_revision: raw_revision(found.manifest_raw_text.as_bytes()),
                post_revision: manifest_rev,
                pre_text: found.manifest_raw_text,
                post_text: manifest_post_text,
            }),
        },
        expected_result: serde_json::to_value(&expected).unwrap(),
        extra: BTreeMap::new(),
    };

    create_journal(env.vault, &journal)?;

    // Write manifest first
    crate::history::snapshot_before_write(
        env.vault,
        &found.manifest_file_path,
        &manifest_bytes,
        "database-manifest",
    )
    .map_err(|e| io_failure("snapshot", e))?;
    let prep_m = env.watcher.prepare_write([(
        &found.manifest_file_path,
        watcher::fingerprint_for_bytes(&manifest_bytes),
    )]);
    if let Err(e) = frontmatter::atomic_write_bytes(&found.manifest_file_path, &manifest_bytes) {
        env.watcher.cancel_prepared_write(&prep_m);
        return Err(io_failure("write", e));
    }
    env.watcher.confirm_prepared_write(&prep_m);

    // Write amby-story.json (commit point)
    crate::history::snapshot_before_write(
        env.vault,
        &found.story_file_path,
        &story_bytes,
        "story-config",
    )
    .map_err(|e| io_failure("snapshot", e))?;
    let prep_s = env.watcher.prepare_write([(
        &found.story_file_path,
        watcher::fingerprint_for_bytes(&story_bytes),
    )]);
    if let Err(e) = frontmatter::atomic_write_bytes(&found.story_file_path, &story_bytes) {
        env.watcher.cancel_prepared_write(&prep_s);
        return Err(io_failure("write", e));
    }
    env.watcher.confirm_prepared_write(&prep_s);

    let mut j = journal;
    j.status = STATUS_COMPLETED.to_owned();
    let _ = replace_journal(env.vault, &j);

    Ok(expected)
}

// ---------------------------------------------------------------------------
// Add text status
// ---------------------------------------------------------------------------

pub fn add_text_status(
    env: &Env,
    request: &AddTextStatusRequest,
) -> Result<AddedTextStatus, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let revision = request_revision(&json!({
        "storyId": request.story_id,
        "expectedStoryRevision": request.expected_story_revision,
        "labels": request.labels,
    }))?;

    match replay(env, &request.operation_id, OP_ADD_TEXT_STATUS, &revision)? {
        Replay::Fresh | Replay::Resume(_) => {}
        Replay::Done(value) => {
            let mut added: AddedTextStatus =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            added.replayed = true;
            return Ok(added);
        }
    }

    let found = find_story(env, &request.story_id)?;
    check_writable_story(&found.story_doc, &request.expected_story_revision)?;

    if found
        .story_doc
        .raw
        .pointer("/text/properties/status")
        .and_then(Value::as_str)
        .is_some()
    {
        return Err(ProjectError::StatusAlreadyConfigured);
    }

    let (prop_name, status_names) = resolve_status_labels(&request.labels)?;
    let mut builder = super::props::PropertyBuilder::new(
        env.vault,
        &found.manifest.name,
        &crate::database::mutations::PlannedDatabaseIds {
            database_id: found.manifest.database_id.clone(),
            view_id: ulid::Ulid::generate().to_string(),
        },
    )?;

    let (prop_def, planned_prop_ids) = builder.add("status", &prop_name, &status_names, &|_| {})?;

    let mut next_manifest = found.manifest.clone();
    let parsed_def: PropertyDefinition =
        serde_json::from_value(prop_def).map_err(|e| io_failure("deserialize", e))?;
    next_manifest.properties.push(parsed_def);

    let mut manifest_bytes =
        serde_json::to_vec_pretty(&next_manifest).map_err(|e| io_failure("serialize", e))?;
    manifest_bytes.push(b'\n');
    let manifest_post_text = String::from_utf8(manifest_bytes.clone()).unwrap();
    let manifest_rev = raw_revision(&manifest_bytes);

    let story_after =
        with_text_status_property(&found.story_doc.raw, &planned_prop_ids.property_id)
            .map_err(|e| io_failure("storyFormat", e))?;
    let story_bytes = document_bytes(&story_after, found.story_doc.has_bom)
        .map_err(|e| io_failure("serialize", e))?;
    let story_rev = raw_revision(&story_bytes);

    let expected = AddedTextStatus {
        operation_id: request.operation_id.clone(),
        story_id: request.story_id.clone(),
        property_id: planned_prop_ids.property_id,
        story_revision: story_rev.clone(),
        manifest_revision: manifest_rev.clone(),
        replayed: false,
        warnings: Vec::new(),
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_ADD_TEXT_STATUS.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: None,
            workshop_path: None,
            creates_workshop_folder: false,
            workshop_file_revision: None,
            sections: Vec::new(),
            story: None,
            story_file_path: Some(found.story_file_rel.clone()),
            story_file_revision: Some(story_rev.clone()),
            manifest_write: Some(PlannedManifestWrite {
                manifest_path: found.manifest_rel.clone(),
                pre_revision: raw_revision(found.manifest_raw_text.as_bytes()),
                post_revision: manifest_rev,
                pre_text: found.manifest_raw_text,
                post_text: manifest_post_text,
            }),
        },
        expected_result: serde_json::to_value(&expected).unwrap(),
        extra: BTreeMap::new(),
    };

    create_journal(env.vault, &journal)?;

    // Write manifest first
    crate::history::snapshot_before_write(
        env.vault,
        &found.manifest_file_path,
        &manifest_bytes,
        "database-manifest",
    )
    .map_err(|e| io_failure("snapshot", e))?;
    let prep_m = env.watcher.prepare_write([(
        &found.manifest_file_path,
        watcher::fingerprint_for_bytes(&manifest_bytes),
    )]);
    if let Err(e) = frontmatter::atomic_write_bytes(&found.manifest_file_path, &manifest_bytes) {
        env.watcher.cancel_prepared_write(&prep_m);
        return Err(io_failure("write", e));
    }
    env.watcher.confirm_prepared_write(&prep_m);

    // Write amby-story.json (commit point)
    crate::history::snapshot_before_write(
        env.vault,
        &found.story_file_path,
        &story_bytes,
        "story-config",
    )
    .map_err(|e| io_failure("snapshot", e))?;
    let prep_s = env.watcher.prepare_write([(
        &found.story_file_path,
        watcher::fingerprint_for_bytes(&story_bytes),
    )]);
    if let Err(e) = frontmatter::atomic_write_bytes(&found.story_file_path, &story_bytes) {
        env.watcher.cancel_prepared_write(&prep_s);
        return Err(io_failure("write", e));
    }
    env.watcher.confirm_prepared_write(&prep_s);

    let mut j = journal;
    j.status = STATUS_COMPLETED.to_owned();
    let _ = replace_journal(env.vault, &j);

    Ok(expected)
}
