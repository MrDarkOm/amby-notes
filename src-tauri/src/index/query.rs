use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

use super::note_index::IndexedNote;
use crate::vault::scan::{abs_from_rel, path_string};

const SEARCH_LIMIT: i64 = 50;
const SNIPPET_RADIUS: usize = 60;

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub note: IndexedNote,
    pub match_type: String,
    pub snippet: Option<String>,
    pub score: i64,
}

#[derive(Clone, Copy)]
struct FoldedCharacter {
    character: char,
    start: usize,
    end: usize,
}

fn casefolded_characters(text: &str) -> Vec<FoldedCharacter> {
    text.char_indices()
        .flat_map(|(start, source)| {
            let end = start + source.len_utf8();
            source.to_lowercase().map(move |character| FoldedCharacter {
                character,
                start,
                end,
            })
        })
        .collect()
}

fn casefolded_range(content: &str, query: &str) -> Option<(usize, usize)> {
    let needle = casefolded_characters(query);
    if needle.is_empty() {
        return None;
    }
    let haystack = casefolded_characters(content);
    haystack
        .windows(needle.len())
        .find(|window| {
            window
                .iter()
                .zip(&needle)
                .all(|(haystack, needle)| haystack.character == needle.character)
        })
        .map(|window| (window[0].start, window[window.len() - 1].end))
}

fn advance_characters(content: &str, offset: usize, count: usize) -> usize {
    content[offset..]
        .char_indices()
        .nth(count)
        .map(|(index, _)| offset + index)
        .unwrap_or(content.len())
}

fn retreat_characters(content: &str, offset: usize, count: usize) -> usize {
    content[..offset]
        .char_indices()
        .rev()
        .nth(count.saturating_sub(1))
        .map(|(index, _)| index)
        .unwrap_or(0)
}

pub fn snippet(content: &str, query: &str) -> Option<String> {
    let (match_start, match_end) = casefolded_range(content, query)?;
    let start = retreat_characters(content, match_start, SNIPPET_RADIUS);
    let end = advance_characters(content, match_end, SNIPPET_RADIUS);
    Some(format!(
        "{}{}{}",
        if start > 0 { "..." } else { "" },
        &content[start..end],
        if end < content.len() { "..." } else { "" }
    ))
}

fn fts_query(query: &str) -> Option<String> {
    let terms = query
        .split_whitespace()
        .map(|term| {
            term.chars()
                .filter(|character| character.is_alphanumeric() || *character == '_')
                .collect::<String>()
        })
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{term}\"*"))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

fn row_to_note(vault: &Path, row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexedNote> {
    Ok(IndexedNote {
        id: row.get(0)?,
        path: {
            let rel: String = row.get(1)?;
            path_string(&abs_from_rel(vault, &rel))
        },
        title: row.get(2)?,
        modified: row.get::<_, Option<i64>>(3)?.map(|value| value as u64),
        word_count: row.get::<_, i64>(4)? as usize,
    })
}

pub fn search_notes(
    conn: &Connection,
    vault: &Path,
    query: &str,
) -> Result<Vec<SearchResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(tag_query) = query.strip_prefix('#') {
        return search_tags(conn, vault, tag_query.trim());
    }
    let Some(fts_query) = fts_query(query) else {
        return Ok(Vec::new());
    };
    let mut statement = conn
        .prepare(
            r#"
            SELECT notes.id, notes.path, notes.title, notes.mtime, notes.word_count, notes.content
            FROM notes_fts
            JOIN notes ON notes.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ?1
            ORDER BY bm25(notes_fts), notes.path
            LIMIT ?2
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![fts_query, SEARCH_LIMIT], |row| {
            let note = row_to_note(vault, row)?;
            Ok((note, row.get::<_, String>(5)?))
        })
        .map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for row in rows {
        let (note, content) = row.map_err(|error| error.to_string())?;
        let title_match = casefolded_range(&note.title, query).is_some();
        results.push(SearchResult {
            score: if title_match { 3 } else { 1 },
            match_type: if title_match { "name" } else { "content" }.to_string(),
            snippet: (!title_match).then(|| snippet(&content, query)).flatten(),
            note,
        });
    }
    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then(left.note.title.cmp(&right.note.title))
    });
    Ok(results)
}

fn search_tags(conn: &Connection, vault: &Path, query: &str) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let normalized_query = query.to_lowercase();
    let pattern = format!("%{normalized_query}%");
    let mut statement = conn
        .prepare(
            r#"
            SELECT notes.id, notes.path, notes.title, notes.mtime, notes.word_count,
                   GROUP_CONCAT('#' || tags.tag, '  ')
            FROM tags
            JOIN notes ON notes.id = tags.note_id
            WHERE tags.tag LIKE ?1
            GROUP BY notes.id
            ORDER BY CASE WHEN tags.tag = ?2 THEN 0 ELSE 1 END, notes.title
            LIMIT ?3
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![pattern, normalized_query, SEARCH_LIMIT], |row| {
            Ok((row_to_note(vault, row)?, row.get::<_, String>(5)?))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (note, tags) = row.map_err(|error| error.to_string())?;
        Ok(SearchResult {
            note,
            match_type: "tag".to_string(),
            snippet: Some(tags),
            score: 2,
        })
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_index::init_schema;

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn insert_note(conn: &Connection, id: &str, title: &str, content: &str) {
        conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, ?4, 0, 0, 0)",
            params![id, format!("{id}.md"), title, content],
        )
        .unwrap();
    }

    #[test]
    fn snippets_keep_unicode_boundaries_from_the_original_content() {
        let content = "Начало 🚀 İstanbul и завершающий текст";
        let result = snippet(content, "İSTANBUL").unwrap();

        assert!(result.contains("İstanbul"));
        assert!(snippet(content, "🚀").unwrap().contains('🚀'));
        assert!(snippet("e\u{301}clair", "E\u{301}C").is_some());
    }

    #[test]
    fn fts_search_limits_results_and_uses_indexed_content() {
        let conn = test_connection();
        for index in 0..55 {
            insert_note(
                &conn,
                &format!("{index:02}"),
                &format!("Note {index}"),
                "needle body",
            );
        }

        let results = search_notes(&conn, Path::new("/vault"), "needle").unwrap();
        assert_eq!(results.len(), SEARCH_LIMIT as usize);
        assert!(results.iter().all(|result| result.match_type == "content"));
    }

    #[test]
    fn schema_rebuilds_fts_for_an_existing_notes_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, content TEXT NOT NULL, word_count INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO notes VALUES ('legacy', 'Legacy.md', 'Legacy', 0, 0, 'needle from an older index', 0, 0, 0);",
        )
        .unwrap();
        init_schema(&conn).unwrap();

        let results = search_notes(&conn, Path::new("/vault"), "needle").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].note.id, "legacy");
    }

    #[test]
    fn tag_search_uses_the_indexed_tag_table() {
        let conn = test_connection();
        insert_note(&conn, "tagged", "Tagged", "body");
        conn.execute(
            "INSERT INTO tags (note_id, tag) VALUES ('tagged', 'проект')",
            [],
        )
        .unwrap();

        let results = search_notes(&conn, Path::new("/vault"), "#ПРО").unwrap();
        assert_eq!(results[0].match_type, "tag");
        assert_eq!(results[0].snippet.as_deref(), Some("#проект"));
    }
}
