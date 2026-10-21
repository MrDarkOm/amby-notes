//! Runs the random scenarios of `sync/sim` against the real engine, for a long time and in a few
//! processes (Э3, step 2 of the implementation session). The simulation itself is not changed.
//!
//! `amby-sync-simrun <first seed> <count> [quick|folders]`: every failing seed is printed with
//! the violation and the trace of the scenario, the exit code is the number of failures (capped).
//!
//! The test client of the server opens a new connection for every request, and on macOS a closed
//! connection holds its port for 30 seconds. Many requests in a short time use up the ports and
//! the client fails with "Can't assign requested address". That is the machine, not the engine:
//! the runner waits while many ports are held, and runs a seed again when its only problem was
//! the transport.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::Command;
use std::time::{Duration, Instant};

use amby_sync_core::engine::Engine;
use amby_sync_sim::scenario::{run_scenario, Failure, Options};

/// How many closed connections may be waiting before the next scenario starts, unless
/// `SIMRUN_PORTS_HELD_LIMIT` says otherwise. The machine has about 16 000 ports.
const PORTS_HELD_LIMIT: usize = 9000;

fn ports_held_limit() -> usize {
    std::env::var("SIMRUN_PORTS_HELD_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(PORTS_HELD_LIMIT)
}

/// Connections of this machine that are in the closing wait (macOS and Linux `netstat`).
fn ports_held() -> usize {
    Command::new("netstat")
        .args(["-an", "-p", "tcp"])
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|line| line.contains("TIME_WAIT"))
                .count()
        })
        .unwrap_or(0)
}

fn wait_for_ports() {
    let limit = ports_held_limit();
    while ports_held() > limit {
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// One scenario; `Err(None)` when the transport of the test client failed (the machine).
fn attempt(seed: u64, options: Options) -> Result<(), Option<Failure>> {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        run_scenario(Engine::boxed, seed, options)
    }));
    match outcome {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(failure)) => Err(Some(failure)),
        Err(panic) => {
            let text = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_string()))
                .unwrap_or_default();
            if text.contains("transport failure") {
                Err(None)
            } else {
                println!("PANIC seed={seed}: {text}");
                Err(Some(Failure {
                    seed,
                    step: 0,
                    violation: amby_sync_sim::invariants::violation(
                        amby_sync_sim::invariants::Kind::Unexpected,
                        format!("panic: {text}"),
                    ),
                    trace: Vec::new(),
                }))
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let first: u64 = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(1);
    let count: u64 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(100);
    let mode = args.get(3).map_or("quick", String::as_str);
    let options = match mode {
        "folders" => Options {
            folders: true,
            ..Options::QUICK
        },
        _ => Options::QUICK,
    };
    let started = Instant::now();
    let verbose = std::env::var("SIMRUN_VERBOSE").is_ok();
    let (mut failed, mut passed, mut retried) = (0u32, 0u64, 0u32);
    for seed in first..first + count {
        wait_for_ports();
        let began = Instant::now();
        let mut result = attempt(seed, options);
        if matches!(result, Err(None)) {
            retried += 1;
            std::thread::sleep(Duration::from_secs(40));
            wait_for_ports();
            result = attempt(seed, options);
        }
        if verbose {
            eprintln!("seed {seed}: {:.2} s", began.elapsed().as_secs_f64());
        }
        match result {
            Ok(()) => passed += 1,
            Err(Some(failure)) => {
                failed += 1;
                println!("FAIL mode={mode} seed={seed}\n{failure}");
            }
            Err(None) => println!("INFRA mode={mode} seed={seed}: the transport failed twice"),
        }
    }
    println!(
        "mode={mode} seeds {first}..{} done in {:.1} s: {passed} passed, {failed} failed, {retried} repeated for the transport",
        first + count,
        started.elapsed().as_secs_f64()
    );
    std::process::exit(i32::try_from(failed.min(100)).unwrap_or(100));
}
