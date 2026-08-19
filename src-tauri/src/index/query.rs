use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

use super::note_index::IndexedNote;
use crate::vault::scan::{abs_from_rel, path_string};

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub note: IndexedNote,
    pub match_type: String,
    pub snippet: Option<String>,
    pub score: i64,
}

pub fn snippet(content: &str, query: &str) -> Option<String> {
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
    let idx = lower.find(&q)?;
    let start = idx.saturating_sub(60);
    let end = (idx + query.len() + 60).min(content.len());
    Some(format!(
        "{}{}{}",
        if start > 0 { "..." } else { "" },
        &content[start..end],
        if end < content.len() { "..." } else { "" }
    ))
}

pub fn search_notes(
    conn: &Connection,
    vault: &Path,
    query: &str,
) -> Result<Vec<SearchResult>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT id, path, title, mtime, word_count, content FROM notes ORDER BY path")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                IndexedNote {
                    id: row.get(0)?,
                    path: {
                        let rel: String = row.get(1)?;
                        path_string(&abs_from_rel(vault, &rel))
                    },
                    title: row.get(2)?,
                    modified: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    word_count: row.get::<_, i64>(4)? as usize,
                },
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for row in rows {
        let (note, content) = row.map_err(|e| e.to_string())?;
        let title = note.title.to_lowercase();
        if title.contains(&q) {
            results.push(SearchResult {
                note,
                match_type: "name".to_string(),
                snippet: None,
                score: if title.starts_with(&q) { 3 } else { 2 },
            });
        } else if content.to_lowercase().contains(&q) {
            results.push(SearchResult {
                note,
                match_type: "content".to_string(),
                snippet: snippet(&content, query),
                score: 1,
            });
        }
    }
    results.sort_by(|a, b| b.score.cmp(&a.score).then(a.note.title.cmp(&b.note.title)));
    Ok(results)
}
