//! Per-vault consent to send search results to a cloud provider.
use super::AiConfig;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsentFile {
    version: u32,
    decisions: BTreeMap<String, bool>,
}

fn endpoint(config: &AiConfig) -> Result<reqwest::Url, String> {
    let default = match config.provider.as_str() {
        "ollama" => "http://localhost:11434",
        "openai" => "https://api.openai.com",
        "anthropic" => "https://api.anthropic.com",
        "azure" => "",
        // Agent mode has no endpoint of its own: the notes go to ChatGPT through Codex.
        // The path is the version of what the user agrees to. v2: Codex runs isolated with only
        // Amby's read tools. A consent given to the first, unisolated mode (no path) is not reused.
        "codex" => {
            return Ok(
                reqwest::Url::parse("https://chatgpt.com/amby-isolated-agent/2")
                    .expect("static URL"),
            )
        }
        // Claude Code runs isolated with only Amby's read tools; the notes go to Anthropic.
        "claude-code" => {
            return Ok(
                reqwest::Url::parse("https://claude.ai/amby-isolated-agent/1").expect("static URL"),
            )
        }
        _ => return Err("Invalid provider".into()),
    };
    if config.provider == "azure" {
        return super::azure_url(config);
    }
    super::provider_base_url(config, default)
}

fn local(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => {
            name.eq_ignore_ascii_case("localhost") || name.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unique_local(),
        None => false,
    }
}

fn key(config: &AiConfig, url: &reqwest::Url) -> String {
    let path = if config.provider == "azure" {
        reqwest::Url::parse(&config.base_url)
            .ok()
            .map(|value| value.path().to_owned())
            .unwrap_or_default()
    } else {
        url.path().to_owned()
    };
    let identity = (
        "v2",
        config.provider.as_str(),
        url.origin().ascii_serialization(),
        path.trim_end_matches('/'),
        config.credential_id.as_deref(),
        if config.credential_id.is_some() {
            None
        } else {
            config.api_key.as_deref()
        },
        config.api_version.as_deref(),
    );
    let bytes = serde_json::to_vec(&identity).expect("consent identity is serializable");
    format!("{:x}", Sha256::digest(bytes))
}

fn file(root: &Path) -> Result<std::path::PathBuf, String> {
    crate::paths::confine_rel_no_symlinks(root, ".amby/ai/consents.json")
}

fn read(root: &Path) -> Result<ConsentFile, String> {
    let path = file(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConsentFile {
                version: 1,
                decisions: BTreeMap::new(),
            })
        }
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("Consent file unavailable".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Consent file unavailable".into());
    }
    let data: ConsentFile =
        serde_json::from_slice(&bytes).map_err(|_| "Consent file unavailable")?;
    if data.version != 1 {
        return Err("Unsupported consent version".into());
    }
    Ok(data)
}

pub(crate) fn status(root: &Path, config: &AiConfig) -> Result<&'static str, String> {
    let url = endpoint(config)?;
    if local(&url) {
        return Ok("local");
    }
    Ok(match read(root)?.decisions.get(&key(config, &url)) {
        Some(true) => "allowed",
        Some(false) => "denied",
        None => "unknown",
    })
}

pub(crate) fn decide(root: &Path, config: &AiConfig, allowed: bool) -> Result<(), String> {
    let url = endpoint(config)?;
    if local(&url) {
        return Ok(());
    }
    let mut data = read(root)?;
    data.decisions.insert(key(config, &url), allowed);
    super::chats::ensure_dir(root, ".amby/ai")?;
    let path = file(root)?;
    let bytes = serde_json::to_vec(&data).map_err(|error| error.to_string())?;
    crate::frontmatter::atomic_write_bytes(&path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(url: &str) -> AiConfig {
        AiConfig {
            provider: "openai".into(),
            internal_model_id: None,
            model: "x".into(),
            base_url: url.into(),
            credential_id: None,
            api_key: None,
            max_tokens: None,
            api_version: None,
        }
    }
    #[test]
    fn ai1_s1_consent_is_per_vault_and_provider_and_rejects_corruption() {
        let root = std::env::temp_dir().join(format!("amby-ai-consent-{}", ulid::Ulid::generate()));
        let other =
            std::env::temp_dir().join(format!("amby-ai-consent-{}", ulid::Ulid::generate()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(&other).unwrap();
        let provider = config("https://example.com/v1");
        assert_eq!(status(&root, &provider).unwrap(), "unknown");
        decide(&root, &provider, false).unwrap();
        assert_eq!(status(&root, &provider).unwrap(), "denied");
        assert_eq!(status(&other, &provider).unwrap(), "unknown");
        assert_eq!(
            status(&root, &config("https://other.example/v1")).unwrap(),
            "unknown"
        );
        assert_eq!(
            status(&root, &config("https://example.com/other-provider")).unwrap(),
            "unknown"
        );
        decide(&root, &provider, true).unwrap();
        assert_eq!(status(&root, &provider).unwrap(), "allowed");
        assert_eq!(
            status(&root, &config("http://127.0.0.1:1234")).unwrap(),
            "local"
        );
        let path = file(&root).unwrap();
        fs::write(&path, b"{broken").unwrap();
        assert!(decide(&root, &provider, true).is_err());
        assert_eq!(fs::read(path).unwrap(), b"{broken");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn codex_agent_mode_is_a_cloud_provider_that_needs_its_own_consent() {
        let root = std::env::temp_dir().join(format!("amby-ai-consent-{}", ulid::Ulid::generate()));
        fs::create_dir(&root).unwrap();
        let mut codex = config("");
        codex.provider = "codex".into();
        assert_eq!(status(&root, &codex).unwrap(), "unknown");
        // A stray base URL must neither make it local nor change its identity.
        codex.base_url = "http://localhost:1".into();
        assert_eq!(status(&root, &codex).unwrap(), "unknown");
        decide(&root, &codex, true).unwrap();
        assert_eq!(status(&root, &codex).unwrap(), "allowed");
        assert_eq!(
            status(&root, &config("https://chatgpt.com")).unwrap(),
            "unknown"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claude_code_is_a_cloud_provider_with_its_own_consent_apart_from_the_api() {
        let root = std::env::temp_dir().join(format!("amby-ai-consent-{}", ulid::Ulid::generate()));
        fs::create_dir(&root).unwrap();
        let mut claude = config("");
        claude.provider = "claude-code".into();
        assert_eq!(status(&root, &claude).unwrap(), "unknown");
        claude.base_url = "http://localhost:1".into();
        assert_eq!(status(&root, &claude).unwrap(), "unknown");
        decide(&root, &claude, true).unwrap();
        assert_eq!(status(&root, &claude).unwrap(), "allowed");
        // Neither the Anthropic API nor Codex shares that decision.
        let mut api = config("");
        api.provider = "anthropic".into();
        assert_eq!(status(&root, &api).unwrap(), "unknown");
        let mut codex = config("");
        codex.provider = "codex".into();
        assert_eq!(status(&root, &codex).unwrap(), "unknown");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_consent_given_to_the_old_unisolated_codex_is_not_reused_for_the_isolated_one() {
        let root = std::env::temp_dir().join(format!("amby-ai-consent-{}", ulid::Ulid::generate()));
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(root.join(".amby/ai")).unwrap();
        // The decision stored by the first Codex mode, which had the user's own access to the
        // computer: hash of "codex:https://chatgpt.com:".
        let old = "a7fb428f48a4323c37e978b5f0d70e941e6b5cb54cb9018c8e221a5640aa70b3";
        fs::write(
            root.join(".amby/ai/consents.json"),
            format!(r#"{{"version":1,"decisions":{{"{old}":true}}}}"#),
        )
        .unwrap();
        let mut codex = config("");
        codex.provider = "codex".into();
        assert_eq!(status(&root, &codex).unwrap(), "unknown");
        decide(&root, &codex, true).unwrap();
        assert_eq!(status(&root, &codex).unwrap(), "allowed");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn credential_and_api_version_changes_require_new_consent() {
        let root = std::env::temp_dir().join(format!("amby-ai-consent-{}", ulid::Ulid::generate()));
        fs::create_dir(&root).unwrap();
        let mut value = config("https://example.com");
        value.credential_id = Some("first".into());
        decide(&root, &value, true).unwrap();
        value.credential_id = Some("second".into());
        assert_eq!(status(&root, &value).unwrap(), "unknown");
        value.credential_id = Some("first".into());
        value.api_version = Some("new".into());
        assert_eq!(status(&root, &value).unwrap(), "unknown");
        fs::remove_dir_all(root).unwrap();
    }
}
