//! Durable database JSON types and the pure, filesystem-free JSON boundary.
//!
//! This module intentionally stops at bytes. It does not know about vaults,
//! paths, SQLite, or Tauri state. Callers can parse a shard, validate it, and
//! prepare replacement bytes before choosing an atomic filesystem publisher.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

static OPTION_NAME_HISTORY: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn record_option_name_history(name: &str, option_id: &str) {
    if !name.trim().is_empty() && !option_id.trim().is_empty() {
        if let Ok(mut map) = OPTION_NAME_HISTORY.lock() {
            map.insert(name.trim().to_lowercase(), option_id.trim().to_string());
        }
    }
}

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const SUPPORTED_FORMAT_VERSION: u64 = 1;
pub const MAX_JSON_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_TEMPLATE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_JSON_DEPTH: usize = 64;

pub type ExtraFields = BTreeMap<String, Value>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentKind {
    Manifest,
    Record,
    View,
    Template,
}

impl DocumentKind {
    pub const fn format(self) -> &'static str {
        match self {
            Self::Manifest => "amby-database",
            Self::Record => "amby-database-record",
            Self::View => "amby-database-view",
            Self::Template => "amby-database-template",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadOnlyReason {
    Utf8Bom,
    UnsupportedFormatVersion { actual: u64 },
    UnsupportedLayout { actual: String },
    UnknownLayoutConfig,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FormatError {
    Empty,
    TooLarge {
        bytes: usize,
        limit: usize,
    },
    TooDeep {
        depth: usize,
        limit: usize,
    },
    InvalidUtf8,
    InvalidJson(String),
    NotAnObject,
    MissingField(&'static str),
    WrongFormat {
        expected: &'static str,
        actual: String,
    },
    InvalidFormatVersion,
    UnsupportedFormatVersion {
        actual: u64,
    },
    ReadOnly(ReadOnlyReason),
    Serialization(String),
}

impl std::fmt::Display for FormatError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(formatter, "database JSON is empty"),
            Self::TooLarge { bytes, limit } => {
                write!(
                    formatter,
                    "database JSON is {bytes} bytes; limit is {limit}"
                )
            }
            Self::TooDeep { depth, limit } => {
                write!(
                    formatter,
                    "database JSON depth is {depth}; limit is {limit}"
                )
            }
            Self::InvalidUtf8 => write!(formatter, "database JSON is not valid UTF-8"),
            Self::InvalidJson(error) => write!(formatter, "database JSON is invalid: {error}"),
            Self::NotAnObject => write!(formatter, "database JSON root must be an object"),
            Self::MissingField(field) => write!(formatter, "database JSON is missing {field}"),
            Self::WrongFormat { expected, actual } => {
                write!(formatter, "expected format {expected}, got {actual}")
            }
            Self::InvalidFormatVersion => write!(formatter, "formatVersion must be an integer"),
            Self::UnsupportedFormatVersion { actual } => {
                write!(formatter, "formatVersion {actual} is read-only")
            }
            Self::ReadOnly(reason) => write!(formatter, "document is read-only: {reason:?}"),
            Self::Serialization(error) => {
                write!(formatter, "could not serialize database JSON: {error}")
            }
        }
    }
}

impl std::error::Error for FormatError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedJson<T> {
    pub value: T,
    pub raw: Vec<u8>,
    pub revision: String,
    pub read_only: Option<ReadOnlyReason>,
}

impl<T> ParsedJson<T> {
    pub fn is_writable(&self) -> bool {
        self.read_only.is_none()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedJson {
    pub bytes: Vec<u8>,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DatabaseManifest {
    pub format: String,
    #[serde(rename = "formatVersion")]
    pub format_version: u64,
    #[serde(rename = "databaseId")]
    pub database_id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub cover: Option<DatabaseCover>,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub membership: Membership,
    #[serde(default)]
    pub properties: Vec<PropertyDefinition>,
    #[serde(rename = "viewOrder", default)]
    pub view_order: Vec<String>,
    #[serde(rename = "defaultViewId", default)]
    pub default_view_id: Option<String>,
    #[serde(rename = "templateOrder", default)]
    pub template_order: Vec<String>,
    #[serde(rename = "defaultTemplateId", default)]
    pub default_template_id: Option<String>,
    #[serde(default)]
    pub views: Vec<DatabaseViewFile>,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DatabaseCover {
    pub kind: String,
    #[serde(rename = "assetId")]
    pub asset_id: String,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Membership {
    pub kind: String,
    pub recursive: bool,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

impl Default for Membership {
    fn default() -> Self {
        Self {
            kind: "filesystem-descendants".to_string(),
            recursive: true,
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct YamlBinding {
    pub key: String,
    pub direction: String,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PropertyFields<C> {
    pub id: String,
    pub name: String,
    #[serde(rename = "pageVisibility")]
    pub page_visibility: String,
    #[serde(rename = "yamlBinding", default)]
    pub yaml_binding: Option<YamlBinding>,
    pub config: C,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TextConfig {
    pub multiline: bool,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NumberConfig {
    pub format: String,
    pub currency: Option<String>,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CheckboxConfig {
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DateConfig {
    #[serde(rename = "includeTime")]
    pub include_time: bool,
    #[serde(rename = "allowRange")]
    pub allow_range: bool,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SelectOption {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StatusOption {
    pub id: String,
    pub name: String,
    pub color: String,
    pub group: String,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SelectConfig<O> {
    pub options: Vec<O>,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FilesConfig {
    #[serde(rename = "mediaOnly")]
    pub media_only: bool,
    #[serde(rename = "maxItems")]
    pub max_items: Option<u64>,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RelationConfig {
    #[serde(rename = "targetDatabaseId")]
    pub target_database_id: String,
    #[serde(rename = "maxItems")]
    pub max_items: Option<u8>,
    #[serde(rename = "inversePropertyId")]
    pub inverse_property_id: Option<String>,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FormulaConfig {
    pub version: u64,
    pub expression: String,
    #[serde(rename = "resultType", default)]
    pub result_type: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RollupConfig {
    #[serde(rename = "relationPropertyId")]
    pub relation_property_id: String,
    #[serde(rename = "targetPropertyId")]
    pub target_property_id: String,
    pub aggregation: String,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PropertyDefinition {
    Text(PropertyFields<TextConfig>),
    Number(PropertyFields<NumberConfig>),
    Checkbox(PropertyFields<CheckboxConfig>),
    Date(PropertyFields<DateConfig>),
    Select(PropertyFields<SelectConfig<SelectOption>>),
    MultiSelect(PropertyFields<SelectConfig<SelectOption>>),
    Status(PropertyFields<SelectConfig<StatusOption>>),
    Url(PropertyFields<CheckboxConfig>),
    Files(PropertyFields<FilesConfig>),
    Relation(PropertyFields<RelationConfig>),
    Formula(PropertyFields<FormulaConfig>),
    Rollup(PropertyFields<RollupConfig>),
    Opaque(Value),
}

impl PropertyDefinition {
    pub fn kind(&self) -> &str {
        match self {
            Self::Text(_) => "text",
            Self::Number(_) => "number",
            Self::Checkbox(_) => "checkbox",
            Self::Date(_) => "date",
            Self::Select(_) => "select",
            Self::MultiSelect(_) => "multiSelect",
            Self::Status(_) => "status",
            Self::Url(_) => "url",
            Self::Files(_) => "files",
            Self::Relation(_) => "relation",
            Self::Formula(_) => "formula",
            Self::Rollup(_) => "rollup",
            Self::Opaque(_) => "opaque",
        }
    }

    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Text(fields) => Some(&fields.id),
            Self::Number(fields) => Some(&fields.id),
            Self::Checkbox(fields) => Some(&fields.id),
            Self::Date(fields) => Some(&fields.id),
            Self::Select(fields) => Some(&fields.id),
            Self::MultiSelect(fields) => Some(&fields.id),
            Self::Status(fields) => Some(&fields.id),
            Self::Url(fields) => Some(&fields.id),
            Self::Files(fields) => Some(&fields.id),
            Self::Relation(fields) => Some(&fields.id),
            Self::Formula(fields) => Some(&fields.id),
            Self::Rollup(fields) => Some(&fields.id),
            Self::Opaque(_) => None,
        }
    }

    pub fn yaml_binding(&self) -> Option<&YamlBinding> {
        match self {
            Self::Text(fields) => fields.yaml_binding.as_ref(),
            Self::Number(fields) => fields.yaml_binding.as_ref(),
            Self::Checkbox(fields) => fields.yaml_binding.as_ref(),
            Self::Date(fields) => fields.yaml_binding.as_ref(),
            Self::Select(fields) => fields.yaml_binding.as_ref(),
            Self::MultiSelect(fields) => fields.yaml_binding.as_ref(),
            Self::Status(fields) => fields.yaml_binding.as_ref(),
            Self::Url(fields) => fields.yaml_binding.as_ref(),
            Self::Files(fields) => fields.yaml_binding.as_ref(),
            Self::Relation(fields) => fields.yaml_binding.as_ref(),
            Self::Formula(fields) => fields.yaml_binding.as_ref(),
            Self::Rollup(fields) => fields.yaml_binding.as_ref(),
            Self::Opaque(_) => None,
        }
    }

    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Text(fields) => Some(&fields.name),
            Self::Number(fields) => Some(&fields.name),
            Self::Checkbox(fields) => Some(&fields.name),
            Self::Date(fields) => Some(&fields.name),
            Self::Select(fields) => Some(&fields.name),
            Self::MultiSelect(fields) => Some(&fields.name),
            Self::Status(fields) => Some(&fields.name),
            Self::Url(fields) => Some(&fields.name),
            Self::Files(fields) => Some(&fields.name),
            Self::Relation(fields) => Some(&fields.name),
            Self::Formula(fields) => Some(&fields.name),
            Self::Rollup(fields) => Some(&fields.name),
            Self::Opaque(_) => None,
        }
    }

    pub fn storage_key(&self) -> Option<&str> {
        self.yaml_binding().map(|b| b.key.as_str())
    }

    pub fn frontmatter_key(&self) -> Option<&str> {
        self.storage_key().or_else(|| self.name())
    }

    pub fn find_option_name(&self, option_id: &str) -> Option<&str> {
        match self {
            Self::Select(fields) | Self::MultiSelect(fields) => fields
                .config
                .options
                .iter()
                .find(|opt| opt.id == option_id)
                .map(|opt| opt.name.as_str()),
            Self::Status(fields) => fields
                .config
                .options
                .iter()
                .find(|opt| opt.id == option_id)
                .map(|opt| opt.name.as_str()),
            _ => None,
        }
    }

    pub fn find_option_id(&self, name_or_id: &str) -> Option<&str> {
        let trimmed = name_or_id.trim();
        let current_match = match self {
            Self::Select(fields) | Self::MultiSelect(fields) => fields
                .config
                .options
                .iter()
                .find(|opt| opt.id == trimmed || opt.name.eq_ignore_ascii_case(trimmed))
                .map(|opt| opt.id.as_str()),
            Self::Status(fields) => fields
                .config
                .options
                .iter()
                .find(|opt| opt.id == trimmed || opt.name.eq_ignore_ascii_case(trimmed))
                .map(|opt| opt.id.as_str()),
            _ => None,
        };
        if current_match.is_some() {
            return current_match;
        }

        if let Ok(map) = OPTION_NAME_HISTORY.lock() {
            if let Some(historical_id) = map.get(&trimmed.to_lowercase()) {
                return match self {
                    Self::Select(fields) | Self::MultiSelect(fields) => fields
                        .config
                        .options
                        .iter()
                        .find(|opt| opt.id == *historical_id)
                        .map(|opt| opt.id.as_str()),
                    Self::Status(fields) => fields
                        .config
                        .options
                        .iter()
                        .find(|opt| opt.id == *historical_id)
                        .map(|opt| opt.id.as_str()),
                    _ => None,
                };
            }
        }

        None
    }
}

impl Serialize for PropertyDefinition {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if let Self::Opaque(value) = self {
            return value.serialize(serializer);
        }
        let (kind, value) = match self {
            Self::Text(fields) => ("text", serde_json::to_value(fields)),
            Self::Number(fields) => ("number", serde_json::to_value(fields)),
            Self::Checkbox(fields) => ("checkbox", serde_json::to_value(fields)),
            Self::Date(fields) => ("date", serde_json::to_value(fields)),
            Self::Select(fields) => ("select", serde_json::to_value(fields)),
            Self::MultiSelect(fields) => ("multiSelect", serde_json::to_value(fields)),
            Self::Status(fields) => ("status", serde_json::to_value(fields)),
            Self::Url(fields) => ("url", serde_json::to_value(fields)),
            Self::Files(fields) => ("files", serde_json::to_value(fields)),
            Self::Relation(fields) => ("relation", serde_json::to_value(fields)),
            Self::Formula(fields) => ("formula", serde_json::to_value(fields)),
            Self::Rollup(fields) => ("rollup", serde_json::to_value(fields)),
            Self::Opaque(_) => unreachable!(),
        };
        let mut object = value
            .map_err(serde::ser::Error::custom)?
            .as_object()
            .cloned()
            .ok_or_else(|| {
                serde::ser::Error::custom("property definition must serialize as an object")
            })?;
        object.insert("type".to_owned(), Value::String(kind.to_owned()));
        Value::Object(object).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PropertyDefinition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let kind = raw.get("type").and_then(Value::as_str);
        let Some(kind) = kind else {
            return Ok(Self::Opaque(raw));
        };
        let known = without_key(&raw, "type");
        macro_rules! parse {
            ($variant:ident, $ty:ty) => {
                serde_json::from_value::<$ty>(known.clone())
                    .map(Self::$variant)
                    .map_err(serde::de::Error::custom)
            };
        }
        match kind {
            "text" => parse!(Text, PropertyFields<TextConfig>),
            "number" => parse!(Number, PropertyFields<NumberConfig>),
            "checkbox" => parse!(Checkbox, PropertyFields<CheckboxConfig>),
            "date" => parse!(Date, PropertyFields<DateConfig>),
            "select" => parse!(Select, PropertyFields<SelectConfig<SelectOption>>),
            "multiSelect" => parse!(MultiSelect, PropertyFields<SelectConfig<SelectOption>>),
            "status" => parse!(Status, PropertyFields<SelectConfig<StatusOption>>),
            "url" => parse!(Url, PropertyFields<CheckboxConfig>),
            "files" => parse!(Files, PropertyFields<FilesConfig>),
            "relation" => parse!(Relation, PropertyFields<RelationConfig>),
            "formula" => parse!(Formula, PropertyFields<FormulaConfig>),
            "rollup" => parse!(Rollup, PropertyFields<RollupConfig>),
            _ => Ok(Self::Opaque(raw)),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecordShard {
    pub format: String,
    #[serde(rename = "formatVersion")]
    pub format_version: u64,
    #[serde(rename = "databaseId")]
    pub database_id: String,
    #[serde(rename = "noteId")]
    pub note_id: String,
    pub values: BTreeMap<String, PropertyValue>,
    #[serde(rename = "yamlSyncBases", default)]
    pub yaml_sync_bases: BTreeMap<String, YamlSyncBase>,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FileValue {
    #[serde(rename = "assetId")]
    pub asset_id: String,
    pub kind: String,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PropertyValue {
    Text {
        value: String,
        extra: ExtraFields,
    },
    Number {
        decimal: String,
        extra: ExtraFields,
    },
    Checkbox {
        checked: bool,
        extra: ExtraFields,
    },
    Date {
        start: String,
        end: Option<String>,
        time_zone: Option<String>,
        extra: ExtraFields,
    },
    Select {
        option_id: String,
        extra: ExtraFields,
    },
    Status {
        option_id: String,
        extra: ExtraFields,
    },
    MultiSelect {
        option_ids: Vec<String>,
        extra: ExtraFields,
    },
    Url {
        value: String,
        extra: ExtraFields,
    },
    Files {
        items: Vec<FileValue>,
        extra: ExtraFields,
    },
    Relation {
        target_note_ids: Vec<String>,
        extra: ExtraFields,
    },
    Opaque(Value),
}

impl PropertyValue {
    pub fn kind(&self) -> &str {
        match self {
            Self::Text { .. } => "text",
            Self::Number { .. } => "number",
            Self::Checkbox { .. } => "checkbox",
            Self::Date { .. } => "date",
            Self::Select { .. } => "select",
            Self::Status { .. } => "status",
            Self::MultiSelect { .. } => "multiSelect",
            Self::Url { .. } => "url",
            Self::Files { .. } => "files",
            Self::Relation { .. } => "relation",
            Self::Opaque(_) => "opaque",
        }
    }
}

impl Serialize for PropertyValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if let Self::Opaque(value) = self {
            return value.serialize(serializer);
        }
        let (kind, mut object) = match self {
            Self::Text { value, extra } => (
                "text",
                object_with(extra, [("value", Value::String(value.clone()))]),
            ),
            Self::Number { decimal, extra } => (
                "number",
                object_with(extra, [("decimal", Value::String(decimal.clone()))]),
            ),
            Self::Checkbox { checked, extra } => (
                "checkbox",
                object_with(extra, [("checked", Value::Bool(*checked))]),
            ),
            Self::Date {
                start,
                end,
                time_zone,
                extra,
            } => (
                "date",
                object_with(
                    extra,
                    [
                        ("start", Value::String(start.clone())),
                        ("end", end.clone().map_or(Value::Null, Value::String)),
                        (
                            "timeZone",
                            time_zone.clone().map_or(Value::Null, Value::String),
                        ),
                    ],
                ),
            ),
            Self::Select { option_id, extra } => (
                "select",
                object_with(extra, [("optionId", Value::String(option_id.clone()))]),
            ),
            Self::Status { option_id, extra } => (
                "status",
                object_with(extra, [("optionId", Value::String(option_id.clone()))]),
            ),
            Self::MultiSelect { option_ids, extra } => (
                "multiSelect",
                object_with(
                    extra,
                    [(
                        "optionIds",
                        serde_json::to_value(option_ids).map_err(serde::ser::Error::custom)?,
                    )],
                ),
            ),
            Self::Url { value, extra } => (
                "url",
                object_with(extra, [("value", Value::String(value.clone()))]),
            ),
            Self::Files { items, extra } => (
                "files",
                object_with(
                    extra,
                    [(
                        "items",
                        serde_json::to_value(items).map_err(serde::ser::Error::custom)?,
                    )],
                ),
            ),
            Self::Relation {
                target_note_ids,
                extra,
            } => (
                "relation",
                object_with(
                    extra,
                    [(
                        "targetNoteIds",
                        serde_json::to_value(target_note_ids).map_err(serde::ser::Error::custom)?,
                    )],
                ),
            ),
            Self::Opaque(_) => unreachable!(),
        };
        object.insert("type".to_owned(), Value::String(kind.to_owned()));
        Value::Object(object).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PropertyValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let Some(kind) = raw.get("type").and_then(Value::as_str) else {
            return Ok(Self::Opaque(raw));
        };
        let object = raw
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("property value must be an object"))?;
        let extra = object
            .iter()
            .filter(|(key, _)| {
                !matches!(
                    key.as_str(),
                    "type"
                        | "value"
                        | "decimal"
                        | "checked"
                        | "start"
                        | "end"
                        | "timeZone"
                        | "optionId"
                        | "optionIds"
                        | "items"
                        | "targetNoteIds"
                )
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let get_string = |key: &'static str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| {
                    serde::de::Error::custom(format!("property value {key} must be a string"))
                })
        };
        match kind {
            "text" => Ok(Self::Text {
                value: get_string("value")?,
                extra,
            }),
            "number" => Ok(Self::Number {
                decimal: get_string("decimal")?,
                extra,
            }),
            "checkbox" => Ok(Self::Checkbox {
                checked: object
                    .get("checked")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| serde::de::Error::custom("checked must be boolean"))?,
                extra,
            }),
            "date" => Ok(Self::Date {
                start: get_string("start")?,
                end: optional_string(object, "end").map_err(serde::de::Error::custom)?,
                time_zone: optional_string(object, "timeZone").map_err(serde::de::Error::custom)?,
                extra,
            }),
            "select" => Ok(Self::Select {
                option_id: get_string("optionId")?,
                extra,
            }),
            "status" => Ok(Self::Status {
                option_id: get_string("optionId")?,
                extra,
            }),
            "multiSelect" => Ok(Self::MultiSelect {
                option_ids: serde_json::from_value(
                    object
                        .get("optionIds")
                        .cloned()
                        .ok_or_else(|| serde::de::Error::custom("optionIds is missing"))?,
                )
                .map_err(serde::de::Error::custom)?,
                extra,
            }),
            "url" => Ok(Self::Url {
                value: get_string("value")?,
                extra,
            }),
            "files" => Ok(Self::Files {
                items: serde_json::from_value(
                    object
                        .get("items")
                        .cloned()
                        .ok_or_else(|| serde::de::Error::custom("items is missing"))?,
                )
                .map_err(serde::de::Error::custom)?,
                extra,
            }),
            "relation" => Ok(Self::Relation {
                target_note_ids: serde_json::from_value(
                    object
                        .get("targetNoteIds")
                        .cloned()
                        .ok_or_else(|| serde::de::Error::custom("targetNoteIds is missing"))?,
                )
                .map_err(serde::de::Error::custom)?,
                extra,
            }),
            _ => Ok(Self::Opaque(raw)),
        }
    }
}

pub fn property_value_to_frontmatter_value(
    value: &PropertyValue,
    property_def: &PropertyDefinition,
) -> Option<serde_yaml::Value> {
    match value {
        PropertyValue::Text { value, .. } => {
            if value.trim().is_empty() {
                None
            } else {
                Some(serde_yaml::Value::String(value.clone()))
            }
        }
        PropertyValue::Number { decimal, .. } => {
            if decimal.trim().is_empty() {
                None
            } else if let Ok(n) = decimal.parse::<i64>() {
                Some(serde_yaml::Value::Number(serde_yaml::Number::from(n)))
            } else {
                Some(serde_yaml::Value::String(decimal.clone()))
            }
        }
        PropertyValue::Checkbox { checked, .. } => Some(serde_yaml::Value::Bool(*checked)),
        PropertyValue::Date {
            start,
            end,
            time_zone,
            extra,
        } => {
            if start.trim().is_empty() {
                None
            } else if end.is_none() && time_zone.is_none() && extra.is_empty() {
                Some(serde_yaml::Value::String(start.clone()))
            } else {
                let mut map = serde_yaml::Mapping::new();
                map.insert(
                    serde_yaml::Value::String("start".to_string()),
                    serde_yaml::Value::String(start.clone()),
                );
                if let Some(end) = end {
                    map.insert(
                        serde_yaml::Value::String("end".to_string()),
                        serde_yaml::Value::String(end.clone()),
                    );
                }
                if let Some(tz) = time_zone {
                    map.insert(
                        serde_yaml::Value::String("timeZone".to_string()),
                        serde_yaml::Value::String(tz.clone()),
                    );
                }
                for (k, v) in extra {
                    if let Ok(yv) = serde_yaml::to_value(v) {
                        map.insert(serde_yaml::Value::String(k.clone()), yv);
                    }
                }
                Some(serde_yaml::Value::Mapping(map))
            }
        }
        PropertyValue::Select { option_id, .. } | PropertyValue::Status { option_id, .. } => {
            let name = property_def
                .find_option_name(option_id)
                .unwrap_or(option_id);
            if name.trim().is_empty() {
                None
            } else {
                record_option_name_history(name, option_id);
                Some(serde_yaml::Value::String(name.to_string()))
            }
        }
        PropertyValue::MultiSelect { option_ids, .. } => {
            let names: Vec<serde_yaml::Value> = option_ids
                .iter()
                .map(|id| {
                    let name = property_def.find_option_name(id).unwrap_or(id);
                    record_option_name_history(name, id);
                    serde_yaml::Value::String(name.to_string())
                })
                .collect();
            if names.is_empty() {
                None
            } else {
                Some(serde_yaml::Value::Sequence(names))
            }
        }
        PropertyValue::Url { value, .. } => {
            if value.trim().is_empty() {
                None
            } else {
                Some(serde_yaml::Value::String(value.clone()))
            }
        }
        PropertyValue::Relation {
            target_note_ids, ..
        } => {
            let items: Vec<serde_yaml::Value> = target_note_ids
                .iter()
                .map(|id| serde_yaml::Value::String(id.clone()))
                .collect();
            if items.is_empty() {
                None
            } else {
                Some(serde_yaml::Value::Sequence(items))
            }
        }
        PropertyValue::Files { items, .. } => {
            if items.is_empty() {
                None
            } else {
                let mut file_items = Vec::new();
                for item in items {
                    let mut map = serde_yaml::Mapping::new();
                    map.insert(
                        serde_yaml::Value::String("assetId".to_string()),
                        serde_yaml::Value::String(item.asset_id.clone()),
                    );
                    map.insert(
                        serde_yaml::Value::String("kind".to_string()),
                        serde_yaml::Value::String(item.kind.clone()),
                    );
                    map.insert(
                        serde_yaml::Value::String("relativePath".to_string()),
                        serde_yaml::Value::String(item.relative_path.clone()),
                    );
                    map.insert(
                        serde_yaml::Value::String("name".to_string()),
                        serde_yaml::Value::String(item.name.clone()),
                    );
                    map.insert(
                        serde_yaml::Value::String("mimeType".to_string()),
                        serde_yaml::Value::String(item.mime_type.clone()),
                    );
                    map.insert(
                        serde_yaml::Value::String("sizeBytes".to_string()),
                        serde_yaml::Value::Number(serde_yaml::Number::from(item.size_bytes)),
                    );
                    for (k, v) in &item.extra {
                        if let Ok(yv) = serde_yaml::to_value(v) {
                            map.insert(serde_yaml::Value::String(k.clone()), yv);
                        }
                    }
                    file_items.push(serde_yaml::Value::Mapping(map));
                }
                Some(serde_yaml::Value::Sequence(file_items))
            }
        }
        PropertyValue::Opaque(val) => serde_yaml::to_value(val).ok(),
    }
}

#[allow(clippy::needless_borrows_for_generic_args)]
pub fn frontmatter_value_to_property_value(
    yaml: &serde_yaml::Value,
    property_def: &PropertyDefinition,
) -> Option<PropertyValue> {
    match property_def {
        PropertyDefinition::Text(_) => {
            let s = match yaml {
                serde_yaml::Value::String(s) => s.clone(),
                serde_yaml::Value::Number(n) => n.to_string(),
                serde_yaml::Value::Bool(b) => b.to_string(),
                _ => return None,
            };
            Some(PropertyValue::Text {
                value: s,
                extra: BTreeMap::new(),
            })
        }
        PropertyDefinition::Number(_) => {
            let s = match yaml {
                serde_yaml::Value::Number(n) => n.to_string(),
                serde_yaml::Value::String(s) => s.clone(),
                _ => return None,
            };
            Some(PropertyValue::Number {
                decimal: s,
                extra: BTreeMap::new(),
            })
        }
        PropertyDefinition::Checkbox(_) => {
            let b = match yaml {
                serde_yaml::Value::Bool(b) => *b,
                serde_yaml::Value::String(s) => {
                    s.eq_ignore_ascii_case("true")
                        || s.trim() == "1"
                        || s.eq_ignore_ascii_case("yes")
                }
                serde_yaml::Value::Number(n) => n.as_i64() == Some(1),
                _ => false,
            };
            Some(PropertyValue::Checkbox {
                checked: b,
                extra: BTreeMap::new(),
            })
        }
        PropertyDefinition::Date(_) => match yaml {
            serde_yaml::Value::String(s) => {
                if s.trim().is_empty() {
                    return None;
                }
                Some(PropertyValue::Date {
                    start: s.clone(),
                    end: None,
                    time_zone: None,
                    extra: BTreeMap::new(),
                })
            }
            serde_yaml::Value::Mapping(map) => {
                let start = map
                    .get(&serde_yaml::Value::String("start".to_string()))
                    .or_else(|| map.get(&serde_yaml::Value::String("from".to_string())))
                    .and_then(|v| match v {
                        serde_yaml::Value::String(s) => Some(s.clone()),
                        serde_yaml::Value::Number(n) => Some(n.to_string()),
                        _ => None,
                    })?;
                let end = map
                    .get(&serde_yaml::Value::String("end".to_string()))
                    .or_else(|| map.get(&serde_yaml::Value::String("to".to_string())))
                    .and_then(|v| match v {
                        serde_yaml::Value::String(s) => Some(s.clone()),
                        serde_yaml::Value::Number(n) => Some(n.to_string()),
                        _ => None,
                    });
                let time_zone = map
                    .get(&serde_yaml::Value::String("timeZone".to_string()))
                    .or_else(|| map.get(&serde_yaml::Value::String("time_zone".to_string())))
                    .and_then(|v| match v {
                        serde_yaml::Value::String(s) => Some(s.clone()),
                        _ => None,
                    });
                let mut extra = BTreeMap::new();
                for (k, v) in map {
                    if let serde_yaml::Value::String(k_str) = k {
                        if !matches!(
                            k_str.as_str(),
                            "start" | "from" | "end" | "to" | "timeZone" | "time_zone"
                        ) {
                            if let Ok(jv) = serde_json::to_value(v) {
                                extra.insert(k_str.clone(), jv);
                            }
                        }
                    }
                }
                Some(PropertyValue::Date {
                    start,
                    end,
                    time_zone,
                    extra,
                })
            }
            _ => None,
        },
        PropertyDefinition::Select(_) => {
            let text = match yaml {
                serde_yaml::Value::String(s) => s.as_str(),
                _ => return None,
            };
            let option_id = property_def
                .find_option_id(text)
                .map(|id| id.to_string())
                .unwrap_or_else(|| text.to_string());
            Some(PropertyValue::Select {
                option_id,
                extra: BTreeMap::new(),
            })
        }
        PropertyDefinition::Status(_) => {
            let text = match yaml {
                serde_yaml::Value::String(s) => s.as_str(),
                _ => return None,
            };
            let option_id = property_def
                .find_option_id(text)
                .map(|id| id.to_string())
                .unwrap_or_else(|| text.to_string());
            Some(PropertyValue::Status {
                option_id,
                extra: BTreeMap::new(),
            })
        }
        PropertyDefinition::MultiSelect(_) => {
            let mut option_ids = Vec::new();
            match yaml {
                serde_yaml::Value::Sequence(items) => {
                    for item in items {
                        if let serde_yaml::Value::String(s) = item {
                            let opt_id = property_def
                                .find_option_id(s)
                                .map(|id| id.to_string())
                                .unwrap_or_else(|| s.clone());
                            option_ids.push(opt_id);
                        }
                    }
                }
                serde_yaml::Value::String(s) => {
                    for part in s.split(',') {
                        let trimmed = part.trim();
                        if !trimmed.is_empty() {
                            let opt_id = property_def
                                .find_option_id(trimmed)
                                .map(|id| id.to_string())
                                .unwrap_or_else(|| trimmed.to_string());
                            option_ids.push(opt_id);
                        }
                    }
                }
                _ => return None,
            }
            Some(PropertyValue::MultiSelect {
                option_ids,
                extra: BTreeMap::new(),
            })
        }
        PropertyDefinition::Url(_) => {
            let s = match yaml {
                serde_yaml::Value::String(s) => s.clone(),
                _ => return None,
            };
            Some(PropertyValue::Url {
                value: s,
                extra: BTreeMap::new(),
            })
        }
        PropertyDefinition::Files(_) => match yaml {
            serde_yaml::Value::Sequence(items) => {
                let mut file_items = Vec::new();
                for item in items {
                    match item {
                        serde_yaml::Value::Mapping(map) => {
                            let get_str = |key: &str| {
                                map.get(&serde_yaml::Value::String(key.to_string()))
                                    .and_then(|v| v.as_str())
                                    .map(str::to_owned)
                            };
                            let name = get_str("name").unwrap_or_default();
                            let asset_id = get_str("assetId")
                                .or_else(|| get_str("asset_id"))
                                .unwrap_or_else(|| ulid::Ulid::generate().to_string());
                            let kind = get_str("kind").unwrap_or_else(|| "asset".to_string());
                            let relative_path = get_str("relativePath")
                                .or_else(|| get_str("relative_path"))
                                .unwrap_or_else(|| format!("assets/{name}"));
                            let mime_type = get_str("mimeType")
                                .or_else(|| get_str("mime_type"))
                                .unwrap_or_default();
                            let size_bytes = map
                                .get(&serde_yaml::Value::String("sizeBytes".to_string()))
                                .or_else(|| {
                                    map.get(&serde_yaml::Value::String("size_bytes".to_string()))
                                })
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let mut extra = BTreeMap::new();
                            for (k, v) in map {
                                if let serde_yaml::Value::String(k_str) = k {
                                    if !matches!(
                                        k_str.as_str(),
                                        "assetId"
                                            | "asset_id"
                                            | "kind"
                                            | "relativePath"
                                            | "relative_path"
                                            | "name"
                                            | "mimeType"
                                            | "mime_type"
                                            | "sizeBytes"
                                            | "size_bytes"
                                    ) {
                                        if let Ok(jv) = serde_json::to_value(v) {
                                            extra.insert(k_str.clone(), jv);
                                        }
                                    }
                                }
                            }
                            file_items.push(FileValue {
                                asset_id,
                                kind,
                                relative_path,
                                name,
                                mime_type,
                                size_bytes,
                                extra,
                            });
                        }
                        serde_yaml::Value::String(name) => {
                            file_items.push(FileValue {
                                asset_id: ulid::Ulid::generate().to_string(),
                                kind: "asset".to_string(),
                                relative_path: format!("assets/{name}"),
                                name: name.clone(),
                                mime_type: "".to_string(),
                                size_bytes: 0,
                                extra: BTreeMap::new(),
                            });
                        }
                        _ => {}
                    }
                }
                Some(PropertyValue::Files {
                    items: file_items,
                    extra: BTreeMap::new(),
                })
            }
            _ => None,
        },
        PropertyDefinition::Relation(_) => {
            let mut target_note_ids = Vec::new();
            match yaml {
                serde_yaml::Value::Sequence(items) => {
                    for item in items {
                        if let serde_yaml::Value::String(s) = item {
                            let clean = s.trim().trim_start_matches("[[").trim_end_matches("]]");
                            target_note_ids.push(clean.to_string());
                        }
                    }
                }
                serde_yaml::Value::String(s) => {
                    let clean = s.trim().trim_start_matches("[[").trim_end_matches("]]");
                    target_note_ids.push(clean.to_string());
                }
                _ => return None,
            }
            Some(PropertyValue::Relation {
                target_note_ids,
                extra: BTreeMap::new(),
            })
        }
        _ => None,
    }
}

pub fn is_reserved_system_key(key: &str) -> bool {
    let lower = key.trim().to_ascii_lowercase();
    lower == "amby-id"
        || lower == "amby-title"
        || lower == "amby-views"
        || lower == "amby-database"
        || lower.starts_with("amby-")
}

pub fn resolve_property_yaml_value<'a>(
    mapping: &'a serde_yaml::Mapping,
    property_def: &PropertyDefinition,
) -> Option<&'a serde_yaml::Value> {
    let storage_key = property_def.storage_key();
    let prop_id = property_def.id();
    let prop_name = property_def.name();

    // 1. Exact match on storage_key (yaml_binding.key if present)
    if let Some(sk) = storage_key {
        if !is_reserved_system_key(sk) {
            for (k, v) in mapping {
                if let serde_yaml::Value::String(k_str) = k {
                    if k_str == sk {
                        return Some(v);
                    }
                }
            }
        }
    }

    // 2. Exact match on property_id
    if let Some(id) = prop_id {
        if !is_reserved_system_key(id) {
            for (k, v) in mapping {
                if let serde_yaml::Value::String(k_str) = k {
                    if k_str == id {
                        return Some(v);
                    }
                }
            }
        }
    }

    // 3. Case-insensitive match on storage_key
    if let Some(sk) = storage_key {
        if !is_reserved_system_key(sk) {
            let matches: Vec<&'a serde_yaml::Value> = mapping
                .iter()
                .filter_map(|(k, v)| {
                    if let serde_yaml::Value::String(k_str) = k {
                        if !is_reserved_system_key(k_str) && k_str.trim().eq_ignore_ascii_case(sk) {
                            return Some(v);
                        }
                    }
                    None
                })
                .collect();
            if !matches.is_empty() {
                return Some(matches[0]);
            }
        }
    }

    // 4. Exact match on display name (legacy fallback)
    if let Some(name) = prop_name {
        if !is_reserved_system_key(name) && Some(name) != storage_key {
            for (k, v) in mapping {
                if let serde_yaml::Value::String(k_str) = k {
                    if k_str == name && !is_reserved_system_key(k_str) {
                        return Some(v);
                    }
                }
            }
        }
    }

    // 5. Case-insensitive match on display name (legacy fallback)
    if let Some(name) = prop_name {
        if !is_reserved_system_key(name) && Some(name) != storage_key {
            let matches: Vec<&'a serde_yaml::Value> = mapping
                .iter()
                .filter_map(|(k, v)| {
                    if let serde_yaml::Value::String(k_str) = k {
                        if !is_reserved_system_key(k_str) && k_str.trim().eq_ignore_ascii_case(name)
                        {
                            return Some(v);
                        }
                    }
                    None
                })
                .collect();
            if !matches.is_empty() {
                return Some(matches[0]);
            }
        }
    }

    None
}

#[derive(Clone, Debug, PartialEq)]
pub enum YamlSyncBase {
    Missing {
        extra: ExtraFields,
    },
    Value {
        value: PropertyValue,
        extra: ExtraFields,
    },
    Opaque(Value),
}

impl Serialize for YamlSyncBase {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut object = match self {
            Self::Missing { extra } => object_with(extra, []),
            Self::Value { value, extra } => object_with(
                extra,
                [(
                    "value",
                    serde_json::to_value(value).map_err(serde::ser::Error::custom)?,
                )],
            ),
            Self::Opaque(value) => return value.serialize(serializer),
        };
        object.insert(
            "state".to_owned(),
            Value::String(
                if matches!(self, Self::Missing { .. }) {
                    "missing"
                } else {
                    "value"
                }
                .to_owned(),
            ),
        );
        Value::Object(object).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for YamlSyncBase {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let Some(state) = raw.get("state").and_then(Value::as_str) else {
            return Ok(Self::Opaque(raw));
        };
        let object = raw
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("yaml sync base must be an object"))?;
        let extra = object
            .iter()
            .filter(|(key, _)| key.as_str() != "state" && key.as_str() != "value")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        match state {
            "missing" => Ok(Self::Missing { extra }),
            "value" => Ok(Self::Value {
                value: serde_json::from_value(
                    object
                        .get("value")
                        .cloned()
                        .ok_or_else(|| serde::de::Error::custom("yaml sync value is missing"))?,
                )
                .map_err(serde::de::Error::custom)?,
                extra,
            }),
            _ => Ok(Self::Opaque(raw)),
        }
    }
}

fn default_open_mode() -> String {
    "sidePeek".to_string()
}

fn default_subitems_mode() -> String {
    "nested".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DatabaseViewFile {
    pub format: String,
    #[serde(rename = "formatVersion")]
    pub format_version: u64,
    #[serde(rename = "databaseId")]
    pub database_id: String,
    #[serde(rename = "viewId")]
    pub view_id: String,
    pub name: String,
    pub layout: String,
    #[serde(rename = "openMode", default = "default_open_mode")]
    pub open_mode: String,
    #[serde(rename = "subitemsMode", default = "default_subitems_mode")]
    pub subitems_mode: String,
    pub density: Option<String>,
    #[serde(default)]
    pub fields: Vec<ViewField>,
    pub filter: Option<FilterNode>,
    #[serde(default)]
    pub sorts: Vec<SortRule>,
    pub group: Option<GroupRule>,
    #[serde(rename = "manualOrder", default)]
    pub manual_order: Vec<String>,
    #[serde(default)]
    pub aggregates: Vec<AggregateRule>,
    #[serde(rename = "layoutConfig", default)]
    pub layout_config: Value,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ViewField {
    pub field: FieldRef,
    pub visible: bool,
    pub width: Option<u32>,
    pub frozen: bool,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FieldRef {
    System {
        field: String,
        extra: ExtraFields,
    },
    Property {
        property_id: String,
        extra: ExtraFields,
    },
    Opaque(Value),
}

impl Serialize for FieldRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut object = match self {
            Self::System { field, extra } => {
                object_with(extra, [("field", Value::String(field.clone()))])
            }
            Self::Property { property_id, extra } => {
                object_with(extra, [("propertyId", Value::String(property_id.clone()))])
            }
            Self::Opaque(value) => return value.serialize(serializer),
        };
        object.insert(
            "kind".to_owned(),
            Value::String(
                if matches!(self, Self::System { .. }) {
                    "system"
                } else {
                    "property"
                }
                .to_owned(),
            ),
        );
        Value::Object(object).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for FieldRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let Some(kind) = raw.get("kind").and_then(Value::as_str) else {
            return Ok(Self::Opaque(raw));
        };
        let object = raw
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("field reference must be an object"))?;
        let extra = object
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "kind" | "field" | "propertyId"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        match kind {
            "system" => Ok(Self::System {
                field: object
                    .get("field")
                    .and_then(Value::as_str)
                    .ok_or_else(|| serde::de::Error::custom("system field is missing"))?
                    .to_owned(),
                extra,
            }),
            "property" => Ok(Self::Property {
                property_id: object
                    .get("propertyId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| serde::de::Error::custom("propertyId is missing"))?
                    .to_owned(),
                extra,
            }),
            _ => Ok(Self::Opaque(raw)),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum FilterNode {
    Group {
        operator: String,
        children: Vec<FilterNode>,
        extra: ExtraFields,
    },
    Condition {
        field: FieldRef,
        operator: String,
        value: Option<Value>,
        extra: ExtraFields,
    },
    Opaque(Value),
}

impl Serialize for FilterNode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let (kind, mut object) = match self {
            Self::Group {
                operator,
                children,
                extra,
            } => (
                "group",
                object_with(
                    extra,
                    [
                        ("operator", Value::String(operator.clone())),
                        (
                            "children",
                            serde_json::to_value(children).map_err(serde::ser::Error::custom)?,
                        ),
                    ],
                ),
            ),
            Self::Condition {
                field,
                operator,
                value,
                extra,
            } => {
                let mut object = object_with(
                    extra,
                    [
                        (
                            "field",
                            serde_json::to_value(field).map_err(serde::ser::Error::custom)?,
                        ),
                        ("operator", Value::String(operator.clone())),
                    ],
                );
                if let Some(value) = value {
                    object.insert("value".to_owned(), value.clone());
                }
                ("condition", object)
            }
            Self::Opaque(value) => return value.serialize(serializer),
        };
        object.insert("kind".to_owned(), Value::String(kind.to_owned()));
        Value::Object(object).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for FilterNode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let Some(kind) = raw.get("kind").and_then(Value::as_str) else {
            return Ok(Self::Opaque(raw));
        };
        let object = raw
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("filter node must be an object"))?;
        let extra = object
            .iter()
            .filter(|(key, _)| {
                !matches!(
                    key.as_str(),
                    "kind" | "operator" | "children" | "field" | "value"
                )
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        match kind {
            "group" => Ok(Self::Group {
                operator: object
                    .get("operator")
                    .and_then(Value::as_str)
                    .ok_or_else(|| serde::de::Error::custom("filter group operator is missing"))?
                    .to_owned(),
                children: serde_json::from_value(
                    object
                        .get("children")
                        .cloned()
                        .ok_or_else(|| serde::de::Error::custom("filter children are missing"))?,
                )
                .map_err(serde::de::Error::custom)?,
                extra,
            }),
            "condition" => Ok(Self::Condition {
                field: serde_json::from_value(
                    object
                        .get("field")
                        .cloned()
                        .ok_or_else(|| serde::de::Error::custom("filter field is missing"))?,
                )
                .map_err(serde::de::Error::custom)?,
                operator: object
                    .get("operator")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        serde::de::Error::custom("filter condition operator is missing")
                    })?
                    .to_owned(),
                value: object.get("value").cloned(),
                extra,
            }),
            _ => Ok(Self::Opaque(raw)),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SortRule {
    pub field: FieldRef,
    pub direction: String,
    #[serde(rename = "nulls")]
    pub nulls: String,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct GroupRule {
    pub field: FieldRef,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AggregateRule {
    pub field: FieldRef,
    pub function: String,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DatabaseTemplateFile {
    pub format: String,
    #[serde(rename = "formatVersion")]
    pub format_version: u64,
    #[serde(rename = "databaseId")]
    pub database_id: String,
    #[serde(rename = "templateId")]
    pub template_id: String,
    pub name: String,
    pub body: String,
    pub values: BTreeMap<String, PropertyValue>,
    #[serde(flatten)]
    pub extra: ExtraFields,
}

pub fn parse_manifest(bytes: &[u8]) -> Result<ParsedJson<DatabaseManifest>, FormatError> {
    parse_document(bytes, DocumentKind::Manifest, MAX_JSON_BYTES)
}

pub fn parse_record(bytes: &[u8]) -> Result<ParsedJson<RecordShard>, FormatError> {
    parse_document(bytes, DocumentKind::Record, MAX_JSON_BYTES)
}

pub fn parse_view(bytes: &[u8]) -> Result<ParsedJson<DatabaseViewFile>, FormatError> {
    parse_document(bytes, DocumentKind::View, MAX_JSON_BYTES)
}

pub fn parse_template(bytes: &[u8]) -> Result<ParsedJson<DatabaseTemplateFile>, FormatError> {
    parse_document(bytes, DocumentKind::Template, MAX_TEMPLATE_BYTES)
}

pub fn prepare_json<T: Serialize>(
    parsed: &ParsedJson<T>,
    value: &T,
) -> Result<PreparedJson, FormatError> {
    if let Some(reason) = &parsed.read_only {
        return Err(FormatError::ReadOnly(reason.clone()));
    }
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| FormatError::Serialization(error.to_string()))?;
    bytes.push(b'\n');
    Ok(PreparedJson {
        revision: raw_revision(&bytes),
        bytes,
    })
}

pub fn raw_revision(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn view_bytes(view: &DatabaseViewFile) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(view).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn view_revision(view: &DatabaseViewFile) -> Result<String, String> {
    let bytes = view_bytes(view)?;
    Ok(raw_revision(&bytes))
}

pub fn matches_view_revision(view: &DatabaseViewFile, expected: &str) -> bool {
    if expected.is_empty() {
        return true;
    }
    // 1. Canonical: to_vec_pretty(view) with newline
    if let Ok(bytes) = view_bytes(view) {
        if raw_revision(&bytes) == expected {
            return true;
        }
    }
    // 2. Fallback: to_vec_pretty(view) without newline (legacy SQLite projection)
    if let Ok(bytes) = serde_json::to_vec_pretty(view) {
        if raw_revision(&bytes) == expected {
            return true;
        }
    }
    // 3. Fallback: to_value BTreeMap order with newline
    if let Ok(val) = serde_json::to_value(view) {
        if let Ok(mut bytes) = serde_json::to_vec_pretty(&val) {
            bytes.push(b'\n');
            if raw_revision(&bytes) == expected {
                return true;
            }
            // 4. Fallback: to_value BTreeMap order without newline
            bytes.pop();
            if raw_revision(&bytes) == expected {
                return true;
            }
        }
    }
    false
}

fn parse_document<T: DeserializeOwned>(
    bytes: &[u8],
    kind: DocumentKind,
    limit: usize,
) -> Result<ParsedJson<T>, FormatError> {
    if bytes.is_empty() {
        return Err(FormatError::Empty);
    }
    if bytes.len() > limit {
        return Err(FormatError::TooLarge {
            bytes: bytes.len(),
            limit,
        });
    }
    let has_bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let without_bom = if has_bom { &bytes[3..] } else { bytes };
    let text = std::str::from_utf8(without_bom).map_err(|_| FormatError::InvalidUtf8)?;
    let raw: Value =
        serde_json::from_str(text).map_err(|error| FormatError::InvalidJson(error.to_string()))?;
    let depth = json_depth(&raw);
    if depth > MAX_JSON_DEPTH {
        return Err(FormatError::TooDeep {
            depth,
            limit: MAX_JSON_DEPTH,
        });
    }
    let object = raw.as_object().ok_or(FormatError::NotAnObject)?;
    let actual_format = object
        .get("format")
        .and_then(Value::as_str)
        .ok_or(FormatError::MissingField("format"))?;
    if actual_format != kind.format() {
        return Err(FormatError::WrongFormat {
            expected: kind.format(),
            actual: actual_format.to_owned(),
        });
    }
    let version = object
        .get("formatVersion")
        .and_then(Value::as_u64)
        .ok_or(FormatError::InvalidFormatVersion)?;
    if version != SUPPORTED_FORMAT_VERSION {
        return Err(FormatError::UnsupportedFormatVersion { actual: version });
    }
    let value =
        serde_json::from_value(raw).map_err(|error| FormatError::InvalidJson(error.to_string()))?;
    Ok(ParsedJson {
        value,
        raw: bytes.to_owned(),
        revision: raw_revision(bytes),
        read_only: has_bom.then_some(ReadOnlyReason::Utf8Bom),
    })
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(values) => 1 + values.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(values) => 1 + values.values().map(json_depth).max().unwrap_or(0),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => 1,
    }
}

fn without_key(value: &Value, key: &str) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let mut copy = object.clone();
    copy.remove(key);
    Value::Object(copy)
}

fn object_with<const N: usize>(
    extra: &ExtraFields,
    fields: [(&str, Value); N],
) -> Map<String, Value> {
    let mut object = extra
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Map<_, _>>();
    for (key, value) in fields {
        object.insert(key.to_owned(), value);
    }
    object
}

fn optional_string(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<Option<String>, serde::de::value::Error> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(serde::de::Error::custom(format!(
            "{key} must be a string or null"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_json() -> Vec<u8> {
        r###"{
  "format": "amby-database",
  "formatVersion": 1,
  "databaseId": "01J00000000000000000000000",
  "name": "Characters",
  "icon": "📚",
  "cover": null,
  "locked": false,
  "membership": {"kind": "filesystem-descendants", "recursive": true},
  "properties": [{
    "id": "01J00000000000000000000001",
    "name": "Role",
    "type": "select",
    "pageVisibility": "alwaysShow",
    "yamlBinding": null,
    "config": {"options": [{"id": "01J00000000000000000000002", "name": "Hero", "color": "#fff"}]}
  }],
  "viewOrder": [],
  "defaultViewId": null,
  "templateOrder": [],
  "defaultTemplateId": null,
  "futureField": {"preserve": true}
}
"###
        .as_bytes()
        .to_vec()
    }

    #[test]
    fn parses_unknown_fields_and_prepares_them_again() {
        let parsed = parse_manifest(&manifest_json()).unwrap();
        assert!(parsed.is_writable());
        assert_eq!(parsed.value.extra["futureField"]["preserve"], true);
        let mut changed = parsed.value.clone();
        changed.name = "Characters renamed".to_owned();
        let prepared = prepare_json(&parsed, &changed).unwrap();
        let reparsed = parse_manifest(&prepared.bytes).unwrap();
        assert_eq!(reparsed.value.name, "Characters renamed");
        assert_eq!(reparsed.value.extra["futureField"]["preserve"], true);
    }

    #[test]
    fn bom_is_read_only_and_revision_is_raw_bytes() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend(manifest_json());
        let parsed = parse_manifest(&bytes).unwrap();
        assert_eq!(parsed.read_only, Some(ReadOnlyReason::Utf8Bom));
        assert_eq!(parsed.revision, raw_revision(&bytes));
        assert!(matches!(
            prepare_json(&parsed, &parsed.value),
            Err(FormatError::ReadOnly(_))
        ));
    }

    #[test]
    fn unsupported_version_never_produces_writer_bytes() {
        let bytes = manifest_json();
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["formatVersion"] = Value::from(99);
        let encoded = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            parse_manifest(&encoded),
            Err(FormatError::UnsupportedFormatVersion { actual: 99 })
        ));
    }

    #[test]
    fn opaque_property_and_filter_entries_round_trip() {
        let property: PropertyDefinition = serde_json::from_value(serde_json::json!({
            "type": "future",
            "id": "01J00000000000000000000003",
            "payload": {"keep": [1, 2, 3]}
        }))
        .unwrap();
        assert!(matches!(property, PropertyDefinition::Opaque(_)));
        assert_eq!(
            serde_json::to_value(property).unwrap()["payload"]["keep"][1],
            2
        );

        let filter: FilterNode =
            serde_json::from_value(serde_json::json!({"kind": "future", "data": true})).unwrap();
        assert!(matches!(filter, FilterNode::Opaque(_)));
        assert_eq!(serde_json::to_value(filter).unwrap()["data"], true);
    }

    #[test]
    fn golden_database_fixtures_parse_and_validate() {
        let manifest = parse_manifest(include_bytes!(
            "../../fixtures/database-format/manifest.json"
        ))
        .unwrap();
        let record =
            parse_record(include_bytes!("../../fixtures/database-format/record.json")).unwrap();
        let view = parse_view(include_bytes!("../../fixtures/database-format/view.json")).unwrap();
        let template = parse_template(include_bytes!(
            "../../fixtures/database-format/template.json"
        ))
        .unwrap();

        assert!(crate::database::validation::validate_manifest(&manifest.value).is_writable());
        assert!(
            crate::database::validation::validate_record(&record.value, Some(&manifest.value))
                .is_valid()
        );
        assert!(
            crate::database::validation::validate_view(&view.value, Some(&manifest.value))
                .is_writable()
        );
        assert!(crate::database::validation::validate_template(
            &template.value,
            Some(&manifest.value)
        )
        .is_valid());
        assert_eq!(
            manifest.value.extra["futureManifestSetting"]["preserve"],
            true
        );
        assert_eq!(record.value.extra["futureRecordSetting"][0], "preserve");
        assert_eq!(
            template.value.extra["futureTemplateSetting"]["preserve"],
            true
        );
    }

    #[test]
    fn rejects_excessive_json_depth_before_typed_deserialization() {
        let mut bytes = vec![b'['; MAX_JSON_DEPTH + 2];
        bytes.extend(std::iter::repeat_n(b']', MAX_JSON_DEPTH + 2));
        assert!(matches!(
            parse_manifest(&bytes),
            Err(FormatError::TooDeep { .. })
        ));
    }

    #[test]
    fn r2_lossless_conversions_roundtrip() {
        // 1. Decimal precision: 1234567890.123456789 round-trips without f64 precision loss
        let num_val = PropertyValue::Number {
            decimal: "1234567890.123456789".to_string(),
            extra: Default::default(),
        };
        let num_def = PropertyDefinition::Number(PropertyFields {
            id: "prop1".into(),
            name: "Num".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: NumberConfig {
                format: "number".into(),
                currency: None,
                extra: Default::default(),
            },
            extra: Default::default(),
        });
        let yaml = property_value_to_frontmatter_value(&num_val, &num_def).unwrap();
        let back = frontmatter_value_to_property_value(&yaml, &num_def);
        assert_eq!(back, Some(num_val));

        // 2. Date range and time_zone: start, end, and time_zone round-trip without loss
        let date_val = PropertyValue::Date {
            start: "2026-09-20T10:00:00".into(),
            end: Some("2026-09-21T18:00:00".into()),
            time_zone: Some("Europe/Moscow".into()),
            extra: Default::default(),
        };
        let date_def = PropertyDefinition::Date(PropertyFields {
            id: "prop2".into(),
            name: "Due".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: DateConfig {
                include_time: true,
                allow_range: true,
                extra: Default::default(),
            },
            extra: Default::default(),
        });
        let date_yaml = property_value_to_frontmatter_value(&date_val, &date_def).unwrap();
        let date_back = frontmatter_value_to_property_value(&date_yaml, &date_def);
        assert_eq!(date_back, Some(date_val));

        // 3. Files: structured file metadata (assetId, kind, relativePath, name, mimeType, sizeBytes) round-trips without loss
        let files_val = PropertyValue::Files {
            items: vec![FileValue {
                asset_id: "01J00000000000000000000009".into(),
                kind: "asset".into(),
                relative_path: "assets/report.pdf".into(),
                name: "report.pdf".into(),
                mime_type: "application/pdf".into(),
                size_bytes: 4096,
                extra: Default::default(),
            }],
            extra: Default::default(),
        };
        let files_def = PropertyDefinition::Files(PropertyFields {
            id: "prop3".into(),
            name: "Attachments".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: FilesConfig {
                media_only: false,
                max_items: None,
                extra: Default::default(),
            },
            extra: Default::default(),
        });
        let files_yaml = property_value_to_frontmatter_value(&files_val, &files_def).unwrap();
        let files_back = frontmatter_value_to_property_value(&files_yaml, &files_def);
        assert_eq!(files_back, Some(files_val));
    }

    #[test]
    fn st02_property_storage_key_and_deterministic_resolution() {
        let text_def = PropertyDefinition::Text(PropertyFields {
            id: "01JTEXT00000000000000000001".into(),
            name: "Due Date".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: Some(YamlBinding {
                key: "due_date".into(),
                direction: "twoWay".into(),
                extra: Default::default(),
            }),
            config: TextConfig {
                multiline: false,
                extra: Default::default(),
            },
            extra: Default::default(),
        });

        assert_eq!(text_def.storage_key(), Some("due_date"));
        assert_eq!(text_def.name(), Some("Due Date"));
        assert_eq!(text_def.id(), Some("01JTEXT00000000000000000001"));

        // Case 1: exact storage_key wins over name
        let yaml_str = "due_date: \"2026-09-20\"\nDue Date: \"2025-01-01\"\n";
        let mapping: serde_yaml::Mapping = serde_yaml::from_str(yaml_str).unwrap();
        let resolved = resolve_property_yaml_value(&mapping, &text_def);
        assert_eq!(
            resolved,
            Some(&serde_yaml::Value::String("2026-09-20".into()))
        );

        // Case 2: exact property_id wins over fallback name
        let id_def = PropertyDefinition::Text(PropertyFields {
            id: "prop_ulid".into(),
            name: "My Field".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: TextConfig {
                multiline: false,
                extra: Default::default(),
            },
            extra: Default::default(),
        });
        let yaml_str2 = "prop_ulid: \"by-id-val\"\nMy Field: \"by-name-val\"\n";
        let mapping2: serde_yaml::Mapping = serde_yaml::from_str(yaml_str2).unwrap();
        let resolved2 = resolve_property_yaml_value(&mapping2, &id_def);
        assert_eq!(
            resolved2,
            Some(&serde_yaml::Value::String("by-id-val".into()))
        );

        // Case 3: case-insensitive storage_key wins over name
        let yaml_str3 = "DUE_DATE: \"2026-10-10\"\n";
        let mapping3: serde_yaml::Mapping = serde_yaml::from_str(yaml_str3).unwrap();
        let resolved3 = resolve_property_yaml_value(&mapping3, &text_def);
        assert_eq!(
            resolved3,
            Some(&serde_yaml::Value::String("2026-10-10".into()))
        );

        // Case 4: fallback to display name when storage_key is absent
        let yaml_str4 = "Due Date: \"2026-12-31\"\n";
        let mapping4: serde_yaml::Mapping = serde_yaml::from_str(yaml_str4).unwrap();
        let resolved4 = resolve_property_yaml_value(&mapping4, &text_def);
        assert_eq!(
            resolved4,
            Some(&serde_yaml::Value::String("2026-12-31".into()))
        );

        // Protection: amby-id is never matched by a property named "id" or "amby-id"
        let user_id_prop = PropertyDefinition::Text(PropertyFields {
            id: "01JID00000000000000000000001".into(),
            name: "id".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: TextConfig {
                multiline: false,
                extra: Default::default(),
            },
            extra: Default::default(),
        });
        let yaml_str5 = "amby-id: \"01JSECRET00000000000000001\"\nid: \"user-custom-id\"\n";
        let mapping5: serde_yaml::Mapping = serde_yaml::from_str(yaml_str5).unwrap();
        let resolved5 = resolve_property_yaml_value(&mapping5, &user_id_prop);
        assert_eq!(
            resolved5,
            Some(&serde_yaml::Value::String("user-custom-id".into()))
        );

        // And if note has only amby-id, user_id_prop must NOT match it
        let yaml_str6 = "amby-id: \"01JSECRET00000000000000001\"\n";
        let mapping6: serde_yaml::Mapping = serde_yaml::from_str(yaml_str6).unwrap();
        let resolved6 = resolve_property_yaml_value(&mapping6, &user_id_prop);
        assert_eq!(resolved6, None);
    }

    #[test]
    fn st03_select_status_multiselect_rename_resilience() {
        let opt1_id = "01JOPT00000000000000000001";
        let opt2_id = "01JOPT00000000000000000002";
        let select_def = PropertyDefinition::Select(PropertyFields {
            id: "01JSEL000000000000000000001".into(),
            name: "Status".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: SelectConfig {
                options: vec![
                    SelectOption {
                        id: opt1_id.into(),
                        name: "In Progress".into(),
                        color: "#3b82f6".into(),
                        extra: Default::default(),
                    },
                    SelectOption {
                        id: opt2_id.into(),
                        name: "Done".into(),
                        color: "#22c55e".into(),
                        extra: Default::default(),
                    },
                ],
                extra: Default::default(),
            },
            extra: Default::default(),
        });

        // 1. Finding by name (case-insensitive) resolves to option id
        assert_eq!(select_def.find_option_id("in progress"), Some(opt1_id));
        assert_eq!(select_def.find_option_id("Done"), Some(opt2_id));

        // 2. Finding by ID resolves to option id
        assert_eq!(select_def.find_option_id(opt1_id), Some(opt1_id));

        // 3. Serialization to YAML uses option name
        let val = PropertyValue::Select {
            option_id: opt1_id.into(),
            extra: Default::default(),
        };
        let yaml_val = property_value_to_frontmatter_value(&val, &select_def).unwrap();
        assert_eq!(yaml_val, serde_yaml::Value::String("In Progress".into()));

        // 4. Deserialization from YAML with name resolves back to option id
        let parsed = frontmatter_value_to_property_value(&yaml_val, &select_def).unwrap();
        assert_eq!(parsed, val);

        // 5. Deserialization from YAML with raw option ID also resolves to option id
        let id_yaml = serde_yaml::Value::String(opt1_id.into());
        let parsed_id = frontmatter_value_to_property_value(&id_yaml, &select_def).unwrap();
        assert_eq!(parsed_id, val);
    }

    #[test]
    fn st03_empty_and_zero_values_handling() {
        let num_def = PropertyDefinition::Number(PropertyFields {
            id: "prop_num".into(),
            name: "Count".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: NumberConfig {
                format: "number".into(),
                currency: None,
                extra: Default::default(),
            },
            extra: Default::default(),
        });
        let bool_def = PropertyDefinition::Checkbox(PropertyFields {
            id: "prop_bool".into(),
            name: "Active".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: CheckboxConfig {
                extra: Default::default(),
            },
            extra: Default::default(),
        });

        // Zero is preserved and NOT treated as empty
        let zero_val = PropertyValue::Number {
            decimal: "0".into(),
            extra: Default::default(),
        };
        let zero_yaml = property_value_to_frontmatter_value(&zero_val, &num_def).unwrap();
        assert_eq!(zero_yaml, serde_yaml::Value::Number(0.into()));
        let zero_back = frontmatter_value_to_property_value(&zero_yaml, &num_def).unwrap();
        assert_eq!(zero_back, zero_val);

        // False is preserved and NOT treated as empty
        let false_val = PropertyValue::Checkbox {
            checked: false,
            extra: Default::default(),
        };
        let false_yaml = property_value_to_frontmatter_value(&false_val, &bool_def).unwrap();
        assert_eq!(false_yaml, serde_yaml::Value::Bool(false));
        let false_back = frontmatter_value_to_property_value(&false_yaml, &bool_def).unwrap();
        assert_eq!(false_back, false_val);

        // Empty string is None (cleared)
        let empty_num = PropertyValue::Number {
            decimal: "  ".into(),
            extra: Default::default(),
        };
        assert_eq!(
            property_value_to_frontmatter_value(&empty_num, &num_def),
            None
        );
    }
    #[test]
    fn review_persisted_select_survives_option_rename() {
        let opt1_id = "01J00000000000000000000001";
        let opt2_id = "01J00000000000000000000002";
        let mut select_def = PropertyDefinition::Select(PropertyFields {
            id: "01J00000000000000000000003".into(),
            name: "Status".into(),
            page_visibility: "alwaysShow".into(),
            yaml_binding: None,
            config: SelectConfig {
                options: vec![
                    SelectOption {
                        id: opt1_id.into(),
                        name: "In Progress".into(),
                        color: "#3b82f6".into(),
                        extra: Default::default(),
                    },
                    SelectOption {
                        id: opt2_id.into(),
                        name: "Done".into(),
                        color: "#22c55e".into(),
                        extra: Default::default(),
                    },
                ],
                extra: Default::default(),
            },
            extra: Default::default(),
        });

        // 1. Finding by name (case-insensitive) resolves to option id
        assert_eq!(select_def.find_option_id("in progress"), Some(opt1_id));
        assert_eq!(select_def.find_option_id("Done"), Some(opt2_id));

        // 2. Finding by ID resolves to option id
        assert_eq!(select_def.find_option_id(opt1_id), Some(opt1_id));

        // 3. Serialization to YAML uses option name
        let val = PropertyValue::Select {
            option_id: opt1_id.into(),
            extra: Default::default(),
        };
        let yaml_val = property_value_to_frontmatter_value(&val, &select_def).unwrap();
        assert_eq!(yaml_val, serde_yaml::Value::String("In Progress".into()));

        if let PropertyDefinition::Select(fields) = &mut select_def {
            fields.config.options[0].name = "Doing".to_owned();
        }
        // 4. Deserialization from YAML with name resolves back to option id
        let parsed = frontmatter_value_to_property_value(&yaml_val, &select_def).unwrap();
        assert_eq!(parsed, val);

        // 5. Deserialization from YAML with raw option ID also resolves to option id
        let id_yaml = serde_yaml::Value::String(opt1_id.into());
        let parsed_id = frontmatter_value_to_property_value(&id_yaml, &select_def).unwrap();
        assert_eq!(parsed_id, val);
    }
}
