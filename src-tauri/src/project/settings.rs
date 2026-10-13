//! Project settings and text-schema mutations on an existing project (`update_project`,
//! `remove_project_section`, `reorder_project_sections`, `update_text_levels`,
//! `add_text_status`).
//!
//! Every operation follows the same durable contract as `create_project_section`: validate and
//! preflight before any write, publish a journal in `.amby/recovery/projects/`, snapshot
//! modified manifests and `amby-project.json` into history, and treat `amby-project.json`
//! reaching its planned bytes as the commit point.

use std::collections::{BTreeMap, HashSet};
use std::fs;

use serde_json::{json, Value};

use super::create::{
    find_project, finish, io_failure, replay, request_revision, run, validate_operation_id, Env,
    ProjectWrite, Replay,
};
use super::format::{
    document_bytes, with_project_metadata, with_section_removed, with_sections_reordered,
    ProjectDoc,
};
use super::journal::{
    self, Journal, Plan, PlannedManifestWrite, JOURNAL_FORMAT, JOURNAL_VERSION, OP_ADD_TEXT_STATUS,
    OP_REMOVE_SECTION, OP_REORDER_SECTIONS, OP_UPDATE_PROJECT, OP_UPDATE_TEXT_LEVELS,
    STATUS_IN_PROGRESS,
};
use super::model::{
    AddTextStatusRequest, AddedTextStatus, ProjectError, RemoveProjectSectionRequest,
    RemovedProjectSection, ReorderProjectSectionsRequest, ReorderedProjectSections,
    UpdateProjectRequest, UpdateTextLevelsRequest, UpdatedProject, UpdatedTextLevels, ROLE_TEXT,
};
use super::names::{normalize_entry_name, normalize_icon, normalize_tags, normalize_title};
use super::text_schema::{
    resolve_status_labels, with_text_levels_updated, with_text_status_property, MAX_TEXT_LEVELS,
};
use crate::database::discovery::manifest_path_for_container;
use crate::database::format::{
    parse_manifest, prepare_json, raw_revision, DatabaseManifest, ParsedJson, PropertyDefinition,
    SelectOption,
};
use crate::database::mutations::{
    build_new_property, find_database_container, CreateDatabasePropertyRequest, PlannedPropertyIds,
};
use crate::database::validation::validate_manifest;
use crate::durable;

const LABEL: &str = "Project settings";

fn check_writable_project(doc: &ProjectDoc, expected_revision: &str) -> Result<(), ProjectError> {
    if !doc.is_known_version() {
        return Err(ProjectError::ProjectReadOnly {
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
// Update project metadata (name, icon, tags)
// ---------------------------------------------------------------------------

pub fn update_project(
    env: &Env,
    request: &UpdateProjectRequest,
) -> Result<UpdatedProject, ProjectError> {
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
        "projectId": request.project_id,
        "expectedProjectRevision": request.expected_project_revision,
        "name": name,
        "icon": icon,
        "tags": tags,
    }))?;

    let resumed = match replay(env, &request.operation_id, OP_UPDATE_PROJECT, &revision)? {
        Replay::Done(value) => {
            return finish(
                value,
                true,
                Vec::new(),
                |result: &mut UpdatedProject, replayed, warnings| {
                    result.replayed = replayed;
                    result.warnings = warnings;
                },
            )
        }
        Replay::Resume(journal) => Some(journal),
        Replay::Fresh => None,
    };

    let project = find_project(env, &request.project_id)?;
    let doc = &project.doc;
    check_writable_project(doc, &request.expected_project_revision)?;

    let after = with_project_metadata(
        &doc.raw,
        name.as_deref(),
        icon.as_ref().map(|opt| opt.as_deref()),
        tags.as_deref(),
    )
    .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let bytes = document_bytes(&after, doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let project_revision = raw_revision(&bytes);

    let final_name = name.unwrap_or_else(|| doc.name.clone());
    let final_icon = icon.unwrap_or_else(|| doc.icon.clone());
    let final_tags = tags.unwrap_or_else(|| doc.tags.clone());

    let plan = Plan {
        project_id: doc.project_id.clone(),
        project_path: project.path.clone(),
        creates_project_folder: false,
        project_file_revision: project_revision.clone(),
        sections: Vec::new(),
        text_block: None,
        manifest_write: None,
    };
    let expected = UpdatedProject {
        operation_id: request.operation_id.clone(),
        project_id: doc.project_id.clone(),
        name: final_name,
        icon: final_icon,
        tags: final_tags,
        project_revision,
        replayed: false,
        warnings: Vec::new(),
    };
    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_UPDATE_PROJECT.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan,
        expected_result: serde_json::to_value(&expected)
            .map_err(|error| io_failure("serialize", error))?,
        extra: BTreeMap::new(),
    };
    journal::validate_journal(&journal)?;
    let write = ProjectWrite::Replace {
        expected_revision: request.expected_project_revision.clone(),
        bytes,
    };
    let (done, warnings) = run(env, journal, resumed.is_some(), write)?;
    finish(
        done.expected_result,
        false,
        warnings,
        |result: &mut UpdatedProject, _, warnings| {
            result.warnings = warnings;
        },
    )
}

// ---------------------------------------------------------------------------
// Remove section from structure file (database stays on disk)
// ---------------------------------------------------------------------------

pub fn remove_project_section(
    env: &Env,
    request: &RemoveProjectSectionRequest,
) -> Result<RemovedProjectSection, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let section_id = request.section_id.trim();
    if section_id.is_empty() {
        return Err(ProjectError::SectionNotFound {
            section_id: request.section_id.clone(),
        });
    }
    let revision = request_revision(&json!({
        "projectId": request.project_id,
        "expectedProjectRevision": request.expected_project_revision,
        "sectionId": section_id,
    }))?;

    let resumed = match replay(env, &request.operation_id, OP_REMOVE_SECTION, &revision)? {
        Replay::Done(value) => {
            return finish(
                value,
                true,
                Vec::new(),
                |result: &mut RemovedProjectSection, replayed, warnings| {
                    result.replayed = replayed;
                    result.warnings = warnings;
                },
            )
        }
        Replay::Resume(journal) => Some(journal),
        Replay::Fresh => None,
    };

    let project = find_project(env, &request.project_id)?;
    let doc = &project.doc;
    check_writable_project(doc, &request.expected_project_revision)?;

    let section = doc
        .sections
        .iter()
        .find(|candidate| candidate.id == section_id)
        .ok_or_else(|| ProjectError::SectionNotFound {
            section_id: section_id.to_owned(),
        })?;
    if section.role.as_deref() == Some(ROLE_TEXT) {
        return Err(ProjectError::CannotRemoveTextSection);
    }

    let after = with_section_removed(&doc.raw, section_id)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let bytes = document_bytes(&after, doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let project_revision = raw_revision(&bytes);

    let plan = Plan {
        project_id: doc.project_id.clone(),
        project_path: project.path.clone(),
        creates_project_folder: false,
        project_file_revision: project_revision.clone(),
        sections: Vec::new(),
        text_block: None,
        manifest_write: None,
    };
    let expected = RemovedProjectSection {
        operation_id: request.operation_id.clone(),
        project_id: doc.project_id.clone(),
        section_id: section_id.to_owned(),
        project_revision,
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
        plan,
        expected_result: serde_json::to_value(&expected)
            .map_err(|error| io_failure("serialize", error))?,
        extra: BTreeMap::new(),
    };
    journal::validate_journal(&journal)?;
    let write = ProjectWrite::Replace {
        expected_revision: request.expected_project_revision.clone(),
        bytes,
    };
    let (done, warnings) = run(env, journal, resumed.is_some(), write)?;
    finish(
        done.expected_result,
        false,
        warnings,
        |result: &mut RemovedProjectSection, _, warnings| {
            result.warnings = warnings;
        },
    )
}

// ---------------------------------------------------------------------------
// Reorder sections in structure file
// ---------------------------------------------------------------------------

pub fn reorder_project_sections(
    env: &Env,
    request: &ReorderProjectSectionsRequest,
) -> Result<ReorderedProjectSections, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let mut seen = HashSet::new();
    for id in &request.section_ids {
        if id.trim().is_empty() || !seen.insert(id.as_str()) {
            return Err(ProjectError::InvalidName {
                field: "sectionIds".to_owned(),
                reason: "duplicate or empty".to_owned(),
            });
        }
    }

    let revision = request_revision(&json!({
        "projectId": request.project_id,
        "expectedProjectRevision": request.expected_project_revision,
        "sectionIds": request.section_ids,
    }))?;

    let resumed = match replay(env, &request.operation_id, OP_REORDER_SECTIONS, &revision)? {
        Replay::Done(value) => {
            return finish(
                value,
                true,
                Vec::new(),
                |result: &mut ReorderedProjectSections, replayed, warnings| {
                    result.replayed = replayed;
                    result.warnings = warnings;
                },
            )
        }
        Replay::Resume(journal) => Some(journal),
        Replay::Fresh => None,
    };

    let project = find_project(env, &request.project_id)?;
    let doc = &project.doc;
    check_writable_project(doc, &request.expected_project_revision)?;

    for wanted in &request.section_ids {
        if !doc.sections.iter().any(|section| &section.id == wanted) {
            return Err(ProjectError::SectionNotFound {
                section_id: wanted.clone(),
            });
        }
    }
    if let Some(missing) = doc.sections.iter().find(|section| {
        !request
            .section_ids
            .iter()
            .any(|wanted| wanted == &section.id)
    }) {
        return Err(ProjectError::SectionNotFound {
            section_id: missing.id.clone(),
        });
    }

    let after = with_sections_reordered(&doc.raw, &request.section_ids)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let bytes = document_bytes(&after, doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let project_revision = raw_revision(&bytes);

    let plan = Plan {
        project_id: doc.project_id.clone(),
        project_path: project.path.clone(),
        creates_project_folder: false,
        project_file_revision: project_revision.clone(),
        sections: Vec::new(),
        text_block: None,
        manifest_write: None,
    };
    let expected = ReorderedProjectSections {
        operation_id: request.operation_id.clone(),
        project_id: doc.project_id.clone(),
        section_ids: request.section_ids.clone(),
        project_revision,
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
        plan,
        expected_result: serde_json::to_value(&expected)
            .map_err(|error| io_failure("serialize", error))?,
        extra: BTreeMap::new(),
    };
    journal::validate_journal(&journal)?;
    let write = ProjectWrite::Replace {
        expected_revision: request.expected_project_revision.clone(),
        bytes,
    };
    let (done, warnings) = run(env, journal, resumed.is_some(), write)?;
    finish(
        done.expected_result,
        false,
        warnings,
        |result: &mut ReorderedProjectSections, _, warnings| {
            result.warnings = warnings;
        },
    )
}

// ---------------------------------------------------------------------------
// Shared text manifest loading
// ---------------------------------------------------------------------------

struct LoadedTextManifest {
    manifest_rel_path: String,
    pre_text: String,
    parsed: ParsedJson<DatabaseManifest>,
}

fn load_text_manifest(env: &Env, doc: &ProjectDoc) -> Result<LoadedTextManifest, ProjectError> {
    if doc.raw.get("text").and_then(Value::as_object).is_none() {
        return Err(ProjectError::TextNotConfigured);
    }
    let database_id = doc
        .sections
        .iter()
        .find(|section| section.role.as_deref() == Some(ROLE_TEXT))
        .map(|section| section.database_id.clone())
        .ok_or(ProjectError::TextNotConfigured)?;
    let container = find_database_container(env.vault, &database_id)
        .map_err(|_| ProjectError::TextNotConfigured)?;
    let manifest_path = manifest_path_for_container(&container);
    let manifest_rel_path = durable::relative_string(env.vault, &manifest_path, LABEL)
        .map_err(|message| ProjectError::failed("invalidPath", message))?;
    let bytes = fs::read(&manifest_path)
        .map_err(|error| ProjectError::failed("readManifest", error.to_string()))?;
    let pre_text = String::from_utf8(bytes.clone())
        .map_err(|error| ProjectError::failed("readManifest", error.to_string()))?;
    let parsed = parse_manifest(&bytes)
        .map_err(|error| ProjectError::failed("textSchemaBroken", error.to_string()))?;
    if !parsed.is_writable() || parsed.value.locked {
        return Err(ProjectError::failed(
            "databaseLocked",
            "The text database manifest is locked or read-only",
        ));
    }
    Ok(LoadedTextManifest {
        manifest_rel_path,
        pre_text,
        parsed,
    })
}

fn keep_old_name_as_alias(aliases: &mut Vec<String>, old_name: &str, new_name: &str) {
    if old_name.is_empty() || old_name == new_name {
        return;
    }
    if !aliases
        .iter()
        .any(|alias| alias.eq_ignore_ascii_case(old_name))
    {
        aliases.push(old_name.to_owned());
    }
}

fn clean_option_aliases(options: &mut [SelectOption]) {
    let names: Vec<String> = options
        .iter()
        .map(|option| option.name.to_lowercase())
        .collect();
    for option in options.iter_mut() {
        option
            .aliases
            .retain(|alias| !names.contains(&alias.to_lowercase()));
    }
}

// ---------------------------------------------------------------------------
// Update text levels (rename, icon, reorder, add new levels)
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
    request: &UpdateTextLevelsRequest,
) -> Result<UpdatedTextLevels, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let normalized = normalize_level_updates(&request.levels)?;

    let revision = request_revision(&json!({
        "projectId": request.project_id,
        "expectedProjectRevision": request.expected_project_revision,
        "levels": normalized
            .iter()
            .map(|entry| json!({"id": entry.id, "name": entry.name, "icon": entry.icon}))
            .collect::<Vec<_>>(),
    }))?;

    let resumed = match replay(env, &request.operation_id, OP_UPDATE_TEXT_LEVELS, &revision)? {
        Replay::Done(value) => {
            return finish(
                value,
                true,
                Vec::new(),
                |result: &mut UpdatedTextLevels, replayed, warnings| {
                    result.replayed = replayed;
                    result.warnings = warnings;
                },
            )
        }
        Replay::Resume(journal) => Some(journal),
        Replay::Fresh => None,
    };

    let project = find_project(env, &request.project_id)?;
    let doc = &project.doc;
    check_writable_project(doc, &request.expected_project_revision)?;
    let loaded = load_text_manifest(env, doc)?;

    let existing_level_ids: Vec<String> = doc
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

    let level_property_id = doc
        .raw
        .pointer("/text/properties/level")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProjectError::failed("textSchemaBroken", "text.properties.level is missing")
        })?
        .to_owned();

    let resumed_ids: Option<Vec<String>> = resumed
        .as_ref()
        .and_then(|journal| journal.plan.text_block.as_ref())
        .and_then(|block| block.get("levels"))
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .filter(|ids: &Vec<String>| ids.len() == normalized.len());

    let mut planned_levels: Vec<(String, Option<String>, String)> =
        Vec::with_capacity(normalized.len());
    for (index, item) in normalized.into_iter().enumerate() {
        let id = match item.id {
            Some(existing) => existing,
            None => resumed_ids
                .as_ref()
                .and_then(|ids| ids.get(index).cloned())
                .unwrap_or_else(|| ulid::Ulid::generate().to_string()),
        };
        planned_levels.push((id, item.icon, item.name));
    }

    let mut manifest = loaded.parsed.value.clone();
    let property = manifest
        .properties
        .iter_mut()
        .find(|candidate| candidate.id() == Some(level_property_id.as_str()))
        .ok_or_else(|| {
            ProjectError::failed("textSchemaBroken", "the level property was deleted")
        })?;
    let PropertyDefinition::Select(fields) = property else {
        return Err(ProjectError::failed(
            "textSchemaBroken",
            "the level property is not a Select",
        ));
    };

    let previous = std::mem::take(&mut fields.config.options);
    let mut next_options = Vec::with_capacity(previous.len().max(planned_levels.len()));
    let mut handled_ids = HashSet::new();
    for (id, _, name) in &planned_levels {
        handled_ids.insert(id.clone());
        let mut option = previous
            .iter()
            .find(|opt| &opt.id == id)
            .cloned()
            .unwrap_or_else(|| SelectOption {
                id: id.clone(),
                name: String::new(),
                color: "#94a3b8".to_owned(),
                aliases: Vec::new(),
                extra: Default::default(),
            });
        keep_old_name_as_alias(&mut option.aliases, &option.name, name);
        option.name = name.clone();
        next_options.push(option);
    }
    for extra_option in previous {
        if !handled_ids.contains(&extra_option.id) {
            next_options.push(extra_option);
        }
    }
    clean_option_aliases(&mut next_options);
    fields.config.options = next_options;

    if !validate_manifest(&manifest).errors.is_empty() {
        return Err(ProjectError::failed(
            "schemaBuild",
            "Level update would make the text database manifest invalid",
        ));
    }
    let prepared_manifest = prepare_json(&loaded.parsed, &manifest)
        .map_err(|error| ProjectError::failed("serialize", error.to_string()))?;
    let post_text = String::from_utf8(prepared_manifest.bytes)
        .map_err(|error| ProjectError::failed("serialize", error.to_string()))?;

    let file_levels: Vec<(String, Option<String>)> = planned_levels
        .iter()
        .map(|(id, icon, _)| (id.clone(), icon.clone()))
        .collect();
    let after = with_text_levels_updated(&doc.raw, &file_levels)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let bytes = document_bytes(&after, doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let project_revision = raw_revision(&bytes);
    let level_ids: Vec<String> = file_levels.into_iter().map(|(id, _)| id).collect();

    let plan = Plan {
        project_id: doc.project_id.clone(),
        project_path: project.path.clone(),
        creates_project_folder: false,
        project_file_revision: project_revision.clone(),
        sections: Vec::new(),
        text_block: after.get("text").cloned(),
        manifest_write: Some(PlannedManifestWrite {
            manifest_path: loaded.manifest_rel_path,
            pre_revision: loaded.parsed.revision,
            post_revision: prepared_manifest.revision.clone(),
            pre_text: loaded.pre_text,
            post_text,
        }),
    };
    let expected = UpdatedTextLevels {
        operation_id: request.operation_id.clone(),
        project_id: doc.project_id.clone(),
        project_revision,
        manifest_revision: prepared_manifest.revision,
        level_ids,
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
        plan,
        expected_result: serde_json::to_value(&expected)
            .map_err(|error| io_failure("serialize", error))?,
        extra: BTreeMap::new(),
    };
    journal::validate_journal(&journal)?;
    let write = ProjectWrite::Replace {
        expected_revision: request.expected_project_revision.clone(),
        bytes,
    };
    let (done, warnings) = run(env, journal, resumed.is_some(), write)?;
    finish(
        done.expected_result,
        false,
        warnings,
        |result: &mut UpdatedTextLevels, _, warnings| {
            result.warnings = warnings;
        },
    )
}

// ---------------------------------------------------------------------------
// Add page status property to an existing story's text database
// ---------------------------------------------------------------------------

fn resumed_status_ids(journal: &Journal, option_count: usize) -> Option<PlannedPropertyIds> {
    let property_id = journal
        .plan
        .text_block
        .as_ref()?
        .pointer("/properties/status")?
        .as_str()?
        .to_owned();
    let post_text = &journal.plan.manifest_write.as_ref()?.post_text;
    let parsed = parse_manifest(post_text.as_bytes()).ok()?;
    let property = parsed
        .value
        .properties
        .iter()
        .find(|prop| prop.id() == Some(property_id.as_str()))?;
    let PropertyDefinition::Status(fields) = property else {
        return None;
    };
    if fields.config.options.len() != option_count {
        return None;
    }
    Some(PlannedPropertyIds {
        property_id,
        option_ids: fields
            .config
            .options
            .iter()
            .map(|opt| opt.id.clone())
            .collect(),
    })
}

pub fn add_text_status(
    env: &Env,
    request: &AddTextStatusRequest,
) -> Result<AddedTextStatus, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let (property_name, status_names) = resolve_status_labels(&request.labels)?;

    let revision = request_revision(&json!({
        "projectId": request.project_id,
        "expectedProjectRevision": request.expected_project_revision,
        "labels": request.labels,
    }))?;

    let resumed = match replay(env, &request.operation_id, OP_ADD_TEXT_STATUS, &revision)? {
        Replay::Done(value) => {
            return finish(
                value,
                true,
                Vec::new(),
                |result: &mut AddedTextStatus, replayed, warnings| {
                    result.replayed = replayed;
                    result.warnings = warnings;
                },
            )
        }
        Replay::Resume(journal) => Some(journal),
        Replay::Fresh => None,
    };

    let project = find_project(env, &request.project_id)?;
    let doc = &project.doc;
    check_writable_project(doc, &request.expected_project_revision)?;
    let loaded = load_text_manifest(env, doc)?;

    if let Some(existing_status_id) = doc
        .raw
        .pointer("/text/properties/status")
        .and_then(Value::as_str)
    {
        if loaded
            .parsed
            .value
            .properties
            .iter()
            .any(|prop| prop.id() == Some(existing_status_id))
        {
            return Err(ProjectError::StatusAlreadyConfigured);
        }
    }

    if loaded.parsed.value.properties.iter().any(|prop| {
        prop.name()
            .is_some_and(|existing| existing.trim().eq_ignore_ascii_case(&property_name))
    }) {
        return Err(ProjectError::InvalidName {
            field: "schemaName".to_owned(),
            reason: "duplicate".to_owned(),
        });
    }

    let planned_ids = resumed
        .as_ref()
        .and_then(|journal| resumed_status_ids(journal, status_names.len()))
        .unwrap_or_else(|| PlannedPropertyIds::generate(status_names.len()));

    let spec = CreateDatabasePropertyRequest {
        database_id: loaded.parsed.value.database_id.clone(),
        property_type: "status".to_owned(),
        options: status_names,
        ..Default::default()
    };
    let (definition, _, property_id) = build_new_property(
        env.vault,
        &loaded.parsed.value,
        &spec,
        &property_name,
        false,
        Some(&planned_ids),
    )
    .map_err(|message| ProjectError::failed("schemaBuild", message))?;

    let mut manifest = loaded.parsed.value.clone();
    manifest.properties.push(definition);
    if !validate_manifest(&manifest).errors.is_empty() {
        return Err(ProjectError::failed(
            "schemaBuild",
            "Status property would make the text database manifest invalid",
        ));
    }
    let prepared_manifest = prepare_json(&loaded.parsed, &manifest)
        .map_err(|error| ProjectError::failed("serialize", error.to_string()))?;
    let post_text = String::from_utf8(prepared_manifest.bytes)
        .map_err(|error| ProjectError::failed("serialize", error.to_string()))?;

    let after = with_text_status_property(&doc.raw, &property_id)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let bytes = document_bytes(&after, doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let project_revision = raw_revision(&bytes);

    let plan = Plan {
        project_id: doc.project_id.clone(),
        project_path: project.path.clone(),
        creates_project_folder: false,
        project_file_revision: project_revision.clone(),
        sections: Vec::new(),
        text_block: after.get("text").cloned(),
        manifest_write: Some(PlannedManifestWrite {
            manifest_path: loaded.manifest_rel_path,
            pre_revision: loaded.parsed.revision,
            post_revision: prepared_manifest.revision.clone(),
            pre_text: loaded.pre_text,
            post_text,
        }),
    };
    let expected = AddedTextStatus {
        operation_id: request.operation_id.clone(),
        project_id: doc.project_id.clone(),
        property_id,
        project_revision,
        manifest_revision: prepared_manifest.revision,
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
        plan,
        expected_result: serde_json::to_value(&expected)
            .map_err(|error| io_failure("serialize", error))?,
        extra: BTreeMap::new(),
    };
    journal::validate_journal(&journal)?;
    let write = ProjectWrite::Replace {
        expected_revision: request.expected_project_revision.clone(),
        bytes,
    };
    let (done, warnings) = run(env, journal, resumed.is_some(), write)?;
    finish(
        done.expected_result,
        false,
        warnings,
        |result: &mut AddedTextStatus, _, warnings| {
            result.warnings = warnings;
        },
    )
}
