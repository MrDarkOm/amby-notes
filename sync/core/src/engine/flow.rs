//! How a pass is left early (private): a stop, an error, or "try the whole pass again".

use crate::crypto::error::CryptoError;

use super::model::{EngineError, StopReason};
use super::ports::{FsError, RemoteError, StateError};

/// Why [`Res`] is not `Ok`.
pub(super) enum Flow {
    /// The pass stops before it did anything (Д60).
    Stop(StopReason),
    /// The pass fails; the state is whole (Д4).
    Err(EngineError),
    /// A commit lost the race: decide again (Д10).
    Retry,
}

pub(super) type Res<T> = Result<T, Flow>;

impl From<EngineError> for Flow {
    fn from(error: EngineError) -> Self {
        Flow::Err(error)
    }
}

impl From<RemoteError> for Flow {
    fn from(error: RemoteError) -> Self {
        match error {
            // Д19, С12: sign in again; nothing was written.
            RemoteError::Unauthorized | RemoteError::Revoked => {
                Flow::Stop(StopReason::AuthRequired)
            }
            other => Flow::Err(EngineError::Remote(other)),
        }
    }
}

impl From<FsError> for Flow {
    fn from(error: FsError) -> Self {
        Flow::Err(EngineError::Fs(error))
    }
}

impl From<StateError> for Flow {
    fn from(error: StateError) -> Self {
        Flow::Err(match error {
            StateError::Locked => EngineError::Locked,
            other => EngineError::State(other),
        })
    }
}

impl From<CryptoError> for Flow {
    fn from(error: CryptoError) -> Self {
        Flow::Err(EngineError::Crypto(error))
    }
}
