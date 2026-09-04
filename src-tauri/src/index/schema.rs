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

        CREATE TABLE IF NOT EXISTS db_databases (
            database_id TEXT PRIMARY KEY,
            container_path TEXT NOT NULL UNIQUE,
            attached_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
            name TEXT NOT NULL,
            icon TEXT,
            cover_json TEXT,
            locked INTEGER NOT NULL,
            format_version INTEGER NOT NULL,
            manifest_revision TEXT NOT NULL,
            projection_state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS db_properties (
            database_id TEXT NOT NULL REFERENCES db_databases(database_id) ON DELETE CASCADE,
            property_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            property_type TEXT NOT NULL,
            page_visibility TEXT NOT NULL,
            config_json TEXT NOT NULL,
            yaml_key TEXT,
            yaml_direction TEXT,
            PRIMARY KEY (database_id, property_id)
        );
        CREATE TABLE IF NOT EXISTS db_options (
            database_id TEXT NOT NULL,
            property_id TEXT NOT NULL,
            option_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            status_group TEXT,
            PRIMARY KEY (database_id, property_id, option_id),
            FOREIGN KEY (database_id, property_id)
                REFERENCES db_properties(database_id, property_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS db_members (
            database_id TEXT NOT NULL REFERENCES db_databases(database_id) ON DELETE CASCADE,
            note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
            parent_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
            relative_path TEXT NOT NULL,
            category_path TEXT NOT NULL,
            depth INTEGER NOT NULL,
            title_sort_key BLOB NOT NULL,
            PRIMARY KEY (database_id, note_id)
        );
        CREATE TABLE IF NOT EXISTS db_record_revisions (
            database_id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            revision TEXT NOT NULL,
            PRIMARY KEY (database_id, note_id),
            FOREIGN KEY (database_id, note_id)
                REFERENCES db_members(database_id, note_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS db_values (
            database_id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            property_id TEXT NOT NULL,
            value_type TEXT NOT NULL,
            canonical_json TEXT NOT NULL,
            text_value TEXT,
            text_sort_key BLOB,
            decimal_value TEXT,
            decimal_sort_key BLOB,
            bool_value INTEGER,
            date_start TEXT,
            date_end TEXT,
            date_start_key INTEGER,
            date_end_key INTEGER,
            date_precision TEXT,
            option_id TEXT,
            source_revision TEXT NOT NULL,
            PRIMARY KEY (database_id, note_id, property_id),
            FOREIGN KEY (database_id) REFERENCES db_databases(database_id) ON DELETE CASCADE,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS db_value_options (
            database_id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            property_id TEXT NOT NULL,
            option_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (database_id, note_id, property_id, option_id),
            FOREIGN KEY (database_id, note_id, property_id)
                REFERENCES db_values(database_id, note_id, property_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS db_value_files (
            database_id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            property_id TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            relative_path TEXT NOT NULL,
            name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            PRIMARY KEY (database_id, note_id, property_id, asset_id),
            FOREIGN KEY (database_id, note_id, property_id)
                REFERENCES db_values(database_id, note_id, property_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS db_relation_edges (
            source_database_id TEXT NOT NULL,
            source_note_id TEXT NOT NULL,
            property_id TEXT NOT NULL,
            target_note_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            target_state TEXT NOT NULL,
            PRIMARY KEY (source_database_id, source_note_id, property_id, target_note_id),
            FOREIGN KEY (source_database_id) REFERENCES db_databases(database_id) ON DELETE CASCADE,
            FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS db_views (
            database_id TEXT NOT NULL REFERENCES db_databases(database_id) ON DELETE CASCADE,
            view_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            layout TEXT NOT NULL,
            revision TEXT NOT NULL,
            query_json TEXT NOT NULL,
            layout_json TEXT NOT NULL,
            projection_state TEXT NOT NULL,
            PRIMARY KEY (database_id, view_id)
        );
        CREATE TABLE IF NOT EXISTS db_templates (
            database_id TEXT NOT NULL REFERENCES db_databases(database_id) ON DELETE CASCADE,
            template_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            revision TEXT NOT NULL,
            body TEXT NOT NULL,
            values_json TEXT NOT NULL,
            projection_state TEXT NOT NULL,
            PRIMARY KEY (database_id, template_id)
        );
        CREATE TABLE IF NOT EXISTS db_yaml_conflicts (
            database_id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            property_id TEXT NOT NULL,
            base_json TEXT NOT NULL,
            shard_json TEXT NOT NULL,
            yaml_json TEXT NOT NULL,
            note_revision TEXT NOT NULL,
            record_revision TEXT NOT NULL,
            PRIMARY KEY (database_id, note_id, property_id),
            FOREIGN KEY (database_id) REFERENCES db_databases(database_id) ON DELETE CASCADE,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS db_diagnostics (
            diagnostic_id TEXT PRIMARY KEY,
            scope_kind TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            code TEXT NOT NULL,
            severity TEXT NOT NULL,
            details_json TEXT NOT NULL,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_db_databases_container_path
            ON db_databases(container_path);
        CREATE INDEX IF NOT EXISTS idx_db_members_parent
            ON db_members(database_id, parent_note_id, note_id);
        CREATE INDEX IF NOT EXISTS idx_db_members_title
            ON db_members(database_id, title_sort_key, note_id);
        CREATE INDEX IF NOT EXISTS idx_db_values_text
            ON db_values(database_id, property_id, text_sort_key, note_id);
        CREATE INDEX IF NOT EXISTS idx_db_values_decimal
            ON db_values(database_id, property_id, decimal_sort_key, note_id);
        CREATE INDEX IF NOT EXISTS idx_db_values_date
            ON db_values(database_id, property_id, date_start_key, note_id);
        CREATE INDEX IF NOT EXISTS idx_db_values_bool
            ON db_values(database_id, property_id, bool_value, note_id);
        CREATE INDEX IF NOT EXISTS idx_db_values_option
            ON db_values(database_id, property_id, option_id, note_id);
        CREATE INDEX IF NOT EXISTS idx_db_value_options_option
            ON db_value_options(database_id, property_id, option_id, note_id);
        CREATE INDEX IF NOT EXISTS idx_db_relation_target
            ON db_relation_edges(property_id, target_note_id, source_note_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS db_values_fts USING fts5(
            database_id UNINDEXED,
            note_id UNINDEXED,
            property_id UNINDEXED,
            searchable_text
        );

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

    // Cache-only schema version 2. Introspection makes an interrupted upgrade
    // repeatable; NULL stamps force one read of old rows without touching Markdown
    // or durable property sidecars. DDL and the outcome marker commit together.
    let has_mtime_ns: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name = 'mtime_ns')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if !has_mtime_ns {
        tx.execute("ALTER TABLE notes ADD COLUMN mtime_ns INTEGER", [])
            .map_err(|error| error.to_string())?;
    }
    tx.execute(
        "INSERT INTO index_metadata (key, value) VALUES ('file_stamp_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;

    conn.execute(
        "INSERT INTO index_metadata (key, value) VALUES ('database_schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )
    .map_err(|error| error.to_string())?;

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
