use serde::{Deserialize, Serialize};

/// Health of the rebuildable SQLite index. Markdown files remain authoritative
/// regardless of this state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Degraded is reserved for recoverable index work in WP-10.
pub enum IndexState {
    Healthy,
    Degraded,
    RebuildRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OperationWarning {
    IndexRebuildRequired,
}

/// The filesystem result is authoritative. A cache failure is returned as a
/// recoverable warning rather than turning a completed mutation into an error.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MutationOutcome {
    pub mutation: FsMutationResult,
    pub index_state: IndexState,
    pub warnings: Vec<OperationWarning>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WriteNoteOutcome {
    pub path: String,
    pub revision: String,
    pub index_state: IndexState,
    pub warnings: Vec<OperationWarning>,
}

#[derive(Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WriteNoteRequest {
    pub expected_generation: u64,
    pub note_id: String,
    pub content: String,
    pub expected_revision: String,
    pub origin_window: String,
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreDeletedNoteRequest {
    pub expected_generation: u64,
    pub note_id: String,
    pub path: String,
    pub content: String,
    pub source_template: String,
    pub origin_window: String,
}

/// Editor text, its on-disk revision, and the complete source retained as a
/// restore template. Revisions hash unnormalised body bytes for stable IDs and
/// the complete source for opaque path keys, detecting YAML-only external edits.
/// Unterminated frontmatter is edited as full source; other notes expose body.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteReadOutcome {
    pub content: String,
    pub revision: String,
    pub source: String,
}

/// A save failure that callers can distinguish from transport and filesystem
/// failures. In particular, a stale renderer must never retry a CAS conflict
/// with its old buffer.
#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteNoteError {
    RevisionConflict { actual_revision: String },
    Failed { message: String },
}

impl WriteNoteError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteWrittenPayload {
    pub note_id: String,
    pub revision: String,
    pub origin_window: String,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PathChange {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsMutationResult {
    pub primary_id: Option<String>,
    pub primary_path: Option<String>,
    pub path_changes: Vec<PathChange>,
    pub deleted_paths: Vec<String>,
    pub deleted_ids: Vec<String>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LayerResult {
    pub note_path: String,
    pub layer_path: String,
    pub kind: String,
    pub path_changes: Vec<PathChange>,
}

#[derive(Serialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteLayers {
    pub canvas: bool,
    pub sketch: bool,
    pub database: bool,
}

#[derive(Serialize, specta::Type)]
pub struct FileMetadata {
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub word_count: usize,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadata {
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub word_count: usize,
}

/// Read-only view of a single YAML frontmatter entry. The original YAML stays
/// on disk untouched; `value` is only a display representation for the UI.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterProperty {
    pub key: String,
    pub value: String,
    pub value_kind: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomProperty {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub property_type: String,
    pub value: String,
    pub settings: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FrontmatterStatus {
    None,
    Valid,
    Invalid,
    Unterminated,
}

impl FrontmatterStatus {
    pub fn is_malformed(self) -> bool {
        matches!(self, Self::Invalid | Self::Unterminated)
    }
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteProperties {
    pub has_frontmatter: bool,
    pub frontmatter_status: FrontmatterStatus,
    pub body_read_only: bool,
    pub properties: Vec<FrontmatterProperty>,
    pub parse_error: Option<String>,
    pub custom_properties: Vec<CustomProperty>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAsset {
    pub rel_path: String,
    pub abs_path: String,
    pub file_name: String,
    pub kind: String,
}
