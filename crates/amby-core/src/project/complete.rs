//! Making a workshop of the earlier stages whole (`docs/creative-format.md` §4).
//!
//! A workshop made before the whole set of bases was created at once may lack the universes,
//! arcs, anchors or notes bases and some links between its bases and its stories' texts. This
//! module adds exactly what is absent, one journaled operation at a time (the same operations
//! the lazy creation uses: `create_workshop_section`, `add_story_links`, `ensure_plot_links`),
//! in the order that lets each base take its links from the ones made before it. It never
//! touches what is there, so repeating it writes nothing.

use std::collections::BTreeMap;

use super::create::{create_workshop_section, validate_operation_id, Env};
use super::discovery::{discover_projects, DiscoveredWorkshop};
use super::format::WorkshopSectionDoc;
use super::links::{add_story_links, ensure_plot_links};
use super::model::{
    AddStoryLinksRequest, CompleteWorkshopRequest, CompletedWorkshop, CreateWorkshopSectionRequest,
    EnsurePlotLinksRequest, PlotLinksTarget, ProjectError, ROLE_ANCHORS, ROLE_ARCS, ROLE_NOTES,
    ROLE_STORIES, ROLE_UNIVERSES,
};
use super::presets::{is_link_label, links_to_stories};
use crate::database::format::raw_revision;
use crate::database::mutations::find_database_container;

/// The bases a whole workshop has beyond the three the earlier stages always made, in the order
/// they are made: arcs after universes so the anchors take both.
const LAZY_ROLES: [(&str, &str); 4] = [
    (ROLE_UNIVERSES, "Вселенные"),
    (ROLE_ARCS, "Арки"),
    (ROLE_ANCHORS, "Якоря"),
    (ROLE_NOTES, "Заметки"),
];

/// The ID of one step of the operation. It depends on the revision the step starts from, so a
/// retry that starts from the same files repeats the step (the journal answers) and one that
/// starts from other files is a new step.
fn step_id(operation_id: &str, step: &str, revision: &str) -> String {
    let digest = raw_revision(format!("{operation_id}|{step}|{revision}").as_bytes());
    let head: String = operation_id.chars().take(96).collect();
    format!("{head}-{}", &digest[..24])
}

fn workshop_of(env: &Env, workshop_id: &str) -> Result<DiscoveredWorkshop, ProjectError> {
    let discovery = discover_projects(env.vault)
        .map_err(|message| ProjectError::failed("discovery", message))?;
    discovery
        .workshops
        .into_iter()
        .find(|workshop| workshop.doc.workshop_id == workshop_id)
        .ok_or_else(|| ProjectError::WorkshopNotFound {
            workshop_id: workshop_id.to_owned(),
        })
}

fn on_disk(env: &Env, section: &WorkshopSectionDoc) -> bool {
    find_database_container(env.vault, &section.database_id).is_ok()
}

/// What a step that cannot be done leaves alone, without failing the rest: a locked or read-only
/// database, a folder already taken, a text without its schema.
fn is_skippable(error: &ProjectError) -> bool {
    matches!(
        error,
        ProjectError::StoryLinksUnavailable { .. }
            | ProjectError::StoryLinksAlreadyConfigured
            | ProjectError::PathCollision { .. }
            | ProjectError::StoryReadOnly { .. }
            | ProjectError::TextNotConfigured
            | ProjectError::InvalidName { .. }
    )
}

pub fn complete_workshop(
    env: &Env,
    request: &CompleteWorkshopRequest,
) -> Result<CompletedWorkshop, ProjectError> {
    validate_operation_id(&request.operation_id)?;
    let link_labels: BTreeMap<String, String> = request
        .labels
        .iter()
        .filter(|(key, _)| is_link_label(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();

    let mut workshop = workshop_of(env, &request.workshop_id)?;
    if !workshop.doc.is_known_version() {
        return Err(ProjectError::WorkshopReadOnly {
            format_version: workshop.doc.format_version,
        });
    }

    let mut created_roles = Vec::new();
    let mut linked = Vec::new();
    let mut skipped = Vec::new();
    let mut changed = false;

    // 1. The bases that are absent, each in one operation of its own.
    for (role, default_name) in LAZY_ROLES {
        if workshop
            .doc
            .sections
            .iter()
            .any(|section| section.role == role)
        {
            continue;
        }
        let name = request
            .labels
            .get(&format!("section:{role}"))
            .map(String::as_str)
            .unwrap_or(default_name);
        let result = create_workshop_section(
            env,
            &CreateWorkshopSectionRequest {
                expected_generation: request.expected_generation,
                operation_id: step_id(&request.operation_id, role, &workshop.doc.revision),
                workshop_id: request.workshop_id.clone(),
                expected_workshop_revision: workshop.doc.revision.clone(),
                role: role.to_owned(),
                name: name.to_owned(),
                labels: request.labels.clone(),
            },
        );
        match result {
            Ok(_) => {
                created_roles.push(role.to_owned());
                changed = true;
                workshop = workshop_of(env, &request.workshop_id)?;
            }
            Err(error) if is_skippable(&error) => skipped.push(format!("section:{role}")),
            Err(error) => return Err(error),
        }
    }

    // 2. The links of every section to the stories, and of the stories to the universes.
    let section_ids: Vec<String> = workshop
        .doc
        .sections
        .iter()
        .map(|section| section.id.clone())
        .collect();
    for section_id in section_ids {
        let Some(section) = workshop
            .doc
            .sections
            .iter()
            .find(|section| section.id == section_id)
        else {
            continue;
        };
        let wants_link =
            if section.role == ROLE_STORIES {
                section.universe_property_id.is_none()
                    && workshop.doc.sections.iter().any(|candidate| {
                        candidate.role == ROLE_UNIVERSES && on_disk(env, candidate)
                    })
            } else {
                links_to_stories(&section.role) && section.stories_property_id.is_none()
            };
        if !wants_link || !on_disk(env, section) {
            continue;
        }
        let result = add_story_links(
            env,
            &AddStoryLinksRequest {
                expected_generation: request.expected_generation,
                operation_id: step_id(
                    &request.operation_id,
                    &format!("links:{section_id}"),
                    &workshop.doc.revision,
                ),
                workshop_id: request.workshop_id.clone(),
                expected_workshop_revision: workshop.doc.revision.clone(),
                section_id: section_id.clone(),
                labels: link_labels.clone(),
            },
        );
        match result {
            Ok(_) => {
                linked.push(format!("section:{section_id}"));
                changed = true;
                workshop = workshop_of(env, &request.workshop_id)?;
            }
            Err(error) if is_skippable(&error) => skipped.push(format!("links:{section_id}")),
            Err(error) => return Err(error),
        }
    }

    // 3. The anchors' own "Arcs" and "Universe", now that the bases they point at exist.
    if workshop
        .doc
        .sections
        .iter()
        .any(|section| section.role == ROLE_ANCHORS && on_disk(env, section))
    {
        let result = ensure_plot_links(
            env,
            &EnsurePlotLinksRequest {
                expected_generation: request.expected_generation,
                operation_id: step_id(&request.operation_id, "anchors", &workshop.doc.revision),
                workshop_id: request.workshop_id.clone(),
                target: PlotLinksTarget::Anchors,
                story_id: None,
                expected_revision: workshop.doc.revision.clone(),
                labels: link_labels.clone(),
            },
        );
        match result {
            Ok(ensured) if ensured.changed => {
                linked.push("anchors".to_owned());
                changed = true;
                workshop = workshop_of(env, &request.workshop_id)?;
            }
            Ok(_) => {}
            Err(error) if is_skippable(&error) => skipped.push("anchors".to_owned()),
            Err(error) => return Err(error),
        }
    }

    // 4. The "Anchors" and "Arcs" of each story's text.
    let stories: Vec<(String, String)> = workshop
        .stories
        .iter()
        .filter(|story| story.database_id.is_some())
        .map(|story| (story.story_id.clone(), story.file_revision.clone()))
        .collect();
    for (story_id, revision) in stories {
        let result = ensure_plot_links(
            env,
            &EnsurePlotLinksRequest {
                expected_generation: request.expected_generation,
                operation_id: step_id(
                    &request.operation_id,
                    &format!("story:{story_id}"),
                    &revision,
                ),
                workshop_id: request.workshop_id.clone(),
                target: PlotLinksTarget::Story,
                story_id: Some(story_id.clone()),
                expected_revision: revision,
                labels: link_labels.clone(),
            },
        );
        match result {
            Ok(ensured) if ensured.changed => {
                linked.push(format!("story:{story_id}"));
                changed = true;
            }
            Ok(_) => {}
            Err(error) if is_skippable(&error) => skipped.push(format!("story:{story_id}")),
            Err(error) => return Err(error),
        }
    }

    let workshop_revision = workshop_of(env, &request.workshop_id)?.doc.revision;
    Ok(CompletedWorkshop {
        operation_id: request.operation_id.clone(),
        workshop_id: request.workshop_id.clone(),
        created_roles,
        linked,
        changed,
        skipped,
        workshop_revision,
        warnings: Vec::new(),
    })
}
