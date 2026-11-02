use std::path::{Path, PathBuf};

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

pub fn resolve_note_path_for_id(
    vault: &Path,
    container: &Path,
    note_id: &str,
) -> Result<PathBuf, String> {
    resolve_note_path_for_id_optional(vault, container, note_id)?.ok_or_else(|| {
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

    if let Ok(conn) = crate::index::open_connection(vault) {
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

pub fn find_database_container(vault: &Path, database_id: &str) -> Result<PathBuf, String> {
    let discovery = crate::database::discovery::discover_vault(vault)?;
    discovery
        .databases
        .into_iter()
        .find(|database| database.database_id == database_id)
        .map(|database| database.container_path)
        .ok_or_else(|| "Database was not found".to_owned())
}
