use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

use super::note_index::list_notes;

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraphNode {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unresolved: Option<bool>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraphEdge {
    pub source: String,
    pub target: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unresolved: Option<bool>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
pub struct LinkGraph {
    pub nodes: Vec<LinkGraphNode>,
    pub edges: Vec<LinkGraphEdge>,
}

pub fn normalize_wiki_target(raw: &str) -> String {
    let without_alias = raw.split('|').next().unwrap_or(raw);
    let base = without_alias
        .split(['#', '^'])
        .next()
        .unwrap_or(without_alias);
    base.trim()
        .trim_end_matches(".md")
        .replace('\\', "/")
        .to_lowercase()
}

pub fn protected_markdown_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();

    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        let mut offset = content
            .find('\n')
            .map(|index| index + 1)
            .unwrap_or(content.len());
        for line in content[offset..].split_inclusive('\n') {
            offset += line.len();
            if matches!(line.trim_end_matches(['\r', '\n']), "---" | "...") {
                ranges.push((0, offset));
                break;
            }
        }
    }

    let mut fenced: Option<(char, usize, usize)> = None;
    let mut offset = 0;

    for line in content.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next();
        let marker_len = marker
            .filter(|character| matches!(character, '`' | '~'))
            .map(|character| {
                trimmed
                    .chars()
                    .take_while(|current| *current == character)
                    .count()
            })
            .unwrap_or_default();

        if let Some((fence_character, fence_len, start)) = fenced {
            if marker == Some(fence_character) && marker_len >= fence_len {
                ranges.push((start, offset + line.len()));
                fenced = None;
            }
        } else if let Some(fence_character) = marker.filter(|_| marker_len >= 3) {
            fenced = Some((fence_character, marker_len, offset));
        }
        offset += line.len();
    }
    if let Some((_, _, start)) = fenced {
        ranges.push((start, content.len()));
    }

    let mut cursor = 0;
    while cursor < content.len() {
        if let Some((_, to)) = ranges
            .iter()
            .find(|(from, to)| cursor >= *from && cursor < *to)
        {
            cursor = *to;
            continue;
        }

        if content[cursor..].starts_with("%%") {
            let end = content[cursor + 2..]
                .find("%%")
                .map(|relative| cursor + 2 + relative + 2)
                .unwrap_or(content.len());
            ranges.push((cursor, end));
            cursor = end;
            continue;
        }

        if content[cursor..].starts_with('`') {
            let delimiter_len = content[cursor..]
                .chars()
                .take_while(|character| *character == '`')
                .count();
            let delimiter = "`".repeat(delimiter_len);
            let line_end = content[cursor..]
                .find('\n')
                .map(|relative| cursor + relative)
                .unwrap_or(content.len());
            let search_start = cursor + delimiter_len;
            if let Some(relative) = content[search_start..line_end].find(&delimiter) {
                let end = search_start + relative + delimiter_len;
                ranges.push((cursor, end));
                cursor = end;
                continue;
            }
        }

        cursor += content[cursor..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
    }

    ranges.sort_unstable_by_key(|range| range.0);
    ranges
}

pub fn extract_links(content: &str) -> Vec<(String, String, String)> {
    let mut links = Vec::new();
    let protected_ranges = protected_markdown_ranges(content);
    let mut cursor = 0;
    while let Some(relative_start) = content[cursor..].find("[[") {
        let start = cursor + relative_start;
        cursor = start + 2;
        if protected_ranges
            .iter()
            .any(|(from, to)| start >= *from && start < *to)
        {
            continue;
        }
        let Some(relative_end) = content[cursor..].find("]]") else {
            break;
        };
        let end = cursor + relative_end;
        let raw = &content[cursor..end];
        let target = normalize_wiki_target(raw);
        if !target.is_empty() {
            let label = raw
                .split('|')
                .nth(1)
                .unwrap_or_else(|| raw.split('|').next().unwrap_or(raw))
                .trim()
                .to_string();
            links.push((raw.to_string(), target, label));
        }
        cursor = end + 2;
    }
    links
}

pub fn build_note_lookup(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT id, path, title FROM notes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut lookup = HashMap::new();
    for row in rows {
        let (id, path, title) = row.map_err(|e| e.to_string())?;
        lookup.insert(title.to_lowercase(), id.clone());
        lookup.insert(path.trim_end_matches(".md").to_lowercase(), id.clone());
        if let Some(name) = path.split('/').next_back() {
            lookup.insert(name.trim_end_matches(".md").to_lowercase(), id);
        }
    }
    Ok(lookup)
}

pub fn resolve_links(conn: &Connection) -> Result<(), String> {
    let lookup = build_note_lookup(conn)?;

    conn.execute("UPDATE links SET target_note_id = NULL", [])
        .map_err(|e| e.to_string())?;

    let mut link_stmt = conn
        .prepare("SELECT rowid, target FROM links")
        .map_err(|e| e.to_string())?;
    let links = link_stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(link_stmt);

    for (rowid, target) in links {
        if let Some(target_id) = lookup.get(&target) {
            conn.execute(
                "UPDATE links SET target_note_id = ?1 WHERE rowid = ?2",
                params![target_id, rowid],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn resolve_links_for_note(conn: &Connection, note_id: &str) -> Result<(), String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT path, title FROM notes WHERE id = ?1",
            [note_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((path, title)) = row else {
        return Ok(());
    };

    let mut keys = vec![
        title.to_lowercase(),
        path.trim_end_matches(".md").to_lowercase(),
    ];
    if let Some(name) = path.split('/').next_back() {
        keys.push(name.trim_end_matches(".md").to_lowercase());
    }
    keys.sort();
    keys.dedup();

    let lookup = build_note_lookup(conn)?;
    let mut stmt = conn
        .prepare("SELECT rowid, target FROM links WHERE note_id = ?1")
        .map_err(|e| e.to_string())?;
    let outgoing = stmt
        .query_map([note_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (rowid, target) in outgoing {
        let target_id = lookup.get(&target);
        conn.execute(
            "UPDATE links SET target_note_id = ?1 WHERE rowid = ?2",
            params![target_id, rowid],
        )
        .map_err(|e| e.to_string())?;
    }

    let placeholders = keys.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let mut bind: Vec<String> = Vec::with_capacity(keys.len() + 1);
    bind.push(note_id.to_string());
    bind.extend(keys.iter().cloned());
    conn.execute(
        &format!(
            "UPDATE links SET target_note_id = NULL WHERE target_note_id = ?1 AND target NOT IN ({placeholders})"
        ),
        rusqlite::params_from_iter(bind.iter()),
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        &format!("UPDATE links SET target_note_id = ?1 WHERE target IN ({placeholders})"),
        rusqlite::params_from_iter(bind.iter()),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn link_graph(conn: &Connection, vault: &Path) -> Result<LinkGraph, String> {
    let notes = list_notes(conn, vault)?;
    let mut nodes: HashMap<String, LinkGraphNode> = notes
        .iter()
        .map(|note| {
            (
                note.id.clone(),
                LinkGraphNode {
                    id: note.id.clone(),
                    label: note.title.clone(),
                    unresolved: None,
                },
            )
        })
        .collect();
    let mut edges = Vec::new();
    let mut stmt = conn
        .prepare("SELECT note_id, target, label, target_note_id FROM links ORDER BY note_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (source, target, label, target_note_id) = row.map_err(|e| e.to_string())?;
        let (target_id, unresolved) = if let Some(id) = target_note_id {
            (id, false)
        } else {
            let id = format!("missing:{target}");
            nodes.entry(id.clone()).or_insert(LinkGraphNode {
                id: id.clone(),
                label: target,
                unresolved: Some(true),
            });
            (id, true)
        };
        edges.push(LinkGraphEdge {
            source,
            target: target_id,
            label,
            unresolved: if unresolved { Some(true) } else { None },
        });
    }
    Ok(LinkGraph {
        nodes: nodes.into_values().collect(),
        edges,
    })
}
