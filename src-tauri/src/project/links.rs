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
//! - `create_entity`, a world page born with its story already set, in one write.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::json;

use super::create::{
    checkpoint, guarded, io_failure, join_relative, replay, request_revision, settle,
    validate_operation_id, write_file_safe, Env, FileWrite, Interrupt, Replay, Step,
};
use super::discovery::discover_projects;
use super::format::{document_bytes, with_section_links};
use super::journal::{
    create_journal, replace_journal, Journal, Plan, PlannedManifestWrite, JOURNAL_FORMAT,
    JOURNAL_VERSION, OP_ADD_STORY_LINKS, STATUS_IN_PROGRESS,
};
use super::model::{
    AddStoryLinksRequest, AddedStoryLinks, CreateWorkshopEntityRequest, CreatedWorkshopEntity,
    ProjectError, ROLE_NOTES, ROLE_STORIES, ROLE_UNIVERSES, WORKSHOP_FILE_NAME,
};
use super::notebooks::resolve_notebook_dir;
use super::presets::{is_link_label, link_property_name, links_to_stories};
use super::props::PropertyBuilder;
use crate::database::discovery::manifest_path_for_container;
use crate::database::format::{
    parse_manifest, prepare_json, raw_revision, PropertyDefinition, PropertyValue,
};
use crate::database::mutations::find_database_container;
use crate::database::rows::{
    create_database_row_in_directory, CreateDatabaseRowRequest, DatabaseRowTemplate,
};
use crate::frontmatter;
use crate::watcher;

/// The two links a workshop keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    /// A world page to its stories: many, no limit.
    Stories,
    /// A story to its universe: at most one.
    Universe,
}

impl LinkKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stories => "stories",
            Self::Universe => "universe",
        }
    }
}

/// One link property, planned against the manifest it joins. `write` is `None` when the
/// manifest already had a matching relation and only its ID has to be recorded.
pub struct PlannedLink {
    pub property_id: String,
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

    let wanted_limit = match kind {
        LinkKind::Stories => None,
        LinkKind::Universe => Some(1),
    };
    if adopt {
        let existing = parsed
            .value
            .properties
            .iter()
            .find_map(|property| match property {
                PropertyDefinition::Relation(fields)
                    if fields.config.target_database_id == target_database_id
                        && fields.config.max_items == wanted_limit
                        && fields.config.inverse_property_id.is_none() =>
                {
                    Some(fields.id.clone())
                }
                _ => None,
            });
        if let Some(property_id) = existing {
            return Ok(PlannedLink {
                property_id,
                write: None,
            });
        }
    }

    let name = link_property_name(labels, kind.name())?;
    if parsed.value.properties.iter().any(|property| {
        property
            .name()
            .is_some_and(|existing| existing.trim().eq_ignore_ascii_case(&name))
    }) {
        return Err(ProjectError::InvalidName {
            field: "schemaName".to_owned(),
            reason: "a property with this name already exists".to_owned(),
        });
    }

    let mut builder =
        PropertyBuilder::for_manifest(vault, parsed.value.clone()).with_pending_databases(pending);
    let (definition, ids) = builder.add("relation", &name, &[], &|spec| {
        spec.relation_target_database_id = Some(target_database_id.to_owned());
        spec.relation_two_way = Some(false);
        if kind == LinkKind::Universe {
            spec.relation_max_items = Some(1);
        }
    })?;
    builder.validate()?;
    let property: PropertyDefinition =
        serde_json::from_value(definition).map_err(|error| io_failure("deserialize", error))?;
    let mut next = parsed.value.clone();
    next.properties.push(property);
    let prepared =
        prepare_json(&parsed, &next).map_err(|error| io_failure("serialize", error.to_string()))?;

    let relative = vault_relative(vault, &manifest_path)?;
    let pre_text =
        String::from_utf8(original).map_err(|error| io_failure("readManifest", error))?;
    let post_text = String::from_utf8(prepared.bytes)
        .map_err(|error| io_failure("serialize", error.to_string()))?;
    Ok(PlannedLink {
        property_id: ids.property_id,
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
            let (stories_id, universe_id) = match kind {
                LinkKind::Stories => (Some(link.property_id.as_str()), None),
                LinkKind::Universe => (None, Some(link.property_id.as_str())),
            };
            let document =
                with_section_links(&workshop.doc.raw, &section.id, stories_id, universe_id)
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
// create_entity
// ---------------------------------------------------------------------------

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
        let container =
            find_database_container(env.vault, &section.database_id).map_err(unavailable)?;
        let manifest = fs::read(manifest_path_for_container(&container))
            .map_err(|error| io_failure("readManifest", error))
            .and_then(|bytes| {
                parse_manifest(&bytes).map_err(|error| io_failure("parseManifest", error))
            })?;
        if !manifest
            .value
            .properties
            .iter()
            .any(|property| property.id() == Some(property_id.as_str()))
        {
            return Err(unavailable("the link property was deleted"));
        }
        values.insert(
            property_id,
            PropertyValue::Relation {
                target_note_ids: vec![card_note_id],
                extra: BTreeMap::new(),
            },
        );
        linked_story_id = Some(story_id.clone());
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
