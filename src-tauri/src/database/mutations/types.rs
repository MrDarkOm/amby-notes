use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseCreateMode {
    Standalone,
    Attached,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseRequest {
    pub expected_generation: u64,
    pub mode: DatabaseCreateMode,
    pub parent_path: Option<String>,
    pub note_path: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabase {
    pub database_id: String,
    pub title: String,
    pub manifest_revision: String,
    pub view_id: String,
    pub view_revision: String,
    pub manifest_path: String,
    pub view_path: String,
    pub note_path: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseValueMutation {
    pub note_id: String,
    pub property_id: String,
    pub value_json: Option<String>,
    pub expected_revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseValueBatchRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub operation_id: String,
    pub cells: Vec<DatabaseValueMutation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseNoteRevision {
    pub note_id: String,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseValueBatchResult {
    pub operation_id: String,
    pub database_id: String,
    pub revisions: Vec<DatabaseNoteRevision>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabasePropertyRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub expected_manifest_revision: String,
    pub name: String,
    pub property_type: String,
    pub before_property_id: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub formula_expression: Option<String>,
    #[serde(default)]
    pub relation_target_database_id: Option<String>,
    #[serde(default)]
    pub relation_max_items: Option<u8>,
    #[serde(default)]
    pub relation_two_way: Option<bool>,
    #[serde(default)]
    pub relation_inverse_property_name: Option<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub expected_target_manifest_revision: Option<String>,
    #[serde(default)]
    pub rollup_relation_property_id: Option<String>,
    #[serde(default)]
    pub rollup_target_property_id: Option<String>,
    #[serde(default)]
    pub rollup_aggregation: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameDatabaseRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub expected_manifest_revision: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenamedDatabase {
    pub database_id: String,
    pub title: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabaseProperty {
    pub database_id: String,
    pub property_id: String,
    pub name: String,
    pub property_type: String,
    pub manifest_revision: String,
    pub operation_id: Option<String>,
    pub inverse_property_id: Option<String>,
    pub manifest_revisions: Vec<DatabaseManifestRevision>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseManifestRevision {
    pub database_id: String,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameDatabasePropertyRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenamedDatabaseProperty {
    pub database_id: String,
    pub property_id: String,
    pub name: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOptionInput {
    /// Existing option to keep (its ID is stable); absent for a new option.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub color: String,
    /// Status only: `notStarted`, `inProgress` or `done`.
    #[serde(default)]
    pub group: Option<String>,
    /// New rows start with this option. A Select or Status has at most one such option.
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabasePropertyOptionsRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
    /// The complete, ordered option list of the property.
    pub options: Vec<DatabaseOptionInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOptionResult {
    pub id: String,
    pub name: String,
    pub color: String,
    pub group: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedDatabasePropertyOptions {
    pub database_id: String,
    pub property_id: String,
    pub manifest_revision: String,
    /// The saved list in order, with IDs assigned to the new options.
    pub options: Vec<DatabaseOptionResult>,
    pub warnings: Vec<String>,
}

/// A change to the settings of a Text, Number, Date or Formula property. Only the
/// fields that apply to the property's type may be set.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabasePropertyConfigRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
    /// Text: whether the value may span lines.
    #[serde(default)]
    pub multiline: Option<bool>,
    /// Number: `number`, `percent` or `currency`.
    #[serde(default)]
    pub number_format: Option<String>,
    /// Number: ISO 4217 code (three capital letters) of the `currency` format.
    #[serde(default)]
    pub currency: Option<String>,
    /// Date: whether values carry a time. Only while the property has no values.
    #[serde(default)]
    pub include_time: Option<bool>,
    /// Date: whether values may be a range. Only while the property has no values.
    #[serde(default)]
    pub allow_range: Option<bool>,
    /// Date, display only: `full`, `monthDayYear`, `dayMonthYear`, `yearMonthDay` or `relative`.
    #[serde(default)]
    pub date_format: Option<String>,
    /// Date, display only: `12h` or `24h`.
    #[serde(default)]
    pub time_format: Option<String>,
    /// Formula: the expression.
    #[serde(default)]
    pub formula_expression: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedDatabasePropertyConfig {
    pub database_id: String,
    pub property_id: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDatabasePropertyTypeRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
    pub property_type: String,
    #[serde(default)]
    pub relation_target_database_id: Option<String>,
    #[serde(default)]
    pub relation_max_items: Option<u8>,
    #[serde(default)]
    pub relation_two_way: Option<bool>,
    #[serde(default)]
    pub relation_inverse_property_name: Option<String>,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub expected_related_manifest_revisions: Vec<DatabaseManifestRevision>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseRelationValueRequest {
    pub expected_generation: u64,
    pub operation_id: String,
    pub expected_revision: String,
    pub database_id: String,
    pub note_id: String,
    pub property_id: String,
    pub target_note_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseAffectedNote {
    pub database_id: String,
    pub note_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseRelationValueResult {
    pub operation_id: String,
    pub database_id: String,
    pub note_id: String,
    pub target_note_ids: Vec<String>,
    pub affected_notes: Vec<DatabaseAffectedNote>,
    pub revisions: Vec<DatabaseNoteRevision>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDatabasePropertyType {
    pub database_id: String,
    pub property_id: String,
    pub property_type: String,
    pub manifest_revision: String,
    pub operation_id: Option<String>,
    pub inverse_property_id: Option<String>,
    pub manifest_revisions: Vec<DatabaseManifestRevision>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDatabasePropertyRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub property_id: String,
    pub expected_manifest_revision: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedDatabaseProperty {
    pub database_id: String,
    pub property_id: String,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderDatabasePropertiesRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub expected_manifest_revision: String,
    pub property_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderedDatabaseProperties {
    pub database_id: String,
    pub property_ids: Vec<String>,
    pub manifest_revision: String,
    pub warnings: Vec<String>,
}
