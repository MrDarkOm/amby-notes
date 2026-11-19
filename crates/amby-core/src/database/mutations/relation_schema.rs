use serde_json::json;

use crate::database::format::PropertyDefinition;
use crate::frontmatter::{self};

use super::*;

pub(super) fn manifest_revision_is_valid(revision: &str) -> bool {
    revision.len() == 64
        && revision
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub(super) fn normalize_relation_max_items(value: Option<u8>) -> Option<u8> {
    value.and_then(|limit| (limit == 1).then_some(1))
}

pub(super) fn related_revision_map(
    request: &ChangeDatabasePropertyTypeRequest,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut revisions = std::collections::BTreeMap::new();
    for revision in &request.expected_related_manifest_revisions {
        if !frontmatter::is_amby_id(&revision.database_id)
            || revision.database_id == request.database_id
            || !manifest_revision_is_valid(&revision.revision)
            || revisions
                .insert(revision.database_id.clone(), revision.revision.clone())
                .is_some()
        {
            return Err("Invalid related manifest revision".to_owned());
        }
    }
    Ok(revisions)
}

pub(super) fn relation_config(
    property: &PropertyDefinition,
) -> Option<(&str, &str, Option<u8>, Option<&str>)> {
    match property {
        PropertyDefinition::Relation(fields) => Some((
            fields.id.as_str(),
            fields.config.target_database_id.as_str(),
            fields.config.max_items,
            fields.config.inverse_property_id.as_deref(),
        )),
        _ => None,
    }
}

pub(super) fn property_with_relation_config(
    property: &PropertyDefinition,
    target_database_id: &str,
    max_items: Option<u8>,
    inverse_property_id: Option<&str>,
) -> Result<PropertyDefinition, String> {
    let mut value = serde_json::to_value(property).map_err(|error| error.to_string())?;
    value["type"] = serde_json::Value::String("relation".to_owned());
    let config = value
        .get_mut("config")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "Relation property config is not editable".to_owned())?;
    config.insert(
        "targetDatabaseId".to_owned(),
        serde_json::Value::String(target_database_id.to_owned()),
    );
    config.insert(
        "maxItems".to_owned(),
        max_items.map_or(serde_json::Value::Null, |value| json!(value)),
    );
    config.insert(
        "inversePropertyId".to_owned(),
        inverse_property_id.map_or(serde_json::Value::Null, |value| {
            serde_json::Value::String(value.to_owned())
        }),
    );
    serde_json::from_value(value).map_err(|error| error.to_string())
}

pub(super) fn property_with_type_and_config(
    property: &PropertyDefinition,
    property_type: &str,
    config: serde_json::Value,
) -> Result<PropertyDefinition, String> {
    let mut value = serde_json::to_value(property).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Property definition is not editable".to_owned())?;
    object.insert(
        "type".to_owned(),
        serde_json::Value::String(property_type.to_owned()),
    );
    let mut merged_config = object
        .get("config")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    let requested_config = config
        .as_object()
        .ok_or_else(|| "Property configuration must be an object".to_owned())?;
    for (key, value) in requested_config {
        merged_config.insert(key.clone(), value.clone());
    }
    object.insert(
        "config".to_owned(),
        serde_json::Value::Object(merged_config),
    );
    serde_json::from_value(value).map_err(|error| error.to_string())
}

pub(super) fn relation_inverse_property(
    id: &str,
    name: &str,
    source_database_id: &str,
    source_property_id: &str,
) -> Result<PropertyDefinition, String> {
    serde_json::from_value(json!({
        "type": "relation",
        "id": id,
        "name": name,
        "pageVisibility": "alwaysShow",
        "yamlBinding": null,
        "config": {
            "targetDatabaseId": source_database_id,
            "maxItems": null,
            "inversePropertyId": source_property_id,
        },
    }))
    .map_err(|error| error.to_string())
}

pub(super) fn relation_property_mut<'a>(
    manifest: &'a mut crate::database::format::DatabaseManifest,
    property_id: &str,
) -> Result<&'a mut PropertyDefinition, String> {
    manifest
        .properties
        .iter_mut()
        .find(|property| property.id() == Some(property_id))
        .ok_or_else(|| "Related inverse property was not found".to_owned())
}
