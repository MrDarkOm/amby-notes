//! Random scenarios from a seed (раздел 7): edits, creations, renames, deletions on several
//! devices, passes with crashes and lost requests, and the protections of Р8 met on the way: an
//! unplugged or emptied vault, a rollback of the server, a mass change, a reset of the server, a
//! server restored from an old copy. A failing scenario is repeated from its seed.
//!
//! How many scenarios a run makes is `AMBY_SIM_SCENARIOS` (a few by default, many at night).

use std::collections::BTreeMap;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::engine::{
    ChangeEntry, CycleOutcome, CycleRequest, EngineBuilder, EngineError, StopReason,
};

use crate::fault::{RemoteKind, PROCESS_DIED};
use crate::invariants::{check_final, check_pass, violation, CheckOptions, Kind, Violation};
use crate::vfs::Vfs;
use crate::world::{World, WorldOptions};

/// How many scenarios a run makes: `AMBY_SIM_SCENARIOS`, else `default`.
pub fn scenario_count(default: usize) -> usize {
    std::env::var("AMBY_SIM_SCENARIOS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Where the seeds start: `AMBY_SIM_SEED`, else 1.
pub fn first_seed() -> u64 {
    std::env::var("AMBY_SIM_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1)
}

/// What a scenario may do.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Steps of editing and syncing per scenario.
    pub steps: usize,
    /// Folders and renames of folders (the real engine; the mini-engine has no folders).
    pub folders: bool,
    /// Crashes and lost requests in the passes.
    pub faults: bool,
    /// Unplugged or emptied vault, rollback, mass change (any server).
    pub protections: bool,
    /// Reset and restore of the server (needs a server of its own, slower).
    pub server_events: bool,
}

impl Options {
    pub const QUICK: Options = Options {
        steps: 30,
        folders: false,
        faults: true,
        protections: true,
        server_events: true,
    };
}

/// A failed scenario: repeat it with the seed.
#[derive(Debug)]
pub struct Failure {
    pub seed: u64,
    pub step: usize,
    pub violation: Violation,
    pub trace: Vec<String>,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(
            f,
            "scenario with seed {} failed at step {}: {}",
            self.seed, self.step, self.violation
        )?;
        for line in &self.trace {
            writeln!(f, "  {line}")?;
        }
        Ok(())
    }
}

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03);
        rng.next();
        rng
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
}

/// A content the user could have saved: starts with the marker, never repeats.
pub fn content(counter: u64, rng_size: u64) -> Vec<u8> {
    let size = match rng_size % 100 {
        0..=2 => 0,
        3..=4 => 70_000 + (rng_size as usize % 5000),
        5..=14 => 400 + (rng_size as usize % 3000),
        _ => 20 + (rng_size as usize % 300),
    };
    if size == 0 {
        return Vec::new();
    }
    let mut out = format!("AMBYSIM-{counter:08x}-").into_bytes();
    let mut i = 0u64;
    while out.len() < size {
        out.extend_from_slice(format!("line {i} of version {counter}\n").as_bytes());
        i += 1;
    }
    out.truncate(size.max(out.len().min(size)));
    out
}

const KEEP: &str = "Keep/AMBYSIM-keep.md";

struct Run<'a> {
    world: &'a mut World,
    rng: Rng,
    counter: u64,
    options: Options,
    steps_done: usize,
    bulk_done: bool,
}

impl Run<'_> {
    fn note(&self, line: impl Into<String>) {
        let line = format!("step {}: {}", self.steps_done, line.into());
        if std::env::var("AMBY_SIM_TRACE").is_ok() {
            eprintln!("{line}");
        }
        self.world.log(line);
    }

    fn fresh(&mut self) -> Vec<u8> {
        self.counter += 1;
        let size = self.rng.next();
        content(self.counter, size)
    }

    fn pick_path(&mut self, existing: &[String]) -> String {
        const DIRS: [&str; 3] = ["", "Notes/", "Ideas/Deep/"];
        if !existing.is_empty() && self.rng.chance(55) {
            return existing[self.rng.below(existing.len())].clone();
        }
        format!(
            "{}AMBYSIM-{}.md",
            DIRS[self.rng.below(DIRS.len())],
            self.rng.below(14)
        )
    }

    fn editable(&self, d: usize) -> Vec<String> {
        self.world
            .dev(d)
            .fs
            .files()
            .keys()
            .filter(|p| p.as_str() != KEEP && !p.contains("-conflict"))
            .cloned()
            .collect()
    }

    fn step(&mut self) -> Result<(), Violation> {
        let devices = self.world.devices.len();
        let d = self.rng.below(devices);
        let roll = self.rng.below(100);
        match roll {
            0..=27 => {
                let files = self.editable(d);
                let path = self.pick_path(&files);
                let bytes = self.fresh();
                self.note(format!("device {d} saves {path} ({} bytes)", bytes.len()));
                self.world.dev(d).fs.user_write(&path, &bytes);
                Ok(())
            }
            28..=35 => {
                let files = self.editable(d);
                if files.is_empty() {
                    return Ok(());
                }
                let path = files[self.rng.below(files.len())].clone();
                self.note(format!("device {d} deletes {path}"));
                self.world.dev(d).fs.user_delete(&path);
                Ok(())
            }
            36..=45 => {
                let files = self.editable(d);
                if files.is_empty() {
                    return Ok(());
                }
                let from = files[self.rng.below(files.len())].clone();
                let to = self.pick_path(&[]);
                if self.world.dev(d).fs.exists(&to) {
                    return Ok(());
                }
                self.note(format!("device {d} renames {from} to {to}"));
                self.world.dev(d).fs.user_rename(&from, &to);
                Ok(())
            }
            46..=49 if self.options.folders => {
                let dirs: Vec<String> = self
                    .world
                    .dev(d)
                    .fs
                    .dirs()
                    .into_iter()
                    .filter(|p| p.as_str() != "Keep" && !p.is_empty())
                    .collect();
                if dirs.is_empty() {
                    return Ok(());
                }
                let from = dirs[self.rng.below(dirs.len())].clone();
                let to = format!("Moved-{}", self.rng.below(4));
                if self.world.dev(d).fs.exists(&to) || to.starts_with(&from) {
                    return Ok(());
                }
                self.note(format!("device {d} renames the folder {from} to {to}"));
                self.world.dev(d).fs.user_rename(&from, &to);
                Ok(())
            }
            50..=89 => self.sync_step(d),
            _ if self.options.protections => self.protection_step(d),
            _ => self.sync_step(d),
        }
    }

    fn sync_step(&mut self, d: usize) -> Result<(), Violation> {
        let mut injected = false;
        if self.options.faults {
            match self.rng.below(100) {
                0..=19 => {
                    let at = 1 + self.rng.below(45) as u64;
                    self.note(format!("device {d}: the process dies at call {at}"));
                    self.world.dev(d).faults.crash_at(at);
                    injected = true;
                }
                20..=31 => {
                    let kind = self.remote_kind();
                    self.note(format!("device {d}: the answer to {kind:?} is lost"));
                    self.world.dev(d).faults.lose_response_of(kind);
                    injected = true;
                }
                32..=39 => {
                    let kind = self.remote_kind();
                    self.note(format!("device {d}: the request {kind:?} does not arrive"));
                    self.world.dev(d).faults.drop_request_of(kind);
                    injected = true;
                }
                _ => {}
            }
        }
        if !injected {
            self.note(format!("device {d} synchronises"));
        }
        let result = self.world.dev(d).sync();
        self.check_result(d, result, injected)
    }

    fn remote_kind(&mut self) -> RemoteKind {
        [
            RemoteKind::Info,
            RemoteKind::Changes,
            RemoteKind::BlobStart,
            RemoteKind::Complete,
            RemoteKind::Download,
            RemoteKind::Commit,
        ][self.rng.below(6)]
        .clone()
    }

    fn check_result(
        &mut self,
        d: usize,
        result: Result<amby_sync_core::engine::CycleReport, EngineError>,
        injected: bool,
    ) -> Result<(), Violation> {
        match result {
            Ok(report) => {
                if report.outcome != CycleOutcome::Done {
                    return Err(violation(
                        Kind::Unexpected,
                        format!("device {d}: the pass ended with {:?}", report.outcome),
                    ));
                }
            }
            Err(error) => {
                let expected = injected
                    && matches!(
                        &error,
                        EngineError::Remote(_) | EngineError::Fs(_) | EngineError::State(_)
                    );
                if !expected {
                    return Err(violation(
                        Kind::Unexpected,
                        format!("device {d}: the pass failed: {error}"),
                    ));
                }
                let text = error.to_string();
                if !text.contains(PROCESS_DIED) && !text.contains("simulated network fault") {
                    return Err(violation(
                        Kind::Unexpected,
                        format!("device {d}: the pass failed with a strange error: {error}"),
                    ));
                }
            }
        }
        check_pass(self.world, d)
    }

    fn protection_step(&mut self, d: usize) -> Result<(), Violation> {
        let mut choices = vec!["unplug", "wipe", "rollback"];
        if !self.bulk_done {
            choices.push("bulk");
        }
        if self.options.server_events && self.world.devices.len() >= 2 {
            choices.extend(["reset", "behind"]);
        }
        let which = choices[self.rng.below(choices.len())];
        self.note(format!("device {d}: protection scenario `{which}`"));
        match which {
            "unplug" => self.unplug(d),
            "wipe" => self.wipe(d),
            "rollback" => self.rollback(d),
            "bulk" => {
                self.bulk_done = true;
                self.bulk(d)
            }
            "reset" => self.reset(),
            _ => self.behind(),
        }
    }

    fn expect_stop(
        &self,
        d: usize,
        what: &str,
        matches_reason: impl Fn(&StopReason) -> bool,
    ) -> Result<(), Violation> {
        match self.world.dev(d).sync() {
            Ok(report) => match &report.outcome {
                CycleOutcome::Stopped(reason) if matches_reason(reason) => Ok(()),
                other => Err(violation(
                    Kind::Protection,
                    format!(
                        "device {d}: {what}: expected a stop, the pass ended with {other:?} (Р8)"
                    ),
                )),
            },
            Err(error) => Err(violation(
                Kind::Unexpected,
                format!("device {d}: {what}: the pass failed: {error}"),
            )),
        }
    }

    fn state_has_files(&self, d: usize) -> bool {
        self.world
            .dev(d)
            .state
            .snapshot()
            .items
            .values()
            .any(|r| !r.deleted)
    }

    fn unplug(&mut self, d: usize) -> Result<(), Violation> {
        if !self.state_has_files(d) {
            return Ok(());
        }
        let before = self.world.server_head();
        self.world.dev(d).fs.set_root_present(false);
        let stopped = self.expect_stop(d, "the vault folder is gone", |r| {
            matches!(r, StopReason::VaultMissing)
        });
        self.world.dev(d).fs.set_root_present(true);
        stopped?;
        self.same_head(before, "the vault folder is gone")
    }

    fn wipe(&mut self, d: usize) -> Result<(), Violation> {
        if !self.state_has_files(d) {
            return Ok(());
        }
        let files = self.world.dev(d).fs.files();
        let before = self.world.server_head();
        for path in files.keys() {
            self.world.dev(d).fs.user_delete(path);
        }
        let stopped = self.expect_stop(d, "the vault folder is empty", |r| {
            matches!(r, StopReason::VaultEmpty)
        });
        for (path, bytes) in &files {
            self.world.dev(d).fs.user_write(path, bytes);
        }
        stopped?;
        self.same_head(before, "the vault folder is empty")
    }

    fn same_head(&self, before: u64, what: &str) -> Result<(), Violation> {
        let after = self.world.server_head();
        if after != before {
            return Err(violation(
                Kind::Protection,
                format!(
                    "{what}: the pass sent changes to the server (head {before} → {after}) (Р8)"
                ),
            ));
        }
        Ok(())
    }

    fn rollback(&mut self, d: usize) -> Result<(), Violation> {
        // An item the device knows at its latest version and the server has an older one of.
        let state = self.world.dev(d).state.snapshot();
        let space = self.world.space(d);
        let mut victim: Option<(ChangeEntry, Vec<u8>)> = None;
        for (key, record) in &state.items {
            if record.deleted || record.version < 2 {
                continue;
            }
            let item = ItemId::from_bytes(*key);
            let versions = space.versions(&item).expect(200).json();
            let list = versions["versions"].as_array().cloned().unwrap_or_default();
            let latest = list.first().and_then(|v| v["version"].as_u64());
            if latest != Some(record.version) {
                continue;
            }
            if let Some(old) = list
                .iter()
                .find(|v| v["version"].as_u64() < Some(record.version))
            {
                let entry = ChangeEntry {
                    seq: old["seq"].as_u64().unwrap_or(0),
                    item_id: item,
                    version: old["version"].as_u64().unwrap_or(0),
                    header: hex::decode(old["header"].as_str().unwrap_or("")).unwrap_or_default(),
                    blob_id: old["blob_id"].as_str().map(|s| {
                        amby_sync_core::crypto::keys::BodyId::from_bytes(
                            hex::decode(s).unwrap().try_into().unwrap(),
                        )
                    }),
                    blob_size: old["blob_size"].as_u64(),
                    deleted: old["deleted"].as_bool().unwrap_or(false),
                    device_id: [0; 16],
                    committed_ms: 0,
                };
                victim = Some((entry, Vec::new()));
                break;
            }
        }
        let Some((stale, _)) = victim else {
            return Ok(());
        };
        let files = self.world.dev(d).fs.files();
        let device = self.world.dev(d);
        device.lies.borrow_mut().changes = Some(Box::new(move |mut page| {
            page.changes.retain(|c| c.item_id != stale.item_id);
            page.changes.push(stale.clone());
            page
        }));
        let stopped = self.expect_stop(d, "the server shows an older version", |r| {
            matches!(r, StopReason::Rollback { .. })
        });
        self.world.dev(d).lies.borrow_mut().changes = None;
        stopped?;
        if self.world.dev(d).fs.files() != files {
            return Err(violation(
                Kind::Protection,
                format!(
                    "device {d}: files changed in a pass that had to stop on a rollback (Р6, С6)"
                ),
            ));
        }
        Ok(())
    }

    fn bulk(&mut self, d: usize) -> Result<(), Violation> {
        if let Err(error) = self.world.settle() {
            return Err(violation(Kind::Unexpected, error));
        }
        let mut originals = BTreeMap::new();
        for i in 0..30 {
            let bytes = self.fresh();
            let path = format!("Bulk/AMBYSIM-bulk-{i}.md");
            self.world.dev(d).fs.user_write(&path, &bytes);
            originals.insert(path, bytes);
        }
        if let Err(error) = self.world.settle() {
            return Err(violation(Kind::Unexpected, error));
        }
        // 1. Outgoing: 26 deletions in one pass.
        let before = self.world.server_head();
        let victims: Vec<String> = originals.keys().take(26).cloned().collect();
        for path in &victims {
            self.world.dev(d).fs.user_delete(path);
        }
        let stopped = self.expect_stop(d, "26 deletions of 30+ files", |r| {
            matches!(
                r,
                StopReason::MassChange {
                    direction: amby_sync_core::engine::Direction::Outgoing,
                    ..
                }
            )
        });
        for path in &victims {
            self.world.dev(d).fs.user_write(path, &originals[path]);
        }
        stopped?;
        self.same_head(before, "26 deletions of 30+ files")?;
        // 2. Incoming: 26 edits arrive at another device.
        let other = (d + 1) % self.world.devices.len();
        if let Err(error) = self.world.settle() {
            return Err(violation(Kind::Unexpected, error));
        }
        for path in &victims {
            let bytes = self.fresh();
            self.world.dev(d).fs.user_write(path, &bytes);
        }
        if let Err(error) = self.world.dev(d).sync() {
            return Err(violation(Kind::Unexpected, format!("{error}")));
        }
        let files = self.world.dev(other).fs.files();
        let stopped = self.expect_stop(other, "26 files overwritten from the server", |r| {
            matches!(
                r,
                StopReason::MassChange {
                    direction: amby_sync_core::engine::Direction::Incoming,
                    ..
                }
            )
        });
        stopped?;
        if self.world.dev(other).fs.files() != files {
            return Err(violation(
                Kind::Protection,
                format!("device {other}: files changed in a pass that had to stop on a mass change (О6)"),
            ));
        }
        let approved = CycleRequest {
            approvals: amby_sync_core::engine::Approvals {
                mass_change: true,
                ..Default::default()
            },
            ..Default::default()
        };
        for index in 0..self.world.devices.len() {
            let result = if index == d {
                self.world.dev(index).sync()
            } else {
                self.world.dev(index).sync_with(&approved)
            };
            match result {
                Ok(report) if report.outcome == CycleOutcome::Done => {}
                other_result => {
                    return Err(violation(
                        Kind::Protection,
                        format!("the approved pass did not finish: {other_result:?}"),
                    ))
                }
            }
        }
        Ok(())
    }

    fn reset(&mut self) -> Result<(), Violation> {
        if self.world.settle().is_err() {
            return Err(violation(Kind::Unexpected, "no settle before the reset"));
        }
        let before: Vec<_> = self.world.devices.iter().map(|d| d.fs.files()).collect();
        self.world.reset_server();
        for d in 0..self.world.devices.len() {
            self.expect_stop(d, "the server was reset", |r| {
                matches!(r, StopReason::ServerReset { .. })
            })?;
            if self.world.dev(d).fs.files() != before[d] {
                return Err(violation(
                    Kind::Protection,
                    format!("device {d}: local files changed after the server was reset (Р8, С7)"),
                ));
            }
        }
        for d in 0..self.world.devices.len() {
            match self.world.dev(d).sync_approved() {
                Ok(report) if report.outcome == CycleOutcome::Done => {}
                other => {
                    return Err(violation(
                        Kind::Protection,
                        format!("device {d}: the upload after the reset did not finish: {other:?}"),
                    ))
                }
            }
        }
        Ok(())
    }

    fn behind(&mut self) -> Result<(), Violation> {
        if self.world.settle().is_err() {
            return Err(violation(Kind::Unexpected, "no settle before the backup"));
        }
        let backup = self.world.backup_server();
        let bytes = self.fresh();
        self.world
            .dev(0)
            .fs
            .user_write("Notes/AMBYSIM-after-backup.md", &bytes);
        if self.world.settle().is_err() {
            return Err(violation(Kind::Unexpected, "no settle after the backup"));
        }
        let before: Vec<_> = self.world.devices.iter().map(|d| d.fs.files()).collect();
        self.world.restore_server(&backup);
        for d in 0..self.world.devices.len() {
            self.expect_stop(d, "the server went back to an older copy", |r| {
                matches!(
                    r,
                    StopReason::ServerBehind { .. } | StopReason::ServerReset { .. }
                )
            })?;
            if self.world.dev(d).fs.files() != before[d] {
                return Err(violation(
                    Kind::Protection,
                    format!("device {d}: local files changed after the server went back (Р8, С7)"),
                ));
            }
        }
        for d in 0..self.world.devices.len() {
            match self.world.dev(d).sync_approved() {
                Ok(report) if report.outcome == CycleOutcome::Done => {}
                other => {
                    return Err(violation(
                        Kind::Protection,
                        format!("device {d}: the pass after the restore did not finish: {other:?}"),
                    ))
                }
            }
        }
        Ok(())
    }
}

/// Runs one scenario of `options` from `seed` against the engine made by `builder`.
pub fn run_scenario(
    builder: EngineBuilder,
    seed: u64,
    options: Options,
) -> Result<Vec<String>, Failure> {
    let mut rng = Rng::new(seed);
    let devices = 2 + rng.below(2);
    let isolated = options.server_events && rng.chance(25);
    let mut world_options = WorldOptions::new(devices).seed(seed);
    world_options.isolated = isolated;
    world_options.fs = (0..devices).map(|_| Vfs::linux()).collect();
    let mut world = World::new(builder, world_options);
    let options = Options {
        server_events: options.server_events && isolated,
        ..options
    };
    let mut run = Run {
        world: &mut world,
        rng,
        counter: seed * 1000,
        options,
        steps_done: 0,
        bulk_done: false,
    };
    let fail = |run: &Run, step: usize, violation: Violation| Failure {
        seed,
        step,
        violation,
        trace: run.world.trace.borrow().clone(),
    };

    // A file that is never touched keeps the vault from being empty.
    run.world
        .dev(0)
        .fs
        .user_write(KEEP, b"AMBYSIM keep this file\n");
    if let Err(error) = run.world.settle() {
        return Err(fail(&run, 0, violation(Kind::Unexpected, error)));
    }
    for step in 0..options.steps {
        run.steps_done = step;
        if let Err(v) = run.step() {
            return Err(fail(&run, step, v));
        }
    }
    run.world.log("the scenario is over, everything settles");
    if let Err(error) = run.world.settle() {
        return Err(fail(
            &run,
            options.steps,
            violation(Kind::Unexpected, error),
        ));
    }
    let check = CheckOptions {
        folders: options.folders,
    };
    if let Err(v) = check_final(run.world, check) {
        return Err(fail(&run, options.steps, v));
    }
    let trace = run.world.trace.borrow().clone();
    Ok(trace)
}

/// Runs `count` scenarios from `first`; stops at the first failure.
pub fn run_many(
    builder: EngineBuilder,
    first: u64,
    count: usize,
    options: Options,
) -> Result<usize, Failure> {
    for seed in first..first + count as u64 {
        run_scenario(builder, seed, options)?;
    }
    Ok(count)
}

/// Runs scenarios until one fails; returns the failure and how many scenarios it took.
pub fn find_failure(
    builder: EngineBuilder,
    first: u64,
    limit: usize,
    options: Options,
) -> Option<(usize, Failure)> {
    for (index, seed) in (first..first + limit as u64).enumerate() {
        if let Err(failure) = run_scenario(builder, seed, options) {
            return Some((index + 1, failure));
        }
    }
    None
}
