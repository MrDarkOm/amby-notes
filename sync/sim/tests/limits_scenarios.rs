//! Random scenarios of the limits of appendix Е against the real engine: plans, a downgrade in
//! the middle of the run, a filled quota, faults at `account`, `blob_start`, `blob_delete` and
//! `commit`; the six invariants of Е.9 and the history ceiling are checked after every step
//! (`sim/src/limits.rs`). `AMBY_SIM_SCENARIOS` and `AMBY_SIM_SEED` choose the seeds.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::Engine;
use amby_sync_sim::limits::run_limits_scenario;
use amby_sync_sim::scenario::{first_seed, scenario_count};

#[test]
fn limits_scenarios_hold_the_invariants_of_appendix_e() {
    let first = first_seed();
    for seed in first..first + scenario_count(6) as u64 {
        if let Err(failure) = run_limits_scenario(Engine::boxed, seed) {
            panic!("{failure}");
        }
    }
}
