//! The AI connections file in the app-data folder and the native checks that read it.
use std::fs;
use std::path::Path;

use serde_json::Value;

/// The connections live in a file of their own: an `ai` section of version 1. Settings keep no
/// copy; older builds that still read the `ai` section of settings.json cannot damage this file.
pub(crate) const CONNECTIONS: &str = "ai-connections.json";

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

/// Every section that may name a credential: the connections file, when it exists.
pub(crate) fn credential_sections(root: &Path) -> Result<Vec<Value>, String> {
    Ok(read_connections(root)?.into_iter().collect())
}

/// At the native dispatch boundary, a versioned settings file is authoritative.
/// The renderer may only send an enabled model with its exact connection.
fn validate_selected_model_locked(
    root: &Path,
    config: &super::AiConfig,
    wants_tools: bool,
) -> Result<(), String> {
    // The connections file is authoritative; without it there is nothing to check against.
    let Some(section) = read_connections(root)? else {
        return Ok(());
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_root() -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("amby-ai-connections-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_missing_file_is_no_connections_and_a_bad_one_is_refused() {
        let root = temp_root();
        assert!(read_connections(&root).unwrap().is_none());
        assert!(credential_sections(&root).unwrap().is_empty());
        fs::write(root.join(CONNECTIONS), "{").unwrap();
        assert_eq!(read_connections(&root).unwrap_err(), "corruptAiConnections");
        fs::write(root.join(CONNECTIONS), r#"{"version":2}"#).unwrap();
        assert_eq!(read_connections(&root).unwrap_err(), "unknownVersion");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_native_check_refuses_a_disabled_model_in_the_connections_file() {
        let root = temp_root();
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
    fn native_dispatch_refuses_disabled_or_changed_connections() {
        let root = std::env::temp_dir().join(format!("amby-ai-model-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        let mut value = json!({"version":1,"connections":[{"id":"c","provider":"openai","method":"api","baseUrl":"","credentialId":"key","apiVersion":""}],"models":[{"id":"m","connectionId":"c","model":"gpt","enabled":true,"available":true,"origin":"catalog"}]});
        let path = root.join(CONNECTIONS);
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
        value["models"][0]["enabled"] = json!(false);
        fs::write(&path, value.to_string()).unwrap();
        assert_eq!(
            validate_selected_model(&root, &config, false).unwrap_err(),
            "unavailableModel"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
