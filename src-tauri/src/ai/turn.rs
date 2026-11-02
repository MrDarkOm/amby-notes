//! One read-only AI turn: provider calls and tool execution stay in Rust.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Emitter;

use super::chats::{ChatSource, ChatStep};
use super::provider_stream::{StreamDecoder, ToolCall};
use super::tools::{ToolBudget, ToolScope};
use super::{AiChatError, AiConfig, AiErrorCode, AiMessage, AiStreamState, StreamGuard};
use crate::vault_context::VaultContext;

#[derive(Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiTurnRequest {
    pub generation: u64,
    pub config: AiConfig,
    pub messages: Vec<AiMessage>,
    pub system: Option<String>,
    pub note_ids: Vec<String>,
    pub folders: Vec<String>,
    pub initial_sources: Vec<ChatSource>,
    pub search_enabled: bool,
    pub supports_tools: bool,
    pub stream_id: String,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiTurnResult {
    pub content: String,
    pub steps: Vec<ChatStep>,
    pub sources: Vec<ChatSource>,
}

fn error(provider: &str, code: AiErrorCode) -> AiChatError {
    AiChatError {
        provider: provider.into(),
        code,
    }
}

fn active(context: &VaultContext, generation: u64) -> bool {
    context
        .generation()
        .is_ok_and(|current| current == generation)
}

fn turn_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .no_proxy()
            // An endpoint approved as local must not redirect note text or credentials elsewhere.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("AI HTTP client")
    })
}

fn check(
    context: &VaultContext,
    generation: u64,
    rx: &tokio::sync::watch::Receiver<bool>,
) -> Result<(), &'static str> {
    if *rx.borrow() || !active(context, generation) {
        Err("cancelled")
    } else {
        Ok(())
    }
}

fn definitions(search: bool, anthropic: bool) -> Vec<Value> {
    let mut defs = vec![
        (
            "read_note",
            "Read a note by ID. Offset and maxChars count Unicode characters.",
            json!({"type":"object","properties":{"id":{"type":"string"},"offset":{"type":"integer","minimum":0},"maxChars":{"type":"integer","minimum":1,"maximum":20000}},"required":["id"]}),
        ),
        (
            "get_links",
            "Find outgoing and incoming links for a note.",
            json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}),
        ),
    ];
    if search {
        defs.extend([
            ("search_notes", "Search the vault's indexed notes.", json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":10}},"required":["query"]})),
            ("list_folder", "List notes in a vault-relative folder. Empty path means the vault root.", json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})),
        ]);
    }
    defs.into_iter().map(|(name, description, schema)| {
        if anthropic { json!({"name":name,"description":description,"input_schema":schema}) }
        else { json!({"type":"function","function":{"name":name,"description":description,"parameters":schema}}) }
    }).collect()
}

fn initial_messages(family: &str, messages: &[AiMessage], system: Option<&str>) -> Vec<Value> {
    let mut result = Vec::new();
    if family != "anthropic" {
        if let Some(text) = system.filter(|text| !text.is_empty()) {
            result.push(json!({"role":"system","content":text}));
        }
    }
    result.extend(
        messages
            .iter()
            .map(|message| json!({"role":message.role,"content":message.content})),
    );
    result
}

fn request_body(
    config: &AiConfig,
    messages: &[Value],
    system: Option<&str>,
    tools: bool,
    search: bool,
) -> Value {
    let anthropic = config.provider == "anthropic";
    let mut body = json!({"model": config.model, "messages": messages, "stream": true});
    if config.provider == "anthropic" {
        body["max_tokens"] = json!(config
            .max_tokens
            .unwrap_or(1024)
            .min(super::MAX_TOKENS_LIMIT));
    } else if config.provider != "ollama" {
        super::set_openai_token_limit(&mut body, config);
    }
    if anthropic {
        if let Some(system) = system.filter(|value| !value.is_empty()) {
            body["system"] = json!(system);
        }
    }
    if tools {
        body["tools"] = json!(definitions(search, anthropic));
    }
    body
}

fn append_exchange(
    family: &str,
    messages: &mut Vec<Value>,
    text: &str,
    thinking: &str,
    calls: &[ToolCall],
    results: &[Value],
) {
    if family == "anthropic" {
        let mut content = Vec::new();
        if !text.is_empty() {
            content.push(json!({"type":"text","text":text}));
        }
        content.extend(calls.iter().map(
            |call| json!({"type":"tool_use","id":call.id,"name":call.name,"input":call.arguments}),
        ));
        messages.push(json!({"role":"assistant","content":content}));
        let outputs: Vec<Value> = calls.iter().zip(results).map(|(call, result)| json!({"type":"tool_result","tool_use_id":call.id,"content":result.to_string()})).collect();
        messages.push(json!({"role":"user","content":outputs}));
    } else {
        let calls_wire: Vec<Value> = calls.iter().enumerate().map(|(index, call)| {
            if family == "ollama" { json!({"type":"function","function":{"index":index,"name":call.name,"arguments":call.arguments}}) }
            else { json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}}) }
        }).collect();
        let mut assistant = json!({"role":"assistant","content":text,"tool_calls":calls_wire});
        if family == "ollama" && !thinking.is_empty() {
            assistant["thinking"] = json!(thinking);
        }
        messages.push(assistant);
        for (call, result) in calls.iter().zip(results) {
            messages.push(if family == "ollama" {
                json!({"role":"tool","tool_name":call.name,"content":result.to_string()})
            } else {
                json!({"role":"tool","tool_call_id":call.id,"content":result.to_string()})
            });
        }
    }
}

fn unsupported_tools_response(body: &str) -> bool {
    let text = body.to_ascii_lowercase();
    text.contains("tool")
        && (text.contains("not support")
            || text.contains("unsupported")
            || text.contains("not supported")
            || text.contains("unknown parameter")
            || text.contains("unrecognized"))
}

struct Events<'a> {
    app: &'a tauri::AppHandle,
    stream_id: &'a str,
    sequence: u64,
}
impl Events<'_> {
    fn emit(&mut self, kind: &str, payload: Value) {
        self.sequence += 1;
        let _ = self.app.emit("ai:event", json!({"streamId":self.stream_id,"sequence":self.sequence,"kind":kind,"payload":payload}));
    }
}

struct ProviderRound<'a> {
    context: &'a VaultContext,
    generation: u64,
    config: &'a AiConfig,
    messages: &'a [Value],
    system: Option<&'a str>,
    tools: bool,
    search: bool,
}

async fn provider_round(
    round: ProviderRound<'_>,
    rx: &mut tokio::sync::watch::Receiver<bool>,
    events: &mut Events<'_>,
) -> Result<(String, Vec<ToolCall>, String), &'static str> {
    let ProviderRound {
        context,
        generation,
        config,
        messages,
        system,
        tools,
        search,
    } = round;
    check(context, generation, rx)?;
    let family = config.provider.as_str();
    let (urls, auth): (Vec<reqwest::Url>, Option<(&str, String)>) = match family {
        "anthropic" => {
            let mut url = super::provider_base_url(config, "https://api.anthropic.com")
                .map_err(|_| "invalidConfiguration")?;
            url.set_path("/v1/messages");
            let key = super::clean_key(config).ok_or("missingCredential")?;
            (vec![url], Some(("x-api-key", key)))
        }
        "azure" => (
            vec![super::azure_url(config).map_err(|_| "invalidConfiguration")?],
            Some(super::azure_auth(config).map_err(|_| "missingCredential")?),
        ),
        "openai" => (
            super::openai_candidate_urls(config).map_err(|_| "invalidConfiguration")?,
            super::openai_auth(config),
        ),
        "ollama" => {
            let mut url = super::provider_base_url(config, "http://localhost:11434")
                .map_err(|_| "invalidConfiguration")?;
            url.set_path("/api/chat");
            (vec![url], None)
        }
        _ => return Err("invalidConfiguration"),
    };
    let body = request_body(config, messages, system, tools, search);
    let mut response = None;
    for (index, url) in urls.iter().enumerate() {
        let mut request = turn_client().post(url.clone()).json(&body);
        if let Some((name, value)) = &auth {
            request = request.header(*name, value);
        }
        if family == "anthropic" {
            request = request.header("anthropic-version", "2023-06-01");
        }
        let pending = request.send();
        tokio::pin!(pending);
        let mut timer = tokio::time::interval(Duration::from_millis(100));
        let reply = loop {
            tokio::select! {
                _ = rx.changed() => return Err("cancelled"),
                _ = timer.tick() => check(context, generation, rx)?,
                result = &mut pending => break result.map_err(|_| "network")?,
            }
        };
        check(context, generation, rx)?;
        if reply.status().is_success() {
            response = Some(reply);
            break;
        }
        if reply.status().as_u16() == 404 && index + 1 < urls.len() {
            continue;
        }
        let status = reply.status().as_u16();
        if status == 400 && tools {
            // Inspect a bounded body locally, but never return or log it: it may
            // contain echoed note text or credentials.
            let body = super::read_bounded_text(reply, 16 * 1024);
            tokio::pin!(body);
            let mut timer = tokio::time::interval(Duration::from_millis(100));
            let unsupported = loop {
                tokio::select! {
                    _ = rx.changed() => return Err("cancelled"),
                    _ = timer.tick() => check(context, generation, rx)?,
                    result = &mut body => break result.is_ok_and(|text| unsupported_tools_response(&text)),
                }
            };
            if unsupported {
                return Err("toolsUnsupported");
            }
            return Err("requestFailed");
        }
        return Err(match status {
            401 | 403 | 429 => "providerRejected",
            _ => "requestFailed",
        });
    }
    let mut stream = response.ok_or("requestFailed")?.bytes_stream();
    let mut decoder = StreamDecoder::new(family);
    let mut emitted_bytes = 0usize;
    let mut timer = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            _ = rx.changed() => return Err("cancelled"),
            _ = timer.tick() => check(context, generation, rx)?,
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break };
                check(context, generation, rx)?;
                let delta = decoder.push(&chunk.map_err(|_| "network")?).map_err(|_| "invalidResponse")?;
                if !delta.is_empty() { emitted_bytes += delta.len(); events.emit("token", json!({"delta":delta})); }
            }
        }
    }
    let (text, calls, thinking) = decoder.finish().map_err(|_| "invalidResponse")?;
    check(context, generation, rx)?;
    if emitted_bytes < text.len() {
        events.emit("token", json!({"delta":&text[emitted_bytes..]}));
    }
    Ok((text, calls, thinking))
}

fn safe_code(code: &str) -> AiErrorCode {
    match code {
        "cancelled" => AiErrorCode::Cancelled,
        "missingCredential" => AiErrorCode::MissingCredential,
        "invalidConfiguration" => AiErrorCode::InvalidConfiguration,
        "providerRejected" => AiErrorCode::ProviderRejected,
        "toolsUnsupported" => AiErrorCode::ToolsUnsupported,
        "invalidResponse" => AiErrorCode::InvalidResponse,
        "network" => AiErrorCode::Network,
        _ => AiErrorCode::RequestFailed,
    }
}

/// Provider-independent state machine. The same transition is driven by a
/// scripted provider in tests and by the network provider in production.
struct TurnEngine {
    family: String,
    messages: Vec<Value>,
    budget: ToolBudget,
    content: String,
    steps: Vec<ChatStep>,
    sources: Vec<ChatSource>,
    seen_sources: HashSet<String>,
}

impl TurnEngine {
    fn new(family: &str, messages: Vec<Value>, sources: Vec<ChatSource>) -> Self {
        let seen_sources = sources.iter().map(|source| source.id.clone()).collect();
        Self {
            family: family.into(),
            messages,
            budget: ToolBudget::default(),
            content: String::new(),
            steps: Vec::new(),
            sources,
            seen_sources,
        }
    }

    fn accept(
        &mut self,
        text: String,
        calls: Vec<ToolCall>,
        thinking: String,
        tools_offered: bool,
        mut execute: impl FnMut(&mut ToolBudget, &ToolCall) -> Result<Value, &'static str>,
        mut emit: impl FnMut(&str, Value),
    ) -> Result<bool, &'static str> {
        self.content.push_str(&text);
        if self.content.len() > super::MAX_RESPONSE_BYTES {
            return Err("invalidResponse");
        }
        if calls.is_empty() {
            if text.trim().is_empty() {
                return Err("invalidResponse");
            }
            return Ok(true);
        }
        if !tools_offered {
            return Err("invalidResponse");
        }
        let mut results = Vec::new();
        for call in &calls {
            results.push(self.run_call(call, &mut execute, &mut emit)?);
        }
        append_exchange(
            &self.family,
            &mut self.messages,
            &text,
            &thinking,
            &calls,
            &results,
        );
        Ok(false)
    }

    /// One tool call: announce it, run it, collect its citation, source and step.
    fn run_call(
        &mut self,
        call: &ToolCall,
        execute: &mut impl FnMut(&mut ToolBudget, &ToolCall) -> Result<Value, &'static str>,
        emit: &mut impl FnMut(&str, Value),
    ) -> Result<Value, &'static str> {
        let query = call
            .arguments
            .get("query")
            .or_else(|| call.arguments.get("path"))
            .or_else(|| call.arguments.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(1024)
            .collect::<String>();
        emit("toolStart", json!({"tool":call.name,"query":query}));
        let mut value = execute(&mut self.budget, call)?;
        let mut ids: Vec<String> = value
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|note| note.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        let mut source = None;
        if call.name == "read_note" {
            if let (Some(id), Some(title)) = (
                value.get("id").and_then(Value::as_str).map(str::to_owned),
                value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ) {
                ids.push(id.clone());
                if self.seen_sources.insert(id.clone()) {
                    source = Some(json!({"id":id,"title":title}));
                    self.sources.push(ChatSource {
                        id: id.clone(),
                        title,
                    });
                }
                let citation = self
                    .sources
                    .iter()
                    .position(|item| item.id == id)
                    .unwrap_or(0)
                    + 1;
                value["citation"] = json!(citation);
            }
        }
        emit(
            "toolEnd",
            json!({"tool":call.name,"query":query,"noteIds":ids,"source":source,"error":value.get("error")}),
        );
        self.steps.push(ChatStep {
            tool: call.name.clone(),
            query,
            note_ids: ids,
            error: value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
        Ok(value)
    }

    fn finish(self) -> AiTurnResult {
        AiTurnResult {
            content: self.content,
            steps: self.steps,
            sources: self.sources,
        }
    }
}

/// The read-only tools as an MCP server describes them (the same set the other providers get).
fn mcp_tools(search: bool) -> Vec<Value> {
    definitions(search, false)
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool["function"]["name"],
                "description": tool["function"]["description"],
                "inputSchema": tool["function"]["parameters"],
                "annotations": {"readOnlyHint": true, "openWorldHint": false, "destructiveHint": false}
            })
        })
        .collect()
}

/// Turn events from more than one task (the answer's tokens and the tool bridge) share one
/// sequence, so the renderer sees them in order.
struct SharedEvents {
    app: tauri::AppHandle,
    stream_id: String,
    sequence: std::sync::atomic::AtomicU64,
}

impl SharedEvents {
    fn emit(&self, kind: &str, payload: Value) {
        let sequence = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let _ = self.app.emit(
            "ai:event",
            json!({"streamId":self.stream_id,"sequence":sequence,"kind":kind,"payload":payload}),
        );
    }
}

/// Amby's own tools for Codex: the same scoped, budgeted, read-only vault access the other
/// providers get, with steps and sources recorded by the same engine.
struct VaultToolHost {
    app: tauri::AppHandle,
    generation: u64,
    search: bool,
    scope: ToolScope,
    engine: std::sync::Mutex<TurnEngine>,
    events: std::sync::Arc<SharedEvents>,
    cancel: tokio::sync::watch::Receiver<bool>,
}

impl super::codex::mcp::ToolHost for VaultToolHost {
    fn tools(&self) -> Vec<Value> {
        mcp_tools(self.search)
    }

    fn call(&self, name: &str, arguments: &Value) -> Value {
        use tauri::Manager;
        let context = self.app.state::<VaultContext>();
        let call = ToolCall {
            id: String::new(),
            name: name.to_owned(),
            arguments: arguments.clone(),
        };
        let Ok(mut engine) = self.engine.lock() else {
            return json!({"error": "requestFailed"});
        };
        let rx = &self.cancel;
        engine
            .run_call(
                &call,
                &mut |budget, call| {
                    check(&context, self.generation, rx)?;
                    let active = context.conn.lock().map_err(|_| "requestFailed")?;
                    let active = active.as_ref().ok_or("cancelled")?;
                    if active.generation != self.generation {
                        return Err("cancelled");
                    }
                    let index = match super::index_snapshot::open(&active.root, || *rx.borrow()) {
                        Ok(index) => index,
                        Err("cancelled") => return Err("cancelled"),
                        Err(code) => return Ok(budget.reject(code)),
                    };
                    Ok(budget.execute(
                        &index,
                        &active.root,
                        &self.scope,
                        &call.name,
                        &call.arguments,
                    ))
                },
                &mut |kind, payload| self.events.emit(kind, payload),
            )
            .unwrap_or_else(|code| json!({"error": code}))
    }
}

/// Agent mode: the conversation goes to Amby's isolated Codex or Claude Code, which can reach
/// the vault only through Amby's own tools (see ai/codex/ and ai/claude_code/).
async fn cli_agent_turn(
    app: tauri::AppHandle,
    context: &VaultContext,
    request: &AiTurnRequest,
    rx: &tokio::sync::watch::Receiver<bool>,
) -> Result<AiTurnResult, AiChatError> {
    use super::codex::mcp::McpServer;
    let provider = request.config.provider.as_str();
    let claude = provider == "claude-code";
    let fail = |code: AiErrorCode| AiChatError {
        code,
        provider: provider.to_owned(),
    };
    let events = std::sync::Arc::new(SharedEvents {
        app: app.clone(),
        stream_id: request.stream_id.clone(),
        sequence: std::sync::atomic::AtomicU64::new(0),
    });
    let result = async {
        let root = crate::app_data::app_root(&app).map_err(|_| AiErrorCode::Network)?;
        let search = request.search_enabled && request.supports_tools;
        let host = std::sync::Arc::new(VaultToolHost {
            app: app.clone(),
            generation: request.generation,
            search,
            scope: ToolScope {
                search_enabled: search,
                note_ids: request.note_ids.iter().cloned().collect(),
                folders: request.folders.clone(),
            },
            engine: std::sync::Mutex::new(TurnEngine::new(
                provider,
                Vec::new(),
                request.initial_sources.clone(),
            )),
            events: events.clone(),
            cancel: rx.clone(),
        });
        let text = if claude {
            use super::claude_code::{self as cc, home::prepare_home, launch};
            let code = |error: cc::ClaudeError| cc::error_code(&error);
            let binary = launch::find_binary().ok_or(AiErrorCode::InvalidConfiguration)?;
            let _only_one = cc::CLAUDE_HOME_LOCK.lock().await;
            let server = McpServer::start(host.clone())
                .await
                .map_err(|_| AiErrorCode::Network)?;
            let outcome = async {
                let home = prepare_home(&root)?.with_bridge_token(server.token.clone());
                launch::run_claude_turn(
                    &binary,
                    &home,
                    &launch::TurnRequest {
                        bridge_port: server.addr.port(),
                        search,
                        messages: &request.messages,
                        system: request.system.as_deref(),
                        model: Some(request.config.model.as_str()),
                    },
                    rx.clone(),
                    |delta| events.emit("token", json!({"delta":delta})),
                )
                .await
            }
            .await;
            server.stop().await;
            outcome.map_err(code)?
        } else {
            use super::codex::{self, agent::run_agent_turn, launch::find_binary};
            let code = |error: codex::CodexError| codex::error_code(&error);
            let binary = find_binary().ok_or(AiErrorCode::InvalidConfiguration)?;
            let _only_one = codex::CODEX_HOME_LOCK.lock().await;
            let server = McpServer::start(host.clone())
                .await
                .map_err(|_| AiErrorCode::Network)?;
            let outcome = async {
                let home = codex::home::prepare_home_with_bridge(&root, server.addr.port())?
                    .with_bridge_token(server.token.clone());
                run_agent_turn(
                    &binary,
                    &home,
                    &request.messages,
                    request.system.as_deref(),
                    Some(request.config.model.as_str()),
                    rx.clone(),
                    |delta| events.emit("token", json!({"delta":delta})),
                )
                .await
            }
            .await;
            server.stop().await;
            // Drop the bridge's port from the configuration again, whatever happened.
            let _ = codex::home::prepare_home(&root);
            outcome.map_err(code)?.text
        };
        if !active(context, request.generation) {
            return Err(AiErrorCode::Cancelled);
        }
        let (steps, sources) = host
            .engine
            .lock()
            .map(|engine| (engine.steps.clone(), engine.sources.clone()))
            .map_err(|_| AiErrorCode::Network)?;
        Ok(AiTurnResult {
            content: text,
            steps,
            sources,
        })
    }
    .await
    .map_err(fail);
    match &result {
        Ok(_) => events.emit("done", json!({})),
        Err(payload) => events.emit("error", json!({"error":payload})),
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn ai_run_turn(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    state: tauri::State<'_, AiStreamState>,
    mut request: AiTurnRequest,
) -> Result<AiTurnResult, AiChatError> {
    let provider = request.config.provider.clone();
    let fail = |code| error(&provider, code);
    let root = crate::app_data::app_root(&app).map_err(|_| fail(AiErrorCode::RequestFailed))?;
    let captured_key = super::connections::capture_selected_credential(
        &root,
        &request.config,
        request.supports_tools,
    )
    .map_err(|_| fail(AiErrorCode::InvalidConfiguration))?;
    request.config.api_key = if !super::is_cli_provider(&request.config.provider)
        && request.config.credential_id.is_some()
    {
        Some(captured_key.unwrap_or_default())
    } else {
        captured_key
    };
    if request.stream_id.len() > 128
        || request.stream_id.is_empty()
        || request.messages.len() > super::MAX_MESSAGES_COUNT
        || request
            .messages
            .iter()
            .any(|m| m.role != "user" && m.role != "assistant")
        || request
            .messages
            .iter()
            .map(|m| m.content.len())
            .sum::<usize>()
            > super::MAX_TOTAL_PROMPT_BYTES
        || request
            .system
            .as_ref()
            .is_some_and(|value| value.len() > super::MAX_SYSTEM_PROMPT_BYTES)
        || request.note_ids.len() > 512
        || request.folders.len() > 128
        || request.initial_sources.len() > 512
        || request
            .initial_sources
            .iter()
            .any(|source| source.id.len() > 512 || source.title.len() > 4096)
    {
        return Err(fail(AiErrorCode::InvalidConfiguration));
    }
    if !active(&context, request.generation) {
        return Err(fail(AiErrorCode::Cancelled));
    }
    // Agent mode sends the whole conversation to ChatGPT, so it always needs consent.
    let codex = super::is_cli_provider(&provider);
    let mut codex_root = None;
    if codex || (request.search_enabled && request.supports_tools) {
        let active = context
            .conn
            .lock()
            .map_err(|_| fail(AiErrorCode::RequestFailed))?;
        let active = active
            .as_ref()
            .ok_or_else(|| fail(AiErrorCode::Cancelled))?;
        if active.generation != request.generation {
            return Err(fail(AiErrorCode::Cancelled));
        }
        match super::consent::status(&active.root, &request.config) {
            Ok("allowed" | "local") => (),
            Ok(_) => return Err(fail(AiErrorCode::PrivacyConsentRequired)),
            Err(_) => return Err(fail(AiErrorCode::RequestFailed)),
        }
        codex_root = Some(active.root.clone());
    }
    let mut rx = state
        .register(&request.stream_id)
        .map_err(|code| fail(safe_code(code)))?;
    let _guard = StreamGuard {
        stream_id: request.stream_id.clone(),
        state: state.0.clone(),
    };
    if codex && codex_root.is_some() {
        return cli_agent_turn(app.clone(), &context, &request, &rx).await;
    }
    let mut events = Events {
        app: &app,
        stream_id: &request.stream_id,
        sequence: 0,
    };
    let scope = ToolScope {
        search_enabled: request.search_enabled && request.supports_tools,
        note_ids: request.note_ids.iter().cloned().collect(),
        folders: request.folders.clone(),
    };
    let mut engine = TurnEngine::new(
        &provider,
        initial_messages(&provider, &request.messages, request.system.as_deref()),
        request.initial_sources.clone(),
    );
    let result: Result<(), &'static str> = async {
        loop {
            let allow_tools = request.supports_tools && !engine.budget.exhausted();
            let (text, calls, thinking) = provider_round(
                ProviderRound {
                    context: &context,
                    generation: request.generation,
                    config: &request.config,
                    messages: &engine.messages,
                    system: request.system.as_deref(),
                    tools: allow_tools,
                    search: scope.search_enabled,
                },
                &mut rx,
                &mut events,
            )
            .await?;
            let done = engine.accept(
                text,
                calls,
                thinking,
                allow_tools,
                |budget, call| {
                    check(&context, request.generation, &rx)?;
                    {
                        let active = context.conn.lock().map_err(|_| "requestFailed")?;
                        let active = active.as_ref().ok_or("cancelled")?;
                        if active.generation != request.generation {
                            return Err("cancelled");
                        }
                        let index = match super::index_snapshot::open(&active.root, || *rx.borrow())
                        {
                            Ok(index) => index,
                            Err("cancelled") => return Err("cancelled"),
                            Err(code) => return Ok(budget.reject(code)),
                        };
                        Ok(budget.execute(
                            &index,
                            &active.root,
                            &scope,
                            &call.name,
                            &call.arguments,
                        ))
                    }
                },
                |kind, payload| events.emit(kind, payload),
            )?;
            if done {
                break;
            }
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            events.emit("done", json!({}));
            Ok(engine.finish())
        }
        Err(code) => {
            let payload = fail(safe_code(code));
            events.emit("error", json!({"error":payload}));
            Err(payload)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai1_r5_disabled_search_omits_discovery_tools_for_all_families() {
        for anthropic in [false, true] {
            let defs = definitions(false, anthropic);
            let text = serde_json::to_string(&defs).unwrap();
            assert!(text.contains("read_note"));
            assert!(text.contains("get_links"));
            assert!(!text.contains("search_notes"));
            assert!(!text.contains("list_folder"));
        }
    }

    #[test]
    fn ai1_p1_tool_results_keep_provider_protocol_shape() {
        let call = ToolCall {
            id: "call-1".into(),
            name: "read_note".into(),
            arguments: json!({"id":"n"}),
        };
        for family in ["openai", "azure", "ollama", "anthropic"] {
            let mut messages = vec![];
            append_exchange(
                family,
                &mut messages,
                "",
                "",
                std::slice::from_ref(&call),
                &[json!({"id":"n"})],
            );
            assert_eq!(messages.len(), 2);
            if family == "anthropic" {
                assert_eq!(messages[0]["content"][0]["type"], "tool_use");
                assert_eq!(messages[1]["content"][0]["tool_use_id"], "call-1");
            } else {
                assert_eq!(
                    messages[0]["tool_calls"][0]["function"]["name"],
                    "read_note"
                );
                if family == "ollama" {
                    assert_eq!(messages[1]["tool_name"], "read_note");
                } else {
                    assert_eq!(messages[1]["tool_call_id"], "call-1");
                }
                assert_eq!(
                    messages[0]["tool_calls"][0]["function"]["arguments"].is_object(),
                    family == "ollama"
                );
            }
        }
    }

    #[test]
    fn ai1_p3_only_classifies_relevant_tool_rejections() {
        assert!(unsupported_tools_response(
            "This model does not support tools"
        ));
        assert!(unsupported_tools_response("Unsupported parameter: tools"));
        assert!(!unsupported_tools_response("invalid model name"));
    }

    #[test]
    fn ai1_p4_r2_r4_scripted_provider_runs_without_network_and_without_writes() {
        let root = std::env::temp_dir().join(format!("amby-ai-fake-{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(root.join(".amby")).unwrap();
        std::fs::write(root.join("note.md"), "original note").unwrap();
        std::fs::write(root.join(".amby/marker"), "durable metadata").unwrap();
        let conn = crate::index::open_connection(&root).unwrap();
        conn.execute("INSERT INTO notes (id,path,title,mtime,size,content,word_count,created_at,updated_at) VALUES ('n','note.md','Note',0,0,'original note',2,0,0)", []).unwrap();
        let before_changes = conn.total_changes();
        let snapshot = || -> std::collections::BTreeMap<_, _> {
            use sha2::{Digest, Sha256};
            walkdir::WalkDir::new(&root)
                .into_iter()
                .map(Result::unwrap)
                .filter(|entry| entry.file_type().is_file())
                .map(|entry| {
                    (
                        entry.path().strip_prefix(&root).unwrap().to_path_buf(),
                        format!("{:x}", Sha256::digest(std::fs::read(entry.path()).unwrap())),
                    )
                })
                .collect()
        };
        let before = snapshot();
        let scope = ToolScope {
            search_enabled: true,
            note_ids: ["n".into()].into_iter().collect(),
            folders: vec![],
        };
        let mut engine = TurnEngine::new("openai", vec![], vec![]);
        let actions = [
            ("search_notes", json!({"query":"original"})),
            ("list_folder", json!({"path":""})),
            ("get_links", json!({"id":"n"})),
            ("read_note", json!({"id":"n"})),
            ("read_note", json!({"id":"n"})),
            ("read_note", json!({"id":"n"})),
            ("read_note", json!({"id":"n"})),
            ("read_note", json!({"id":"n"})),
        ];
        let calls = actions
            .into_iter()
            .enumerate()
            .map(|(index, (name, arguments))| ToolCall {
                id: format!("call-{index}"),
                name: name.into(),
                arguments,
            })
            .collect();
        let mut script = std::collections::VecDeque::from([
            (String::new(), calls),
            ("answer [1]".into(), vec![]),
        ]);
        let mut offered = Vec::new();
        while let Some((text, calls)) = script.pop_front() {
            let tools_offered = !engine.budget.exhausted();
            offered.push(tools_offered);
            let done = engine
                .accept(
                    text,
                    calls,
                    String::new(),
                    tools_offered,
                    |budget, call| {
                        let index = super::super::index_snapshot::open(&root, || false)?;
                        Ok(budget.execute(&index, &root, &scope, &call.name, &call.arguments))
                    },
                    |_, _| {},
                )
                .unwrap();
            if done {
                break;
            }
        }
        let result = engine.finish();
        assert_eq!(offered, [true, false]);
        assert_eq!(result.content, "answer [1]");
        assert_eq!(result.steps.len(), 8);
        assert_eq!(result.sources.len(), 1);
        assert_eq!(conn.total_changes(), before_changes);
        assert_eq!(snapshot(), before);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai1_r6_changed_vault_aborts_before_another_tool_can_run() {
        use std::cell::Cell;
        use std::sync::{Arc, Mutex};
        let context = VaultContext::new();
        let make_active = |generation| crate::vault_context::ActiveVault {
            root: std::env::temp_dir(),
            connection: rusqlite::Connection::open_in_memory().unwrap(),
            generation,
            watcher_identity: None,
            index_health: Cell::new(crate::model::IndexState::Healthy),
            index_changes: Arc::new(Mutex::new(HashSet::new())),
            pending_move_refactor: Mutex::new(None),
        };
        *context.conn.lock().unwrap() = Some(make_active(1));
        let (_sender, receiver) = tokio::sync::watch::channel(false);
        assert!(check(&context, 1, &receiver).is_ok());
        *context.conn.lock().unwrap() = Some(make_active(2));
        assert_eq!(check(&context, 1, &receiver), Err("cancelled"));
    }

    #[test]
    fn codex_gets_the_same_read_only_tools_in_mcp_form() {
        let names = |search| {
            mcp_tools(search)
                .iter()
                .map(|tool| tool["name"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(false), ["read_note", "get_links"]);
        assert_eq!(
            names(true),
            ["read_note", "get_links", "search_notes", "list_folder"]
        );
    }

    #[test]
    fn every_mcp_tool_is_described_and_marked_read_only_and_closed_world() {
        for tool in mcp_tools(true) {
            assert!(tool["description"]
                .as_str()
                .is_some_and(|text| !text.is_empty()));
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert!(tool["inputSchema"]["properties"].is_object());
            assert_eq!(tool["annotations"]["readOnlyHint"], true);
            assert_eq!(tool["annotations"]["openWorldHint"], false);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
            for leaked in ["function", "parameters", "input_schema", "type"] {
                assert!(tool.get(leaked).is_none(), "{leaked} leaked into {tool}");
            }
        }
    }
}
