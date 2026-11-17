use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::bundle::rollback_bundle_promotion;
use crate::database::format::MAX_JSON_BYTES;
use crate::frontmatter::{self, AtomicCreateError};

pub(crate) fn json_bytes(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_JSON_BYTES {
        return Err("Generated database JSON is too large".to_owned());
    }
    Ok(bytes)
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match frontmatter::atomic_write_bytes_new(path, bytes) {
        Ok(()) => Ok(()),
        Err(AtomicCreateError::AlreadyExists) => {
            Err(format!("File already exists: {}", path.display()))
        }
        Err(AtomicCreateError::Other(error)) => Err(error),
    }
}

pub(super) fn rollback_promotion(promoted: Option<&(PathBuf, PathBuf)>) -> Result<(), String> {
    if let Some((original, main_note)) = promoted {
        rollback_bundle_promotion(original, main_note)?;
    }
    Ok(())
}

/// Opens the SQLite index read-only, for path hints only. `None` when there is no readable
/// index; every caller then uses the filesystem, so a missing or damaged index never blocks an
/// edit and never gets created by one.
pub(crate) fn open_hint_connection(vault: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        crate::index::db_path(vault),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.busy_timeout(std::time::Duration::from_millis(2000))
        .ok()?;
    Some(conn)
}

pub fn resolve_note_path_for_id(
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Result<PathBuf, String> {
    resolve_note_path_for_id_hinted(
        open_hint_connection(vault).as_ref(),
        vault,
        container,
        note_id,
    )
}

/// [`resolve_note_path_for_id`] with an index connection the caller already holds (opened once
/// for a whole batch instead of once per note).
pub(crate) fn resolve_note_path_for_id_hinted(
    hint: Option<&Connection>,
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Result<PathBuf, String> {
    resolve_note_path_for_id_optional_hinted(hint, vault, container, note_id)?.ok_or_else(|| {
        format!(
            "Note not found for ID {note_id} in database container {}",
            container.display()
        )
    })
}

pub(super) fn resolve_note_path_for_id_optional(
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Result<Option<PathBuf>, String> {
    resolve_note_path_for_id_optional_hinted(
        open_hint_connection(vault).as_ref(),
        vault,
        container,
        note_id,
    )
}

/// True when the last projection recorded a duplicate of this kind anywhere in the vault, or when
/// that cannot be read. An ID with two owners must be settled by the filesystem (which refuses),
/// never by the index picking one of the files.
fn index_reports_duplicates(conn: &Connection, code: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM db_diagnostics WHERE code = ?1)",
        [code],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(true)
}

/// The index path of a note is only a hint: the index can lag the disk. It is trusted only after
/// reading that one file and finding the same `amby-id` inside this container and outside every
/// nested database and service folder. Anything else walks the container.
fn indexed_note_hint(
    conn: &Connection,
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Option<PathBuf> {
    if index_reports_duplicates(conn, "duplicateNoteId") {
        return None;
    }
    let rel: String = conn
        .query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
            row.get(0)
        })
        .ok()?;
    let full = crate::paths::confine(vault, &vault.join(rel)).ok()?;
    if !full.is_file() || full.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return None;
    }
    let mut directory = full.parent()?;
    while directory != container {
        if !directory.starts_with(container) {
            return None;
        }
        let name = directory.file_name()?.to_string_lossy();
        if crate::vault::scan::is_service_directory(name.as_ref())
            || crate::database::discovery::find_manifest_path(directory).is_some()
        {
            return None;
        }
        directory = directory.parent()?;
    }
    let parsed = frontmatter::read_markdown(&full).ok()?;
    (parsed.note_id() == Some(note_id)).then_some(full)
}

pub(crate) fn resolve_note_path_for_id_optional_hinted(
    hint: Option<&Connection>,
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Result<Option<PathBuf>, String> {
    if let Some(path) = hint.and_then(|conn| indexed_note_hint(conn, vault, container, note_id)) {
        return Ok(Some(path));
    }
    #[cfg(test)]
    container_walk_seam::CONTAINER_WALKS.with(|walks| walks.set(walks.get() + 1));
    let mut matches = Vec::new();
    let mut unreadable_entry = None;

    for entry in walkdir::WalkDir::new(container)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let file_name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                // Do not descend into service directories
                if crate::vault::scan::is_service_directory(file_name.as_ref()) {
                    return false;
                }
                // Do not descend into nested database containers
                if e.path() != container
                    && crate::database::discovery::find_manifest_path(e.path()).is_some()
                {
                    return false;
                }
            }
            true
        })
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                unreadable_entry.get_or_insert_with(|| error.to_string());
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            match frontmatter::read_markdown(path) {
                Ok(parsed) => {
                    if parsed.note_id() == Some(note_id) {
                        matches.push(path.to_path_buf());
                    } else if let Some(error) = parsed.parse_error {
                        unreadable_entry.get_or_insert(error);
                    }
                }
                Err(error) => {
                    unreadable_entry.get_or_insert(error);
                }
            }
        }
    }

    if matches.len() == 1 {
        return Ok(Some(matches.remove(0)));
    }
    if matches.len() > 1 {
        return Err(format!(
            "Ambiguous note ID: {note_id} found in multiple notes under {}",
            container.display()
        ));
    }

    if let Some(conn) = hint {
        let rel_path: Result<String, _> =
            conn.query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
                row.get(0)
            });
        if let Ok(rel) = rel_path {
            let full = vault.join(&rel);
            if full.is_file() && full.starts_with(container) {
                let parsed = frontmatter::read_markdown(&full)
                    .map_err(|error| format!("Note {note_id} is not readable: {error}"))?;
                if parsed.note_id() == Some(note_id) {
                    return Ok(Some(full));
                }
            }
        }
    }
    if let Some(error) = unreadable_entry {
        return Err(format!(
            "Cannot resolve note {note_id}: an entry in database container {} is not readable: {error}",
            container.display()
        ));
    }
    Ok(None)
}

/// The container of a database, from the index when it still matches the disk.
///
/// `db_databases.container_path` is only a hint: it is trusted after reading that one manifest and
/// finding the same database ID in a valid manifest inside the vault. A moved, renamed, broken or
/// unindexed database scans the vault, as before.
pub fn find_database_container(vault: &Path, database_id: &str) -> Result<PathBuf, String> {
    if let Some(container) = open_hint_connection(vault)
        .and_then(|conn| indexed_database_container(&conn, vault, database_id))
    {
        return Ok(container);
    }
    let discovery = crate::database::discovery::discover_vault(vault)?;
    discovery
        .databases
        .into_iter()
        .find(|database| database.database_id == database_id)
        .map(|database| database.container_path)
        .ok_or_else(|| "Database was not found".to_owned())
}

fn indexed_database_container(
    conn: &Connection,
    vault: &Path,
    database_id: &str,
) -> Option<PathBuf> {
    if index_reports_duplicates(conn, "duplicateDatabaseId") {
        return None;
    }
    let relative: String = conn
        .query_row(
            "SELECT container_path FROM db_databases WHERE database_id = ?1",
            [database_id],
            |row| row.get(0),
        )
        .ok()?;
    let container = crate::paths::confine(vault, &vault.join(relative)).ok()?;
    let manifest_path = crate::database::discovery::find_manifest_path(&container)?;
    let bytes = std::fs::read(manifest_path).ok()?;
    let parsed = crate::database::format::parse_manifest(&bytes).ok()?;
    if parsed.value.database_id != database_id
        || !crate::database::validation::validate_manifest(&parsed.value)
            .errors
            .is_empty()
    {
        return None;
    }
    Some(container)
}

/// Test-only counter: how many times a database container was walked to find a note.
#[cfg(test)]
pub(crate) mod container_walk_seam {
    use std::cell::Cell;
    thread_local! {
        pub(crate) static CONTAINER_WALKS: Cell<usize> = const { Cell::new(0) };
    }
}
