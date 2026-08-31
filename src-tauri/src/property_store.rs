use crate::{frontmatter, model::CustomProperty};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::Path};
use ulid::Ulid;

const FORMAT_VERSION: u32 = 1;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PropertyFile {
    version: u32,
    notes: HashMap<String, Vec<CustomProperty>>,
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
    if let Some(existing) = properties.iter_mut().find(|item| item.id == property.id) {
        *existing = property.clone();
    } else {
        properties.push(property.clone());
    }
    let cache = properties.clone();
    write(vault, &file)?;
    replace_note_cache(conn, note_id, &cache)?;
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
    if let Some(properties) = file.notes.get_mut(note_id) {
        properties.retain(|property| property.id != property_id);
        if properties.is_empty() {
            file.notes.remove(note_id);
        }
    }
    write(vault, &file)?;
    conn.execute(
        "DELETE FROM note_custom_properties WHERE note_id = ?1 AND id = ?2",
        params![note_id, property_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
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
    fn malformed_sidecar_is_not_overwritten() {
        let (vault, conn) = fixture();
        let file_path = path(&vault);
        fs::write(&file_path, "not-json").unwrap();
        assert!(upsert(&conn, &vault, "01TEST", property()).is_err());
        assert_eq!(fs::read_to_string(file_path).unwrap(), "not-json");
        fs::remove_dir_all(vault).unwrap();
    }
}
