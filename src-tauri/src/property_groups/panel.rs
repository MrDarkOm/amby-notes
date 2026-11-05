//! The panel of a note and the cache of SQLite (appendix З: З1, З3, З3а, З23, З25, З44–З47).
//! Reading never writes (З8).

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::files::{self, all_groups, storage_mode};
use super::header::{
    base_look, fits_type, look_of, open_note, outside_options, resolve, same_name, NoteAccess,
};
use super::{
    ActiveProperty, DormantProperty, NoteEntry, Panel, PanelWarning, RenameHint, StorageMode,
};
use crate::frontmatter::HeaderKey;
use crate::model::CustomProperty;

/// What is known of the group file of a note.
#[derive(Debug, Clone, Default)]
pub(super) struct GroupState {
    /// The file has a line that cannot be used, or its first line cannot be read (З51).
    pub bad_in_group: bool,
    /// The line of this very note cannot be used (З51).
    pub own_line_bad: bool,
    pub format_newer: bool,
}

/// What the keys of a header and the record of a note make together (З46).
pub(super) struct Resolved {
    pub active: Vec<ActiveProperty>,
    pub dormant: Vec<DormantProperty>,
    /// Names whose keys are ambiguous (З1).
    pub ambiguous: Vec<String>,
}

/// Matches the records to the keys, the rest of the keys are ordinary lines (З3, З46), and
/// puts the properties in the order of З47.
pub(super) fn resolve_note(
    keys: &[HeaderKey],
    entry: Option<&NoteEntry>,
    own_line_bad: bool,
) -> Resolved {
    let usable: Vec<&HeaderKey> = keys
        .iter()
        .filter(|key| !super::header::is_reserved(&key.key))
        .collect();
    let usable_keys: Vec<HeaderKey> = usable.iter().map(|k| (*k).clone()).collect();
    let position = |key: &str| usable_keys.iter().position(|k| k.key == key);
    let mut used = vec![false; usable_keys.len()];
    let mut slots: Vec<(usize, ActiveProperty)> = Vec::new();
    let mut dormant = Vec::new();
    let mut ambiguous = Vec::new();
    let empty = std::collections::BTreeMap::new();
    let props = entry.map_or(&empty, |e| &e.props);
    for (name, diff) in props {
        if super::header::is_reserved(name) {
            continue;
        }
        let look = look_of(name, Some(diff));
        match resolve(&usable_keys, name, diff.previous_name.as_deref()) {
            super::KeyMatch::Found {
                key,
                value,
                complex,
            } => {
                let at = position(&key).unwrap_or(0);
                used[at] = true;
                slots.push((
                    at,
                    active(
                        name,
                        &key,
                        &value,
                        &look,
                        true,
                        complex || own_line_bad,
                        true,
                    ),
                ));
            }
            super::KeyMatch::Ambiguous {
                keys: ambiguous_keys,
            } => {
                let first = ambiguous_keys
                    .iter()
                    .filter_map(|k| position(k))
                    .min()
                    .unwrap_or(0);
                for key in &ambiguous_keys {
                    if let Some(at) = position(key) {
                        used[at] = true;
                    }
                }
                ambiguous.push(name.clone());
                slots.push((
                    first,
                    active(
                        name,
                        ambiguous_keys.first().map_or("", String::as_str),
                        "",
                        &look,
                        true,
                        true,
                        true,
                    ),
                ));
            }
            _ => dormant.push(DormantProperty {
                name: name.clone(),
                diff: diff.clone(),
            }),
        }
    }
    // The old key of a rename that is not finished, while the new one is in the header too, is an
    // ordinary key; it goes below the others (З29).
    let stale: Vec<String> = props
        .values()
        .filter_map(|diff| diff.previous_name.as_deref())
        .map(str::to_string)
        .collect();
    for (at, key) in usable_keys.iter().enumerate() {
        if used[at] {
            continue;
        }
        let look = base_look(&key.key);
        let at = if stale.iter().any(|p| same_name(p, &key.key)) {
            at + usable_keys.len()
        } else {
            at
        };
        slots.push((
            at,
            active(
                &key.key,
                &key.key,
                &key.value,
                &look,
                false,
                key.complex || own_line_bad,
                false,
            ),
        ));
    }
    slots.sort_by_key(|(at, _)| *at);
    let mut active: Vec<ActiveProperty> = slots.into_iter().map(|(_, p)| p).collect();
    if let Some(entry) = entry {
        if !entry.order.is_empty() {
            let rank = |name: &str| entry.order.iter().position(|o| same_name(o, name));
            let mut listed: Vec<(usize, ActiveProperty)> = Vec::new();
            let mut rest = Vec::new();
            for property in active {
                match rank(&property.name) {
                    Some(at) => listed.push((at, property)),
                    None => rest.push(property),
                }
            }
            listed.sort_by_key(|(at, _)| *at);
            active = listed.into_iter().map(|(_, p)| p).chain(rest).collect();
        }
    }
    Resolved {
        active,
        dormant,
        ambiguous,
    }
}

fn active(
    name: &str,
    key: &str,
    value: &str,
    look: &super::header::Look,
    has_record: bool,
    read_only: bool,
    bound: bool,
) -> ActiveProperty {
    let _ = bound;
    ActiveProperty {
        name: name.to_string(),
        key: key.to_string(),
        value: value.to_string(),
        property_type: look.property_type.clone(),
        icon: look.icon.clone(),
        settings: look.settings.clone(),
        from_template: crate::property_template::lookup(name).is_some(),
        has_record,
        read_only,
        type_mismatch: !fits_type(value, &look.property_type),
        outside_options: outside_options(value, &look.property_type, &look.settings),
    }
}

/// The value the cache remembers for a name, the last header it saw (З3а).
fn cached_value(conn: &Connection, note_id: &str, name: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM note_custom_properties WHERE note_id = ?1 AND name = ?2",
        params![note_id, name],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// «Похоже, «Статус» переименовали в «Состояние»» (З3а, З44): one sleeping record with a value
/// from the last header, one new key with the same value, not refused.
fn rename_hint(
    conn: &Connection,
    note_id: &str,
    resolved: &Resolved,
    entry: Option<&NoteEntry>,
) -> Option<RenameHint> {
    let [dormant] = resolved.dormant.as_slice() else {
        return None;
    };
    let fresh: Vec<&ActiveProperty> = resolved.active.iter().filter(|p| !p.has_record).collect();
    let [new] = fresh.as_slice() else {
        return None;
    };
    let last = cached_value(conn, note_id, &dormant.name)?;
    if last.trim().is_empty() || last.trim() != new.value.trim() {
        return None;
    }
    let refused = entry.is_some_and(|e| {
        e.dismissed_renames
            .iter()
            .any(|[old, now]| same_name(old, &dormant.name) && same_name(now, &new.name))
    });
    (!refused).then(|| RenameHint {
        old_name: dormant.name.clone(),
        new_name: new.name.clone(),
    })
}

/// The panel of a note from what is already read.
pub(super) fn build_panel(
    conn: &Connection,
    note_id: &str,
    access: &NoteAccess,
    entry: Option<&NoteEntry>,
    state: &GroupState,
) -> Panel {
    let resolved = resolve_note(
        &access.keys,
        entry,
        state.own_line_bad || state.format_newer,
    );
    let mut warnings = Vec::new();
    if state.format_newer {
        warnings.push(PanelWarning::FormatNewer);
    }
    if state.bad_in_group {
        warnings.push(PanelWarning::BadLineInGroup);
    }
    for name in &resolved.ambiguous {
        warnings.push(PanelWarning::AmbiguousKey { name: name.clone() });
    }
    let hint = if state.own_line_bad || state.format_newer {
        None
    } else {
        rename_hint(conn, note_id, &resolved, entry)
    };
    Panel {
        unreadable: false,
        active: resolved.active,
        dormant: resolved.dormant,
        rename_hint: hint,
        warnings,
        read_only: false,
    }
}

/// The group of a note as the panel needs it: its record and what is wrong with the file.
pub(super) fn group_state(
    vault: &Path,
    note_id: &str,
) -> Result<(Option<NoteEntry>, GroupState), String> {
    match storage_mode(vault)? {
        StorageMode::Legacy => Ok((None, GroupState::default())),
        StorageMode::Newer => Ok((
            None,
            GroupState {
                format_newer: true,
                ..GroupState::default()
            },
        )),
        StorageMode::Groups => match files::read_group(vault, note_id) {
            Ok((file, bad)) => {
                let own = bad.iter().any(|b| b.note_id.as_deref() == Some(note_id));
                let entry = file.entries.into_iter().find(|e| e.id == note_id);
                Ok((
                    entry,
                    GroupState {
                        bad_in_group: !bad.is_empty(),
                        own_line_bad: own,
                        format_newer: false,
                    },
                ))
            }
            Err(_) => Ok((
                None,
                GroupState {
                    bad_in_group: true,
                    own_line_bad: true,
                    format_newer: false,
                },
            )),
        },
    }
}

/// The panel of a note. Reads only: never writes (З8). While the vault is not migrated, or cannot
/// be, or is of a newer format, the whole panel is for reading only (З57, З59).
pub fn panel(conn: &Connection, vault: &Path, note_id: &str) -> Result<Panel, String> {
    let read_only = storage_mode(vault)? != StorageMode::Groups;
    let (entry, state) = group_state(vault, note_id)?;
    let Ok(access) = open_note(conn, vault, note_id) else {
        let mut warnings = Vec::new();
        if state.format_newer {
            warnings.push(PanelWarning::FormatNewer);
        }
        return Ok(Panel {
            unreadable: true,
            warnings,
            read_only,
            ..Panel::default()
        });
    };
    let mut shown = build_panel(conn, note_id, &access, entry.as_ref(), &state);
    shown.read_only = read_only;
    Ok(shown)
}

// ----- the cache (З23) -----

/// Position of a sleeping record in the cache: it is kept so that the last value is remembered
/// for the hint of З3а, and is never listed.
const DORMANT_POSITION: i64 = -1;

/// Replaces the rows of a note in `note_custom_properties` with what the panel shows: the
/// properties with the value of the header (З23), the sleeping records with their last value.
fn store_rows(conn: &Connection, note_id: &str, panel: &Panel) -> Result<(), String> {
    let remembered: Vec<(String, String)> = panel
        .dormant
        .iter()
        .map(|d| {
            (
                d.name.clone(),
                cached_value(conn, note_id, &d.name).unwrap_or_default(),
            )
        })
        .collect();
    conn.execute(
        "DELETE FROM note_custom_properties WHERE note_id = ?1",
        [note_id],
    )
    .map_err(|error| error.to_string())?;
    let insert = |name: &str, icon: &str, ty: &str, value: &str, settings: &str, position: i64| {
        conn.execute(
            r#"INSERT OR REPLACE INTO note_custom_properties
               (id, note_id, name, icon, property_type, value, settings, position)
               VALUES (?1, ?2, ?1, ?3, ?4, ?5, ?6, ?7)"#,
            params![name, note_id, icon, ty, value, settings, position],
        )
        .map_err(|error| error.to_string())
    };
    for (at, property) in panel.active.iter().enumerate() {
        insert(
            &property.name,
            &property.icon,
            &property.property_type,
            &property.value,
            &property.settings,
            at as i64,
        )?;
    }
    for (dormant, (_, value)) in panel.dormant.iter().zip(remembered) {
        let look = look_of(&dormant.name, Some(&dormant.diff));
        insert(
            &dormant.name,
            &look.icon,
            &look.property_type,
            &value,
            &look.settings,
            DORMANT_POSITION,
        )?;
    }
    Ok(())
}

/// Rebuilds the cache of one note from its file, the template and its record (З23). Does nothing
/// when the vault is not in the groups format yet (З38).
pub(super) fn refresh_cache(conn: &Connection, vault: &Path, note_id: &str) -> Result<(), String> {
    if storage_mode(vault)? != StorageMode::Groups {
        return Ok(());
    }
    let shown = panel(conn, vault, note_id)?;
    if shown.unreadable {
        return Ok(());
    }
    store_rows(conn, note_id, &shown)
}

/// The rows of the cache of a note, in the order of the panel (З23).
pub fn cached_properties(conn: &Connection, note_id: &str) -> Result<Vec<CustomProperty>, String> {
    let mut statement = conn
        .prepare(
            r#"SELECT id, name, icon, property_type, value, settings
               FROM note_custom_properties WHERE note_id = ?1 AND position >= 0
               ORDER BY position, rowid"#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([note_id], |row| {
            Ok(CustomProperty {
                id: row.get(0)?,
                name: row.get(1)?,
                icon: row.get(2)?,
                property_type: row.get(3)?,
                value: row.get(4)?,
                settings: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// Rebuilds the SQLite table `note_custom_properties` from the files, the template and the
/// headers; `value` is the one of the header. Migrates and deletes nothing (З23).
pub fn rebuild_cache(conn: &Connection, vault: &Path) -> Result<(), String> {
    if storage_mode(vault)? != StorageMode::Groups {
        return Ok(());
    }
    conn.execute("DELETE FROM note_custom_properties", [])
        .map_err(|error| error.to_string())?;
    let known = |id: &str| -> bool {
        conn.query_row("SELECT 1 FROM notes WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    };
    let mut done: BTreeSet<String> = BTreeSet::new();
    for (entries, bad) in all_groups(vault)? {
        let bad_in_group = !bad.is_empty();
        for entry in entries {
            if !known(&entry.id) || !done.insert(entry.id.clone()) {
                continue;
            }
            let Ok(access) = open_note(conn, vault, &entry.id) else {
                continue;
            };
            let state = GroupState {
                bad_in_group,
                own_line_bad: false,
                format_newer: false,
            };
            let shown = build_panel(conn, &entry.id, &access, Some(&entry), &state);
            store_rows(conn, &entry.id, &shown)?;
        }
    }
    Ok(())
}
