//! The old id-based interface of the properties on top of the groups (appendix З: З38, З47): the
//! interface keeps asking for `upsert`, `delete`, `reorder` and a list of custom properties; in
//! the groups a property is known by its name, so the name is its id here. One call may become
//! several edits; each of them follows the rules of its own operation (З9, З28).

use std::path::Path;

use rusqlite::Connection;

use super::edits::{
    change_type, create_property, delete_property, rename_property, reorder, set_appearance,
    set_value,
};
use super::files::storage_mode;
use super::header::same_name;
use super::panel::panel;
use super::{Design, StorageMode};
use crate::model::CustomProperty;

/// Are the properties of this vault in the groups?
pub fn in_groups(vault: &Path) -> bool {
    matches!(storage_mode(vault), Ok(StorageMode::Groups))
}

/// The old store may be written only while there is no layout at all; a layout of another
/// version makes every property read only (З48).
pub fn ensure_old_store_writable(vault: &Path) -> Result<(), String> {
    match storage_mode(vault)? {
        StorageMode::Newer => {
            Err("The format of the properties is newer than this version of Amby".to_string())
        }
        _ => Ok(()),
    }
}

fn as_custom(property: &super::ActiveProperty) -> CustomProperty {
    CustomProperty {
        id: property.name.clone(),
        name: property.name.clone(),
        icon: property.icon.clone(),
        property_type: property.property_type.clone(),
        value: property.value.clone(),
        settings: property.settings.clone(),
    }
}

/// The properties of a note that have a look of their own — a record or a basic property of the
/// template — in the order of the panel (З46). A key without a look is an ordinary line of the
/// header and is not listed.
pub fn custom_properties(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<Vec<CustomProperty>, String> {
    let shown = panel(conn, vault, note_id)?;
    Ok(shown
        .active
        .iter()
        .filter(|property| property.has_record || property.from_template)
        .map(as_custom)
        .collect())
}

/// Creates or changes a property by the old contract: `id` is the name it has now.
pub fn upsert_compat(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property: CustomProperty,
) -> Result<CustomProperty, String> {
    let name = property.name.trim().to_string();
    if name.is_empty() {
        return Err("Property name cannot be empty".to_string());
    }
    let shown = panel(conn, vault, note_id)?;
    if shown.unreadable {
        return Err("Properties are unavailable while the header is malformed".to_string());
    }
    let current_id = if property.id.is_empty() {
        &name
    } else {
        &property.id
    };
    let existing = shown
        .active
        .iter()
        .find(|p| same_name(&p.name, current_id))
        .cloned();
    match existing {
        Some(existing) => {
            let mut at = existing.name.clone();
            if !same_name(&existing.name, &name) || existing.name != name {
                rename_property(conn, vault, note_id, &at, &name)?;
                at = name.clone();
            }
            if existing.property_type != property.property_type {
                change_type(conn, vault, note_id, &at, &property.property_type)?;
            }
            if existing.icon != property.icon || existing.settings != property.settings {
                set_appearance(
                    conn,
                    vault,
                    note_id,
                    &at,
                    &property.icon,
                    &property.settings,
                )?;
            }
            if existing.value != property.value {
                set_value(conn, vault, note_id, &at, &property.value)?;
            }
        }
        None => {
            create_property(
                conn,
                vault,
                note_id,
                Design {
                    name: name.clone(),
                    icon: property.icon.clone(),
                    property_type: property.property_type.clone(),
                    settings: property.settings.clone(),
                },
                &property.value,
            )?;
        }
    }
    let shown = panel(conn, vault, note_id)?;
    shown
        .active
        .iter()
        .find(|p| same_name(&p.name, &name))
        .map(as_custom)
        .ok_or_else(|| format!("The property {name} is not in the panel after the edit"))
}

/// Deletes a property by the old contract: the id is its name.
pub fn delete_compat(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
) -> Result<(), String> {
    delete_property(conn, vault, note_id, property_id)
}

/// Orders the properties by the old contract: the ids are the names.
pub fn reorder_compat(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_ids: &[String],
) -> Result<(), String> {
    reorder(conn, vault, note_id, property_ids)
}

/// Rebuilds the SQLite mirror of the properties from the right store: the groups when the vault
/// is in the new format, `properties.json` otherwise (З23, З38).
pub fn restore_cache_any(conn: &Connection, vault: &Path) -> Result<(), String> {
    match storage_mode(vault)? {
        StorageMode::Groups => super::panel::rebuild_cache(conn, vault),
        StorageMode::Legacy => crate::property_store::restore_cache(conn, vault),
        StorageMode::Newer => Ok(()),
    }
}

static PENDING_OLD_VERSION: std::sync::Mutex<Option<super::legacy::LegacyReport>> =
    std::sync::Mutex::new(None);

/// At the opening of a vault: carries over what an old version changed in `properties.json`,
/// when its hash differs from the one this device remembers (З22, З36). The answer waits for the
/// interface, which asks for it with [`take_pending_old_version_report`].
pub fn check_old_version_on_open(conn: &Connection, vault: &Path) {
    if !in_groups(vault) {
        return;
    }
    if let Ok(report) = super::legacy::check_old_version_edits(conn, vault) {
        if !report.transferred.is_empty() || !report.conflicts.is_empty() {
            if let Ok(mut pending) = PENDING_OLD_VERSION.lock() {
                *pending = Some(report);
            }
        }
    }
}

/// The report the opening of the vault made, once.
pub fn take_pending_old_version_report() -> Option<super::legacy::LegacyReport> {
    PENDING_OLD_VERSION.lock().ok()?.take()
}
