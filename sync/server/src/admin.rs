//! Administrator commands (П38, П39): `user add|list|remove` and `backup`.
//!
//! They work on the same data as a running server: the database lock of SQLite keeps the two
//! apart, and the one-time code is shown to the caller only, never written to a log.

use std::fs;
use std::io;
use std::path::Path;

use rusqlite::params;
use sha2::{Digest, Sha256};

use crate::db::DB_FILE;
use crate::state::AppState;
use crate::store::{BlobKey, StoreError, UserRecord};

/// Why an administrator command failed. [`AdminError::exit_code`] is the exit code of the
/// command line (П38).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AdminError {
    /// The name breaks the rules of П11.
    #[error("invalid user name")]
    InvalidName,
    /// The user already has a password (П17).
    #[error("the user already has a password")]
    HasPassword,
    /// Anything else.
    #[error("{0}")]
    Other(String),
}

impl AdminError {
    /// The exit code of the command line: 2 for a bad name, 3 for a user who has a password,
    /// 1 for the rest (П38).
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::InvalidName => 2,
            Self::HasPassword => 3,
            Self::Other(_) => 1,
        }
    }
}

impl From<StoreError> for AdminError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::HasPassword => Self::HasPassword,
            StoreError::NotFound => Self::Other("no such user".into()),
            StoreError::Io(message) => Self::Other(message),
        }
    }
}

/// The result of `user add` (П38).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAdded {
    /// The user name.
    pub username: String,
    /// The one-time code, shown once (П17). Never written to a log (П39).
    pub enroll_code: String,
    /// When the code expires.
    pub expires_ms: i64,
}

/// The valid names of П11: ASCII `a-z 0-9 . _ -`, 1 to 64 characters, a letter or a digit at
/// both ends.
pub(crate) fn valid_username(name: &str) -> bool {
    let bytes = name.as_bytes();
    let edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let inner = |byte: u8| edge(byte) || matches!(byte, b'.' | b'_' | b'-');
    (1..=64).contains(&bytes.len())
        && edge(bytes[0])
        && edge(bytes[bytes.len() - 1])
        && bytes.iter().copied().all(inner)
}

/// The code as a person types it: upper case, without dashes and spaces (П17).
pub(crate) fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| !matches!(c, '-' | ' ' | '\t'))
        .flat_map(char::to_uppercase)
        .collect()
}

/// The Crockford base32 alphabet of Ф27 (no `I`, `L`, `O`, `U`).
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A fresh code: 20 symbols of 5 random bits, 100 bits in all, shown in groups of four (П17).
fn new_code() -> Result<String, AdminError> {
    let mut random = [0u8; 20];
    getrandom::fill(&mut random).map_err(|error| AdminError::Other(error.to_string()))?;
    let symbols: Vec<char> = random
        .iter()
        // 256 is a multiple of 32, so taking five bits adds no bias.
        .map(|byte| char::from(ALPHABET[usize::from(byte & 31)]))
        .collect();
    Ok(symbols
        .chunks(4)
        .map(|group| group.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-"))
}

/// `user add <name>` (П38, П17): creates the user and a code valid for `enroll_code_hours`
/// hours (24 by default); for a name without a password it issues a new code and burns the old
/// one.
pub fn user_add(state: &AppState, username: &str) -> Result<UserAdded, AdminError> {
    if !valid_username(username) {
        return Err(AdminError::InvalidName);
    }
    let code = new_code()?;
    let hours = i64::try_from(state.config.enroll_code_hours).unwrap_or(i64::MAX / 3_600_000);
    let expires_ms = state
        .clock
        .now_ms()
        .saturating_add(hours.saturating_mul(3_600_000));
    let hash: [u8; 32] = Sha256::digest(normalize_code(&code).as_bytes()).into();
    state.users.add_user(username, hash, expires_ms)?;
    Ok(UserAdded {
        username: username.to_string(),
        enroll_code: code,
        expires_ms,
    })
}

/// `user list` (П38).
pub fn user_list(state: &AppState) -> Result<Vec<UserRecord>, AdminError> {
    Ok(state.users.list_users()?)
}

/// `user remove <name> --yes` (П38): removes the user, devices, spaces and bodies for good.
pub fn user_remove(state: &AppState, username: &str) -> Result<(), AdminError> {
    Ok(state.users.remove_user(username)?)
}

/// `backup <dir>` (П38, Р11): an online copy of the database and of the bodies.
///
/// The bodies are copied first and the database snapshot is taken after, then every body the
/// snapshot refers to is checked in the copy; if the cleanup removed one in between, the copy
/// is taken again. The copy is therefore never a database that points to a missing body.
pub fn backup(state: &AppState, target: &Path) -> Result<(), AdminError> {
    let other = |error: &dyn std::fmt::Display| AdminError::Other(error.to_string());
    fs::create_dir_all(target).map_err(|error| other(&error))?;
    let final_db = target.join(DB_FILE);
    if final_db.exists() {
        return Err(AdminError::Other(format!(
            "{} already holds a backup; use an empty directory",
            target.display()
        )));
    }
    let source_blobs = state.config.data_dir.join("blobs");
    let target_blobs = target.join("blobs");
    let partial = target.join(format!("{DB_FILE}.partial"));
    for _attempt in 0..3 {
        copy_tree(&source_blobs, &target_blobs).map_err(|error| other(&error))?;
        let _ = fs::remove_file(&partial);
        let partial_text = partial.to_string_lossy().into_owned();
        state
            .db
            .call(|conn| conn.execute("VACUUM INTO ?1", params![partial_text]))
            .map_err(|error| other(&error))?;
        if snapshot_is_complete(&partial, &target_blobs).map_err(|error| other(&error))? {
            fs::rename(&partial, &final_db).map_err(|error| other(&error))?;
            return Ok(());
        }
    }
    let _ = fs::remove_file(&partial);
    Err(AdminError::Other(
        "the data kept changing during the backup; try again when the server is quiet".into(),
    ))
}

/// Whether the body of every complete blob in the snapshot is in the copy.
fn snapshot_is_complete(snapshot: &Path, blobs: &Path) -> rusqlite::Result<bool> {
    let conn = rusqlite::Connection::open_with_flags(
        snapshot,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut statement = conn.prepare(
        "SELECT s.space_id, b.blob_id FROM blobs b JOIN spaces s ON s.id = b.space \
         WHERE b.complete = 1",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    for row in rows {
        let (space, blob) = row?;
        let (Ok(space_id), Ok(blob_id)) = (space.try_into(), blob.try_into()) else {
            return Ok(false);
        };
        let key = BlobKey { space_id, blob_id };
        if !blobs.join(crate::store::relative_body_path(&key)).exists() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Copies `from` into `to`; a file that is already there with the same size is left alone
/// (bodies never change once complete).
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    fs::create_dir_all(to)?;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().ends_with(".tmp") {
            continue;
        }
        let destination = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            let length = entry.metadata()?.len();
            let same = fs::metadata(&destination).is_ok_and(|have| have.len() == length);
            if !same {
                // A file removed by the cleanup while we copy is not an error.
                match fs::copy(entry.path(), &destination) {
                    Ok(_) => fs::File::open(&destination)?.sync_all()?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(())
}
