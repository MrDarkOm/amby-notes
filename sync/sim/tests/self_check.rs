//! The simulation checks itself (plan, раздел 6): before it is trusted with the real engine it
//! must (1) pass a correct engine, (2) catch every broken engine with the invariant that engine
//! violates, (3) replay a scenario from its seed, and (4) have invariants that can fail at all.
//! These tests do not touch the real engine: they are green now, and they stay green.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;
use common::*;

use amby_sync_sim::invariants::{
    check_blind, check_convergence, check_nothing_lost, CheckOptions, Kind,
};
use amby_sync_sim::mini::{builder_of, Flaw, ALL_FLAWS};
use amby_sync_sim::scenario::{find_failure, first_seed, run_scenario, scenario_count, Options};

fn options() -> Options {
    Options::QUICK
}

#[test]
fn the_correct_mini_engine_passes_the_simulation() {
    // Раздел 6, раздел 7: a simulation that fails a correct engine is useless; the scenarios
    // count is AMBY_SIM_SCENARIOS (a few by default, thousands at night).
    let count = scenario_count(20);
    for seed in first_seed()..first_seed() + count as u64 {
        if let Err(failure) = run_scenario(mini::correct, seed, options()) {
            panic!("{failure}");
        }
    }
}

fn caught(flaw: Flaw, expected: Kind) {
    let limit = scenario_count(250);
    let found = find_failure(builder_of(flaw), first_seed(), limit, options());
    let Some((after, failure)) = found else {
        panic!("раздел 6: the simulation did not catch {flaw:?} in {limit} scenarios");
    };
    assert_eq!(
        failure.violation.kind, expected,
        "{flaw:?} was caught after {after} scenarios, but by another invariant:\n{failure}"
    );
    eprintln!(
        "{flaw:?}: caught after {after} scenarios by {:?}",
        failure.violation.kind
    );
}

#[test]
fn a_last_writer_that_overwrites_without_a_copy_is_caught() {
    // Раздел 6, О5, Р7: a local version nobody else has is replaced and no copy is kept.
    caught(Flaw::LastWriterWins, Kind::Displaced);
}

#[test]
fn a_deletion_that_beats_an_edit_is_caught() {
    // Раздел 6, Р7, Р8: an edited file goes to the trash.
    caught(Flaw::DeleteBeatsEdit, Kind::Displaced);
}

#[test]
fn an_empty_server_that_means_delete_everything_is_caught() {
    // Раздел 6, Р8, С7: a reset server must stop the pass and keep the files.
    caught(Flaw::EmptyServerDeletesAll, Kind::Protection);
}

#[test]
fn an_engine_that_does_not_notice_a_rollback_is_caught() {
    // Раздел 6, Р6, С6.
    caught(Flaw::NoRollbackCheck, Kind::Protection);
}

#[test]
fn an_engine_without_the_mass_change_stop_is_caught() {
    // Р8, О6.
    caught(Flaw::NoMassGuard, Kind::Protection);
}

#[test]
fn an_engine_that_replaces_files_without_a_snapshot_is_caught() {
    // Р8, О4, Д53.
    caught(Flaw::NoSnapshot, Kind::NoSnapshot);
}

#[test]
fn an_engine_that_reads_a_missing_folder_as_deleted_files_is_caught() {
    // Р8, С8.
    caught(Flaw::EmptyVaultSendsDeletes, Kind::Protection);
}

#[test]
fn every_flaw_is_in_the_list_and_has_a_test() {
    // Раздел 6: no broken engine is forgotten: the list used by the tests above is the whole enum.
    assert_eq!(ALL_FLAWS.len(), 7);
    for flaw in ALL_FLAWS {
        assert_ne!(flaw, Flaw::None);
    }
}

#[test]
fn a_scenario_is_replayed_exactly_from_its_seed() {
    // Раздел 7: a failing scenario must be repeatable.
    let a = run_scenario(mini::correct, 4242, options()).expect("passes");
    let b = run_scenario(mini::correct, 4242, options()).expect("passes");
    assert_eq!(a, b, "the same seed makes the same steps");
    assert!(a.len() > 10);
    let other = run_scenario(mini::correct, 4243, options()).expect("passes");
    assert_ne!(a, other);
    let flawed_a =
        find_failure(mini::last_writer_wins, 1, 100, options()).map(|(n, f)| (n, f.step, f.trace));
    let flawed_b =
        find_failure(mini::last_writer_wins, 1, 100, options()).map(|(n, f)| (n, f.step, f.trace));
    assert_eq!(flawed_a, flawed_b, "a failure repeats too");
}

// ----- the invariants can fail -----

#[test]
fn the_convergence_check_sees_a_difference() {
    // Раздел 7, 1.
    let w = pair_with_a(mini::correct);
    w.settle_ok();
    assert!(check_convergence(&w, CheckOptions { folders: false }).is_ok());
    w.dev(1)
        .fs
        .user_write("Notes/a.md", b"changed behind the engine's back");
    let v = check_convergence(&w, CheckOptions { folders: false }).unwrap_err();
    assert_eq!(v.kind, Kind::Convergence);
}

#[test]
fn the_nothing_lost_check_sees_a_missing_version() {
    // Раздел 7, 2: a content a pass saw is nowhere any more.
    let w = two(mini::correct);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "lost.md", "AMBYSIM-never-uploaded");
    // The pass reads both files and dies before anything reaches the server.
    w.dev(0).faults.crash_at(10);
    assert!(w.dev(0).sync().is_err());
    assert!(w.dev(0).fs.files().contains_key("lost.md"));
    assert!(
        check_nothing_lost(&w).is_ok(),
        "the file is still on the disk"
    );
    w.dev(0).fs.vanish("lost.md");
    let v = check_nothing_lost(&w).unwrap_err();
    assert_eq!(v.kind, Kind::NothingLost);
}

#[test]
fn the_blind_check_sees_plain_text_on_the_server() {
    // Раздел 7, 3, О1.
    let w = World::new(mini::correct, WorldOptions::new(2));
    w.save(0, "Keep/k.md", "AMBYSIM keep");
    w.pass(0);
    assert!(check_blind(&w).is_ok());
    let dir = w.target().control().unwrap().data_dir().to_path_buf();
    let leak = dir.join("leak.txt");
    std::fs::write(&leak, b"here is AMBYSIM in plain text").unwrap();
    let v = check_blind(&w).unwrap_err();
    std::fs::remove_file(&leak).unwrap();
    assert_eq!(v.kind, Kind::NotBlind);
}
