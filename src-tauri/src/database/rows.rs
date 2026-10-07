//! Structural row operations. A database row remains an ordinary Markdown
//! note; its values live in frontmatter (legacy record shards are read-only input).

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::discovery::discover_vault;
use super::format::{parse_manifest, parse_template, PropertyDefinition, PropertyValue};
use crate::frontmatter::{self, AtomicCreateError};
use crate::watcher::{self, WatcherState};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DatabaseRowTemplate {
    Empty,
    Default,
    Template {
        #[serde(rename = "templateId")]
        template_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseRowRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub title: String,
    pub template: DatabaseRowTemplate,
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
    pub warnings: Vec<String>,
}

/// The value a new row gets for a Select, Multi-select or Status that has default options.
fn default_value_of(property: &PropertyDefinition) -> Option<PropertyValue> {
    let listed = |extra: &super::format::ExtraFields, exists: &dyn Fn(&str) -> bool| {
        extra
            .get("defaultOptionIds")
            .and_then(serde_json::Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(serde_json::Value::as_str)
                    .filter(|id| exists(id))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    match property {
        PropertyDefinition::Select(fields) => {
            let ids = listed(&fields.config.extra, &|id| {
                fields.config.options.iter().any(|option| option.id == id)
            });
            ids.into_iter()
                .next()
                .map(|option_id| PropertyValue::Select {
                    option_id,
                    extra: Default::default(),
                })
        }
        PropertyDefinition::Status(fields) => {
            let ids = listed(&fields.config.extra, &|id| {
                fields.config.options.iter().any(|option| option.id == id)
            });
            ids.into_iter()
                .next()
                .map(|option_id| PropertyValue::Status {
                    option_id,
                    extra: Default::default(),
                })
        }
        PropertyDefinition::MultiSelect(fields) => {
            let option_ids = listed(&fields.config.extra, &|id| {
                fields.config.options.iter().any(|option| option.id == id)
            });
            (!option_ids.is_empty()).then(|| PropertyValue::MultiSelect {
                option_ids,
                extra: Default::default(),
            })
        }
        _ => None,
    }
}

pub fn create_database_row(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabaseRowRequest,
) -> Result<CreatedDatabaseRow, String> {
    create_database_row_with_values(vault, watcher, request, &Default::default())
}

/// Creates a row that already carries `initial` values (by property ID), written together
/// with the note, so the page never exists half-set. They win over the template's values.
pub(crate) fn create_database_row_with_values(
    vault: &Path,
    watcher: &WatcherState,
    request: &CreateDatabaseRowRequest,
    initial: &std::collections::BTreeMap<String, PropertyValue>,
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
    let note_id = ulid::Ulid::generate().to_string();
    // The stable ID belongs to the row metadata, not the user's filename.
    // Resolve duplicate titles with the familiar numeric suffix used by file
    // managers, while the frontmatter ID remains the durable identity.
    let stem = safe_row_stem(title);
    let note_path = unique_row_path(&database.container_path, &stem)?;
    if note_path.exists() {
        return Err("A row with this title or ID already exists".to_owned());
    }
    let (template_body, mut template_values) = match &request.template {
        DatabaseRowTemplate::Empty => (String::new(), std::collections::BTreeMap::new()),
        DatabaseRowTemplate::Default => load_default_template(&database, &request.database_id),
        DatabaseRowTemplate::Template { template_id } => {
            load_template(&database, &request.database_id, template_id)
        }
    };
    for (property_id, value) in initial {
        template_values.insert(property_id.clone(), value.clone());
    }
    // Every new row starts with the options the database marks as defaults, unless the template
    // already sets that property.
    if let Ok(bytes) = fs::read(&database.manifest_path) {
        if let Ok(manifest) = parse_manifest(&bytes) {
            for property in &manifest.value.properties {
                if let (Some(id), Some(value)) = (property.id(), default_value_of(property)) {
                    template_values.entry(id.to_owned()).or_insert(value);
                }
            }
        }
    }
    let encoded_title = serde_json::to_string(title).map_err(|error| error.to_string())?;
    let mut note_content =
        format!("---\namby-id: {note_id}\namby-title: {encoded_title}\n---\n{template_body}");

    if !template_values.is_empty() {
        if let Ok(manifest_bytes) = fs::read(&database.manifest_path) {
            if let Ok(manifest) = parse_manifest(&manifest_bytes) {
                for (prop_id, prop_val) in &template_values {
                    if let Some(prop_def) = manifest
                        .value
                        .properties
                        .iter()
                        .find(|p| p.id() == Some(prop_id.as_str()))
                    {
                        if let (Some(prop_name), Some(yaml_val)) = (
                            prop_def.name(),
                            super::format::property_value_to_frontmatter_value(prop_val, prop_def),
                        ) {
                            if let Ok(updated) = frontmatter::replace_yaml_binding_lossless(
                                &note_content,
                                prop_name,
                                &yaml_val,
                            ) {
                                note_content = updated;
                            }
                        }
                    }
                }
            }
        }
    }
    let note_bytes = note_content.into_bytes();
    let prepared =
        watcher.prepare_write([(&note_path, watcher::fingerprint_for_bytes(&note_bytes))]);
    if let Err(error) = write_new(&note_path, &note_bytes) {
        watcher.cancel_prepared_write(&prepared);
        return Err(error);
    }
    watcher.confirm_prepared_write(&prepared);
    Ok(CreatedDatabaseRow {
        database_id: request.database_id.clone(),
        note_id,
        title: title.to_owned(),
        note_path: note_path.to_string_lossy().to_string(),
        record_path: String::new(),
        record_revision: String::new(),
        warnings: Vec::new(),
    })
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateDatabaseRowRequest {
    pub expected_generation: u64,
    pub database_id: String,
    pub note_id: String,
    /// Title of the copy; the caller localizes the "copy" wording.
    pub title: String,
}

/// Copies a row next to the original: the same property values and body, a new stable ID and
/// the given title. The original is only read. Relation values are copied as they are, so a
/// two-way Relation's other side does not list the copy until it is linked there.
pub fn duplicate_database_row(
    vault: &Path,
    watcher: &WatcherState,
    request: &DuplicateDatabaseRowRequest,
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
    let discovery = discover_vault(vault)?;
    let database = discovery
        .databases
        .iter()
        .find(|database| database.database_id == request.database_id)
        .ok_or_else(|| "Database was not found".to_owned())?;
    if database.read_only {
        return Err("Database is read-only".to_owned());
    }
    let source = discovery
        .notes
        .iter()
        .find(|note| {
            note.note_id.as_deref() == Some(request.note_id.as_str())
                && note.owner_database_id.as_deref() == Some(request.database_id.as_str())
        })
        .ok_or_else(|| "Row was not found in this database".to_owned())?;
    let directory = source
        .path
        .parent()
        .ok_or_else(|| "Row has no parent folder".to_owned())?;
    let content = fs::read_to_string(&source.path)
        .map_err(|error| format!("Could not read the row: {error}"))?;
    let note_id = ulid::Ulid::generate().to_string();
    let with_id = frontmatter::replace_yaml_binding_lossless(
        &content,
        frontmatter::AMBY_ID_FIELD,
        &serde_yaml::Value::String(note_id.clone()),
    )?;
    let note_content = frontmatter::replace_yaml_binding_lossless(
        &with_id,
        frontmatter::AMBY_TITLE_FIELD,
        &serde_yaml::Value::String(title.to_owned()),
    )?;
    let note_path = unique_row_path(directory, &safe_row_stem(title))?;
    let note_bytes = note_content.into_bytes();
    let prepared =
        watcher.prepare_write([(&note_path, watcher::fingerprint_for_bytes(&note_bytes))]);
    if let Err(error) = write_new(&note_path, &note_bytes) {
        watcher.cancel_prepared_write(&prepared);
        return Err(error);
    }
    watcher.confirm_prepared_write(&prepared);
    Ok(CreatedDatabaseRow {
        database_id: request.database_id.clone(),
        note_id,
        title: title.to_owned(),
        note_path: note_path.to_string_lossy().to_string(),
        record_path: String::new(),
        record_revision: String::new(),
        warnings: Vec::new(),
    })
}

/// Publish a newly created Markdown row into the primary note index before the
/// database projection is rebuilt. The watcher suppresses the app's own file
/// event, so waiting for a later refresh would otherwise leave `db_members`
/// empty even though the note already exists on disk.
pub fn index_created_database_row(
    connection: &rusqlite::Connection,
    vault: &Path,
    created: &CreatedDatabaseRow,
) -> Result<(), String> {
    let note_path = Path::new(&created.note_path);
    let source = fs::read_to_string(note_path).map_err(|error| error.to_string())?;
    crate::vault_index::index_update_note(connection, vault, note_path, &source)
}

fn load_default_template(
    database: &super::discovery::DiscoveredDatabase,
    database_id: &str,
) -> (String, std::collections::BTreeMap<String, PropertyValue>) {
    let Ok(manifest_bytes) = fs::read(&database.manifest_path) else {
        return (String::new(), std::collections::BTreeMap::new());
    };
    let Ok(manifest) = parse_manifest(&manifest_bytes) else {
        return (String::new(), std::collections::BTreeMap::new());
    };
    let Some(template_id) = manifest.value.default_template_id else {
        return (String::new(), std::collections::BTreeMap::new());
    };
    load_template_file(database, database_id, &template_id)
}

fn load_template(
    database: &super::discovery::DiscoveredDatabase,
    database_id: &str,
    template_id: &str,
) -> (String, std::collections::BTreeMap<String, PropertyValue>) {
    let Ok(manifest_bytes) = fs::read(&database.manifest_path) else {
        return (String::new(), std::collections::BTreeMap::new());
    };
    let Ok(manifest) = parse_manifest(&manifest_bytes) else {
        return (String::new(), std::collections::BTreeMap::new());
    };
    if manifest.value.database_id != database_id
        || !manifest
            .value
            .template_order
            .iter()
            .any(|id| id == template_id)
    {
        return (String::new(), std::collections::BTreeMap::new());
    }
    load_template_file(database, database_id, template_id)
}

fn load_template_file(
    database: &super::discovery::DiscoveredDatabase,
    database_id: &str,
    template_id: &str,
) -> (String, std::collections::BTreeMap<String, PropertyValue>) {
    let path = database
        .container_path
        .join(".ambd/templates")
        .join(format!("{template_id}.json"));
    let Ok(bytes) = fs::read(path) else {
        return (String::new(), std::collections::BTreeMap::new());
    };
    let Ok(template) = parse_template(&bytes) else {
        return (String::new(), std::collections::BTreeMap::new());
    };
    if template.value.database_id != database_id || template.value.template_id != template_id {
        return (String::new(), std::collections::BTreeMap::new());
    }
    (template.value.body, template.value.values)
}

fn safe_row_stem(title: &str) -> String {
    let mut readable = title
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\' | ':') {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    while readable.ends_with(['.', ' ']) {
        readable.pop();
    }
    let reserved = matches!(
        readable.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
    ) || (readable.len() == 4
        && (readable.to_ascii_uppercase().starts_with("COM")
            || readable.to_ascii_uppercase().starts_with("LPT"))
        && readable
            .as_bytes()
            .get(3)
            .is_some_and(|byte| (b'1'..=b'9').contains(byte)));
    if reserved {
        readable = "row".to_owned();
    }
    let readable = readable.trim();
    let readable = if readable.is_empty() { "row" } else { readable };
    let max_readable = 96usize;
    let mut prefix = String::new();
    for character in readable.chars() {
        if prefix.len() + character.len_utf8() > max_readable.max(1) {
            break;
        }
        prefix.push(character);
    }
    prefix
}

fn unique_row_path(container: &Path, stem: &str) -> Result<std::path::PathBuf, String> {
    for number in 1..=10_000_u32 {
        let suffix = if number == 1 {
            String::new()
        } else {
            format!(" {number}")
        };
        let max_stem_len = 96usize.saturating_sub(suffix.len());
        let mut base = String::new();
        for character in stem.chars() {
            if base.len() + character.len_utf8() > max_stem_len {
                break;
            }
            base.push(character);
        }
        let candidate = container.join(format!("{base}{suffix}.md"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not find an available filename for the database row".to_owned())
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
    use serde_json::json;
    use std::path::PathBuf;

    fn json_bytes(value: &serde_json::Value) -> Result<Vec<u8>, String> {
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    fn temp_vault() -> PathBuf {
        let path = std::env::temp_dir().join(format!("amby-db-row-{}", ulid::Ulid::generate()));
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
                template: DatabaseRowTemplate::Default,
            },
        )
        .unwrap();
        assert_eq!(row.note_id.len(), 26);
        assert!(Path::new(&row.note_path).is_file());
        assert!(!Path::new(&row.note_path)
            .parent()
            .unwrap()
            .join(".ambd/records")
            .exists());
        assert!(String::from_utf8(fs::read(&row.note_path).unwrap())
            .unwrap()
            .contains(&row.note_id));
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn duplicates_a_row_with_a_new_id_the_same_body_and_values() {
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
                database_id: database.database_id.clone(),
                title: "Plan".to_owned(),
                template: DatabaseRowTemplate::Empty,
            },
        )
        .unwrap();
        // The original gains a custom key and a body the copy must carry over.
        let original = fs::read_to_string(&row.note_path).unwrap();
        let edited = original.replacen("---\n", "---\nowner: Ann\n", 1) + "Body text\n";
        fs::write(&row.note_path, &edited).unwrap();

        let copy = duplicate_database_row(
            &vault,
            &WatcherState::new(),
            &DuplicateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id.clone(),
                note_id: row.note_id.clone(),
                title: "Plan — copy".to_owned(),
            },
        )
        .unwrap();
        assert_ne!(copy.note_id, row.note_id);
        assert_eq!(copy.note_id.len(), 26);
        let copied = fs::read_to_string(&copy.note_path).unwrap();
        assert!(copied.contains(&copy.note_id));
        assert!(!copied.contains(&row.note_id));
        assert!(copied.contains("owner: Ann"));
        assert!(copied.ends_with("Body text\n"));
        assert!(copied.contains("Plan — copy"));
        // The original is untouched and the copy sits next to it.
        assert_eq!(fs::read_to_string(&row.note_path).unwrap(), edited);
        assert_eq!(
            Path::new(&copy.note_path).parent(),
            Path::new(&row.note_path).parent()
        );

        // A second copy with the same title gets its own file.
        let second = duplicate_database_row(
            &vault,
            &WatcherState::new(),
            &DuplicateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id,
                note_id: row.note_id,
                title: "Plan — copy".to_owned(),
            },
        )
        .unwrap();
        assert_ne!(second.note_path, copy.note_path);
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn refuses_to_duplicate_a_row_of_another_database() {
        let vault = temp_vault();
        let request = DuplicateDatabaseRowRequest {
            expected_generation: 1,
            database_id: ulid::Ulid::generate().to_string(),
            note_id: ulid::Ulid::generate().to_string(),
            title: "Copy".to_owned(),
        };
        assert!(duplicate_database_row(&vault, &WatcherState::new(), &request).is_err());
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
        let manifest_path = crate::database::discovery::manifest_path_for_container(&container);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["properties"] = json!([{
            "type": "text",
            "id": property_id.clone(),
            "name": "Status",
            "pageVisibility": "alwaysShow",
            "config": { "multiline": false }
        }]);
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
                template: DatabaseRowTemplate::Default,
            },
        )
        .unwrap();
        let note = String::from_utf8(fs::read(row.note_path).unwrap()).unwrap();
        assert!(note.ends_with("# Project\n"));
        assert!(note.contains("Status: todo"));
        assert!(!container.join(".ambd/records").exists());
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn creates_an_empty_row_without_template_body_or_values() {
        let vault = temp_vault();
        let database = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Empty pages".to_owned(),
            },
        )
        .unwrap();
        let row = create_database_row(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id,
                title: "Blank".to_owned(),
                template: DatabaseRowTemplate::Empty,
            },
        )
        .unwrap();
        let note = String::from_utf8(fs::read(&row.note_path).unwrap()).unwrap();
        assert_eq!(
            note,
            format!(
                "---\namby-id: {}\namby-title: \"Blank\"\n---\n",
                row.note_id
            )
        );
        assert!(!Path::new(&row.note_path)
            .parent()
            .unwrap()
            .join(".ambd/records")
            .exists());
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn duplicate_titles_get_readable_numbered_paths_and_display_titles() {
        let vault = temp_vault();
        let database = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Duplicate names".to_owned(),
            },
        )
        .unwrap();
        let first = create_database_row(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id.clone(),
                title: "Алекс".to_owned(),
                template: DatabaseRowTemplate::Empty,
            },
        )
        .unwrap();
        let second = create_database_row(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id,
                title: "Алекс".to_owned(),
                template: DatabaseRowTemplate::Empty,
            },
        )
        .unwrap();
        assert_ne!(first.note_id, second.note_id);
        assert_ne!(first.note_path, second.note_path);
        assert!(first.note_path.ends_with("Алекс.md"));
        assert!(second.note_path.ends_with("Алекс 2.md"));
        assert!(String::from_utf8(fs::read(first.note_path).unwrap())
            .unwrap()
            .contains("amby-title: \"Алекс\""));
        assert!(String::from_utf8(fs::read(second.note_path).unwrap())
            .unwrap()
            .contains("amby-title: \"Алекс\""));
        let _ = fs::remove_dir_all(vault);
    }

    #[test]
    fn indexes_an_attached_row_before_rebuilding_database_membership() {
        let vault = temp_vault().canonicalize().unwrap();
        let note_path = vault.join("People.md");
        fs::write(&note_path, "People\n").unwrap();
        let connection = crate::index::open_connection(&vault).unwrap();
        crate::index::sync_vault(&connection, &vault).unwrap();
        let database = create_database(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Attached,
                parent_path: None,
                note_path: Some(note_path.to_string_lossy().to_string()),
                name: "People".to_owned(),
            },
        )
        .unwrap();
        let row = create_database_row(
            &vault,
            &WatcherState::new(),
            &CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: database.database_id.clone(),
                title: "Alice".to_owned(),
                template: DatabaseRowTemplate::Default,
            },
        )
        .unwrap();

        index_created_database_row(&connection, &vault, &row).unwrap();
        crate::database::projection::rebuild_database_projection(&connection, &vault).unwrap();
        let members: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM db_members WHERE database_id = ?1",
                [database.database_id],
                |result| result.get(0),
            )
            .unwrap();
        assert_eq!(members, 1);
        let _ = fs::remove_dir_all(vault);
    }
}
