//! Amby sync core (docs/sync-plan.md, Р12): cryptography and, later, the sync engine.
//! No dependency on Tauri; files, network, time and randomness are reached through interfaces.
//!
//! Stage Э3 (interfaces only so far): [`engine`] is the sync engine of appendix В; its bodies are
//! `todo!()` until the tests of `sync/sim` are reviewed (plan, раздел 6).
//!
//! Stage Э1: [`crypto`] is implemented against the tests that were reviewed first (plan, раздел 6).
//! The byte format is appendix А of the plan.

pub mod crypto;
pub mod engine;
