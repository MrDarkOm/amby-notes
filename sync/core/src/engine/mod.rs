//! The sync engine (docs/sync-plan.md, Э3; rules: appendix В «Движок v1», decisions Д1–Д69).
//!
//! The engine decides what to download, upload, overwrite, copy and delete. It sees the world
//! only through the ports of [`ports`]: the local file system ([`ports::LocalFs`]), the server
//! ([`ports::Remote`], protocol of appendix Б), the state of the device ([`ports::StateStore`]),
//! the clock and randomness (Р12, Д2). There is no Tauri, SQLite or network in this crate: the
//! real ports live in the application (Э4), the test ports in `sync/sim`.
//!
//! Stage Э3, step 1 (plan, раздел 6): this module holds **interfaces only**. The bodies are
//! `todo!()`; the tests of `sync/sim` and of `sync/core/tests` are written against them first.
//!
//! - [`ports`]: the traits the engine reaches the world through;
//! - [`model`]: the state kept on the device and the report of a pass;
//! - [`names`]: names that cannot exist on this system, conflict copy names (Р7, Р9);
//! - [`consistency`]: meaning of the header fields (Ф14 checks only their shape);
//! - [`stream`]: opening a body as a stream (Ф24);
//! - [`rules`]: what is not synchronised (Р4) and the mass-change threshold (Р8);
//! - [`sync`]: the engine itself.

pub mod consistency;
pub mod model;
pub mod names;
pub mod ports;
pub mod rules;
pub mod stream;
pub mod sync;

pub use model::{
    Approvals, ConflictKind, ConflictRecord, CycleOutcome, CycleReport, CycleRequest, Direction,
    EngineError, ItemError, ItemErrorKind, ItemRecord, PendingCommit, PendingUpload, PlannedChange,
    PlannedKind, ReadOnlyItem, RenameHint, StateOp, StateTx, StopReason, SyncState, UnsyncedReason,
    UnsyncedRecord,
};
pub use ports::{
    BlobState, ChangeEntry, ChangesPage, Clock, CommitAccepted, CommitItem, CommitReply, FsError,
    Listing, LocalEntry, LocalFs, LocalKind, NameRules, Remote, RemoteError, RootState, ServerInfo,
    SnapshotReason, StagedWrite, StateError, StateLock, StateStore, TrashReason, VersionConflict,
};
pub use sync::{Engine, EngineBuilder, EngineConfig, Ports, SyncEngine};
