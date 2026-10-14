//! Creating a workshop, creating a story, and adding a section, each as one journaled operation.
//!
//! Order of every operation: validate and preflight without writing, publish the
//! journal, create the folders and databases through database creation, and write
//! the structure file last. That file is the commit point; if anything fails before it,
//! the journal drives a conditional cleanup. Repeating a call with the same operation ID
//! never creates a second set.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::discovery::discover_projects;
use super::format::{document_bytes, with_section_appended, workshop_section_entry};
use super::journal::{
    create_journal, read_journal, remove_journal, replace_journal, Journal, Plan, PlannedSection,
    PlannedStory, JOURNAL_FORMAT, JOURNAL_VERSION, OP_CREATE_SECTION, OP_CREATE_STORY,
    OP_CREATE_WORKSHOP, STATUS_COMPLETED, STATUS_IN_PROGRESS,
};
use super::model::{
    CreateStoryRequest, CreateWorkshopRequest, CreateWorkshopSectionRequest, CreatedStory,
    CreatedWorkshop, CreatedWorkshopSection, CreatedWorkshopSectionResult, ProjectError,
    KNOWN_FORMAT_VERSION, KNOWN_ROLES, ROLE_CHARACTERS, ROLE_CUSTOM, ROLE_LOCATIONS, ROLE_STORIES,
    STORY_FILE_NAME, WORKSHOP_FILE_NAME,
};
use super::names::{exists_ignoring_case, normalize_entry_name, normalize_icon, normalize_tags};
use super::presets::{self, template_file_bytes, PlannedTemplate};
use super::recovery::{self, Rollback};
use super::text_schema;
use crate::database::format::raw_revision;
use crate::database::mutations::{
    create_database_with_ids, new_database_manifest_bytes, CreateDatabaseRequest,
    DatabaseCreateMode, NewDatabaseExtras, PlannedDatabaseIds,
};
use crate::durable::{self, valid_operation_id};
use crate::frontmatter;
use crate::watcher::{self, WatcherState};

const LABEL: &str = "Creative creation";

pub struct Env<'a> {
    pub vault: &'a Path,
    pub watcher: &'a WatcherState,
}

// ---------------------------------------------------------------------------
// Step checkpoints for fault injection in tests
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    JournalWritten,
    FolderCreated,
    BeforeDatabase(usize),
    DatabaseCreated(usize),
    BeforeWorkshopFile,
    WorkshopFileWritten,
    StoryFolderCreated,
    CardNoteCreated,
    TextDatabaseCreated,
    BeforeStoryFile,
    StoryFileWritten,
    BeforeCompletion,
}

#[cfg(test)]
pub(crate) enum Fault {
    Fail(String),
    Crash,
}

#[cfg(test)]
type StepHook = Box<dyn FnMut(&Step) -> Option<Fault>>;

#[cfg(test)]
thread_local! {
    static STEP_HOOK: std::cell::RefCell<Option<StepHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_step_hook(hook: impl FnMut(&Step) -> Option<Fault> + 'static) {
    STEP_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
pub(crate) fn clear_step_hook() {
    STEP_HOOK.with(|slot| *slot.borrow_mut() = None);
}

enum Interrupt {
    Error(String),
    Conflict(String),
    #[cfg_attr(not(test), allow(dead_code))]
    Crash,
}

fn checkpoint(step: Step) -> Result<(), Interrupt> {
    #[cfg(test)]
    {
        let fault = STEP_HOOK.with(|slot| slot.borrow_mut().as_mut().and_then(|hook| hook(&step)));
        match fault {
            None => Ok(()),
            Some(Fault::Fail(message)) => Err(Interrupt::Error(message)),
            Some(Fault::Crash) => Err(Interrupt::Crash),
        }
    }
    #[cfg(not(test))]
    {
        let _ = step;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub(super) fn io_failure(code: &str, error: impl ToString) -> ProjectError {
    ProjectError::failed(code, error.to_string())
}

pub(super) fn validate_operation_id(value: &str) -> Result<(), ProjectError> {
    if valid_operation_id(value) {
        Ok(())
    } else {
        Err(ProjectError::InvalidOperationId)
    }
}

pub(super) fn request_revision(value: &Value) -> Result<String, ProjectError> {
    let bytes = serde_json::to_vec(value).map_err(|error| io_failure("serialize", error))?;
    Ok(raw_revision(&bytes))
}

pub(super) fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

fn guarded(vault: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
    durable::guarded_path(vault, relative, LABEL)
        .map_err(|message| ProjectError::failed("invalidPath", message))
}

fn committed(path: &Path, revision: &str) -> bool {
    fs::read(path).is_ok_and(|bytes| raw_revision(&bytes) == revision)
}

fn manifest_revision(
    name: &str,
    ids: &PlannedDatabaseIds,
    extras: &NewDatabaseExtras,
) -> Result<String, ProjectError> {
    new_database_manifest_bytes(name, "standalone", ids, extras)
        .map(|bytes| raw_revision(&bytes))
        .map_err(|message| ProjectError::failed("serialize", message))
}

fn planned_ids(section: &PlannedSection) -> PlannedDatabaseIds {
    PlannedDatabaseIds {
        database_id: section.database_id.clone(),
        view_id: section.view_id.clone(),
    }
}

pub(super) enum Replay {
    Fresh,
    Done(Value),
    Resume(Box<Journal>),
}

pub(super) fn replay(
    env: &Env,
    operation_id: &str,
    operation: &str,
    request_revision: &str,
) -> Result<Replay, ProjectError> {
    let Some(mut journal) = read_journal(env.vault, operation_id)? else {
        return Ok(Replay::Fresh);
    };
    if journal.operation != operation || journal.request_revision != request_revision {
        return Err(ProjectError::OperationIdReused {
            operation_id: operation_id.to_owned(),
        });
    }
    if journal.status == STATUS_COMPLETED {
        return Ok(Replay::Done(journal.expected_result));
    }
    match recovery::rollback(env.vault, &journal)? {
        Rollback::Committed => {
            journal.status = STATUS_COMPLETED.to_owned();
            let _ = replace_journal(env.vault, &journal);
            Ok(Replay::Done(journal.expected_result))
        }
        Rollback::Clean => Ok(Replay::Resume(Box::new(journal))),
        Rollback::Leftovers(left) => Err(ProjectError::RecoveryRequired {
            operation_id: operation_id.to_owned(),
            message: left.join("; "),
        }),
    }
}

fn write_template(
    env: &Env,
    container: &Path,
    section: &PlannedSection,
    template: &PlannedTemplate,
) -> Result<(), Interrupt> {
    let bytes = template_file_bytes(&section.database_id, template).map_err(Interrupt::Error)?;
    let path = container
        .join(".ambd")
        .join("templates")
        .join(format!("{}.json", template.template_id));
    let prepared = env
        .watcher
        .prepare_write([(&path, watcher::fingerprint_for_bytes(&bytes))]);
    match durable::create_new(&path, &bytes, LABEL) {
        Ok(()) => {
            env.watcher.confirm_prepared_write(&prepared);
            Ok(())
        }
        Err(error) => {
            env.watcher.cancel_prepared_write(&prepared);
            Err(Interrupt::Error(error))
        }
    }
}

pub(super) enum FileWrite {
    New {
        bytes: Vec<u8>,
    },
    Replace {
        expected_revision: String,
        bytes: Vec<u8>,
    },
}

fn write_file_safe(
    env: &Env,
    path: &Path,
    write: &FileWrite,
    planned_revision: &str,
    history_kind: &'static str,
) -> Result<(), Interrupt> {
    match write {
        FileWrite::New { bytes } => {
            let prepared = env
                .watcher
                .prepare_write([(&path, watcher::fingerprint_for_bytes(bytes))]);
            match durable::create_new(path, bytes, LABEL) {
                Ok(()) => {
                    env.watcher.confirm_prepared_write(&prepared);
                    Ok(())
                }
                Err(error) => {
                    env.watcher.cancel_prepared_write(&prepared);
                    if committed(path, planned_revision) {
                        Ok(())
                    } else {
                        Err(Interrupt::Error(error))
                    }
                }
            }
        }
        FileWrite::Replace {
            expected_revision,
            bytes,
        } => {
            let current = fs::read(path).map_err(|error| Interrupt::Error(error.to_string()))?;
            let actual = raw_revision(&current);
            if actual != *expected_revision {
                return Err(Interrupt::Conflict(actual));
            }
            crate::history::snapshot_before_write(env.vault, path, bytes, history_kind)
                .map_err(Interrupt::Error)?;
            let prepared = env
                .watcher
                .prepare_write([(&path, watcher::fingerprint_for_bytes(bytes))]);
            match frontmatter::atomic_write_bytes(path, bytes) {
                Ok(()) => {
                    env.watcher.confirm_prepared_write(&prepared);
                    Ok(())
                }
                Err(error) => {
                    env.watcher.cancel_prepared_write(&prepared);
                    if committed(path, planned_revision) {
                        Ok(())
                    } else {
                        Err(Interrupt::Error(error))
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 1. Create Workshop
// ---------------------------------------------------------------------------

pub fn create_workshop(
    env: &Env,
    request: &CreateWorkshopRequest,
) -> Result<CreatedWorkshop, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let request_rev = request_revision(&serde_json::to_value(request).unwrap())?;

    let resumed = match replay(env, &request.operation_id, OP_CREATE_WORKSHOP, &request_rev)? {
        Replay::Fresh => None,
        Replay::Resume(j) => Some(j),
        Replay::Done(value) => {
            let mut created: CreatedWorkshop =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            created.replayed = true;
            return Ok(created);
        }
    };

    for key in request.labels.keys() {
        let is_valid = if let Some(role) = key.strip_prefix("section:") {
            KNOWN_ROLES.contains(&role)
        } else {
            presets::is_preset_label(key) || text_schema::is_schema_label(key)
        };
        if !is_valid {
            return Err(ProjectError::InvalidName {
                field: "labels".to_owned(),
                reason: "unknown label".to_owned(),
            });
        }
    }

    let name = normalize_entry_name("name", &request.name)?;
    let parent_rel = request.parent_path.as_deref().unwrap_or("").trim();
    let parent_dir = if parent_rel.is_empty() {
        env.vault.to_path_buf()
    } else {
        if parent_rel.starts_with(".amby") || parent_rel.split('/').any(|seg| seg.starts_with('.'))
        {
            return Err(ProjectError::InvalidParent {
                reason: "cannot create inside hidden or reserved folder".to_owned(),
            });
        }
        guarded(env.vault, parent_rel).map_err(|e| ProjectError::InvalidParent {
            reason: e.to_string(),
        })?
    };
    if !parent_dir.is_dir() {
        return Err(ProjectError::InvalidParent {
            reason: "not a directory".to_owned(),
        });
    }
    let workshop_rel = join_relative(parent_rel, &name);

    if exists_ignoring_case(&parent_dir, &name)? {
        return Err(ProjectError::PathCollision { path: workshop_rel });
    }
    let workshop_dir = guarded(env.vault, &workshop_rel)?;

    let icon = normalize_icon(request.icon.as_deref())?;
    let tags = normalize_tags(&request.tags)?;

    let workshop_id = ulid::Ulid::generate().to_string();

    // Plan base sections: stories, characters, locations
    let mut planned_sections = Vec::new();
    let mut section_docs = Vec::new();
    let mut created_sections = Vec::new();
    let mut target_databases = BTreeMap::new();

    // Stories section first
    let stories_name = normalize_entry_name(
        "section:stories",
        request
            .labels
            .get("section:stories")
            .or_else(|| request.labels.get("preset:stories"))
            .map(String::as_str)
            .unwrap_or("Истории"),
    )?;
    let stories_ids = PlannedDatabaseIds {
        database_id: ulid::Ulid::generate().to_string(),
        view_id: ulid::Ulid::generate().to_string(),
    };
    target_databases.insert("stories".to_owned(), stories_ids.database_id.clone());

    let stories_preset = presets::plan(
        env.vault,
        ROLE_STORIES,
        &stories_name,
        &stories_ids,
        &request.labels,
        &target_databases,
        &target_databases.values().cloned().collect::<Vec<_>>(),
    )?;
    let stories_section = PlannedSection {
        id: "stories".to_owned(),
        role: ROLE_STORIES.to_owned(),
        name: stories_name.clone(),
        path: stories_name.clone(),
        database_id: stories_ids.database_id.clone(),
        view_id: stories_ids.view_id.clone(),
        extras: stories_preset.extras.clone(),
        template: stories_preset.template,
    };
    section_docs.push(workshop_section_entry(
        "stories",
        ROLE_STORIES,
        &stories_name,
        &stories_ids.database_id,
        &stories_name,
    ));
    created_sections.push(CreatedWorkshopSection {
        section_id: "stories".to_owned(),
        role: ROLE_STORIES.to_owned(),
        name: stories_name.clone(),
        database_id: stories_ids.database_id.clone(),
        path: stories_name.clone(),
        container_path: join_relative(&workshop_rel, &stories_name),
        manifest_revision: manifest_revision(&stories_name, &stories_ids, &stories_preset.extras)?,
    });
    planned_sections.push(stories_section);

    // Characters section
    let chars_name = normalize_entry_name(
        "section:characters",
        request
            .labels
            .get("section:characters")
            .or_else(|| request.labels.get("preset:characters"))
            .map(String::as_str)
            .unwrap_or("Персонажи"),
    )?;
    let chars_ids = PlannedDatabaseIds {
        database_id: ulid::Ulid::generate().to_string(),
        view_id: ulid::Ulid::generate().to_string(),
    };
    target_databases.insert("characters".to_owned(), chars_ids.database_id.clone());

    let chars_preset = presets::plan(
        env.vault,
        ROLE_CHARACTERS,
        &chars_name,
        &chars_ids,
        &request.labels,
        &target_databases,
        &target_databases.values().cloned().collect::<Vec<_>>(),
    )?;
    let chars_section = PlannedSection {
        id: "characters".to_owned(),
        role: ROLE_CHARACTERS.to_owned(),
        name: chars_name.clone(),
        path: chars_name.clone(),
        database_id: chars_ids.database_id.clone(),
        view_id: chars_ids.view_id.clone(),
        extras: chars_preset.extras.clone(),
        template: chars_preset.template.clone(),
    };
    section_docs.push(workshop_section_entry(
        "characters",
        ROLE_CHARACTERS,
        &chars_name,
        &chars_ids.database_id,
        &chars_name,
    ));
    created_sections.push(CreatedWorkshopSection {
        section_id: "characters".to_owned(),
        role: ROLE_CHARACTERS.to_owned(),
        name: chars_name.clone(),
        database_id: chars_ids.database_id.clone(),
        path: chars_name.clone(),
        container_path: join_relative(&workshop_rel, &chars_name),
        manifest_revision: manifest_revision(&chars_name, &chars_ids, &chars_preset.extras)?,
    });
    planned_sections.push(chars_section);

    // Locations section
    let locs_name = normalize_entry_name(
        "section:locations",
        request
            .labels
            .get("section:locations")
            .or_else(|| request.labels.get("preset:locations"))
            .map(String::as_str)
            .unwrap_or("Локации"),
    )?;
    let locs_ids = PlannedDatabaseIds {
        database_id: ulid::Ulid::generate().to_string(),
        view_id: ulid::Ulid::generate().to_string(),
    };

    let locs_preset = presets::plan(
        env.vault,
        ROLE_LOCATIONS,
        &locs_name,
        &locs_ids,
        &request.labels,
        &target_databases,
        &target_databases.values().cloned().collect::<Vec<_>>(),
    )?;
    let locs_section = PlannedSection {
        id: "locations".to_owned(),
        role: ROLE_LOCATIONS.to_owned(),
        name: locs_name.clone(),
        path: locs_name.clone(),
        database_id: locs_ids.database_id.clone(),
        view_id: locs_ids.view_id.clone(),
        extras: locs_preset.extras.clone(),
        template: locs_preset.template.clone(),
    };
    section_docs.push(workshop_section_entry(
        "locations",
        ROLE_LOCATIONS,
        &locs_name,
        &locs_ids.database_id,
        &locs_name,
    ));
    created_sections.push(CreatedWorkshopSection {
        section_id: "locations".to_owned(),
        role: ROLE_LOCATIONS.to_owned(),
        name: locs_name.clone(),
        database_id: locs_ids.database_id.clone(),
        path: locs_name.clone(),
        container_path: join_relative(&workshop_rel, &locs_name),
        manifest_revision: manifest_revision(&locs_name, &locs_ids, &locs_preset.extras)?,
    });
    planned_sections.push(locs_section);

    // Workshop document
    let mut workshop_doc_val = json!({
        "formatVersion": KNOWN_FORMAT_VERSION,
        "workshopId": workshop_id,
        "name": name,
        "tags": tags,
        "sections": section_docs,
    });
    if let Some(ic) = &icon {
        workshop_doc_val["icon"] = json!(ic);
    }
    let workshop_bytes =
        document_bytes(&workshop_doc_val, false).map_err(|e| io_failure("serialize", e))?;
    let workshop_rev = raw_revision(&workshop_bytes);

    let created = CreatedWorkshop {
        operation_id: request.operation_id.clone(),
        workshop_id: workshop_id.clone(),
        name: name.clone(),
        path: workshop_rel.clone(),
        file_path: join_relative(&workshop_rel, WORKSHOP_FILE_NAME),
        file_revision: workshop_rev.clone(),
        sections: created_sections,
        replayed: false,
        warnings: Vec::new(),
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_CREATE_WORKSHOP.to_owned(),
        request_revision: request_rev,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: Some(workshop_id),
            workshop_path: Some(workshop_rel.clone()),
            creates_workshop_folder: true,
            workshop_file_revision: Some(workshop_rev.clone()),
            sections: planned_sections.clone(),
            story: None,
            story_file_path: None,
            story_file_revision: None,
            manifest_write: None,
        },
        expected_result: serde_json::to_value(&created).unwrap(),
        extra: BTreeMap::new(),
    };

    if resumed.is_some() {
        replace_journal(env.vault, &journal)?;
    } else {
        create_journal(env.vault, &journal)?;
    }

    // Apply
    let run_res = (|| -> Result<(), Interrupt> {
        checkpoint(Step::JournalWritten)?;
        fs::create_dir(&workshop_dir).map_err(|e| Interrupt::Error(e.to_string()))?;
        checkpoint(Step::FolderCreated)?;

        for (i, section) in planned_sections.iter().enumerate() {
            checkpoint(Step::BeforeDatabase(i))?;
            create_database_with_ids(
                env.vault,
                env.watcher,
                &CreateDatabaseRequest {
                    expected_generation: 0,
                    mode: DatabaseCreateMode::Standalone,
                    parent_path: Some(workshop_dir.to_string_lossy().to_string()),
                    note_path: None,
                    name: section.name.clone(),
                },
                Some(&planned_ids(section)),
                &section.extras,
            )
            .map_err(Interrupt::Error)?;

            if let Some(template) = &section.template {
                write_template(env, &workshop_dir.join(&section.path), section, template)?;
            }
            checkpoint(Step::DatabaseCreated(i))?;
        }

        checkpoint(Step::BeforeWorkshopFile)?;
        write_file_safe(
            env,
            &workshop_dir.join(WORKSHOP_FILE_NAME),
            &FileWrite::New {
                bytes: workshop_bytes,
            },
            &workshop_rev,
            "workshop-structure",
        )?;
        checkpoint(Step::WorkshopFileWritten)?;
        checkpoint(Step::BeforeCompletion)?;
        Ok(())
    })();

    match run_res {
        Ok(()) => {
            let mut j = journal;
            j.status = STATUS_COMPLETED.to_owned();
            let _ = replace_journal(env.vault, &j);
            Ok(created)
        }
        Err(interrupt) => {
            let message = match interrupt {
                Interrupt::Crash => {
                    return Err(ProjectError::failed("interrupted", "operation interrupted"))
                }
                Interrupt::Error(m) => m,
                Interrupt::Conflict(_) => "conflict".to_owned(),
            };
            match recovery::rollback(env.vault, &journal) {
                Ok(Rollback::Committed) => Ok(created),
                Ok(Rollback::Clean) => {
                    remove_journal(env.vault, &request.operation_id);
                    Err(ProjectError::RolledBack {
                        operation_id: request.operation_id.clone(),
                        message,
                    })
                }
                Ok(Rollback::Leftovers(left)) => Err(ProjectError::RecoveryRequired {
                    operation_id: request.operation_id.clone(),
                    message: left.join("; "),
                }),
                Err(e) => Err(e),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Create Story
// ---------------------------------------------------------------------------

/// Everything `create_story` decides before the first write, whether freshly planned or read
/// back from a journal on resume.
struct StoryPlan {
    story_id: String,
    card_note_id: String,
    database_id: String,
    text_ids: PlannedDatabaseIds,
    planned_schema: text_schema::TextSchema,
    story_file_bytes: Vec<u8>,
    story_file_rev: String,
    card_bytes: Vec<u8>,
    manifest_bytes: Vec<u8>,
}

/// Bytes of a story card. Values are written as JSON strings (a subset of YAML double-quoted
/// scalars, as `create_database_row_with_values` does), so a quote, a backslash or any control
/// character in the title cannot break the frontmatter. The result goes into the journal, and
/// a resume reads these same bytes back instead of recomputing them.
pub(super) fn story_card_bytes(
    card_note_id: &str,
    title: &str,
    story_id: &str,
) -> Result<Vec<u8>, ProjectError> {
    let encode = |value: &str| serde_json::to_string(value).map_err(|e| io_failure("serialize", e));
    Ok(format!(
        "---\namby-id: {}\namby-title: {}\namby-story-id: {}\n---\n\n",
        encode(card_note_id)?,
        encode(title)?,
        encode(story_id)?,
    )
    .into_bytes())
}

pub fn create_story(env: &Env, request: &CreateStoryRequest) -> Result<CreatedStory, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let request_rev = request_revision(&serde_json::to_value(request).unwrap())?;

    let resumed = match replay(env, &request.operation_id, OP_CREATE_STORY, &request_rev)? {
        Replay::Fresh => None,
        Replay::Resume(j) => Some(j),
        Replay::Done(value) => {
            let mut created: CreatedStory =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            created.replayed = true;
            return Ok(created);
        }
    };

    let discovery = discover_projects(env.vault).map_err(|e| io_failure("discovery", e))?;
    let workshop = discovery
        .workshops
        .iter()
        .find(|w| w.doc.workshop_id == request.workshop_id)
        .ok_or_else(|| ProjectError::WorkshopNotFound {
            workshop_id: request.workshop_id.clone(),
        })?;

    if !workshop.doc.is_known_version() {
        return Err(ProjectError::WorkshopReadOnly {
            format_version: workshop.doc.format_version,
        });
    }

    let stories_section = workshop
        .doc
        .sections
        .iter()
        .find(|s| s.role == ROLE_STORIES)
        .ok_or_else(|| {
            ProjectError::failed("missingStoriesSection", "Workshop has no stories section")
        })?;

    let title = normalize_entry_name("title", &request.title)?;
    let workshop_dir = guarded(env.vault, &workshop.path)?;
    let stories_dir = workshop_dir.join(&stories_section.path);
    if !stories_dir.is_dir() {
        return Err(ProjectError::failed(
            "missingStoriesDir",
            "Stories section folder is missing on disk",
        ));
    }

    if exists_ignoring_case(&stories_dir, &title)? {
        return Err(ProjectError::PathCollision {
            path: join_relative(&stories_section.path, &title),
        });
    }

    let story_rel_folder = join_relative(
        &join_relative(&workshop.path, &stories_section.path),
        &title,
    );
    let story_dir = guarded(env.vault, &story_rel_folder)?;

    let card_path_rel = join_relative(&story_rel_folder, &format!("{title}.md"));
    let manifest_path_rel = join_relative(&story_rel_folder, &format!("{title}.json"));
    let story_file_rel = join_relative(&story_rel_folder, STORY_FILE_NAME);

    let StoryPlan {
        story_id,
        card_note_id,
        database_id,
        text_ids,
        planned_schema,
        story_file_bytes,
        story_file_rev,
        card_bytes,
        manifest_bytes,
    } = if let Some(planned_story) = resumed.as_ref().and_then(|j| j.plan.story.as_ref()) {
        let story_doc_val: Value = serde_json::from_slice(&planned_story.story_file_bytes)
            .map_err(|e| io_failure("deserialize", e))?;
        let card_note_id =
            frontmatter::parse_markdown(&String::from_utf8_lossy(&planned_story.card_bytes))
                .note_id()
                .unwrap_or_default()
                .to_owned();
        let manifest = crate::database::format::parse_manifest(&planned_story.manifest_bytes)
            .map_err(|e| io_failure("deserialize", e))?
            .value;
        let text_ids = PlannedDatabaseIds {
            database_id: manifest.database_id.clone(),
            view_id: manifest.default_view_id.unwrap_or_default(),
        };
        let text_schema = text_schema::TextSchema {
            properties: manifest
                .properties
                .into_iter()
                .map(|p| serde_json::to_value(p).unwrap_or_default())
                .collect(),
            text_block: story_doc_val.get("text").cloned().unwrap_or_default(),
        };
        StoryPlan {
            story_id: planned_story.story_id.clone(),
            card_note_id,
            database_id: manifest.database_id,
            text_ids,
            planned_schema: text_schema,
            story_file_bytes: planned_story.story_file_bytes.clone(),
            story_file_rev: planned_story.story_file_revision.clone(),
            card_bytes: planned_story.card_bytes.clone(),
            manifest_bytes: planned_story.manifest_bytes.clone(),
        }
    } else {
        let story_id = ulid::Ulid::generate().to_string();
        let card_note_id = ulid::Ulid::generate().to_string();
        let database_id = ulid::Ulid::generate().to_string();
        let view_id = ulid::Ulid::generate().to_string();

        let level_names = match &request.text_levels {
            Some(levels) => Some(text_schema::normalize_text_levels(levels)?),
            None => None,
        };

        let text_ids = PlannedDatabaseIds {
            database_id: database_id.clone(),
            view_id,
        };
        let planned_schema = text_schema::plan(
            env.vault,
            &title,
            &text_ids,
            &request.labels,
            level_names.as_deref(),
        )?;

        let story_doc_val = json!({
            "formatVersion": KNOWN_FORMAT_VERSION,
            "storyId": story_id,
            "text": planned_schema.text_block,
        });
        let story_file_bytes =
            document_bytes(&story_doc_val, false).map_err(|e| io_failure("serialize", e))?;
        let story_file_rev = raw_revision(&story_file_bytes);

        let card_bytes = story_card_bytes(&card_note_id, &title, &story_id)?;

        let manifest_bytes = crate::database::mutations::new_database_manifest_bytes(
            &title,
            "attached",
            &text_ids,
            &NewDatabaseExtras {
                properties: planned_schema.properties.clone(),
                view: None,
                icon: None,
                template_id: None,
            },
        )
        .map_err(|e| io_failure("manifest", e))?;

        StoryPlan {
            story_id,
            card_note_id,
            database_id,
            text_ids,
            planned_schema,
            story_file_bytes,
            story_file_rev,
            card_bytes,
            manifest_bytes,
        }
    };

    let created = CreatedStory {
        operation_id: request.operation_id.clone(),
        workshop_id: request.workshop_id.clone(),
        story_id: story_id.clone(),
        title: title.clone(),
        folder_path: story_rel_folder.clone(),
        card_path: card_path_rel.clone(),
        card_note_id: card_note_id.clone(),
        database_id: database_id.clone(),
        story_file_revision: story_file_rev.clone(),
        replayed: false,
        warnings: Vec::new(),
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_CREATE_STORY.to_owned(),
        request_revision: request_rev,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: Some(request.workshop_id.clone()),
            workshop_path: Some(workshop.path.clone()),
            creates_workshop_folder: false,
            workshop_file_revision: None,
            sections: Vec::new(),
            story: Some(PlannedStory {
                story_id,
                folder_path: story_rel_folder.clone(),
                card_path: card_path_rel,
                card_bytes: card_bytes.clone(),
                manifest_path: manifest_path_rel,
                manifest_bytes,
                story_file_path: story_file_rel.clone(),
                story_file_bytes: story_file_bytes.clone(),
                story_file_revision: story_file_rev.clone(),
            }),
            story_file_path: Some(story_file_rel.clone()),
            story_file_revision: Some(story_file_rev.clone()),
            manifest_write: None,
        },
        expected_result: serde_json::to_value(&created).unwrap(),
        extra: BTreeMap::new(),
    };

    if resumed.is_some() {
        replace_journal(env.vault, &journal)?;
    } else {
        create_journal(env.vault, &journal)?;
    }

    // Apply
    let run_res = (|| -> Result<(), Interrupt> {
        checkpoint(Step::JournalWritten)?;
        fs::create_dir(&story_dir).map_err(|e| Interrupt::Error(e.to_string()))?;
        checkpoint(Step::StoryFolderCreated)?;

        // Write card note
        let card_path = story_dir.join(format!("{title}.md"));
        let prepared_card = env
            .watcher
            .prepare_write([(&card_path, watcher::fingerprint_for_bytes(&card_bytes))]);
        durable::create_new(&card_path, &card_bytes, LABEL).map_err(|e| {
            env.watcher.cancel_prepared_write(&prepared_card);
            Interrupt::Error(e)
        })?;
        env.watcher.confirm_prepared_write(&prepared_card);
        checkpoint(Step::CardNoteCreated)?;

        // Create attached text database
        create_database_with_ids(
            env.vault,
            env.watcher,
            &CreateDatabaseRequest {
                expected_generation: 0,
                mode: DatabaseCreateMode::Attached,
                parent_path: Some(story_dir.to_string_lossy().to_string()),
                note_path: Some(card_path.to_string_lossy().to_string()),
                name: title.clone(),
            },
            Some(&text_ids),
            &NewDatabaseExtras {
                properties: planned_schema.properties,
                view: None,
                icon: None,
                template_id: None,
            },
        )
        .map_err(Interrupt::Error)?;
        checkpoint(Step::TextDatabaseCreated)?;

        // Write amby-story.json (commit point!)
        checkpoint(Step::BeforeStoryFile)?;
        write_file_safe(
            env,
            &story_dir.join(STORY_FILE_NAME),
            &FileWrite::New {
                bytes: story_file_bytes,
            },
            &story_file_rev,
            "story-config",
        )?;
        checkpoint(Step::StoryFileWritten)?;
        checkpoint(Step::BeforeCompletion)?;
        Ok(())
    })();

    match run_res {
        Ok(()) => {
            let mut j = journal;
            j.status = STATUS_COMPLETED.to_owned();
            let _ = replace_journal(env.vault, &j);
            Ok(created)
        }
        Err(interrupt) => {
            let message = match interrupt {
                Interrupt::Crash => {
                    return Err(ProjectError::failed("interrupted", "operation interrupted"))
                }
                Interrupt::Error(m) => m,
                Interrupt::Conflict(_) => "conflict".to_owned(),
            };
            match recovery::rollback(env.vault, &journal) {
                Ok(Rollback::Committed) => Ok(created),
                Ok(Rollback::Clean) => {
                    remove_journal(env.vault, &request.operation_id);
                    Err(ProjectError::RolledBack {
                        operation_id: request.operation_id.clone(),
                        message,
                    })
                }
                Ok(Rollback::Leftovers(left)) => Err(ProjectError::RecoveryRequired {
                    operation_id: request.operation_id.clone(),
                    message: left.join("; "),
                }),
                Err(e) => Err(e),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Create Workshop Section (Lazy W11 & Custom)
// ---------------------------------------------------------------------------

pub fn create_workshop_section(
    env: &Env,
    request: &CreateWorkshopSectionRequest,
) -> Result<CreatedWorkshopSectionResult, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let request_rev = request_revision(&serde_json::to_value(request).unwrap())?;

    match replay(env, &request.operation_id, OP_CREATE_SECTION, &request_rev)? {
        Replay::Fresh | Replay::Resume(_) => {}
        Replay::Done(value) => {
            let mut created: CreatedWorkshopSectionResult =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            created.replayed = true;
            return Ok(created);
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

    if !workshop.doc.is_known_version() {
        return Err(ProjectError::WorkshopReadOnly {
            format_version: workshop.doc.format_version,
        });
    }

    if workshop.doc.revision != request.expected_workshop_revision {
        return Err(ProjectError::RevisionConflict {
            actual_revision: workshop.doc.revision.clone(),
        });
    }

    let role = request.role.trim();
    if !KNOWN_ROLES.contains(&role) {
        return Err(ProjectError::UnsupportedRole {
            role: role.to_owned(),
        });
    }

    // Role cannot duplicate non-custom sections
    if role != ROLE_CUSTOM && workshop.doc.sections.iter().any(|s| s.role == role) {
        return Err(ProjectError::failed(
            "sectionAlreadyExists",
            format!("Section with role {role} already exists in workshop"),
        ));
    }

    let name = normalize_entry_name("name", &request.name)?;
    let workshop_dir = guarded(env.vault, &workshop.path)?;
    if exists_ignoring_case(&workshop_dir, &name)? {
        return Err(ProjectError::PathCollision {
            path: join_relative(&workshop.path, &name),
        });
    }

    let section_id = if role != ROLE_CUSTOM {
        role.to_owned()
    } else {
        ulid::Ulid::generate().to_string()
    };

    let ids = PlannedDatabaseIds {
        database_id: ulid::Ulid::generate().to_string(),
        view_id: ulid::Ulid::generate().to_string(),
    };

    let mut target_databases = BTreeMap::new();
    for s in &workshop.doc.sections {
        target_databases.insert(s.role.clone(), s.database_id.clone());
    }

    let preset = presets::plan(
        env.vault,
        role,
        &name,
        &ids,
        &request.labels,
        &target_databases,
        &[],
    )?;

    let planned_section = PlannedSection {
        id: section_id.clone(),
        role: role.to_owned(),
        name: name.clone(),
        path: name.clone(),
        database_id: ids.database_id.clone(),
        view_id: ids.view_id.clone(),
        extras: preset.extras.clone(),
        template: preset.template.clone(),
    };

    let new_entry = workshop_section_entry(&section_id, role, &name, &ids.database_id, &name);
    let updated_doc =
        with_section_appended(&workshop.doc.raw, new_entry).map_err(|e| io_failure("format", e))?;
    let updated_bytes = document_bytes(&updated_doc, workshop.doc.has_bom)
        .map_err(|e| io_failure("serialize", e))?;
    let updated_rev = raw_revision(&updated_bytes);

    let created_section = CreatedWorkshopSection {
        section_id: section_id.clone(),
        role: role.to_owned(),
        name: name.clone(),
        database_id: ids.database_id.clone(),
        path: name.clone(),
        container_path: join_relative(&workshop.path, &name),
        manifest_revision: manifest_revision(&name, &ids, &preset.extras)?,
    };

    let result = CreatedWorkshopSectionResult {
        operation_id: request.operation_id.clone(),
        workshop_id: request.workshop_id.clone(),
        section: created_section,
        workshop_revision: updated_rev.clone(),
        replayed: false,
        warnings: Vec::new(),
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_CREATE_SECTION.to_owned(),
        request_revision: request_rev,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: Some(request.workshop_id.clone()),
            workshop_path: Some(workshop.path.clone()),
            creates_workshop_folder: false,
            workshop_file_revision: Some(updated_rev.clone()),
            sections: vec![planned_section.clone()],
            story: None,
            story_file_path: None,
            story_file_revision: None,
            manifest_write: None,
        },
        expected_result: serde_json::to_value(&result).unwrap(),
        extra: BTreeMap::new(),
    };

    create_journal(env.vault, &journal)?;

    // Apply
    let run_res = (|| -> Result<(), Interrupt> {
        checkpoint(Step::JournalWritten)?;
        checkpoint(Step::BeforeDatabase(0))?;

        create_database_with_ids(
            env.vault,
            env.watcher,
            &CreateDatabaseRequest {
                expected_generation: 0,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(workshop_dir.to_string_lossy().to_string()),
                note_path: None,
                name: name.clone(),
            },
            Some(&ids),
            &preset.extras,
        )
        .map_err(Interrupt::Error)?;

        if let Some(template) = &preset.template {
            write_template(env, &workshop_dir.join(&name), &planned_section, template)?;
        }
        checkpoint(Step::DatabaseCreated(0))?;

        checkpoint(Step::BeforeWorkshopFile)?;
        write_file_safe(
            env,
            &workshop_dir.join(WORKSHOP_FILE_NAME),
            &FileWrite::Replace {
                expected_revision: workshop.doc.revision.clone(),
                bytes: updated_bytes,
            },
            &updated_rev,
            "workshop-structure",
        )?;
        checkpoint(Step::WorkshopFileWritten)?;
        checkpoint(Step::BeforeCompletion)?;
        Ok(())
    })();

    match run_res {
        Ok(()) => {
            let mut j = journal;
            j.status = STATUS_COMPLETED.to_owned();
            let _ = replace_journal(env.vault, &j);
            Ok(result)
        }
        Err(interrupt) => {
            let (message, conflict) = match interrupt {
                Interrupt::Crash => {
                    return Err(ProjectError::failed("interrupted", "operation interrupted"))
                }
                Interrupt::Error(m) => (m, None),
                Interrupt::Conflict(actual) => ("revision conflict".to_owned(), Some(actual)),
            };
            match recovery::rollback(env.vault, &journal) {
                Ok(Rollback::Committed) => Ok(result),
                Ok(Rollback::Clean) => {
                    remove_journal(env.vault, &request.operation_id);
                    if let Some(actual_revision) = conflict {
                        Err(ProjectError::RevisionConflict { actual_revision })
                    } else {
                        Err(ProjectError::RolledBack {
                            operation_id: request.operation_id.clone(),
                            message,
                        })
                    }
                }
                Ok(Rollback::Leftovers(left)) => Err(ProjectError::RecoveryRequired {
                    operation_id: request.operation_id.clone(),
                    message: left.join("; "),
                }),
                Err(e) => Err(e),
            }
        }
    }
}
