//! The typed error of the storage commands (IPC-06): a stable code the interface turns into text,
//! and a detail for the logs. The interface never reads the category out of the detail, because
//! the detail carries the user's own paths ("Collision notes" is a folder name, not a collision).
//!
//! Commands translated so far: `create_note`, `create_folder`, `create_file`, `rename_item`,
//! `move_item`, `delete_item`, `archive_item`. The rest still send a bare string.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum StorageErrorCode {
    NotFound,
    AlreadyExists,
    PermissionDenied,
    InvalidPath,
    Failed,
    /// An undo found the item gone from where the operation left it, or its old place taken.
    UndoItemMoved,
    /// An undo found a note the operation rewrote changed since.
    UndoNoteChanged,
    /// An undo cannot run: the version it needs is gone, or the record is not one it can follow.
    UndoUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct StorageError {
    pub code: StorageErrorCode,
    /// For the logs only; may contain paths. Never shown.
    pub detail: String,
}

impl StorageError {
    pub fn new(code: StorageErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    /// A failed operating-system call: the kind of the error decides, not its text.
    pub fn from_io(error: &std::io::Error) -> Self {
        use std::io::ErrorKind;
        let code = match error.kind() {
            ErrorKind::NotFound => StorageErrorCode::NotFound,
            ErrorKind::AlreadyExists => StorageErrorCode::AlreadyExists,
            ErrorKind::PermissionDenied => StorageErrorCode::PermissionDenied,
            _ => classify(&error.to_string()),
        };
        Self::new(code, error.to_string())
    }
}

/// The helpers under the commands still report a sentence. Only the parts of it that Amby wrote
/// and the OS wrote decide: the numeric OS code at the very end, or a fixed sentence at the very
/// start. A path in the middle never counts.
fn classify(message: &str) -> StorageErrorCode {
    if let Some(number) = os_error_number(message) {
        match number {
            2 | 3 => return StorageErrorCode::NotFound,
            5 | 13 => return StorageErrorCode::PermissionDenied,
            17 | 80 | 183 => return StorageErrorCode::AlreadyExists,
            _ => {}
        }
    }
    // Amby's own sentences: a short words-only head, then a colon (or the whole sentence).
    let head = message.split(':').next().unwrap_or(message);
    let fixed_head =
        head.split(' ').count() <= 4 && head.chars().all(|c| c.is_ascii_alphabetic() || c == ' ');
    if !fixed_head {
        return StorageErrorCode::Failed;
    }
    let head = head.to_ascii_lowercase();
    if head.ends_with(" already exists") {
        StorageErrorCode::AlreadyExists
    } else if head.ends_with(" not found") {
        StorageErrorCode::NotFound
    } else if head.starts_with("path escapes vault")
        || head.starts_with("path must be relative")
        || head.starts_with("unsafe relative path")
        || head.starts_with("invalid ")
        || head.ends_with(" outside the vault")
        || head.ends_with(" is outside vault")
    {
        StorageErrorCode::InvalidPath
    } else {
        StorageErrorCode::Failed
    }
}

/// The `(os error N)` the standard library puts at the very end of an I/O error, which holds on a
/// localized Windows too. Looked for at the end only, so a folder name cannot imitate it.
fn os_error_number(message: &str) -> Option<u32> {
    let rest = message.trim_end().strip_suffix(')')?;
    let (_, number) = rest.rsplit_once("(os error ")?;
    number.parse().ok()
}

impl From<String> for StorageError {
    fn from(message: String) -> Self {
        Self::new(classify(&message), message)
    }
}

impl From<&str> for StorageError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::{create_note_impl, rename_item_impl};
    use std::fs;
    use std::path::PathBuf;

    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("amby-{label}-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn code(message: &str) -> StorageErrorCode {
        StorageError::from(message).code
    }

    #[test]
    fn a_folder_called_collision_does_not_turn_permission_denied_into_a_collision() {
        assert_eq!(
            code("Failed to write /v/Collision notes/a.md: Permission denied (os error 13)"),
            StorageErrorCode::PermissionDenied
        );
        assert_eq!(
            code("Path not accessible (/v/Already exists): Access is denied. (os error 5)"),
            StorageErrorCode::PermissionDenied
        );
        assert_eq!(
            code("Disk error in /v/Not found/a.md"),
            StorageErrorCode::Failed
        );
    }

    #[test]
    fn amby_sentences_and_os_codes_give_their_codes() {
        for (message, expected) in [
            (
                "File already exists: /v/a.md",
                StorageErrorCode::AlreadyExists,
            ),
            (
                "Target already exists: /v/a.md",
                StorageErrorCode::AlreadyExists,
            ),
            ("Source not found: /v/a.md", StorageErrorCode::NotFound),
            ("Path not found: /v/a.md", StorageErrorCode::NotFound),
            ("No such file (os error 2)", StorageErrorCode::NotFound),
            ("Path escapes vault: /v/../a", StorageErrorCode::InvalidPath),
            ("Invalid item name", StorageErrorCode::InvalidPath),
            ("Something else", StorageErrorCode::Failed),
        ] {
            assert_eq!(code(message), expected, "{message}");
        }
    }

    #[test]
    fn mutations_report_a_collision_and_a_missing_file_with_their_codes() {
        let vault = scratch("storage-error");
        fs::write(vault.join("A.md"), "a").unwrap();
        fs::write(vault.join("B.md"), "b").unwrap();
        let collision = rename_item_impl(&vault, &vault.join("A.md"), "B")
            .err()
            .expect("must fail");
        assert_eq!(
            StorageError::from(collision).code,
            StorageErrorCode::AlreadyExists
        );
        let missing = rename_item_impl(&vault, &vault.join("Gone.md"), "C")
            .err()
            .expect("must fail");
        assert_eq!(StorageError::from(missing).code, StorageErrorCode::NotFound);
        let existing = create_note_impl(&vault, "A").err().expect("must fail");
        assert_eq!(
            StorageError::from(existing).code,
            StorageErrorCode::AlreadyExists
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_write_is_permission_denied_even_inside_a_collision_folder() {
        use std::os::unix::fs::PermissionsExt;
        let vault = scratch("storage-error-denied");
        let folder = vault.join("Collision notes");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("A.md"), "a").unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
        let denied = rename_item_impl(&vault, &folder.join("A.md"), "B");
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        if let Err(message) = denied {
            assert_eq!(
                StorageError::from(message).code,
                StorageErrorCode::PermissionDenied
            );
        }
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_io_error_is_classified_by_its_kind() {
        let error = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            StorageError::from_io(&error).code,
            StorageErrorCode::PermissionDenied
        );
    }
}
