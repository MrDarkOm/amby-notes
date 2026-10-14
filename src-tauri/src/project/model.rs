//! IPC and domain types of the creative workshop layer (see `docs/creative-format.md`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const WORKSHOP_FILE_NAME: &str = "amby-workshop.json";
pub const STORY_FILE_NAME: &str = "amby-story.json";
pub const LEGACY_PROJECT_FILE_NAME: &str = "amby-project.json";

/// Format version 3 is the flat workshop format.
pub const KNOWN_FORMAT_VERSION: u64 = 3;

/// Workshop section roles.
pub const ROLE_STORIES: &str = "stories";
pub const ROLE_CHARACTERS: &str = "characters";
pub const ROLE_LOCATIONS: &str = "locations";
pub const ROLE_UNIVERSES: &str = "universes";
pub const ROLE_ARCS: &str = "arcs";
pub const ROLE_ANCHORS: &str = "anchors";
pub const ROLE_NOTES: &str = "notes";
pub const ROLE_CUSTOM: &str = "custom";

pub const KNOWN_ROLES: [&str; 8] = [
    ROLE_STORIES,
    ROLE_CHARACTERS,
    ROLE_LOCATIONS,
    ROLE_UNIVERSES,
    ROLE_ARCS,
    ROLE_ANCHORS,
    ROLE_NOTES,
    ROLE_CUSTOM,
];

#[allow(dead_code)]
pub const BASE_ROLES: [&str; 3] = [ROLE_STORIES, ROLE_CHARACTERS, ROLE_LOCATIONS];
#[allow(dead_code)]
pub const LAZY_ROLES: [&str; 4] = [ROLE_UNIVERSES, ROLE_ARCS, ROLE_ANCHORS, ROLE_NOTES];

/// Typed failures of every project / workshop command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[allow(dead_code)]
pub enum ProjectError {
    ModuleDisabled,
    VaultNotOpen,
    VaultGenerationConflict {
        #[serde(rename = "actualGeneration")]
        actual_generation: u64,
    },
    InvalidOperationId,
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
    WorkshopNotFound {
        #[serde(rename = "workshopId")]
        workshop_id: String,
    },
    StoryNotFound {
        #[serde(rename = "storyId")]
        story_id: String,
    },
    WorkshopReadOnly {
        #[serde(rename = "formatVersion")]
        format_version: u64,
    },
    StoryReadOnly {
        #[serde(rename = "formatVersion")]
        format_version: u64,
    },
    RevisionConflict {
        #[serde(rename = "actualRevision")]
        actual_revision: String,
    },
    UnsupportedRole {
        role: String,
    },
    UnsupportedPreset {
        preset: String,
    },
    SectionNotFound {
        #[serde(rename = "sectionId")]
        section_id: String,
    },
    CannotRemoveStoriesSection,
    CannotRemoveTextSection,
    StatusAlreadyConfigured,
    StoryLinksAlreadyConfigured,
    StoryLinksUnavailable {
        reason: String,
    },
    TextNotConfigured,
    UnknownTextLevel {
        #[serde(rename = "levelId")]
        level_id: String,
    },
    UnknownTextFormat {
        #[serde(rename = "formatId")]
        format_id: String,
    },
    InvalidOrderKey,
    PageNotFound {
        #[serde(rename = "noteId")]
        note_id: String,
    },
    ParentCycle,
    ParentLevelNotShallower {
        #[serde(rename = "parentLevelId")]
        parent_level_id: String,
        #[serde(rename = "levelId")]
        level_id: String,
    },
    LevelInUse {
        #[serde(rename = "levelId")]
        level_id: String,
        count: u64,
    },
    RolledBack {
        #[serde(rename = "operationId")]
        operation_id: String,
        message: String,
    },
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
            ProjectError::WorkshopNotFound { workshop_id } => {
                write!(formatter, "Workshop {workshop_id} was not found")
            }
            ProjectError::StoryNotFound { story_id } => {
                write!(formatter, "Story {story_id} was not found")
            }
            ProjectError::WorkshopReadOnly { format_version } => {
                write!(formatter, "Workshop format {format_version} is read-only")
            }
            ProjectError::StoryReadOnly { format_version } => {
                write!(formatter, "Story format {format_version} is read-only")
            }
            ProjectError::RevisionConflict { .. } => write!(formatter, "Revision conflict"),
            ProjectError::UnsupportedRole { role } => write!(formatter, "Unsupported role {role}"),
            ProjectError::UnsupportedPreset { preset } => {
                write!(formatter, "Unsupported section preset {preset}")
            }
            ProjectError::SectionNotFound { section_id } => {
                write!(formatter, "Section {section_id} was not found")
            }
            ProjectError::CannotRemoveStoriesSection => {
                write!(
                    formatter,
                    "The stories section of a workshop cannot be removed"
                )
            }
            ProjectError::CannotRemoveTextSection => {
                write!(formatter, "The text section cannot be removed")
            }
            ProjectError::StatusAlreadyConfigured => {
                write!(
                    formatter,
                    "Page status is already configured for this story"
                )
            }
            ProjectError::StoryLinksAlreadyConfigured => {
                write!(formatter, "This section is already linked")
            }
            ProjectError::StoryLinksUnavailable { reason } => {
                write!(formatter, "This section cannot be linked: {reason}")
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
            ProjectError::LevelInUse { level_id, count } => {
                write!(
                    formatter,
                    "Text level {level_id} is in use by {count} page(s)"
                )
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
pub struct WorkshopSectionSummary {
    pub id: String,
    pub role: String,
    pub name: String,
    pub database_id: String,
    /// The relative path recorded in the structure file (a hint).
    pub path_hint: String,
    /// The ID of the relation property linking this section's pages to stories, when set.
    pub stories_property_id: Option<String>,
    /// The ID of the relation property linking a story to a universe (stories section only).
    pub universe_property_id: Option<String>,
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

/// A page format.
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

/// An option of the optional `status` property of the text database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextStatusOptionSummary {
    pub id: String,
    pub name: String,
    pub color: String,
    /// `notStarted`, `inProgress` or `done`.
    pub group: String,
}

/// The system properties of the text database; each is present only if it exists there.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextPropertyIds {
    pub level: Option<String>,
    pub parent: Option<String>,
    pub order: Option<String>,
    pub format: Option<String>,
    pub status: Option<String>,
    pub anchors: Option<String>,
    pub arcs: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextSummary {
    pub database_id: Option<String>,
    pub properties: TextPropertyIds,
    pub levels: Vec<TextLevelSummary>,
    pub formats: Vec<TextFormatSummary>,
    pub status_options: Vec<TextStatusOptionSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StorySummary {
    pub story_id: String,
    pub workshop_id: String,
    pub name: String,
    pub folder_path: String,
    pub card_path: String,
    pub card_note_id: Option<String>,
    pub database_id: Option<String>,
    pub file_revision: String,
    pub format_version: u64,
    pub text_json: Option<String>,
    pub text: Option<ProjectTextSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkshopSummary {
    pub workshop_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    /// Vault-relative workshop folder; empty for a workshop at the vault root.
    pub path: String,
    /// Raw-byte revision of `amby-workshop.json`.
    pub file_revision: String,
    pub format_version: u64,
    pub read_only: bool,
    pub sections: Vec<WorkshopSectionSummary>,
    pub stories: Vec<StorySummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiagnostic {
    /// Stable code the interface localizes, for example `duplicateWorkshopId`.
    pub code: String,
    /// `warning` or `error`.
    pub severity: String,
    /// Vault-relative path of the relevant file.
    pub path: String,
    pub workshop_id: Option<String>,
    pub story_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCatalog {
    pub vault_generation: u64,
    /// Changes whenever the index is rebuilt.
    pub index_epoch: String,
    pub workshops: Vec<WorkshopSummary>,
    pub diagnostics: Vec<ProjectDiagnostic>,
}

// ---------------------------------------------------------------------------
// Creation & Mutation Requests & Responses
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkshopRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub name: String,
    #[serde(default)]
    pub parent_path: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorkshopSection {
    pub section_id: String,
    pub role: String,
    pub name: String,
    pub database_id: String,
    pub path: String,
    pub container_path: String,
    pub manifest_revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorkshop {
    pub operation_id: String,
    pub workshop_id: String,
    pub name: String,
    pub path: String,
    pub file_path: String,
    pub file_revision: String,
    pub sections: Vec<CreatedWorkshopSection>,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateStoryRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub workshop_id: String,
    pub title: String,
    #[serde(default)]
    pub text_levels: Option<Vec<String>>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedStory {
    pub operation_id: String,
    pub workshop_id: String,
    pub story_id: String,
    pub title: String,
    pub folder_path: String,
    pub card_path: String,
    pub card_note_id: String,
    pub database_id: String,
    pub story_file_revision: String,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkshopSectionRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub workshop_id: String,
    pub expected_workshop_revision: String,
    pub role: String,
    pub name: String,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorkshopSectionResult {
    pub operation_id: String,
    pub workshop_id: String,
    pub section: CreatedWorkshopSection,
    pub workshop_revision: String,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkshopRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub workshop_id: String,
    pub expected_workshop_revision: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedWorkshop {
    pub operation_id: String,
    pub workshop_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub tags: Vec<String>,
    pub workshop_revision: String,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorkshopSectionRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub workshop_id: String,
    pub expected_workshop_revision: String,
    pub section_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemovedWorkshopSection {
    pub operation_id: String,
    pub workshop_id: String,
    pub section_id: String,
    pub workshop_revision: String,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderWorkshopSectionsRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub workshop_id: String,
    pub expected_workshop_revision: String,
    pub section_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderedWorkshopSections {
    pub operation_id: String,
    pub workshop_id: String,
    pub section_ids: Vec<String>,
    pub workshop_revision: String,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextLevelUpdateInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTextLevelsRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub story_id: String,
    pub expected_story_revision: String,
    pub levels: Vec<TextLevelUpdateInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedTextLevels {
    pub operation_id: String,
    pub story_id: String,
    pub story_revision: String,
    pub manifest_revision: String,
    pub level_ids: Vec<String>,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddTextStatusRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub story_id: String,
    pub expected_story_revision: String,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddedTextStatus {
    pub operation_id: String,
    pub story_id: String,
    pub property_id: String,
    pub story_revision: String,
    pub manifest_revision: String,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

/// Links a section to stories (a world section) or a story to universes (the stories section).
/// Which one is decided by the section's role.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddStoryLinksRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub workshop_id: String,
    pub expected_workshop_revision: String,
    pub section_id: String,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddedStoryLinks {
    pub operation_id: String,
    pub workshop_id: String,
    pub section_id: String,
    /// `stories` for a world section, `universe` for the stories section.
    pub link: String,
    pub property_id: String,
    pub workshop_revision: String,
    pub replayed: bool,
    pub warnings: Vec<String>,
}

/// A page of a world section. With `story_id` the page is born linked to that story's card.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkshopEntityRequest {
    pub expected_generation: u64,
    pub workshop_id: String,
    pub section_id: String,
    pub title: String,
    #[serde(default)]
    pub story_id: Option<String>,
    /// A notebook of the notes base: the folder names from the base's root down, such as
    /// `["Идеи", "Сюжеты"]`. Empty or absent puts the page in the root of the base.
    #[serde(default)]
    pub notebook: Option<Vec<String>>,
}

/// One notebook: a plain folder inside the notes base (`docs/creative-format.md` §6).
#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    /// Folder names from the base's root down to this notebook.
    pub segments: Vec<String>,
    /// The folder on disk, as the file tree names it.
    pub path: String,
    /// What lies directly in the folder besides notebooks: notes, their folders, any other file.
    pub item_count: u32,
}

/// The notebooks of one base and the base's own folder.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCatalog {
    pub database_id: String,
    /// The base's folder on disk, as the file tree names it.
    pub container_path: String,
    /// What lies directly in the base's folder besides notebooks.
    pub root_item_count: u32,
    /// Parents come before their children, siblings by name.
    pub notebooks: Vec<Notebook>,
    /// The folder tree was deeper or wider than a listing reads; the rest is left out.
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorkshopEntity {
    pub database_id: String,
    pub note_id: String,
    pub title: String,
    pub note_path: String,
    pub linked_story_id: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateTextPageRequest {
    pub expected_generation: u64,
    pub story_id: String,
    pub title: String,
    #[serde(default)]
    pub parent_note_id: Option<String>,
    pub level_id: String,
    #[serde(default)]
    pub format_id: Option<String>,
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
    pub operation_id: String,
    pub story_id: String,
    pub note_id: String,
    #[serde(default)]
    pub new_parent_note_id: Option<String>,
    pub order_key: String,
    pub expected_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MovedTextPage {
    pub database_id: String,
    pub note_id: String,
    pub parent_note_id: Option<String>,
    pub order_key: String,
    pub revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChangedPayload {
    pub kind: &'static str,
    pub path: String,
    pub generation: u64,
}
