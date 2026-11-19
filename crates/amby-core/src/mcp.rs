//! Transport-independent JSON-RPC for the read-only vault tools.

use serde_json::Value;

/// What the bridge offers Codex. `call` may block (it reads the vault index).
pub trait ToolHost: Send + Sync + 'static {
    /// MCP tool descriptions: `name`, `description`, `inputSchema`, `annotations`.
    fn tools(&self) -> Vec<Value>;
    /// The tool's result; an `error` field marks a failed call.
    fn call(&self, name: &str, arguments: &Value) -> Value;
    /// Whether the host lists notes as MCP resources.
    fn supports_resources(&self) -> bool {
        false
    }
    /// One page of `resources/list`: `{"resources": [...], "nextCursor"?: "..."}`.
    fn list_resources(&self, _cursor: Option<&str>) -> Result<Value, &'static str> {
        Err("unsupported")
    }
    /// The `contents` of `resources/read`.
    fn read_resource(&self, _uri: &str) -> Result<Value, &'static str> {
        Err("unsupported")
    }
    /// Whether the host offers prompts.
    fn supports_prompts(&self) -> bool {
        false
    }
    /// The `prompts` of `prompts/list`.
    fn list_prompts(&self) -> Value {
        Value::Array(Vec::new())
    }
    /// The result of `prompts/get`: `{"description", "messages"}`.
    fn get_prompt(&self, _name: &str, _arguments: &Value) -> Result<Value, &'static str> {
        Err("unsupported")
    }
}

/// A tool result may carry extra MCP content blocks (an image, say) under this key; they
/// follow the JSON text block and are not part of the structured result.
pub const EXTRA_CONTENT: &str = "_mcpContent";

const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn rpc_result(id: Value, result: Value) -> Value {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// One JSON-RPC message. `None` means "nothing to send back" (a notification).
pub fn handle_rpc(host: &dyn ToolHost, message: &Value, server_version: &str) -> Option<Value> {
    let Some(object) = message.as_object() else {
        return Some(rpc_error(Value::Null, -32600, "invalid request"));
    };
    let id = object.get("id").cloned();
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Some(rpc_error(
            id.unwrap_or(Value::Null),
            -32600,
            "invalid request",
        ));
    };
    let Some(id) = id else {
        return None; // a notification: nothing is sent back, whatever it was
    };
    let params = object.get("params").unwrap_or(&Value::Null);
    Some(match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str);
            let version = asked
                .filter(|version| SUPPORTED_VERSIONS.contains(version))
                .unwrap_or("2025-03-26");
            let mut capabilities = serde_json::json!({"tools": {}});
            if host.supports_resources() {
                capabilities["resources"] = serde_json::json!({});
            }
            if host.supports_prompts() {
                capabilities["prompts"] = serde_json::json!({});
            }
            rpc_result(
                id,
                serde_json::json!({
                    "protocolVersion": version,
                    "capabilities": capabilities,
                    "serverInfo": {"name": "amby", "version": server_version}
                }),
            )
        }
        "ping" => rpc_result(id, serde_json::json!({})),
        "resources/list" if host.supports_resources() => {
            let cursor = params.get("cursor").and_then(Value::as_str);
            match host.list_resources(cursor) {
                Ok(page) => rpc_result(id, page),
                Err(_) => rpc_error(id, -32602, "invalid params"),
            }
        }
        "resources/templates/list" if host.supports_resources() => {
            rpc_result(id, serde_json::json!({"resourceTemplates": []}))
        }
        "resources/read" if host.supports_resources() => {
            match params.get("uri").and_then(Value::as_str) {
                Some(uri) => match host.read_resource(uri) {
                    Ok(contents) => rpc_result(id, serde_json::json!({"contents": contents})),
                    Err(_) => rpc_error(id, -32002, "resource not found"),
                },
                None => rpc_error(id, -32602, "invalid params"),
            }
        }
        "prompts/list" if host.supports_prompts() => {
            rpc_result(id, serde_json::json!({"prompts": host.list_prompts()}))
        }
        "prompts/get" if host.supports_prompts() => {
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            match params.get("name").and_then(Value::as_str) {
                Some(name) if arguments.is_object() => match host.get_prompt(name, &arguments) {
                    Ok(prompt) => rpc_result(id, prompt),
                    Err(_) => rpc_error(id, -32602, "invalid params"),
                },
                _ => rpc_error(id, -32602, "invalid params"),
            }
        }
        "tools/list" => rpc_result(id, serde_json::json!({"tools": host.tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str);
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            match name {
                Some(name) if arguments.is_object() => {
                    let mut result = host.call(name, &arguments);
                    let failed = result.get("error").is_some();
                    let extra = result
                        .as_object_mut()
                        .and_then(|object| object.remove(EXTRA_CONTENT))
                        .and_then(|extra| match extra {
                            Value::Array(blocks) => Some(blocks),
                            _ => None,
                        })
                        .unwrap_or_default();
                    let mut content =
                        vec![serde_json::json!({"type": "text", "text": result.to_string()})];
                    content.extend(extra);
                    rpc_result(
                        id,
                        serde_json::json!({"content": content, "isError": failed}),
                    )
                }
                _ => rpc_error(id, -32602, "invalid params"),
            }
        }
        _ => rpc_error(id, -32601, "method not found"),
    })
}
