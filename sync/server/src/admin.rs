//! Administrator commands (П38, П39). In the stub stage all of them fail with `NotImplemented`.

use crate::state::AppState;
use crate::store::UserRecord;

/// Why an administrator command failed. [`AdminError::exit_code`] is the exit code of the
/// command line (П38).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AdminError {
    /// A stub (stage Э2, step 1).
    #[error("not_implemented: administrator command")]
    NotImplemented,
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
            Self::NotImplemented | Self::Other(_) => 1,
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

/// `user add <name>` (П38, П17): creates the user and a code valid for 24 hours; for a name
/// without a password it issues a new code and burns the old one.
pub fn user_add(_state: &AppState, _username: &str) -> Result<UserAdded, AdminError> {
    Err(AdminError::NotImplemented)
}

/// `user list` (П38).
pub fn user_list(_state: &AppState) -> Result<Vec<UserRecord>, AdminError> {
    Err(AdminError::NotImplemented)
}

/// `user remove <name> --yes` (П38): removes the user, devices, spaces and bodies for good.
pub fn user_remove(_state: &AppState, _username: &str) -> Result<(), AdminError> {
    Err(AdminError::NotImplemented)
}

/// `backup <dir>` (П38, Р11): an online copy of the database and of the bodies.
pub fn backup(_state: &AppState, _target: &std::path::Path) -> Result<(), AdminError> {
    Err(AdminError::NotImplemented)
}
