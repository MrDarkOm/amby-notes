//! What the application asks of the properties around the opening of a vault (appendix З: З23,
//! З36, З57, З59): which store the vault is in, the list shown for a note, the mirror of SQLite and
//! the report of the edits of an old version found at the opening. The edits of the properties
//! themselves are the commands by name of [`super::edits`] (З60); nothing here writes the old file.

use std::path::Path;

use rusqlite::Connection;

use super::files::storage_mode;
use super::panel::panel;
use super::StorageMode;
use crate::model::CustomProperty;

/// Are the properties of this vault in the groups?
pub fn in_groups(vault: &Path) -> bool {
    matches!(storage_mode(vault), Ok(StorageMode::Groups))
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
        .filter(|property| {
            // A header list with no record is listed too: it reads as a multi-select (З62).
            property.has_record || property.from_template || property.property_type != "text"
        })
        .map(as_custom)
        .collect())
}

/// Rebuilds the SQLite mirror of the properties from the right store: the groups when the vault
/// is in the new format, `properties.json` (read only) otherwise (З23, З59).
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
