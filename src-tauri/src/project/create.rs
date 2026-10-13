//! Creating a project and adding a section, each as one journaled operation.
//!
//! Order of every operation: validate and preflight without writing, publish the
//! journal, create the folder and the section databases through the existing
//! database creation, and write the structure file last. That file is the commit
//! point; if anything fails before it, the journal drives a conditional cleanup.
//! Repeating a call with the same operation ID never creates a second set.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use super::discovery::{discover_projects, DiscoveredProject};
use super::format::{
    document_bytes, parse_project_file, section_entry, with_section_appended, ProjectDoc,
};
use super::journal::{
    self, create_journal, read_journal, remove_journal, replace_journal, Journal, Plan,
    PlannedSection, JOURNAL_FORMAT, JOURNAL_VERSION, OP_CREATE_PROJECT, OP_CREATE_SECTION,
    STATUS_COMPLETED, STATUS_IN_PROGRESS,
};
use super::model::{
    CreateProjectRequest, CreateProjectSectionRequest, CreatedProject, CreatedProjectSection,
    CreatedSection, ProjectError, ProjectKind, KNOWN_FORMAT_VERSION, KNOWN_ROLES,
    PROJECT_FILE_NAME, ROLE_CHARACTERS, ROLE_LOCATIONS, ROLE_NOTES, ROLE_TEXT,
};
use super::names::{
    exists_ignoring_case, normalize_entry_name, normalize_icon, normalize_tags, normalize_title,
};
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

const LABEL: &str = "Project creation";

pub struct Env<'a> {
    pub vault: &'a Path,
    pub watcher: &'a WatcherState,
}

// ---------------------------------------------------------------------------
// Step checkpoints. In production they do nothing; tests use them to fail or
// "crash" the operation at every durable boundary.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    JournalWritten,
    FolderCreated,
    BeforeDatabase(usize),
    DatabaseCreated(usize),
    BeforeProjectFile,
    ProjectFileWritten,
    BeforeCompletion,
}

#[cfg(test)]
pub(crate) enum Fault {
    /// An ordinary error at this step: the operation cleans up after itself.
    Fail(String),
    /// The process dies here: nothing runs after this point.
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
    /// Only tests simulate a process that dies mid-operation.
    #[cfg_attr(not(test), allow(dead_code))]
    Crash,
}

fn checkpoint(step: Step) -> Result<(), Interrupt> {
    #[cfg(test)]
    {
        let fault = STEP_HOOK.with(|slot| slot.borrow_mut().as_mut().and_then(|hook| hook(&step)));
        return match fault {
            None => Ok(()),
            Some(Fault::Fail(message)) => Err(Interrupt::Error(message)),
            Some(Fault::Crash) => Err(Interrupt::Crash),
        };
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

fn created_section(
    project_path: &str,
    section: &PlannedSection,
) -> Result<CreatedProjectSection, ProjectError> {
    Ok(CreatedProjectSection {
        section_id: section.id.clone(),
        role: section.role.clone(),
        group_id: section.group_id.clone(),
        name: section.name.clone(),
        database_id: section.database_id.clone(),
        path: section.path.clone(),
        container_path: join_relative(project_path, &section.path),
        manifest_revision: manifest_revision(
            &section.name,
            &planned_ids(section),
            &section.extras,
        )?,
    })
}

/// Replays an earlier operation recorded under the same ID.
pub(super) enum Replay {
    /// No journal: a new operation.
    Fresh,
    /// Finished before; the recorded answer stands.
    Done(Value),
    /// An unfinished journal was cleaned up; its IDs are reused.
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
            // The work is on disk; a failed bookkeeping write only costs a
            // second cleanup pass at the next activation.
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

// ---------------------------------------------------------------------------
// Applying a plan
// ---------------------------------------------------------------------------

pub(super) enum ProjectWrite {
    /// The structure file does not exist yet.
    New { bytes: Vec<u8> },
    /// Replace the file the caller last saw, after a history snapshot.
    Replace {
        expected_revision: String,
        bytes: Vec<u8>,
    },
}

fn guarded(vault: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
    durable::guarded_path(vault, relative, LABEL)
        .map_err(|message| ProjectError::failed("invalidPath", message))
}

fn committed(path: &Path, revision: &str) -> bool {
    fs::read(path).is_ok_and(|bytes| raw_revision(&bytes) == revision)
}

fn write_project_file(
    env: &Env,
    project_dir: &Path,
    write: &ProjectWrite,
    planned_revision: &str,
) -> Result<(), Interrupt> {
    let path = project_dir.join(PROJECT_FILE_NAME);
    match write {
        ProjectWrite::New { bytes } => {
            let prepared = env
                .watcher
                .prepare_write([(&path, watcher::fingerprint_for_bytes(bytes))]);
            match durable::create_new(&path, bytes, LABEL) {
                Ok(()) => {
                    env.watcher.confirm_prepared_write(&prepared);
                    Ok(())
                }
                Err(error) => {
                    env.watcher.cancel_prepared_write(&prepared);
                    // A failure after the file appeared (directory sync) still
                    // leaves a committed project.
                    if committed(&path, planned_revision) {
                        Ok(())
                    } else {
                        Err(Interrupt::Error(error))
                    }
                }
            }
        }
        ProjectWrite::Replace {
            expected_revision,
            bytes,
        } => {
            let current = fs::read(&path).map_err(|error| Interrupt::Error(error.to_string()))?;
            let actual = raw_revision(&current);
            if actual != *expected_revision {
                return Err(Interrupt::Conflict(actual));
            }
            crate::history::snapshot_before_write(env.vault, &path, bytes, "project-structure")
                .map_err(Interrupt::Error)?;
            let prepared = env
                .watcher
                .prepare_write([(&path, watcher::fingerprint_for_bytes(bytes))]);
            match frontmatter::atomic_write_bytes(&path, bytes) {
                Ok(()) => {
                    env.watcher.confirm_prepared_write(&prepared);
                    Ok(())
                }
                Err(error) => {
                    env.watcher.cancel_prepared_write(&prepared);
                    if committed(&path, planned_revision) {
                        Ok(())
                    } else {
                        Err(Interrupt::Error(error))
                    }
                }
            }
        }
    }
}

/// The page template a preset lists in its manifest, written next to it.
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

fn write_manifest(env: &Env, mw: &super::journal::PlannedManifestWrite) -> Result<(), Interrupt> {
    if mw.pre_revision == mw.post_revision {
        return Ok(());
    }
    let path = guarded(env.vault, &mw.manifest_path)
        .map_err(|error| Interrupt::Error(error.to_string()))?;
    let current = fs::read(&path).map_err(|error| Interrupt::Error(error.to_string()))?;
    let actual = raw_revision(&current);
    if actual == mw.post_revision {
        return Ok(());
    }
    if actual != mw.pre_revision {
        return Err(Interrupt::Error("Manifest revision conflict".to_owned()));
    }
    let bytes = mw.post_text.as_bytes();
    crate::history::snapshot_before_write(env.vault, &path, bytes, "database-schema")
        .map_err(Interrupt::Error)?;
    let prepared = env
        .watcher
        .prepare_write([(&path, watcher::fingerprint_for_bytes(bytes))]);
    match frontmatter::atomic_write_bytes(&path, bytes) {
        Ok(()) => {
            env.watcher.confirm_prepared_write(&prepared);
            Ok(())
        }
        Err(error) => {
            env.watcher.cancel_prepared_write(&prepared);
            if committed(&path, &mw.post_revision) {
                Ok(())
            } else {
                Err(Interrupt::Error(error))
            }
        }
    }
}

fn apply(env: &Env, journal: &Journal, write: &ProjectWrite) -> Result<(), Interrupt> {
    let plan = &journal.plan;
    let project_dir = guarded(env.vault, &plan.project_path)
        .map_err(|error| Interrupt::Error(error.to_string()))?;
    checkpoint(Step::JournalWritten)?;
    if plan.creates_project_folder {
        fs::create_dir(&project_dir).map_err(|error| Interrupt::Error(error.to_string()))?;
        checkpoint(Step::FolderCreated)?;
    }
    for (index, section) in plan.sections.iter().enumerate() {
        checkpoint(Step::BeforeDatabase(index))?;
        create_database_with_ids(
            env.vault,
            env.watcher,
            &CreateDatabaseRequest {
                expected_generation: 0,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(project_dir.to_string_lossy().to_string()),
                note_path: None,
                name: section.name.clone(),
            },
            Some(&planned_ids(section)),
            &section.extras,
        )
        .map_err(Interrupt::Error)?;
        if let Some(template) = &section.template {
            write_template(env, &project_dir.join(&section.path), section, template)?;
        }
        checkpoint(Step::DatabaseCreated(index))?;
    }
    if let Some(mw) = &plan.manifest_write {
        write_manifest(env, mw)?;
    }
    checkpoint(Step::BeforeProjectFile)?;
    write_project_file(env, &project_dir, write, &plan.project_file_revision)?;
    checkpoint(Step::ProjectFileWritten)?;
    Ok(())
}

/// Publishes the journal (unless resuming), applies the plan, and either
/// finishes the journal or cleans up. Returns the final journal and warnings.
pub(super) fn run(
    env: &Env,
    mut journal: Journal,
    journal_exists: bool,
    write: ProjectWrite,
) -> Result<(Journal, Vec<String>), ProjectError> {
    let operation_id = journal.operation_id.clone();
    if !journal_exists {
        create_journal(env.vault, &journal)?;
    }
    let mut warnings = Vec::new();
    if let Err(interrupt) = apply(env, &journal, &write) {
        let (message, conflict) = match interrupt {
            Interrupt::Crash => {
                return Err(ProjectError::failed("interrupted", "operation interrupted"))
            }
            Interrupt::Error(message) => (message, None),
            Interrupt::Conflict(actual) => ("revision conflict".to_owned(), Some(actual)),
        };
        match recovery::rollback(env.vault, &journal) {
            // The error arrived after the commit point: the work stands.
            Ok(Rollback::Committed) => {}
            Ok(Rollback::Clean) => {
                remove_journal(env.vault, &operation_id);
                return Err(match conflict {
                    Some(actual_revision) => ProjectError::RevisionConflict { actual_revision },
                    None => ProjectError::RolledBack {
                        operation_id,
                        message,
                    },
                });
            }
            Ok(Rollback::Leftovers(left)) => {
                return Err(ProjectError::RecoveryRequired {
                    operation_id,
                    message: format!("{message}; left in place: {}", left.join("; ")),
                })
            }
            Err(error) => {
                return Err(ProjectError::RecoveryRequired {
                    operation_id,
                    message: format!("{message}; {error}"),
                })
            }
        }
    }
    match checkpoint(Step::BeforeCompletion) {
        Err(Interrupt::Crash) => {
            return Err(ProjectError::failed("interrupted", "operation interrupted"))
        }
        Err(_) => warnings.push("The operation journal was not finalized".to_owned()),
        Ok(()) => {
            journal.status = STATUS_COMPLETED.to_owned();
            if replace_journal(env.vault, &journal).is_err() {
                // Committed work stays; the next activation marks the journal done.
                journal.status = STATUS_IN_PROGRESS.to_owned();
                warnings.push("The operation journal was not finalized".to_owned());
            }
        }
    }
    Ok((journal, warnings))
}

pub(super) fn finish<T: serde::de::DeserializeOwned>(
    value: Value,
    replayed: bool,
    warnings: Vec<String>,
    patch: impl FnOnce(&mut T, bool, Vec<String>),
) -> Result<T, ProjectError> {
    let mut result: T =
        serde_json::from_value(value).map_err(|error| io_failure("projectJournal", error))?;
    patch(&mut result, replayed, warnings);
    Ok(result)
}

// ---------------------------------------------------------------------------
// Create project
// ---------------------------------------------------------------------------

struct GroupSpec {
    id: &'static str,
    name: String,
}

struct SectionSpec {
    role: &'static str,
    group: &'static str,
    name: String,
}

fn default_section_name(role: &str) -> &'static str {
    match role {
        ROLE_TEXT => "Текст",
        ROLE_NOTES => "Заметки",
        ROLE_CHARACTERS => "Персонажи",
        _ => "Локации",
    }
}

fn default_group_name(id: &str) -> &'static str {
    if id == "work" {
        "Произведение"
    } else {
        "Мир"
    }
}

/// The base sections of a kind, with their group, named from `labels` or the
/// Russian defaults.
fn base_layout(
    kind: ProjectKind,
    base_sections: bool,
    labels: &BTreeMap<String, String>,
) -> Result<(Vec<GroupSpec>, Vec<SectionSpec>), ProjectError> {
    for key in labels.keys() {
        let known = key
            .strip_prefix("section:")
            .is_some_and(|role| KNOWN_ROLES.contains(&role))
            || matches!(key.as_str(), "group:work" | "group:world")
            || super::text_schema::is_schema_label(key)
            || presets::is_preset_label(key);
        if !known {
            return Err(ProjectError::InvalidName {
                field: "labels".to_owned(),
                reason: format!("unknown label {key}"),
            });
        }
    }
    if !base_sections {
        return Ok((Vec::new(), Vec::new()));
    }
    let layout: &[(&'static str, &'static str)] = match kind {
        ProjectKind::Story => &[
            (ROLE_TEXT, "work"),
            (ROLE_NOTES, "work"),
            (ROLE_CHARACTERS, "world"),
            (ROLE_LOCATIONS, "world"),
        ],
        ProjectKind::Collection => &[(ROLE_CHARACTERS, "world"), (ROLE_LOCATIONS, "world")],
    };
    let mut groups: Vec<GroupSpec> = Vec::new();
    let mut sections = Vec::new();
    for (role, group) in layout {
        if !groups.iter().any(|spec| spec.id == *group) {
            let name = labels
                .get(&format!("group:{group}"))
                .map(String::as_str)
                .unwrap_or_else(|| default_group_name(group));
            groups.push(GroupSpec {
                id: group,
                name: normalize_title("groupName", name)?,
            });
        }
        let name = labels
            .get(&format!("section:{role}"))
            .map(String::as_str)
            .unwrap_or_else(|| default_section_name(role));
        sections.push(SectionSpec {
            role,
            group,
            name: normalize_entry_name("sectionName", name)?,
        });
    }
    let mut seen: Vec<String> = Vec::new();
    for section in &sections {
        let lower = section.name.to_lowercase();
        if seen.contains(&lower) {
            return Err(ProjectError::InvalidName {
                field: "sectionName".to_owned(),
                reason: "duplicate".to_owned(),
            });
        }
        seen.push(lower);
    }
    Ok((groups, sections))
}

/// Folder parts of the parent, relative to the vault, checked against the
/// vault boundary, reserved folders and symlinks.
fn resolve_parent(vault: &Path, parent: Option<&str>) -> Result<String, ProjectError> {
    let invalid = |reason: &str| ProjectError::InvalidParent {
        reason: reason.to_owned(),
    };
    let relative = match parent.map(str::trim).filter(|value| !value.is_empty()) {
        None => String::new(),
        Some(parent) => {
            let path = Path::new(parent);
            let absolute = if path.is_absolute() {
                path.to_path_buf()
            } else {
                vault.join(path)
            };
            let confined =
                crate::paths::confine(vault, &absolute).map_err(|message| invalid(&message))?;
            let relative = confined
                .strip_prefix(vault)
                .map_err(|_| invalid("outside the vault"))?;
            let mut parts = Vec::new();
            for component in relative.components() {
                match component {
                    std::path::Component::Normal(part) => parts.push(
                        part.to_str()
                            .ok_or_else(|| invalid("not valid UTF-8"))?
                            .to_owned(),
                    ),
                    _ => return Err(invalid("unsafe path")),
                }
            }
            parts.join("/")
        }
    };
    if relative
        .split('/')
        .filter(|part| !part.is_empty())
        .any(|part| part.starts_with('.') || crate::vault::scan::is_service_directory(part))
    {
        return Err(invalid("reserved folder"));
    }
    if !relative.is_empty() {
        crate::paths::confine_rel_no_symlinks(vault, &relative)
            .map_err(|message| invalid(&message))?;
    }
    if !vault.join(&relative).is_dir() {
        return Err(invalid("not a folder"));
    }
    Ok(relative)
}

/// Enforces the nesting rules against the structure files above `parent`.
fn check_ancestors(vault: &Path, parent: &str, kind: ProjectKind) -> Result<(), ProjectError> {
    let mut folders = vec![String::new()];
    let mut current = String::new();
    for part in parent.split('/').filter(|part| !part.is_empty()) {
        current = join_relative(&current, part);
        folders.push(current.clone());
    }
    for folder in folders {
        let file = vault.join(&folder).join(PROJECT_FILE_NAME);
        let Ok(metadata) = fs::symlink_metadata(&file) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(bytes) = fs::read(&file) else {
            continue;
        };
        // A damaged file is not a project, so it imposes no rule.
        let Ok(doc) = parse_project_file(&bytes) else {
            continue;
        };
        if !doc.is_known_version() {
            return Err(ProjectError::ParentProjectReadOnly { path: folder });
        }
        if doc.kind == ProjectKind::Collection && kind == ProjectKind::Collection {
            return Err(ProjectError::NestedCollectionUnsupported {
                ancestor_path: folder,
            });
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewGroup<'a> {
    id: &'a str,
    name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewSection<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<&'a str>,
    database_id: &'a str,
    path: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewProjectFile<'a> {
    format_version: u64,
    kind: &'a str,
    project_id: &'a str,
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<&'a str>,
    tags: &'a [String],
    groups: Vec<NewGroup<'a>>,
    sections: Vec<NewSection<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a Value>,
}

/// The text levels a request names, normalized, or `None` for the template's four. Naming them
/// where no text section is created is a mistake of the caller, refused before any write.
fn resolve_text_levels(
    raw: Option<&[String]>,
    creates_text: bool,
) -> Result<Option<Vec<String>>, ProjectError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if !creates_text {
        return Err(ProjectError::InvalidName {
            field: "textLevels".to_owned(),
            reason: "no text section".to_owned(),
        });
    }
    text_schema::normalize_text_levels(raw).map(Some)
}

/// Puts the named levels into the payload a request's revision is computed from. A request that
/// names none hashes exactly as it did before the field existed, so an operation journaled by an
/// older build still matches its repeat.
fn with_text_levels(mut payload: Value, levels: Option<&[String]>) -> Value {
    if let (Some(levels), Some(object)) = (levels, payload.as_object_mut()) {
        object.insert("textLevels".to_owned(), json!(levels));
    }
    payload
}

/// Fixes what a section is created with: the text schema for a story's text, a preset for a
/// world section. When an earlier attempt of the same operation is resumed, its journal wins,
/// so the IDs are the ones already planned. Returns the `text` block for the structure file.
fn plan_contents(
    env: &Env,
    section: &mut PlannedSection,
    preset: Option<&str>,
    earlier: Option<&PlannedSection>,
    labels: &BTreeMap<String, String>,
    text_levels: Option<&[String]>,
) -> Result<Option<Value>, ProjectError> {
    if let Some(earlier) = earlier {
        section.extras = earlier.extras.clone();
        section.template = earlier.template.clone();
        return Ok(None);
    }
    if section.role.as_deref() == Some(ROLE_TEXT) {
        let schema = text_schema::plan(
            env.vault,
            &section.name,
            &planned_ids(section),
            labels,
            text_levels,
        )?;
        section.extras.properties = schema.properties;
        return Ok(Some(schema.text_block));
    }
    if let Some(preset) = preset {
        let plan = presets::plan(
            env.vault,
            preset,
            &section.name,
            &planned_ids(section),
            labels,
        )?;
        section.extras = plan.extras;
        section.template = Some(plan.template);
    }
    Ok(None)
}

pub fn create_project(
    env: &Env,
    request: &CreateProjectRequest,
) -> Result<CreatedProject, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let name = normalize_entry_name("name", &request.name)?;
    let tags = normalize_tags(&request.tags)?;
    let icon = normalize_icon(request.icon.as_deref())?;
    let (groups, specs) = base_layout(request.kind, request.base_sections, &request.labels)?;
    let text_levels = resolve_text_levels(
        request.text_levels.as_deref(),
        request.kind == ProjectKind::Story && request.base_sections,
    )?;
    let parent_hint = request
        .parent_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let revision = request_revision(&with_text_levels(
        json!({
            "kind": request.kind.as_str(),
            "name": name,
            "parentPath": parent_hint,
            "icon": icon,
            "tags": tags,
            "groups": groups.iter().map(|group| json!([group.id, group.name])).collect::<Vec<_>>(),
            "sections": specs.iter().map(|spec| json!([spec.role, spec.group, spec.name])).collect::<Vec<_>>(),
            "labels": request.labels,
        }),
        text_levels.as_deref(),
    ))?;

    let resumed = match replay(env, &request.operation_id, OP_CREATE_PROJECT, &revision)? {
        Replay::Done(value) => {
            return finish(
                value,
                true,
                Vec::new(),
                |result: &mut CreatedProject, replayed, warnings| {
                    result.replayed = replayed;
                    result.warnings = warnings;
                },
            )
        }
        Replay::Resume(journal) => Some(journal),
        Replay::Fresh => None,
    };

    // Preflight: nothing is written until every check has passed.
    let parent = resolve_parent(env.vault, parent_hint)?;
    check_ancestors(env.vault, &parent, request.kind)?;
    let project_path = join_relative(&parent, &name);
    if exists_ignoring_case(&env.vault.join(&parent), &name)? {
        return Err(ProjectError::PathCollision { path: project_path });
    }

    let (project_id, planned): (String, Vec<(String, PlannedDatabaseIds)>) = match &resumed {
        Some(journal) => {
            if journal.plan.sections.len() != specs.len() {
                return Err(ProjectError::failed(
                    "projectJournal",
                    "journal does not match the request",
                ));
            }
            (
                journal.plan.project_id.clone(),
                journal
                    .plan
                    .sections
                    .iter()
                    .map(|section| (section.id.clone(), planned_ids(section)))
                    .collect(),
            )
        }
        None => (
            ulid::Ulid::generate().to_string(),
            specs
                .iter()
                .map(|spec| (spec.role.to_owned(), PlannedDatabaseIds::generate()))
                .collect(),
        ),
    };
    let mut sections = specs
        .iter()
        .zip(planned)
        .map(|(spec, (id, ids))| PlannedSection {
            id,
            role: Some(spec.role.to_owned()),
            group_id: Some(spec.group.to_owned()),
            name: spec.name.clone(),
            path: spec.name.clone(),
            database_id: ids.database_id,
            view_id: ids.view_id,
            extras: NewDatabaseExtras::default(),
            template: None,
        })
        .collect::<Vec<_>>();
    // The text database gets its system properties, a world section its preset, each in one
    // manifest; a resumed attempt keeps what its journal planned.
    let mut text_block: Option<Value> = resumed
        .as_ref()
        .and_then(|journal| journal.plan.text_block.clone());
    for section in sections.iter_mut() {
        let preset = section
            .role
            .as_deref()
            .filter(|role| presets::is_preset(role))
            .map(str::to_owned);
        let earlier = resumed.as_ref().and_then(|journal| {
            journal
                .plan
                .sections
                .iter()
                .find(|earlier| earlier.id == section.id)
        });
        if let Some(block) = plan_contents(
            env,
            section,
            preset.as_deref(),
            earlier,
            &request.labels,
            text_levels.as_deref(),
        )? {
            text_block = Some(block);
        }
    }

    let file = NewProjectFile {
        format_version: KNOWN_FORMAT_VERSION,
        kind: request.kind.as_str(),
        project_id: &project_id,
        name: &name,
        icon: icon.as_deref(),
        tags: &tags,
        groups: groups
            .iter()
            .map(|group| NewGroup {
                id: group.id,
                name: &group.name,
            })
            .collect(),
        sections: sections
            .iter()
            .map(|section| NewSection {
                id: &section.id,
                role: section.role.as_deref(),
                group: section.group_id.as_deref(),
                database_id: &section.database_id,
                path: &section.path,
            })
            .collect(),
        text: text_block.as_ref(),
    };
    let mut bytes =
        serde_json::to_vec_pretty(&file).map_err(|error| io_failure("serialize", error))?;
    bytes.push(b'\n');
    let file_revision = raw_revision(&bytes);

    let plan = Plan {
        project_id: project_id.clone(),
        project_path: project_path.clone(),
        creates_project_folder: true,
        project_file_revision: file_revision.clone(),
        sections,
        text_block: text_block.clone(),
        manifest_write: None,
    };
    let expected = CreatedProject {
        operation_id: request.operation_id.clone(),
        project_id,
        kind: request.kind,
        name,
        path: project_path.clone(),
        file_path: join_relative(&project_path, PROJECT_FILE_NAME),
        file_revision,
        sections: plan
            .sections
            .iter()
            .map(|section| created_section(&project_path, section))
            .collect::<Result<_, _>>()?,
        replayed: false,
        warnings: Vec::new(),
    };
    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_CREATE_PROJECT.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan,
        expected_result: serde_json::to_value(&expected)
            .map_err(|error| io_failure("serialize", error))?,
        extra: BTreeMap::new(),
    };
    journal::validate_journal(&journal)?;
    let (done, warnings) = run(env, journal, resumed.is_some(), ProjectWrite::New { bytes })?;
    finish(
        done.expected_result,
        false,
        warnings,
        |result: &mut CreatedProject, _, warnings| {
            result.warnings = warnings;
        },
    )
}

// ---------------------------------------------------------------------------
// Create section
// ---------------------------------------------------------------------------

pub(super) fn find_project(env: &Env, project_id: &str) -> Result<DiscoveredProject, ProjectError> {
    discover_projects(env.vault)
        .map_err(|message| ProjectError::failed("discoveryFailed", message))?
        .projects
        .into_iter()
        .find(|project| project.doc.project_id == project_id)
        .ok_or_else(|| ProjectError::ProjectNotFound {
            project_id: project_id.to_owned(),
        })
}

fn validate_section_role(doc: &ProjectDoc, role: Option<&str>) -> Result<(), ProjectError> {
    let Some(role) = role else {
        return Ok(());
    };
    if !KNOWN_ROLES.contains(&role) {
        return Err(ProjectError::UnsupportedRole {
            role: role.to_owned(),
        });
    }
    // One text section per story, and only a story has text.
    if role == ROLE_TEXT
        && (doc.kind != ProjectKind::Story
            || doc.text_json.is_some()
            || doc
                .sections
                .iter()
                .any(|section| section.role.as_deref() == Some(ROLE_TEXT)))
    {
        return Err(ProjectError::UnsupportedRole {
            role: role.to_owned(),
        });
    }
    Ok(())
}

pub fn create_project_section(
    env: &Env,
    request: &CreateProjectSectionRequest,
) -> Result<CreatedSection, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let name = normalize_entry_name("name", &request.name)?;
    let role = request.role.as_deref().filter(|role| !role.is_empty());
    let group_id = request
        .group_id
        .as_deref()
        .filter(|group| !group.is_empty());
    let preset = request
        .preset
        .as_deref()
        .filter(|preset| !preset.is_empty());
    if let Some(preset) = preset {
        // A text section has its own schema; a preset is for the world.
        if !presets::is_preset(preset) || role == Some(ROLE_TEXT) {
            return Err(ProjectError::UnsupportedPreset {
                preset: preset.to_owned(),
            });
        }
    }
    let text_levels = resolve_text_levels(request.text_levels.as_deref(), role == Some(ROLE_TEXT))?;
    let revision = request_revision(&with_text_levels(
        json!({
            "projectId": request.project_id,
            "expectedProjectRevision": request.expected_project_revision,
            "name": name,
            "role": role,
            "groupId": group_id,
            "labels": request.labels,
            "preset": preset,
        }),
        text_levels.as_deref(),
    ))?;

    let resumed = match replay(env, &request.operation_id, OP_CREATE_SECTION, &revision)? {
        Replay::Done(value) => {
            return finish(
                value,
                true,
                Vec::new(),
                |result: &mut CreatedSection, replayed, warnings| {
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
    if !doc.is_known_version() {
        return Err(ProjectError::ProjectReadOnly {
            format_version: doc.format_version,
        });
    }
    if doc.revision != request.expected_project_revision {
        return Err(ProjectError::RevisionConflict {
            actual_revision: doc.revision.clone(),
        });
    }
    validate_section_role(doc, role)?;
    if let Some(group) = group_id {
        if !doc.groups.iter().any(|candidate| candidate.id == group) {
            return Err(ProjectError::UnknownGroup {
                group_id: group.to_owned(),
            });
        }
    }
    let project_dir = env.vault.join(&project.path);
    let section_path = join_relative(&project.path, &name);
    let taken = doc
        .sections
        .iter()
        .any(|section| section.path_hint.to_lowercase() == name.to_lowercase());
    if taken || exists_ignoring_case(&project_dir, &name)? {
        return Err(ProjectError::PathCollision { path: section_path });
    }

    let (section_id, ids) = match resumed
        .as_ref()
        .and_then(|journal| journal.plan.sections.first())
    {
        Some(section) => (section.id.clone(), planned_ids(section)),
        None => {
            let mut id = format!("sec_{}", ulid::Ulid::generate().to_string().to_lowercase());
            while doc.sections.iter().any(|section| section.id == id) {
                id = format!("sec_{}", ulid::Ulid::generate().to_string().to_lowercase());
            }
            (id, PlannedDatabaseIds::generate())
        }
    };
    let mut planned = PlannedSection {
        id: section_id,
        role: role.map(str::to_owned),
        group_id: group_id.map(str::to_owned),
        name: name.clone(),
        path: name,
        database_id: ids.database_id,
        view_id: ids.view_id,
        extras: NewDatabaseExtras::default(),
        template: None,
    };
    // A story's text is created with its system properties and the `text` block that names
    // them; a world section with its preset.
    let earlier = resumed
        .as_ref()
        .and_then(|journal| journal.plan.sections.first());
    let mut text_block: Option<Value> = resumed
        .as_ref()
        .and_then(|journal| journal.plan.text_block.clone());
    if let Some(block) = plan_contents(
        env,
        &mut planned,
        preset,
        earlier,
        &request.labels,
        text_levels.as_deref(),
    )? {
        text_block = Some(block);
    }
    let mut after = with_section_appended(
        &doc.raw,
        section_entry(
            &planned.id,
            planned.role.as_deref(),
            planned.group_id.as_deref(),
            &planned.database_id,
            &planned.path,
        ),
    )
    .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    if let Some(block) = &text_block {
        after = text_schema::with_text_block(&after, block)
            .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    }
    let bytes = document_bytes(&after, doc.has_bom)
        .map_err(|message| ProjectError::failed("invalidProjectFile", message))?;
    let project_revision = raw_revision(&bytes);

    let plan = Plan {
        project_id: doc.project_id.clone(),
        project_path: project.path.clone(),
        creates_project_folder: false,
        project_file_revision: project_revision.clone(),
        sections: vec![planned],
        text_block,
        manifest_write: None,
    };
    let expected = CreatedSection {
        operation_id: request.operation_id.clone(),
        project_id: doc.project_id.clone(),
        section: created_section(&project.path, &plan.sections[0])?,
        project_revision,
        replayed: false,
        warnings: Vec::new(),
    };
    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_CREATE_SECTION.to_owned(),
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
        |result: &mut CreatedSection, _, warnings| {
            result.warnings = warnings;
        },
    )
}
