//! Crash-safe migration and validation for versioned AI connection settings.
use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::frontmatter;

/// The connections live in a file of their own. Older builds keep reading and rewriting the `ai`
/// section of settings.json in their own shape; a build that does not know this file can then
/// never damage what is stored here.
pub(crate) const CONNECTIONS: &str = "ai-connections.json";
/// Copy of settings.json taken before the first migration, kept as history.
const SETTINGS_BACKUP: &str = "settings.pre-ai-connections.backup.json";
/// Left by the earlier migration that rewrote settings.json in place; they are history and the
/// source of a recovery, never written again.
const PREPARED: &str = "settings.ai-v1.prepared.json";
const COMPLETED: &str = "settings.ai-v1.completed";

fn transform(raw: &str) -> Result<String, String> {
    let mut root: Value = serde_json::from_str(raw.strip_prefix('\u{feff}').unwrap_or(raw))
        .map_err(|_| "corruptSettings")?;
    let object = root.as_object_mut().ok_or("corruptSettings")?;
    if object.get("ai").is_none_or(Value::is_null) {
        object.insert("ai".into(), json!({"models": [{"id":"default-ollama", "label":"Ollama · llama3.2", "provider":"ollama", "model":"llama3.2", "baseUrl":"", "credentialId":null, "apiVersion":""}], "activeModelId":"default-ollama"}));
    }
    let ai = object.get_mut("ai").ok_or("missingAiSettings")?;
    let old = ai.as_object().ok_or("corruptAiSettings")?;
    if old.contains_key("version") {
        return Err("alreadyVersioned".into());
    }
    let models = old
        .get("models")
        .and_then(Value::as_array)
        .ok_or("corruptAiSettings")?;
    let mut seen = std::collections::HashSet::new();
    let mut connections = Vec::new();
    let mut converted = Vec::new();
    for model in models {
        let model = model.as_object().ok_or("corruptAiSettings")?;
        let id = model
            .get("id")
            .and_then(Value::as_str)
            .ok_or("corruptAiSettings")?;
        if id.is_empty() || !seen.insert(id.to_owned()) {
            return Err("duplicateModelId".into());
        }
        for field in ["label", "model", "baseUrl", "apiVersion"] {
            if model.get(field).is_some_and(|v| !v.is_string()) {
                return Err("corruptAiSettings".into());
            }
        }
        if model
            .get("credentialId")
            .is_some_and(|v| !v.is_null() && !v.is_string())
            || model.get("supportsTools").is_some_and(|v| !v.is_boolean())
        {
            return Err("corruptAiSettings".into());
        }
        let provider = model
            .get("provider")
            .and_then(Value::as_str)
            .ok_or("corruptAiSettings")?;
        // Plaintext legacy keys must be migrated into the credential store first.
        if model
            .get("apiKey")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
        {
            return Err("legacyCredential".into());
        }
        if provider.is_empty() {
            return Err("corruptAiSettings".into());
        }
        let connection_id = format!("legacy:{id}");
        connections.push(json!({
            "id": connection_id, "provider": if provider == "codex" { "openai" } else { provider },
            "method": if provider == "codex" { "codex-cli" } else { "api" },
            "label": model.get("label").cloned().unwrap_or(json!("")),
            "baseUrl": model.get("baseUrl").cloned().unwrap_or(json!("")),
            "credentialId": model.get("credentialId").cloned().unwrap_or(Value::Null),
            "apiVersion": model.get("apiVersion").cloned().unwrap_or(json!("")),
        }));
        let mut entry = model.clone();
        entry.entry("label").or_insert(json!(""));
        entry.entry("model").or_insert(json!(""));
        entry.remove("provider");
        entry.remove("baseUrl");
        entry.remove("credentialId");
        entry.remove("apiVersion");
        entry.remove("apiKey");
        entry.insert("connectionId".into(), json!(connection_id));
        entry.insert("enabled".into(), json!(true));
        entry.insert("available".into(), json!(true));
        entry.insert("origin".into(), json!("legacy"));
        converted.push(Value::Object(entry));
    }
    let active = old.get("activeModelId").cloned().unwrap_or(Value::Null);
    if !active.is_null() && active.as_str().is_none_or(|id| !seen.contains(id)) {
        return Err("corruptAiSettings".into());
    }
    let mut next = old.clone();
    next.insert("version".into(), json!(1));
    next.insert("connections".into(), json!(connections));
    next.insert("models".into(), json!(converted));
    next.insert("activeModelId".into(), active);
    *ai = Value::Object(next);
    let json = serde_json::to_string_pretty(&root).map_err(|_| "invalidSettings")?;
    let bytes = frontmatter::text_bytes_from_template(raw, &json)?;
    String::from_utf8(bytes).map_err(|_| "invalidSettings".into())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The file existed already and was left alone.
    AlreadyPresent,
    /// settings.json held a versioned section, copied as it is.
    FromVersioned,
    /// settings.json held the older shape, converted.
    FromLegacy,
    /// settings.json held only the stock default, so the section saved by the earlier
    /// migration was brought back.
    Recovered,
    /// There was no settings.json at all.
    Fresh,
}

fn parse_json(raw: &str, error: &str) -> Result<Value, String> {
    serde_json::from_str(raw.strip_prefix('\u{feff}').unwrap_or(raw)).map_err(|_| error.to_owned())
}

/// The connections file, or `None` when it has not been created yet. It is an `ai` section of
/// version 1 on its own; any other version is refused rather than guessed at.
pub(crate) fn read_connections(root: &Path) -> Result<Option<Value>, String> {
    let path = crate::paths::confine_rel_no_symlinks(root, CONNECTIONS)?;
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("connectionsUnavailable".into()),
    };
    let value = parse_json(&raw, "corruptAiConnections")?;
    match value.get("version") {
        Some(version) if *version == 1 => Ok(Some(value)),
        _ => Err("unknownVersion".into()),
    }
}

/// The section a build before the file kept in settings.json, when there is one.
fn settings_section(root: &Path) -> Result<Option<Value>, String> {
    let path = crate::paths::confine_rel_no_symlinks(root, "settings.json")?;
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("settingsUnavailable".into()),
    };
    Ok(parse_json(&raw, "corruptSettings")?.get("ai").cloned())
}

/// Every section that may name a credential, newest first: the connections file, then what
/// settings.json still holds for builds that read it. A key is in use if any of them says so.
pub(crate) fn credential_sections(root: &Path) -> Result<Vec<Value>, String> {
    let mut sections = Vec::new();
    if let Some(file) = read_connections(root)? {
        sections.push(file);
    }
    if let Some(section) = settings_section(root)? {
        sections.push(section);
    }
    Ok(sections)
}

/// The settings every new install starts with.
fn default_section() -> Result<Value, String> {
    let next = transform("{}")?;
    parse_json(&next, "invalidSettings")?
        .get("ai")
        .cloned()
        .ok_or_else(|| "invalidSettings".to_owned())
}

/// What the older builds put back when they cannot read the section they find.
fn is_stock_default(section: &Value) -> bool {
    let Some(models) = section.get("models").and_then(Value::as_array) else {
        return false;
    };
    models.len() == 1
        && models[0].get("id").and_then(Value::as_str) == Some("default-ollama")
        && models[0].get("provider").and_then(Value::as_str) == Some("ollama")
        && models[0].get("model").and_then(Value::as_str) == Some("llama3.2")
        && section.get("activeModelId").and_then(Value::as_str) == Some("default-ollama")
        && section.get("version").is_none()
}

/// The section the earlier in-place migration saved, if it finished and left it behind.
fn earlier_snapshot(root: &Path) -> Result<Option<Value>, String> {
    let completed = crate::paths::confine_rel_no_symlinks(root, COMPLETED)?;
    let prepared = crate::paths::confine_rel_no_symlinks(root, PREPARED)?;
    if !completed.exists() {
        return Ok(None);
    }
    let Ok(raw) = fs::read_to_string(prepared) else {
        return Ok(None);
    };
    let Ok(settings) = parse_json(&raw, "corruptSettings") else {
        return Ok(None);
    };
    Ok(settings
        .get("ai")
        .filter(|section| section.get("version").is_some_and(|version| *version == 1))
        .cloned())
}

fn section_from_settings(root: &Path, raw: &str) -> Result<(Value, Outcome), String> {
    let settings = parse_json(raw, "corruptSettings")?;
    let section = settings.get("ai").filter(|section| !section.is_null());
    if let Some(section) = section {
        if let Some(version) = section.get("version") {
            if *version != 1 {
                return Err("unknownVersion".into());
            }
            return Ok((section.clone(), Outcome::FromVersioned));
        }
        if is_stock_default(section) {
            if let Some(earlier) = earlier_snapshot(root)? {
                return Ok((earlier, Outcome::Recovered));
            }
        }
    }
    let next = parse_json(&transform(raw)?, "invalidSettings")?;
    let converted = next
        .get("ai")
        .cloned()
        .ok_or_else(|| "invalidSettings".to_owned())?;
    Ok((converted, Outcome::FromLegacy))
}

/// Creates the connections file from whatever the settings hold, once. The copy of settings.json
/// is made first and never replaced; the file is then published without replacing anything, so its
/// existence is the completion marker and a second start finds the work done.
pub(crate) fn ensure(root: &Path) -> Result<Outcome, String> {
    let _guard = crate::app_data::lock_app_data_writes()?;
    if read_connections(root)?.is_some() {
        return Ok(Outcome::AlreadyPresent);
    }
    let settings_path = crate::paths::confine_rel_no_symlinks(root, "settings.json")?;
    let raw = match fs::read_to_string(&settings_path) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("settingsUnavailable".into()),
    };
    let (section, outcome) = match &raw {
        None => (default_section()?, Outcome::Fresh),
        Some(raw) => section_from_settings(root, raw)?,
    };
    if let Some(raw) = &raw {
        let backup = crate::paths::confine_rel_no_symlinks(root, SETTINGS_BACKUP)?;
        if !backup.exists() {
            frontmatter::atomic_write_new(&backup, raw).map_err(|_| "backupFailed")?;
        }
    }
    let text = serde_json::to_string_pretty(&section).map_err(|_| "invalidSettings")?;
    let target = crate::paths::confine_rel_no_symlinks(root, CONNECTIONS)?;
    match frontmatter::atomic_write_new(&target, &text) {
        Ok(()) => Ok(outcome),
        Err(_) if read_connections(root)?.is_some() => Ok(Outcome::AlreadyPresent),
        Err(_) => Err("publishFailed".into()),
    }
}

/// Sets the connections file aside under a timestamped name, never deleting it; the next start
/// migrates again from settings.json. This is the way back to the earlier behavior.
pub(crate) fn rollback(root: &Path) -> Result<(), String> {
    let _guard = crate::app_data::lock_app_data_writes()?;
    let from = crate::paths::confine_rel_no_symlinks(root, CONNECTIONS)?;
    if !from.exists() {
        return Err("nothingToRollBack".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let mut name = format!("{CONNECTIONS}.rolledback-{stamp}");
    let mut counter = 1;
    while crate::paths::confine_rel_no_symlinks(root, &name)?.exists() {
        name = format!("{CONNECTIONS}.rolledback-{stamp}-{counter}");
        counter += 1;
    }
    let to = crate::paths::confine_rel_no_symlinks(root, &name)?;
    fs::rename(from, to).map_err(|_| "markerFailed".to_owned())
}

/// Migrate when the connection settings screen is first opened.
#[tauri::command]
#[specta::specta]
pub fn migrate_ai_settings(app: tauri::AppHandle) -> Result<(), String> {
    ensure(&crate::app_data::app_root(&app)?).map(|_| ())
}

#[tauri::command]
#[specta::specta]
pub fn rollback_ai_settings(app: tauri::AppHandle) -> Result<(), String> {
    rollback(&crate::app_data::app_root(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_root() -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("amby-ai-connections-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn read_json(root: &Path, name: &str) -> Value {
        serde_json::from_str(&fs::read_to_string(root.join(name)).unwrap()).unwrap()
    }
    const LEGACY: &str = r#"{"unknown":42,"ai":{"models":[{"id":"m","provider":"openai","model":"x","label":"X","credentialId":"key","extra":7}],"activeModelId":"m"}}"#;
    const STOCK: &str = r#"{"layout":{},"ai":{"models":[{"id":"default-ollama","label":"Ollama · llama3.2","provider":"ollama","model":"llama3.2","baseUrl":"","credentialId":null,"apiVersion":""}],"activeModelId":"default-ollama"}}"#;

    #[test]
    fn a_legacy_section_becomes_the_connections_file_and_settings_stay_untouched() {
        let root = temp_root();
        fs::write(root.join("settings.json"), LEGACY).unwrap();
        assert_eq!(ensure(&root).unwrap(), Outcome::FromLegacy);
        let file = read_json(&root, CONNECTIONS);
        assert_eq!(file["version"], 1);
        assert_eq!(file["models"][0]["id"], "m");
        assert_eq!(file["models"][0]["extra"], 7);
        assert_eq!(file["connections"][0]["credentialId"], "key");
        // The old section stays exactly as it was, for builds that still read it.
        assert_eq!(
            fs::read_to_string(root.join("settings.json")).unwrap(),
            LEGACY
        );
        assert_eq!(
            fs::read_to_string(root.join(SETTINGS_BACKUP)).unwrap(),
            LEGACY
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_versioned_section_in_settings_is_copied_whole() {
        let root = temp_root();
        let versioned = r#"{"ai":{"version":1,"connections":[{"id":"c","provider":"openai","method":"api","label":"A","credentialId":null}],"models":[{"id":"m","connectionId":"c","enabled":true,"available":true,"model":"x","label":"X","origin":"catalog"}],"activeModelId":"m","note":"kept"}}"#;
        fs::write(root.join("settings.json"), versioned).unwrap();
        assert_eq!(ensure(&root).unwrap(), Outcome::FromVersioned);
        let file = read_json(&root, CONNECTIONS);
        assert_eq!(file["note"], "kept");
        assert_eq!(file["connections"][0]["id"], "c");
        assert_eq!(
            fs::read_to_string(root.join("settings.json")).unwrap(),
            versioned
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn connections_overwritten_with_the_stock_default_are_recovered_from_the_earlier_snapshot() {
        let root = temp_root();
        let earlier = r#"{"ai":{"version":1,"connections":[{"id":"legacy:t","provider":"openai","method":"codex-cli","label":"Terra","credentialId":null}],"models":[{"id":"t","connectionId":"legacy:t","enabled":true,"available":true,"model":"gpt","label":"Terra","origin":"legacy"}],"activeModelId":"t"}}"#;
        fs::write(root.join(PREPARED), earlier).unwrap();
        fs::write(root.join(COMPLETED), "1").unwrap();
        fs::write(root.join("settings.json"), STOCK).unwrap();
        assert_eq!(ensure(&root).unwrap(), Outcome::Recovered);
        assert_eq!(
            read_json(&root, CONNECTIONS)["connections"][0]["label"],
            "Terra"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn real_legacy_models_are_never_replaced_by_an_earlier_snapshot() {
        let root = temp_root();
        fs::write(
            root.join(PREPARED),
            r#"{"ai":{"version":1,"connections":[],"models":[],"activeModelId":null}}"#,
        )
        .unwrap();
        fs::write(root.join(COMPLETED), "1").unwrap();
        fs::write(root.join("settings.json"), LEGACY).unwrap();
        assert_eq!(ensure(&root).unwrap(), Outcome::FromLegacy);
        assert_eq!(read_json(&root, CONNECTIONS)["models"][0]["id"], "m");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_new_install_gets_the_default_without_a_settings_file() {
        let root = temp_root();
        assert_eq!(ensure(&root).unwrap(), Outcome::Fresh);
        assert_eq!(
            read_json(&root, CONNECTIONS)["models"][0]["id"],
            "default-ollama"
        );
        assert!(!root.join("settings.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_existing_file_is_never_overwritten_and_a_bad_one_is_refused() {
        let root = temp_root();
        fs::write(root.join("settings.json"), LEGACY).unwrap();
        ensure(&root).unwrap();
        let written = fs::read_to_string(root.join(CONNECTIONS)).unwrap();
        fs::write(root.join("settings.json"), STOCK).unwrap();
        assert_eq!(ensure(&root).unwrap(), Outcome::AlreadyPresent);
        assert_eq!(fs::read_to_string(root.join(CONNECTIONS)).unwrap(), written);
        fs::write(root.join(CONNECTIONS), "{").unwrap();
        assert_eq!(ensure(&root).unwrap_err(), "corruptAiConnections");
        fs::write(root.join(CONNECTIONS), r#"{"version":2}"#).unwrap();
        assert_eq!(read_connections(&root).unwrap_err(), "unknownVersion");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_legacy_key_in_plain_text_stops_the_migration_before_anything_is_written() {
        let root = temp_root();
        fs::write(
            root.join("settings.json"),
            r#"{"ai":{"models":[{"id":"x","provider":"openai","apiKey":"secret"}]}}"#,
        )
        .unwrap();
        assert_eq!(ensure(&root).unwrap_err(), "legacyCredential");
        assert!(!root.join(CONNECTIONS).exists());
        assert!(!root.join(SETTINGS_BACKUP).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rollback_sets_the_file_aside_and_the_next_start_migrates_again() {
        let root = temp_root();
        fs::write(root.join("settings.json"), LEGACY).unwrap();
        ensure(&root).unwrap();
        rollback(&root).unwrap();
        assert!(!root.join(CONNECTIONS).exists());
        let kept = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("ai-connections.json.rolledback-")
            })
            .count();
        assert_eq!(kept, 1);
        assert_eq!(rollback(&root).unwrap_err(), "nothingToRollBack");
        assert_eq!(ensure(&root).unwrap(), Outcome::FromLegacy);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_native_check_reads_the_connections_file_before_settings() {
        let root = temp_root();
        fs::write(root.join("settings.json"), LEGACY).unwrap();
        fs::write(
            root.join(CONNECTIONS),
            r#"{"version":1,"connections":[{"id":"c","provider":"openai","method":"api","baseUrl":"https://api.openai.com","credentialId":"key"}],"models":[{"id":"m","connectionId":"c","enabled":false,"available":true,"model":"gpt"}],"activeModelId":"m"}"#,
        )
        .unwrap();
        let config = super::super::AiConfig {
            provider: "openai".into(),
            internal_model_id: Some("m".into()),
            model: "gpt".into(),
            base_url: "https://api.openai.com".into(),
            credential_id: Some("key".into()),
            api_key: None,
            max_tokens: None,
            api_version: None,
        };
        assert_eq!(
            validate_selected_model(&root, &config, false).unwrap_err(),
            "unavailableModel"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_corrupt_or_plaintext_credentials_before_writing() {
        assert!(transform("{").is_err());
        assert_eq!(
            transform(r#"{"ai":{"models":[{"id":"x","provider":"openai","apiKey":"secret"}]}}"#)
                .unwrap_err(),
            "legacyCredential"
        );
        assert_eq!(
            transform(r#"{"ai":{"version":2,"models":[]}}"#).unwrap_err(),
            "alreadyVersioned"
        );
    }
    #[test]
    fn refuses_duplicate_ids_and_wrong_types() {
        assert_eq!(transform(r#"{"ai":{"models":[{"id":"a","provider":"openai"},{"id":"a","provider":"openai"}]}}"#).unwrap_err(), "duplicateModelId");
        assert_eq!(
            transform(r#"{"ai":{"models":[{"id":"a","provider":"openai","model":42}]}}"#)
                .unwrap_err(),
            "corruptAiSettings"
        );
    }
    #[test]
    fn native_dispatch_refuses_disabled_or_changed_connections() {
        let root = std::env::temp_dir().join(format!("amby-ai-model-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        let mut value = json!({"ai":{"version":1,"connections":[{"id":"c","provider":"openai","method":"api","baseUrl":"","credentialId":"key","apiVersion":""}],"models":[{"id":"m","connectionId":"c","model":"gpt","enabled":true,"available":true,"origin":"catalog"}]}});
        let path = root.join("settings.json");
        fs::write(&path, value.to_string()).unwrap();
        let mut config = super::super::AiConfig {
            provider: "openai".into(),
            internal_model_id: Some("m".into()),
            model: "gpt".into(),
            base_url: "https://api.openai.com".into(),
            credential_id: Some("key".into()),
            api_key: None,
            max_tokens: None,
            api_version: None,
        };
        assert!(validate_selected_model(&root, &config, false).is_ok());
        assert_eq!(
            validate_selected_model(&root, &config, true).unwrap_err(),
            "toolsUnsupported"
        );
        config.credential_id = Some("other".into());
        assert_eq!(
            validate_selected_model(&root, &config, false).unwrap_err(),
            "connectionChanged"
        );
        config.credential_id = Some("key".into());
        value["ai"]["models"][0]["enabled"] = json!(false);
        fs::write(&path, value.to_string()).unwrap();
        assert_eq!(
            validate_selected_model(&root, &config, false).unwrap_err(),
            "unavailableModel"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

/// At the native dispatch boundary, a versioned settings file is authoritative.
/// The renderer may only send an enabled model with its exact connection.
fn validate_selected_model_locked(
    root: &Path,
    config: &super::AiConfig,
    wants_tools: bool,
) -> Result<(), String> {
    // The connections file is authoritative; a versioned section still in settings.json counts
    // only while the file has not been created.
    let section = match read_connections(root)? {
        Some(section) => section,
        None => {
            let Some(section) = settings_section(root)? else {
                return Ok(());
            };
            if section.get("version").is_none() {
                return Ok(());
            }
            section
        }
    };
    let ai = &section;
    let version = ai.get("version").ok_or("corruptAiSettings")?;
    if *version != 1 {
        return Err("unknownVersion".into());
    }
    let id = config
        .internal_model_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or("missingModel")?;
    let models = ai
        .get("models")
        .and_then(Value::as_array)
        .ok_or("corruptAiSettings")?;
    let mut matching = models
        .iter()
        .filter(|model| model.get("id").and_then(Value::as_str) == Some(id));
    let model = matching.next().ok_or("missingModel")?;
    if matching.next().is_some()
        || model.get("enabled").and_then(Value::as_bool) != Some(true)
        || model.get("available").and_then(Value::as_bool) != Some(true)
    {
        return Err("unavailableModel".into());
    }
    let connection_id = model
        .get("connectionId")
        .and_then(Value::as_str)
        .ok_or("corruptAiSettings")?;
    let connections = ai
        .get("connections")
        .and_then(Value::as_array)
        .ok_or("corruptAiSettings")?;
    let mut matches = connections
        .iter()
        .filter(|connection| connection.get("id").and_then(Value::as_str) == Some(connection_id));
    let connection = matches.next().ok_or("missingConnection")?;
    if matches.next().is_some() {
        return Err("corruptAiSettings".into());
    }
    let provider = connection
        .get("provider")
        .and_then(Value::as_str)
        .ok_or("corruptAiSettings")?;
    let method = connection
        .get("method")
        .and_then(Value::as_str)
        .ok_or("corruptAiSettings")?;
    let (family, default_url, default_model, _local) = match (provider, method) {
        ("openai", "codex-cli") => ("codex", "", "", false),
        ("anthropic", "claude-cli") => ("claude-code", "", "", false),
        ("ollama", "api") => ("ollama", "http://localhost:11434", "llama3.2", true),
        ("lmstudio", "api") => ("openai", "http://localhost:1234", "local-model", true),
        ("mlx", "api") => (
            "openai",
            "http://localhost:8080",
            "mlx-community/Llama-3.2-3B-Instruct-4bit",
            true,
        ),
        ("llamacpp", "api") => ("openai", "http://localhost:8080", "default", true),
        ("openai", "api") => ("openai", "https://api.openai.com", "gpt-4o-mini", false),
        ("anthropic", "api") => (
            "anthropic",
            "https://api.anthropic.com",
            "claude-3-5-haiku-latest",
            false,
        ),
        ("azure", "api") => ("azure", "", "", false),
        ("openrouter", "api") => (
            "openai",
            "https://openrouter.ai/api",
            "openai/gpt-4o-mini",
            false,
        ),
        ("groq", "api") => (
            "openai",
            "https://api.groq.com/openai",
            "llama-3.3-70b-versatile",
            false,
        ),
        ("mistral", "api") => (
            "openai",
            "https://api.mistral.ai",
            "mistral-small-latest",
            false,
        ),
        _ => return Err("unsupportedProvider".into()),
    };
    let base = connection
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or("corruptAiSettings")?;
    let selected_model = model
        .get("model")
        .and_then(Value::as_str)
        .ok_or("corruptAiSettings")?;
    let credential = connection.get("credentialId").and_then(Value::as_str);
    let api_version = connection
        .get("apiVersion")
        .and_then(Value::as_str)
        .ok_or("corruptAiSettings")?;
    let expected_version = if family == "azure" {
        Some(if api_version.is_empty() {
            "2024-06-01"
        } else {
            api_version
        })
    } else {
        None
    };
    if config.provider != family
        || config.base_url != if base.is_empty() { default_url } else { base }
        || config.model
            != if selected_model.is_empty() {
                default_model
            } else {
                selected_model
            }
        || config.credential_id.as_deref() != credential
        || config.api_version.as_deref() != expected_version
        || config.api_key.is_some()
    {
        return Err("connectionChanged".into());
    }
    let effective_base = if base.is_empty() { default_url } else { base };
    let endpoint_local = reqwest::Url::parse(effective_base)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| {
            let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
            if host == "localhost" || host.ends_with(".localhost") {
                return true;
            }
            match host.parse::<std::net::IpAddr>() {
                Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
                Ok(std::net::IpAddr::V6(ip)) => {
                    ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00
                }
                Err(_) => false,
            }
        });
    let supports_tools = model
        .get("supportsTools")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            if model.get("origin").and_then(Value::as_str) == Some("catalog") {
                false
            } else {
                !endpoint_local
            }
        });
    if wants_tools && !supports_tools {
        return Err("toolsUnsupported".into());
    }
    Ok(())
}

/// Capture a credential under the same lock as key deletion and settings writes.
pub(crate) fn capture_selected_credential(
    root: &Path,
    config: &super::AiConfig,
    wants_tools: bool,
) -> Result<Option<String>, String> {
    let _guard = crate::app_data::lock_app_data_writes()?;
    validate_selected_model_locked(root, config, wants_tools)?;
    Ok(if super::is_cli_provider(&config.provider) {
        None
    } else {
        super::credential_key(config)
    })
}

#[cfg(test)]
fn validate_selected_model(
    root: &Path,
    config: &super::AiConfig,
    wants_tools: bool,
) -> Result<(), String> {
    let _guard = crate::app_data::lock_app_data_writes()?;
    validate_selected_model_locked(root, config, wants_tools)
}
