//! Builds the properties a new database starts with, against the manifest it will be
//! created with, by the same code `create_database_property` uses.

use std::path::Path;

use serde_json::Value;

use super::model::ProjectError;
use crate::database::format::{parse_manifest, DatabaseManifest};
use crate::database::mutations::{
    build_new_property, default_table_view, new_database_manifest_bytes,
    CreateDatabasePropertyRequest, NewDatabaseExtras, PlannedDatabaseIds, PlannedPropertyIds,
};
use crate::database::validation::validate_manifest;

fn fail(message: impl ToString) -> ProjectError {
    ProjectError::failed("schemaBuild", message.to_string())
}

/// Names that must differ inside one list (option names of one property, property names).
pub fn ensure_distinct(names: &[String]) -> Result<(), ProjectError> {
    let mut seen: Vec<String> = Vec::new();
    for name in names {
        let lower = name.to_lowercase();
        if seen.contains(&lower) {
            return Err(ProjectError::InvalidName {
                field: "schemaName".to_owned(),
                reason: "duplicate".to_owned(),
            });
        }
        seen.push(lower);
    }
    Ok(())
}

pub struct PropertyBuilder<'a> {
    vault: &'a Path,
    database_id: String,
    manifest: DatabaseManifest,
    /// Databases the same operation creates; relations to them are not looked up on disk.
    pending_databases: Vec<String>,
}

impl<'a> PropertyBuilder<'a> {
    /// A builder for the database that `ids` and `name` describe, starting empty.
    pub fn new(
        vault: &'a Path,
        name: &str,
        ids: &PlannedDatabaseIds,
    ) -> Result<Self, ProjectError> {
        let base =
            new_database_manifest_bytes(name, "standalone", ids, &NewDatabaseExtras::default())
                .map_err(fail)?;
        let manifest = parse_manifest(&base).map_err(fail)?.value;
        Ok(Self {
            vault,
            database_id: ids.database_id.clone(),
            manifest,
            pending_databases: Vec::new(),
        })
    }

    /// Names the databases that the operation creates alongside this one.
    pub fn with_pending_databases(mut self, pending: &[String]) -> Self {
        self.pending_databases = pending.to_vec();
        self
    }

    /// Adds one property. Later ones see earlier ones, as when they are made one by one.
    pub fn add(
        &mut self,
        property_type: &str,
        name: &str,
        options: &[String],
        tweak: &dyn Fn(&mut CreateDatabasePropertyRequest),
    ) -> Result<(Value, PlannedPropertyIds), ProjectError> {
        let mut spec = CreateDatabasePropertyRequest {
            database_id: self.database_id.clone(),
            property_type: property_type.to_owned(),
            options: options.to_vec(),
            ..Default::default()
        };
        tweak(&mut spec);
        let planned = PlannedPropertyIds::generate(options.len());
        let (definition, _, _) = build_new_property(
            self.vault,
            &self.manifest,
            &spec,
            name,
            false,
            Some(&planned),
            &self.pending_databases,
        )
        .map_err(fail)?;
        let value = serde_json::to_value(&definition).map_err(fail)?;
        self.manifest.properties.push(definition);
        Ok((value, planned))
    }

    /// Checks the whole manifest the way the database layer will.
    pub fn validate(&self) -> Result<(), ProjectError> {
        if validate_manifest(&self.manifest).errors.is_empty() {
            Ok(())
        } else {
            Err(fail("The properties would make the manifest invalid"))
        }
    }
}

/// The default view as a gallery of titles grouped by one property.
pub fn gallery_grouped_by(ids: &PlannedDatabaseIds, name: &str, group_property_id: &str) -> Value {
    let mut view = default_table_view(ids);
    view["name"] = Value::String(name.to_owned());
    view["layout"] = Value::String("gallery".to_owned());
    view["group"] =
        serde_json::json!({"field": {"kind": "property", "propertyId": group_property_id}});
    view["layoutConfig"] =
        serde_json::json!({"cardSize": "medium", "coverVisible": true, "groupSort": "manual"});
    view
}
