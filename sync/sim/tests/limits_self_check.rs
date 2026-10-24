//! The scenarios of limits check themselves (strength of the tests, раздел 6): the real engine
//! passes, and every deliberately broken engine of `broken_limits` is caught by the invariant it
//! breaks. Written after the code, as an addition: the frozen tests are not touched.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::Engine;
use amby_sync_sim::broken_limits::{builder_of, ALL_LIMIT_FLAWS};
use amby_sync_sim::limits::run_limits_scenario_with;
use amby_sync_sim::scenario::{first_seed, scenario_count};

#[test]
fn the_real_engine_passes_the_scenarios_with_races_in_the_middle_of_a_pass() {
    for seed in first_seed()..first_seed() + scenario_count(8) as u64 {
        if let Err(failure) = run_limits_scenario_with(Engine::boxed, seed, false) {
            panic!("{failure}");
        }
    }
}

#[test]
fn every_broken_engine_of_limits_is_caught_by_its_invariant() {
    let limit = scenario_count(120) as u64;
    for (flaw, expected) in ALL_LIMIT_FLAWS {
        let server_flaw = flaw == amby_sync_sim::broken_limits::LimitFlaw::PrunesLatestVersion;
        let found = (first_seed()..first_seed() + limit)
            .find_map(|seed| run_limits_scenario_with(builder_of(flaw), seed, server_flaw).err());
        let Some(failure) = found else {
            panic!("{flaw:?} was not caught in {limit} scenarios");
        };
        assert_eq!(
            failure.violation.kind, expected,
            "{flaw:?} was caught, but by another invariant:\n{failure}"
        );
        eprintln!("{flaw:?}: caught at seed {} by {expected:?}", failure.seed);
    }
}
