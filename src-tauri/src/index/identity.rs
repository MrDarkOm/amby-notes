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

pub fn ensure_unique_identity(conn: &Connection, note_id: &str) -> Result<(), String> {
    if is_path_identity(note_id) {
        return Err(
            "Note identity is invalid or duplicated; fix its frontmatter before this operation"
                .into(),
        );
    }
    let prefix = format!("{CONFLICT_PREFIX}{note_id}:");
    let duplicate: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE substr(id, 1, length(?1)) = ?1)",
            [&prefix],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if duplicate {
        return Err(
            "Duplicate note identity; fix the duplicate frontmatter before this operation".into(),
        );
    }
    Ok(())
}
