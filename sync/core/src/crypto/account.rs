//! Password, recovery code and the key hierarchy on the client (Р5, О3, О8).
//!
//! ```text
//! password ─Argon2id─▶ master key ─HKDF─┬─▶ auth_key   (to the server)
//!                                       └─▶ KEK        (stays on the device)
//! recovery code ─HKDF─┬─▶ recovery_auth_key
//!                     └─▶ recovery_KEK
//! KEK / recovery_KEK ─wrap─▶ AK         AK ─wrap─▶ VK (per space, with an epoch)
//! ```

use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use super::error::CryptoError;
use super::keys::{AccountKey, AuthKey, Kek, MasterKey, SpaceId, SpaceKey};
use super::primitives::{
    argon2id_raw, derive_key, sha256, xchacha20poly1305_open, xchacha20poly1305_seal, Argon2Input,
    XNONCE_LEN,
};
use super::random::Random;
use super::recovery_code::RecoveryCode;

/// Version byte of a wrapped key (Ф4).
const WRAP_VERSION: u8 = 1;
/// Length of a wrapped key: version, nonce, 32 bytes of ciphertext, tag (Ф13).
const WRAPPED_LEN: usize = 1 + XNONCE_LEN + 32 + 16;

const INFO_AUTH: &[u8] = b"amby-sync/auth/1";
const INFO_KEK: &[u8] = b"amby-sync/kek/1";
const INFO_RECOVERY_AUTH: &[u8] = b"amby-sync/recovery-auth/1";
const INFO_RECOVERY_KEK: &[u8] = b"amby-sync/recovery-kek/1";
const AAD_WRAP_AK: &[u8] = b"amby-sync/wrap-ak/1";
const AAD_WRAP_VK: &[u8] = b"amby-sync/wrap-vk/1";

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
        if !(65_536..=1_048_576).contains(&self.memory_kib) {
            return Err(CryptoError::InvalidParams(
                "Argon2id memory is outside 65536-1048576 KiB",
            ));
        }
        if !(3..=12).contains(&self.iterations) {
            return Err(CryptoError::InvalidParams(
                "Argon2id passes are outside 3-12",
            ));
        }
        if !(1..=16).contains(&self.parallelism) {
            return Err(CryptoError::InvalidParams(
                "Argon2id parallelism is outside 1-16",
            ));
        }
        Ok(())
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
    password: &str,
    salt: &[u8; SALT_LEN],
    params: &Argon2Params,
) -> Result<PasswordKeys, CryptoError> {
    params.validate()?;
    let normalised = Zeroizing::new(password.nfkc().collect::<String>());
    let input = Argon2Input {
        password: normalised.as_bytes(),
        salt,
        secret: &[],
        associated_data: &[],
    };
    let output = Zeroizing::new(argon2id_raw(&input, params, 32)?);
    let mut master = [0u8; 32];
    master.copy_from_slice(&output);
    let master = MasterKey::from_bytes(master);
    Ok(PasswordKeys {
        auth_key: AuthKey::from_bytes(*derive_key(master.as_bytes(), INFO_AUTH)),
        kek: Kek::from_bytes(*derive_key(master.as_bytes(), INFO_KEK)),
    })
}

/// Recovery code → `recovery_auth_key` and `recovery_KEK` (Р5, Ф10, Ф30).
pub fn derive_recovery_keys(code: &RecoveryCode) -> RecoveryKeys {
    RecoveryKeys {
        auth_key: AuthKey::from_bytes(*derive_key(code.as_bytes(), INFO_RECOVERY_AUTH)),
        kek: Kek::from_bytes(*derive_key(code.as_bytes(), INFO_RECOVERY_KEK)),
    }
}

/// SHA-256 of an auth key: what the server stores (Р5, Ф5).
pub fn server_auth_hash(auth_key: &AuthKey) -> [u8; 32] {
    sha256(auth_key.as_bytes())
}

/// `0x01 ‖ nonce ‖ ciphertext ‖ tag` of a 32-byte secret under `key` with `aad` (Ф13).
fn wrap_secret(key: &[u8; 32], aad: &[u8], secret: &[u8; 32], rng: &mut dyn Random) -> Vec<u8> {
    let mut nonce = [0u8; XNONCE_LEN];
    rng.fill(&mut nonce);
    let sealed = xchacha20poly1305_seal(key, &nonce, aad, secret);
    let mut wrapped = Vec::with_capacity(WRAPPED_LEN);
    wrapped.push(WRAP_VERSION);
    wrapped.extend_from_slice(&nonce);
    wrapped.extend_from_slice(&sealed);
    wrapped
}

/// The reverse of [`wrap_secret`]. The version byte is told apart from an authentication
/// failure (Ф4); a wrong length is `Malformed`.
fn unwrap_secret(
    key: &[u8; 32],
    aad: &[u8],
    wrapped: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    match wrapped.first() {
        None => return Err(CryptoError::Malformed("wrapped key is empty")),
        Some(&WRAP_VERSION) => {}
        Some(&other) => return Err(CryptoError::UnsupportedVersion(other)),
    }
    if wrapped.len() != WRAPPED_LEN {
        return Err(CryptoError::Malformed("wrapped key has the wrong length"));
    }
    let mut nonce = [0u8; XNONCE_LEN];
    nonce.copy_from_slice(&wrapped[1..=XNONCE_LEN]);
    let plain = Zeroizing::new(xchacha20poly1305_open(
        key,
        &nonce,
        aad,
        &wrapped[1 + XNONCE_LEN..],
    )?);
    let mut secret = Zeroizing::new([0u8; 32]);
    if plain.len() != secret.len() {
        return Err(CryptoError::Authentication);
    }
    secret.copy_from_slice(&plain);
    Ok(secret)
}

/// Wraps AK with a KEK: `0x01 ‖ nonce ‖ ciphertext ‖ tag` (Р5, Ф11, Ф13). Draws a nonce (Ф31).
pub fn wrap_account_key(kek: &Kek, ak: &AccountKey, rng: &mut dyn Random) -> Vec<u8> {
    wrap_secret(kek.as_bytes(), AAD_WRAP_AK, ak.as_bytes(), rng)
}

/// Unwraps AK. A wrong KEK (wrong password or code) or any change of the data is
/// [`CryptoError::Authentication`]; the wrong version byte is `UnsupportedVersion`. О3, С12.
pub fn unwrap_account_key(kek: &Kek, wrapped: &[u8]) -> Result<AccountKey, CryptoError> {
    unwrap_secret(kek.as_bytes(), AAD_WRAP_AK, wrapped).map(|secret| AccountKey::from_bytes(*secret))
}

/// A new space key with `epoch` (Р5, Ф3): 32 random bytes (Ф31). Epoch 0 is `InvalidParams`.
pub fn generate_space_key(epoch: u32, rng: &mut dyn Random) -> Result<SpaceKey, CryptoError> {
    if epoch == 0 {
        return Err(CryptoError::InvalidParams("key epoch starts at 1"));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    rng.fill(&mut *key);
    Ok(SpaceKey::from_bytes(*key, epoch))
}

/// The AAD of a wrapped VK: label, space and epoch (Ф12).
fn space_key_aad(space: &SpaceId, epoch: u32) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_WRAP_VK.len() + 16 + 4);
    aad.extend_from_slice(AAD_WRAP_VK);
    aad.extend_from_slice(space.as_bytes());
    aad.extend_from_slice(&epoch.to_be_bytes());
    aad
}

/// Wraps VK with AK, bound to the space and the epoch (Р5, Ф12, Ф13). Draws a nonce (Ф31).
pub fn wrap_space_key(
    ak: &AccountKey,
    space: &SpaceId,
    vk: &SpaceKey,
    rng: &mut dyn Random,
) -> Vec<u8> {
    wrap_secret(
        ak.as_bytes(),
        &space_key_aad(space, vk.epoch()),
        vk.as_bytes(),
        rng,
    )
}

/// Unwraps VK of `space` and `epoch`. A VK wrapped for another space or epoch, or any change of
/// the data, is [`CryptoError::Authentication`]. Р5, Р6, Ф12.
pub fn unwrap_space_key(
    ak: &AccountKey,
    space: &SpaceId,
    epoch: u32,
    wrapped: &[u8],
) -> Result<SpaceKey, CryptoError> {
    unwrap_secret(ak.as_bytes(), &space_key_aad(space, epoch), wrapped)
        .map(|secret| SpaceKey::from_bytes(*secret, epoch))
}

/// A password for an existing AK: new salt, keys, wrapped AK (Р5, «Забытый пароль»). Draws a
/// salt and a nonce (Ф31).
pub fn seal_account_key_for_password(
    password: &str,
    ak: &AccountKey,
    params: &Argon2Params,
    rng: &mut dyn Random,
) -> Result<PasswordEnvelope, CryptoError> {
    // Refuse before a single random byte is drawn (Ф31).
    params.validate()?;
    let mut salt = [0u8; SALT_LEN];
    rng.fill(&mut salt);
    let keys = derive_password_keys(password, &salt, params)?;
    let wrapped_account_key = wrap_account_key(&keys.kek, ak, rng);
    Ok(PasswordEnvelope {
        salt,
        params: *params,
        auth_key: keys.auth_key,
        wrapped_account_key,
    })
}

/// Creates an account on the first device (Р5, О3): salt, AK, password envelope, recovery code
/// and the AK wrapped by the recovery KEK. Random draws in the order of Ф31.
pub fn create_account(
    password: &str,
    params: &Argon2Params,
    rng: &mut dyn Random,
) -> Result<NewAccount, CryptoError> {
    params.validate()?;
    // Ф31: salt, AK, nonce of the password wrap, recovery code, nonce of the recovery wrap.
    let mut salt = [0u8; SALT_LEN];
    rng.fill(&mut salt);
    let mut ak_bytes = Zeroizing::new([0u8; 32]);
    rng.fill(&mut *ak_bytes);
    let account_key = AccountKey::from_bytes(*ak_bytes);
    let keys = derive_password_keys(password, &salt, params)?;
    let wrapped_account_key = wrap_account_key(&keys.kek, &account_key, rng);
    let recovery_code = RecoveryCode::generate(rng);
    let recovery = derive_recovery_keys(&recovery_code);
    let wrapped_account_key_recovery = wrap_account_key(&recovery.kek, &account_key, rng);
    Ok(NewAccount {
        password: PasswordEnvelope {
            salt,
            params: *params,
            auth_key: keys.auth_key,
            wrapped_account_key,
        },
        account_key,
        recovery_code,
        recovery_auth_key: recovery.auth_key,
        wrapped_account_key_recovery,
    })
}

/// Forgotten password (Р5, О3): the recovery code unwraps AK, then AK is sealed under the new
/// password. AK stays the same, so the data on the server remains readable. Returns AK and the
/// new envelope. A wrong code is `Authentication`.
pub fn reset_password(
    code: &RecoveryCode,
    wrapped_by_recovery: &[u8],
    new_password: &str,
    params: &Argon2Params,
    rng: &mut dyn Random,
) -> Result<(AccountKey, PasswordEnvelope), CryptoError> {
    params.validate()?;
    let recovery = derive_recovery_keys(code);
    let ak = unwrap_account_key(&recovery.kek, wrapped_by_recovery)?;
    let envelope = seal_account_key_for_password(new_password, &ak, params, rng)?;
    Ok((ak, envelope))
}

/// Password change on a connected device (Р5): needs the old password. A wrong old password is
/// `Authentication`. AK stays the same.
pub fn change_password(
    old_password: &str,
    old_salt: &[u8; SALT_LEN],
    old_params: &Argon2Params,
    wrapped_account_key: &[u8],
    new_password: &str,
    new_params: &Argon2Params,
    rng: &mut dyn Random,
) -> Result<(AccountKey, PasswordEnvelope), CryptoError> {
    new_params.validate()?;
    let old = derive_password_keys(old_password, old_salt, old_params)?;
    let ak = unwrap_account_key(&old.kek, wrapped_account_key)?;
    let envelope = seal_account_key_for_password(new_password, &ak, new_params, rng)?;
    Ok((ak, envelope))
}
