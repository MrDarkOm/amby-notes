//! The link between the application and encrypted sync (docs/sync-plan.md, Р5, Р12; stage Э4,
//! the connect screen). Notes are not synchronised yet: this module only signs the device in.
//!
//! - [`types`]: what crosses the IPC border (Specta types, `SyncError` with a machine code);
//! - [`password`]: the length and the strength rule of the password (Р5, `zxcvbn`);
//! - [`secrets`]: AK and the device token live only in the system key store
//!   (`com.ambynotes.sync`, like [`crate::credentials`]);
//! - [`connection`]: the server address and the user name in the app data (not a secret);
//! - [`service`]: the flows — check a server, create an account (the recovery code is confirmed
//!   before anything is sent), sign in, recover, devices, sign out.
//!
//! Neither the password nor a key nor a token nor the recovery code is written to the settings,
//! to the vault or to a log (О1, Р5).

pub mod connection;
pub mod password;
pub mod secrets;
pub mod service;
pub mod types;

#[cfg(test)]
mod connection_tests;
#[cfg(test)]
mod password_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod test_support;
