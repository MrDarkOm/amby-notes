//! Cryptography of encrypted sync (docs/sync-plan.md, Р5 and Р6; byte format: appendix А).
//!
//! Layers, from the bottom:
//!
//! - [`primitives`]: thin wrappers of the standard primitives (Argon2id, HKDF-SHA-256,
//!   XChaCha20-Poly1305, BLAKE3), checked against the vectors of the standards;
//! - [`account`]: password and recovery code → keys, wrapping of the account key (AK) and of the
//!   space keys (VK), account creation and password reset (Р5, О3);
//! - [`header`] and [`body`]: encrypted item header and STREAM body (Р2, Р6);
//! - [`padme`] and [`recovery_code`]: size hiding and the printable recovery code.
//!
//! Randomness always comes through [`random::Random`], so the reference vectors are reproducible.

pub mod account;
pub mod body;
pub mod error;
pub mod header;
pub mod keys;
pub mod padme;
pub mod primitives;
pub mod random;
pub mod recovery_code;

pub use error::{CryptoError, RecoveryCodeError};
