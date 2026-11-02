//! Crash-safe migration and validation for versioned AI connection settings.
use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::frontmatter;

const BACKUP: &str = "settings.ai-v1.backup.json";
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

/// Moves the markers of a finished migration aside under a timestamped name. The completion
/// marker goes last, so a crash in between is finished by the next run.
fn supersede_markers(root: &Path) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    for name in [BACKUP, PREPARED, COMPLETED] {
        let from = crate::paths::confine_rel_no_symlinks(root, name)?;
        if !from.exists() {
            continue;
        }
        let mut target = format!("{name}.superseded-{stamp}");
        let mut counter = 1;
        while crate::paths::confine_rel_no_symlinks(root, &target)?.exists() {
            target = format!("{name}.superseded-{stamp}-{counter}");
            counter += 1;
        }
        let to = crate::paths::confine_rel_no_symlinks(root, &target)?;
        fs::rename(&from, &to).map_err(|_| "markerFailed")?;
    }
    Ok(())
}

/// Backup and publication are no-replace/atomic. A published snapshot acts as
/// the completion marker and guards rollback against later user edits.
fn migrate(root: &Path) -> Result<(), String> {
    let _guard = crate::app_data::lock_app_data_writes()?;
    let path = crate::paths::confine_rel_no_symlinks(root, "settings.json")?;
    let raw = fs::read_to_string(&path).map_err(|_| "settingsUnavailable")?;
    let prepared = crate::paths::confine_rel_no_symlinks(root, PREPARED)?;
    let completed = crate::paths::confine_rel_no_symlinks(root, COMPLETED)?;
    let parsed: Value = serde_json::from_str(raw.strip_prefix('\u{feff}').unwrap_or(&raw))
        .map_err(|_| "corruptSettings")?;
    if let Some(version) = parsed.get("ai").and_then(|ai| ai.get("version")) {
        if version != 1 {
            return Err("unknownVersion".into());
        }
        if completed.exists() {
            return Ok(());
        }
        if fs::read_to_string(&prepared).map_err(|_| "markerUnavailable")? != raw {
            return Err("markerConflict".into());
        }
        frontmatter::atomic_write(&completed, "1")?;
        return Ok(());
    }
    let next = transform(&raw)?;
    if completed.exists() {
        // The migration finished once, yet `ai` has no version again: another build wrote the file
        // afterwards. The earlier backup and markers belong to that finished migration, so they
        // are set aside (kept, never deleted) and this file is migrated afresh.
        supersede_markers(root)?;
    }
    let backup = crate::paths::confine_rel_no_symlinks(root, BACKUP)?;
    if backup.exists() {
        if fs::read_to_string(&backup).map_err(|_| "backupUnavailable")? != raw {
            return Err("backupConflict".into());
        }
    } else {
        frontmatter::atomic_write_new(&backup, &raw).map_err(|_| "backupFailed")?;
    }
    if prepared.exists() {
        if fs::read_to_string(&prepared).map_err(|_| "markerUnavailable")? != next {
            return Err("markerConflict".into());
        }
    } else {
        frontmatter::atomic_write_new(&prepared, &next).map_err(|_| "markerFailed")?;
    }
    if fs::read_to_string(&path).map_err(|_| "settingsUnavailable")? != raw {
        return Err("settingsChanged".into());
    }
    frontmatter::atomic_write_bytes(&path, next.as_bytes())?;
    if fs::read_to_string(&path).map_err(|_| "settingsUnavailable")? != next {
        return Err("verificationFailed".into());
    }
    frontmatter::atomic_write(&completed, "1")?;
    Ok(())
}

fn rollback(root: &Path) -> Result<(), String> {
    let _guard = crate::app_data::lock_app_data_writes()?;
    let path = crate::paths::confine_rel_no_symlinks(root, "settings.json")?;
    let current = fs::read_to_string(&path).map_err(|_| "settingsUnavailable")?;
    let published = fs::read_to_string(crate::paths::confine_rel_no_symlinks(root, PREPARED)?)
        .map_err(|_| "markerUnavailable")?;
    if current != published {
        return Err("settingsChanged".into());
    }
    let backup = fs::read_to_string(crate::paths::confine_rel_no_symlinks(root, BACKUP)?)
        .map_err(|_| "backupUnavailable")?;
    frontmatter::atomic_write_bytes(&path, backup.as_bytes())?;
    match fs::remove_file(crate::paths::confine_rel_no_symlinks(root, COMPLETED)?) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("markerFailed".into()),
    };
    Ok(())
}

/// Migrate when the connection settings screen is first opened.
#[tauri::command]
#[specta::specta]
pub fn migrate_ai_settings(app: tauri::AppHandle) -> Result<(), String> {
    migrate(&crate::app_data::app_root(&app)?)
}

#[tauri::command]
#[specta::specta]
pub fn rollback_ai_settings(app: tauri::AppHandle) -> Result<(), String> {
    rollback(&crate::app_data::app_root(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_ids_and_unknown_fields_and_guards_rollback() {
        let root =
            std::env::temp_dir().join(format!("amby-ai-migration-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        let old = r#"{"unknown":42,"ai":{"models":[{"id":"m","provider":"openai","model":"x","label":"X","credentialId":"key","extra":7}],"activeModelId":"m"}}"#;
        fs::write(&root.join("settings.json"), old).unwrap();
        migrate(&root).unwrap();
        migrate(&root).unwrap();
        let migrated: Value =
            serde_json::from_str(&fs::read_to_string(&root.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(migrated["unknown"], 42);
        assert_eq!(migrated["ai"]["models"][0]["id"], "m");
        assert_eq!(migrated["ai"]["models"][0]["extra"], 7);
        assert_eq!(migrated["ai"]["connections"][0]["credentialId"], "key");
        fs::write(&root.join("settings.json"), "changed").unwrap();
        assert_eq!(rollback(&root).unwrap_err(), "settingsChanged");
        fs::write(
            &root.join("settings.json"),
            fs::read(&root.join(PREPARED)).unwrap(),
        )
        .unwrap();
        rollback(&root).unwrap();
        assert_eq!(
            fs::read_to_string(&root.join("settings.json")).unwrap(),
            old
        );
        fs::remove_dir_all(&root).unwrap();
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
    fn recovers_prepared_publication_and_preserves_bom_backup() {
        let root =
            std::env::temp_dir().join(format!("amby-ai-migration-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        let old = "\u{feff}{\"ai\":{\"models\":[],\"activeModelId\":null}}";
        fs::write(root.join("settings.json"), old).unwrap();
        fs::write(root.join(BACKUP), old).unwrap();
        let next = transform(old).unwrap();
        fs::write(root.join(PREPARED), &next).unwrap();
        migrate(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join(BACKUP)).unwrap(), old);
        fs::remove_file(root.join(COMPLETED)).unwrap();
        migrate(&root).unwrap();
        assert!(root.join(COMPLETED).exists());
        rollback(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join("settings.json")).unwrap(), old);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migrates_again_when_an_older_build_rewrote_the_settings() {
        let root =
            std::env::temp_dir().join(format!("amby-ai-migration-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        let first = r#"{"ai":{"models":[{"id":"a","provider":"openai","model":"x","label":"A"}],"activeModelId":"a"}}"#;
        fs::write(root.join("settings.json"), first).unwrap();
        migrate(&root).unwrap();
        // An older build writes the legacy shape back.
        let again = r#"{"ai":{"models":[{"id":"b","provider":"ollama","model":"y","label":"B"}],"activeModelId":"b"}}"#;
        fs::write(root.join("settings.json"), again).unwrap();
        migrate(&root).unwrap();
        let migrated: Value =
            serde_json::from_str(&fs::read_to_string(root.join("settings.json")).unwrap()).unwrap();
        assert_eq!(migrated["ai"]["version"], 1);
        assert_eq!(migrated["ai"]["models"][0]["id"], "b");
        assert_eq!(fs::read_to_string(root.join(BACKUP)).unwrap(), again);
        assert!(root.join(COMPLETED).exists());
        // The first migration's backup is kept, not deleted.
        let kept = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.ai-v1.backup.json.superseded-")
            })
            .count();
        assert_eq!(kept, 1);
        fs::remove_dir_all(root).unwrap();
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
    let path = crate::paths::confine_rel_no_symlinks(root, "settings.json")?;
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("settingsUnavailable".into()),
    };
    let settings: Value = serde_json::from_str(raw.strip_prefix('\u{feff}').unwrap_or(&raw))
        .map_err(|_| "corruptSettings")?;
    let Some(ai) = settings.get("ai") else {
        return Ok(());
    };
    let Some(version) = ai.get("version") else {
        return Ok(());
    };
    if version != 1 {
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
