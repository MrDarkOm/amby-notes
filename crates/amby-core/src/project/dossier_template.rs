//! The dossier layout of a section's page template (docs/road/creative-visual.md §3).
//!
//! A template object in the database manifest keeps fields it does not know, so the layout is one
//! additive field of it, `ambyDossier`: the tabs of a dossier (its headings), the hint shown under
//! an empty one, and the properties shown in it. Writing the layout also rewrites the template's
//! `body` so a new page starts with the headings in their order; text the author had put in the
//! template is never lost: it follows its section (by ID, through a rename) or, for a section
//! that is gone, stays at the end.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::Value;

use super::create::Env;
use super::model::{
    DossierLayout, DossierTemplate, ProjectError, UpdateDossierTemplateRequest,
    UpdatedDossierTemplate,
};
use crate::database::discovery::manifest_path_for_container;
use crate::database::format::{parse_manifest, prepare_json, raw_revision, DatabaseManifest};
use crate::database::mutations::find_database_container;
use crate::database::validation::validate_manifest;
use crate::frontmatter;
use crate::self_write;

/// The key of the layout in a template object.
const LAYOUT_KEY: &str = "ambyDossier";
const LAYOUT_VERSION: u32 = 1;
const MAX_SECTIONS: usize = 30;
const MAX_FIELDS: usize = 30;
const MAX_TITLE: usize = 120;
const MAX_HINT: usize = 400;
/// The heading a template's sections are written with, as the presets write them.
const HEADING: &str = "## ";

fn invalid(field: &str, reason: &str) -> ProjectError {
    ProjectError::InvalidName {
        field: field.to_owned(),
        reason: reason.to_owned(),
    }
}

fn io(code: &str, error: impl ToString) -> ProjectError {
    ProjectError::failed(code, error.to_string())
}

/// The index of the section's default template among the manifest's inline templates.
fn template_index(manifest: &DatabaseManifest, template_id: Option<&str>) -> Option<usize> {
    let templates = manifest.extra.get("templates")?.as_array()?;
    let wanted = template_id
        .map(str::to_owned)
        .or_else(|| manifest.default_template_id.clone())
        .or_else(|| manifest.template_order.first().cloned())?;
    templates.iter().position(|template| {
        template.get("templateId").and_then(Value::as_str) == Some(wanted.as_str())
    })
}

fn summary(
    database_id: &str,
    template: &Value,
    manifest_revision: String,
) -> Result<DossierTemplate, ProjectError> {
    let text = |key: &str| {
        template
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    // A layout another app broke is shown as none: the template still works as text.
    let dossier = template
        .get(LAYOUT_KEY)
        .and_then(|value| serde_json::from_value::<DossierLayout>(value.clone()).ok());
    Ok(DossierTemplate {
        database_id: database_id.to_owned(),
        template_id: text("templateId"),
        name: text("name"),
        body: text("body"),
        dossier,
        manifest_revision,
    })
}

/// The page template of a section (its default one) with its dossier layout, read from disk.
pub fn get_dossier_template(
    vault: &Path,
    database_id: &str,
) -> Result<DossierTemplate, ProjectError> {
    let container =
        find_database_container(vault, database_id).map_err(|e| io("databaseNotFound", e))?;
    let bytes =
        fs::read(manifest_path_for_container(&container)).map_err(|e| io("readManifest", e))?;
    let parsed = parse_manifest(&bytes).map_err(|e| io("parseManifest", e))?;
    let index = template_index(&parsed.value, None).ok_or_else(|| {
        ProjectError::failed("templateNotFound", "the section has no inline template")
    })?;
    summary(
        database_id,
        &parsed.value.extra["templates"][index],
        parsed.revision,
    )
}

/// Checks the layout against the manifest before anything is written.
fn check_layout(layout: &DossierLayout, manifest: &DatabaseManifest) -> Result<(), ProjectError> {
    if layout.version != LAYOUT_VERSION {
        return Err(invalid("dossier", "unknown layout version"));
    }
    if layout.sections.is_empty() || layout.sections.len() > MAX_SECTIONS {
        return Err(invalid(
            "dossier",
            "a template has between 1 and 30 sections",
        ));
    }
    let properties: HashSet<&str> = manifest
        .properties
        .iter()
        .filter_map(|property| property.id())
        .collect();
    let mut ids = HashSet::new();
    let mut titles = HashSet::new();
    for section in &layout.sections {
        let id = section.id.trim();
        if id.is_empty() || id.len() > 64 || !ids.insert(id.to_owned()) {
            return Err(invalid("sectionId", "a section needs its own ID"));
        }
        let title = section.title.trim();
        if title.is_empty()
            || title.chars().count() > MAX_TITLE
            || title.contains(['\n', '\r'])
            || title.starts_with('#')
        {
            return Err(invalid("title", "a section title is one line of text"));
        }
        if !titles.insert(title.to_lowercase()) {
            return Err(invalid("title", "two sections have the same title"));
        }
        if section.hint.chars().count() > MAX_HINT || section.hint.contains(['\n', '\r']) {
            return Err(invalid("hint", "a hint is one line of text"));
        }
        if section.fields.len() > MAX_FIELDS
            || section
                .fields
                .iter()
                .any(|field| !properties.contains(field.as_str()))
        {
            return Err(invalid("fields", "a field is a property of this section"));
        }
    }
    Ok(())
}

/// A template body cut at its section headings: what stands before the first one, then each
/// heading's title with the text under it.
fn split_body(body: &str) -> (String, Vec<(String, String)>) {
    let mut preamble = String::new();
    let mut blocks: Vec<(String, String)> = Vec::new();
    for line in body.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if let Some(title) = bare.strip_prefix(HEADING) {
            blocks.push((title.trim().to_owned(), String::new()));
        } else if let Some((_, text)) = blocks.last_mut() {
            text.push_str(line);
        } else {
            preamble.push_str(line);
        }
    }
    (preamble, blocks)
}

/// The body of a template written from its new layout: each section's heading with the text the
/// old body had under it (found by the section's old title, or its own), and after them the
/// sections that are gone but held text, so nothing the author wrote is lost.
fn render_body(old_body: &str, old: Option<&DossierLayout>, new: &DossierLayout) -> String {
    let (preamble, blocks) = split_body(old_body);
    let old_titles: BTreeMap<&str, &str> = old
        .map(|layout| {
            layout
                .sections
                .iter()
                .map(|section| (section.id.as_str(), section.title.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let mut used = vec![false; blocks.len()];
    let mut take = |title: &str| -> Option<String> {
        let at = blocks
            .iter()
            .enumerate()
            .position(|(index, (heading, _))| {
                !used[index] && heading.to_lowercase() == title.trim().to_lowercase()
            })?;
        used[at] = true;
        Some(blocks[at].1.clone())
    };
    let mut body = preamble;
    for section in &new.sections {
        let title = section.title.trim();
        let text = old_titles
            .get(section.id.as_str())
            .and_then(|previous| take(previous))
            .or_else(|| take(title))
            .unwrap_or_else(|| "\n".to_owned());
        body.push_str(HEADING);
        body.push_str(title);
        body.push('\n');
        body.push_str(&text);
    }
    for (index, (heading, text)) in blocks.iter().enumerate() {
        if used[index] || text.trim().is_empty() {
            continue;
        }
        if !body.ends_with('\n') {
            body.push('\n');
        }
        body.push_str(HEADING);
        body.push_str(heading);
        body.push('\n');
        body.push_str(text);
    }
    body
}

/// Writes the dossier layout of a section's template (and its body) into the database manifest:
/// over the revision the caller read, with a history snapshot and an atomic write.
pub fn update_dossier_template(
    env: &Env,
    request: &UpdateDossierTemplateRequest,
) -> Result<UpdatedDossierTemplate, ProjectError> {
    let container = find_database_container(env.vault, &request.database_id)
        .map_err(|e| io("databaseNotFound", e))?;
    let manifest_path = manifest_path_for_container(&container);
    let original = fs::read(&manifest_path).map_err(|e| io("readManifest", e))?;
    let parsed = parse_manifest(&original).map_err(|e| io("parseManifest", e))?;
    if parsed.revision != request.expected_manifest_revision {
        return Err(ProjectError::RevisionConflict {
            actual_revision: parsed.revision,
        });
    }
    if parsed.read_only.is_some() || parsed.value.locked {
        return Err(ProjectError::failed(
            "databaseLocked",
            "the database cannot be changed",
        ));
    }
    let index = template_index(&parsed.value, Some(&request.template_id)).ok_or_else(|| {
        ProjectError::failed("templateNotFound", "no such template in the manifest")
    })?;
    check_layout(&request.dossier, &parsed.value)?;

    let mut layout = request.dossier.clone();
    for section in &mut layout.sections {
        section.id = section.id.trim().to_owned();
        section.title = section.title.trim().to_owned();
        section.hint = section.hint.trim().to_owned();
    }
    let mut manifest = parsed.value.clone();
    let template = manifest
        .extra
        .get_mut("templates")
        .and_then(|templates| templates.get_mut(index))
        .ok_or_else(|| {
            ProjectError::failed("templateNotFound", "no such template in the manifest")
        })?;
    let old_layout = template
        .get(LAYOUT_KEY)
        .and_then(|value| serde_json::from_value::<DossierLayout>(value.clone()).ok());
    let old_body = template
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    template["body"] = Value::from(render_body(&old_body, old_layout.as_ref(), &layout));
    template[LAYOUT_KEY] = serde_json::to_value(&layout).map_err(|e| io("serialize", e))?;
    if !validate_manifest(&manifest).errors.is_empty() {
        return Err(invalid(
            "dossier",
            "the template would make the manifest invalid",
        ));
    }

    let prepared = prepare_json(&parsed, &manifest).map_err(|e| io("serialize", e))?;
    let current = fs::read(&manifest_path).map_err(|e| io("readManifest", e))?;
    if raw_revision(&current) != request.expected_manifest_revision {
        return Err(ProjectError::RevisionConflict {
            actual_revision: raw_revision(&current),
        });
    }
    crate::history::snapshot_before_write(
        env.vault,
        &manifest_path,
        &prepared.bytes,
        "database-metadata",
    )
    .map_err(|e| io("history", e))?;
    let write = env.watcher.prepare_write([(
        &manifest_path,
        self_write::fingerprint_for_bytes(&prepared.bytes),
    )]);
    if let Err(error) = frontmatter::atomic_write_bytes(&manifest_path, &prepared.bytes) {
        env.watcher.cancel_prepared_write(&write);
        return Err(io("writeManifest", error));
    }
    env.watcher.confirm_prepared_write(&write);

    let written: Value =
        serde_json::from_slice(&prepared.bytes).map_err(|e| io("parseManifest", e))?;
    let template = written
        .get("templates")
        .and_then(|templates| templates.get(index))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(UpdatedDossierTemplate {
        template: summary(&request.database_id, &template, prepared.revision)?,
        warnings: Vec::new(),
    })
}
