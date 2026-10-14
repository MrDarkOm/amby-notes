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
use super::format::{document_bytes, with_section_appended, workshop_section_entry, SectionLinks};
use super::journal::{
    create_journal, read_journal, remove_journal, replace_journal, Journal, Plan,
    PlannedManifestWrite, PlannedSection, PlannedStory, JOURNAL_FORMAT, JOURNAL_VERSION,
    OP_CREATE_SECTION, OP_CREATE_STORY, OP_CREATE_WORKSHOP, STATUS_COMPLETED, STATUS_IN_PROGRESS,
};
use super::model::{
    CreateStoryRequest, CreateWorkshopRequest, CreateWorkshopSectionRequest, CreatedStory,
    CreatedWorkshop, CreatedWorkshopSection, CreatedWorkshopSectionResult, ProjectError,
    KNOWN_FORMAT_VERSION, KNOWN_ROLES, ROLE_ANCHORS, ROLE_ARCS, ROLE_CHARACTERS, ROLE_CUSTOM,
    ROLE_LOCATIONS, ROLE_STORIES, ROLE_UNIVERSES, STORY_FILE_NAME, WORKSHOP_FILE_NAME,
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
    BeforeManifest,
    ManifestWritten,
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

pub(super) enum Interrupt {
    Error(String),
    Conflict(String),
    #[cfg_attr(not(test), allow(dead_code))]
    Crash,
}

pub(super) fn checkpoint(step: Step) -> Result<(), Interrupt> {
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

pub(super) fn guarded(vault: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
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

pub(super) fn write_file_safe(
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
// Settling an operation
// ---------------------------------------------------------------------------

/// Closes an operation after its apply step: marks the journal completed, or cleans up through
/// the journal. The structure file reaching its planned bytes is the commit point, so an error
/// after it still reports success.
pub(super) fn settle<T>(
    env: &Env,
    journal: Journal,
    result: T,
    run: Result<(), Interrupt>,
) -> Result<T, ProjectError> {
    match run {
        Ok(()) => {
            let mut journal = journal;
            journal.status = STATUS_COMPLETED.to_owned();
            let _ = replace_journal(env.vault, &journal);
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
                    remove_journal(env.vault, &journal.operation_id);
                    if let Some(actual_revision) = conflict {
                        Err(ProjectError::RevisionConflict { actual_revision })
                    } else {
                        Err(ProjectError::RolledBack {
                            operation_id: journal.operation_id.clone(),
                            message,
                        })
                    }
                }
                Ok(Rollback::Leftovers(left)) => Err(ProjectError::RecoveryRequired {
                    operation_id: journal.operation_id.clone(),
                    message: left.join("; "),
                }),
                Err(e) => Err(e),
            }
        }
    }
}

/// One section of a new workshop: its plan for the journal, its entry in the structure file and
/// its line in the answer.
struct BaseSection {
    planned: PlannedSection,
    entry: Value,
    created: CreatedWorkshopSection,
}

/// Plans a base section (`stories`, `characters`, `locations`). `target_databases` holds the
/// databases planned so far, and every one of them is created by this same operation.
fn plan_base_section(
    env: &Env,
    labels: &BTreeMap<String, String>,
    workshop_rel: &str,
    role: &str,
    default_name: &str,
    target_databases: &mut BTreeMap<String, String>,
) -> Result<BaseSection, ProjectError> {
    let name = normalize_entry_name(
        &format!("section:{role}"),
        labels
            .get(&format!("section:{role}"))
            .or_else(|| labels.get(&format!("preset:{role}")))
            .map(String::as_str)
            .unwrap_or(default_name),
    )?;
    let ids = PlannedDatabaseIds {
        database_id: ulid::Ulid::generate().to_string(),
        view_id: ulid::Ulid::generate().to_string(),
    };
    target_databases.insert(role.to_owned(), ids.database_id.clone());
    let pending = target_databases.values().cloned().collect::<Vec<_>>();
    let preset = presets::plan(
        env.vault,
        role,
        &name,
        &ids,
        labels,
        target_databases,
        &pending,
    )?;
    let entry = workshop_section_entry(role, role, &name, &ids.database_id, &name, &preset.links);
    let created = CreatedWorkshopSection {
        section_id: role.to_owned(),
        role: role.to_owned(),
        name: name.clone(),
        database_id: ids.database_id.clone(),
        path: name.clone(),
        container_path: join_relative(workshop_rel, &name),
        manifest_revision: manifest_revision(&name, &ids, &preset.extras)?,
    };
    let planned = PlannedSection {
        id: role.to_owned(),
        role: role.to_owned(),
        name: name.clone(),
        path: name,
        database_id: ids.database_id,
        view_id: ids.view_id,
        extras: preset.extras,
        template: preset.template,
        stories_property_id: preset.links.stories,
    };
    Ok(BaseSection {
        planned,
        entry,
        created,
    })
}

// ---------------------------------------------------------------------------
// 1. Create Workshop
// ---------------------------------------------------------------------------

/// Everything `create_workshop` decides before the first write, whether freshly planned or read
/// back from a journal on resume (so the IDs and the structure file are the ones already planned).
struct WorkshopPlan {
    planned_sections: Vec<PlannedSection>,
    file_text: String,
    file_revision: String,
    created: CreatedWorkshop,
}

fn workshop_plan_from_journal(journal: &Journal) -> Option<WorkshopPlan> {
    let file_text = journal.plan.workshop_file_text.clone()?;
    let file_revision = journal.plan.workshop_file_revision.clone()?;
    if raw_revision(file_text.as_bytes()) != file_revision || journal.plan.sections.is_empty() {
        return None;
    }
    let created: CreatedWorkshop = serde_json::from_value(journal.expected_result.clone()).ok()?;
    Some(WorkshopPlan {
        planned_sections: journal.plan.sections.clone(),
        file_text,
        file_revision,
        created,
    })
}

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

    let WorkshopPlan {
        planned_sections,
        file_text,
        file_revision: workshop_rev,
        created,
    } = match resumed.as_deref().and_then(workshop_plan_from_journal) {
        Some(plan) => plan,
        None => {
            let workshop_id = ulid::Ulid::generate().to_string();
            let mut target_databases = BTreeMap::new();
            let mut planned_sections = Vec::new();
            let mut section_docs = Vec::new();
            let mut created_sections = Vec::new();
            for (role, default_name) in [
                (ROLE_STORIES, "Истории"),
                (ROLE_CHARACTERS, "Персонажи"),
                (ROLE_LOCATIONS, "Локации"),
            ] {
                let base = plan_base_section(
                    env,
                    &request.labels,
                    &workshop_rel,
                    role,
                    default_name,
                    &mut target_databases,
                )?;
                planned_sections.push(base.planned);
                section_docs.push(base.entry);
                created_sections.push(base.created);
            }

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
                workshop_id,
                name: name.clone(),
                path: workshop_rel.clone(),
                file_path: join_relative(&workshop_rel, WORKSHOP_FILE_NAME),
                file_revision: workshop_rev.clone(),
                sections: created_sections,
                replayed: false,
                warnings: Vec::new(),
            };
            WorkshopPlan {
                planned_sections,
                file_text: String::from_utf8(workshop_bytes)
                    .map_err(|e| io_failure("serialize", e))?,
                file_revision: workshop_rev,
                created,
            }
        }
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_CREATE_WORKSHOP.to_owned(),
        request_revision: request_rev,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: Some(created.workshop_id.clone()),
            workshop_path: Some(workshop_rel.clone()),
            creates_workshop_folder: true,
            workshop_file_revision: Some(workshop_rev.clone()),
            sections: planned_sections.clone(),
            story: None,
            story_file_path: None,
            story_file_revision: None,
            workshop_file_text: Some(file_text.clone()),
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
    let run = (|| -> Result<(), Interrupt> {
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
                bytes: file_text.clone().into_bytes(),
            },
            &workshop_rev,
            "workshop-structure",
        )?;
        checkpoint(Step::WorkshopFileWritten)?;
        checkpoint(Step::BeforeCompletion)?;
        Ok(())
    })();

    settle(env, journal, created, run)
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

/// The anchors and arcs databases a story made now can point at: those the workshop has and whose
/// database is on disk. A missing one is left out; `ensure_plot_links` offers it later.
fn plot_targets(
    env: &Env,
    workshop: &super::discovery::DiscoveredWorkshop,
) -> text_schema::PlotTargets {
    let existing = |role: &str| {
        workshop
            .doc
            .sections
            .iter()
            .find(|section| section.role == role)
            .map(|section| section.database_id.clone())
            .filter(|id| crate::database::mutations::find_database_container(env.vault, id).is_ok())
    };
    text_schema::PlotTargets {
        anchors_database_id: existing(ROLE_ANCHORS),
        arcs_database_id: existing(ROLE_ARCS),
    }
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
        let plot = plot_targets(env, workshop);
        let planned_schema = text_schema::plan(
            env.vault,
            &title,
            &text_ids,
            &request.labels,
            level_names.as_deref(),
            &plot,
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
            workshop_file_text: None,
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

/// Everything `create_workshop_section` decides before the first write, fresh or read back from
/// a journal. Creating the universes section also adds the "Universe" relation to the stories
/// section, which is why a manifest write can be part of it.
struct SectionPlan {
    planned: PlannedSection,
    file_text: String,
    file_revision: String,
    manifest_write: Option<PlannedManifestWrite>,
    result: CreatedWorkshopSectionResult,
}

fn section_plan_from_journal(journal: &Journal) -> Option<SectionPlan> {
    let file_text = journal.plan.workshop_file_text.clone()?;
    let file_revision = journal.plan.workshop_file_revision.clone()?;
    if raw_revision(file_text.as_bytes()) != file_revision || journal.plan.sections.len() != 1 {
        return None;
    }
    let result: CreatedWorkshopSectionResult =
        serde_json::from_value(journal.expected_result.clone()).ok()?;
    Some(SectionPlan {
        planned: journal.plan.sections[0].clone(),
        file_text,
        file_revision,
        manifest_write: journal.plan.manifest_write.clone(),
        result,
    })
}

pub fn create_workshop_section(
    env: &Env,
    request: &CreateWorkshopSectionRequest,
) -> Result<CreatedWorkshopSectionResult, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let request_rev = request_revision(&serde_json::to_value(request).unwrap())?;

    let resumed = match replay(env, &request.operation_id, OP_CREATE_SECTION, &request_rev)? {
        Replay::Fresh => None,
        Replay::Resume(journal) => Some(journal),
        Replay::Done(value) => {
            let mut created: CreatedWorkshopSectionResult =
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

    let SectionPlan {
        planned: planned_section,
        file_text,
        file_revision: updated_rev,
        manifest_write,
        result,
    } = match resumed.as_deref().and_then(section_plan_from_journal) {
        Some(plan) => plan,
        None => plan_section(env, workshop, request, role, &name)?,
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
            workshop_file_text: Some(file_text.clone()),
            manifest_write: manifest_write.clone(),
        },
        expected_result: serde_json::to_value(&result).unwrap(),
        extra: BTreeMap::new(),
    };

    if resumed.is_some() {
        replace_journal(env.vault, &journal)?;
    } else {
        create_journal(env.vault, &journal)?;
    }

    // Apply
    let run = (|| -> Result<(), Interrupt> {
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
                name: planned_section.name.clone(),
            },
            Some(&planned_ids(&planned_section)),
            &planned_section.extras,
        )
        .map_err(Interrupt::Error)?;

        if let Some(template) = &planned_section.template {
            write_template(
                env,
                &workshop_dir.join(&planned_section.path),
                &planned_section,
                template,
            )?;
        }
        checkpoint(Step::DatabaseCreated(0))?;

        if let Some(write) = &manifest_write {
            checkpoint(Step::BeforeManifest)?;
            super::links::write_planned_manifest(env, write)?;
            checkpoint(Step::ManifestWritten)?;
        }

        checkpoint(Step::BeforeWorkshopFile)?;
        write_file_safe(
            env,
            &workshop_dir.join(WORKSHOP_FILE_NAME),
            &FileWrite::Replace {
                expected_revision: workshop.doc.revision.clone(),
                bytes: file_text.clone().into_bytes(),
            },
            &updated_rev,
            "workshop-structure",
        )?;
        checkpoint(Step::WorkshopFileWritten)?;
        checkpoint(Step::BeforeCompletion)?;
        Ok(())
    })();

    settle(env, journal, result, run)
}

/// Plans a new section from scratch: its database, its entry in the structure file and, for the
/// universes section, the "Universe" relation that joins the stories section.
fn plan_section(
    env: &Env,
    workshop: &super::discovery::DiscoveredWorkshop,
    request: &CreateWorkshopSectionRequest,
    role: &str,
    name: &str,
) -> Result<SectionPlan, ProjectError> {
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
        name,
        &ids,
        &request.labels,
        &target_databases,
        &[],
    )?;

    let planned = PlannedSection {
        id: section_id.clone(),
        role: role.to_owned(),
        name: name.to_owned(),
        path: name.to_owned(),
        database_id: ids.database_id.clone(),
        view_id: ids.view_id.clone(),
        extras: preset.extras.clone(),
        template: preset.template.clone(),
        stories_property_id: preset.links.stories.clone(),
    };

    let new_entry = workshop_section_entry(
        &section_id,
        role,
        name,
        &ids.database_id,
        name,
        &preset.links,
    );
    let mut updated_doc =
        with_section_appended(&workshop.doc.raw, new_entry).map_err(|e| io_failure("format", e))?;

    // The first universe also gives the stories a "Universe" relation, in the same operation.
    let mut manifest_write = None;
    if role == ROLE_UNIVERSES {
        if let Some(stories) = workshop
            .doc
            .sections
            .iter()
            .find(|s| s.role == ROLE_STORIES && s.universe_property_id.is_none())
        {
            match super::links::plan_link(
                env.vault,
                super::links::LinkKind::Universe,
                &stories.database_id,
                &ids.database_id,
                std::slice::from_ref(&ids.database_id),
                &request.labels,
                false,
            ) {
                Ok(link) => {
                    updated_doc = super::format::with_section_links(
                        &updated_doc,
                        &stories.id,
                        &SectionLinks {
                            universe: Some(link.property_id),
                            ..SectionLinks::default()
                        },
                    )
                    .map_err(|e| io_failure("format", e))?;
                    manifest_write = link.write;
                }
                // A stories database that cannot take the relation (missing, locked, read-only)
                // never stops a universe from being made; "Link to universes" offers it again.
                Err(ProjectError::StoryLinksUnavailable { .. }) => {}
                Err(other) => return Err(other),
            }
        }
    }
    // The first arcs also give the anchors an "Arcs" relation, in the same operation. Anchors
    // made earlier and the stories' texts get theirs later (`ensure_plot_links`).
    if role == ROLE_ARCS {
        if let Some(anchors) = workshop
            .doc
            .sections
            .iter()
            .find(|s| s.role == ROLE_ANCHORS && s.arcs_property_id.is_none())
        {
            match super::links::plan_link(
                env.vault,
                super::links::LinkKind::Arcs,
                &anchors.database_id,
                &ids.database_id,
                std::slice::from_ref(&ids.database_id),
                &request.labels,
                false,
            ) {
                Ok(link) => {
                    updated_doc = super::format::with_section_links(
                        &updated_doc,
                        &anchors.id,
                        &SectionLinks {
                            arcs: Some(link.property_id),
                            ..SectionLinks::default()
                        },
                    )
                    .map_err(|e| io_failure("format", e))?;
                    manifest_write = link.write;
                }
                // Anchors that cannot take the relation (locked, or a property of the same name
                // already there) never stop arcs from being made; `ensure_plot_links` offers it.
                Err(
                    ProjectError::StoryLinksUnavailable { .. } | ProjectError::InvalidName { .. },
                ) => {}
                Err(other) => return Err(other),
            }
        }
    }

    let updated_bytes = document_bytes(&updated_doc, workshop.doc.has_bom)
        .map_err(|e| io_failure("serialize", e))?;
    let updated_rev = raw_revision(&updated_bytes);

    let created_section = CreatedWorkshopSection {
        section_id,
        role: role.to_owned(),
        name: name.to_owned(),
        database_id: ids.database_id.clone(),
        path: name.to_owned(),
        container_path: join_relative(&workshop.path, name),
        manifest_revision: manifest_revision(name, &ids, &preset.extras)?,
    };

    Ok(SectionPlan {
        planned,
        file_text: String::from_utf8(updated_bytes).map_err(|e| io_failure("serialize", e))?,
        file_revision: updated_rev.clone(),
        manifest_write,
        result: CreatedWorkshopSectionResult {
            operation_id: request.operation_id.clone(),
            workshop_id: request.workshop_id.clone(),
            section: created_section,
            workshop_revision: updated_rev,
            replayed: false,
            warnings: Vec::new(),
        },
    })
}
