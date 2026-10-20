//! Password, recovery code and the key hierarchy on the client (Р5, О3, О8).
//!
//! ```text
//! password ─Argon2id─▶ master key ─HKDF─┬─▶ auth_key   (to the server)
//!                                       └─▶ KEK        (stays on the device)
//! recovery code ─HKDF─┬─▶ recovery_auth_key
//!                     └─▶ recovery_KEK
//! KEK / recovery_KEK ─wrap─▶ AK         AK ─wrap─▶ VK (per space, with an epoch)
//! ```

use super::error::CryptoError;
use super::keys::{AccountKey, AuthKey, Kek, SpaceId, SpaceKey};
use super::random::Random;
use super::recovery_code::RecoveryCode;

/// Length of the Argon2id salt (Ф7).
pub const SALT_LEN: usize = 16;

/// Argon2id parameters, stored on the server next to the salt (Р5, Ф7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Params {
    /// Memory in KiB.
    pub memory_kib: u32,
    /// Number of passes.
    pub iterations: u32,
    /// Degree of parallelism.
    pub parallelism: u32,
}

impl Argon2Params {
    /// The format v1 defaults: 64 MiB, `t = 3`, `p = 4` (Р5, Ф7).
    pub const V1_DEFAULT: Self = Self {
        memory_kib: 65_536,
        iterations: 3,
        parallelism: 4,
    };

    /// Checks parameters received from the server (Ф8): memory 65 536–1 048 576 KiB, passes
    /// 3–12, parallelism 1–16. A weaker value would make guessing the password cheaper, a
    /// larger one would hang the client. О8, Р5.
    pub fn validate(&self) -> Result<(), CryptoError> {
        todo!("О8, Ф8: parameter limits")
    }
}

/// The keys derived from a password (Р5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordKeys {
    /// Goes to the server for login.
    pub auth_key: AuthKey,
    /// Unwraps the account key; never leaves the device.
    pub kek: Kek,
}

/// The keys derived from a recovery code (Р5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryKeys {
    /// Goes to the server for login by recovery code.
    pub auth_key: AuthKey,
    /// Unwraps the account key; never leaves the device.
    pub kek: Kek,
}

/// What the server keeps for a password (Р5): salt, parameters, the hash of `auth_key` is made
/// by the server from [`PasswordEnvelope::auth_key`], and the account key wrapped by the KEK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordEnvelope {
    /// Argon2id salt (Ф7).
    pub salt: [u8; SALT_LEN],
    /// Argon2id parameters used with this salt.
    pub params: Argon2Params,
    /// The auth key derived from the password.
    pub auth_key: AuthKey,
    /// AK wrapped by the KEK (Ф11, Ф13).
    pub wrapped_account_key: Vec<u8>,
}

/// A newly created account (Р5, «Первое устройство»).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAccount {
    /// The part tied to the password.
    pub password: PasswordEnvelope,
    /// The account key itself; the device keeps it in the system key store.
    pub account_key: AccountKey,
    /// The recovery code to show to the user (О3).
    pub recovery_code: RecoveryCode,
    /// The auth key derived from the recovery code.
    pub recovery_auth_key: AuthKey,
    /// AK wrapped by the recovery KEK (Ф11, Ф13).
    pub wrapped_account_key_recovery: Vec<u8>,
}

/// Password → master key → `auth_key` and `KEK` (Р5, Ф6–Ф10).
///
/// The password is normalised to NFKC (Ф6). `params` are checked with
/// [`Argon2Params::validate`] before any work is done (О8, Ф8).
pub fn derive_password_keys(
    _password: &str,
    _salt: &[u8; SALT_LEN],
    _params: &Argon2Params,
) -> Result<PasswordKeys, CryptoError> {
    todo!("Р5, О8, Ф6–Ф10: password to keys")
}

/// Recovery code → `recovery_auth_key` and `recovery_KEK` (Р5, Ф10, Ф30).
pub fn derive_recovery_keys(_code: &RecoveryCode) -> RecoveryKeys {
    todo!("Р5, Ф10, Ф30: recovery code to keys")
}

/// SHA-256 of an auth key: what the server stores (Р5, Ф5).
pub fn server_auth_hash(_auth_key: &AuthKey) -> [u8; 32] {
    todo!("Р5, Ф5: SHA-256 of the auth key")
}

/// Wraps AK with a KEK: `0x01 ‖ nonce ‖ ciphertext ‖ tag` (Р5, Ф11, Ф13). Draws a nonce (Ф31).
pub fn wrap_account_key(_kek: &Kek, _ak: &AccountKey, _rng: &mut dyn Random) -> Vec<u8> {
    todo!("Р5, Ф11, Ф13: wrap AK")
}

/// Unwraps AK. A wrong KEK (wrong password or code) or any change of the data is
/// [`CryptoError::Authentication`]; the wrong version byte is `UnsupportedVersion`. О3, С12.
pub fn unwrap_account_key(_kek: &Kek, _wrapped: &[u8]) -> Result<AccountKey, CryptoError> {
    todo!("Р5, О3, С12: unwrap AK")
}

/// A new space key with `epoch` (Р5, Ф3): 32 random bytes (Ф31). Epoch 0 is `InvalidParams`.
pub fn generate_space_key(_epoch: u32, _rng: &mut dyn Random) -> Result<SpaceKey, CryptoError> {
    todo!("Р5, Ф3: new VK")
}

/// Wraps VK with AK, bound to the space and the epoch (Р5, Ф12, Ф13). Draws a nonce (Ф31).
pub fn wrap_space_key(
    _ak: &AccountKey,
    _space: &SpaceId,
    _vk: &SpaceKey,
    _rng: &mut dyn Random,
) -> Vec<u8> {
    todo!("Р5, Ф12, Ф13: wrap VK")
}

/// Unwraps VK of `space` and `epoch`. A VK wrapped for another space or epoch, or any change of
/// the data, is [`CryptoError::Authentication`]. Р5, Р6, Ф12.
pub fn unwrap_space_key(
    _ak: &AccountKey,
    _space: &SpaceId,
    _epoch: u32,
    _wrapped: &[u8],
) -> Result<SpaceKey, CryptoError> {
    todo!("Р5, Р6, Ф12: unwrap VK")
}

/// A password for an existing AK: new salt, keys, wrapped AK (Р5, «Забытый пароль»). Draws a
/// salt and a nonce (Ф31).
pub fn seal_account_key_for_password(
    _password: &str,
    _ak: &AccountKey,
    _params: &Argon2Params,
    _rng: &mut dyn Random,
) -> Result<PasswordEnvelope, CryptoError> {
    todo!("Р5, О8, Ф31: password envelope for AK")
}

/// Creates an account on the first device (Р5, О3): salt, AK, password envelope, recovery code
/// and the AK wrapped by the recovery KEK. Random draws in the order of Ф31.
pub fn create_account(
    _password: &str,
    _params: &Argon2Params,
    _rng: &mut dyn Random,
) -> Result<NewAccount, CryptoError> {
    todo!("Р5, О3, Ф31: create an account")
}

/// Forgotten password (Р5, О3): the recovery code unwraps AK, then AK is sealed under the new
/// password. AK stays the same, so the data on the server remains readable. Returns AK and the
/// new envelope. A wrong code is `Authentication`.
pub fn reset_password(
    _code: &RecoveryCode,
    _wrapped_by_recovery: &[u8],
    _new_password: &str,
    _params: &Argon2Params,
    _rng: &mut dyn Random,
) -> Result<(AccountKey, PasswordEnvelope), CryptoError> {
    todo!("Р5, О3: reset password with the recovery code")
}

/// Password change on a connected device (Р5): needs the old password. A wrong old password is
/// `Authentication`. AK stays the same.
pub fn change_password(
    _old_password: &str,
    _old_salt: &[u8; SALT_LEN],
    _old_params: &Argon2Params,
    _wrapped_account_key: &[u8],
    _new_password: &str,
    _new_params: &Argon2Params,
    _rng: &mut dyn Random,
) -> Result<(AccountKey, PasswordEnvelope), CryptoError> {
    todo!("Р5: change password")
}
