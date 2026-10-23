//! Deterministic simulation of the sync engine (docs/sync-plan.md, раздел 7, Э3).
//!
//! Several virtual devices, each with a file system in memory that keeps a history and a trash;
//! **the real server of stage Э2** in this process; faults in the wrappers of the ports (the
//! request does not arrive, the answer is lost, the process dies at the N-th call); random
//! scenarios from a seed. After every scenario the invariants of раздел 7 are checked, see
//! [`invariants`].
//!
//! The same scenarios run against three kinds of engine, through the same [`SyncEngine`] trait
//! (раздел 6): the real one (`Engine`, red until stage Э3 is implemented), the correct
//! [`mini`] engine (shows that the scenarios can be satisfied) and the broken mini-engines (each
//! has one error, and the simulation must catch each with its own invariant).
//!
//! [`SyncEngine`]: amby_sync_core::engine::SyncEngine
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::large_enum_variant,
    clippy::needless_range_loop,
    clippy::unnecessary_map_or
)]

pub mod conflicts;
pub mod dsl;
pub mod fault;
pub mod invariants;
pub mod linemerge;
pub mod mini;
pub mod net;
pub mod scenario;
pub mod state;
pub mod vfs;
pub mod world;

/// Every content of the simulation starts with this marker, and every name contains it, so that
/// the check "the server is blind" can look for it (О1, раздел 7).
pub const MARKER: &[u8] = b"AMBYSIM";
