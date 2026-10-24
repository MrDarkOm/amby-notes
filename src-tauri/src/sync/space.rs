//! The space of a vault on the server (docs/sync-plan.md, Р5, Р11, Ф34): made at the first
//! switching on or taken from the spaces the account already has. The name is sealed with AK
//! (Ф34) and the key of the space is wrapped with AK (Ф12), so the server learns neither.

use std::path::Path;

use amby_sync_client::{ClientError, DeviceToken, NewSpace, SpaceEntry, SyncClient};
use amby_sync_core::crypto::account::{generate_space_key, unwrap_space_key, wrap_space_key};
use amby_sync_core::crypto::keys::{AccountKey, SpaceId, SpaceKey};
use amby_sync_core::crypto::name::{open_space_name, seal_space_name};
use amby_sync_core::crypto::random::{OsRandom, Random};

use crate::sync::account_types::{AccountOverview, BoundVault};
use crate::sync::types::SyncError;
use crate::sync::vault_types::SpaceView;

/// The longest name of a space in bytes (Ф34).
const NAME_MAX_BYTES: usize = 64;
/// The name when the person gave none and the folder has none.
const FALLBACK_NAME: &str = "Vault";

/// A space this device can read and write.
pub struct LinkedSpace {
    /// The identifier.
    pub space_id: [u8; 16],
    /// The name, if it could be read.
    pub name: Option<String>,
    /// The key of the space.
    pub vk: SpaceKey,
    /// The key as the server keeps it, wrapped by AK (Ф12): kept in the state of the vault so
    /// that a vault starts without the network. It is no more secret than on the server.
    pub wrapped_vk: Vec<u8>,
    /// The epoch of the key.
    pub key_epoch: u32,
}

/// Opens a wrapped key of a space that was kept earlier (no network). A key that does not open
/// is `cannot_decrypt`.
pub fn unwrap_kept_key(
    account_key: &AccountKey,
    space_id: [u8; 16],
    key_epoch: u32,
    wrapped_vk: &[u8],
) -> Result<SpaceKey, SyncError> {
    unwrap_space_key(
        account_key,
        &SpaceId::from_bytes(space_id),
        key_epoch,
        wrapped_vk,
    )
    .map_err(|_| SyncError::new("cannot_decrypt"))
}

/// A name typed by the person, made fit for Ф34: trimmed, no control characters, at most 64
/// bytes cut at a character; empty stays empty.
pub fn clean_space_name(raw: &str) -> String {
    let mut name = String::new();
    for c in raw.trim().chars().filter(|c| !c.is_control()) {
        if name.len() + c.len_utf8() > NAME_MAX_BYTES {
            break;
        }
        name.push(c);
    }
    name.trim().to_string()
}

/// The name offered for a vault: the name of its folder (Ф34, at most 64 bytes, cut at a
/// character); `Vault` when the folder has no usable name.
pub fn default_space_name(vault: &Path) -> String {
    let name = vault
        .file_name()
        .map(|name| clean_space_name(&name.to_string_lossy()))
        .unwrap_or_default();
    if name.is_empty() {
        FALLBACK_NAME.to_string()
    } else {
        name
    }
}

fn client_error(error: ClientError) -> SyncError {
    SyncError::from(error)
}

/// Makes a new space named `name` (empty: `Vault`) with a new key and a new identifier (Р5, П20).
pub async fn create_space(
    client: &SyncClient,
    token: &DeviceToken,
    account_key: &AccountKey,
    name: &str,
) -> Result<LinkedSpace, SyncError> {
    let name = match clean_space_name(name).as_str() {
        "" => FALLBACK_NAME.to_string(),
        cleaned => cleaned.to_string(),
    };
    let mut random = OsRandom;
    let mut id = [0u8; 16];
    random.fill(&mut id);
    let space = SpaceId::from_bytes(id);
    let vk = generate_space_key(1, &mut random).map_err(|_| SyncError::new("crypto"))?;
    let wrapped = wrap_space_key(account_key, &space, &vk, &mut random);
    let sealed = seal_space_name(account_key, &space, &name, &mut random)
        .map_err(|_| SyncError::new("invalid_space"))?;
    client
        .create_space(
            token,
            &NewSpace {
                space_id: id,
                name_enc: &sealed,
                key_epoch: vk.epoch(),
                wrapped_vk: &wrapped,
            },
        )
        .await
        .map_err(client_error)?;
    Ok(LinkedSpace {
        space_id: id,
        name: Some(name),
        key_epoch: vk.epoch(),
        wrapped_vk: wrapped,
        vk,
    })
}

fn name_of(account_key: &AccountKey, entry: &SpaceEntry) -> Option<String> {
    open_space_name(
        account_key,
        &SpaceId::from_bytes(entry.space_id),
        &entry.name_enc,
    )
    .ok()
}

/// Opens a space of the account by its identifier: unwraps its key and reads its name. A space
/// the account does not have is `space_not_found`; a key that does not open is `cannot_decrypt`.
pub async fn open_space(
    client: &SyncClient,
    token: &DeviceToken,
    account_key: &AccountKey,
    space_id: [u8; 16],
) -> Result<LinkedSpace, SyncError> {
    let spaces = client.list_spaces(token).await.map_err(client_error)?;
    let entry = spaces
        .iter()
        .find(|entry| entry.space_id == space_id)
        .ok_or_else(|| SyncError::new("space_not_found"))?;
    let vk = unwrap_space_key(
        account_key,
        &SpaceId::from_bytes(entry.space_id),
        entry.key_epoch,
        &entry.wrapped_vk,
    )
    .map_err(|_| SyncError::new("cannot_decrypt"))?;
    Ok(LinkedSpace {
        space_id,
        name: name_of(account_key, entry),
        key_epoch: entry.key_epoch,
        wrapped_vk: entry.wrapped_vk.clone(),
        vk,
    })
}

/// The spaces of the account, newest first, with the names that could be read.
pub async fn list_spaces(
    client: &SyncClient,
    token: &DeviceToken,
    account_key: &AccountKey,
) -> Result<Vec<SpaceView>, SyncError> {
    let mut spaces = client.list_spaces(token).await.map_err(client_error)?;
    // The server lists in the order of creation; newest first, and where the clock of the server
    // gave the same millisecond, the later one still comes first.
    spaces.reverse();
    spaces.sort_by_key(|entry| std::cmp::Reverse(entry.created_ms));
    Ok(spaces
        .iter()
        .map(|entry| SpaceView {
            space_id: hex::encode(entry.space_id),
            name: name_of(account_key, entry),
            seq: entry.seq,
            created_ms: entry.created_ms,
        })
        .collect())
}

/// The storages of the account with their plan, limits and sizes (appendix Е, У5): asks the
/// server for `GET /v1/account`, opens every name with the key of the account (a name that does
/// not open is `None` and does not spoil the list), marks the space of the open vault
/// (`current`) and the spaces `bound` vaults of this computer are linked to. A server that does
/// not know the request (`404`) gives an overview with `limits_known: false`: no plan, no
/// limits, the spaces from the listing.
///
/// STUB of the red-tests step of appendix Е: `not_implemented`.
pub async fn account_overview(
    client: &SyncClient,
    token: &DeviceToken,
    account_key: &AccountKey,
    current: Option<[u8; 16]>,
    bound: &[BoundVault],
) -> Result<AccountOverview, SyncError> {
    let _ = (client, token, account_key, current, bound);
    unimplemented!("not_implemented: sync_account_overview")
}
