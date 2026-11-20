use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use amby_core::index::read_only::{visible_folder, ReadVault};
use amby_core::mcp::{handle_rpc, ToolHost};
use amby_core::note_edit::EditKind;
use serde_json::{json, Value};

const MAX_LINE_BYTES: usize = 1024 * 1024;

use crate::args::WriteAccess;
use crate::{edit, mcp_tools};

struct VaultHost {
    root: PathBuf,
    write_root: Option<PathBuf>,
    grant: Option<String>,
}

const WRITE_TOOLS: [(&str, &str, EditKind); 3] = [
    (
        "new_note",
        "Create a Markdown note at a vault-relative path.",
        EditKind::New,
    ),
    (
        "append_note",
        "Append Markdown to an existing note at a vault-relative path.",
        EditKind::Append,
    ),
    (
        "write_note",
        "Replace a note body at a vault-relative path, retaining frontmatter.",
        EditKind::Write,
    ),
];

fn edit_args(arguments: &Value) -> Result<(&str, &str, bool), &'static str> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty() && path.len() <= 1024)
        .ok_or("invalidArguments")?;
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or("invalidArguments")?;
    let dry_run = arguments
        .get("dryRun")
        .map_or(Ok(false), |value| value.as_bool().ok_or("invalidArguments"))?;
    Ok((path, content, dry_run))
}

impl VaultHost {
    fn write(&self, kind: EditKind, arguments: &Value) -> Result<edit::EditResult, &'static str> {
        let scope = self.write_root.as_deref().ok_or("accessDenied")?;
        let (path, content, dry_run) = edit_args(arguments)?;
        edit::execute(&self.root, Some(scope), kind, path, content, dry_run, true)
    }
}

impl ToolHost for VaultHost {
    fn tools(&self) -> Vec<Value> {
        let mut tools = amby_core::ai_tools::mcp_definitions(true);
        tools.push(amby_core::ai_tools::list_tags_definition());
        tools.push(mcp_tools::get_properties_definition());
        let modules = amby_core::vault_tools::modules::Modules::read(&self.root).ok();
        let enabled = |module| modules.is_some_and(|modules| modules.includes(module));
        let offered = |tool: &Value| {
            tool["name"]
                .as_str()
                .and_then(crate::mcp_extra::module_of)
                .is_none_or(enabled)
        };
        tools.extend(
            crate::mcp_extra::read_definitions()
                .into_iter()
                .filter(offered),
        );
        tools.extend(
            mcp_tools::DOMAIN_READS
                .iter()
                .filter(|(_, _, _, module)| module.is_none_or(enabled))
                .map(|(name, description, fields, _)| {
                    mcp_tools::domain_definition(name, description, fields, true)
                }),
        );
        if self.write_root.is_some() {
            tools.extend(
                mcp_tools::DOMAIN_WRITES
                    .iter()
                    .filter(|(_, _, _, module)| module.is_none_or(enabled))
                    .map(|(name, description, fields, _)| {
                        mcp_tools::domain_definition(name, description, fields, false)
                    }),
            );
            tools.extend(
                mcp_tools::STRUCTURAL
                    .iter()
                    .map(|(name, description, fields)| {
                        mcp_tools::definition(name, description, fields, true, false)
                    }),
            );
            tools.extend(
                crate::mcp_extra::write_definitions()
                    .into_iter()
                    .filter(offered),
            );
            tools.extend(
                mcp_tools::PROPERTY_WRITES
                    .iter()
                    .map(|(name, description, fields)| {
                        mcp_tools::property_definition(name, description, fields)
                    }),
            );
            tools.extend(WRITE_TOOLS.iter().map(|(name, description, kind)| json!({
                "name": name,
                "description": description,
                "inputSchema": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "content": {"type": "string"}, "dryRun": {"type": "boolean"}},
                    "required": ["path", "content"]
                },
                "annotations": {"readOnlyHint": false, "openWorldHint": false, "destructiveHint": *kind == EditKind::Write}
            })));
        }
        tools
    }

    fn call(&self, name: &str, arguments: &Value) -> Value {
        // A long-running server sees edits and deletions on its next request.
        if !self.root.canonicalize().is_ok_and(|path| path == self.root) {
            return json!({ "error": "vaultNotFound" });
        }
        if let Some((_, _, kind)) = WRITE_TOOLS.iter().find(|(tool, _, _)| *tool == name) {
            return match self.write(*kind, arguments) {
                Ok(result) => json!(result),
                Err(code) => json!({"error": code}),
            };
        }
        if mcp_tools::STRUCTURAL
            .iter()
            .any(|(tool, _, _)| *tool == name)
        {
            let Some(grant) = &self.grant else {
                return json!({"error":"accessDenied"});
            };
            return mcp_tools::structural_call(&self.root, grant, name, arguments)
                .unwrap_or_else(|code| json!({"error":code}));
        }
        if mcp_tools::PROPERTY_WRITES
            .iter()
            .any(|(tool, _, _)| *tool == name)
        {
            let Some(grant) = &self.grant else {
                return json!({"error":"accessDenied"});
            };
            return mcp_tools::property_call(&self.root, grant, name, arguments)
                .unwrap_or_else(|code| json!({"error":code}));
        }
        if crate::mcp_extra::is_read(name) {
            return crate::mcp_extra::read(&self.root, name, arguments)
                .unwrap_or_else(|code| json!({"error": code}));
        }
        if crate::mcp_extra::is_write(name) {
            let (Some(scope), Some(grant)) = (&self.write_root, &self.grant) else {
                return json!({"error":"accessDenied"});
            };
            return crate::mcp_extra::write(&self.root, scope, grant, name, arguments)
                .unwrap_or_else(|code| json!({"error": code}));
        }
        if name == "get_properties" {
            let path = match mcp_tools::validate_fields(arguments, &["path"], &[])
                .and_then(|()| mcp_tools::argument(arguments, "path"))
            {
                Ok(path) => path.replace('\\', "/"),
                Err(code) => return json!({"error": code}),
            };
            return ReadVault::open(&self.root)
                .and_then(|vault| vault.properties(&path))
                .unwrap_or_else(|code| json!({"error": code}));
        }
        if mcp_tools::DOMAIN_WRITES
            .iter()
            .any(|(tool, _, _, _)| *tool == name)
        {
            let Some(grant) = &self.grant else {
                return json!({"error":"accessDenied"});
            };
            return mcp_tools::domain_write(&self.root, grant, name, arguments)
                .unwrap_or_else(|code| json!({"error":code}));
        }
        if mcp_tools::DOMAIN_READS
            .iter()
            .any(|(tool, _, _, _)| *tool == name)
        {
            return mcp_tools::domain_read(&self.root, name, arguments)
                .unwrap_or_else(|code| json!({"error":code}));
        }
        match ReadVault::open(&self.root) {
            Ok(vault) => vault.tool(name, arguments),
            Err(code) => json!({ "error": code }),
        }
    }

    fn supports_resources(&self) -> bool {
        true
    }

    fn list_resources(&self, cursor: Option<&str>) -> Result<Value, &'static str> {
        self.note_resources(cursor)
    }

    fn read_resource(&self, uri: &str) -> Result<Value, &'static str> {
        self.note_resource(uri)
    }

    fn supports_prompts(&self) -> bool {
        true
    }

    fn list_prompts(&self) -> Value {
        crate::mcp_extra::prompts()
    }

    fn get_prompt(&self, name: &str, arguments: &Value) -> Result<Value, &'static str> {
        crate::mcp_extra::prompt(name, arguments)
    }
}

const RESOURCE_PREFIX: &str = "amby://vault/";
const RESOURCE_PAGE: usize = 100;
const MAX_RESOURCE_BYTES: u64 = 4 * 1024 * 1024;

/// A vault-relative path as a resource URI: every byte but unreserved characters and `/`
/// is percent-encoded.
fn resource_uri(path: &str) -> String {
    let mut uri = String::from(RESOURCE_PREFIX);
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

fn resource_path(uri: &str) -> Option<String> {
    let encoded = uri.strip_prefix(RESOURCE_PREFIX)?.as_bytes();
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut at = 0;
    while at < encoded.len() {
        if encoded[at] == b'%' {
            let hex = std::str::from_utf8(encoded.get(at + 1..at + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            bytes.push(encoded[at]);
            at += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

impl VaultHost {
    fn note_resources(&self, cursor: Option<&str>) -> Result<Value, &'static str> {
        let start = cursor.map_or(Ok(0), |cursor| {
            cursor.parse::<usize>().map_err(|_| "invalidArguments")
        })?;
        let vault = ReadVault::open(&self.root)?;
        let notes = vault.notes()?;
        let mut resources = Vec::new();
        for note in notes.iter().skip(start).take(RESOURCE_PAGE) {
            let Ok(relative) = std::path::Path::new(&note.path).strip_prefix(&self.root) else {
                continue;
            };
            let relative = amby_core::vault::scan::normalize_rel_path(relative);
            if amby_core::index::read_only::visible_note(&self.root, &relative).is_err() {
                continue;
            }
            resources.push(json!({
                "uri": resource_uri(&relative), "name": note.title, "mimeType": "text/markdown"
            }));
        }
        let mut page = json!({ "resources": resources });
        if notes.len() > start + RESOURCE_PAGE {
            page["nextCursor"] = json!((start + RESOURCE_PAGE).to_string());
        }
        Ok(page)
    }

    fn note_resource(&self, uri: &str) -> Result<Value, &'static str> {
        use std::io::Read;
        let path = resource_path(uri).ok_or("invalidArguments")?;
        let file = amby_core::index::read_only::visible_note(&self.root, &path)?;
        let mut bytes = Vec::new();
        std::fs::File::open(file)
            .map_err(|_| "unavailable")?
            .take(MAX_RESOURCE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "unavailable")?;
        if bytes.len() as u64 > MAX_RESOURCE_BYTES {
            return Err("resultTooLarge");
        }
        let text = String::from_utf8(bytes).map_err(|_| "invalidEncoding")?;
        Ok(json!([{ "uri": uri, "mimeType": "text/markdown", "text": text }]))
    }
}

/// Read one newline-delimited message while draining oversized frames without
/// allocating memory proportional to their length.
fn read_frame(input: &mut impl BufRead, bytes: &mut Vec<u8>) -> io::Result<bool> {
    bytes.clear();
    let mut oversized = false;
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return Ok(oversized || !bytes.is_empty());
        }
        let newline = available.iter().position(|&byte| byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !oversized && bytes.len() + consumed <= MAX_LINE_BYTES {
            bytes.extend_from_slice(&available[..consumed]);
        } else {
            oversized = true;
            bytes.clear();
        }
        input.consume(consumed);
        if newline.is_some() {
            return Ok(true);
        }
    }
}

pub fn serve(
    root: PathBuf,
    write_access: Option<&WriteAccess>,
    mut input: impl BufRead,
    mut output: impl Write,
) -> Result<(), &'static str> {
    let write_root = match write_access {
        None => None,
        Some(WriteAccess::Vault) => Some(root.clone()),
        Some(WriteAccess::Folder(folder)) => {
            Some(visible_folder(&root, &folder.replace('\\', "/"))?)
        }
    };
    let grant = write_root
        .as_ref()
        .and_then(|path| path.strip_prefix(&root).ok())
        .map(amby_core::vault::scan::normalize_rel_path);
    serve_frames(
        VaultHost {
            root,
            write_root,
            grant,
        },
        &mut input,
        &mut output,
    )
    .map_err(|_| "unavailable")
}

fn serve_frames(
    host: VaultHost,
    mut input: impl BufRead,
    mut output: impl Write,
) -> io::Result<()> {
    let mut bytes = Vec::new();
    let mut structured_results = false;
    while read_frame(&mut input, &mut bytes)? {
        let reply = match serde_json::from_slice::<Value>(&bytes) {
            Ok(message) => handle_rpc(&host, &message, env!("CARGO_PKG_VERSION")).map(|mut reply| {
                if message["method"] == "initialize" {
                    structured_results = matches!(reply["result"]["protocolVersion"].as_str(), Some("2025-06-18" | "2025-11-25"));
                }
                if message["method"] == "tools/call" {
                    let text = reply["result"]["content"][0]["text"].as_str();
                    if text.is_some_and(|text| text.len() > MAX_LINE_BYTES / 4) {
                        let error = json!({"error":"resultTooLarge"});
                        reply["result"] = json!({"content":[{"type":"text","text":error.to_string()}],"isError":true});
                    } else if structured_results {
                        if let Some(value) = text.and_then(|text| serde_json::from_str::<Value>(text).ok()).filter(Value::is_object) {
                            reply["result"]["structuredContent"] = value;
                        }
                    }
                }
                reply
            }),
            Err(_) => Some(json!({
                "jsonrpc":"2.0", "id":null, "error":{"code":-32700,"message":"parse error"}
            })),
        };
        if let Some(reply) = reply {
            serde_json::to_writer(&mut output, &reply)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
    Ok(())
}
