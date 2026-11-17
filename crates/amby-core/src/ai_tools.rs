//! Path validation for the AI's read-only vault tools.
//!
//! Indexed paths are not trusted: files can be replaced with symbolic links
//! after indexing, and metadata folders must never be exposed to the model.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

pub(super) fn resolve_note_path(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
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

/// The model never chooses its own authority: this scope comes from the user's
/// context chips and per-conversation search setting.
pub(super) struct ToolScope {
    pub search_enabled: bool,
    pub note_ids: HashSet<String>,
    pub folders: Vec<String>,
}

#[derive(Default)]
pub(super) struct ToolBudget {
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
    if id.len() > 512 {
        return Err("invalidArguments");
    }
    let note = crate::index::note_by_id(conn, root, id).map_err(|_| "notFound")?;
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

fn safe_folder(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
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
            let query = string_arg(args, "query")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .min(10) as usize;
            let matches =
                crate::index::search_notes(conn, root, query).map_err(|_| "unavailable")?;
            let notes: Vec<Value> = matches
                .into_iter()
                .filter_map(|result| {
                    indexed_note(conn, root, scope, &result.note.id)
                        .ok()
                        .map(|(note, _)| json!({"id": note.id, "title": note.title}))
                })
                .take(limit)
                .collect();
            Ok(json!({"notes": notes}))
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
                json!({"id": note.id, "title": note.title, "content": content, "truncated": truncated}),
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
                    notes.push(json!({"id": note.id, "title": note.title}));
                }
            }
            Ok(json!({"notes": notes, "truncated": truncated}))
        }
        "get_links" => {
            let id = string_arg(args, "id")?;
            indexed_note(conn, root, scope, id)?;
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
                        links.push(json!({"id": note.id, "title": note.title, "direction": if source == id { "outgoing" } else { "incoming" }}));
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
