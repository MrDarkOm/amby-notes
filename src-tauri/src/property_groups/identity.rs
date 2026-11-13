//! Identity of a note, deletion of a note and the inspection (appendix З: З10–З12, З27, З34,
//! З35, З51, З55). Nothing is deleted silently: a copy goes to `property-backups/` first.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde_json::json;
use ulid::Ulid;

use super::files::{all_groups, read_entry, require_groups, update_entry};
use super::header::{is_reserved, open_note};
use super::panel::{refresh_cache, resolve_note};
use super::{Hint, Inspection, NoteEntry, RebindOffer};
use crate::frontmatter;

/// Writes a copy of a record to `property-backups/<note-id>/<ULID>.json` (З27, З34). Returns the
/// path relative to the vault.
pub(super) fn write_backup(
    vault: &Path,
    note_id: &str,
    entry: &NoteEntry,
    status: &str,
) -> Result<String, String> {
    let path = vault
        .join(".amby")
        .join("property-backups")
        .join(note_id)
        .join(format!("{}.json", Ulid::generate()));
    let created_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let body = json!({
        "format": "amby-note-property-backup",
        "formatVersion": 2,
        "status": status,
        "noteId": note_id,
        "createdAtMs": created_at_ms,
        "entry": entry,
    });
    let mut bytes = serde_json::to_vec_pretty(&body).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    frontmatter::atomic_write_bytes_new(&path, &bytes)
        .map_err(|error| format!("Failed to create property backup: {error:?}"))?;
    path.strip_prefix(vault)
        .unwrap_or(&path)
        .to_str()
        .map(|text| text.replace('\\', "/"))
        .ok_or_else(|| "Property backup path is not valid UTF-8".to_string())
}

/// A copy in `property-backups/` (as now), then the line leaves the file; returns the relative
/// path of the copy (З27).
pub fn backup_and_clear(conn: &Connection, vault: &Path, note_id: &str) -> Result<String, String> {
    crate::index::identity::ensure_unique_identity(conn, note_id)?;
    require_groups(vault)?;
    // A malformed header stops the clearing, as before.
    open_note(conn, vault, note_id)?;
    let entry = read_entry(vault, note_id)?
        .ok_or_else(|| "Note has no custom properties to back up".to_string())?;
    let copy = write_backup(vault, note_id, &entry, "backedUp")?;
    if let Err(error) = update_entry(conn, vault, note_id, |_| Ok(None)) {
        return Err(format!(
            "Property backup was created at {copy}, but active properties could not be cleared: {error}"
        ));
    }
    let _ = refresh_cache(conn, vault, note_id);
    Ok(copy)
}

/// Like [`backup_and_clear`], but a note with no recorded look (its properties are plain keys of the
/// header, which are never touched) has nothing to back up: that is an empty answer, not a failure.
/// A move into a database asks for this after it carried the properties over.
pub fn backup_if_any(conn: &Connection, vault: &Path, note_id: &str) -> Result<String, String> {
    crate::index::identity::ensure_unique_identity(conn, note_id)?;
    require_groups(vault)?;
    if read_entry(vault, note_id)?.is_none() {
        return Ok(String::new());
    }
    backup_and_clear(conn, vault, note_id)
}

fn note_exists(conn: &Connection, id: &str) -> bool {
    conn.query_row("SELECT 1 FROM notes WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn same_content(a: &NoteEntry, b: &NoteEntry) -> bool {
    let strip = |entry: &NoteEntry| {
        let mut stripped = NoteEntry {
            id: String::new(),
            hint: None,
            ..entry.clone()
        };
        // З70: the time of the last edit is not the content.
        stripped.extra.remove("edited");
        stripped
    };
    strip(a) == strip(b)
}

/// Lines whose note got another `amby-id` at the same path while the old id is nowhere else, and
/// whose new id has no line or an equal one (without `hint`) (З11, З35).
pub fn rebind_offers(conn: &Connection, vault: &Path) -> Result<Vec<RebindOffer>, String> {
    let mut offers = Vec::new();
    for (entries, _) in all_groups(vault)? {
        for entry in entries {
            let Some(Hint { path }) = &entry.hint else {
                continue;
            };
            if note_exists(conn, &entry.id) {
                continue;
            }
            let new_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM notes WHERE path = ?1 AND id != ?2",
                    [path.as_str(), entry.id.as_str()],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let Some(new_id) = new_id else {
                continue;
            };
            if crate::index::identity::is_path_identity(&new_id) {
                continue;
            }
            let theirs = read_entry(vault, &new_id)?;
            if theirs.as_ref().is_some_and(|t| !same_content(t, &entry)) {
                continue;
            }
            offers.push(RebindOffer {
                old_id: entry.id.clone(),
                new_id,
                path: path.clone(),
            });
        }
    }
    offers.sort_by(|a, b| a.old_id.cmp(&b.old_id));
    Ok(offers)
}

/// On consent: the whole line moves to the group of the new id (possibly the same file); a copy
/// of the old one goes to `property-backups/`, then the old line is removed. A repeat after a
/// crash finishes it (З35, З55).
pub fn rebind(conn: &Connection, vault: &Path, old_id: &str, new_id: &str) -> Result<(), String> {
    require_groups(vault)?;
    let old = read_entry(vault, old_id)?;
    let theirs = read_entry(vault, new_id)?;
    let Some(old) = old else {
        return if theirs.is_some() {
            Ok(())
        } else {
            Err("There is no record to bind".to_string())
        };
    };
    match &theirs {
        Some(theirs) if !same_content(theirs, &old) => {
            return Err("The new id has another record already".to_string());
        }
        Some(_) => {}
        None => {
            let mut moved = old.clone();
            moved.id = new_id.to_string();
            update_entry(conn, vault, new_id, |_| Ok(Some(moved)))?;
        }
    }
    write_backup(vault, old_id, &old, "rebound")?;
    update_entry(conn, vault, old_id, |_| Ok(None))?;
    let _ = refresh_cache(conn, vault, new_id);
    Ok(())
}

/// The inspection of the properties of a vault (З10): walks the files, which is the only full
/// walk besides the rebuild and the migration (З56). Reads only.
pub fn inspect(conn: &Connection, vault: &Path) -> Result<Inspection, String> {
    let mut report = Inspection::default();
    if super::files::storage_mode(vault)? != super::StorageMode::Groups {
        return Ok(report);
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (entries, bad) in all_groups(vault)? {
        report.bad_lines.extend(bad);
        for entry in entries {
            if !seen.insert(entry.id.clone()) {
                continue;
            }
            if entry
                .props
                .values()
                .any(|diff| diff.previous_name.is_some())
            {
                report.unfinished_operations.push(entry.id.clone());
            }
            for name in entry.props.keys().filter(|n| is_reserved(n)) {
                report.reserved_names.push((entry.id.clone(), name.clone()));
            }
            if !note_exists(conn, &entry.id) {
                report.orphans.push(entry.id.clone());
                continue;
            }
            let Ok(access) = open_note(conn, vault, &entry.id) else {
                continue;
            };
            let resolved = resolve_note(&access.keys, Some(&entry), false);
            for dormant in &resolved.dormant {
                if !is_reserved(&dormant.name) {
                    report
                        .dormant
                        .push((entry.id.clone(), dormant.name.clone()));
                }
            }
            for name in &resolved.ambiguous {
                report.ambiguous.push((entry.id.clone(), name.clone()));
            }
        }
    }
    report.orphans.sort();
    report.dormant.sort();
    report.ambiguous.sort();
    report.reserved_names.sort();
    report.unfinished_operations.sort();
    Ok(report)
}

/// «Удалить» an orphan line from the inspection: a copy in `property-backups/` first (З34).
pub fn delete_orphan(conn: &Connection, vault: &Path, note_id: &str) -> Result<(), String> {
    require_groups(vault)?;
    if note_exists(conn, note_id) {
        return Err("The note exists; its properties are not orphans".to_string());
    }
    let entry =
        read_entry(vault, note_id)?.ok_or_else(|| "There is no record to delete".to_string())?;
    write_backup(vault, note_id, &entry, "deleted")?;
    update_entry(conn, vault, note_id, |_| Ok(None))?;
    Ok(())
}
