use crate::{frontmatter, model::CustomProperty};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use ulid::Ulid;

const FORMAT_VERSION: u32 = 1;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PropertyFile {
    version: u32,
    notes: HashMap<String, Vec<CustomProperty>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PropertyBackup<'a> {
    format: &'static str,
    format_version: u32,
    status: &'static str,
    note_id: &'a str,
    created_at_ms: u128,
    properties: &'a [CustomProperty],
}

fn path(vault: &Path) -> std::path::PathBuf {
    vault.join(".amby").join("properties.json")
}

fn read(vault: &Path) -> Result<PropertyFile, String> {
    let file_path = path(vault);
    if !file_path.exists() {
        return Ok(PropertyFile {
            version: FORMAT_VERSION,
            notes: HashMap::new(),
        });
    }
    let raw = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let file: PropertyFile = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if file.version != FORMAT_VERSION {
        return Err(format!(
            "Unsupported properties format version: {}",
            file.version
        ));
    }
    Ok(file)
}

fn write(vault: &Path, file: &PropertyFile) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(file).map_err(|error| error.to_string())? + "\n";
    frontmatter::atomic_write(&path(vault), &raw)
}

fn replace_note_cache(
    conn: &Connection,
    note_id: &str,
    properties: &[CustomProperty],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM note_custom_properties WHERE note_id = ?1",
        [note_id],
    )
    .map_err(|error| error.to_string())?;
    for (position, property) in properties.iter().enumerate() {
        conn.execute(
            r#"INSERT INTO note_custom_properties
               (id, note_id, name, icon, property_type, value, settings, position)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            params![
                property.id,
                note_id,
                property.name,
                property.icon,
                property.property_type,
                property.value,
                property.settings,
                position as i64,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn restore_cache(conn: &Connection, vault: &Path) -> Result<(), String> {
    let file = read(vault)?;
    conn.execute("DELETE FROM note_custom_properties", [])
        .map_err(|error| error.to_string())?;
    for (note_id, properties) in file.notes {
        replace_note_cache(conn, &note_id, &properties)?;
    }
    Ok(())
}

/// Syncs all properties stored in `.amby/properties.json` into their respective
/// markdown files' YAML frontmatter if missing.
#[allow(dead_code)]
pub fn sync_all_properties_to_markdown(conn: &Connection, vault: &Path) -> Result<usize, String> {
    let file = read(vault)?;
    let mut updated_count = 0;

    for (note_id, properties) in &file.notes {
        if properties.is_empty() {
            continue;
        }

        let note_rel_path: Option<String> = conn
            .query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|error| error.to_string())?;

        let Some(rel_path) = note_rel_path else {
            continue;
        };

        let note_path = vault.join(&rel_path);
        if !note_path.is_file() {
            continue;
        }

        let Ok(content) = fs::read_to_string(&note_path) else {
            continue;
        };

        let note_props = frontmatter::note_properties(&content);
        if note_props.frontmatter_status.is_malformed() {
            continue;
        }

        let existing_keys: std::collections::HashSet<String> = note_props
            .properties
            .into_iter()
            .map(|p| p.key.trim().to_ascii_lowercase())
            .collect();

        let mut current_content = content.clone();
        let mut modified = false;

        for prop in properties {
            if prop.name.trim().is_empty() {
                continue;
            }
            let key_lower = prop.name.trim().to_ascii_lowercase();
            if !existing_keys.contains(&key_lower) {
                if let Ok(updated) = frontmatter::upsert_frontmatter_property(
                    &current_content,
                    note_id,
                    &prop.name,
                    &prop.value,
                    &prop.property_type,
                ) {
                    current_content = updated;
                    modified = true;
                }
            }
        }

        if modified && current_content != content {
            if let Ok(bytes) = frontmatter::text_bytes_for_write(&note_path, &current_content) {
                let _ = crate::history::snapshot_before_write(
                    vault,
                    &note_path,
                    &bytes,
                    "property-frontmatter-sync",
                );
                let _ = frontmatter::atomic_write_bytes(&note_path, &bytes);
                updated_count += 1;
            }
        }
    }

    Ok(updated_count)
}

pub fn list(conn: &Connection, note_id: &str) -> Result<Vec<CustomProperty>, String> {
    let mut statement = conn
        .prepare(
            r#"SELECT id, name, icon, property_type, value, settings
               FROM note_custom_properties WHERE note_id = ?1 ORDER BY position, rowid"#,
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

pub fn upsert(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    mut property: CustomProperty,
) -> Result<CustomProperty, String> {
    crate::index::identity::ensure_unique_identity(conn, note_id)?;
    ensure_frontmatter_properties_available(conn, vault, note_id)?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE id = ?1)",
            [note_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Err(format!("Note not found: {note_id}"));
    }
    property.name = property.name.trim().to_string();
    if property.name.is_empty() {
        return Err("Property name cannot be empty".to_string());
    }
    if property.id.is_empty() {
        property.id = Ulid::generate().to_string();
    }
    let mut file = read(vault)?;
    let properties = file.notes.entry(note_id.to_string()).or_default();
    let mut old_name_to_remove: Option<String> = None;
    if let Some(existing) = properties.iter_mut().find(|item| {
        item.id == property.id
            || (!property.name.is_empty() && item.name.eq_ignore_ascii_case(&property.name))
    }) {
        if property.id.is_empty() {
            property.id = existing.id.clone();
        }
        if !existing.name.eq_ignore_ascii_case(&property.name) {
            old_name_to_remove = Some(existing.name.clone());
        }
        *existing = property.clone();
    } else {
        properties.push(property.clone());
    }
    let cache = properties.clone();
    write(vault, &file)?;
    replace_note_cache(conn, note_id, &cache)?;

    let note_rel_path: Option<String> = conn
        .query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;

    if let Some(rel_path) = note_rel_path {
        let note_path = vault.join(rel_path);
        if note_path.exists() {
            if let Ok(content) = fs::read_to_string(&note_path) {
                let content_after_old_removed = if let Some(old_name) = old_name_to_remove {
                    frontmatter::remove_frontmatter_property(&content, &old_name).unwrap_or(content)
                } else {
                    content
                };
                if let Ok(updated) = frontmatter::upsert_frontmatter_property(
                    &content_after_old_removed,
                    note_id,
                    &property.name,
                    &property.value,
                    &property.property_type,
                ) {
                    if let Ok(bytes) = frontmatter::text_bytes_for_write(&note_path, &updated) {
                        let _ = crate::history::snapshot_before_write(
                            vault,
                            &note_path,
                            &bytes,
                            "property-upsert",
                        );
                        let _ = frontmatter::atomic_write_bytes(&note_path, &bytes);
                    }
                }
            }
        }
    }

    Ok(property)
}

pub fn delete(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_id: &str,
) -> Result<(), String> {
    crate::index::identity::ensure_unique_identity(conn, note_id)?;
    ensure_frontmatter_properties_available(conn, vault, note_id)?;
    let mut file = read(vault)?;
    let property_name = file
        .notes
        .get(note_id)
        .and_then(|props| {
            props
                .iter()
                .find(|p| p.id == property_id || p.name.eq_ignore_ascii_case(property_id))
        })
        .map(|p| p.name.clone())
        .unwrap_or_else(|| property_id.to_string());
    if let Some(properties) = file.notes.get_mut(note_id) {
        properties.retain(|property| {
            property.id != property_id && !property.name.eq_ignore_ascii_case(property_id)
        });
        if properties.is_empty() {
            file.notes.remove(note_id);
        }
    }
    write(vault, &file)?;
    conn.execute(
        "DELETE FROM note_custom_properties WHERE note_id = ?1 AND (id = ?2 OR name = ?2)",
        params![note_id, property_id],
    )
    .map_err(|error| error.to_string())?;

    let note_rel_path: Option<String> = conn
        .query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;

    if let Some(rel_path) = note_rel_path {
        let note_path = vault.join(rel_path);
        if note_path.exists() {
            if let Ok(content) = fs::read_to_string(&note_path) {
                if let Ok(updated) =
                    frontmatter::remove_frontmatter_property(&content, &property_name)
                {
                    if let Ok(bytes) = frontmatter::text_bytes_for_write(&note_path, &updated) {
                        let _ = crate::history::snapshot_before_write(
                            vault,
                            &note_path,
                            &bytes,
                            "property-delete",
                        );
                        let _ = frontmatter::atomic_write_bytes(&note_path, &bytes);
                    }
                }
            }
        }
    }

    Ok(())
}

pub fn reorder(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    property_ids: &[String],
) -> Result<(), String> {
    crate::index::identity::ensure_unique_identity(conn, note_id)?;
    ensure_frontmatter_properties_available(conn, vault, note_id)?;
    let mut file = read(vault)?;
    let properties = file.notes.get(note_id).cloned().unwrap_or_default();
    if properties.len() != property_ids.len() {
        return Err("Property order must include every property exactly once".to_owned());
    }
    let mut by_id = properties
        .into_iter()
        .map(|property| (property.id.clone(), property))
        .collect::<HashMap<_, _>>();
    let mut reordered = Vec::with_capacity(property_ids.len());
    for property_id in property_ids {
        let property = by_id
            .remove(property_id)
            .ok_or_else(|| "Property order contains an unknown or duplicate ID".to_owned())?;
        reordered.push(property);
    }
    if !by_id.is_empty() {
        return Err("Property order does not include every property".to_owned());
    }
    file.notes.insert(note_id.to_owned(), reordered.clone());
    write(vault, &file)?;
    replace_note_cache(conn, note_id, &reordered)
}

pub fn backup_and_clear(conn: &Connection, vault: &Path, note_id: &str) -> Result<String, String> {
    crate::index::identity::ensure_unique_identity(conn, note_id)?;
    ensure_frontmatter_properties_available(conn, vault, note_id)?;
    let mut file = read(vault)?;
    let properties = file.notes.get(note_id).cloned().unwrap_or_default();
    if properties.is_empty() {
        return Err("Note has no custom properties to back up".to_owned());
    }

    let backup_dir = vault.join(".amby").join("property-backups").join(note_id);
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    let backup_path = backup_dir.join(format!("{}.json", Ulid::generate()));
    let backup = PropertyBackup {
        format: "amby-note-property-backup",
        format_version: 1,
        status: "backedUp",
        note_id,
        created_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis(),
        properties: &properties,
    };
    let mut bytes = serde_json::to_vec_pretty(&backup).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    frontmatter::atomic_write_bytes_new(&backup_path, &bytes)
        .map_err(|error| format!("Failed to create property backup: {error:?}"))?;

    file.notes.remove(note_id);
    if let Err(error) = write(vault, &file) {
        return Err(format!(
            "Property backup was created at {}, but active properties could not be cleared: {error}",
            backup_path.display()
        ));
    }
    replace_note_cache(conn, note_id, &[])?;
    backup_path
        .strip_prefix(vault)
        .unwrap_or(&backup_path)
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Property backup path is not valid UTF-8".to_owned())
}

fn ensure_frontmatter_properties_available(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let path: Option<String> = conn
        .query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(path) = path {
        if crate::frontmatter::read_markdown(&vault.join(path))?
            .frontmatter_status
            .is_malformed()
        {
            return Err("Properties are unavailable while frontmatter is malformed".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (std::path::PathBuf, Connection) {
        let unique = Ulid::generate();
        let vault = std::env::temp_dir().join(format!("amby-properties-{unique}"));
        fs::create_dir_all(vault.join(".amby")).unwrap();
        fs::write(vault.join("Note.md"), "# Note").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL);
            CREATE TABLE note_custom_properties (
                id TEXT NOT NULL, note_id TEXT NOT NULL, name TEXT NOT NULL,
                icon TEXT NOT NULL, property_type TEXT NOT NULL, value TEXT NOT NULL,
                settings TEXT NOT NULL, position INTEGER NOT NULL,
                PRIMARY KEY (note_id, id)
            );
            INSERT INTO notes (id, path) VALUES ('01TEST', 'Note.md');
            "#,
        )
        .unwrap();
        (vault, conn)
    }

    fn property() -> CustomProperty {
        CustomProperty {
            id: String::new(),
            name: "Status".to_string(),
            icon: "📌".to_string(),
            property_type: "select".to_string(),
            value: "Done".to_string(),
            settings: "Idea,Done".to_string(),
        }
    }

    #[test]
    fn persists_sidecar_and_restores_sqlite_cache() {
        let (vault, conn) = fixture();
        let saved = upsert(&conn, &vault, "01TEST", property()).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(list(&conn, "01TEST").unwrap(), vec![saved.clone()]);

        conn.execute("DELETE FROM note_custom_properties", [])
            .unwrap();
        restore_cache(&conn, &vault).unwrap();
        assert_eq!(list(&conn, "01TEST").unwrap(), vec![saved]);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn updates_by_property_id_without_duplicating() {
        let (vault, conn) = fixture();
        let mut saved = upsert(&conn, &vault, "01TEST", property()).unwrap();
        saved.value = "Idea".to_string();
        upsert(&conn, &vault, "01TEST", saved.clone()).unwrap();
        assert_eq!(list(&conn, "01TEST").unwrap(), vec![saved]);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn backup_is_published_before_active_properties_are_cleared() {
        let (vault, conn) = fixture();
        let saved = upsert(&conn, &vault, "01TEST", property()).unwrap();

        let relative_backup = backup_and_clear(&conn, &vault, "01TEST").unwrap();
        let backup_path = vault.join(relative_backup);
        let backup: serde_json::Value =
            serde_json::from_slice(&fs::read(&backup_path).unwrap()).unwrap();

        assert_eq!(backup["format"], "amby-note-property-backup");
        assert_eq!(backup["formatVersion"], 1);
        assert_eq!(backup["status"], "backedUp");
        assert_eq!(backup["noteId"], "01TEST");
        assert_eq!(backup["properties"][0]["id"], saved.id);
        assert!(list(&conn, "01TEST").unwrap().is_empty());
        assert!(!read(&vault).unwrap().notes.contains_key("01TEST"));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn reorder_requires_the_exact_property_set_and_persists_order() {
        let (vault, conn) = fixture();
        let first = upsert(&conn, &vault, "01TEST", property()).unwrap();
        let mut second_property = property();
        second_property.name = "Owner".to_owned();
        let second = upsert(&conn, &vault, "01TEST", second_property).unwrap();

        reorder(
            &conn,
            &vault,
            "01TEST",
            &[second.id.clone(), first.id.clone()],
        )
        .unwrap();
        assert_eq!(
            list(&conn, "01TEST").unwrap(),
            vec![second.clone(), first.clone()]
        );
        assert!(reorder(&conn, &vault, "01TEST", &[first.id.clone()]).is_err());
        assert_eq!(list(&conn, "01TEST").unwrap(), vec![second, first]);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn malformed_sidecar_is_not_overwritten() {
        let (vault, conn) = fixture();
        let file_path = path(&vault);
        fs::write(&file_path, "not-json").unwrap();
        assert!(upsert(&conn, &vault, "01TEST", property()).is_err());
        assert_eq!(fs::read_to_string(file_path).unwrap(), "not-json");
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn upsert_and_delete_synchronizes_markdown_frontmatter() {
        let (vault, conn) = fixture();
        let prop = property();
        let saved = upsert(&conn, &vault, "01TEST", prop).unwrap();

        let note_content = fs::read_to_string(vault.join("Note.md")).unwrap();
        assert!(note_content.contains("amby-id: 01TEST"));
        assert!(note_content.contains("Status: Done"));
        assert!(note_content.ends_with("# Note"));

        delete(&conn, &vault, "01TEST", &saved.id).unwrap();
        let after_delete = fs::read_to_string(vault.join("Note.md")).unwrap();
        assert!(!after_delete.contains("Status:"));
        assert!(after_delete.contains("amby-id: 01TEST"));
        assert!(after_delete.ends_with("# Note"));

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn rename_synchronizes_markdown_frontmatter() {
        let (vault, conn) = fixture();
        let prop = property();
        let mut saved = upsert(&conn, &vault, "01TEST", prop).unwrap();

        let note_content = fs::read_to_string(vault.join("Note.md")).unwrap();
        assert!(note_content.contains("Status: Done"));

        saved.name = "Priority".to_string();
        upsert(&conn, &vault, "01TEST", saved).unwrap();

        let after_rename = fs::read_to_string(vault.join("Note.md")).unwrap();
        assert!(!after_rename.contains("Status:"));
        assert!(after_rename.contains("Priority: Done"));
        assert!(after_rename.contains("amby-id: 01TEST"));
        assert!(after_rename.ends_with("# Note"));

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn sync_all_properties_to_markdown_writes_missing_properties() {
        let (vault, conn) = fixture();
        let prop = property();
        let mut file = PropertyFile {
            version: FORMAT_VERSION,
            notes: HashMap::new(),
        };
        file.notes.insert("01TEST".to_string(), vec![prop]);
        write(&vault, &file).unwrap();

        assert_eq!(fs::read_to_string(vault.join("Note.md")).unwrap(), "# Note");

        let updated = sync_all_properties_to_markdown(&conn, &vault).unwrap();
        assert_eq!(updated, 1);

        let note_content = fs::read_to_string(vault.join("Note.md")).unwrap();
        assert!(note_content.contains("amby-id: 01TEST"));
        assert!(note_content.contains("Status: Done"));
        assert!(note_content.ends_with("# Note"));

        let updated_again = sync_all_properties_to_markdown(&conn, &vault).unwrap();
        assert_eq!(updated_again, 0);

        fs::remove_dir_all(vault).unwrap();
    }
}
