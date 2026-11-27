//! Regression seeds from the long simulation gate.
#![allow(clippy::expect_used)]

use amby_sync_core::engine::Engine;
use amby_sync_sim::scenario::{run_scenario, Options};

const SEED: u64 = 23_390;

#[test]
fn seed_23390_passes_quick_mode() {
    run_scenario(Engine::boxed, SEED, Options::QUICK).unwrap_or_else(|failure| panic!("{failure}"));
}

#[test]
fn seed_23390_passes_folders_mode() {
    let options = Options {
        folders: true,
        ..Options::QUICK
    };
    run_scenario(Engine::boxed, SEED, options).unwrap_or_else(|failure| panic!("{failure}"));
}
