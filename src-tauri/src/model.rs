use serde::Serialize;

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

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAsset {
    pub rel_path: String,
    pub abs_path: String,
    pub file_name: String,
    pub kind: String,
}
