//! Key and identifier types (Р5). Secrets are wiped from memory on drop (Р6, `zeroize`) and
//! never printed.

use core::fmt;

use zeroize::{Zeroize, ZeroizeOnDrop};

use super::random::Random;

macro_rules! secret_key {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
        pub struct $name([u8; 32]);

        impl $name {
            /// Wraps 32 key bytes.
            pub fn from_bytes(bytes: [u8; 32]) -> Self {
                Self(bytes)
            }

            /// The key bytes. Handle with care: copies are not wiped.
            pub fn as_bytes(&self) -> &[u8; 32] {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!(stringify!($name), "([redacted])"))
            }
        }
    };
}

secret_key! {
    /// Argon2id output of the password (Р5, Ф7). Never leaves the device.
    MasterKey
}
secret_key! {
    /// Proves knowledge of the password to the server (Р5, Ф10). The server stores only its
    /// SHA-256 (Ф5).
    AuthKey
}
secret_key! {
    /// Key-encryption key: wraps the account key (Р5, Ф10). Never leaves the device.
    Kek
}
secret_key! {
    /// Account key AK: random, wraps every space key (Р5).
    AccountKey
}

/// Space key VK with its epoch (Р5, Ф3). Header and body keys derive from it (Ф10).
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct SpaceKey {
    key: [u8; 32],
    epoch: u32,
}

impl SpaceKey {
    /// Wraps 32 key bytes together with their epoch (`epoch >= 1`, Ф3).
    pub fn from_bytes(key: [u8; 32], epoch: u32) -> Self {
        Self { key, epoch }
    }

    /// The key bytes. Handle with care: copies are not wiped.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.key
    }

    /// The epoch of this key.
    pub fn epoch(&self) -> u32 {
        self.epoch
    }
}

impl fmt::Debug for SpaceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SpaceKey(epoch {}, [redacted])", self.epoch)
    }
}

macro_rules! id16 {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name([u8; 16]);

        impl $name {
            /// Wraps 16 identifier bytes.
            pub fn from_bytes(bytes: [u8; 16]) -> Self {
                Self(bytes)
            }

            /// The identifier bytes.
            pub fn as_bytes(&self) -> &[u8; 16] {
                &self.0
            }

            /// A new random identifier: 16 bytes drawn from `rng` (Ф2, Ф31).
            pub fn random(_rng: &mut dyn Random) -> Self {
                todo!("Ф2, Ф31: 16 random bytes")
            }
        }
    };
}

id16! {
    /// Identifier of a space (a synchronised vault), Ф2.
    SpaceId
}
id16! {
    /// Identifier of an item (file or folder), Р2, Ф2.
    ItemId
}
id16! {
    /// Identifier of a body: new at every upload, part of the body key (Р6, Ф20).
    BodyId
}
