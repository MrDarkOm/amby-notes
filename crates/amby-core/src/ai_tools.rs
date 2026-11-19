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

/// `list_tags`, offered by the standalone MCP server only (the desktop chat keeps its own set).
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
}

#[derive(Default)]
pub struct ToolBudget {
    calls: usize,
    result_chars: usize,
}

impl ToolBudget {
    pub fn exhausted(&self) -> bool {
        self.calls >= 8 || self.result_chars >= 60_000
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
        let result = match run_tool(conn, root, scope, name, args) {
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
