use std::path::Path;

use rusqlite::Connection;

pub const CONFLICT_PREFIX: &str = "amby-conflict:";
pub const OPAQUE_PREFIX: &str = "amby-opaque:";
pub const OPAQUE_SOURCE_PREFIX: &str = "amby-opaque:source:";

/// Invalid YAML has no trustworthy source identity. These keys are cache-only,
/// bound to the current relative path and editor boundary, never durable IDs.
pub fn opaque_id(rel_path: &str, status: crate::model::FrontmatterStatus) -> String {
    let mode = if status == crate::model::FrontmatterStatus::Unterminated {
        "source"
    } else {
        "body"
    };
    format!("{OPAQUE_PREFIX}{mode}:{rel_path}")
}

pub fn is_path_identity(note_id: &str) -> bool {
    note_id.starts_with(CONFLICT_PREFIX) || note_id.starts_with(OPAQUE_PREFIX)
}

/// Rebuildable, path-scoped index key. Never write it into source frontmatter
/// or use it as a durable property identity.
pub fn conflict_id(claimed_id: Option<&str>, rel_path: &str) -> String {
    format!(
        "{CONFLICT_PREFIX}{}:{rel_path}",
        claimed_id.unwrap_or("invalid")
    )
}

/// Is `rel_path` the copy of a conflict made by synchronisation: `Name.<12 hex>-conflict.md`
/// (docs/sync-plan.md, Р7, Д46)? Such a copy repeats the `amby-id` of its file on purpose and is
/// the one duplicate that never takes the identity and never blocks the file under its name.
pub fn is_sync_conflict_copy(rel_path: &str) -> bool {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let Some(at) = name.rfind("-conflict") else {
        return false;
    };
    let tail = &name[at + "-conflict".len()..];
    if !(tail.is_empty() || tail.starts_with('.')) {
        return false;
    }
    let head = &name[..at];
    let Some(dot) = head.rfind('.') else {
        return false;
    };
    let id = &head[dot + 1..];
    dot > 0
        && id.len() == 12
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The file a copy of a conflict of synchronisation was made from (docs/sync-plan.md, Д46, inverted):
/// `Name.<12 hex>-conflict.ext` → `Name.ext`, in the same folder.
pub fn original_of_conflict_copy(rel_path: &str) -> Option<String> {
    if !is_sync_conflict_copy(rel_path) {
        return None;
    }
    let (dir, name) = match rel_path.rfind('/') {
        Some(at) => (&rel_path[..=at], &rel_path[at + 1..]),
        None => ("", rel_path),
    };
    let at = name.rfind("-conflict")?;
    let dot = name[..at].rfind('.')?;
    Some(format!(
        "{dir}{}{}",
        &name[..dot],
        &name[at + "-conflict".len()..]
    ))
}

/// Does a copy of a conflict of synchronisation hold `claimed` as a duplicate, that is, as a key that
/// is not an identity (docs/vault-format.md)? It does while it repeats the `amby-id` of its file, and also
/// when that file is not there: a copy never holds the identity alone (Р7). Once "keep both" gave the copy
/// an identity of its own, it is an ordinary note.
pub fn conflict_copy_is_duplicate(vault: &Path, rel_path: &str, claimed: &str) -> bool {
    let Some(original) = original_of_conflict_copy(rel_path) else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(vault.join(&original)) else {
        return true;
    };
    crate::frontmatter::parse_markdown(&text).note_id() == Some(claimed)
}

pub fn ensure_unique_identity(conn: &Connection, note_id: &str) -> Result<(), String> {
    if is_path_identity(note_id) {
        return Err(
            "Note identity is invalid or duplicated; fix its frontmatter before this operation"
                .into(),
        );
    }
    let prefix = format!("{CONFLICT_PREFIX}{note_id}:");
    let mut statement = conn
        .prepare("SELECT id FROM notes WHERE substr(id, 1, length(?1)) = ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([&prefix], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for row in rows {
        let key = row.map_err(|error| error.to_string())?;
        // The copy of a conflict of synchronisation does not count (Р7).
        if !is_sync_conflict_copy(&key[prefix.len()..]) {
            return Err(
                "Duplicate note identity; fix the duplicate frontmatter before this operation"
                    .into(),
            );
        }
    }
    Ok(())
}
