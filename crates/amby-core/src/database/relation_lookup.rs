//! Lightweight Relation picker lookups over the SQLite projection: server-side
//! candidate search with keyset paging, and batch resolution of stored note IDs.
//! Searching and resolving are separate operations: a selected page must be
//! named even when it is far outside any loaded search page.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const MAX_CANDIDATE_PAGE: u32 = 100;
pub const DEFAULT_CANDIDATE_PAGE: u32 = 50;
pub const MAX_RESOLVED_REFERENCES: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchRelationCandidatesRequest {
    pub expected_generation: u64,
    /// The database the Relation points to.
    pub database_id: String,
    pub search: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RelationCandidate {
    pub note_id: String,
    pub title: String,
    /// Path inside the vault; lets the picker tell equal titles apart.
    pub path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RelationCandidatePage {
    pub candidates: Vec<RelationCandidate>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRecordReferencesRequest {
    pub expected_generation: u64,
    pub note_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RecordReferenceState {
    /// The note is in the vault index.
    Ok,
    /// No indexed note has this ID: deleted, in the trash, or not yet indexed.
    Missing,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordReference {
    pub note_id: String,
    pub state: RecordReferenceState,
    pub title: Option<String>,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRecordReferences {
    /// One entry per requested ID, in request order.
    pub references: Vec<RecordReference>,
}

fn like_pattern(search: &str) -> String {
    let escaped = search
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn encode_cursor(sort_key: &[u8], note_id: &str) -> String {
    let hex: String = sort_key.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{hex}:{note_id}")
}

fn decode_cursor(cursor: &str) -> Result<(Vec<u8>, String), String> {
    let (hex, note_id) = cursor
        .split_once(':')
        .ok_or_else(|| "cursor is malformed".to_owned())?;
    if hex.len() % 2 != 0 || ulid::Ulid::from_string(note_id).is_err() {
        return Err("cursor is malformed".to_owned());
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "cursor is malformed".to_owned())?;
    Ok((bytes, note_id.to_owned()))
}

pub fn search_relation_candidates(
    conn: &Connection,
    request: &SearchRelationCandidatesRequest,
) -> Result<RelationCandidatePage, String> {
    if ulid::Ulid::from_string(&request.database_id).is_err() {
        return Err("databaseId must be a canonical ULID".to_owned());
    }
    let exists = conn
        .query_row(
            "SELECT 1 FROM db_databases WHERE database_id = ?1",
            [&request.database_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if exists.is_none() {
        return Err("Database was not found".to_owned());
    }
    let limit = request
        .limit
        .unwrap_or(DEFAULT_CANDIDATE_PAGE)
        .clamp(1, MAX_CANDIDATE_PAGE);
    let pattern = request
        .search
        .as_deref()
        .map(str::trim)
        .filter(|search| !search.is_empty())
        .map(like_pattern);
    let cursor = request.cursor.as_deref().map(decode_cursor).transpose()?;
    let (cursor_key, cursor_id) = match cursor {
        Some((key, id)) => (Some(key), Some(id)),
        None => (None, None),
    };
    let mut statement = conn
        .prepare(
            "SELECT m.note_id, n.title, n.path, m.title_sort_key \
             FROM db_members m JOIN notes n ON n.id = m.note_id \
             WHERE m.database_id = ?1 \
               AND (?2 IS NULL OR n.title LIKE ?2 ESCAPE '\\' COLLATE NOCASE) \
               AND (?3 IS NULL OR (m.title_sort_key, m.note_id) > (?3, ?4)) \
             ORDER BY m.title_sort_key ASC, m.note_id ASC LIMIT ?5",
        )
        .map_err(|error| error.to_string())?;
    // One extra row tells whether another page exists.
    let rows = statement
        .query_map(
            params![
                request.database_id,
                pattern,
                cursor_key,
                cursor_id,
                limit + 1
            ],
            |row| {
                Ok((
                    RelationCandidate {
                        note_id: row.get(0)?,
                        title: row.get(1)?,
                        path: row.get(2)?,
                    },
                    row.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let has_next = rows.len() > limit as usize;
    let mut candidates = Vec::with_capacity(rows.len().min(limit as usize));
    let mut next_cursor = None;
    for (index, (candidate, sort_key)) in rows.into_iter().enumerate() {
        if index == limit as usize {
            break;
        }
        if has_next && index + 1 == limit as usize {
            next_cursor = Some(encode_cursor(&sort_key, &candidate.note_id));
        }
        candidates.push(candidate);
    }
    Ok(RelationCandidatePage {
        candidates,
        next_cursor,
    })
}

pub fn resolve_record_references(
    conn: &Connection,
    request: &ResolveRecordReferencesRequest,
) -> Result<ResolvedRecordReferences, String> {
    if request.note_ids.len() > MAX_RESOLVED_REFERENCES {
        return Err(format!(
            "At most {MAX_RESOLVED_REFERENCES} references can be resolved at once"
        ));
    }
    if request
        .note_ids
        .iter()
        .any(|id| ulid::Ulid::from_string(id).is_err())
    {
        return Err("noteIds must be canonical ULIDs".to_owned());
    }
    let mut statement = conn
        .prepare("SELECT title, path FROM notes WHERE id = ?1")
        .map_err(|error| error.to_string())?;
    let mut references = Vec::with_capacity(request.note_ids.len());
    for note_id in &request.note_ids {
        let found = statement
            .query_row(params_from_iter([note_id]), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .optional()
            .map_err(|error| error.to_string())?;
        references.push(match found {
            Some((title, path)) => RecordReference {
                note_id: note_id.clone(),
                state: RecordReferenceState::Ok,
                title: Some(title),
                path: Some(path),
            },
            None => RecordReference {
                note_id: note_id.clone(),
                state: RecordReferenceState::Missing,
                title: None,
                path: None,
            },
        });
    }
    Ok(ResolvedRecordReferences { references })
}

#[cfg(test)]
#[path = "relation_lookup_test.rs"]
mod tests;
