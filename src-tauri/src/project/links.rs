//! Links between world pages, stories and universes (`docs/creative-format.md` §6).
//!
//! A world section keeps a "Stories" relation (no other side, any number of stories) and the
//! stories section keeps a "Universe" relation (one universe, no other side). The workshop file
//! records the ID of each property on the section entry (`storiesPropertyId`,
//! `universePropertyId`), so the module never finds them by name.
//!
//! Three things live here:
//! - planning one link property in an existing database manifest, shared by the lazy creation of
//!   the universes section and by `add_story_links`;
//! - `add_story_links`, the journaled operation that links a section of a workshop made before
//!   the links existed (it adopts a matching relation the section already has);
//! - `create_entity`, a world page born with its story (and, for an anchor, its universe) already
//!   set, in one write.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::json;

use super::create::{
    checkpoint, guarded, io_failure, join_relative, replay, request_revision, settle,
    validate_operation_id, write_file_safe, Env, FileWrite, Interrupt, Replay, Step,
};
use super::discovery::discover_projects;
use super::format::{
    document_bytes, with_section_links, with_text_plot_properties, SectionLinks, WorkshopSectionDoc,
};
use super::journal::{
    create_journal, replace_journal, Journal, Plan, PlannedManifestWrite, JOURNAL_FORMAT,
    JOURNAL_VERSION, OP_ADD_STORY_LINKS, OP_ENSURE_PLOT_LINKS, STATUS_IN_PROGRESS,
};
use super::model::{
    AddStoryLinksRequest, AddedStoryLinks, CreateWorkshopEntityRequest, CreatedWorkshopEntity,
    EnsurePlotLinksRequest, EnsuredPlotLinks, PlotLinksTarget, ProjectError, ROLE_ANCHORS,
    ROLE_ARCS, ROLE_NOTES, ROLE_STORIES, ROLE_UNIVERSES, WORKSHOP_FILE_NAME,
};
use super::notebooks::resolve_notebook_dir;
use super::presets::{is_link_label, link_property_name, links_to_stories};
use super::props::PropertyBuilder;
use super::settings::{check_writable_story, check_writable_workshop, find_story, FoundStory};
use crate::database::discovery::manifest_path_for_container;
use crate::database::format::{
    parse_manifest, prepare_json, raw_revision, PropertyDefinition, PropertyValue,
};
use crate::database::mutations::{find_database_container, resolve_note_path_for_id};
use crate::database::rows::{
    create_database_row_in_directory, CreateDatabaseRowRequest, DatabaseRowTemplate,
};
use crate::frontmatter;
use crate::watcher;

/// The links a workshop keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    /// A world page to its stories: many, no limit.
    Stories,
    /// A story (or an anchor) to its universe: at most one.
    Universe,
    /// A text page to the anchors of the workshop: many.
    Anchors,
    /// A text page, or an anchor, to arcs: many.
    Arcs,
}

impl LinkKind {
    /// The label key suffix (`property:<name>`) the property is named from.
    pub fn name(self) -> &'static str {
        match self {
            Self::Stories => "stories",
            Self::Universe => "universe",
            Self::Anchors => "anchors",
            Self::Arcs => "arcs",
        }
    }

    fn limit(self) -> Option<u8> {
        match self {
            Self::Universe => Some(1),
            _ => None,
        }
    }
}

/// One link property, planned against the manifest it joins. `write` is `None` when the
/// manifest already had a matching relation and only its ID has to be recorded.
pub struct PlannedLink {
    pub property_id: String,
    pub write: Option<PlannedManifestWrite>,
}

/// One link a manifest should have: the relation `kind` to `target_database_id`. With a
/// `recorded` ID that is still a property of the manifest, nothing is planned for it.
pub struct LinkWish<'a> {
    pub kind: LinkKind,
    pub target_database_id: &'a str,
    pub recorded: Option<&'a str>,
}

/// What became of one wished link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkOutcome {
    /// The recorded property is there: nothing changes.
    Present(String),
    /// A relation of the right shape was already in the manifest: only its ID is recorded.
    Adopted(String),
    /// A new relation is added to the manifest.
    Added(String),
}

impl LinkOutcome {
    pub fn property_id(&self) -> &str {
        match self {
            Self::Present(id) | Self::Adopted(id) | Self::Added(id) => id,
        }
    }

    pub fn is_change(&self) -> bool {
        !matches!(self, Self::Present(_))
    }
}

/// The links of one manifest, planned together: one outcome per wish, and the one manifest write
/// that adds every new relation (`None` when nothing is added).
pub struct PlannedLinks {
    pub outcomes: Vec<LinkOutcome>,
    pub write: Option<PlannedManifestWrite>,
}

fn unavailable(reason: impl Into<String>) -> ProjectError {
    ProjectError::StoryLinksUnavailable {
        reason: reason.into(),
    }
}

/// Plans a relation from `source_database_id` to `target_database_id` for `kind` without writing.
/// `pending` names databases the same operation creates (a relation to one is not looked up).
/// With `adopt`, a relation the source already has to the target, with the right limit, is
/// taken as the link instead of making a second one.
pub fn plan_link(
    vault: &Path,
    kind: LinkKind,
    source_database_id: &str,
    target_database_id: &str,
    pending: &[String],
    labels: &BTreeMap<String, String>,
    adopt: bool,
) -> Result<PlannedLink, ProjectError> {
    let wish = [LinkWish {
        kind,
        target_database_id,
        recorded: None,
    }];
    let planned = plan_links(vault, source_database_id, &wish, pending, labels, adopt)?;
    Ok(PlannedLink {
        property_id: planned.outcomes[0].property_id().to_owned(),
        write: planned.write,
    })
}

/// Plans every wished link of one database against its manifest as it is on disk: a recorded
/// property that still exists stays, a relation of the right shape (to the target, with the
/// limit, no other side) is adopted when `adopt` is set, and anything else is added, all in one
/// write of the manifest. Nothing is written.
pub fn plan_links(
    vault: &Path,
    source_database_id: &str,
    wishes: &[LinkWish],
    pending: &[String],
    labels: &BTreeMap<String, String>,
    adopt: bool,
) -> Result<PlannedLinks, ProjectError> {
    let container = find_database_container(vault, source_database_id).map_err(unavailable)?;
    let manifest_path = manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|error| io_failure("readManifest", error))?;
    let parsed = parse_manifest(&original).map_err(|error| io_failure("parseManifest", error))?;
    if parsed.read_only.is_some() {
        return Err(unavailable("the database is read-only"));
    }
    if parsed.value.locked {
        return Err(unavailable("the database is locked"));
    }

    let mut builder =
        PropertyBuilder::for_manifest(vault, parsed.value.clone()).with_pending_databases(pending);
    let mut added: Vec<PropertyDefinition> = Vec::new();
    let mut outcomes = Vec::with_capacity(wishes.len());
    for wish in wishes {
        if let Some(recorded) = wish.recorded {
            if parsed
                .value
                .properties
                .iter()
                .any(|property| property.id() == Some(recorded))
            {
                outcomes.push(LinkOutcome::Present(recorded.to_owned()));
                continue;
            }
        }
        if adopt {
            let existing = parsed
                .value
                .properties
                .iter()
                .find_map(|property| match property {
                    PropertyDefinition::Relation(fields)
                        if fields.config.target_database_id == wish.target_database_id
                            && fields.config.max_items == wish.kind.limit()
                            && fields.config.inverse_property_id.is_none() =>
                    {
                        Some(fields.id.clone())
                    }
                    _ => None,
                });
            if let Some(property_id) = existing {
                outcomes.push(LinkOutcome::Adopted(property_id));
                continue;
            }
        }

        let name = link_property_name(labels, wish.kind.name())?;
        let taken = |existing: Option<&str>| {
            existing.is_some_and(|existing| existing.trim().eq_ignore_ascii_case(&name))
        };
        if parsed
            .value
            .properties
            .iter()
            .any(|property| taken(property.name()))
            || added.iter().any(|property| taken(property.name()))
        {
            return Err(ProjectError::InvalidName {
                field: "schemaName".to_owned(),
                reason: "a property with this name already exists".to_owned(),
            });
        }
        let (definition, ids) = builder.add("relation", &name, &[], &|spec| {
            spec.relation_target_database_id = Some(wish.target_database_id.to_owned());
            spec.relation_two_way = Some(false);
            if wish.kind.limit() == Some(1) {
                spec.relation_max_items = Some(1);
            }
        })?;
        let property: PropertyDefinition =
            serde_json::from_value(definition).map_err(|error| io_failure("deserialize", error))?;
        added.push(property);
        outcomes.push(LinkOutcome::Added(ids.property_id));
    }
    builder.validate()?;

    if added.is_empty() {
        return Ok(PlannedLinks {
            outcomes,
            write: None,
        });
    }
    let mut next = parsed.value.clone();
    next.properties.extend(added);
    let prepared =
        prepare_json(&parsed, &next).map_err(|error| io_failure("serialize", error.to_string()))?;

    let relative = vault_relative(vault, &manifest_path)?;
    let pre_text =
        String::from_utf8(original).map_err(|error| io_failure("readManifest", error))?;
    let post_text = String::from_utf8(prepared.bytes)
        .map_err(|error| io_failure("serialize", error.to_string()))?;
    Ok(PlannedLinks {
        outcomes,
        write: Some(PlannedManifestWrite {
            manifest_path: relative,
            pre_revision: raw_revision(pre_text.as_bytes()),
            post_revision: prepared.revision,
            pre_text,
            post_text,
        }),
    })
}

fn vault_relative(vault: &Path, path: &Path) -> Result<String, ProjectError> {
    let canonical = vault.canonicalize().ok();
    let stripped = path
        .strip_prefix(vault)
        .ok()
        .or_else(|| {
            canonical
                .as_deref()
                .and_then(|root| path.strip_prefix(root).ok())
        })
        .ok_or_else(|| io_failure("invalidPath", "the database is outside the vault"))?;
    Ok(stripped.to_string_lossy().replace('\\', "/"))
}

/// Writes the planned manifest: only over the bytes the plan was made from.
pub(super) fn write_planned_manifest(
    env: &Env,
    write: &PlannedManifestWrite,
) -> Result<(), Interrupt> {
    let path =
        guarded(env.vault, &write.manifest_path).map_err(|e| Interrupt::Error(e.to_string()))?;
    let current = fs::read(&path).map_err(|error| Interrupt::Error(error.to_string()))?;
    if current != write.pre_text.as_bytes() {
        return Err(Interrupt::Error("the database was changed".to_owned()));
    }
    let bytes = write.post_text.as_bytes();
    crate::history::snapshot_before_write(env.vault, &path, bytes, "database-manifest")
        .map_err(Interrupt::Error)?;
    let prepared = env
        .watcher
        .prepare_write([(&path, watcher::fingerprint_for_bytes(bytes))]);
    if let Err(error) = frontmatter::atomic_write_bytes(&path, bytes) {
        env.watcher.cancel_prepared_write(&prepared);
        if fs::read(&path).is_ok_and(|now| now == bytes) {
            return Ok(());
        }
        return Err(Interrupt::Error(error));
    }
    env.watcher.confirm_prepared_write(&prepared);
    Ok(())
}

// ---------------------------------------------------------------------------
// add_story_links
// ---------------------------------------------------------------------------

struct LinksPlan {
    write: Option<PlannedManifestWrite>,
    file_text: String,
    file_revision: String,
    result: AddedStoryLinks,
}

pub fn add_story_links(
    env: &Env,
    request: &AddStoryLinksRequest,
) -> Result<AddedStoryLinks, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    for key in request.labels.keys() {
        if !is_link_label(key) {
            return Err(ProjectError::InvalidName {
                field: "labels".to_owned(),
                reason: "unknown label".to_owned(),
            });
        }
    }
    let revision = request_revision(&json!({
        "workshopId": request.workshop_id,
        "expectedWorkshopRevision": request.expected_workshop_revision,
        "sectionId": request.section_id,
        "labels": request.labels,
    }))?;

    let resumed = match replay(env, &request.operation_id, OP_ADD_STORY_LINKS, &revision)? {
        Replay::Fresh => None,
        Replay::Resume(journal) => Some(journal),
        Replay::Done(value) => {
            let mut added: AddedStoryLinks =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            added.replayed = true;
            return Ok(added);
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
    let section = workshop
        .doc
        .sections
        .iter()
        .find(|section| section.id == request.section_id)
        .ok_or_else(|| ProjectError::SectionNotFound {
            section_id: request.section_id.clone(),
        })?;

    let (kind, target) = if section.role == ROLE_STORIES {
        if section.universe_property_id.is_some() {
            return Err(ProjectError::StoryLinksAlreadyConfigured);
        }
        let universes = workshop
            .doc
            .sections
            .iter()
            .find(|candidate| candidate.role == ROLE_UNIVERSES)
            .ok_or_else(|| unavailable("the workshop has no universes yet"))?;
        (LinkKind::Universe, universes.database_id.clone())
    } else if links_to_stories(&section.role) {
        if section.stories_property_id.is_some() {
            return Err(ProjectError::StoryLinksAlreadyConfigured);
        }
        let stories = workshop
            .doc
            .sections
            .iter()
            .find(|candidate| candidate.role == ROLE_STORIES)
            .ok_or_else(|| unavailable("the workshop has no stories section"))?;
        (LinkKind::Stories, stories.database_id.clone())
    } else {
        return Err(unavailable("universes are not linked to stories"));
    };

    let plan = match resumed
        .as_ref()
        .and_then(|journal| plan_from_journal(journal, kind))
    {
        Some(plan) => plan,
        None => {
            let link = plan_link(
                env.vault,
                kind,
                &section.database_id,
                &target,
                &[],
                &request.labels,
                true,
            )?;
            let mut recorded = SectionLinks::default();
            match kind {
                LinkKind::Universe => recorded.universe = Some(link.property_id.clone()),
                _ => recorded.stories = Some(link.property_id.clone()),
            }
            let document = with_section_links(&workshop.doc.raw, &section.id, &recorded)
                .map_err(|e| io_failure("format", e))?;
            let bytes = document_bytes(&document, workshop.doc.has_bom)
                .map_err(|e| io_failure("serialize", e))?;
            let file_revision = raw_revision(&bytes);
            LinksPlan {
                write: link.write,
                file_text: String::from_utf8(bytes).map_err(|e| io_failure("serialize", e))?,
                file_revision: file_revision.clone(),
                result: AddedStoryLinks {
                    operation_id: request.operation_id.clone(),
                    workshop_id: workshop.doc.workshop_id.clone(),
                    section_id: section.id.clone(),
                    link: kind.name().to_owned(),
                    property_id: link.property_id,
                    workshop_revision: file_revision,
                    replayed: false,
                    warnings: Vec::new(),
                },
            }
        }
    };

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_ADD_STORY_LINKS.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: Plan {
            workshop_id: Some(workshop.doc.workshop_id.clone()),
            workshop_path: Some(workshop.path.clone()),
            creates_workshop_folder: false,
            workshop_file_revision: Some(plan.file_revision.clone()),
            sections: Vec::new(),
            story: None,
            story_file_path: None,
            story_file_revision: None,
            workshop_file_text: Some(plan.file_text.clone()),
            manifest_write: plan.write.clone(),
        },
        expected_result: serde_json::to_value(&plan.result).unwrap(),
        extra: BTreeMap::new(),
    };
    if resumed.is_some() {
        replace_journal(env.vault, &journal)?;
    } else {
        create_journal(env.vault, &journal)?;
    }

    let workshop_file = guarded(
        env.vault,
        &join_relative(&workshop.path, WORKSHOP_FILE_NAME),
    )?;
    let run = (|| -> Result<(), Interrupt> {
        checkpoint(Step::JournalWritten)?;
        if let Some(write) = &plan.write {
            checkpoint(Step::BeforeManifest)?;
            write_planned_manifest(env, write)?;
            checkpoint(Step::ManifestWritten)?;
        }
        checkpoint(Step::BeforeWorkshopFile)?;
        write_file_safe(
            env,
            &workshop_file,
            &FileWrite::Replace {
                expected_revision: workshop.doc.revision.clone(),
                bytes: plan.file_text.clone().into_bytes(),
            },
            &plan.file_revision,
            "workshop-structure",
        )?;
        checkpoint(Step::WorkshopFileWritten)?;
        checkpoint(Step::BeforeCompletion)?;
        Ok(())
    })();
    settle(env, journal, plan.result, run)
}

/// The plan a journal recorded, if it is the plan of the same kind of link.
fn plan_from_journal(journal: &Journal, kind: LinkKind) -> Option<LinksPlan> {
    let result: AddedStoryLinks = serde_json::from_value(journal.expected_result.clone()).ok()?;
    let file_text = journal.plan.workshop_file_text.clone()?;
    let file_revision = journal.plan.workshop_file_revision.clone()?;
    if raw_revision(file_text.as_bytes()) != file_revision || result.link != kind.name() {
        return None;
    }
    Some(LinksPlan {
        write: journal.plan.manifest_write.clone(),
        file_text,
        file_revision,
        result,
    })
}

// ---------------------------------------------------------------------------
// ensure_plot_links
// ---------------------------------------------------------------------------

/// Everything `ensure_plot_links` decides before the first write, fresh or read back from a
/// journal: the one manifest write, the bytes of the file that commits it, and the answer.
struct PlotPlan {
    write: Option<PlannedManifestWrite>,
    commit_bytes: Vec<u8>,
    commit_revision: String,
    result: EnsuredPlotLinks,
}

/// The database of a section role that the workshop has and that is on disk.
fn existing_database(env: &Env, sections: &[WorkshopSectionDoc], role: &str) -> Option<String> {
    let section = sections.iter().find(|section| section.role == role)?;
    find_database_container(env.vault, &section.database_id).ok()?;
    Some(section.database_id.clone())
}

fn outcome_id(outcomes: &[LinkOutcome], index: Option<usize>) -> Option<String> {
    index.map(|index| outcomes[index].property_id().to_owned())
}

/// Makes the link properties of arcs and anchors exist wherever the databases they point at do
/// (`docs/creative-format.md` §6). One call changes one database and one structure file: the
/// text of a story and `amby-story.json`, or the anchors and `amby-workshop.json`. Properties
/// that already exist are recorded, not made again, and when nothing is missing nothing is written.
pub fn ensure_plot_links(
    env: &Env,
    request: &EnsurePlotLinksRequest,
) -> Result<EnsuredPlotLinks, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    for key in request.labels.keys() {
        if !is_link_label(key) {
            return Err(ProjectError::InvalidName {
                field: "labels".to_owned(),
                reason: "unknown label".to_owned(),
            });
        }
    }
    let revision = request_revision(&json!({
        "workshopId": request.workshop_id,
        "target": request.target,
        "storyId": request.story_id,
        "expectedRevision": request.expected_revision,
        "labels": request.labels,
    }))?;

    let resumed = match replay(env, &request.operation_id, OP_ENSURE_PLOT_LINKS, &revision)? {
        Replay::Fresh => None,
        Replay::Resume(journal) => Some(journal),
        Replay::Done(value) => {
            let mut ensured: EnsuredPlotLinks =
                serde_json::from_value(value).map_err(|e| io_failure("deserialize", e))?;
            ensured.replayed = true;
            return Ok(ensured);
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

    let (commit_path, history_kind, expected_revision, plan) = match request.target {
        PlotLinksTarget::Story => {
            let story_id =
                request
                    .story_id
                    .as_deref()
                    .ok_or_else(|| ProjectError::StoryNotFound {
                        story_id: String::new(),
                    })?;
            if !workshop
                .stories
                .iter()
                .any(|story| story.story_id == story_id)
            {
                return Err(ProjectError::StoryNotFound {
                    story_id: story_id.to_owned(),
                });
            }
            let found = find_story(env, story_id)?;
            let (plan, expected) =
                plan_story_links(env, workshop, request, &found, resumed.as_deref())?;
            (
                guarded(env.vault, &found.story_file_rel)?,
                "story-config",
                expected,
                plan,
            )
        }
        PlotLinksTarget::Anchors => {
            let (plan, expected) = plan_anchor_links(env, workshop, request, resumed.as_deref())?;
            (
                guarded(
                    env.vault,
                    &join_relative(&workshop.path, WORKSHOP_FILE_NAME),
                )?,
                "workshop-structure",
                expected,
                plan,
            )
        }
    };
    if !plan.result.changed {
        return Ok(plan.result);
    }

    let journal = Journal {
        format: JOURNAL_FORMAT.to_owned(),
        format_version: JOURNAL_VERSION,
        operation_id: request.operation_id.clone(),
        operation: OP_ENSURE_PLOT_LINKS.to_owned(),
        request_revision: revision,
        status: STATUS_IN_PROGRESS.to_owned(),
        plan: match request.target {
            PlotLinksTarget::Story => Plan {
                workshop_id: None,
                workshop_path: None,
                creates_workshop_folder: false,
                workshop_file_revision: None,
                sections: Vec::new(),
                story: None,
                story_file_path: Some(vault_relative(env.vault, &commit_path)?),
                story_file_revision: Some(plan.commit_revision.clone()),
                workshop_file_text: None,
                manifest_write: plan.write.clone(),
            },
            PlotLinksTarget::Anchors => Plan {
                workshop_id: Some(workshop.doc.workshop_id.clone()),
                workshop_path: Some(workshop.path.clone()),
                creates_workshop_folder: false,
                workshop_file_revision: Some(plan.commit_revision.clone()),
                sections: Vec::new(),
                story: None,
                story_file_path: None,
                story_file_revision: None,
                workshop_file_text: Some(
                    String::from_utf8(plan.commit_bytes.clone())
                        .map_err(|e| io_failure("serialize", e))?,
                ),
                manifest_write: plan.write.clone(),
            },
        },
        expected_result: serde_json::to_value(&plan.result).unwrap(),
        extra: BTreeMap::new(),
    };
    if resumed.is_some() {
        replace_journal(env.vault, &journal)?;
    } else {
        create_journal(env.vault, &journal)?;
    }

    let target = request.target;
    let run = (|| -> Result<(), Interrupt> {
        checkpoint(Step::JournalWritten)?;
        if let Some(write) = &plan.write {
            checkpoint(Step::BeforeManifest)?;
            write_planned_manifest(env, write)?;
            checkpoint(Step::ManifestWritten)?;
        }
        checkpoint(match target {
            PlotLinksTarget::Story => Step::BeforeStoryFile,
            PlotLinksTarget::Anchors => Step::BeforeWorkshopFile,
        })?;
        write_file_safe(
            env,
            &commit_path,
            &FileWrite::Replace {
                expected_revision: expected_revision.clone(),
                bytes: plan.commit_bytes.clone(),
            },
            &plan.commit_revision,
            history_kind,
        )?;
        checkpoint(match target {
            PlotLinksTarget::Story => Step::StoryFileWritten,
            PlotLinksTarget::Anchors => Step::WorkshopFileWritten,
        })?;
        checkpoint(Step::BeforeCompletion)?;
        Ok(())
    })();
    settle(env, journal, plan.result, run)
}

/// The plan for the pages of a story's text. The second value is the revision `amby-story.json`
/// must still have when it is replaced. `None` is never returned for a plan that is needed.
fn plan_story_links(
    env: &Env,
    workshop: &super::discovery::DiscoveredWorkshop,
    request: &EnsurePlotLinksRequest,
    found: &FoundStory,
    resumed: Option<&Journal>,
) -> Result<(PlotPlan, String), ProjectError> {
    let story_id = request.story_id.clone();
    if found
        .story_doc
        .raw
        .get("text")
        .filter(|text| text.is_object())
        .is_none()
    {
        return Err(ProjectError::TextNotConfigured);
    }
    let recorded = |key: &str| {
        found
            .story_doc
            .raw
            .pointer(&format!("/text/properties/{key}"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let sections = &workshop.doc.sections;
    let anchors = existing_database(env, sections, ROLE_ANCHORS);
    let arcs = existing_database(env, sections, ROLE_ARCS);
    let (recorded_anchors, recorded_arcs) = (recorded("anchors"), recorded("arcs"));

    let mut wishes = Vec::new();
    let anchors_at = anchors.as_ref().map(|database_id| {
        wishes.push(LinkWish {
            kind: LinkKind::Anchors,
            target_database_id: database_id,
            recorded: recorded_anchors.as_deref(),
        });
        wishes.len() - 1
    });
    let arcs_at = arcs.as_ref().map(|database_id| {
        wishes.push(LinkWish {
            kind: LinkKind::Arcs,
            target_database_id: database_id,
            recorded: recorded_arcs.as_deref(),
        });
        wishes.len() - 1
    });

    // A resume writes what the journal planned.
    if let Some(journal) = resumed {
        if let Some(result) = journal_result(journal, PlotLinksTarget::Story) {
            if let Some(plan) = story_plan(found, &result, journal.plan.manifest_write.clone()) {
                if plan.commit_revision
                    == journal.plan.story_file_revision.clone().unwrap_or_default()
                {
                    check_writable_story(&found.story_doc, &request.expected_revision)?;
                    return Ok((plan, found.story_doc.revision.clone()));
                }
            }
        }
    }

    let (anchors_id, arcs_id, changed, write) = if wishes.is_empty() {
        let live = |id: Option<String>| {
            id.filter(|id| {
                found
                    .manifest
                    .properties
                    .iter()
                    .any(|property| property.id() == Some(id.as_str()))
            })
        };
        (live(recorded_anchors), live(recorded_arcs), false, None)
    } else {
        let planned_links = plan_links(
            env.vault,
            &found.manifest.database_id,
            &wishes,
            &[],
            &request.labels,
            true,
        )?;
        (
            outcome_id(&planned_links.outcomes, anchors_at),
            outcome_id(&planned_links.outcomes, arcs_at),
            planned_links.outcomes.iter().any(LinkOutcome::is_change),
            planned_links.write,
        )
    };

    let result = EnsuredPlotLinks {
        operation_id: request.operation_id.clone(),
        workshop_id: request.workshop_id.clone(),
        target: PlotLinksTarget::Story,
        story_id,
        anchors_property_id: anchors_id,
        arcs_property_id: arcs_id,
        universe_property_id: None,
        revision: found.story_doc.revision.clone(),
        changed,
        replayed: false,
        warnings: Vec::new(),
    };
    if !changed {
        return Ok((
            PlotPlan {
                write: None,
                commit_bytes: Vec::new(),
                commit_revision: found.story_doc.revision.clone(),
                result,
            },
            found.story_doc.revision.clone(),
        ));
    }
    check_writable_story(&found.story_doc, &request.expected_revision)?;
    let plan = story_plan(found, &result, write)
        .ok_or_else(|| io_failure("storyFormat", "the story file cannot take the properties"))?;
    Ok((plan, found.story_doc.revision.clone()))
}

/// The plan of a story's links from the answer it will give: the story file with the property
/// IDs of the answer set, and the revision that file will have.
fn story_plan(
    found: &FoundStory,
    result: &EnsuredPlotLinks,
    write: Option<PlannedManifestWrite>,
) -> Option<PlotPlan> {
    let document = with_text_plot_properties(
        &found.story_doc.raw,
        result.anchors_property_id.as_deref(),
        result.arcs_property_id.as_deref(),
    )
    .ok()?;
    let bytes = document_bytes(&document, found.story_doc.has_bom).ok()?;
    let revision = raw_revision(&bytes);
    let mut result = result.clone();
    result.revision = revision.clone();
    Some(PlotPlan {
        write,
        commit_bytes: bytes,
        commit_revision: revision,
        result,
    })
}

/// The answer a journal of this target recorded.
fn journal_result(journal: &Journal, target: PlotLinksTarget) -> Option<EnsuredPlotLinks> {
    let result: EnsuredPlotLinks = serde_json::from_value(journal.expected_result.clone()).ok()?;
    (result.target == target && result.changed).then_some(result)
}

/// The plan for the anchors database. The second value is the revision `amby-workshop.json` must
/// still have when it is replaced.
fn plan_anchor_links(
    env: &Env,
    workshop: &super::discovery::DiscoveredWorkshop,
    request: &EnsurePlotLinksRequest,
    resumed: Option<&Journal>,
) -> Result<(PlotPlan, String), ProjectError> {
    let sections = &workshop.doc.sections;
    let anchors = sections
        .iter()
        .find(|section| section.role == ROLE_ANCHORS)
        .ok_or_else(|| unavailable("the workshop has no anchors yet"))?;
    let arcs = existing_database(env, sections, ROLE_ARCS);
    let universes = existing_database(env, sections, ROLE_UNIVERSES);

    let mut wishes = Vec::new();
    let arcs_at = arcs.as_ref().map(|database_id| {
        wishes.push(LinkWish {
            kind: LinkKind::Arcs,
            target_database_id: database_id,
            recorded: anchors.arcs_property_id.as_deref(),
        });
        wishes.len() - 1
    });
    let universe_at = universes.as_ref().map(|database_id| {
        wishes.push(LinkWish {
            kind: LinkKind::Universe,
            target_database_id: database_id,
            recorded: anchors.universe_property_id.as_deref(),
        });
        wishes.len() - 1
    });

    let from_result = |result: &EnsuredPlotLinks| -> Result<PlotPlan, ProjectError> {
        let document = with_section_links(
            &workshop.doc.raw,
            &anchors.id,
            &SectionLinks {
                arcs: result.arcs_property_id.clone(),
                universe: result.universe_property_id.clone(),
                ..SectionLinks::default()
            },
        )
        .map_err(|e| io_failure("format", e))?;
        let bytes = document_bytes(&document, workshop.doc.has_bom)
            .map_err(|e| io_failure("serialize", e))?;
        let revision = raw_revision(&bytes);
        let mut result = result.clone();
        result.revision = revision.clone();
        Ok(PlotPlan {
            write: None,
            commit_bytes: bytes,
            commit_revision: revision,
            result,
        })
    };

    if let Some(journal) = resumed {
        if let Some(result) = journal_result(journal, PlotLinksTarget::Anchors) {
            let plan = from_result(&result)?;
            if journal.plan.workshop_file_revision.as_deref() == Some(plan.commit_revision.as_str())
            {
                check_writable_workshop(&workshop.doc, &request.expected_revision)?;
                return Ok((
                    PlotPlan {
                        write: journal.plan.manifest_write.clone(),
                        ..plan
                    },
                    workshop.doc.revision.clone(),
                ));
            }
        }
    }

    let (arcs_id, universe_id, changed, write) = if wishes.is_empty() {
        (
            anchors.arcs_property_id.clone(),
            anchors.universe_property_id.clone(),
            false,
            None,
        )
    } else {
        let planned = plan_links(
            env.vault,
            &anchors.database_id,
            &wishes,
            &[],
            &request.labels,
            true,
        )?;
        (
            outcome_id(&planned.outcomes, arcs_at),
            outcome_id(&planned.outcomes, universe_at),
            planned.outcomes.iter().any(LinkOutcome::is_change),
            planned.write,
        )
    };
    let result = EnsuredPlotLinks {
        operation_id: request.operation_id.clone(),
        workshop_id: request.workshop_id.clone(),
        target: PlotLinksTarget::Anchors,
        story_id: None,
        anchors_property_id: None,
        arcs_property_id: arcs_id,
        universe_property_id: universe_id,
        revision: workshop.doc.revision.clone(),
        changed,
        replayed: false,
        warnings: Vec::new(),
    };
    if !changed {
        return Ok((
            PlotPlan {
                write: None,
                commit_bytes: Vec::new(),
                commit_revision: workshop.doc.revision.clone(),
                result,
            },
            workshop.doc.revision.clone(),
        ));
    }
    check_writable_workshop(&workshop.doc, &request.expected_revision)?;
    let plan = from_result(&result)?;
    Ok((PlotPlan { write, ..plan }, workshop.doc.revision.clone()))
}

// ---------------------------------------------------------------------------
// create_entity
// ---------------------------------------------------------------------------

/// The manifest of a database still holds the link property the workshop file names.
fn require_property(env: &Env, database_id: &str, property_id: &str) -> Result<(), ProjectError> {
    let container = find_database_container(env.vault, database_id).map_err(unavailable)?;
    let manifest = fs::read(manifest_path_for_container(&container))
        .map_err(|error| io_failure("readManifest", error))
        .and_then(|bytes| {
            parse_manifest(&bytes).map_err(|error| io_failure("parseManifest", error))
        })?;
    if manifest
        .value
        .properties
        .iter()
        .any(|property| property.id() == Some(property_id))
    {
        Ok(())
    } else {
        Err(unavailable("the link property was deleted"))
    }
}

/// Creates a page of a world section. With a story, the page is written with its "Stories"
/// relation already pointing at the story's card, in the same write as the note.
pub fn create_entity(
    env: &Env,
    request: &CreateWorkshopEntityRequest,
) -> Result<CreatedWorkshopEntity, ProjectError> {
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
    let section = workshop
        .doc
        .sections
        .iter()
        .find(|section| section.id == request.section_id)
        .ok_or_else(|| ProjectError::SectionNotFound {
            section_id: request.section_id.clone(),
        })?;
    if section.role == ROLE_STORIES {
        return Err(ProjectError::UnsupportedRole {
            role: section.role.clone(),
        });
    }
    // A notebook is a folder of the notes base: checked before anything is written.
    let notebook_segments = request
        .notebook
        .as_deref()
        .filter(|segments| !segments.is_empty());
    let directory = match notebook_segments {
        Some(segments) => {
            if section.role != ROLE_NOTES {
                return Err(ProjectError::InvalidParent {
                    reason: "notebook: only the notes base has notebooks".to_owned(),
                });
            }
            let container =
                find_database_container(env.vault, &section.database_id).map_err(unavailable)?;
            Some(resolve_notebook_dir(&container, segments)?)
        }
        None => None,
    };

    let mut values: BTreeMap<String, PropertyValue> = BTreeMap::new();
    let mut linked_story_id = None;
    if let Some(story_id) = &request.story_id {
        let property_id = section
            .stories_property_id
            .clone()
            .ok_or_else(|| unavailable("the section is not linked to stories"))?;
        let story = workshop
            .stories
            .iter()
            .find(|story| &story.story_id == story_id)
            .ok_or_else(|| ProjectError::StoryNotFound {
                story_id: story_id.clone(),
            })?;
        let card_note_id = story
            .card_note_id
            .clone()
            .ok_or_else(|| io_failure("storyCardMissing", "the story has no card"))?;
        require_property(env, &section.database_id, &property_id)?;
        values.insert(
            property_id,
            PropertyValue::Relation {
                target_note_ids: vec![card_note_id],
                extra: BTreeMap::new(),
            },
        );
        linked_story_id = Some(story_id.clone());
    }
    // An event of a universe: an anchor born with its "Universe" value, in the same write.
    if let Some(universe_id) = request.universe_id.as_deref() {
        if section.role != ROLE_ANCHORS {
            return Err(ProjectError::InvalidParent {
                reason: "universe: only an anchor takes a universe".to_owned(),
            });
        }
        let property_id = section
            .universe_property_id
            .clone()
            .ok_or_else(|| unavailable("the anchors are not linked to universes"))?;
        let universes = workshop
            .doc
            .sections
            .iter()
            .find(|candidate| candidate.role == ROLE_UNIVERSES)
            .ok_or_else(|| unavailable("the workshop has no universes"))?;
        let universes_container =
            find_database_container(env.vault, &universes.database_id).map_err(unavailable)?;
        resolve_note_path_for_id(env.vault, &universes_container, universe_id)
            .map_err(|_| unavailable("the universe does not exist"))?;
        require_property(env, &section.database_id, &property_id)?;
        values.insert(
            property_id,
            PropertyValue::Relation {
                target_note_ids: vec![universe_id.to_owned()],
                extra: BTreeMap::new(),
            },
        );
    }

    let created = create_database_row_in_directory(
        env.vault,
        env.watcher,
        &CreateDatabaseRowRequest {
            expected_generation: 0,
            database_id: section.database_id.clone(),
            title: request.title.clone(),
            template: DatabaseRowTemplate::Default,
        },
        &values,
        directory.as_deref(),
    )
    .map_err(|error| io_failure("createEntityFailed", error))?;

    Ok(CreatedWorkshopEntity {
        database_id: created.database_id,
        note_id: created.note_id,
        title: created.title,
        note_path: created.note_path,
        linked_story_id,
        warnings: created.warnings,
    })
}
