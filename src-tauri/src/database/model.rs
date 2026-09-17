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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseChangedRequest {
    pub kind: String,
    pub path: String,
    pub container_path: String,
    pub generation: u64,
    pub requires_full_rebuild: bool,
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

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseViewDocument {
    pub database_id: String,
    pub view_id: String,
    pub title: String,
    pub layout: String,
    pub revision: String,
    pub config_json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseViewRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub expected_manifest_revision: String,
    pub name: String,
    pub layout: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseViewRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub view_id: String,
    pub expected_view_revision: String,
    #[serde(default)]
    pub expected_manifest_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseViewConfigRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub view_id: String,
    pub expected_view_revision: String,
    pub config_json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameDatabaseViewRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub view_id: String,
    pub expected_view_revision: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDatabaseViewRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub view_id: String,
    pub expected_view_revision: String,
    pub expected_manifest_revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderDatabaseViewsRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub expected_manifest_revision: String,
    pub view_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseViewMutationResult {
    pub database_id: String,
    pub view_id: String,
    pub view_revision: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTemplateSummary {
    pub template_id: String,
    pub name: String,
    pub revision: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOptionSummary {
    pub option_id: String,
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePropertySummary {
    pub property_id: String,
    pub name: String,
    pub property_type: String,
    pub config_json: String,
    pub options: Vec<DatabaseOptionSummary>,
}

/// A summary deliberately contains no filesystem path. Resource resolution
/// stays backend-owned and only safe view metadata crosses the IPC boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSummary {
    pub database_id: String,
    pub title: String,
    pub icon: Option<String>,
    pub attached_note_id: Option<String>,
    pub manifest_revision: String,
    pub locked: bool,
    pub properties: Vec<DatabasePropertySummary>,
    pub views: Vec<DatabaseViewSummary>,
    pub templates: Vec<DatabaseTemplateSummary>,
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
    pub search: Option<String>,
    pub sorts: Option<Vec<DatabaseSortSpec>>,
    pub filter: Option<DatabaseFilterNode>,
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
pub struct DatabaseNoteContext {
    pub vault_generation: u64,
    pub database_id: String,
    pub database_title: String,
    pub database_icon: Option<String>,
    pub manifest_revision: String,
    pub locked: bool,
    pub properties: Vec<DatabasePropertySummary>,
    pub row: DatabaseRow,
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
    pub total_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseAggregateRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub source: DatabaseQuerySource,
    pub category: Option<DatabaseFieldRef>,
    pub measure: Option<DatabaseFieldRef>,
    pub aggregation: String,
    pub search: Option<String>,
    pub limit: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseAggregateGroup {
    pub key: String,
    pub label: String,
    pub count: u64,
    pub value: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseAggregateResult {
    pub database_id: String,
    pub groups: Vec<DatabaseAggregateGroup>,
    pub total_count: u64,
    pub warnings: Vec<String>,
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
