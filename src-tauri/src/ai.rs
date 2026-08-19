//! AI inference, provider-abstracted and routed through Rust so the webview CSP
//! stays locked (`connect-src 'self'`). The backend is stateless: the frontend
//! passes the resolved provider config on each call.
//!
//! Providers are reduced to four wire "families" (`config.provider`):
//!   - "ollama"    — Ollama native chat (default http://localhost:11434)
//!   - "openai"    — OpenAI-compatible /v1/chat/completions (OpenAI, LM Studio,
//!     MLX, llama.cpp, OpenRouter, Groq, Mistral, …)
//!   - "anthropic" — Anthropic Messages API
//!   - "azure"     — Azure OpenAI (deployment in URL, `api-key` header)
//!
//! When `stream_id` is set, token deltas are emitted as `ai:token` events
//! (`{ streamId, delta }`) and the command still returns the full text at the end.
//! Context scope is the caller's responsibility — this module never reads the vault.

use futures_util::StreamExt;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

pub const MAX_MESSAGES_COUNT: usize = 100;
pub const MAX_TOTAL_PROMPT_BYTES: usize = 512 * 1024; // 512 KB
pub const MAX_SYSTEM_PROMPT_BYTES: usize = 128 * 1024; // 128 KB
pub const MAX_TOKENS_LIMIT: u32 = 8192;
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024; // 4 MB
pub const MAX_ERROR_PREVIEW_CHARS: usize = 500;

#[derive(Clone, Default)]
pub struct AiStreamState(pub Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>);

struct StreamGuard {
    stream_id: String,
    state: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.state.lock() {
            map.remove(&self.stream_id);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    /// "user" | "assistant"
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// Wire family: "ollama" | "openai" | "anthropic" | "azure".
    pub provider: String,
    pub model: String,
    /// Empty string falls back to the family's default endpoint.
    pub base_url: String,
    pub credential_id: Option<String>,
    pub api_key: Option<String>,
    pub max_tokens: Option<u32>,
    /// Azure only: API version query param.
    pub api_version: Option<String>,
}

// ── Reusable HTTP Client & URL Policy ────────────────────────────────────────

pub fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = IpAddr::from_str(host) {
        return ip.is_loopback();
    }
    false
}

pub fn validate_ai_url(url: &Url, allow_http: bool) -> Result<(), String> {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("Unsupported scheme: {scheme}"));
    }

    let host = url
        .host_str()
        .ok_or_else(|| "URL is missing a valid host".to_string())?;

    if host.eq_ignore_ascii_case("metadata.google.internal")
        || host.eq_ignore_ascii_case("instance-data")
    {
        return Err("Forbidden cloud metadata endpoint".to_string());
    }

    if let Ok(ip) = IpAddr::from_str(host) {
        match ip {
            IpAddr::V4(ipv4) => {
                if ipv4.is_link_local() {
                    return Err(
                        "Forbidden link-local/metadata address (169.254.0.0/16)".to_string()
                    );
                }
                if ipv4.is_broadcast() || ipv4.is_unspecified() {
                    return Err("Forbidden address (broadcast/unspecified)".to_string());
                }
            }
            IpAddr::V6(ipv6) => {
                if ipv6.is_unicast_link_local() {
                    return Err("Forbidden link-local address (fe80::/10)".to_string());
                }
                if ipv6.is_unspecified() {
                    return Err("Forbidden address (unspecified ::)".to_string());
                }
            }
        }
    }

    let loopback = is_loopback_host(host);
    if scheme == "http" && !allow_http && !loopback {
        return Err(
            "Remote keyed provider must use HTTPS (plain HTTP is only allowed for local loopback services)".to_string()
        );
    }

    Ok(())
}

static AI_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn get_ai_client() -> &'static reqwest::Client {
    AI_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .user_agent("AmbyNotes/0.1.0")
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("Too many redirects");
                }
                if let Err(e) = validate_ai_url(attempt.url(), false) {
                    return attempt.error(e);
                }
                attempt.follow()
            }))
            .build()
            .expect("failed to build AI reqwest client")
    })
}

fn truncate_error(err: &str) -> String {
    let trimmed = err.trim();
    if trimmed.chars().count() <= MAX_ERROR_PREVIEW_CHARS {
        trimmed.to_string()
    } else {
        let truncated: String = trimmed.chars().take(MAX_ERROR_PREVIEW_CHARS).collect();
        format!("{truncated}…")
    }
}

async fn read_bounded_text(resp: reqwest::Response, max_bytes: usize) -> Result<String, String> {
    let mut stream = resp.bytes_stream();
    let mut buf = Vec::new();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| truncate_error(&e.to_string()))?;
        if buf.len() + chunk.len() > max_bytes {
            return Err(format!(
                "Response body exceeded maximum allowed limit ({max_bytes} bytes)"
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|e| format!("Response is not valid UTF-8: {e}"))
}

fn provider_base_url(config: &AiConfig, default: &str) -> Result<Url, String> {
    let raw = config.base_url.trim().trim_end_matches('/');
    let target = if raw.is_empty() { default } else { raw };
    let url = Url::parse(target).map_err(|e| format!("Invalid base URL '{target}': {e}"))?;
    let allow_http = config.provider == "ollama";
    validate_ai_url(&url, allow_http)?;
    Ok(url)
}

fn clean_key(config: &AiConfig) -> Option<String> {
    if let Some(cred_id) = &config.credential_id {
        if let Ok(secret) = crate::credentials::get_credential(cred_id) {
            let trimmed = secret.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

fn role_messages(messages: &[AiMessage], system: Option<&str>) -> Vec<Value> {
    let mut msgs: Vec<Value> = Vec::new();
    if let Some(sys) = system {
        if !sys.trim().is_empty() {
            msgs.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in messages {
        msgs.push(json!({ "role": m.role, "content": m.content }));
    }
    msgs
}

fn emit_token(app: &tauri::AppHandle, stream_id: &str, delta: &str) {
    let _ = app.emit("ai:token", json!({ "streamId": stream_id, "delta": delta }));
}

// ── Ollama (native) ───────────────────────────────────────────────────────────

async fn chat_ollama(
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    mut rx: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let mut base = provider_base_url(config, "http://localhost:11434")?;
    base.set_path("/api/chat");
    let body = json!({ "model": config.model, "messages": role_messages(messages, system), "stream": false });

    let client = get_ai_client();
    let req = client.post(base.as_str()).json(&body);

    let resp = tokio::select! {
        _ = rx.changed() => {
            if *rx.borrow() {
                return Err("Request cancelled".to_string());
            }
            return Err("Request interrupted".to_string());
        }
        res = req.send() => {
            res.map_err(|e| format!("Локальный сервер недоступен ({base}): {}", truncate_error(&e.to_string())))?
        }
    };

    let status = resp.status();
    let text = read_bounded_text(resp, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!("Ollama error {status}: {}", truncate_error(&text)));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| truncate_error(&e.to_string()))?;
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Unexpected Ollama response: {}", truncate_error(&text)))
}

async fn stream_ollama(
    app: &tauri::AppHandle,
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    stream_id: &str,
    mut rx: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let mut base = provider_base_url(config, "http://localhost:11434")?;
    base.set_path("/api/chat");
    let body = json!({ "model": config.model, "messages": role_messages(messages, system), "stream": true });

    let client = get_ai_client();
    let req = client.post(base.as_str()).json(&body);

    let resp = tokio::select! {
        _ = rx.changed() => {
            if *rx.borrow() {
                return Err("Request cancelled".to_string());
            }
            return Err("Request interrupted".to_string());
        }
        res = req.send() => {
            res.map_err(|e| format!("Локальный сервер недоступен ({base}): {}", truncate_error(&e.to_string())))?
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let err_text = read_bounded_text(resp, 4096).await.unwrap_or_default();
        return Err(format!(
            "Ollama error {status}: {}",
            truncate_error(&err_text)
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut acc = String::new();

    loop {
        let chunk_opt = tokio::select! {
            _ = rx.changed() => {
                if *rx.borrow() {
                    return Err("Request cancelled".to_string());
                }
                return Err("Request interrupted".to_string());
            }
            c = stream.next() => c,
        };

        let Some(chunk_res) = chunk_opt else { break };
        let chunk = chunk_res.map_err(|e| truncate_error(&e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(delta) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !delta.is_empty() {
                        if acc.len() + delta.len() > MAX_RESPONSE_BYTES {
                            return Err(format!("Response stream exceeded maximum allowed size ({MAX_RESPONSE_BYTES} bytes)"));
                        }
                        acc.push_str(delta);
                        emit_token(app, stream_id, delta);
                    }
                }
            }
        }
    }
    Ok(acc)
}

// ── OpenAI-compatible (OpenAI, Azure, LM Studio, etc.) ─────────────────────────

fn openai_candidate_urls(config: &AiConfig) -> Result<Vec<Url>, String> {
    let mut base = provider_base_url(config, "https://api.openai.com")?;
    let path = base.path().trim_end_matches('/');
    let primary_path = if path.ends_with("/v1") {
        format!("{path}/chat/completions")
    } else if path.ends_with("/chat/completions") {
        path.to_string()
    } else {
        format!("{path}/v1/chat/completions")
    };

    base.set_path(&primary_path);
    validate_ai_url(&base, false)?;
    let primary = base.clone();

    if primary_path.contains("/v1/chat/completions") {
        let alt_path = primary_path.replace("/v1/chat/completions", "/chat/completions");
        let mut alt = base;
        alt.set_path(&alt_path);
        if let Ok(()) = validate_ai_url(&alt, false) {
            return Ok(vec![primary, alt]);
        }
    }
    Ok(vec![primary])
}

async fn chat_openai_like(
    urls: Vec<Url>,
    auth: Option<(&'static str, String)>,
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    mut rx: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let max_tokens = config.max_tokens.unwrap_or(1024).min(MAX_TOKENS_LIMIT);
    let body = json!({
        "model": config.model,
        "messages": role_messages(messages, system),
        "stream": false,
        "max_tokens": max_tokens,
    });
    let client = get_ai_client();
    let last = urls.len().saturating_sub(1);
    let mut last_err = String::from("Нет адреса для запроса");

    for (i, url) in urls.iter().enumerate() {
        let mut req = client.post(url.as_str()).json(&body);
        if let Some((name, value)) = &auth {
            req = req.header(*name, value.clone());
        }

        let resp = tokio::select! {
            _ = rx.changed() => {
                if *rx.borrow() {
                    return Err("Request cancelled".to_string());
                }
                return Err("Request interrupted".to_string());
            }
            res = req.send() => {
                res.map_err(|e| format!("Запрос не удался ({url}): {}", truncate_error(&e.to_string())))?
            }
        };

        let status = resp.status();
        let text = read_bounded_text(resp, MAX_RESPONSE_BYTES).await?;
        if status.is_success() {
            let v: Value =
                serde_json::from_str(&text).map_err(|e| truncate_error(&e.to_string()))?;
            return v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("Unexpected response: {}", truncate_error(&text)));
        }
        last_err = format!(
            "Ошибка провайдера {status} ({url}): {}",
            truncate_error(&text)
        );
        if status.as_u16() != 404 || i == last {
            return Err(last_err);
        }
    }
    Err(last_err)
}

#[allow(clippy::too_many_arguments)]
async fn stream_openai_like(
    app: &tauri::AppHandle,
    urls: Vec<Url>,
    auth: Option<(&'static str, String)>,
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    stream_id: &str,
    mut rx: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let max_tokens = config.max_tokens.unwrap_or(1024).min(MAX_TOKENS_LIMIT);
    let body = json!({
        "model": config.model,
        "messages": role_messages(messages, system),
        "stream": true,
        "max_tokens": max_tokens,
    });
    let client = get_ai_client();
    let last = urls.len().saturating_sub(1);
    let mut last_err = String::from("Нет адреса для запроса");
    let mut chosen: Option<reqwest::Response> = None;

    for (i, url) in urls.iter().enumerate() {
        let mut req = client.post(url.as_str()).json(&body);
        if let Some((name, value)) = &auth {
            req = req.header(*name, value.clone());
        }

        let resp = tokio::select! {
            _ = rx.changed() => {
                if *rx.borrow() {
                    return Err("Request cancelled".to_string());
                }
                return Err("Request interrupted".to_string());
            }
            res = req.send() => {
                res.map_err(|e| format!("Запрос не удался ({url}): {}", truncate_error(&e.to_string())))?
            }
        };

        if resp.status().is_success() {
            chosen = Some(resp);
            break;
        }
        let status = resp.status();
        let err_text = read_bounded_text(resp, 4096).await.unwrap_or_default();
        last_err = format!(
            "Ошибка провайдера {status} ({url}): {}",
            truncate_error(&err_text)
        );
        if status.as_u16() != 404 || i == last {
            return Err(last_err);
        }
    }

    let resp = match chosen {
        Some(r) => r,
        None => return Err(last_err),
    };

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut acc = String::new();

    loop {
        let chunk_opt = tokio::select! {
            _ = rx.changed() => {
                if *rx.borrow() {
                    return Err("Request cancelled".to_string());
                }
                return Err("Request interrupted".to_string());
            }
            c = stream.next() => c,
        };

        let Some(chunk_res) = chunk_opt else { break };
        let chunk = chunk_res.map_err(|e| truncate_error(&e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim_end();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(delta) = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !delta.is_empty() {
                        if acc.len() + delta.len() > MAX_RESPONSE_BYTES {
                            return Err(format!("Response stream exceeded maximum allowed size ({MAX_RESPONSE_BYTES} bytes)"));
                        }
                        acc.push_str(delta);
                        emit_token(app, stream_id, delta);
                    }
                }
            }
        }
    }
    Ok(acc)
}

fn openai_auth(config: &AiConfig) -> Option<(&'static str, String)> {
    clean_key(config).map(|k| ("authorization", format!("Bearer {k}")))
}

fn azure_url(config: &AiConfig) -> Result<Url, String> {
    let mut base = provider_base_url(config, "")?;
    let version = config
        .api_version
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("2024-06-01");
    let path = format!("/openai/deployments/{}/chat/completions", config.model);
    base.set_path(&path);
    base.set_query(Some(&format!("api-version={version}")));
    validate_ai_url(&base, false)?;
    Ok(base)
}

fn azure_auth(config: &AiConfig) -> Result<(&'static str, String), String> {
    clean_key(config)
        .map(|k| ("api-key", k))
        .ok_or_else(|| "Не задан API-ключ Azure".to_string())
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

fn anthropic_body(
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    stream: bool,
) -> Value {
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let max_tokens = config.max_tokens.unwrap_or(1024).min(MAX_TOKENS_LIMIT);
    let mut body = json!({
        "model": config.model,
        "max_tokens": max_tokens,
        "messages": msgs,
        "stream": stream,
    });
    if let Some(sys) = system {
        if !sys.trim().is_empty() {
            body["system"] = json!(sys);
        }
    }
    body
}

async fn chat_anthropic(
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    mut rx: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let mut base = provider_base_url(config, "https://api.anthropic.com")?;
    base.set_path("/v1/messages");
    let key = clean_key(config).ok_or("Не задан API-ключ Anthropic")?;
    let client = get_ai_client();
    let req = client
        .post(base.as_str())
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&anthropic_body(config, messages, system, false));

    let resp = tokio::select! {
        _ = rx.changed() => {
            if *rx.borrow() {
                return Err("Request cancelled".to_string());
            }
            return Err("Request interrupted".to_string());
        }
        res = req.send() => {
            res.map_err(|e| format!("Anthropic request failed: {}", truncate_error(&e.to_string())))?
        }
    };

    let status = resp.status();
    let text = read_bounded_text(resp, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "Anthropic error {status}: {}",
            truncate_error(&text)
        ));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| truncate_error(&e.to_string()))?;
    let out: String = v
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if out.is_empty() {
        return Err(format!(
            "Unexpected Anthropic response: {}",
            truncate_error(&text)
        ));
    }
    Ok(out)
}

async fn stream_anthropic(
    app: &tauri::AppHandle,
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    stream_id: &str,
    mut rx: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let mut base = provider_base_url(config, "https://api.anthropic.com")?;
    base.set_path("/v1/messages");
    let key = clean_key(config).ok_or("Не задан API-ключ Anthropic")?;
    let client = get_ai_client();
    let req = client
        .post(base.as_str())
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&anthropic_body(config, messages, system, true));

    let resp = tokio::select! {
        _ = rx.changed() => {
            if *rx.borrow() {
                return Err("Request cancelled".to_string());
            }
            return Err("Request interrupted".to_string());
        }
        res = req.send() => {
            res.map_err(|e| format!("Anthropic request failed: {}", truncate_error(&e.to_string())))?
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let err_text = read_bounded_text(resp, 4096).await.unwrap_or_default();
        return Err(format!(
            "Anthropic error {status}: {}",
            truncate_error(&err_text)
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut acc = String::new();

    loop {
        let chunk_opt = tokio::select! {
            _ = rx.changed() => {
                if *rx.borrow() {
                    return Err("Request cancelled".to_string());
                }
                return Err("Request interrupted".to_string());
            }
            c = stream.next() => c,
        };

        let Some(chunk_res) = chunk_opt else { break };
        let chunk = chunk_res.map_err(|e| truncate_error(&e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim_end();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if v.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                    if let Some(delta) = v
                        .get("delta")
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str())
                    {
                        if !delta.is_empty() {
                            if acc.len() + delta.len() > MAX_RESPONSE_BYTES {
                                return Err(format!("Response stream exceeded maximum allowed size ({MAX_RESPONSE_BYTES} bytes)"));
                            }
                            acc.push_str(delta);
                            emit_token(app, stream_id, delta);
                        }
                    }
                }
            }
        }
    }
    Ok(acc)
}

// ── Commands ───────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn cancel_ai_request(
    state: tauri::State<AiStreamState>,
    stream_id: String,
) -> Result<bool, String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = map.remove(&stream_id) {
        let _ = tx.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn ai_chat(
    app: tauri::AppHandle,
    state: tauri::State<'_, AiStreamState>,
    config: AiConfig,
    messages: Vec<AiMessage>,
    system: Option<String>,
    stream_id: Option<String>,
) -> Result<String, String> {
    // 1. Validate payload limits
    if messages.len() > MAX_MESSAGES_COUNT {
        return Err(format!(
            "Messages count ({}) exceeds maximum limit ({MAX_MESSAGES_COUNT})",
            messages.len()
        ));
    }
    let total_prompt_bytes: usize = messages.iter().map(|m| m.content.len()).sum();
    if total_prompt_bytes > MAX_TOTAL_PROMPT_BYTES {
        return Err(format!(
            "Total prompt bytes ({total_prompt_bytes}) exceeds limit ({MAX_TOTAL_PROMPT_BYTES})"
        ));
    }
    if let Some(sys) = &system {
        if sys.len() > MAX_SYSTEM_PROMPT_BYTES {
            return Err(format!(
                "System prompt bytes ({}) exceeds limit ({MAX_SYSTEM_PROMPT_BYTES})",
                sys.len()
            ));
        }
    }

    // 2. Setup cancellation watch
    let (tx, rx) = tokio::sync::watch::channel(false);
    let active_id = stream_id
        .clone()
        .unwrap_or_else(|| ulid::Ulid::generate().to_string());
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(active_id.clone(), tx);
    }
    let _guard = StreamGuard {
        stream_id: active_id.clone(),
        state: state.0.clone(),
    };

    let sys = system.as_deref();
    let streaming = stream_id.as_deref();
    let result = match (config.provider.as_str(), streaming) {
        ("anthropic", Some(id)) => stream_anthropic(&app, &config, &messages, sys, id, rx).await,
        ("anthropic", None) => chat_anthropic(&config, &messages, sys, rx).await,
        ("azure", Some(id)) => match (azure_url(&config), azure_auth(&config)) {
            (Ok(url), Ok(auth)) => {
                stream_openai_like(&app, vec![url], Some(auth), &config, &messages, sys, id, rx)
                    .await
            }
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        ("azure", None) => match (azure_url(&config), azure_auth(&config)) {
            (Ok(url), Ok(auth)) => {
                chat_openai_like(vec![url], Some(auth), &config, &messages, sys, rx).await
            }
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        ("openai", Some(id)) => match openai_candidate_urls(&config) {
            Ok(urls) => {
                stream_openai_like(
                    &app,
                    urls,
                    openai_auth(&config),
                    &config,
                    &messages,
                    sys,
                    id,
                    rx,
                )
                .await
            }
            Err(e) => Err(e),
        },
        ("openai", None) => match openai_candidate_urls(&config) {
            Ok(urls) => {
                chat_openai_like(urls, openai_auth(&config), &config, &messages, sys, rx).await
            }
            Err(e) => Err(e),
        },
        (_, Some(id)) => stream_ollama(&app, &config, &messages, sys, id, rx).await,
        (_, None) => chat_ollama(&config, &messages, sys, rx).await,
    };

    if let Some(id) = streaming {
        match &result {
            Ok(_) => {
                let _ = app.emit("ai:done", json!({ "streamId": id }));
            }
            Err(e) => {
                let _ = app.emit("ai:error", json!({ "streamId": id, "error": e }));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_policy_allowed() {
        let u1 = Url::parse("http://localhost:11434").unwrap();
        assert!(validate_ai_url(&u1, true).is_ok());

        let u2 = Url::parse("http://127.0.0.1:1234").unwrap();
        assert!(validate_ai_url(&u2, true).is_ok());

        let u3 = Url::parse("http://[::1]:8080").unwrap();
        assert!(validate_ai_url(&u3, true).is_ok());

        let u4 = Url::parse("https://api.openai.com/v1").unwrap();
        assert!(validate_ai_url(&u4, false).is_ok());

        let u5 = Url::parse("https://api.anthropic.com").unwrap();
        assert!(validate_ai_url(&u5, false).is_ok());
    }

    #[test]
    fn test_url_policy_rejected_schemes_and_metadata() {
        // Plain HTTP for remote keyed provider
        let u1 = Url::parse("http://api.openai.com/v1").unwrap();
        assert!(validate_ai_url(&u1, false).is_err());

        // Forbidden link-local
        let u2 = Url::parse("http://169.254.169.254/latest/meta-data").unwrap();
        assert!(validate_ai_url(&u2, true).is_err());

        // Cloud metadata domain
        let u3 = Url::parse("http://metadata.google.internal/computeMetadata/v1").unwrap();
        assert!(validate_ai_url(&u3, true).is_err());

        // Unsupported scheme
        let u4 = Url::parse("file:///etc/passwd").unwrap();
        assert!(validate_ai_url(&u4, true).is_err());
    }

    #[test]
    fn test_truncate_error() {
        let short = "Simple error";
        assert_eq!(truncate_error(short), "Simple error");

        let long = "a".repeat(1000);
        let trunc = truncate_error(&long);
        assert!(trunc.len() < 600);
        assert!(trunc.ends_with('…'));
    }
}
