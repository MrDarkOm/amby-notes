//! The flows of the connect screen (Р5, О1, О3, О8; П11–П19), without Tauri so that they are
//! tested against a real server in the process.
//!
//! **The recovery code comes before the account.** `prepare_account` makes the keys on this
//! device and keeps them in memory only; `confirm_recovery_code` sends them after the person has
//! typed back some groups of the code. So the server never holds an account whose code nobody has
//! seen, and the one-time code of the administrator is not burned by a person who gave up.

use std::sync::{Arc, Mutex};

use amby_sync_core::crypto::account::NewAccount;

use crate::sync::connection::ConnectionStore;
use crate::sync::secrets::SecretStore;
use crate::sync::types::{
    DeviceView, Endpoint, PreparedAccountView, ServerCheck, SignOutResult, SyncError, SyncStatus,
};

/// What the person typed to create an account.
#[derive(Clone)]
pub struct PrepareRequest {
    /// The server.
    pub endpoint: Endpoint,
    /// The user name given by the administrator (П11).
    pub username: String,
    /// The one-time code of the administrator (П17).
    pub enroll_code: String,
    /// The new password.
    pub password: String,
    /// The name of this device (at most 64 bytes, Ф34).
    pub device_name: String,
}

/// What the person typed to sign in on a new device.
#[derive(Clone)]
pub struct SignInRequest {
    /// The server.
    pub endpoint: Endpoint,
    /// The user name.
    pub username: String,
    /// The password.
    pub password: String,
    /// The name of this device.
    pub device_name: String,
}

/// What the person typed to recover a forgotten password.
#[derive(Clone)]
pub struct RecoverRequest {
    /// The server.
    pub endpoint: Endpoint,
    /// The user name.
    pub username: String,
    /// The recovery code as typed (Ф30 accepts small letters, spaces and look-alikes).
    pub recovery_code: String,
    /// The new password.
    pub new_password: String,
    /// The name of this device.
    pub device_name: String,
}

macro_rules! redacted_debug {
    ($name:ident) => {
        impl core::fmt::Debug for $name {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.debug_struct(stringify!($name)).finish_non_exhaustive()
            }
        }
    };
}
redacted_debug!(PrepareRequest);
redacted_debug!(SignInRequest);
redacted_debug!(RecoverRequest);

/// An account that is waiting for the confirmation of its recovery code.
struct Pending {
    _account: NewAccount,
}

/// The sign-in flows with their state.
pub struct SyncService {
    _secrets: Arc<dyn SecretStore>,
    _connection: Arc<dyn ConnectionStore>,
    _pending: Mutex<Option<Pending>>,
}

impl SyncService {
    /// A service over a place for secrets and a place for the connection record.
    pub fn new(secrets: Arc<dyn SecretStore>, connection: Arc<dyn ConnectionStore>) -> Self {
        Self {
            _secrets: secrets,
            _connection: connection,
            _pending: Mutex::new(None),
        }
    }

    /// The state of the connection; reads the record and checks that the key store still holds
    /// AK and the token. Does not touch the network.
    pub fn status(&self) -> Result<SyncStatus, SyncError> {
        todo!("Р5")
    }

    /// `/v1/info` of the server (П9): the address is checked by the `https://` rule (П41) and the
    /// protocol range is compared (Р13).
    pub async fn check_server(&self, endpoint: &Endpoint) -> Result<ServerCheck, SyncError> {
        let _ = endpoint;
        todo!("П9")
    }

    /// Makes the keys of a new account and keeps them in memory (`weak_password` /
    /// `password_too_short` before any work; `already_connected` while signed in). Replaces an
    /// earlier prepared account. Nothing is sent and nothing is stored.
    pub async fn prepare_account(
        &self,
        request: PrepareRequest,
    ) -> Result<PreparedAccountView, SyncError> {
        let _ = request;
        todo!("Р5")
    }

    /// The person typed back `groups` (the groups asked by `prepare_account`, in that order).
    /// Right: the account is sent to the server, AK and the token go to the key store and the
    /// record to the connection store. Wrong: `recovery_confirmation_mismatch` and the prepared
    /// account stays. No prepared account: `no_pending_account`.
    pub async fn confirm_recovery_code(&self, groups: &[String]) -> Result<SyncStatus, SyncError> {
        let _ = groups;
        todo!("О3")
    }

    /// Forgets the prepared account.
    pub fn cancel_pending(&self) {
        todo!("О3")
    }

    /// Signs in on this device with the password (Р5).
    pub async fn sign_in(&self, request: SignInRequest) -> Result<SyncStatus, SyncError> {
        let _ = request;
        todo!("Р5")
    }

    /// Replaces a forgotten password with the recovery code and signs in (Р5, О3).
    pub async fn recover(&self, request: RecoverRequest) -> Result<SyncStatus, SyncError> {
        let _ = request;
        todo!("О3")
    }

    /// The devices of the account (П19). A revoked token (`token_revoked`) signs this device out
    /// locally and is reported as such.
    pub async fn list_devices(&self) -> Result<Vec<DeviceView>, SyncError> {
        todo!("П19")
    }

    /// Disconnects another device (П19, Р5); the current device is signed out instead.
    pub async fn disconnect_device(&self, device_id: &str) -> Result<(), SyncError> {
        let _ = device_id;
        todo!("П19")
    }

    /// Signs this device out: the server is told (best effort), AK, the token and the record are
    /// removed here in every case.
    pub async fn sign_out(&self) -> Result<SignOutResult, SyncError> {
        todo!("Р5")
    }
}
