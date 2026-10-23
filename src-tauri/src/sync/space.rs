//! The space of a vault on the server (docs/sync-plan.md, Р5, Р11, Ф34): made at the first
//! switching on or taken from the spaces the account already has. The name is sealed with AK
//! (Ф34) and the key of the space is wrapped with AK (Ф12), so the server learns neither.

use std::path::Path;

use amby_sync_client::{DeviceToken, SyncClient};
use amby_sync_core::crypto::keys::{AccountKey, SpaceKey};

use crate::sync::types::SyncError;
use crate::sync::vault_types::SpaceView;

/// A space this device can read and write.
pub struct LinkedSpace {
    /// The identifier.
    pub space_id: [u8; 16],
    /// The name, if it could be read.
    pub name: Option<String>,
    /// The key of the space.
    pub vk: SpaceKey,
}

/// The name offered for a vault: the name of its folder (Ф34, at most 64 bytes, cut at a
/// character); `Vault` when the folder has no usable name.
pub fn default_space_name(_vault: &Path) -> String {
    todo!("Э4: default_space_name")
}

/// A name typed by the person, made fit for Ф34: trimmed, no control characters, at most 64
/// bytes cut at a character; empty stays empty.
pub fn clean_space_name(_raw: &str) -> String {
    todo!("Э4: clean_space_name")
}

/// Makes a new space named `name` (empty: `Vault`) with a new key and a new identifier (Р5, П20).
pub async fn create_space(
    _client: &SyncClient,
    _token: &DeviceToken,
    _account_key: &AccountKey,
    _name: &str,
) -> Result<LinkedSpace, SyncError> {
    todo!("Э4: create_space")
}

/// Opens a space of the account by its identifier: unwraps its key and reads its name. A space
/// the account does not have is `space_not_found`; a key that does not open is `cannot_decrypt`.
pub async fn open_space(
    _client: &SyncClient,
    _token: &DeviceToken,
    _account_key: &AccountKey,
    _space_id: [u8; 16],
) -> Result<LinkedSpace, SyncError> {
    todo!("Э4: open_space")
}

/// The spaces of the account, newest first, with the names that could be read.
pub async fn list_spaces(
    _client: &SyncClient,
    _token: &DeviceToken,
    _account_key: &AccountKey,
) -> Result<Vec<SpaceView>, SyncError> {
    todo!("Э4: list_spaces")
}
