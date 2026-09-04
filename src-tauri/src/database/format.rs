//! Durable database JSON types and the pure, filesystem-free JSON boundary.
//!
//! This module intentionally stops at bytes. It does not know about vaults,
//! paths, SQLite, or Tauri state. Callers can parse a shard, validate it, and
//! prepare replacement bytes before choosing an atomic filesystem publisher.

use std::collections::BTreeMap;

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
    pub locked: bool,
    pub membership: Membership,
    pub properties: Vec<PropertyDefinition>,
    #[serde(rename = "viewOrder")]
    pub view_order: Vec<String>,
    #[serde(rename = "defaultViewId")]
    pub default_view_id: Option<String>,
    #[serde(rename = "templateOrder")]
    pub template_order: Vec<String>,
    #[serde(rename = "defaultTemplateId")]
    pub default_template_id: Option<String>,
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
            Self::Opaque(_) => None,
        }
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
    #[serde(rename = "openMode")]
    pub open_mode: String,
    #[serde(rename = "subitemsMode")]
    pub subitems_mode: String,
    pub density: Option<String>,
    pub fields: Vec<ViewField>,
    pub filter: Option<FilterNode>,
    pub sorts: Vec<SortRule>,
    pub group: Option<GroupRule>,
    #[serde(rename = "manualOrder")]
    pub manual_order: Vec<String>,
    pub aggregates: Vec<AggregateRule>,
    #[serde(rename = "layoutConfig")]
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
}
