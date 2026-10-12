//! IPC and domain types of the creative-project layer (see `docs/creative-format.md`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const PROJECT_FILE_NAME: &str = "amby-project.json";
/// The only structure-file version this build reads and writes. A different
/// version opens read-only and the file is never rewritten.
pub const KNOWN_FORMAT_VERSION: u64 = 2;

/// Base section roles. A role is only a hint for which surfaces to offer.
pub const ROLE_TEXT: &str = "text";
pub const ROLE_NOTES: &str = "notes";
pub const ROLE_CHARACTERS: &str = "characters";
pub const ROLE_LOCATIONS: &str = "locations";
/// The key, unchanging events of a story. A hint like the others: the section is an ordinary
/// database, and a story may have none.
pub const ROLE_ANCHORS: &str = "anchors";
pub const KNOWN_ROLES: [&str; 5] = [
    ROLE_TEXT,
    ROLE_NOTES,
    ROLE_CHARACTERS,
    ROLE_LOCATIONS,
    ROLE_ANCHORS,
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    Collection,
    Story,
}

impl ProjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectKind::Collection => "collection",
            ProjectKind::Story => "story",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "collection" => Some(ProjectKind::Collection),
            "story" => Some(ProjectKind::Story),
            _ => None,
        }
    }
}

/// Typed failures of every project command. Field names are spelled out so the
/// generated TypeScript matches `DatabaseError`'s style.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectError {
    ModuleDisabled,
    VaultNotOpen,
    VaultGenerationConflict {
        #[serde(rename = "actualGeneration")]
        actual_generation: u64,
    },
    InvalidOperationId,
    /// The operation ID was already used for a different request.
    OperationIdReused {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    InvalidName {
        field: String,
        reason: String,
    },
    InvalidParent {
        reason: String,
    },
    PathCollision {
        path: String,
    },
    NestedCollectionUnsupported {
        #[serde(rename = "ancestorPath")]
        ancestor_path: String,
    },
    /// The enclosing project has a format this build does not know.
    ParentProjectReadOnly {
        path: String,
    },
    ProjectNotFound {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    /// The structure file is newer than this build; it opens read-only.
    ProjectReadOnly {
        #[serde(rename = "formatVersion")]
        format_version: u64,
    },
    RevisionConflict {
        #[serde(rename = "actualRevision")]
        actual_revision: String,
    },
    UnknownGroup {
        #[serde(rename = "groupId")]
        group_id: String,
    },
    UnsupportedRole {
        role: String,
    },
    /// The section preset is not one of the known starting points.
    UnsupportedPreset {
        preset: String,
    },
    /// The story has no text schema (no `text` block, or its database is not found).
    TextNotConfigured,
    UnknownTextLevel {
        #[serde(rename = "levelId")]
        level_id: String,
    },
    UnknownTextFormat {
        #[serde(rename = "formatId")]
        format_id: String,
    },
    /// An order key is 1-64 characters of `0-9A-Za-z`, compared bytewise.
    InvalidOrderKey,
    /// The page, or the parent it should go under, is not a page of the text database.
    PageNotFound {
        #[serde(rename = "noteId")]
        note_id: String,
    },
    /// The move would make a page its own ancestor.
    ParentCycle,
    /// A parent must be on a shallower level than the page: the one named is the same or deeper
    /// in `text.levels` (skipping a level is allowed).
    ParentLevelNotShallower {
        #[serde(rename = "parentLevelId")]
        parent_level_id: String,
        #[serde(rename = "levelId")]
        level_id: String,
    },
    /// The operation failed and everything it had created was removed.
    RolledBack {
        #[serde(rename = "operationId")]
        operation_id: String,
        message: String,
    },
    /// The operation failed and could not clean up completely; the journal is
    /// kept and the leftovers are listed in the message.
    RecoveryRequired {
        #[serde(rename = "operationId")]
        operation_id: String,
        message: String,
    },
    Failed {
        code: String,
        message: String,
    },
}

impl ProjectError {
    pub fn failed(code: &str, message: impl Into<String>) -> Self {
        ProjectError::Failed {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::ModuleDisabled => write!(formatter, "Database module is disabled"),
            ProjectError::VaultNotOpen => write!(formatter, "No vault is open"),
            ProjectError::VaultGenerationConflict { actual_generation } => {
                write!(formatter, "Vault changed (generation {actual_generation})")
            }
            ProjectError::InvalidOperationId => write!(formatter, "Invalid operation ID"),
            ProjectError::OperationIdReused { operation_id } => {
                write!(
                    formatter,
                    "Operation ID {operation_id} was used for another request"
                )
            }
            ProjectError::InvalidName { field, reason } => {
                write!(formatter, "Invalid {field}: {reason}")
            }
            ProjectError::InvalidParent { reason } => write!(formatter, "Invalid parent: {reason}"),
            ProjectError::PathCollision { path } => {
                write!(formatter, "Path already exists: {path}")
            }
            ProjectError::NestedCollectionUnsupported { ancestor_path } => write!(
                formatter,
                "A collection cannot be created inside the collection at {ancestor_path}"
            ),
            ProjectError::ParentProjectReadOnly { path } => {
                write!(formatter, "The project at {path} has an unknown format")
            }
            ProjectError::ProjectNotFound { project_id } => {
                write!(formatter, "Project {project_id} was not found")
            }
            ProjectError::ProjectReadOnly { format_version } => {
                write!(formatter, "Project format {format_version} is read-only")
            }
            ProjectError::RevisionConflict { .. } => write!(formatter, "Project revision conflict"),
            ProjectError::UnknownGroup { group_id } => {
                write!(formatter, "Unknown project group {group_id}")
            }
            ProjectError::UnsupportedRole { role } => write!(formatter, "Unsupported role {role}"),
            ProjectError::UnsupportedPreset { preset } => {
                write!(formatter, "Unsupported section preset {preset}")
            }
            ProjectError::TextNotConfigured => write!(formatter, "The story has no text schema"),
            ProjectError::UnknownTextLevel { level_id } => {
                write!(formatter, "Unknown text level {level_id}")
            }
            ProjectError::UnknownTextFormat { format_id } => {
                write!(formatter, "Unknown text format {format_id}")
            }
            ProjectError::InvalidOrderKey => write!(formatter, "Invalid order key"),
            ProjectError::PageNotFound { note_id } => {
                write!(formatter, "Page {note_id} was not found in the text")
            }
            ProjectError::ParentLevelNotShallower { .. } => {
                write!(
                    formatter,
                    "A parent must be on a shallower level than the page"
                )
            }
            ProjectError::ParentCycle => {
                write!(formatter, "A page cannot go under its own descendant")
            }
            ProjectError::RolledBack { message, .. } => {
                write!(formatter, "Operation rolled back: {message}")
            }
            ProjectError::RecoveryRequired { message, .. } => {
                write!(formatter, "Recovery required: {message}")
            }
            ProjectError::Failed { message, .. } => write!(formatter, "{message}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Catalog (read side)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroupSummary {
    pub id: String,
    pub name: String,
}

/// How a declared section relates to the databases of the vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SectionState {
    /// The database was found where the structure file says it is.
    Ok,
    /// The database was found at another path; the entry works as is.
    Moved,
    /// No database has this ID. The entry is kept and shown as missing.
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSectionSummary {
    pub id: String,
    pub role: Option<String>,
    pub group_id: Option<String>,
    pub database_id: String,
    /// The relative path recorded in the structure file (a hint).
    pub path_hint: String,
    pub state: SectionState,
    /// Vault-relative container of the database when it was found.
    pub resolved_path: Option<String>,
    pub database_name: Option<String>,
}

/// How an entry of the `text` block relates to the text database.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TextEntryState {
    /// The option exists in the database.
    Ok,
    /// The option was deleted in the database. The entry stays in the file and the
    /// pages that hold the value are not edited.
    Dangling,
    /// The text database was not found, so nothing could be compared.
    Unresolved,
}

/// One level of the work, in the order of `text.levels`. Name and colour come from the
/// option of the level Select; the file only keeps the order and the icon.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextLevelSummary {
    /// The option ID.
    pub id: String,
    pub icon: Option<String>,
    pub name: Option<String>,
    pub color: Option<String>,
    pub state: TextEntryState,
}

/// A page format. `kind` is the file's word; an unknown one is passed through and means
/// plain text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextFormatSummary {
    /// The option ID.
    pub id: String,
    pub kind: String,
    pub name: Option<String>,
    pub color: Option<String>,
    pub state: TextEntryState,
}

/// The system properties of the text database; each is present only if it exists there.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextPropertyIds {
    pub level: Option<String>,
    pub parent: Option<String>,
    pub order: Option<String>,
    pub format: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextSummary {
    /// The database of the section with the role `text`.
    pub database_id: Option<String>,
    pub properties: TextPropertyIds,
    pub levels: Vec<TextLevelSummary>,
    pub formats: Vec<TextFormatSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project_id: String,
    pub kind: ProjectKind,
    pub name: String,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    /// Vault-relative project folder; empty for a project at the vault root.
    pub path: String,
    /// Raw-byte revision of the structure file, for `expectedProjectRevision`.
    pub file_revision: String,
    pub format_version: u64,
    /// True for a format this build does not know: the file is never rewritten.
    pub read_only: bool,
    /// The nearest collection above a story (by folder nesting).
    pub collection_id: Option<String>,
    pub groups: Vec<ProjectGroupSummary>,
    pub sections: Vec<ProjectSectionSummary>,
    /// The `text` block of a story as JSON, exactly as the file has it.
    pub text_json: Option<String>,
    /// The `text` block resolved against the text database.
    pub text: Option<ProjectTextSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiagnostic {
    /// Stable code the interface localizes, for example `duplicateProjectId`.
    pub code: String,
    /// `warning` or `error`.
    pub severity: String,
    /// Vault-relative path of the structure file.
    pub path: String,
    pub project_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCatalog {
    pub vault_generation: u64,
    /// Changes whenever the index is rebuilt.
    pub index_epoch: String,
    pub projects: Vec<ProjectSummary>,
    pub diagnostics: Vec<ProjectDiagnostic>,
}

// ---------------------------------------------------------------------------
// Creation (write side)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub expected_generation: u64,
    /// One per user intent. Repeating the request with the same ID and payload
    /// never creates a second set.
    pub operation_id: String,
    pub kind: ProjectKind,
    pub name: String,
    /// Folder that will contain the project folder (absolute inside the vault,
    /// or vault-relative). Empty means the vault root.
    #[serde(default)]
    pub parent_path: Option<String>,
    /// Encoded `IconValue`, stored as is.
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Create the base sections of the kind: a story gets Text, Notes,
    /// Characters and Locations; a collection gets Characters and Locations (a
    /// universe). A plain collection passes `false`.
    pub base_sections: bool,
    /// Names for the base sections and groups, keyed `section:<role>` and
    /// `group:<id>`, and for the text schema of a story, keyed `property:<key>`,
    /// `level:<key>` and `format:<kind>`. Missing keys fall back to Russian defaults.
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProjectSection {
    pub section_id: String,
    pub role: Option<String>,
    pub group_id: Option<String>,
    pub name: String,
    pub database_id: String,
    /// Path relative to the project folder (the hint stored in the file).
    pub path: String,
    /// Vault-relative container of the new database.
    pub container_path: String,
    pub manifest_revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub operation_id: String,
    pub project_id: String,
    pub kind: ProjectKind,
    pub name: String,
    /// Vault-relative project folder.
    pub path: String,
    /// Vault-relative structure file.
    pub file_path: String,
    pub file_revision: String,
    pub sections: Vec<CreatedProjectSection>,
    /// True when this answer was recorded by an earlier identical call.
    pub replayed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectSectionRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub project_id: String,
    /// Raw-byte revision of the structure file the caller last saw.
    pub expected_project_revision: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    /// A starting point for a world section: `characters`, `locations`, `organizations` or
    /// `items`. It sets an icon, starting properties, a gallery view grouped by importance
    /// (or kind) and the starter headings of the page template. Omitted: an empty database.
    #[serde(default)]
    pub preset: Option<String>,
    /// Names for the text schema (`property:*`, `level:*`, `format:*`) and for a preset
    /// (`preset:*`, `importance:*`, `kind:*`, `heading:*`, `view:gallery`,
    /// `template:dossier`); read only for those sections. Missing keys fall back to Russian.
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSection {
    pub operation_id: String,
    pub project_id: String,
    pub section: CreatedProjectSection,
    pub project_revision: String,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

/// Emitted as the `project:changed` event when the watcher sees a path that can
/// change project discovery. Mirrors the `database:changed` payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChangedPayload {
    /// `file` for the structure file itself, `folder` for a folder event that
    /// may have moved or removed a whole project.
    pub kind: &'static str,
    /// Vault-relative, slash-normalized path.
    pub path: String,
    pub generation: u64,
}

// ---------------------------------------------------------------------------
// Text pages
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateTextPageRequest {
    pub expected_generation: u64,
    pub project_id: String,
    pub title: String,
    /// The page it goes under; none puts it at the top of the text.
    #[serde(default)]
    pub parent_note_id: Option<String>,
    /// An `id` from `text.levels` (the option ID of the level Select).
    pub level_id: String,
    /// An `id` from `text.formats`. Omitted: the manuscript format, when the file has one.
    #[serde(default)]
    pub format_id: Option<String>,
    /// Where it goes among its siblings. The caller computes it (see `fractional-index.ts`).
    pub order_key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedTextPage {
    pub database_id: String,
    pub note_id: String,
    pub title: String,
    pub note_path: String,
    pub level_id: String,
    pub format_id: Option<String>,
    pub parent_note_id: Option<String>,
    pub order_key: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveTextPageRequest {
    pub expected_generation: u64,
    /// One per intent, as for every write: a repeat does not write twice.
    pub operation_id: String,
    pub project_id: String,
    pub note_id: String,
    /// None makes the page a top-level one.
    #[serde(default)]
    pub new_parent_note_id: Option<String>,
    pub order_key: String,
    /// Raw-byte revision of the page the caller last saw.
    pub expected_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MovedTextPage {
    pub database_id: String,
    pub note_id: String,
    pub parent_note_id: Option<String>,
    pub order_key: String,
    /// The page's revision after the write.
    pub revision: String,
    pub warnings: Vec<String>,
}
