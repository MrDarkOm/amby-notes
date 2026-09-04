use serde::{Deserialize, Serialize};

/// Version of the rebuildable database projection. DB-02 does not publish a
/// projection yet, but the typed boundary is established now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionVersion {
    pub epoch: String,
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseModuleState {
    pub enabled: bool,
    pub vault_generation: Option<u64>,
    pub projection: Option<ProjectionVersion>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseViewSummary {
    pub view_id: String,
    pub title: String,
    pub layout: String,
    pub revision: String,
    pub group_field: Option<DatabaseFieldRef>,
}

/// A summary deliberately contains no filesystem path. Resource resolution
/// stays backend-owned and only safe view metadata crosses the IPC boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSummary {
    pub database_id: String,
    pub title: String,
    pub views: Vec<DatabaseViewSummary>,
    pub diagnostics: Vec<DatabaseDiagnostic>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DatabaseFieldRef {
    System { field: String },
    Property { property_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DatabaseFilterNode {
    Group {
        operator: String,
        children: Vec<DatabaseFilterNode>,
    },
    Condition {
        field: DatabaseFieldRef,
        operator: String,
        /// JSON-encoded operand. It is parsed and type-checked by Rust before
        /// becoming a SQLite bind value; SQL expressions are never accepted.
        value: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSortSpec {
    pub field: DatabaseFieldRef,
    pub direction: String,
    pub nulls: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQuerySpec {
    pub filter: Option<DatabaseFilterNode>,
    pub sorts: Vec<DatabaseSortSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePageRequest {
    pub limit: u32,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DatabaseQuerySource {
    SavedView {
        view_id: String,
        expected_revision: Option<String>,
    },
    Inline {
        spec: DatabaseQuerySpec,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQueryRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub source: DatabaseQuerySource,
    pub page: DatabasePageRequest,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRow {
    pub note_id: String,
    pub title: String,
    pub relative_path: String,
    pub parent_note_id: Option<String>,
    pub depth: usize,
    pub category_path: Vec<String>,
    pub values_json: String,
    pub row_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDiagnostic {
    pub code: String,
    pub severity: String,
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQueryResult {
    pub database: DatabaseSummary,
    pub projection: ProjectionVersion,
    pub rows: Vec<DatabaseRow>,
    pub next_cursor: Option<String>,
    pub diagnostics: Vec<DatabaseDiagnostic>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[allow(dead_code)]
pub enum DatabaseError {
    ModuleDisabled,
    VaultNotOpen,
    VaultGenerationConflict { actual_generation: u64 },
    Failed { code: String, message: String },
}
