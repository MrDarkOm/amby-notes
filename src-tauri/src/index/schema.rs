use rusqlite::{Connection, OptionalExtension};

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            size INTEGER NOT NULL,
            content TEXT NOT NULL,
            word_count INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tags (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            PRIMARY KEY (note_id, tag)
        );
        CREATE TABLE IF NOT EXISTS links (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            raw TEXT NOT NULL,
            target TEXT NOT NULL,
            label TEXT NOT NULL,
            target_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS note_custom_properties (
            id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            property_type TEXT NOT NULL,
            value TEXT NOT NULL,
            settings TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (note_id, id)
        );
        CREATE TABLE IF NOT EXISTS index_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
        CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);
        CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);
        CREATE INDEX IF NOT EXISTS idx_links_note ON links(note_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title,
            content,
            content = 'notes',
            content_rowid = 'rowid',
            tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS notes_fts_after_insert AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_fts_after_delete AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content)
            VALUES ('delete', old.rowid, old.title, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_fts_after_update AFTER UPDATE OF title, content ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content)
            VALUES ('delete', old.rowid, old.title, old.content);
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;
        "#,
    )
    .map_err(|e| e.to_string())?;

    // Existing vault indexes predate the FTS table. Keep the rebuildable cache
    // in sync once without changing any user-owned Markdown source files.
    let fts_version: Option<String> = conn
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'notes_fts_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if fts_version.as_deref() != Some("1") {
        conn.execute("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')", [])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO index_metadata (key, value) VALUES ('notes_fts_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
