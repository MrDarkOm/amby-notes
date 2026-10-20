//! Storage interfaces (Р11): bodies and users sit behind traits, so that a paid service can plug
//! in S3 and billing without rewriting the server. This file holds the traits and the stores of
//! a self-hosted server: bodies as files under `blobs/`, users in the SQLite database.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{params, OptionalExtension};

use crate::clock::Clock;
use crate::db::Db;

/// Why a store call failed.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// No such object.
    #[error("not found")]
    NotFound,
    /// The user already has a password: a new enrolment code is not issued (П17).
    #[error("the user already has a password")]
    HasPassword,
    /// The disk or the database failed.
    #[error("storage failure: {0}")]
    Io(String),
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::NotFound {
            Self::NotFound
        } else {
            Self::Io(error.to_string())
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// Result of a store call.
pub type StoreResult<T> = Result<T, StoreError>;

/// Where a body lives: the pair space and blob (П3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BlobKey {
    /// The space.
    pub space_id: [u8; 16],
    /// The body (equal to `body_id` of the header, П3).
    pub blob_id: [u8; 16],
}

/// Storage of sealed bodies, in parts (П21–П24). The files go under `/data/blobs/` (Р11).
pub trait BlobStore: Send + Sync {
    /// Starts a body of `size` bytes (П21).
    fn create(&self, key: &BlobKey, size: u64) -> StoreResult<()>;
    /// Stores or replaces part `part` (П22).
    fn put_part(&self, key: &BlobKey, part: u32, data: &[u8]) -> StoreResult<()>;
    /// Joins the `parts` parts into the final body (П23).
    fn assemble(&self, key: &BlobKey, parts: u32) -> StoreResult<()>;
    /// Reads a complete body or a byte range of it (П24).
    fn read(&self, key: &BlobKey, range: Option<Range<u64>>) -> StoreResult<Vec<u8>>;
    /// Deletes the body with all its parts (П25, П35).
    fn delete(&self, key: &BlobKey) -> StoreResult<()>;
}

/// What the server knows about a user (О2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRecord {
    /// The user name.
    pub username: String,
    /// The user has chosen a password (the code was used).
    pub has_password: bool,
    /// When the enrolment code expires, if one is waiting (П17).
    pub enroll_expires_ms: Option<i64>,
}

/// Accounting of users (Р11): the place where payment and quotas will plug in.
pub trait UserStore: Send + Sync {
    /// Creates a user with a waiting enrolment code, or replaces the code of a user without a
    /// password (П17). `code_hash` is the SHA-256 of the normalised code.
    fn add_user(&self, username: &str, code_hash: [u8; 32], expires_ms: i64) -> StoreResult<()>;
    /// Finds a user.
    fn find_user(&self, username: &str) -> StoreResult<Option<UserRecord>>;
    /// Lists all users.
    fn list_users(&self) -> StoreResult<Vec<UserRecord>>;
    /// Removes a user with everything that belongs to them.
    fn remove_user(&self, username: &str) -> StoreResult<()>;
}

/// Bodies as files: `blobs/<space>/<first byte of blob>/<blob>/part-<n>` while the upload runs
/// and `…/body` once it is complete. A part is written to a temporary file, synced and renamed,
/// so a reader sees a whole part or none. The body is joined the same way, so a crash leaves a
/// finished body or no body, never half of one.
#[derive(Debug, Clone)]
pub struct FsBlobStore {
    root: PathBuf,
}

impl FsBlobStore {
    /// A store under `data_dir/blobs`.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("blobs"),
        }
    }

    fn dir(&self, key: &BlobKey) -> PathBuf {
        self.root.join(relative_dir(key))
    }

    fn part_path(&self, key: &BlobKey, part: u32) -> PathBuf {
        self.dir(key).join(format!("part-{part}"))
    }

    /// Path of the complete body.
    pub fn body_path(&self, key: &BlobKey) -> PathBuf {
        self.dir(key).join("body")
    }

    /// The numbers of the parts that are on disk, ascending.
    pub fn list_parts(&self, key: &BlobKey) -> StoreResult<Vec<u32>> {
        let mut parts = Vec::new();
        let entries = match fs::read_dir(self.dir(key)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(parts),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let name = entry?.file_name();
            if let Some(number) = name
                .to_str()
                .and_then(|name| name.strip_prefix("part-"))
                .and_then(|number| number.parse::<u32>().ok())
            {
                parts.push(number);
            }
        }
        parts.sort_unstable();
        Ok(parts)
    }

    /// Removes the part files of a body whose joined file is safely in place.
    pub fn remove_parts(&self, key: &BlobKey) -> StoreResult<()> {
        for part in self.list_parts(key)? {
            match fs::remove_file(self.part_path(key, part)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// The keys of every body directory on disk (to find leftovers of a crash).
    pub fn all_keys(&self) -> StoreResult<Vec<BlobKey>> {
        let mut keys = Vec::new();
        let Ok(spaces) = fs::read_dir(&self.root) else {
            return Ok(keys);
        };
        for space in spaces.flatten() {
            let Some(space_id) = parse_hex16(&space.file_name().to_string_lossy()) else {
                continue;
            };
            let Ok(shards) = fs::read_dir(space.path()) else {
                continue;
            };
            for shard in shards.flatten() {
                let Ok(blobs) = fs::read_dir(shard.path()) else {
                    continue;
                };
                for blob in blobs.flatten() {
                    if let Some(blob_id) = parse_hex16(&blob.file_name().to_string_lossy()) {
                        keys.push(BlobKey { space_id, blob_id });
                    }
                }
            }
        }
        Ok(keys)
    }
}

/// The directory of a body below `blobs/`.
fn relative_dir(key: &BlobKey) -> PathBuf {
    let blob = hex(&key.blob_id);
    PathBuf::from(hex(&key.space_id))
        .join(&blob[..2])
        .join(blob)
}

/// The file of a complete body below `blobs/`.
pub(crate) fn relative_body_path(key: &BlobKey) -> PathBuf {
    relative_dir(key).join("body")
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn parse_hex16(text: &str) -> Option<[u8; 16]> {
    if text.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Makes the creation, rename or removal of a file in `dir` durable.
fn sync_dir(dir: &Path) {
    // A directory cannot be opened for syncing on every platform; the data is already synced.
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

impl BlobStore for FsBlobStore {
    fn create(&self, key: &BlobKey, _size: u64) -> StoreResult<()> {
        fs::create_dir_all(self.dir(key))?;
        Ok(())
    }

    fn put_part(&self, key: &BlobKey, part: u32, data: &[u8]) -> StoreResult<()> {
        let dir = self.dir(key);
        fs::create_dir_all(&dir)?;
        let temporary = dir.join(format!("part-{part}.tmp"));
        let mut file = File::create(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&temporary, self.part_path(key, part))?;
        sync_dir(&dir);
        Ok(())
    }

    fn assemble(&self, key: &BlobKey, parts: u32) -> StoreResult<()> {
        let dir = self.dir(key);
        let temporary = dir.join("body.tmp");
        let mut out = File::create(&temporary)?;
        for part in 0..parts {
            let mut input = File::open(self.part_path(key, part))?;
            io::copy(&mut input, &mut out)?;
        }
        out.sync_all()?;
        drop(out);
        fs::rename(&temporary, self.body_path(key))?;
        sync_dir(&dir);
        Ok(())
    }

    fn read(&self, key: &BlobKey, range: Option<Range<u64>>) -> StoreResult<Vec<u8>> {
        let mut file = File::open(self.body_path(key))?;
        let mut data = Vec::new();
        match range {
            None => {
                file.read_to_end(&mut data)?;
            }
            Some(range) => {
                file.seek(SeekFrom::Start(range.start))?;
                file.take(range.end.saturating_sub(range.start))
                    .read_to_end(&mut data)?;
            }
        }
        Ok(data)
    }

    fn delete(&self, key: &BlobKey) -> StoreResult<()> {
        match fs::remove_dir_all(self.dir(key)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        // Tidy up the shard and space directories once they are empty; failure is harmless.
        if let Some(shard) = self.dir(key).parent() {
            let _ = fs::remove_dir(shard);
            if let Some(space) = shard.parent() {
                let _ = fs::remove_dir(space);
            }
        }
        Ok(())
    }
}

/// Users in the SQLite database.
pub struct DbUserStore {
    db: Arc<Db>,
    blobs: Arc<FsBlobStore>,
    clock: Arc<dyn Clock>,
}

impl DbUserStore {
    /// A user store over `db`; removing a user also removes their bodies from `blobs`.
    pub fn new(db: Arc<Db>, blobs: Arc<FsBlobStore>, clock: Arc<dyn Clock>) -> Self {
        Self { db, blobs, clock }
    }
}

impl UserStore for DbUserStore {
    fn add_user(&self, username: &str, code_hash: [u8; 32], expires_ms: i64) -> StoreResult<()> {
        let now = self.clock.now_ms();
        self.db.write(|tx| -> StoreResult<()> {
            let existing: Option<bool> = tx
                .query_row(
                    "SELECT has_password FROM users WHERE username = ?1",
                    [username],
                    |row| row.get(0),
                )
                .optional()?;
            match existing {
                Some(true) => return Err(StoreError::HasPassword),
                Some(false) => {
                    tx.execute(
                        "UPDATE users SET enroll_hash = ?2, enroll_expires_ms = ?3 \
                         WHERE username = ?1",
                        params![username, code_hash.as_slice(), expires_ms],
                    )?;
                }
                None => {
                    tx.execute(
                        "INSERT INTO users (username, created_ms, enroll_hash, enroll_expires_ms) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![username, now, code_hash.as_slice(), expires_ms],
                    )?;
                }
            }
            Ok(())
        })
    }

    fn find_user(&self, username: &str) -> StoreResult<Option<UserRecord>> {
        Ok(self.db.call(|conn| {
            conn.query_row(
                "SELECT username, has_password, enroll_expires_ms FROM users WHERE username = ?1",
                [username],
                user_record,
            )
            .optional()
        })?)
    }

    fn list_users(&self) -> StoreResult<Vec<UserRecord>> {
        Ok(self.db.call(|conn| {
            let mut statement = conn.prepare(
                "SELECT username, has_password, enroll_expires_ms FROM users ORDER BY id",
            )?;
            let rows = statement.query_map([], user_record)?;
            rows.collect::<Result<Vec<_>, _>>()
        })?)
    }

    fn remove_user(&self, username: &str) -> StoreResult<()> {
        // The rows go first and the files after: a crash in between leaves files nobody refers
        // to (the cleanup sweeps them), never a row that points to a missing file.
        self.db.write_then(
            |tx| -> StoreResult<Vec<BlobKey>> {
                let id: i64 = tx
                    .query_row(
                        "SELECT id FROM users WHERE username = ?1",
                        [username],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or(StoreError::NotFound)?;
                let mut keys = Vec::new();
                {
                    let mut statement = tx.prepare(
                    "SELECT s.space_id, b.blob_id FROM blobs b JOIN spaces s ON s.id = b.space \
                     WHERE s.user_id = ?1",
                )?;
                    let rows = statement.query_map([id], |row| {
                        Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?))
                    })?;
                    for row in rows {
                        let (space, blob) = row?;
                        if let (Ok(space_id), Ok(blob_id)) = (space.try_into(), blob.try_into()) {
                            keys.push(BlobKey { space_id, blob_id });
                        }
                    }
                }
                tx.execute("DELETE FROM users WHERE id = ?1", [id])?;
                Ok(keys)
            },
            |tx, keys| {
                // Under the lock, and only for bodies whose row did not come back meanwhile.
                for key in keys {
                    if !crate::maintenance::row_exists(tx, key)? {
                        self.blobs.delete(key)?;
                    }
                }
                Ok(())
            },
        )?;
        Ok(())
    }
}

fn user_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRecord> {
    Ok(UserRecord {
        username: row.get(0)?,
        has_password: row.get(1)?,
        enroll_expires_ms: row.get(2)?,
    })
}
