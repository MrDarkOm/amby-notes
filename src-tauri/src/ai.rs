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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

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
    pub api_key: Option<String>,
    pub max_tokens: Option<u32>,
    /// Azure only: API version query param.
    pub api_version: Option<String>,
}

fn provider_base(config: &AiConfig, default: &str) -> String {
    let b = config.base_url.trim().trim_end_matches('/');
    if b.is_empty() {
        default.to_string()
    } else {
        b.to_string()
    }
}

fn clean_key(config: &AiConfig) -> Option<String> {
    config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

/** Messages with an optional leading system message (shared by ollama + openai). */
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

async fn chat_ollama(config: &AiConfig, messages: &[AiMessage], system: Option<&str>) -> Result<String, String> {
    let base = provider_base(config, "http://localhost:11434");
    let body = json!({ "model": config.model, "messages": role_messages(messages, system), "stream": false });
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Локальный сервер недоступен ({base}): {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Ollama error {status}: {text}"));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Unexpected Ollama response: {text}"))
}

async fn stream_ollama(
    app: &tauri::AppHandle,
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    stream_id: &str,
) -> Result<String, String> {
    let base = provider_base(config, "http://localhost:11434");
    let body = json!({ "model": config.model, "messages": role_messages(messages, system), "stream": true });
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Локальный сервер недоступен ({base}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("Ollama error {status}: {}", resp.text().await.unwrap_or_default()));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut acc = String::new();
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| e.to_string())?));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(delta) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                    if !delta.is_empty() {
                        acc.push_str(delta);
                        emit_token(app, stream_id, delta);
                    }
                }
            }
        }
    }
    Ok(acc)
}

// ── OpenAI-compatible (also reused by Azure with a different URL/auth) ─────────

async fn chat_openai_like(
    urls: Vec<String>,
    auth: Option<(&'static str, String)>,
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
) -> Result<String, String> {
    let body = json!({
        "model": config.model,
        "messages": role_messages(messages, system),
        "stream": false,
        "max_tokens": config.max_tokens.unwrap_or(1024),
    });
    let last = urls.len().saturating_sub(1);
    let mut last_err = String::from("Нет адреса для запроса");
    for (i, url) in urls.iter().enumerate() {
        let mut req = reqwest::Client::new().post(url).json(&body);
        if let Some((name, value)) = &auth {
            req = req.header(*name, value.clone());
        }
        let resp = req.send().await.map_err(|e| format!("Запрос не удался ({url}): {e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if status.is_success() {
            let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            return v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("Unexpected response: {text}"));
        }
        last_err = format!("Ошибка провайдера {status} ({url}): {text}");
        // Only fall through to the alternate path on 404 (path mismatch).
        if status.as_u16() != 404 || i == last {
            return Err(last_err);
        }
    }
    Err(last_err)
}

async fn stream_openai_like(
    app: &tauri::AppHandle,
    urls: Vec<String>,
    auth: Option<(&'static str, String)>,
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    stream_id: &str,
) -> Result<String, String> {
    let body = json!({
        "model": config.model,
        "messages": role_messages(messages, system),
        "stream": true,
        "max_tokens": config.max_tokens.unwrap_or(1024),
    });
    let last = urls.len().saturating_sub(1);
    let mut last_err = String::from("Нет адреса для запроса");
    let mut chosen: Option<reqwest::Response> = None;
    for (i, url) in urls.iter().enumerate() {
        let mut req = reqwest::Client::new().post(url).json(&body);
        if let Some((name, value)) = &auth {
            req = req.header(*name, value.clone());
        }
        let resp = req.send().await.map_err(|e| format!("Запрос не удался ({url}): {e}"))?;
        if resp.status().is_success() {
            chosen = Some(resp);
            break;
        }
        let status = resp.status();
        last_err = format!("Ошибка провайдера {status} ({url}): {}", resp.text().await.unwrap_or_default());
        if status.as_u16() != 404 || i == last {
            return Err(last_err);
        }
    }
    let resp = match chosen {
        Some(r) => r,
        None => return Err(last_err),
    };
    // OpenAI-style SSE: `data: {choices:[{delta:{content}}]}` … `data: [DONE]`.
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut acc = String::new();
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| e.to_string())?));
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
                        acc.push_str(delta);
                        emit_token(app, stream_id, delta);
                    }
                }
            }
        }
    }
    Ok(acc)
}

fn openai_url(config: &AiConfig) -> String {
    // Tolerate users pasting a full endpoint or a `/v1` suffix into base_url so
    // we don't end up with a doubled path (a common cause of 404s).
    let base = provider_base(config, "https://api.openai.com");
    let base = base
        .trim_end_matches("/chat/completions")
        .trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

/// Candidate chat URLs to try in order. Some local servers (older mlx_lm.server)
/// expose `/chat/completions` without the `/v1` prefix, so we fall back to it on
/// a 404 from the primary `/v1/chat/completions`.
fn openai_urls(config: &AiConfig) -> Vec<String> {
    let primary = openai_url(config);
    let alt = primary.replace("/v1/chat/completions", "/chat/completions");
    if alt != primary {
        vec![primary, alt]
    } else {
        vec![primary]
    }
}

fn openai_auth(config: &AiConfig) -> Option<(&'static str, String)> {
    clean_key(config).map(|k| ("authorization", format!("Bearer {k}")))
}

fn azure_url(config: &AiConfig) -> Result<String, String> {
    let base = config.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Не задан endpoint Azure (https://<resource>.openai.azure.com)".to_string());
    }
    let version = config
        .api_version
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("2024-06-01");
    Ok(format!(
        "{base}/openai/deployments/{}/chat/completions?api-version={version}",
        config.model
    ))
}

fn azure_auth(config: &AiConfig) -> Result<(&'static str, String), String> {
    clean_key(config)
        .map(|k| ("api-key", k))
        .ok_or_else(|| "Не задан API-ключ Azure".to_string())
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

fn anthropic_body(config: &AiConfig, messages: &[AiMessage], system: Option<&str>, stream: bool) -> Value {
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({
        "model": config.model,
        "max_tokens": config.max_tokens.unwrap_or(1024),
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

async fn chat_anthropic(config: &AiConfig, messages: &[AiMessage], system: Option<&str>) -> Result<String, String> {
    let base = provider_base(config, "https://api.anthropic.com");
    let key = clean_key(config).ok_or("Не задан API-ключ Anthropic")?;
    let resp = reqwest::Client::new()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&anthropic_body(config, messages, system, false))
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Anthropic error {status}: {text}"));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
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
        return Err(format!("Unexpected Anthropic response: {text}"));
    }
    Ok(out)
}

async fn stream_anthropic(
    app: &tauri::AppHandle,
    config: &AiConfig,
    messages: &[AiMessage],
    system: Option<&str>,
    stream_id: &str,
) -> Result<String, String> {
    let base = provider_base(config, "https://api.anthropic.com");
    let key = clean_key(config).ok_or("Не задан API-ключ Anthropic")?;
    let resp = reqwest::Client::new()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&anthropic_body(config, messages, system, true))
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("Anthropic error {status}: {}", resp.text().await.unwrap_or_default()));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut acc = String::new();
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| e.to_string())?));
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
                    if let Some(delta) = v.get("delta").and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                        if !delta.is_empty() {
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

// ── Command ───────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn ai_chat(
    app: tauri::AppHandle,
    config: AiConfig,
    messages: Vec<AiMessage>,
    system: Option<String>,
    stream_id: Option<String>,
) -> Result<String, String> {
    let sys = system.as_deref();
    let streaming = stream_id.as_deref();
    let result = match (config.provider.as_str(), streaming) {
        ("anthropic", Some(id)) => stream_anthropic(&app, &config, &messages, sys, id).await,
        ("anthropic", None) => chat_anthropic(&config, &messages, sys).await,
        ("azure", Some(id)) => match (azure_url(&config), azure_auth(&config)) {
            (Ok(url), Ok(auth)) => stream_openai_like(&app, vec![url], Some(auth), &config, &messages, sys, id).await,
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        ("azure", None) => match (azure_url(&config), azure_auth(&config)) {
            (Ok(url), Ok(auth)) => chat_openai_like(vec![url], Some(auth), &config, &messages, sys).await,
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        ("openai", Some(id)) => {
            stream_openai_like(&app, openai_urls(&config), openai_auth(&config), &config, &messages, sys, id).await
        }
        ("openai", None) => {
            chat_openai_like(openai_urls(&config), openai_auth(&config), &config, &messages, sys).await
        }
        (_, Some(id)) => stream_ollama(&app, &config, &messages, sys, id).await,
        (_, None) => chat_ollama(&config, &messages, sys).await,
    };
    if let Some(id) = streaming {
        match &result {
            Ok(_) => { let _ = app.emit("ai:done", json!({ "streamId": id })); }
            Err(e) => { let _ = app.emit("ai:error", json!({ "streamId": id, "error": e })); }
        }
    }
    result
}
