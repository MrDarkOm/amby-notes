//! Provider catalog preparation. Never return response bodies or request errors
//! across IPC: either may contain credentials or private endpoint details.
use std::collections::HashSet;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{clean_key, openai_candidate_urls, provider_base_url, AiConfig, AiErrorCode};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODELS: usize = 10_000;
const MAX_PAGES: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub model: String,
    pub label: String,
    pub supports_tools: Option<bool>,
}

/// Catalogs commonly omit capabilities. Deny known non-chat families and
/// retain unknown text candidates without asserting tool support; the UI must
/// state that catalogue presence does not establish account access.
fn text_candidate(id: &str, official_openai: bool) -> bool {
    let id = id.to_ascii_lowercase();
    if official_openai
        && (![
            "gpt-3.5-turbo",
            "gpt-4",
            "gpt-5",
            "chatgpt-4",
            "o1",
            "o3",
            "o4",
        ]
        .iter()
        .any(|prefix| id.starts_with(prefix))
            || id.contains("codex")
            || id.contains("-pro")
            || id.contains("deep-research"))
    {
        return false;
    }
    ![
        "embed",
        "whisper",
        "transcri",
        "audio",
        "speech",
        "tts",
        "image",
        "dall-e",
        "moderation",
        "rerank",
        "realtime",
        "search",
        "guard",
        "vision-only",
    ]
    .iter()
    .any(|part| id.contains(part))
}

fn parse_page(
    value: &Value,
    provider: &str,
    official_openai: bool,
) -> Result<(Vec<CatalogModel>, Option<String>), AiErrorCode> {
    let key = if provider == "ollama" {
        "models"
    } else {
        "data"
    };
    let items = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or(AiErrorCode::InvalidResponse)?;
    let mut result = Vec::new();
    for item in items {
        let id = item
            .get(if provider == "ollama" { "name" } else { "id" })
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 1024)
            .ok_or(AiErrorCode::InvalidResponse)?;
        if !text_candidate(id, official_openai) {
            continue;
        }
        if let Some(modalities) = item.pointer("/architecture/input_modalities") {
            let values = modalities.as_array().ok_or(AiErrorCode::InvalidResponse)?;
            if !values.iter().any(|value| value.as_str() == Some("text")) {
                continue;
            }
        }
        if let Some(modalities) = item.pointer("/architecture/output_modalities") {
            let values = modalities.as_array().ok_or(AiErrorCode::InvalidResponse)?;
            if !values.iter().any(|value| value.as_str() == Some("text")) {
                continue;
            }
        }
        let label = item
            .get("display_name")
            .or_else(|| item.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty() && name.len() <= 1024)
            .unwrap_or(id);
        result.push(CatalogModel {
            model: id.into(),
            label: label.into(),
            supports_tools: None,
        });
    }
    if value
        .get("has_more")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(AiErrorCode::InvalidResponse);
    }
    let next = if value.get("has_more").and_then(Value::as_bool) == Some(true) {
        Some(
            value
                .get("last_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 4096)
                .ok_or(AiErrorCode::InvalidResponse)?
                .to_owned(),
        )
    } else {
        None
    };
    Ok((result, next))
}

/// Executes the same endpoint policy as chat with bounded, non-redirecting
/// requests. Azure lists deployments via a different management API and is
/// deliberately refused here instead of inventing a generic models endpoint.
pub async fn fetch_catalog(config: &AiConfig) -> Result<Vec<CatalogModel>, AiErrorCode> {
    tokio::time::timeout(Duration::from_secs(45), fetch_catalog_inner(config))
        .await
        .map_err(|_| AiErrorCode::Network)?
}

async fn fetch_catalog_inner(config: &AiConfig) -> Result<Vec<CatalogModel>, AiErrorCode> {
    let mut urls = match config.provider.as_str() {
        "ollama" => {
            let mut url = provider_base_url(config, "http://localhost:11434")
                .map_err(|_| AiErrorCode::InvalidConfiguration)?;
            url.set_path("/api/tags");
            vec![url]
        }
        "openai" => openai_candidate_urls(config)
            .map_err(|_| AiErrorCode::InvalidConfiguration)?
            .into_iter()
            .map(|mut url| {
                let path = url.path().replace("/chat/completions", "/models");
                url.set_path(&path);
                url
            })
            .collect(),
        "anthropic" => {
            let mut url = provider_base_url(config, "https://api.anthropic.com")
                .map_err(|_| AiErrorCode::InvalidConfiguration)?;
            url.set_path("/v1/models");
            vec![url]
        }
        _ => return Err(AiErrorCode::InvalidConfiguration),
    };
    let official_openai = config.provider == "openai"
        && urls.first().and_then(|url| url.host_str()) == Some("api.openai.com");
    let key = clean_key(config);
    if config.provider == "anthropic" && key.is_none() {
        return Err(AiErrorCode::MissingCredential);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AiErrorCode::RequestFailed)?;
    let mut output = Vec::new();
    let mut total_bytes = 0usize;
    let mut ids = HashSet::new();
    let mut cursors = HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut response = None;
        let has_alternative = urls.len() > 1;
        for (index, url) in urls.iter_mut().enumerate() {
            if let Some(cursor) = &cursor {
                url.query_pairs_mut()
                    .clear()
                    .append_pair("after_id", cursor);
            }
            let mut request = client.get(url.clone());
            if let Some(key) = &key {
                request = if config.provider == "anthropic" {
                    request
                        .header("x-api-key", key)
                        .header("anthropic-version", "2023-06-01")
                } else {
                    request.bearer_auth(key)
                };
            }
            let result = request.send().await.map_err(|_| AiErrorCode::Network)?;
            if result.status().as_u16() == 404 && index == 0 && has_alternative {
                continue;
            }
            if !result.status().is_success() {
                return Err(match result.status().as_u16() {
                    401 | 403 | 429 => AiErrorCode::ProviderRejected,
                    _ => AiErrorCode::RequestFailed,
                });
            }
            response = Some(result);
            break;
        }
        let mut stream = response.ok_or(AiErrorCode::RequestFailed)?.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(part) = stream.next().await {
            let part = part.map_err(|_| AiErrorCode::Network)?;
            if bytes.len() + part.len() > MAX_BYTES {
                return Err(AiErrorCode::InvalidResponse);
            }
            bytes.extend_from_slice(&part);
        }
        total_bytes += bytes.len();
        if total_bytes > MAX_BYTES {
            return Err(AiErrorCode::InvalidResponse);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| AiErrorCode::InvalidResponse)?;
        let (models, next) = parse_page(&value, &config.provider, official_openai)?;
        for model in models {
            if ids.insert(model.model.clone()) {
                output.push(model);
            }
            if output.len() > MAX_MODELS {
                return Err(AiErrorCode::InvalidResponse);
            }
        }
        match next {
            None => return Ok(output),
            Some(next) if cursors.insert(next.clone()) => cursor = Some(next),
            _ => return Err(AiErrorCode::InvalidResponse),
        }
    }
    Err(AiErrorCode::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn filters_non_chat_and_retains_unknown_capabilities() {
        let (models, next) = parse_page(&json!({"data":[{"id":"gpt-chat"},{"id":"text-embedding-3"},{"id":"whisper"}],"has_more":true,"last_id":"x"}), "openai", false).unwrap();
        assert_eq!(
            models,
            vec![CatalogModel {
                model: "gpt-chat".into(),
                label: "gpt-chat".into(),
                supports_tools: None
            }]
        );
        assert_eq!(next.as_deref(), Some("x"));
        assert!(parse_page(&json!({"data":[],"has_more":true}), "anthropic", false).is_err());
        assert!(parse_page(&json!({"data":[],"has_more":"bad"}), "anthropic", false).is_err());
        let (official, _) = parse_page(&json!({"data":[{"id":"gpt-5-mini"},{"id":"gpt-5-pro"},{"id":"gpt-5-codex"},{"id":"babbage-002"}]}), "openai", true).unwrap();
        assert_eq!(
            official
                .iter()
                .map(|model| model.model.as_str())
                .collect::<Vec<_>>(),
            ["gpt-5-mini"]
        );
    }
    #[tokio::test]
    async fn requests_paginated_anthropic_catalog_with_authentication() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for page in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 8192];
                let count = socket.read(&mut request).await.unwrap();
                requests.push(String::from_utf8_lossy(&request[..count]).into_owned());
                let body = if page == 0 {
                    r#"{"data":[{"id":"claude-a","display_name":"A"}],"has_more":true,"last_id":"a"}"#
                } else {
                    r#"{"data":[{"id":"claude-b","display_name":"B"}],"has_more":false}"#
                };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
            }
            requests
        });
        let config = AiConfig {
            provider: "anthropic".into(),
            internal_model_id: None,
            model: String::new(),
            base_url: format!("http://{address}"),
            credential_id: None,
            api_key: Some("test-secret".into()),
            max_tokens: None,
            api_version: None,
        };
        let models = fetch_catalog(&config).await.unwrap();
        let requests = server.await.unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.model.as_str())
                .collect::<Vec<_>>(),
            ["claude-a", "claude-b"]
        );
        assert!(requests[0]
            .to_lowercase()
            .contains("x-api-key: test-secret"));
        assert!(requests[0].starts_with("GET /v1/models "));
        assert!(requests[1].starts_with("GET /v1/models?after_id=a "));
    }
    #[tokio::test]
    async fn rejects_bad_status_malformed_and_oversized_without_leaking_response() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body, expected) in [
            (
                "401 Unauthorized",
                "secret in provider response".to_owned(),
                AiErrorCode::ProviderRejected,
            ),
            (
                "200 OK",
                "not json".to_owned(),
                AiErrorCode::InvalidResponse,
            ),
            (
                "200 OK",
                "x".repeat(MAX_BYTES + 1),
                AiErrorCode::InvalidResponse,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 8192];
                let _ = socket.read(&mut request).await;
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
            });
            let config = AiConfig {
                provider: "anthropic".into(),
                internal_model_id: None,
                model: String::new(),
                base_url: format!("http://{address}"),
                credential_id: None,
                api_key: Some("test-secret".into()),
                max_tokens: None,
                api_version: None,
            };
            assert_eq!(fetch_catalog(&config).await.unwrap_err(), expected);
            server.await.unwrap();
        }
    }
}
