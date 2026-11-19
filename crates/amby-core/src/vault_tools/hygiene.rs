//! Vault hygiene for the CLI and MCP: notes nothing links to, links to notes that do not
//! exist, and a summary of one note. Reads only.

use std::collections::HashSet;
use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::attachments;
use crate::index::read_only::visible_note;
use crate::index::{list_notes, IndexedNote};
use crate::vault::scan::normalize_rel_path;

const UNAVAILABLE: &str = "unavailable";

fn relative(root: &Path, note: &IndexedNote) -> Option<String> {
    Path::new(&note.path)
        .strip_prefix(root)
        .ok()
        .map(normalize_rel_path)
}

fn inside(path: &str, folder: &str) -> bool {
    folder.is_empty() || Path::new(path).starts_with(folder)
}

/// Visible notes that no other note links to.
pub fn orphans(
    conn: &Connection,
    root: &Path,
    folder: &str,
    limit: usize,
) -> Result<Value, &'static str> {
    crate::ai_tools::safe_folder(root, folder)?;
    let mut statement = conn
        .prepare("SELECT DISTINCT target_note_id FROM links WHERE target_note_id IS NOT NULL AND target_note_id != note_id")
        .map_err(|_| UNAVAILABLE)?;
    let linked: HashSet<String> = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| UNAVAILABLE)?
        .collect::<Result<_, _>>()
        .map_err(|_| UNAVAILABLE)?;
    let mut notes = Vec::new();
    let mut truncated = false;
    for note in list_notes(conn, root).map_err(|_| UNAVAILABLE)? {
        let Some(path) = relative(root, &note) else {
            continue;
        };
        if linked.contains(&note.id) || !inside(&path, folder) || visible_note(root, &path).is_err()
        {
            continue;
        }
        if notes.len() == limit {
            truncated = true;
            break;
        }
        notes.push(json!({ "path": path, "title": note.title, "id": note.id }));
    }
    Ok(json!({ "notes": notes, "truncated": truncated }))
}

/// Whether an unresolved wiki target names an existing file (an embedded attachment).
struct Files {
    names: Option<std::collections::BTreeMap<String, Vec<std::path::PathBuf>>>,
}

impl Files {
    fn exists(&mut self, root: &Path, target: &str) -> bool {
        let ext = Path::new(target).extension();
        if ext.is_none_or(|ext| ext.eq_ignore_ascii_case("md")) {
            return false;
        }
        if visible_file(root, target) {
            return true;
        }
        let Some(name) = Path::new(target).file_name() else {
            return false;
        };
        let names = self
            .names
            .get_or_insert_with(|| attachments::files_by_name(root));
        names.contains_key(&name.to_string_lossy().to_lowercase())
    }
}

fn visible_file(root: &Path, relative: &str) -> bool {
    attachments::visible_attachment(root, relative).is_ok()
}

fn raw_target(raw: &str) -> String {
    let target = raw.split('|').next().unwrap_or(raw);
    target.split('#').next().unwrap_or(target).trim().to_owned()
}

struct Unresolved {
    source: String,
    target: String,
    label: String,
}

fn unresolved_rows(
    conn: &Connection,
    root: &Path,
    note_id: Option<&str>,
    files: &mut Files,
) -> Result<Vec<(String, Unresolved)>, &'static str> {
    let mut statement = conn
        .prepare(
            "SELECT n.id, n.path, l.raw, l.label FROM links l JOIN notes n ON n.id = l.note_id
             WHERE l.target_note_id IS NULL AND (?1 IS NULL OR l.note_id = ?1) ORDER BY n.path, l.raw",
        )
        .map_err(|_| UNAVAILABLE)?;
    let rows = statement
        .query_map([note_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|_| UNAVAILABLE)?;
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let (id, source, raw, label) = row.map_err(|_| UNAVAILABLE)?;
        let target = raw_target(&raw);
        if target.is_empty()
            || files.exists(root, &target)
            || !seen.insert((source.clone(), target.to_lowercase()))
        {
            continue;
        }
        found.push((
            id,
            Unresolved {
                source,
                target,
                label,
            },
        ));
    }
    Ok(found)
}

/// Links whose target note does not exist, with the note that holds each.
pub fn unresolved(
    conn: &Connection,
    root: &Path,
    folder: &str,
    limit: usize,
) -> Result<Value, &'static str> {
    crate::ai_tools::safe_folder(root, folder)?;
    let mut files = Files { names: None };
    let mut links = Vec::new();
    let mut truncated = false;
    for (_, link) in unresolved_rows(conn, root, None, &mut files)? {
        if !inside(&link.source, folder) || visible_note(root, &link.source).is_err() {
            continue;
        }
        if links.len() == limit {
            truncated = true;
            break;
        }
        links.push(json!({ "source": link.source, "target": link.target, "label": link.label }));
    }
    Ok(json!({ "links": links, "truncated": truncated }))
}

fn count(conn: &Connection, sql: &str, id: &str) -> Result<u64, &'static str> {
    conn.query_row(sql, [id], |row| row.get::<_, i64>(0))
        .map(|n| n.max(0) as u64)
        .map_err(|_| UNAVAILABLE)
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis() as u64)
}

/// A summary of one note: where it is, its size and words, tags, links, properties and
/// attachments.
pub fn info(conn: &Connection, root: &Path, note: &IndexedNote) -> Result<Value, &'static str> {
    let path = relative(root, note).ok_or("accessDenied")?;
    let file = visible_note(root, &path)?;
    let metadata = std::fs::metadata(&file).map_err(|_| UNAVAILABLE)?;
    let text = std::fs::read_to_string(&file).map_err(|_| "invalidEncoding")?;
    let parsed = crate::frontmatter::parse_markdown(&text);
    let mut tags: Vec<String> = {
        let mut statement = conn
            .prepare("SELECT tag FROM tags WHERE note_id = ?1 ORDER BY tag")
            .map_err(|_| UNAVAILABLE)?;
        let rows = statement
            .query_map([&note.id], |row| row.get::<_, String>(0))
            .map_err(|_| UNAVAILABLE)?;
        rows.collect::<Result<_, _>>().map_err(|_| UNAVAILABLE)?
    };
    tags.dedup();
    let outgoing = count(
        conn,
        "SELECT COUNT(DISTINCT target_note_id) FROM links WHERE note_id = ?1 AND target_note_id IS NOT NULL",
        &note.id,
    )?;
    let incoming = count(
        conn,
        "SELECT COUNT(DISTINCT note_id) FROM links WHERE target_note_id = ?1 AND note_id != ?1",
        &note.id,
    )?;
    let unresolved = unresolved_rows(conn, root, Some(&note.id), &mut Files { names: None })?.len();
    let properties = super::properties::read(conn, root, &path)
        .ok()
        .and_then(|listing| listing["properties"].as_array().map(Vec::len));
    let attachments = attachments::list(root, &file, &text);
    let missing = attachments
        .iter()
        .filter(|attachment| !attachment.exists)
        .count();
    Ok(json!({
        "path": path,
        "noteId": parsed.id,
        "title": note.title,
        "size": metadata.len(),
        "words": note.word_count,
        "modified": millis(metadata.modified()),
        "created": millis(metadata.created()),
        "tags": tags,
        "links": { "outgoing": outgoing, "incoming": incoming, "unresolved": unresolved },
        "properties": properties,
        "attachments": { "count": attachments.len(), "missing": missing },
    }))
}
