//! Cheap numbers for the pages of one database (a story's text, its anchors): words, the time of
//! the last change and the time the note was made. They come from the note index (`notes.word_count`, `notes.mtime`), which the vault
//! scan already keeps, so the panel and the project page can show progress without reading a
//! single file. Read-only, nothing is stored and nothing is written into a note.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::model::ProjectError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextPageStat {
    pub note_id: String,
    /// Words of the note's body as the index counted them when it last read the file.
    pub word_count: usize,
    /// Last modification time of the file, as the index keeps it.
    pub modified: Option<u64>,
    /// When the note was made, as the index keeps it: the order events were added in.
    pub created: Option<u64>,
}

/// The stat of every page of a database that the index knows, in no particular order.
pub fn list_text_stats(
    connection: &Connection,
    database_id: &str,
) -> Result<Vec<TextPageStat>, ProjectError> {
    let failed =
        |error: rusqlite::Error| ProjectError::failed("projectIndexFailed", error.to_string());
    let mut statement = connection
        .prepare(
            "SELECT m.note_id, n.word_count, n.mtime, n.created_at
             FROM db_members m
             JOIN notes n ON n.id = m.note_id
             WHERE m.database_id = ?1",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![database_id], |row| {
            Ok(TextPageStat {
                note_id: row.get(0)?,
                word_count: row.get::<_, i64>(1)?.max(0) as usize,
                modified: row
                    .get::<_, Option<i64>>(2)?
                    .map(|value| value.max(0) as u64),
                created: row
                    .get::<_, Option<i64>>(3)?
                    .map(|value| value.max(0) as u64),
            })
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::init_schema;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        connection
    }

    fn add_page(connection: &Connection, database: &str, id: &str, words: i64, mtime: i64) {
        connection
            .execute(
                "INSERT OR IGNORE INTO db_databases
                 (database_id, container_path, name, locked, format_version, manifest_revision, projection_state)
                 VALUES (?1, ?1, ?1, 0, 1, '', 'ready')",
                params![database],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at)
                 VALUES (?1, ?2, ?1, ?3, 0, '', ?4, ?3 - 100, 0)",
                params![id, format!("{database}/{id}.md"), mtime, words],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO db_members (database_id, note_id, parent_note_id, relative_path, category_path, depth, title_sort_key)
                 VALUES (?1, ?2, NULL, ?3, '', 0, x'00')",
                params![database, id, format!("{id}.md")],
            )
            .unwrap();
    }

    #[test]
    fn counts_only_the_pages_of_the_asked_database() {
        let connection = connection();
        add_page(&connection, "db_text", "01A", 120, 1_700_000_000);
        add_page(&connection, "db_text", "01B", 0, 1_700_000_500);
        add_page(&connection, "db_other", "01C", 999, 1_700_000_900);

        let mut stats = list_text_stats(&connection, "db_text").unwrap();
        stats.sort_by(|a, b| a.note_id.cmp(&b.note_id));

        assert_eq!(
            stats,
            vec![
                TextPageStat {
                    note_id: "01A".into(),
                    word_count: 120,
                    modified: Some(1_700_000_000),
                    created: Some(1_699_999_900),
                },
                TextPageStat {
                    note_id: "01B".into(),
                    word_count: 0,
                    modified: Some(1_700_000_500),
                    created: Some(1_700_000_400),
                },
            ]
        );
    }

    #[test]
    fn a_database_without_pages_is_an_empty_answer() {
        let connection = connection();
        assert!(list_text_stats(&connection, "db_missing")
            .unwrap()
            .is_empty());
    }
}
