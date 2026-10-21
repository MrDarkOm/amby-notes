//! Shared by the test files of the simulation: one scenario is written once, as a function of
//! the engine builder, and run against two engines (раздел 6): the **real** one (red until the
//! engine is written) and the **correct mini-engine** (green: it shows that the scenario can be
//! satisfied). A scenario that the mini-engine cannot do (folders, names of the system, resumable
//! uploads) is run against the real engine only and is marked as such in its file.
#![allow(dead_code, unused_macros, unused_imports)]

pub use amby_sync_core::engine::{
    Approvals, CycleOutcome, CycleReport, CycleRequest, Engine, EngineBuilder, StopReason,
};
pub use amby_sync_sim::dsl::*;
pub use amby_sync_sim::fault::{NetFault, RemoteKind};
pub use amby_sync_sim::mini;
pub use amby_sync_sim::vfs::{FsEvent, Vfs};
pub use amby_sync_sim::world::*;

/// The events of a device that change something on disk (not the batch marks).
pub fn disk_changes(w: &World, d: usize) -> Vec<FsEvent> {
    w.dev(d)
        .fs
        .events()
        .into_iter()
        .filter(|e| {
            matches!(
                e,
                FsEvent::Publish { .. }
                    | FsEvent::Trash { .. }
                    | FsEvent::Rename { .. }
                    | FsEvent::CreateDir { .. }
                    | FsEvent::RemoveDir { .. }
            )
        })
        .collect()
}

/// Runs each scenario against the real engine and against the correct mini-engine.
macro_rules! both {
    ($($name:ident),* $(,)?) => {
        mod real_engine {
            use super::*;
            $( #[test] fn $name() { super::$name(Engine::boxed) } )*
        }
        mod mini_engine {
            use super::*;
            $( #[test] fn $name() { super::$name(mini::correct) } )*
        }
    };
}

/// Runs each scenario against the real engine only.
macro_rules! real_only {
    ($($name:ident),* $(,)?) => {
        mod real_engine_only {
            use super::*;
            $( #[test] fn $name() { super::$name(Engine::boxed) } )*
        }
    };
}
