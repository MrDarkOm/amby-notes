//! Transport-independent JSON-RPC for the read-only vault tools.

use serde_json::Value;

/// What the bridge offers Codex. `call` may block (it reads the vault index).
pub trait ToolHost: Send + Sync + 'static {
    /// MCP tool descriptions: `name`, `description`, `inputSchema`, `annotations`.
    fn tools(&self) -> Vec<Value>;
    /// The tool's result; an `error` field marks a failed call.
    fn call(&self, name: &str, arguments: &Value) -> Value;
}

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
            rpc_result(
                id,
                serde_json::json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "amby", "version": server_version}
                }),
            )
        }
        "ping" => rpc_result(id, serde_json::json!({})),
        "tools/list" => rpc_result(id, serde_json::json!({"tools": host.tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str);
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            match name {
                Some(name) if arguments.is_object() => {
                    let result = host.call(name, &arguments);
                    let failed = result.get("error").is_some();
                    rpc_result(
                        id,
                        serde_json::json!({
                            "content": [{"type": "text", "text": result.to_string()}],
                            "isError": failed
                        }),
                    )
                }
                _ => rpc_error(id, -32602, "invalid params"),
            }
        }
        _ => rpc_error(id, -32601, "method not found"),
    })
}
