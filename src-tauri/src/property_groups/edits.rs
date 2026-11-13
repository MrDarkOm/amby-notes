//! Edits of one note: the value into the header, the look into the group, and the operations
//! that touch both (appendix З: З9, З24–З29, З55). A refusal comes before the first write (З28).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};
use ulid::Ulid;

use super::files::{self, read_entry, require_groups, update_entry};
use super::header::{
    check_name, look_of, open_note, resolve, same_name, set_look, Look, NoteAccess,
};
use super::panel::{refresh_cache, resolve_note, Resolved};
use super::{Design, KeyMatch, NoteEntry, RecoverReport, RenameHint};
use crate::frontmatter;

// ----- preparation -----

/// A note ready for an edit: its header can be trusted, its group can be written.
struct Ctx {
    access: NoteAccess,
    entry: Option<NoteEntry>,
    resolved: Resolved,
}

/// The checks that come before any write (З12, З25, З28, З48, З51).
fn prepare(conn: &Connection, vault: &Path, note_id: &str) -> Result<Ctx, String> {
    require_groups(vault)?;
    let access = open_note(conn, vault, note_id)?;
    let (file, bad) = files::read_group(vault, note_id)?;
    if !bad.is_empty() {
        return Err("The file of the group has a line that cannot be used".to_string());
    }
    let entry = file.entries.into_iter().find(|e| e.id == note_id);
    let resolved = resolve_note(&access.keys, entry.as_ref(), false);
    Ok(Ctx {
        access,
        entry,
        resolved,
    })
}

impl Ctx {
    fn property(&self, name: &str) -> Option<&super::ActiveProperty> {
        self.resolved
            .active
            .iter()
            .find(|p| same_name(&p.name, name))
    }

    fn record_name(&self, name: &str) -> Option<String> {
        self.entry
            .as_ref()?
            .props
            .keys()
            .find(|key| same_name(key, name))
            .cloned()
    }

    /// Every name of the note: keys of the header and records (З47).
    fn names(&self) -> BTreeSet<String> {
        self.access
            .keys
            .iter()
            .map(|k| k.key.clone())
            .chain(self.entry.iter().flat_map(|e| e.props.keys().cloned()))
            .map(|name| amby_sync_core::engine::props_groups::name_key(&name))
            .collect()
    }
}

/// Drops from `order` and `dismissedRenames` what points at nothing (З44, З47). Called only by
/// real writes.
fn prune(entry: &mut NoteEntry, names: &BTreeSet<String>) {
    let alive = |name: &str| names.contains(&amby_sync_core::engine::props_groups::name_key(name));
    entry.order.retain(|name| alive(name));
    entry
        .dismissed_renames
        .retain(|[old, new]| alive(old) && alive(new));
}

fn write_note(vault: &Path, path: &Path, content: &str, reason: &str) -> Result<(), String> {
    let bytes = frontmatter::text_bytes_for_write(path, content)?;
    let _ = crate::history::snapshot_before_write(vault, path, &bytes, reason);
    frontmatter::atomic_write_bytes(path, &bytes)
}

/// The journal folder, local, not synchronised (З28).
pub fn ops_dir(vault: &Path) -> PathBuf {
    vault.join(".amby").join("property-ops")
}

/// Writes the journal of an operation before its first write (З28).
fn begin_op(vault: &Path, body: Value) -> Result<PathBuf, String> {
    let path = ops_dir(vault).join(format!("{}.json", Ulid::generate()));
    let mut bytes = serde_json::to_vec_pretty(&body).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    frontmatter::atomic_write_bytes_new(&path, &bytes)
        .map_err(|error| format!("Failed to write the journal: {error:?}"))?;
    Ok(path)
}

fn end_op(path: &Path) {
    let _ = fs::remove_file(path);
}

fn refresh(conn: &Connection, vault: &Path, note_id: &str) {
    let _ = refresh_cache(conn, vault, note_id);
}

/// Sets the differences of a property from a look, or removes the property when nothing differs.
fn store_look(entry: &mut NoteEntry, name: &str, look: &Look) {
    let key = entry
        .props
        .keys()
        .find(|k| same_name(k, name))
        .cloned()
        .unwrap_or_else(|| name.to_string());
    let mut diff = entry.props.remove(&key).unwrap_or_default();
    set_look(&mut diff, &key, look);
    entry.props.insert(key, diff);
}

/// Moves the record of a property to another name; the look it had is kept as differences from
/// the template of the new name (З55).
fn move_prop(
    entry: &mut NoteEntry,
    from: &str,
    look_before: &Look,
    to: &str,
    previous_name: Option<String>,
) {
    let key = entry
        .props
        .keys()
        .find(|k| same_name(k, from))
        .cloned()
        .unwrap_or_else(|| from.to_string());
    let mut diff = entry.props.remove(&key).unwrap_or_default();
    set_look(&mut diff, to, look_before);
    diff.previous_name = previous_name;
    entry.props.insert(to.to_string(), diff);
    for name in &mut entry.order {
        if same_name(name, from) {
            *name = to.to_string();
        }
    }
    for [old, new] in &mut entry.dismissed_renames {
        if same_name(new, from) {
            *new = to.to_string();
        }
        if same_name(old, from) {
            *old = to.to_string();
        }
    }
}

// ----- creation (З28) -----

/// A new property: the key goes into the header first, then the record, if any (З28). Returns
/// the name it was given (trimmed).
pub fn create_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    design: Design,
    value: &str,
) -> Result<String, String> {
    let name = design.name.trim().to_string();
    check_name(&name)?;
    let ctx = prepare(conn, vault, note_id)?;
    if ctx
        .entry
        .as_ref()
        .is_some_and(|e| e.props.keys().any(|k| same_name(k, &name)))
    {
        return Err(format!("A property named {name} exists already"));
    }
    let key = match resolve(&ctx.access.keys, &name, None) {
        KeyMatch::Found { key, complex, .. } => {
            if complex {
                return Err("The value of this key cannot be rewritten without loss".to_string());
            }
            key
        }
        KeyMatch::Ambiguous { .. } => return Err("Several keys match this name".to_string()),
        _ => name.clone(),
    };
    let journal = begin_op(
        vault,
        json!({"version": 1, "op": "create", "noteId": note_id, "name": name}),
    )?;
    let updated = frontmatter::upsert_frontmatter_property(
        &ctx.access.text,
        note_id,
        &key,
        value,
        &design.property_type,
    )?;
    if updated != ctx.access.text {
        write_note(vault, &ctx.access.path, &updated, "property-create")?;
    }
    let look = Look {
        property_type: design.property_type.clone(),
        icon: design.icon.clone(),
        settings: design.settings.clone(),
        from_template: false,
    };
    let mut names = ctx.names();
    names.insert(amby_sync_core::engine::props_groups::name_key(&name));
    update_entry(conn, vault, note_id, |old| {
        let mut entry = old.unwrap_or_default();
        store_look(&mut entry, &name, &look);
        if !entry.order.is_empty() {
            entry.order.push(name.clone());
        }
        prune(&mut entry, &names);
        Ok(Some(entry))
    })?;
    end_op(&journal);
    refresh(conn, vault, note_id);
    Ok(name)
}

// ----- value (З1, З24, З26) -----

/// Writes the value into the found spelling of the key (З1, З24, З26).
pub fn set_value(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    value: &str,
) -> Result<(), String> {
    require_groups(vault)?;
    let access = open_note(conn, vault, note_id)?;
    let (entry, state) = super::panel::group_state(vault, note_id)?;
    if state.own_line_bad || state.format_newer {
        return Err("The properties of this note are read only".to_string());
    }
    let resolved = resolve_note(&access.keys, entry.as_ref(), false);
    let property = resolved
        .active
        .iter()
        .find(|p| same_name(&p.name, name))
        .ok_or_else(|| format!("No such property: {name}"))?;
    if property.read_only {
        return Err("This value cannot be rewritten without loss".to_string());
    }
    let updated = frontmatter::upsert_frontmatter_property(
        &access.text,
        note_id,
        &property.key,
        value,
        &property.property_type,
    )?;
    if updated != access.text {
        write_note(vault, &access.path, &updated, "property-upsert")?;
    }
    refresh(conn, vault, note_id);
    Ok(())
}

/// Writes a list as the value of a multi-select: the items as they are, one YAML item each, never
/// glued with commas (З62).
pub fn set_list_value(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    items: &[String],
) -> Result<(), String> {
    require_groups(vault)?;
    let access = open_note(conn, vault, note_id)?;
    let (entry, state) = super::panel::group_state(vault, note_id)?;
    if state.own_line_bad || state.format_newer {
        return Err("The properties of this note are read only".to_string());
    }
    let resolved = resolve_note(&access.keys, entry.as_ref(), false);
    let property = resolved
        .active
        .iter()
        .find(|p| same_name(&p.name, name))
        .ok_or_else(|| format!("No such property: {name}"))?;
    if property.read_only {
        return Err("This value cannot be rewritten without loss".to_string());
    }
    let updated =
        frontmatter::upsert_frontmatter_list(&access.text, note_id, &property.key, items)?;
    if updated != access.text {
        write_note(vault, &access.path, &updated, "property-upsert")?;
    }
    refresh(conn, vault, note_id);
    Ok(())
}

/// Changes the type: the record first, then the value when it is rewritten and the conversion is
/// reversible (З26, З28).
pub fn change_type(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    property_type: &str,
) -> Result<(), String> {
    let ctx = prepare(conn, vault, note_id)?;
    let property = ctx.property(name).cloned();
    let record = ctx.record_name(name);
    let (name, mut look) = match (&property, &record) {
        (Some(p), _) => (
            p.name.clone(),
            look_of(
                &p.name,
                ctx.entry.as_ref().and_then(|e| e.props.get(&p.name)),
            ),
        ),
        (None, Some(record)) => (
            record.clone(),
            look_of(record, ctx.entry.as_ref().and_then(|e| e.props.get(record))),
        ),
        _ => return Err(format!("No such property: {name}")),
    };
    look.property_type = property_type.to_string();
    let journal = begin_op(
        vault,
        json!({"version": 1, "op": "type", "noteId": note_id, "name": name}),
    )?;
    let names = ctx.names();
    update_entry(conn, vault, note_id, |old| {
        let mut entry = old.unwrap_or_default();
        store_look(&mut entry, &name, &look);
        prune(&mut entry, &names);
        Ok(Some(entry))
    })?;
    if let Some(p) = property.filter(|p| !p.read_only) {
        let converted = frontmatter::property_value_to_yaml_value(&p.value, property_type);
        let reversible = frontmatter::value_as_text(&converted).trim() == p.value.trim();
        if reversible {
            let updated = frontmatter::upsert_frontmatter_property(
                &ctx.access.text,
                note_id,
                &p.key,
                &p.value,
                property_type,
            )?;
            if updated != ctx.access.text {
                write_note(vault, &ctx.access.path, &updated, "property-upsert")?;
            }
        }
    }
    end_op(&journal);
    refresh(conn, vault, note_id);
    Ok(())
}

// ----- look only (З9, З47) -----

/// Only the look: icon and settings. One line of one file, the note is not touched (З9, З47).
pub fn set_appearance(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    icon: &str,
    settings: &str,
) -> Result<(), String> {
    set_appearance_fields(conn, vault, note_id, name, Some(icon), Some(settings))
}

/// The look field by field: a field that is `None` is not touched (З60). A change of the icon
/// never carries options it has not seen, and a change of the options never carries an icon.
pub fn set_appearance_fields(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    icon: Option<&str>,
    settings: Option<&str>,
) -> Result<(), String> {
    let ctx = prepare(conn, vault, note_id)?;
    let (name, mut look) = match (ctx.property(name), ctx.record_name(name)) {
        (Some(p), _) => (
            p.name.clone(),
            look_of(
                &p.name,
                ctx.entry.as_ref().and_then(|e| e.props.get(&p.name)),
            ),
        ),
        (None, Some(record)) => (
            record.clone(),
            look_of(
                &record,
                ctx.entry.as_ref().and_then(|e| e.props.get(&record)),
            ),
        ),
        _ => return Err(format!("No such property: {name}")),
    };
    if let Some(icon) = icon {
        look.icon = icon.to_string();
    }
    if let Some(settings) = settings {
        look.settings = settings.to_string();
    }
    let names = ctx.names();
    update_entry(conn, vault, note_id, |old| {
        let mut entry = old.clone().unwrap_or_default();
        store_look(&mut entry, &name, &look);
        if Some(&entry.props) == old.as_ref().map(|e| &e.props) {
            return Ok(old);
        }
        prune(&mut entry, &names);
        Ok(Some(entry))
    })?;
    refresh(conn, vault, note_id);
    Ok(())
}

/// The order of the panel: names. Written to `order` only when it differs from the order of the
/// header (З47).
pub fn reorder(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    names: &[String],
) -> Result<(), String> {
    let ctx = prepare(conn, vault, note_id)?;
    let header_order: Vec<String> = {
        let plain = resolve_note(
            &ctx.access.keys,
            ctx.entry
                .as_ref()
                .map(|e| NoteEntry {
                    order: Vec::new(),
                    ..e.clone()
                })
                .as_ref(),
            false,
        );
        plain.active.iter().map(|p| p.name.clone()).collect()
    };
    let wanted: Vec<String> = names
        .iter()
        .filter(|name| {
            header_order.iter().any(|h| same_name(h, name))
                || ctx
                    .entry
                    .as_ref()
                    .is_some_and(|e| e.props.keys().any(|k| same_name(k, name)))
        })
        .cloned()
        .collect();
    let effective: Vec<String> = wanted
        .iter()
        .filter_map(|n| header_order.iter().find(|h| same_name(h, n)).cloned())
        .chain(
            header_order
                .iter()
                .filter(|h| !wanted.iter().any(|n| same_name(n, h)))
                .cloned(),
        )
        .collect();
    let needs_order = effective != header_order;
    let all = ctx.names();
    update_entry(conn, vault, note_id, |old| {
        let mut entry = old.unwrap_or_default();
        let before = entry.order.clone();
        entry.order = if needs_order {
            wanted.clone()
        } else {
            Vec::new()
        };
        if entry.order == before {
            return Ok(Some(entry));
        }
        prune(&mut entry, &all);
        Ok(Some(entry))
    })?;
    refresh(conn, vault, note_id);
    Ok(())
}

// ----- deletion (З28) -----

/// Deletes a property: the key goes from the header first, then the record (З28).
pub fn delete_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
) -> Result<(), String> {
    let ctx = prepare(conn, vault, note_id)?;
    let property = ctx.property(name).cloned();
    let record = ctx.record_name(name);
    if property.is_none() && record.is_none() {
        return Err(format!("No such property: {name}"));
    }
    if let Some(p) = &property {
        if p.read_only {
            return Err("This key cannot be removed without loss".to_string());
        }
    }
    let journal = begin_op(
        vault,
        json!({"version": 1, "op": "delete", "noteId": note_id, "name": name}),
    )?;
    if let Some(p) = &property {
        let updated = frontmatter::remove_frontmatter_property(&ctx.access.text, &p.key)?;
        if updated != ctx.access.text {
            write_note(vault, &ctx.access.path, &updated, "property-delete")?;
        }
    }
    if let Some(record) = record {
        let mut names = ctx.names();
        names.remove(&amby_sync_core::engine::props_groups::name_key(&record));
        update_entry(conn, vault, note_id, |old| {
            let mut entry = old.unwrap_or_default();
            entry.props.remove(&record);
            entry.order.retain(|o| !same_name(o, &record));
            prune(&mut entry, &names);
            Ok(Some(entry))
        })?;
    }
    end_op(&journal);
    refresh(conn, vault, note_id);
    Ok(())
}

// ----- rename (З9, З28, З55) -----

/// Renames a property: the record with `previousName`, the header, then `previousName` removed.
/// A property with no record and not from the template changes only the key of the header, the
/// line is written for the time of the operation only (З9, З28, З55).
pub fn rename_property(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
    new_name: &str,
) -> Result<(), String> {
    let new_name = new_name.trim().to_string();
    check_name(&new_name)?;
    let ctx = prepare(conn, vault, note_id)?;
    let property = ctx
        .property(name)
        .cloned()
        .ok_or_else(|| format!("No such property: {name}"))?;
    if property.read_only {
        return Err("This property cannot be renamed without loss".to_string());
    }
    let others = ctx
        .resolved
        .active
        .iter()
        .filter(|p| p.name != property.name)
        .any(|p| same_name(&p.name, &new_name))
        || ctx
            .access
            .keys
            .iter()
            .any(|k| k.key != property.key && same_name(&k.key, &new_name))
        || ctx.entry.as_ref().is_some_and(|e| {
            e.props
                .keys()
                .any(|k| k != &property.name && same_name(k, &new_name))
        });
    if others {
        return Err(format!("A property named {new_name} exists already"));
    }
    let look_before = look_of(
        &property.name,
        ctx.entry.as_ref().and_then(|e| e.props.get(&property.name)),
    );
    let mut names = ctx.names();
    names.remove(&amby_sync_core::engine::props_groups::name_key(
        &property.name,
    ));
    names.insert(amby_sync_core::engine::props_groups::name_key(&new_name));
    let journal = begin_op(
        vault,
        json!({
            "version": 1, "op": "rename", "noteId": note_id,
            "name": property.name, "newName": new_name,
            "headerHash": super::files::blake3_hex(ctx.access.text.as_bytes()),
        }),
    )?;
    // 1. the record with `previousName`
    let old_name = property.name.clone();
    update_entry(conn, vault, note_id, |old| {
        let mut entry = old.unwrap_or_default();
        move_prop(
            &mut entry,
            &old_name,
            &look_before,
            &new_name,
            Some(old_name.clone()),
        );
        prune(&mut entry, &names);
        Ok(Some(entry))
    })?;
    // 2. the key of the header
    let updated =
        frontmatter::rename_yaml_key_lossless(&ctx.access.text, &property.key, &new_name)?;
    write_note(vault, &ctx.access.path, &updated, "property-rename")?;
    // 3. `previousName` is not needed any more
    update_entry(conn, vault, note_id, |old| {
        let mut entry = old.unwrap_or_default();
        if let Some(diff) = entry.props.get_mut(&new_name) {
            diff.previous_name = None;
        }
        Ok(Some(entry))
    })?;
    end_op(&journal);
    refresh(conn, vault, note_id);
    Ok(())
}

// ----- sleeping records (З3, З3а, З34) -----

fn dormant_record(ctx: &Ctx, name: &str) -> Result<String, String> {
    ctx.resolved
        .dormant
        .iter()
        .find(|d| same_name(&d.name, name))
        .map(|d| d.name.clone())
        .ok_or_else(|| format!("No sleeping property: {name}"))
}

/// «Вернуть»: the key is added to the header with an empty value (З3).
pub fn restore_dormant(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
) -> Result<(), String> {
    let ctx = prepare(conn, vault, note_id)?;
    let name = dormant_record(&ctx, name)?;
    let look = look_of(&name, ctx.entry.as_ref().and_then(|e| e.props.get(&name)));
    let updated = frontmatter::upsert_frontmatter_property(
        &ctx.access.text,
        note_id,
        &name,
        "",
        &look.property_type,
    )?;
    write_note(vault, &ctx.access.path, &updated, "property-upsert")?;
    refresh(conn, vault, note_id);
    Ok(())
}

/// «Удалить окончательно»: a copy in `property-backups/<note-id>/<ULID>.json` first, then the
/// record of the property leaves the line (З3, З34).
pub fn purge_dormant(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    name: &str,
) -> Result<(), String> {
    let ctx = prepare(conn, vault, note_id)?;
    let name = dormant_record(&ctx, name)?;
    if let Some(entry) = &ctx.entry {
        super::identity::write_backup(vault, note_id, entry, "purged")?;
    }
    let mut names = ctx.names();
    names.remove(&amby_sync_core::engine::props_groups::name_key(&name));
    update_entry(conn, vault, note_id, |old| {
        let mut entry = old.unwrap_or_default();
        entry.props.remove(&name);
        entry.order.retain(|o| !same_name(o, &name));
        prune(&mut entry, &names);
        Ok(Some(entry))
    })?;
    refresh(conn, vault, note_id);
    Ok(())
}

/// «Перенести»: the record is renamed in the line; the header is not touched (З3а).
pub fn accept_rename_hint(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    hint: &RenameHint,
) -> Result<(), String> {
    let ctx = prepare(conn, vault, note_id)?;
    let old = dormant_record(&ctx, &hint.old_name)?;
    let fresh = ctx
        .resolved
        .active
        .iter()
        .find(|p| same_name(&p.name, &hint.new_name) && !p.has_record)
        .cloned()
        .ok_or_else(|| format!("No such key: {}", hint.new_name))?;
    let look = look_of(&old, ctx.entry.as_ref().and_then(|e| e.props.get(&old)));
    let mut names = ctx.names();
    names.remove(&amby_sync_core::engine::props_groups::name_key(&old));
    update_entry(conn, vault, note_id, |entry| {
        let mut entry = entry.unwrap_or_default();
        move_prop(&mut entry, &old, &look, &fresh.name, None);
        prune(&mut entry, &names);
        Ok(Some(entry))
    })?;
    refresh(conn, vault, note_id);
    Ok(())
}

/// «Нет»: the pair goes to `dismissedRenames` of the record (З3а, З44).
pub fn dismiss_rename_hint(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    hint: &RenameHint,
) -> Result<(), String> {
    let ctx = prepare(conn, vault, note_id)?;
    let pair = [hint.old_name.clone(), hint.new_name.clone()];
    update_entry(conn, vault, note_id, |entry| {
        let mut entry = entry.unwrap_or_default();
        if !entry
            .dismissed_renames
            .iter()
            .any(|[a, b]| same_name(a, &pair[0]) && same_name(b, &pair[1]))
        {
            entry.dismissed_renames.push(pair.clone());
            entry.dismissed_renames.sort();
        }
        Ok(Some(entry))
    })?;
    let _ = ctx;
    refresh(conn, vault, note_id);
    Ok(())
}

// ----- finishing what this device began (З29) -----

/// At the opening of a vault: finishes what **this device** began, by its own journal
/// `.amby/property-ops/` (З28, З29). Never walks the files; a line that came by sync with a
/// `previousName` is only read.
pub fn recover_operations(conn: &Connection, vault: &Path) -> Result<RecoverReport, String> {
    let mut report = RecoverReport::default();
    let Ok(listing) = fs::read_dir(ops_dir(vault)) else {
        return Ok(report);
    };
    let mut journals: Vec<PathBuf> = listing
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    journals.sort();
    for path in journals {
        let body: Option<Value> = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let Some(body) = body else {
            end_op(&path);
            continue;
        };
        if body["op"] == "rename" {
            if let (Some(note), Some(old), Some(new)) = (
                body["noteId"].as_str(),
                body["name"].as_str(),
                body["newName"].as_str(),
            ) {
                finish_rename(conn, vault, note, old, new, &mut report)?;
            }
        }
        end_op(&path);
    }
    Ok(report)
}

fn finish_rename(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    old: &str,
    new: &str,
    report: &mut RecoverReport,
) -> Result<(), String> {
    if storage_is_not_groups(vault) {
        return Ok(());
    }
    let Some(entry) = read_entry(vault, note_id)? else {
        return Ok(());
    };
    let pending = entry.props.iter().find(|(name, diff)| {
        same_name(name, new)
            && diff
                .previous_name
                .as_deref()
                .is_some_and(|p| same_name(p, old))
    });
    let Some((name, _)) = pending else {
        return Ok(());
    };
    let name = name.clone();
    let Ok(access) = open_note(conn, vault, note_id) else {
        report.left_for_inspection.push(note_id.to_string());
        return Ok(());
    };
    let has = |wanted: &str| matches!(resolve(&access.keys, wanted, None), KeyMatch::Found { .. });
    if has(&name) {
        update_entry(conn, vault, note_id, |entry| {
            let mut entry = entry.unwrap_or_default();
            if let Some(diff) = entry.props.get_mut(&name) {
                diff.previous_name = None;
            }
            Ok(Some(entry))
        })?;
        report.completed.push(note_id.to_string());
    } else if has(old) {
        update_entry(conn, vault, note_id, |entry| {
            let mut entry = entry.unwrap_or_default();
            let look = look_of(&name, entry.props.get(&name));
            move_prop(&mut entry, &name, &look, old, None);
            Ok(Some(entry))
        })?;
        report.rolled_back.push(note_id.to_string());
    } else {
        report.left_for_inspection.push(note_id.to_string());
    }
    refresh(conn, vault, note_id);
    Ok(())
}

fn storage_is_not_groups(vault: &Path) -> bool {
    !matches!(files::storage_mode(vault), Ok(super::StorageMode::Groups))
}
