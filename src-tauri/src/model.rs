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
    pub index_state: IndexState,
    pub warnings: Vec<OperationWarning>,
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

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteProperties {
    pub has_frontmatter: bool,
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
