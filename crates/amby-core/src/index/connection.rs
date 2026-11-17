use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

use super::schema::init_schema;

pub fn db_path(vault: &Path) -> PathBuf {
    vault.join(".amby").join("notes.db")
}

pub fn open_connection(vault: &Path) -> Result<Connection, String> {
    let amby_dir = vault.join(".amby");
    fs::create_dir_all(&amby_dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(db_path(vault)).map_err(|e| e.to_string())?;
    // WAL + a busy timeout keep reads and writes from colliding now that heavy
    // commands run concurrently on the blocking thread pool.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
        .map_err(|e| e.to_string())?;
    init_schema(&conn)?;
    Ok(conn)
}
