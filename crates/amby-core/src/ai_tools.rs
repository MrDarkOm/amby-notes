//! Path validation for the AI's read-only vault tools.
//!
//! Indexed paths are not trusted: files can be replaced with symbolic links
//! after indexing, and metadata folders must never be exposed to the model.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

pub(crate) fn resolve_note_path(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    let path = Path::new(relative);
    if relative.is_empty() || path.is_absolute() {
        return Err("accessDenied");
    }
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err("accessDenied");
        };
        let name = name.to_str().ok_or("accessDenied")?;
        if name.starts_with('.') || crate::vault::scan::is_service_directory(name) {
            return Err("accessDenied");
        }
    }
    let real = crate::paths::confine_rel_no_symlinks(root, relative).map_err(|_| "accessDenied")?;
    if !real.is_file() {
        return Err("notFound");
    }
    Ok(real)
}

/// Descriptions of the vault tools shared by provider adapters.
pub fn definitions(search: bool) -> Vec<(&'static str, &'static str, Value)> {
    let mut defs = vec![
        (
            "read_note",
            "Read a note by ID or vault-relative path. Offset and maxChars count Unicode characters.",
            json!({"type":"object","properties":{"id":{"type":"string","description":"A note ID or a vault-relative Markdown path."},"offset":{"type":"integer","minimum":0},"maxChars":{"type":"integer","minimum":1,"maximum":20000}},"required":["id"]}),
        ),
        (
            "get_links",
            "Find outgoing and incoming links for a note by ID or vault-relative path.",
            json!({"type":"object","properties":{"id":{"type":"string","description":"A note ID or a vault-relative Markdown path."}},"required":["id"]}),
        ),
    ];
    if search {
        defs.extend([
            ("search_notes", "Search notes by text, tags, header properties and folder. Give a query, a filter, or both; every filter must match.", json!({"type":"object","properties":{
                "query":{"type":"string","maxLength":1024},
                "tags":{"type":"array","items":{"type":"string","minLength":1,"maxLength":256},"maxItems":16,"description":"Every tag must be present; a tag also matches its nested tags."},
                "properties":{"type":"array","maxItems":16,"items":{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":256},"value":{"type":"string","maxLength":1024}},"required":["name"],"additionalProperties":false},"description":"The header key must exist; with value, the value or a list item must equal it, ignoring case."},
                "folder":{"type":"string","maxLength":1024,"description":"A vault-relative folder."},
                "limit":{"type":"integer","minimum":1,"maximum":50}}})),
            ("list_folder", "List notes in a vault-relative folder. Empty path means the vault root.", json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})),
        ]);
    }
    defs
}

/// The panel's read tools that name one note (`path` or `id`); each stays inside the scope.
const PANEL_NOTE_TOOLS: [&str; 6] = [
    "get_outline",
    "read_section",
    "get_properties",
    "get_note_info",
    "list_versions",
    "read_version",
];
/// The panel's vault-wide read tools, offered with the conversation's search switch only.
const PANEL_WIDE_TOOLS: [&str; 3] = ["list_databases", "read_database", "query_database"];

/// The tools the AI panel offers every provider: the base set, `list_tags` with search, the
/// note-level reads, and the database reads with search. Definitions come from `tool_set`.
pub fn panel_mcp_definitions(search: bool) -> Vec<Value> {
    let mut tools = mcp_definitions(search);
    let shared = |name: &str| crate::tool_set::definition_of(name);
    if search {
        tools.extend(shared("list_tags"));
    }
    tools.extend(PANEL_NOTE_TOOLS.iter().filter_map(|name| shared(name)));
    if search {
        tools.extend(PANEL_WIDE_TOOLS.iter().filter_map(|name| shared(name)));
    }
    tools
}

/// Reads plus, when the conversation may write, the proposal tools.
pub fn panel_mcp_definitions_with(search: bool, writes: Writes) -> Vec<Value> {
    let mut tools = panel_mcp_definitions(search);
    tools.extend(panel_write_definitions(writes));
    tools
}

/// `panel_mcp_definitions` as (name, description, input schema) for function-call providers.
pub fn panel_definitions(search: bool) -> Vec<(String, String, Value)> {
    let text = |tool: &Value, key: &str| tool[key].as_str().unwrap_or_default().to_owned();
    panel_mcp_definitions(search)
        .into_iter()
        .map(|tool| {
            (
                text(&tool, "name"),
                text(&tool, "description"),
                tool["inputSchema"].clone(),
            )
        })
        .collect()
}

/// `list_tags`, offered by the standalone MCP server and, with search, by the panel.
pub fn list_tags_definition() -> Value {
    json!({
        "name": "list_tags",
        "description": "List up to 200 tags with the number of notes that carry each.",
        "inputSchema": {"type":"object","properties":{}},
        "annotations": {"readOnlyHint": true, "openWorldHint": false, "destructiveHint": false}
    })
}

pub fn mcp_definitions(search: bool) -> Vec<Value> {
    definitions(search).into_iter().map(|(name, description, schema)| json!({
        "name": name, "description": description, "inputSchema": schema,
        "annotations": {"readOnlyHint": true, "openWorldHint": false, "destructiveHint": false}
    })).collect()
}

/// The model never chooses its own authority: this scope comes from the user's
/// context chips and per-conversation search setting.
pub struct ToolScope {
    pub search_enabled: bool,
    pub note_ids: HashSet<String>,
    pub folders: Vec<String>,
    /// Where the panel may propose changes; set by the user's conversation switch.
    pub writes: Writes,
}

/// What the panel's write tools may reach. They only propose: the user applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writes {
    /// No write tools.
    Off,
    /// The notes and folders in the context chips.
    Context,
    /// The whole vault (the conversation's switch).
    Vault,
}

/// The most proposals one turn may make.
pub const PROPOSALS_PER_TURN: usize = 5;

const PANEL_WRITE_TOOLS: [&str; 6] = [
    "new_note",
    "append_note",
    "edit_note",
    "set_property",
    "delete_property",
    "rename_property",
];

/// The panel's write tools. They return a proposal ID at once; nothing is written until the
/// user applies the card, so the descriptions say so.
pub fn panel_write_definitions(writes: Writes) -> Vec<Value> {
    if writes == Writes::Off {
        return Vec::new();
    }
    let path = json!({"type":"string","minLength":1,"maxLength":1024,"description":"A vault-relative Markdown path."});
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
            "name": name, "description": description,
            "inputSchema": {"type":"object","properties":properties,"required":required,"additionalProperties":false},
            "annotations": {"readOnlyHint": false, "openWorldHint": false, "destructiveHint": false}
        })
    };
    let property_tool = |name: &str, description: &str, fields: &[&str]| {
        let mut tool = crate::tool_set::property_definition(name, description, fields);
        tool["annotations"]["destructiveHint"] = json!(false);
        tool
    };
    vec![
        tool("new_note", "Propose a new Markdown note at a path in an existing folder. This creates a proposal: the user applies it, or their approval mode applies it at once.", json!({"path":path,"content":{"type":"string"}}), &["path", "content"]),
        tool("append_note", "Propose Markdown to add at the end of a note. This creates a proposal: the user applies it, or their approval mode applies it at once.", json!({"path":path,"content":{"type":"string"}}), &["path", "content"]),
        tool("edit_note", "Propose replacing an exact fragment of a note's body (oldText must occur once unless replaceAll is true; copy it from read_note or read_section). This creates a proposal: the user applies it, or their approval mode applies it at once.", json!({"path":path,"oldText":{"type":"string","minLength":1},"newText":{"type":"string"},"replaceAll":{"type":"boolean"}}), &["path", "oldText", "newText"]),
        property_tool("set_property", "Propose setting a header property of a note (a missing one is created; type sets the type of a new property). Use null to clear the value and an array for a list. This creates a proposal: the user applies it, or their approval mode applies it at once.", &["path", "name", "value"]),
        property_tool("delete_property", "Propose removing a property from a note's header. This creates a proposal: the user applies it, or their approval mode applies it at once.", &["path", "name"]),
        property_tool("rename_property", "Propose renaming a property of a note, keeping its value. This creates a proposal: the user applies it, or their approval mode applies it at once.", &["path", "name", "newName"]),
    ]
}

#[derive(Default)]
pub struct ToolBudget {
    calls: usize,
    result_chars: usize,
    proposals: Vec<crate::ai_proposals::Proposal>,
    proposed: usize,
}

impl ToolBudget {
    pub fn exhausted(&self) -> bool {
        self.calls >= 8 || self.result_chars >= 60_000
    }

    /// The proposals the turn's write tools made since the last call; the desktop keeps them for
    /// the user's cards.
    pub fn take_proposals(&mut self) -> Vec<crate::ai_proposals::Proposal> {
        std::mem::take(&mut self.proposals)
    }

    fn propose(
        &mut self,
        conn: &Connection,
        root: &Path,
        scope: &ToolScope,
        name: &str,
        args: &Value,
    ) -> Result<Value, &'static str> {
        use crate::ai_proposals::{propose, ProposalOp, WriteScope};
        if scope.writes == Writes::Off {
            return Err("accessDenied");
        }
        if self.proposed >= PROPOSALS_PER_TURN {
            return Err("tooManyProposals");
        }
        let notes = scope
            .note_ids
            .iter()
            .filter_map(|id| crate::index::note_by_id(conn, root, id).ok())
            .filter_map(|note| relative_path(root, &note))
            .collect();
        let write = WriteScope {
            vault: scope.writes == Writes::Vault,
            notes,
            folders: scope.folders.clone(),
        };
        let text = |key: &str| string_arg(args, key).map(str::to_owned);
        let content = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or("invalidArguments")
        };
        let op = match name {
            "new_note" | "append_note" => {
                crate::tool_set::validate_fields(args, &["path", "content"], &[])?;
                let (path, content) = (text("path")?, content("content")?);
                if name == "new_note" {
                    ProposalOp::New { path, content }
                } else {
                    ProposalOp::Append { path, content }
                }
            }
            "edit_note" => {
                crate::tool_set::validate_fields(
                    args,
                    &["path", "oldText", "newText"],
                    &["replaceAll"],
                )?;
                ProposalOp::Replace {
                    path: text("path")?,
                    old_text: content("oldText")?,
                    new_text: content("newText")?,
                    replace_all: match args.get("replaceAll") {
                        None => false,
                        Some(value) => value.as_bool().ok_or("invalidArguments")?,
                    },
                }
            }
            "set_property" => {
                crate::tool_set::validate_fields(args, &["path", "name", "value"], &["type"])?;
                ProposalOp::SetProperty {
                    path: text("path")?,
                    name: text("name")?,
                    value: args.get("value").cloned().ok_or("invalidArguments")?,
                    property_type: match args.get("type") {
                        None => None,
                        Some(_) => Some(text("type")?),
                    },
                }
            }
            "delete_property" => {
                crate::tool_set::validate_fields(args, &["path", "name"], &[])?;
                ProposalOp::DeleteProperty {
                    path: text("path")?,
                    name: text("name")?,
                }
            }
            "rename_property" => {
                crate::tool_set::validate_fields(args, &["path", "name", "newName"], &[])?;
                ProposalOp::RenameProperty {
                    path: text("path")?,
                    name: text("name")?,
                    new_name: text("newName")?,
                }
            }
            _ => return Err("unknownTool"),
        };
        let proposal = propose(root, &write, Some(conn), op)?;
        self.proposed += 1;
        let reply = json!({
            "status": "pending", "proposalId": proposal.id, "path": proposal.path,
            "message": "Proposed. It is applied when the user approves it, or at once if they chose an automatic mode; do not repeat it."
        });
        self.proposals.push(proposal);
        Ok(reply)
    }

    pub fn reject(&mut self, code: &str) -> Value {
        if self.exhausted() {
            return json!({"error": "budgetExceeded"});
        }
        self.calls += 1;
        let result = json!({"error": code});
        self.result_chars = self
            .result_chars
            .saturating_add(result.to_string().chars().count() + 64)
            .min(60_000);
        result
    }

    pub fn execute(
        &mut self,
        conn: &Connection,
        root: &Path,
        scope: &ToolScope,
        name: &str,
        args: &Value,
    ) -> Value {
        if self.exhausted() {
            return json!({"error": "budgetExceeded"});
        }
        self.calls += 1;
        let outcome = if PANEL_WRITE_TOOLS.contains(&name) {
            self.propose(conn, root, scope, name, args)
        } else {
            run_tool(conn, root, scope, name, args)
        };
        let result = match outcome {
            Ok(value) => value,
            Err(code) => json!({"error": code}),
        };
        // Reserve space for the citation field added by the turn engine and
        // for a bounded error result when the remaining budget is exhausted.
        let size = result.to_string().chars().count().saturating_add(64);
        if self.result_chars.saturating_add(size) > 60_000 {
            self.result_chars = 60_000;
            json!({"error": "budgetExceeded"})
        } else {
            self.result_chars += size;
            result
        }
    }
}

fn indexed_note(
    conn: &Connection,
    root: &Path,
    scope: &ToolScope,
    id: &str,
) -> Result<(crate::index::IndexedNote, PathBuf), &'static str> {
    if id.len() > 1024 {
        return Err("invalidArguments");
    }
    let note = match crate::index::note_by_id(conn, root, id) {
        Ok(note) => note,
        // A vault-relative path names the note too; the scope below still checks its ID.
        Err(_) => {
            let id: String = conn
                .query_row(
                    "SELECT id FROM notes WHERE path = ?1",
                    [id.replace('\\', "/")],
                    |row| row.get(0),
                )
                .map_err(|_| "notFound")?;
            crate::index::note_by_id(conn, root, &id).map_err(|_| "notFound")?
        }
    };
    let id = note.id.as_str();
    let relative = Path::new(&note.path)
        .strip_prefix(root)
        .map_err(|_| "accessDenied")?;
    let relative_string = relative.to_str().ok_or("accessDenied")?;
    let file = resolve_note_path(root, relative_string)?;
    if !scope.search_enabled && !scope.note_ids.contains(id) {
        let inside_folder = scope.folders.iter().any(|folder| {
            !folder.is_empty()
                && relative.starts_with(Path::new(folder))
                && safe_folder(root, folder).is_ok()
        });
        if !inside_folder {
            return Err("accessDenied");
        }
    }
    Ok((note, file))
}

pub(crate) fn safe_folder(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    if relative.is_empty() {
        return Ok(root.to_path_buf());
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return Err("accessDenied");
    }
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err("accessDenied");
        };
        let name = name.to_str().ok_or("accessDenied")?;
        if name.starts_with('.') || crate::vault::scan::is_service_directory(name) {
            return Err("accessDenied");
        }
    }
    let resolved =
        crate::paths::confine_rel_no_symlinks(root, relative).map_err(|_| "accessDenied")?;
    if !resolved.is_dir() {
        return Err("notFound");
    }
    Ok(resolved)
}

fn relative_path(root: &Path, note: &crate::index::IndexedNote) -> Option<String> {
    Path::new(&note.path)
        .strip_prefix(root)
        .ok()
        .map(crate::vault::scan::normalize_rel_path)
}

/// The search filter of a tool's arguments (`query`, `tags`, `properties`, `folder`,
/// `limit` up to 50); at least a query or a filter.
pub fn filter_from(args: &Value, root: &Path) -> Result<crate::index::NoteFilter, &'static str> {
    let strings = |key: &str, max: usize| -> Result<Vec<String>, &'static str> {
        let Some(items) = args.get(key) else {
            return Ok(Vec::new());
        };
        let items = items
            .as_array()
            .filter(|items| items.len() <= max)
            .ok_or("invalidArguments")?;
        items
            .iter()
            .map(|item| {
                item.as_str()
                    .filter(|item| !item.trim().is_empty() && item.len() <= 256)
                    .map(str::to_owned)
                    .ok_or("invalidArguments")
            })
            .collect()
    };
    let tags = strings("tags", 16)?;
    let mut properties = Vec::new();
    if let Some(items) = args.get("properties") {
        let items = items
            .as_array()
            .filter(|items| items.len() <= 16)
            .ok_or("invalidArguments")?;
        for item in items {
            let object = item.as_object().ok_or("invalidArguments")?;
            if object.keys().any(|key| key != "name" && key != "value") {
                return Err("invalidArguments");
            }
            let name = string_arg(item, "name")?;
            if name.trim().is_empty() || name.len() > 256 {
                return Err("invalidArguments");
            }
            let value = item
                .get("value")
                .map(|_| string_arg(item, "value"))
                .transpose()?;
            properties.push(crate::index::PropertyFilter {
                name: name.to_owned(),
                value: value.map(str::to_owned),
            });
        }
    }
    let folder = args
        .get("folder")
        .map(|_| string_arg(args, "folder"))
        .transpose()?
        .unwrap_or("");
    let folder = folder.trim_matches('/').replace('\\', "/");
    safe_folder(root, &folder)?;
    let query = args
        .get("query")
        .map(|_| string_arg(args, "query"))
        .transpose()?;
    let limit = match args.get("limit") {
        None => 10,
        Some(limit) => limit
            .as_u64()
            .filter(|n| (1..=50).contains(n))
            .ok_or("invalidArguments")? as usize,
    };
    let filter = crate::index::NoteFilter {
        query: query.map(str::to_owned),
        tags,
        properties,
        folder,
        limit,
    };
    if filter.is_empty() {
        return Err("invalidArguments");
    }
    Ok(filter)
}

fn string_arg<'a>(args: &'a Value, name: &str) -> Result<&'a str, &'static str> {
    args.get(name)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 1024)
        .ok_or("invalidArguments")
}

fn run_tool(
    conn: &Connection,
    root: &Path,
    scope: &ToolScope,
    name: &str,
    args: &Value,
) -> Result<Value, &'static str> {
    match name {
        "search_notes" => {
            if !scope.search_enabled {
                return Err("accessDenied");
            }
            let mut filter = filter_from(args, root)?;
            let limit = filter.limit;
            // Hidden or out-of-scope notes are dropped below, so ask for the full page.
            filter.limit = 50;
            let matches =
                crate::index::find_notes(conn, root, &filter).map_err(|_| "unavailable")?;
            let notes: Vec<Value> = matches
                .into_iter()
                .filter_map(|result| {
                    indexed_note(conn, root, scope, &result.note.id)
                        .ok()
                        .map(|(note, _)| json!({
                            "id": note.id, "title": note.title, "path": relative_path(root, &note),
                            "snippet": result.snippet.map(|snippet| snippet.chars().take(1024).collect::<String>()),
                            "matchType": result.match_type,
                        }))
                })
                .take(limit)
                .collect();
            Ok(json!({"notes": notes}))
        }
        "list_tags" => {
            if !scope.search_enabled {
                return Err("accessDenied");
            }
            let tags = crate::index::list_tags(conn, root).map_err(|_| "unavailable")?;
            let truncated = tags.len() > 200;
            let tags: Vec<Value> = tags
                .into_iter()
                .take(200)
                .map(|entry| {
                    let count = entry
                        .notes
                        .iter()
                        .filter(|note| indexed_note(conn, root, scope, &note.id).is_ok())
                        .count();
                    json!({"tag": entry.tag, "count": count})
                })
                .filter(|tag| tag["count"] != 0)
                .collect();
            Ok(json!({"tags": tags, "truncated": truncated}))
        }
        "read_note" => {
            let id = string_arg(args, "id")?;
            let (note, file) = indexed_note(conn, root, scope, id)?;
            let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
            if offset > 1_000_000 {
                return Err("invalidArguments");
            }
            let limit = args
                .get("maxChars")
                .and_then(Value::as_u64)
                .unwrap_or(20_000)
                .min(20_000) as usize;
            let mut bytes = Vec::new();
            let cap = (offset as usize + limit + 1).saturating_mul(4);
            std::fs::File::open(file)
                .map_err(|_| "unavailable")?
                .take(cap as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "unavailable")?;
            let text = match std::str::from_utf8(&bytes) {
                Ok(text) => text,
                Err(error) if error.error_len().is_none() => {
                    std::str::from_utf8(&bytes[..error.valid_up_to()]).map_err(|_| "unavailable")?
                }
                Err(_) => return Err("unavailable"),
            };
            let mut chars = text.chars().skip(offset as usize);
            let content: String = chars.by_ref().take(limit).collect();
            let truncated = chars.next().is_some();
            Ok(
                json!({"id": note.id, "title": note.title, "path": relative_path(root, &note), "content": content, "truncated": truncated}),
            )
        }
        "list_folder" => {
            if !scope.search_enabled {
                return Err("accessDenied");
            }
            let folder = string_arg(args, "path")?;
            safe_folder(root, folder)?;
            let mut statement = conn
                .prepare("SELECT id FROM notes WHERE ?1 = '' OR substr(path, 1, length(?1) + 1) = ?1 || '/' ORDER BY path")
                .map_err(|_| "unavailable")?;
            let rows = statement
                .query_map([folder], |row| row.get::<_, String>(0))
                .map_err(|_| "unavailable")?;
            let mut notes = Vec::new();
            let mut truncated = false;
            for row in rows {
                let id = row.map_err(|_| "unavailable")?;
                if let Ok((note, _)) = indexed_note(conn, root, scope, &id) {
                    if notes.len() == 100 {
                        truncated = true;
                        break;
                    }
                    notes.push(json!({"id": note.id, "title": note.title, "path": relative_path(root, &note)}));
                }
            }
            Ok(json!({"notes": notes, "truncated": truncated}))
        }
        "get_outline" | "read_section" | "list_versions" | "get_properties" => {
            crate::tool_set::validate_fields(args, &["path"], &["heading", "occurrence"])?;
            let (note, _) = indexed_note(conn, root, scope, string_arg(args, "path")?)?;
            let mut args = args.clone();
            args["path"] = json!(relative_path(root, &note).ok_or("accessDenied")?);
            if name == "get_properties" {
                crate::tool_set::validate_fields(&args, &["path"], &[])?;
                let path = string_arg(&args, "path")?;
                return crate::vault_tools::properties::read(conn, root, path);
            }
            crate::tool_set::note_read(root, name, &args)
        }
        "get_note_info" => {
            crate::tool_set::validate_fields(args, &["id"], &[])?;
            let (note, _) = indexed_note(conn, root, scope, string_arg(args, "id")?)?;
            crate::vault_tools::hygiene::info(conn, root, &note)
        }
        "read_version" => {
            let version = crate::tool_set::note_read(root, name, args)?;
            // A version belongs to the note it was taken from, and that note sets the scope.
            indexed_note(conn, root, scope, string_arg(&version, "path")?)?;
            Ok(version)
        }
        "list_databases" | "read_database" | "query_database" => {
            if !scope.search_enabled {
                return Err("accessDenied");
            }
            crate::tool_set::domain_read(root, name, args)
        }
        "get_links" => {
            let (note, _) = indexed_note(conn, root, scope, string_arg(args, "id")?)?;
            let id = note.id.as_str();
            let mut statement = conn.prepare("SELECT note_id, target_note_id, target, label FROM links WHERE note_id = ?1 OR target_note_id = ?1 ORDER BY note_id, target LIMIT 201").map_err(|_| "unavailable")?;
            let rows = statement
                .query_map([id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|_| "unavailable")?;
            let mut links = Vec::new();
            let mut truncated = false;
            for (index, row) in rows.enumerate() {
                let (source, target, raw_target, label) = row.map_err(|_| "unavailable")?;
                if index == 200 {
                    truncated = true;
                    break;
                }
                if let Some(target) = target {
                    let other = if source == id { &target } else { &source };
                    if let Ok((note, _)) = indexed_note(conn, root, scope, other) {
                        links.push(json!({"id": note.id, "title": note.title, "path": relative_path(root, &note), "direction": if source == id { "outgoing" } else { "incoming" }}));
                    }
                } else if source == id {
                    // The unresolved target is text already present in the permitted note.
                    links.push(json!({"target": raw_target.chars().take(1024).collect::<String>(), "label": label.chars().take(1024).collect::<String>(), "direction": "outgoing", "unresolved": true}));
                }
            }
            Ok(json!({"links": links, "truncated": truncated}))
        }
        _ => Err("unknownTool"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn ai1_r3_rejects_private_and_escaping_paths() {
        let root = std::env::temp_dir().join(format!("amby-ai-path-{}", ulid::Ulid::generate()));
        fs::create_dir_all(root.join(".amby")).unwrap();
        fs::write(root.join("note.md"), "note").unwrap();
        fs::write(root.join(".amby/secret.md"), "secret").unwrap();
        assert!(resolve_note_path(&root, "note.md").is_ok());
        for path in [
            "../note.md",
            "/note.md",
            ".amby/secret.md",
            "assets/file.md",
            "./note.md",
        ] {
            assert_eq!(resolve_note_path(&root, path), Err("accessDenied"));
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("note.md"), root.join("link.md")).unwrap();
            assert_eq!(resolve_note_path(&root, "link.md"), Err("accessDenied"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    fn panel_vault(name: &str) -> (PathBuf, Connection) {
        let root = std::env::temp_dir().join(format!("amby-{name}-{}", ulid::Ulid::generate()));
        fs::create_dir_all(root.join("folder")).unwrap();
        // The desktop's vault root is canonical; so is the one the property reader compares.
        let root = fs::canonicalize(root).unwrap();
        let notes = [
            (
                "a",
                "folder/a.md",
                "---\ntitle: A\nstatus: open\n---\n# One\ntext\n## Two\nmore\n",
            ),
            ("b", "b.md", "# Secret\nhidden\n"),
        ];
        let conn = Connection::open_in_memory().unwrap();
        crate::index::init_schema(&conn).unwrap();
        for (id, path, body) in notes {
            fs::write(root.join(path), body).unwrap();
            conn.execute("INSERT INTO notes (id,path,title,mtime,size,content,word_count,created_at,updated_at) VALUES (?1,?2,?1,0,0,?3,1,0,0)", rusqlite::params![id,path,body]).unwrap();
        }
        (root, conn)
    }

    fn scoped(folder: &str, search: bool) -> ToolScope {
        ToolScope {
            search_enabled: search,
            note_ids: HashSet::new(),
            folders: vec![folder.into()],
            writes: Writes::Off,
        }
    }

    fn call(conn: &Connection, root: &Path, scope: &ToolScope, name: &str, args: Value) -> Value {
        ToolBudget::default().execute(conn, root, scope, name, &args)
    }

    #[test]
    fn panel_reads_stay_inside_the_context_scope() {
        let (root, conn) = panel_vault("panel-scope");
        let scope = scoped("folder", false);
        for (name, inside, outside) in [
            (
                "get_outline",
                json!({"path":"folder/a.md"}),
                json!({"path":"b.md"}),
            ),
            (
                "read_section",
                json!({"path":"folder/a.md","heading":"Two"}),
                json!({"path":"b.md","heading":"Secret"}),
            ),
            (
                "get_properties",
                json!({"path":"folder/a.md"}),
                json!({"path":"b.md"}),
            ),
            (
                "list_versions",
                json!({"path":"folder/a.md"}),
                json!({"path":"b.md"}),
            ),
            ("get_note_info", json!({"id":"a"}), json!({"id":"b"})),
        ] {
            let ok = call(&conn, &root, &scope, name, inside);
            assert!(ok.get("error").is_none(), "{name}: {ok}");
            assert_eq!(
                call(&conn, &root, &scope, name, outside)["error"],
                "accessDenied",
                "{name}"
            );
        }
        let outline = call(
            &conn,
            &root,
            &scope,
            "get_outline",
            json!({"path":"folder/a.md"}),
        );
        assert_eq!(outline["headings"].as_array().unwrap().len(), 2);
        let section = call(
            &conn,
            &root,
            &scope,
            "read_section",
            json!({"path":"folder/a.md","heading":"Two"}),
        );
        assert!(section["content"].as_str().unwrap().contains("more"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn panel_vault_wide_reads_need_the_search_switch() {
        let (root, conn) = panel_vault("panel-wide");
        let narrow = scoped("folder", false);
        let wide = scoped("folder", true);
        for name in ["list_tags", "list_databases"] {
            assert_eq!(
                call(&conn, &root, &narrow, name, json!({}))["error"],
                "accessDenied",
                "{name}"
            );
        }
        for (name, args) in [
            ("read_database", json!({"databaseId":"x"})),
            ("query_database", json!({"databaseId":"x"})),
        ] {
            assert_eq!(
                call(&conn, &root, &narrow, name, args)["error"],
                "accessDenied",
                "{name}"
            );
        }
        assert!(call(&conn, &root, &wide, "list_tags", json!({}))
            .get("error")
            .is_none());
        assert!(
            call(&conn, &root, &wide, "get_outline", json!({"path":"b.md"}))
                .get("error")
                .is_none()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn panel_versions_follow_the_note_scope_and_writes_do_not_exist() {
        let (root, conn) = panel_vault("panel-versions");
        let id_of = |path: &str| {
            crate::history::snapshot_before_write(&root, &root.join(path), b"changed", "ai-edit")
                .unwrap()
                .unwrap()
        };
        let (inside, outside) = (id_of("folder/a.md"), id_of("b.md"));
        let scope = scoped("folder", false);
        let read = call(&conn, &root, &scope, "read_version", json!({"id":inside}));
        assert_eq!(read["path"], "folder/a.md");
        assert!(read["content"].as_str().unwrap().contains("# One"));
        assert_eq!(
            call(&conn, &root, &scope, "read_version", json!({"id":outside}))["error"],
            "accessDenied"
        );
        let list = call(
            &conn,
            &root,
            &scope,
            "list_versions",
            json!({"path":"folder/a.md"}),
        );
        assert_eq!(list["versions"][0]["reason"], "ai-edit");
        let wide = scoped("folder", true);
        for name in ["restore_version", "delete_item", "open_in_amby"] {
            assert_eq!(
                call(&conn, &root, &wide, name, json!({}))["error"],
                "unknownTool",
                "{name}"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn panel_reads_are_strict_and_count_against_the_budget() {
        let (root, conn) = panel_vault("panel-budget");
        let scope = scoped("folder", true);
        let mut budget = ToolBudget::default();
        let args = json!({"path":"folder/a.md","extra":1});
        assert_eq!(
            budget.execute(&conn, &root, &scope, "get_outline", &args)["error"],
            "invalidArguments"
        );
        for _ in 0..7 {
            budget.execute(
                &conn,
                &root,
                &scope,
                "get_outline",
                &json!({"path":"folder/a.md"}),
            );
        }
        assert!(budget.exhausted());
        assert_eq!(
            budget.execute(
                &conn,
                &root,
                &scope,
                "get_outline",
                &json!({"path":"folder/a.md"})
            )["error"],
            "budgetExceeded"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn writing(folder: &str, mode: Writes) -> ToolScope {
        ToolScope {
            writes: mode,
            ..scoped(folder, false)
        }
    }

    #[test]
    fn panel_write_tools_only_propose_and_stay_in_the_write_scope() {
        let (root, conn) = panel_vault("panel-propose");
        let before_a = fs::read(root.join("folder/a.md")).unwrap();
        let before_b = fs::read(root.join("b.md")).unwrap();
        let scope = writing("folder", Writes::Context);
        let mut budget = ToolBudget::default();
        let edit = json!({"path":"folder/a.md","oldText":"text","newText":"changed"});
        let reply = budget.execute(&conn, &root, &scope, "edit_note", &edit);
        assert_eq!(reply["status"], "pending", "{reply}");
        assert!(reply["proposalId"].as_str().is_some());
        let outside = json!({"path":"b.md","oldText":"hidden","newText":"x"});
        assert_eq!(
            budget.execute(&conn, &root, &scope, "edit_note", &outside)["error"],
            "outsideWriteScope"
        );
        let new = json!({"path":"folder/new.md","content":"hi"});
        assert_eq!(
            budget.execute(&conn, &root, &scope, "new_note", &new)["status"],
            "pending"
        );
        let append = json!({"path":"folder/a.md","content":"tail"});
        assert_eq!(
            budget.execute(&conn, &root, &scope, "append_note", &append)["status"],
            "pending"
        );
        let drained = budget.take_proposals();
        assert_eq!(drained.len(), 3);
        assert!(budget.take_proposals().is_empty());
        // Nothing was written.
        assert_eq!(fs::read(root.join("folder/a.md")).unwrap(), before_a);
        assert_eq!(fs::read(root.join("b.md")).unwrap(), before_b);
        assert!(!root.join("folder/new.md").exists());
        // A chosen note is writable; the vault switch widens the scope.
        let mut chosen = writing("folder", Writes::Context);
        chosen.note_ids.insert("b".into());
        assert_eq!(
            budget.execute(&conn, &root, &chosen, "edit_note", &outside)["status"],
            "pending"
        );
        let wide = writing("folder", Writes::Vault);
        let mut budget = ToolBudget::default();
        assert_eq!(
            budget.execute(&conn, &root, &wide, "edit_note", &outside)["status"],
            "pending"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn panel_property_tools_only_propose_and_stay_in_the_write_scope() {
        let (root, conn) = panel_vault("panel-props");
        fs::create_dir_all(root.join(".amby/properties")).unwrap();
        fs::write(
            root.join(".amby/properties/layout.json"),
            "{\"groups\":16,\"hash\":\"blake3-first-hex\",\"template\":1,\"version\":1}\n",
        )
        .unwrap();
        let before = fs::read(root.join("folder/a.md")).unwrap();
        let scope = writing("folder", Writes::Context);
        let mut budget = ToolBudget::default();
        let set = json!({"path":"folder/a.md","name":"status","value":"done"});
        let reply = budget.execute(&conn, &root, &scope, "set_property", &set);
        assert_eq!(reply["status"], "pending", "{reply}");
        let rename = json!({"path":"folder/a.md","name":"status","newName":"state"});
        assert_eq!(
            budget.execute(&conn, &root, &scope, "rename_property", &rename)["status"],
            "pending"
        );
        let delete = json!({"path":"folder/a.md","name":"status"});
        assert_eq!(
            budget.execute(&conn, &root, &scope, "delete_property", &delete)["status"],
            "pending"
        );
        let outside = json!({"path":"b.md","name":"status","value":"x"});
        assert_eq!(
            budget.execute(&conn, &root, &scope, "set_property", &outside)["error"],
            "outsideWriteScope"
        );
        let strict = json!({"path":"folder/a.md","name":"status","value":"x","extra":1});
        assert_eq!(
            budget.execute(&conn, &root, &scope, "set_property", &strict)["error"],
            "invalidArguments"
        );
        assert_eq!(budget.take_proposals().len(), 3);
        assert_eq!(fs::read(root.join("folder/a.md")).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn panel_writes_are_refused_when_the_scope_has_no_writes_and_are_capped_per_turn() {
        let (root, conn) = panel_vault("panel-propose-off");
        let args = json!({"path":"folder/a.md","oldText":"text","newText":"changed"});
        let off = writing("folder", Writes::Off);
        assert_eq!(
            call(&conn, &root, &off, "edit_note", args.clone())["error"],
            "accessDenied"
        );
        let scope = writing("folder", Writes::Context);
        let mut budget = ToolBudget::default();
        for index in 0..PROPOSALS_PER_TURN {
            let args = json!({"path":format!("folder/n{index}.md"),"content":"x"});
            assert_eq!(
                budget.execute(&conn, &root, &scope, "new_note", &args)["status"],
                "pending"
            );
        }
        assert!(
            budget.exhausted()
                || budget.execute(
                    &conn,
                    &root,
                    &scope,
                    "new_note",
                    &json!({"path":"folder/z.md","content":"x"})
                )["error"]
                    == "tooManyProposals"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn panel_write_definitions_are_offered_only_with_writes() {
        let names = |writes| -> Vec<String> {
            panel_write_definitions(writes)
                .iter()
                .map(|tool| tool["name"].as_str().unwrap().to_owned())
                .collect()
        };
        assert!(names(Writes::Off).is_empty());
        assert_eq!(
            names(Writes::Context),
            [
                "new_note",
                "append_note",
                "edit_note",
                "set_property",
                "delete_property",
                "rename_property"
            ]
        );
        assert_eq!(names(Writes::Vault), names(Writes::Context));
        for tool in panel_write_definitions(Writes::Context) {
            assert_eq!(tool["annotations"]["readOnlyHint"], false);
            assert!(tool["description"].as_str().unwrap().contains("proposal"));
        }
    }

    #[test]
    fn panel_tool_list_is_one_definition_with_the_mcp_server() {
        let names = |search| -> Vec<String> {
            panel_definitions(search)
                .into_iter()
                .map(|(name, _, _)| name)
                .collect()
        };
        assert_eq!(
            names(false),
            [
                "read_note",
                "get_links",
                "get_outline",
                "read_section",
                "get_properties",
                "get_note_info",
                "list_versions",
                "read_version"
            ]
        );
        assert_eq!(
            names(true),
            [
                "read_note",
                "get_links",
                "search_notes",
                "list_folder",
                "list_tags",
                "get_outline",
                "read_section",
                "get_properties",
                "get_note_info",
                "list_versions",
                "read_version",
                "list_databases",
                "read_database",
                "query_database"
            ]
        );
        let mcp = panel_mcp_definitions(true);
        assert_eq!(mcp.len(), 14);
        for tool in &mcp {
            assert_eq!(tool["annotations"]["readOnlyHint"], true);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
        }
        for (name, description, schema) in panel_definitions(true) {
            let shared = crate::tool_set::definition_of(&name).unwrap();
            assert_eq!(shared["description"], description);
            assert_eq!(shared["inputSchema"], schema);
        }
    }

    #[test]
    fn ai1_r2_r4_r5_tools_are_read_only_scoped_and_bounded() {
        let root = std::env::temp_dir().join(format!("amby-ai-tools-{}", ulid::Ulid::generate()));
        fs::create_dir_all(root.join("folder")).unwrap();
        fs::write(root.join("folder/a.md"), "ёжик ABC").unwrap();
        fs::write(root.join("b.md"), "secret ABC").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::index::init_schema(&conn).unwrap();
        for (id, path, body) in [
            ("a", "folder/a.md", "ёжик ABC"),
            ("b", "b.md", "secret ABC"),
        ] {
            conn.execute("INSERT INTO notes (id,path,title,mtime,size,content,word_count,created_at,updated_at) VALUES (?1,?2,?1,0,0,?3,1,0,0)", rusqlite::params![id,path,body]).unwrap();
        }
        conn.execute("INSERT INTO links(note_id,raw,target,label,target_note_id) VALUES ('a','b','b','b','b')", []).unwrap();
        let before_a = fs::read(root.join("folder/a.md")).unwrap();
        let before_b = fs::read(root.join("b.md")).unwrap();
        let scope = ToolScope {
            search_enabled: false,
            note_ids: HashSet::new(),
            folders: vec!["folder".into()],
            writes: Writes::Off,
        };
        let mut budget = ToolBudget::default();
        assert_eq!(
            budget.execute(
                &conn,
                &root,
                &scope,
                "search_notes",
                &json!({"query":"ABC"})
            )["error"],
            "accessDenied"
        );
        assert_eq!(
            budget.execute(&conn, &root, &scope, "read_note", &json!({"id":"b"}))["error"],
            "accessDenied"
        );
        let result = budget.execute(
            &conn,
            &root,
            &scope,
            "read_note",
            &json!({"id":"a","offset":1,"maxChars":2}),
        );
        assert_eq!(result["content"], "жи");
        assert_eq!(result["truncated"], true);
        assert_eq!(
            budget.execute(&conn, &root, &scope, "get_links", &json!({"id":"a"}))["links"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let open_scope = ToolScope {
            search_enabled: true,
            note_ids: HashSet::new(),
            folders: vec![],
            writes: Writes::Off,
        };
        assert_eq!(
            budget.execute(
                &conn,
                &root,
                &open_scope,
                "search_notes",
                &json!({"query":"ABC","limit":1})
            )["notes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            budget.execute(
                &conn,
                &root,
                &open_scope,
                "list_folder",
                &json!({"path":"folder"})
            )["notes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            budget.execute(
                &conn,
                &root,
                &open_scope,
                "list_folder",
                &json!({"path":"../"})
            )["error"],
            "accessDenied"
        );
        budget.execute(&conn, &root, &open_scope, "read_note", &json!({"id":"a"}));
        assert!(budget.exhausted());
        assert_eq!(
            budget.execute(&conn, &root, &open_scope, "read_note", &json!({"id":"a"}))["error"],
            "budgetExceeded"
        );
        assert_eq!(fs::read(root.join("folder/a.md")).unwrap(), before_a);
        assert_eq!(fs::read(root.join("b.md")).unwrap(), before_b);
        fs::remove_dir_all(root).unwrap();
    }
}
