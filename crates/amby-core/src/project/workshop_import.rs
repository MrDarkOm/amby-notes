//! Link existing notes into a workshop. The registry and operation receipts share one
//! atomic publication, so there is no interval in which only half the batch exists.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::index::load_catalog;
use super::model::{ProjectError, WorkshopSummary, WORKSHOP_FILE_NAME};
use crate::atomic_fs::atomic_write_bytes_checked;
use crate::database::format::raw_revision;
use crate::durable::guarded_path;

mod preview;

pub const IMPORT_FILE_NAME: &str = "amby-imports.json";
const MAX_ENTRIES: usize = 5_000;
const FORMAT_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub kind: ImportSourceKind,
    pub source_id: String, // Vault-relative folder path or database ID.
    pub section_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportSourceKind {
    Folder,
    Database,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportMapping {
    pub source_key: String,
    pub target_id: String,
}

#[derive(Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelection {
    pub source_index: usize,
    pub note_ids: Vec<String>,
    pub mappings: Vec<ImportMapping>,
}

#[derive(Debug, Deserialize, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ImportAction {
    Preview {
        sources: Vec<ImportSource>,
    },
    Apply {
        sources: Vec<ImportSource>,
        selection: Vec<ImportSelection>,
        #[serde(rename = "expectedPreview")]
        expected_preview: String,
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    List,
    Undo {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Unlink {
        #[serde(rename = "sectionId")]
        section_id: String,
        #[serde(rename = "noteId")]
        note_id: String,
    },
}

#[derive(Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkshopImportRequest {
    pub expected_generation: u64,
    pub workshop_id: String,
    pub action: ImportAction,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportField {
    pub key: String,
    pub name: String,
    pub value_type: String,
    pub example: Option<String>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub note_id: Option<String>,
    pub path: String,
    pub title: String,
    pub already_linked: bool,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourcePreview {
    pub source: ImportSource,
    pub candidates: Vec<ImportCandidate>,
    pub source_fields: Vec<ImportField>,
    pub target_fields: Vec<ImportField>,
    pub suggested: Vec<ImportMapping>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub revision: String,
    pub write_path: String,
    pub sources: Vec<ImportSourcePreview>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedNote {
    pub operation_id: String,
    pub section_id: String,
    pub note_id: String,
    pub title: String,
    pub available: bool,
    pub fields: Vec<ImportedField>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkshopImportResult {
    pub preview: Option<ImportPreview>,
    pub entries: Vec<ImportedNote>,
    pub added: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportEntry {
    pub operation_id: String,
    pub section_id: String,
    pub note_id: String,
    pub title: String,
    pub database_id: Option<String>,
    pub mappings: Vec<ImportMapping>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Registry {
    version: u32,
    pub receipts: BTreeMap<String, String>,
    pub entries: Vec<ImportEntry>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            version: FORMAT_VERSION,
            receipts: BTreeMap::new(),
            entries: Vec::new(),
        }
    }
}

pub(super) struct RegistryRead {
    pub value: Registry,
    pub revision: String,
}

fn failed(code: &str, cause: impl std::fmt::Display) -> ProjectError {
    ProjectError::failed(code, cause.to_string())
}

pub(super) fn read_registry(path: &Path) -> Result<RegistryRead, ProjectError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RegistryRead {
                value: Registry::default(),
                revision: String::new(),
            });
        }
        Err(error) => return Err(failed("workshopImportRead", error)),
    };
    let value: Registry =
        serde_json::from_slice(&bytes).map_err(|error| failed("workshopImportRead", error))?;
    if value.version != FORMAT_VERSION {
        return Err(failed("workshopImportRead", "Unknown registry version"));
    }
    Ok(RegistryRead {
        value,
        revision: raw_revision(&bytes),
    })
}

pub(super) fn publish(path: &Path, previous: &str, next: &Registry) -> Result<(), ProjectError> {
    let bytes =
        serde_json::to_vec_pretty(next).map_err(|error| failed("workshopImportWrite", error))?;
    let revision = raw_revision(&bytes);
    let result = atomic_write_bytes_checked(path, &bytes, || {
        let actual = read_registry(path)
            .map_err(|error| error.to_string())?
            .revision;
        if actual == previous {
            Ok(())
        } else {
            Err("Import registry changed".into())
        }
    });
    if let Err(error) = result {
        let actual = read_registry(path)?.revision;
        // Publication may have succeeded even when directory sync or a post-publish fault failed.
        if actual == revision {
            return Ok(());
        }
        if actual != previous {
            return Err(ProjectError::RevisionConflict {
                actual_revision: actual,
            });
        }
        return Err(failed("workshopImportWrite", error));
    }
    Ok(())
}

fn import_paths(
    root: &Path,
    workshop: &WorkshopSummary,
) -> Result<(PathBuf, String), ProjectError> {
    let relative = |name: &str| {
        if workshop.path.is_empty() {
            name.to_owned()
        } else {
            format!("{}/{}", workshop.path, name)
        }
    };
    let marker = guarded_path(root, &relative(WORKSHOP_FILE_NAME), "workshop import")
        .map_err(|error| failed("workshopImportRead", error))?;
    let revision = fs::read(marker)
        .map(|bytes| raw_revision(&bytes))
        .map_err(|error| failed("workshopImportRead", error))?;
    if revision != workshop.file_revision {
        return Err(ProjectError::RevisionConflict {
            actual_revision: revision,
        });
    }
    let registry = relative(IMPORT_FILE_NAME);
    let path = guarded_path(root, &registry, "workshop import")
        .map_err(|error| failed("workshopImportRead", error))?;
    Ok((path, registry))
}

pub fn run(
    conn: &Connection,
    vault: &Path,
    request: &WorkshopImportRequest,
) -> Result<WorkshopImportResult, ProjectError> {
    let catalog = load_catalog(conn, vault, request.expected_generation)
        .map_err(|error| failed("projectIndexFailed", error))?;
    let workshop = catalog
        .workshops
        .iter()
        .find(|item| item.workshop_id == request.workshop_id)
        .ok_or_else(|| failed("workshopImportRead", "Workshop is missing"))?;
    let (path, write_path) = import_paths(vault, workshop)?;
    let RegistryRead {
        mut value,
        revision,
    } = read_registry(&path)?;
    let mut result = WorkshopImportResult {
        preview: None,
        entries: Vec::new(),
        added: 0,
    };
    if workshop.read_only && !matches!(&request.action, ImportAction::List) {
        return Err(ProjectError::WorkshopReadOnly {
            format_version: workshop.format_version,
        });
    }
    match &request.action {
        ImportAction::Preview { sources } => {
            result.preview = Some(preview::build(
                conn, vault, workshop, &value, &revision, write_path, sources,
            )?);
            return Ok(result);
        }
        ImportAction::Apply {
            sources,
            selection,
            expected_preview,
            operation_id,
        } => {
            if !crate::durable::valid_operation_id(operation_id) {
                return Err(failed("workshopImportInvalid", "Invalid operation ID"));
            }
            let request_bytes = serde_json::to_vec(&request.action)
                .map_err(|error| failed("workshopImportInvalid", error))?;
            let receipt = raw_revision(&request_bytes);
            if let Some(existing) = value.receipts.get(operation_id) {
                if existing != &receipt {
                    return Err(failed("workshopImportInvalid", "Operation ID was reused"));
                }
            } else {
                let current = preview::build(
                    conn, vault, workshop, &value, &revision, write_path, sources,
                )?;
                if &current.revision != expected_preview {
                    return Err(ProjectError::RevisionConflict {
                        actual_revision: current.revision,
                    });
                }
                let entries = prepare_entries(&value, &current, selection, operation_id)?;
                result.added = entries.len();
                if result.added > 0 {
                    if value.entries.len() + entries.len() > MAX_ENTRIES {
                        return Err(failed("workshopImportLimit", "Import registry is full"));
                    }
                    value.entries.extend(entries);
                    value.receipts.insert(operation_id.clone(), receipt);
                    publish(&path, &revision, &value)?;
                }
            }
        }
        ImportAction::Undo { operation_id } => {
            let before = value.entries.len();
            value
                .entries
                .retain(|entry| &entry.operation_id != operation_id);
            if value.entries.len() != before {
                publish(&path, &revision, &value)?;
            }
        }
        ImportAction::Unlink {
            section_id,
            note_id,
        } => {
            let before = value.entries.len();
            value
                .entries
                .retain(|entry| &entry.section_id != section_id || &entry.note_id != note_id);
            if value.entries.len() != before {
                publish(&path, &revision, &value)?;
            }
        }
        ImportAction::List => {}
    }
    result.entries = preview::resolve_entries(conn, vault, workshop, &value);
    Ok(result)
}

fn prepare_entries(
    registry: &Registry,
    preview: &ImportPreview,
    selection: &[ImportSelection],
    operation_id: &str,
) -> Result<Vec<ImportEntry>, ProjectError> {
    if selection.len() > preview.sources.len() {
        return Err(failed(
            "workshopImportInvalid",
            "Unexpected import selection",
        ));
    }
    let mut linked = registry
        .entries
        .iter()
        .map(|entry| (entry.section_id.clone(), entry.note_id.clone()))
        .collect::<BTreeSet<_>>();
    let mut result = Vec::new();
    for selected in selection {
        let source = preview
            .sources
            .get(selected.source_index)
            .ok_or_else(|| failed("workshopImportInvalid", "Unknown import source"))?;
        let eligible = source
            .candidates
            .iter()
            .filter_map(|row| row.note_id.as_deref().map(|id| (id, row)))
            .collect::<BTreeMap<_, _>>();
        if selected.note_ids.len() > eligible.len()
            || selected.mappings.len() > source.target_fields.len()
        {
            return Err(failed(
                "workshopImportInvalid",
                "Unexpected import selection",
            ));
        }
        let mut destinations = BTreeSet::new();
        for mapping in &selected.mappings {
            let target = source
                .target_fields
                .iter()
                .find(|field| field.key == mapping.target_id);
            let from = source
                .source_fields
                .iter()
                .find(|field| field.key == mapping.source_key);
            if !target
                .zip(from)
                .is_some_and(|(target, from)| target.value_type == from.value_type)
                || !destinations.insert(&mapping.target_id)
            {
                return Err(failed("workshopImportInvalid", "Invalid field mapping"));
            }
        }
        for note_id in &selected.note_ids {
            let row = eligible
                .get(note_id.as_str())
                .ok_or_else(|| failed("workshopImportInvalid", "Note is unavailable"))?;
            if row.already_linked
                || !linked.insert((source.source.section_id.clone(), note_id.clone()))
            {
                continue;
            }
            result.push(ImportEntry {
                operation_id: operation_id.into(),
                section_id: source.source.section_id.clone(),
                note_id: note_id.clone(),
                title: row.title.clone(),
                database_id: (source.source.kind == ImportSourceKind::Database)
                    .then(|| source.source.source_id.clone()),
                mappings: selected.mappings.clone(),
            });
        }
    }
    Ok(result)
}
