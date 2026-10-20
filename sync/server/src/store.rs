//! Storage interfaces (Р11): bodies and users sit behind traits, so that a paid service can plug
//! in S3 and billing without rewriting the server. The stubs here answer
//! [`StoreError::NotImplemented`] until stage Э2 gets its code.

use std::ops::Range;

/// Why a store call failed.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// A stub (stage Э2, step 1).
    #[error("not_implemented: store")]
    NotImplemented,
    /// No such object.
    #[error("not found")]
    NotFound,
    /// The disk or the database failed.
    #[error("storage failure: {0}")]
    Io(String),
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

/// The stub of [`BlobStore`].
#[derive(Debug, Default)]
pub struct StubBlobStore;

impl BlobStore for StubBlobStore {
    fn create(&self, _key: &BlobKey, _size: u64) -> StoreResult<()> {
        Err(StoreError::NotImplemented)
    }
    fn put_part(&self, _key: &BlobKey, _part: u32, _data: &[u8]) -> StoreResult<()> {
        Err(StoreError::NotImplemented)
    }
    fn assemble(&self, _key: &BlobKey, _parts: u32) -> StoreResult<()> {
        Err(StoreError::NotImplemented)
    }
    fn read(&self, _key: &BlobKey, _range: Option<Range<u64>>) -> StoreResult<Vec<u8>> {
        Err(StoreError::NotImplemented)
    }
    fn delete(&self, _key: &BlobKey) -> StoreResult<()> {
        Err(StoreError::NotImplemented)
    }
}

/// The stub of [`UserStore`].
#[derive(Debug, Default)]
pub struct StubUserStore;

impl UserStore for StubUserStore {
    fn add_user(&self, _username: &str, _code_hash: [u8; 32], _expires_ms: i64) -> StoreResult<()> {
        Err(StoreError::NotImplemented)
    }
    fn find_user(&self, _username: &str) -> StoreResult<Option<UserRecord>> {
        Err(StoreError::NotImplemented)
    }
    fn list_users(&self) -> StoreResult<Vec<UserRecord>> {
        Err(StoreError::NotImplemented)
    }
    fn remove_user(&self, _username: &str) -> StoreResult<()> {
        Err(StoreError::NotImplemented)
    }
}
