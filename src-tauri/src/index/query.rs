use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

use super::note_index::IndexedNote;
use crate::vault::scan::{abs_from_rel, path_string};

const SEARCH_LIMIT: i64 = 50;
const SNIPPET_RADIUS: usize = 60;
// FTS5 BM25 returns lower (normally negative) values for more relevant rows.
// Keep enough precision when exposing the existing integer score over IPC, while
// reserving bounded adjustments for clearly stronger title matches.
const BM25_SCORE_SCALE: f64 = 1_000_000_000.0;
const TITLE_EXACT_BONUS: i64 = 1_200;
const TITLE_PREFIX_BONUS: i64 = 700;
const TITLE_CONTAINS_BONUS: i64 = 250;

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

/// Split a user search string into the word-like units understood by FTS.
///
/// Underscores stay within a token to preserve identifier searches, while all
/// other punctuation is a boundary. This deliberately turns `foo-bar` into
/// `foo`, `bar` rather than silently searching for `foobar`.
fn search_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| !(character.is_alphanumeric() || character == '_'))
        .filter(|term| !term.is_empty())
        .map(str::to_owned)
        .collect()
}

fn fts_query(query: &str) -> Option<String> {
    let terms = search_terms(query)
        // Terms are generated exclusively by `search_terms`, rather than
        // accepting FTS syntax from the user. Quoting them also keeps the
        // expression shape fixed as an AND of prefix searches.
        .iter()
        .map(|term| format!("\"{term}\"*"))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

fn search_score(rank: f64, title: &str, query: &str) -> i64 {
    let normalized_title = title.trim().to_lowercase();
    let normalized_query = query.trim().to_lowercase();
    let title_bonus = if normalized_title == normalized_query {
        TITLE_EXACT_BONUS
    } else if normalized_title.starts_with(&normalized_query) {
        TITLE_PREFIX_BONUS
    } else if normalized_title.contains(&normalized_query) {
        TITLE_CONTAINS_BONUS
    } else {
        0
    };

    // Negating preserves FTS5's direction: a lower BM25 rank becomes a higher
    // score. The bonuses deliberately adjust, rather than replace, relevance.
    (-rank * BM25_SCORE_SCALE).round() as i64 + title_bonus
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
            SELECT notes.id, notes.path, notes.title, notes.mtime, notes.word_count, notes.content,
                   bm25(notes_fts) AS rank
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
            Ok((note, row.get::<_, String>(5)?, row.get::<_, f64>(6)?))
        })
        .map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for row in rows {
        let (note, content, rank) = row.map_err(|error| error.to_string())?;
        let title_match = casefolded_range(&note.title, query).is_some();
        results.push(SearchResult {
            score: search_score(rank, &note.title, query),
            match_type: if title_match { "name" } else { "content" }.to_string(),
            snippet: (!title_match).then(|| snippet(&content, query)).flatten(),
            note,
        });
    }
    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.note.path.cmp(&right.note.path))
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
    fn search_terms_split_punctuation_without_losing_unicode_words() {
        assert_eq!(search_terms("foo-bar"), ["foo", "bar"]);
        assert_eq!(search_terms("foo/bar"), ["foo", "bar"]);
        assert_eq!(search_terms("hello.world"), ["hello", "world"]);
        assert_eq!(
            search_terms("русский/український"),
            ["русский", "український"]
        );
        assert_eq!(search_terms("emoji 🔥"), ["emoji"]);
    }

    #[test]
    fn search_terms_define_special_query_behavior() {
        assert_eq!(search_terms("C++"), ["C"]);
        assert_eq!(search_terms("C#"), ["C"]);
        assert_eq!(search_terms("node.js"), ["node", "js"]);
        assert_eq!(search_terms("file-name"), ["file", "name"]);
        assert_eq!(search_terms("foo/bar"), ["foo", "bar"]);
        assert_eq!(search_terms("snake_case"), ["snake_case"]);
    }

    #[test]
    fn fts_queries_do_not_admit_user_fts_syntax() {
        assert_eq!(
            fts_query("foo OR bar\" NEAR/10 baz*"),
            Some(
                "\"foo\"* AND \"OR\"* AND \"bar\"* AND \"NEAR\"* AND \"10\"* AND \"baz\"*"
                    .to_string()
            )
        );
    }

    #[test]
    fn punctuation_separated_terms_match_independently() {
        let conn = test_connection();
        insert_note(&conn, "separated", "Separated", "foo-bar baz");
        insert_note(&conn, "joined", "Joined", "foobar baz");

        let results = search_notes(&conn, Path::new("/vault"), "foo-bar").unwrap();
        assert_eq!(
            results
                .iter()
                .map(|result| result.note.id.as_str())
                .collect::<Vec<_>>(),
            ["separated"]
        );
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
    fn fts_ranking_is_preserved_with_title_match_bonuses() {
        let conn = test_connection();
        insert_note(&conn, "apple", "Apple", "A short note about fruit.");
        insert_note(&conn, "pie", "Apple pie", "A short dessert recipe.");
        insert_note(
            &conn,
            "cooking",
            "Cooking",
            "apple apple apple apple apple apple apple apple apple apple apple apple",
        );
        let long_fruit_note = format!("apple apple apple apple {}", "orchard ".repeat(100));
        insert_note(&conn, "fruit", "Fruit", &long_fruit_note);
        insert_note(&conn, "random", "Random", "apple");

        let results = search_notes(&conn, Path::new("/vault"), "apple").unwrap();
        let ids = results
            .iter()
            .map(|result| result.note.id.as_str())
            .collect::<Vec<_>>();

        // Exact and prefix title matches are elevated, while content-only rows
        // retain their FTS relevance order instead of falling back to titles.
        assert_eq!(
            ids,
            ["apple", "pie", "cooking", "random", "fruit"],
            "scores: {:?}",
            results
                .iter()
                .map(|result| result.score)
                .collect::<Vec<_>>()
        );
        assert!(results[0].score > results[1].score);
        assert!(
            results[2].score > results[3].score,
            "content scores: {} then {}",
            results[2].score,
            results[3].score
        );
        assert!(results[3].score > results[4].score);
    }

    #[test]
    fn fts_ranking_handles_cyrillic_emoji_and_mixed_text() {
        let conn = test_connection();
        insert_note(&conn, "russian", "русский", "Текст о языке");
        insert_note(&conn, "ukrainian", "український", "Текст про мову");
        insert_note(&conn, "emoji", "Emoji 🔥", "emoji fire 🔥");
        insert_note(
            &conn,
            "mixed",
            "Mixed English/русский",
            "English и русский текст",
        );

        assert_eq!(
            search_notes(&conn, Path::new("/vault"), "русский")
                .unwrap()
                .iter()
                .map(|result| result.note.id.as_str())
                .collect::<Vec<_>>(),
            ["russian", "mixed"]
        );
        assert_eq!(
            search_notes(&conn, Path::new("/vault"), "український").unwrap()[0]
                .note
                .id,
            "ukrainian"
        );
        let emoji_results = search_notes(&conn, Path::new("/vault"), "emoji").unwrap();
        assert_eq!(emoji_results[0].note.id, "emoji");
        assert!(emoji_results[0].note.title.contains('🔥'));
        assert_eq!(
            search_notes(&conn, Path::new("/vault"), "English").unwrap()[0]
                .note
                .id,
            "mixed"
        );
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
