//! Search narrowed by tags, header properties and a folder (docs/cli.md, docs/mcp.md).
//!
//! The text query uses the regular full-text search; the filters keep only the notes that
//! match all of them. Property values are read from each candidate's header; names and values
//! are compared after NFC, ignoring case.

use std::collections::HashSet;
use std::path::Path;

use rusqlite::Connection;
use unicode_normalization::UnicodeNormalization;

use super::{list_notes, search_notes, SearchResult};
use crate::frontmatter::{header_keys, HeaderKeys};

/// One property condition: the key must be present, and when `value` is given, the value
/// (or one item of a list) must equal it, ignoring case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyFilter {
    pub name: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteFilter {
    pub query: Option<String>,
    /// Every tag must be present; a tag also matches its nested tags (`work` finds `work/a`).
    pub tags: Vec<String>,
    pub properties: Vec<PropertyFilter>,
    /// A vault-relative folder, `""` for the whole vault.
    pub folder: String,
    pub limit: usize,
}

impl NoteFilter {
    /// A search needs a text query or at least one filter.
    pub fn is_empty(&self) -> bool {
        self.query
            .as_deref()
            .is_none_or(|query| query.trim().is_empty())
            && self.tags.is_empty()
            && self.properties.is_empty()
            && self.folder.is_empty()
    }
}

fn fold(text: &str) -> String {
    text.trim().nfc().collect::<String>().to_lowercase()
}

/// The notes carrying `tag` or one of its nested tags, ignoring case in every script.
fn tagged(conn: &Connection, tag: &str) -> Result<HashSet<String>, String> {
    let tag = fold(tag.trim_start_matches('#'));
    let nested = format!("{tag}/");
    let mut statement = conn
        .prepare("SELECT note_id, tag FROM tags")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut notes = HashSet::new();
    for row in rows {
        let (note, candidate) = row.map_err(|error| error.to_string())?;
        let candidate = fold(&candidate);
        if candidate == tag || candidate.starts_with(&nested) {
            notes.insert(note);
        }
    }
    Ok(notes)
}

/// Any header key whose name equals the filter's, ignoring case in every script (`статус`
/// finds `Статус`); `amby-*` keys are never properties.
fn has_property(text: &str, filter: &PropertyFilter) -> bool {
    let HeaderKeys::Keys(keys) = header_keys(text) else {
        return false;
    };
    let name = fold(&filter.name);
    let wanted = filter.value.as_deref().map(fold);
    keys.iter()
        .filter(|key| !key.key.trim().to_ascii_lowercase().starts_with("amby-"))
        .filter(|key| fold(&key.key) == name)
        .any(|key| match &wanted {
            None => true,
            Some(wanted) => {
                fold(&key.value) == *wanted || key.items.iter().any(|item| fold(item) == *wanted)
            }
        })
}

fn in_folder(vault: &Path, path: &str, folder: &str) -> bool {
    if folder.is_empty() {
        return true;
    }
    Path::new(path)
        .strip_prefix(vault)
        .is_ok_and(|relative| relative.starts_with(folder))
}

/// The notes matching every condition of `filter`, best text matches first, then by path.
pub fn find_notes(
    conn: &Connection,
    vault: &Path,
    filter: &NoteFilter,
) -> Result<Vec<SearchResult>, String> {
    let query = filter
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty());
    let candidates = match query {
        Some(query) => search_notes(conn, vault, query)?,
        None => list_notes(conn, vault)?
            .into_iter()
            .map(|note| SearchResult {
                note,
                match_type: "filter".to_string(),
                snippet: None,
                score: 0,
            })
            .collect(),
    };
    let mut required_tags = None::<HashSet<String>>;
    for tag in &filter.tags {
        let notes = tagged(conn, tag)?;
        required_tags = Some(match required_tags {
            Some(previous) => previous.intersection(&notes).cloned().collect(),
            None => notes,
        });
    }
    let folder = filter.folder.trim_matches('/');
    let mut results = Vec::new();
    for result in candidates {
        if results.len() >= filter.limit {
            break;
        }
        if !in_folder(vault, &result.note.path, folder)
            || required_tags
                .as_ref()
                .is_some_and(|ids| !ids.contains(&result.note.id))
        {
            continue;
        }
        if !filter.properties.is_empty() {
            let Ok(text) = std::fs::read_to_string(&result.note.path) else {
                continue;
            };
            if !filter
                .properties
                .iter()
                .all(|property| has_property(&text, property))
            {
                continue;
            }
        }
        results.push(result);
    }
    Ok(results)
}
