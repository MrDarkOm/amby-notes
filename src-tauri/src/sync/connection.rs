//! The server address and the user name, kept in the app data (`sync-connection.json`, next to
//! the settings of the application). They are not secrets (Р5). The record never holds a
//! password, a key, a token or the recovery code.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::frontmatter;

/// The file name inside the app data root.
pub const CONNECTION_FILE: &str = "sync-connection.json";

/// Where this device is signed in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRecord {
    /// The normalised address of the server.
    pub server_url: String,
    /// Whether it was added with the "local network" switch (П41).
    pub allow_http: bool,
    /// The user name on the server.
    pub username: String,
    /// The identifier of this device on the server.
    pub device_id: String,
}

/// The connection record could not be read or written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionError;

/// A place for the record. The real one is a file; tests use memory.
pub trait ConnectionStore: Send + Sync {
    /// The record, or `None` when there is none. A file that cannot be understood counts as none
    /// (the person just signs in again); it is never a crash.
    fn load(&self) -> Result<Option<ConnectionRecord>, ConnectionError>;
    /// Writes the record atomically.
    fn save(&self, record: &ConnectionRecord) -> Result<(), ConnectionError>;
    /// Removes the record; a missing one is not an error.
    fn clear(&self) -> Result<(), ConnectionError>;
}

/// The record in a JSON file, written with the atomic write of the application.
#[derive(Debug, Clone)]
pub struct FileConnectionStore {
    path: PathBuf,
}

impl FileConnectionStore {
    /// A store in `path` (the directory may not exist yet).
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The file this store uses.
    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}

impl ConnectionStore for FileConnectionStore {
    fn load(&self) -> Result<Option<ConnectionRecord>, ConnectionError> {
        match fs::read_to_string(&self.path) {
            Ok(text) => Ok(serde_json::from_str(&text).ok()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(ConnectionError),
        }
    }

    fn save(&self, record: &ConnectionRecord) -> Result<(), ConnectionError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| ConnectionError)?;
        }
        let text = serde_json::to_string_pretty(record).map_err(|_| ConnectionError)?;
        frontmatter::atomic_write_bytes(&self.path, text.as_bytes()).map_err(|_| ConnectionError)
    }

    fn clear(&self) -> Result<(), ConnectionError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ConnectionError),
        }
    }
}
