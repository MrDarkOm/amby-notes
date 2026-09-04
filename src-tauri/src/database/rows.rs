//! Structural row operations. A database row remains an ordinary Markdown
//! note; the record shard is only an additional, rebuildable value source.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::discovery::discover_vault;
use super::format::{parse_manifest, parse_template, raw_revision, MAX_JSON_BYTES};
use crate::frontmatter::{self, AtomicCreateError};
use crate::watcher::{self, WatcherState};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseRowRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDatabaseRow {
    pub database_id: String,
    pub note_id: String,
    pub title: String,
    pub note_path: String,
    pub record_path: String,
    pub record_revision: String,
}

pub fn create_database_row(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabaseRowRequest,
) -> Result<CreatedDatabaseRow, String> {
    let title = request.title.trim();
    if title.is_empty()
        || title.contains('/')
        || title.contains('\\')
        || title == "."
        || title == ".."
    {
        return Err("Invalid row title".to_owned());
    }
    let database = discover_vault(vault)?
        .databases
        .into_iter()
        .find(|database| database.database_id == request.database_id)
        .ok_or_else(|| "Database was not found".to_owned())?;
    if database.read_only {
        return Err("Database is read-only".to_owned());
    }
    let notes = discover_vault(vault)?.notes;
    let normalized = normalize_title(title);
    if notes.iter().any(|note| {
        note.owner_database_id.as_deref() == Some(request.database_id.as_str())
            && normalize_title(&note.title) == normalized
    }) {
        return Err("A row with this normalized title already exists".to_owned());
    }
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = database.container_path.join(format!("{title}.md"));
    let record_path = database
        .container_path
        .join(".ambd/records")
        .join(format!("{note_id}.json"));
    if note_path.exists() || record_path.exists() {
        return Err("A row with this title or ID already exists".to_owned());
    }
    let (template_body, template_values) = load_default_template(&database, &request.database_id);
    let note_bytes = format!("---\namby-id: {note_id}\n---\n{template_body}").into_bytes();
    let record_bytes = json_bytes(&json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": request.database_id.clone(),
        "noteId": note_id.clone(),
        "values": template_values
    }))?;
    let prepared = watcher.prepare_write([
        (&note_path, watcher::fingerprint_for_bytes(&note_bytes)),
        (&record_path, watcher::fingerprint_for_bytes(&record_bytes)),
    ]);
    fs::create_dir_all(record_path.parent().ok_or("Record has no parent")?)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        write_new(&note_path, &note_bytes)?;
        if let Err(error) = write_new(&record_path, &record_bytes) {
            let _ = fs::remove_file(&note_path);
            return Err(error);
        }
        Ok(())
    })();
    if let Err(error) = result {
        watcher.cancel_prepared_write(&prepared);
        let _ = fs::remove_file(&note_path);
        let _ = fs::remove_file(&record_path);
        return Err(error);
    }
    watcher.confirm_prepared_write(&prepared);
    Ok(CreatedDatabaseRow {
        database_id: request.database_id.clone(),
        note_id,
        title: title.to_owned(),
        note_path: note_path.to_string_lossy().to_string(),
        record_path: record_path.to_string_lossy().to_string(),
        record_revision: raw_revision(&record_bytes),
    })
}

fn load_default_template(
    database: &super::discovery::DiscoveredDatabase,
    database_id: &str,
) -> (String, serde_json::Value) {
    let Ok(manifest_bytes) = fs::read(&database.manifest_path) else {
        return (String::new(), json!({}));
    };
    let Ok(manifest) = parse_manifest(&manifest_bytes) else {
        return (String::new(), json!({}));
    };
    let Some(template_id) = manifest.value.default_template_id else {
        return (String::new(), json!({}));
    };
    let path = database
        .container_path
        .join(".ambd/templates")
        .join(format!("{template_id}.json"));
    let Ok(bytes) = fs::read(path) else {
        return (String::new(), json!({}));
    };
    let Ok(template) = parse_template(&bytes) else {
        return (String::new(), json!({}));
    };
    if template.value.database_id != database_id || template.value.template_id != template_id {
        return (String::new(), json!({}));
    }
    let values = serde_json::to_value(template.value.values).unwrap_or_else(|_| json!({}));
    (template.value.body, values)
}

fn normalize_title(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn json_bytes(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_JSON_BYTES {
        return Err("Generated record JSON is too large".to_owned());
    }
    Ok(bytes)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match frontmatter::atomic_write_bytes_new(path, bytes) {
        Ok(()) => Ok(()),
        Err(AtomicCreateError::AlreadyExists) => {
            Err(format!("File already exists: {}", path.display()))
        }
        Err(AtomicCreateError::Other(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::mutations::{create_database, CreateDatabaseRequest, DatabaseCreateMode};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("amby-db-row-{stamp}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn creates_real_markdown_row_and_record_with_stable_id() {
        let vault = temp_vault();
        let database = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let row = create_database_row(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id,
                title: "First project".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(row.note_id.len(), 26);
        assert!(Path::new(&row.note_path).is_file());
        assert!(Path::new(&row.record_path).is_file());
        assert!(String::from_utf8(fs::read(&row.note_path).unwrap())
            .unwrap()
            .contains(&row.note_id));
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn applies_the_default_template_once_when_creating_a_row() {
        let vault = temp_vault();
        let database = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let container = vault.join("Projects");
        let property_id = ulid::Ulid::generate().to_string();
        let template_id = ulid::Ulid::generate().to_string();
        let manifest_path = container.join("ambd.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["templateOrder"] = json!([template_id.clone()]);
        manifest["defaultTemplateId"] = json!(template_id.clone());
        fs::write(&manifest_path, json_bytes(&manifest).unwrap()).unwrap();
        let template_path = container
            .join(".ambd/templates")
            .join(format!("{template_id}.json"));
        fs::create_dir_all(template_path.parent().unwrap()).unwrap();
        fs::write(
            template_path,
            json_bytes(&json!({
                "format": "amby-database-template",
                "formatVersion": 1,
                "databaseId": database.database_id,
                "templateId": template_id,
                "name": "Project",
                "body": "# Project\n",
                "values": {(property_id.clone()): {"type": "text", "value": "todo"}}
            }))
            .unwrap(),
        )
        .unwrap();
        let row = create_database_row(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id,
                title: "Templated".to_owned(),
            },
        )
        .unwrap();
        let note = String::from_utf8(fs::read(row.note_path).unwrap()).unwrap();
        assert!(note.ends_with("# Project\n"));
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(row.record_path).unwrap()).unwrap();
        assert_eq!(record["values"][property_id]["value"], "todo");
        let _ = fs::remove_dir_all(vault);
    }
}
