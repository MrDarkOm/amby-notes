//! Random scenarios of the limits of appendix Е (Е.9, "Движок: симуляция"). The server is the
//! real one with a plans file; the plan is changed in the middle of the run (a downgrade), the
//! quota is filled from another space of the same account, and the passes of the writing device
//! meet crashes and lost answers at `account`, `blob_start`, `blob_delete` and `commit`.
//!
//! One device writes (the user), another only reads, and a filler uses a second space of the
//! account, so there are no conflicts: whatever happens to a file is the work of a limit. The
//! checks after every step are the six invariants of Е.9 and those of the history ceiling:
//!
//! 1. no local file disappears or changes because of a limit;
//! 2. no version on the server is removed because of a limit (before the cleanup is due), and
//!    every body a version refers to is there;
//! 3. after the limits are lifted, all files converge;
//! 4. a refusal by a limit is not a mass change;
//! 5. the server never accepts growth over the quota;
//! 6. a failure of any call does not lose the record of what is being sent.
//!
//! The ceiling: a latest version is never pruned, and early removal goes oldest first.
//!
//! The scenarios exist to be run against the real engine; the mini-engines know no limits, so
//! the checks themselves are not shown to catch broken engines (docs/Road/sync-plans-tests-report.md).

use std::collections::BTreeMap;

use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::engine::{CycleOutcome, EngineBuilder, StopReason};
use amby_sync_server::Clock;
use serde_json::json;

use crate::fault::RemoteKind;
use crate::invariants::{violation, Kind, Violation};
use crate::scenario::Failure;
use crate::world::{World, WorldOptions};

const KEEP: &str = "Keep/AMBYSIM-keep.md";
const DAY_MS: i64 = 24 * 3_600_000;

fn sealed(n: u64) -> u64 {
    sealed_body_len(n).expect("size")
}

/// The plans of the run: small numbers, a file limit that some of the sizes below exceed.
pub fn plans_text() -> String {
    json!({
        "default_plan": "tight",
        "plans": {
            "tight": {"max_file_bytes": sealed(8_000), "max_total_bytes": 60_000,
                      "history_days": 5, "max_history_bytes": 30_000},
            "roomy": {"max_file_bytes": sealed(60_000), "max_total_bytes": 400_000, "history_days": 20},
            "tiny": {"max_file_bytes": sealed(60_000), "max_total_bytes": 5_000, "history_days": 5},
            "free": {}
        }
    })
    .to_string()
}

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x1234_5678_9ABC_DEF1);
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

fn body(counter: u64, size: usize) -> Vec<u8> {
    let mut out = format!("AMBYSIM-{counter:08x}-").into_bytes();
    while out.len() < size {
        out.extend_from_slice(format!("line of version {counter}\n").as_bytes());
    }
    out.truncate(size.max(1));
    out
}

struct Run {
    world: World,
    rng: Rng,
    counter: u64,
    /// What the user has on device 0: only the user changes it.
    model: BTreeMap<String, Vec<u8>>,
    /// Rows of `versions` seen at the last check (they only grow, except at a cleanup).
    versions_seen: i64,
    live_seen: u64,
    deleted_since_pass: bool,
    filler_items: Vec<(amby_sync_core::crypto::keys::ItemId, u64, String)>,
    filler: Option<amby_sync_conformance::client::Space>,
    trace: Vec<String>,
    /// A model of a broken pruning of the history: the cleanup also removes a latest version.
    prune_latest: bool,
}

/// The filler takes room in its space, by the rules of the server; every refusal is its answer.
/// Never panics: it runs in a hook in the middle of a pass of the device.
fn grab_room(space: &amby_sync_conformance::client::Space, size: usize) {
    let body = amby_sync_conformance::client::new_body();
    if space.init_blob(&body, size as u64).status != 201 {
        return;
    }
    if space.put_part(&body, 0, vec![0x42; size]).status != 200
        || space.complete_blob(&body).status != 200
    {
        return;
    }
    let item = amby_sync_conformance::client::new_item();
    let prepared = space.file_with_uploaded_body(&item, 0, "grab.bin", b"x", &body);
    let _ = space.commit(&[prepared]);
}

impl Run {
    fn log(&mut self, line: impl Into<String>) {
        let line = line.into();
        self.world.log(line.clone());
        self.trace.push(line);
    }

    fn fail<T>(&self, kind: Kind, detail: impl Into<String>) -> Result<T, Violation> {
        Err(violation(kind, detail))
    }

    // ----- the user -----

    fn write(&mut self) {
        let sizes = [200usize, 3_000, 9_000, 20_000, 70_000];
        let size = sizes[self.rng.below(sizes.len())];
        let path = format!("F/AMBYSIM-{}.bin", self.rng.below(6));
        self.counter += 1;
        let bytes = body(self.counter, size);
        self.log(format!("user writes {path} ({size} bytes)"));
        self.world.dev(0).fs.user_write(&path, &bytes);
        self.model.insert(path, bytes);
    }

    fn delete(&mut self) {
        let paths: Vec<String> = self.model.keys().filter(|p| *p != KEEP).cloned().collect();
        if paths.is_empty() {
            return;
        }
        let path = paths[self.rng.below(paths.len())].clone();
        self.log(format!("user deletes {path}"));
        self.world.dev(0).fs.user_delete(&path);
        self.model.remove(&path);
        self.deleted_since_pass = true;
    }

    fn rename(&mut self) {
        let paths: Vec<String> = self.model.keys().filter(|p| *p != KEEP).cloned().collect();
        if paths.is_empty() {
            return;
        }
        let from = paths[self.rng.below(paths.len())].clone();
        let to = format!("R/AMBYSIM-moved-{}.bin", self.counter);
        self.counter += 1;
        if self.model.contains_key(&to) {
            return;
        }
        self.log(format!("user renames {from} to {to}"));
        self.world.dev(0).fs.user_rename(&from, &to);
        let bytes = self.model.remove(&from).expect("model");
        self.model.insert(to, bytes);
        self.deleted_since_pass = true;
    }

    // ----- the administrator and the neighbour -----

    fn plan(&mut self) {
        let name = ["tight", "roomy", "free"][self.rng.below(3)];
        self.log(format!("the administrator sets the plan {name}"));
        self.world.set_plan(name);
    }

    fn filler_add(&mut self) {
        let space = self.filler.clone().expect("filler space");
        let size = 5_000 + self.rng.below(25_000);
        let item = amby_sync_conformance::client::new_item();
        // The filler honours the server: a refusal by the quota is its answer, not a failure.
        let body = amby_sync_conformance::client::new_body();
        if space.init_blob(&body, size as u64).status != 201 {
            self.log("the filler is refused (quota or file limit)");
            return;
        }
        space.put_part(&body, 0, vec![0x42; size]).expect(200);
        space.complete_blob(&body).expect(200);
        let prepared = space.file_with_uploaded_body(&item, 0, "filler.bin", b"x", &body);
        let answer = space.commit(&[prepared]);
        if answer.status == 200 {
            self.log(format!("the filler adds {size} bytes"));
            self.filler_items.push((item, 1, "filler.bin".into()));
        } else {
            self.log("the filler's commit is refused");
        }
    }

    fn filler_remove(&mut self) {
        let Some((item, version, path)) = self.filler_items.pop() else {
            return;
        };
        let space = self.filler.clone().expect("filler space");
        self.log("the filler deletes a file");
        space.commit_ok(&[space.deletion(&item, version, &path)]);
    }

    // ----- passes -----

    fn pass(&mut self, d: usize, with_faults: bool) -> Result<(), Violation> {
        if with_faults {
            let faults = &self.world.dev(d).faults;
            match self.rng.below(6) {
                0 => faults.crash_at(1 + self.rng.below(60) as u64),
                1 => faults.lose_response_of(RemoteKind::Commit),
                2 => faults.lose_response_of(RemoteKind::BlobStart),
                3 => faults.drop_request_of(RemoteKind::Account),
                4 => faults.drop_request_of(RemoteKind::BlobDelete),
                _ => {}
            }
            // The numbers the pass read at its start go stale: another device takes the room, or
            // the administrator lowers the plan, right before the body is started (Д76).
            if d == 0 {
                match self.rng.below(6) {
                    0 => {
                        self.world
                            .log("  (a hook: the filler grabs room before the body starts)");
                        let space = self.filler.clone().expect("filler space");
                        let size = 20_000 + self.rng.below(30_000);
                        faults.before_remote(RemoteKind::BlobStart, move || {
                            grab_room(&space, size);
                        });
                    }
                    1 => {
                        self.world
                            .log("  (a hook: the plan is lowered before the body starts)");
                        let admin = self.world.target().admin.clone();
                        let name = self.world.accounts[0].username.clone();
                        faults.before_remote(RemoteKind::BlobStart, move || {
                            let _ = admin.run(&["user", "plan", "set", &name, "tight"]);
                        });
                    }
                    2 | 3 => {
                        self.world
                            .log("  (a hook: the plan is lowered before the commit)");
                        let admin = self.world.target().admin.clone();
                        let name = self.world.accounts[0].username.clone();
                        faults.before_remote(RemoteKind::Commit, move || {
                            let _ = admin.run(&["user", "plan", "set", &name, "tiny"]);
                        });
                    }
                    _ => {}
                }
            }
        }
        self.log(format!("device {d} syncs (faults: {with_faults})"));
        let head_before = self.world.server_head();
        let had_pending = self.world.dev(d).state.snapshot().commit.is_some();
        match self.world.dev(d).sync() {
            Ok(report) => {
                self.log(format!(
                    "  -> {:?} up {} down {} trashed {} unsynced {:?} errors {} limits {:?}",
                    report.outcome,
                    report.uploaded,
                    report.downloaded,
                    report.trashed,
                    report
                        .unsynced
                        .iter()
                        .map(|u| (&u.path, &u.reason))
                        .collect::<Vec<_>>(),
                    report.errors.len(),
                    report.limits
                ));
                if d == 0 {
                    // Д75: a refused body is asked for once per pass, not again and again.
                    let starts = self.world.remote_calls(0, RemoteKind::BlobStart);
                    if starts > self.model.len() + 2 {
                        return self.fail(
                            Kind::LimitRetryStorm,
                            format!(
                                "{starts} requests to start a body in one pass for {} files",
                                self.model.len()
                            ),
                        );
                    }
                    // Е.9 (6), Д76: a commit the server did not take (507) leaves the record of
                    // what is being sent in the state; nothing but an accepted commit clears it.
                    let commits = self.world.remote_calls(0, RemoteKind::Commit);
                    if commits > 0
                        && !had_pending
                        && report.outcome == CycleOutcome::Done
                        // A commit refused for a size (413) is dropped on purpose: nothing was
                        // applied and every file is judged anew. Only the lack of room (507)
                        // keeps the record.
                        && report
                            .unsynced
                            .iter()
                            .any(|u| u.reason == amby_sync_core::engine::UnsyncedReason::QuotaFull)
                        && !report.unsynced.iter().any(|u| {
                            matches!(u.reason, amby_sync_core::engine::UnsyncedReason::TooLarge { .. })
                        })
                        && self.world.server_head() == head_before
                        && self.world.dev(0).state.snapshot().commit.is_none()
                    {
                        return self.fail(
                            Kind::SendRecordLost,
                            "a commit was sent, the server did not take it and the record of it is gone",
                        );
                    }
                    if let CycleOutcome::Stopped(StopReason::MassChange { .. }) = report.outcome {
                        if !self.deleted_since_pass {
                            return self.fail(
                                Kind::LimitMassChange,
                                "a refusal by a limit stopped the pass as a mass change (Д78-в)",
                            );
                        }
                    }
                    if report.outcome == CycleOutcome::Done && !with_faults {
                        self.deleted_since_pass = false;
                    }
                }
            }
            Err(error) => self.log(format!("the pass failed: {error}")),
        }
        Ok(())
    }

    fn cleanup(&mut self) -> Result<(), Violation> {
        // A device that is behind the cleanup meets a gap in the feed, and a pass after a gap is a
        // full reconcile that believes no deletion (Д58): the file the user deleted comes back.
        // That is the design, not a limit's doing, so the devices catch up before the cleanup.
        let _ = self.world.settle();
        self.log("six days pass, the server cleans up");
        let control = self.world.control();
        control.advance(std::time::Duration::from_millis((6 * DAY_MS) as u64));
        let (latest_before, history_before) = self.snapshot();
        control.run_maintenance();
        if self.prune_latest {
            control.sql_write(|conn| {
                let removed = conn
                    .execute(
                        "DELETE FROM versions WHERE (space, item_id, version) IN ( \
                         SELECT space, item_id, version FROM versions \
                         WHERE superseded_ms IS NULL AND deleted = 0 LIMIT 1)",
                        [],
                    )
                    .expect("the model of a broken pruning");
                assert!(removed <= 1);
            });
        }
        let (latest_after, history_after) = self.snapshot();
        if latest_after != latest_before {
            return self.fail(
                Kind::HistoryCeiling,
                "a latest version was removed by the cleanup",
            );
        }
        // Oldest first: if a row that was still promised (keep_until in the future) went, no
        // older row may remain.
        let now = control.clock.now_ms();
        let removed: Vec<&(Vec<u8>, i64, i64, i64)> = history_before
            .iter()
            .filter(|row| !history_after.contains(row))
            .collect();
        let early_max = removed
            .iter()
            .filter(|row| row.3 > now)
            .map(|row| row.2)
            .max();
        if let Some(limit) = early_max {
            if let Some(left) = history_after.iter().find(|row| row.2 < limit) {
                return self.fail(
                    Kind::HistoryCeiling,
                    format!(
                        "a version replaced at {limit} was removed early while an older one (replaced at {}) stays",
                        left.2
                    ),
                );
            }
        }
        self.versions_seen = self.count("versions");
        Ok(())
    }

    /// The latest rows and the history rows as `(item, version, superseded_ms, keep_until_ms)`.
    #[allow(clippy::type_complexity)]
    fn snapshot(&self) -> (Vec<(Vec<u8>, i64)>, Vec<(Vec<u8>, i64, i64, i64)>) {
        self.world.control().sql(|conn| {
            let mut latest = conn
                .prepare("SELECT item_id, version FROM versions WHERE superseded_ms IS NULL AND deleted = 0 ORDER BY item_id")
                .expect("prepare");
            let latest: Vec<(Vec<u8>, i64)> = latest
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query")
                .map(Result::unwrap)
                .collect();
            let mut history = conn
                .prepare(
                    "SELECT item_id, version, superseded_ms, COALESCE(keep_until_ms, 0) \
                     FROM versions WHERE superseded_ms IS NOT NULL ORDER BY superseded_ms",
                )
                .expect("prepare");
            let history: Vec<(Vec<u8>, i64, i64, i64)> = history
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
                .expect("query")
                .map(Result::unwrap)
                .collect();
            (latest, history)
        })
    }

    fn count(&self, table: &str) -> i64 {
        self.world.count_rows(table)
    }

    // ----- the invariants after a step -----

    fn check(&mut self) -> Result<(), Violation> {
        // 1: the files of the user are as the user left them.
        let files = self.world.dev(0).fs.files();
        if files != self.model {
            let missing: Vec<&String> = self
                .model
                .keys()
                .filter(|p| !files.contains_key(*p))
                .collect();
            return self.fail(
                Kind::LimitTouchedLocal,
                format!("device 0 differs from what the user has: missing {missing:?}"),
            );
        }
        // 2: versions only grow between cleanups; bodies of versions are there.
        let versions = self.count("versions");
        if versions < self.versions_seen {
            return self.fail(
                Kind::LimitRemovedServer,
                format!(
                    "the server has fewer versions ({versions}) than before ({})",
                    self.versions_seen
                ),
            );
        }
        self.versions_seen = versions;
        let dangling: i64 = self.world.control().sql(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM versions v WHERE v.blob_id IS NOT NULL AND NOT EXISTS \
                 (SELECT 1 FROM blobs b WHERE b.space = v.space AND b.blob_id = v.blob_id AND b.complete = 1)",
                [],
                |row| row.get(0),
            )
            .expect("dangling")
        });
        if dangling > 0 {
            return self.fail(
                Kind::LimitRemovedServer,
                format!("{dangling} versions refer to a body the server does not have"),
            );
        }
        // 5: the live bytes never grow above the quota of the moment.
        let overview = self.world.overview();
        let live = overview["usage"]["live_bytes"].as_u64().unwrap_or(0);
        if let Some(total) = overview["limits"]["max_total_bytes"].as_u64() {
            if live > total && live > self.live_seen {
                return self.fail(
                    Kind::QuotaOverrun,
                    format!(
                        "live bytes grew from {} to {live} over the quota {total}",
                        self.live_seen
                    ),
                );
            }
        }
        self.live_seen = live;
        Ok(())
    }

    fn finish(&mut self) -> Result<(), Violation> {
        self.log("the limits are lifted, the filler leaves, everything settles");
        self.world.set_plan("free");
        while !self.filler_items.is_empty() {
            self.filler_remove();
        }
        if let Err(error) = self.world.settle() {
            return self.fail(Kind::LimitNotConverged, error);
        }
        let server = self.world.server_files();
        if server != self.model {
            return self.fail(
                Kind::LimitNotConverged,
                format!(
                    "the server has {} files, the user has {}: only on the server {:?}, only with the user {:?}, different {:?}",
                    server.len(),
                    self.model.len(),
                    server.keys().filter(|p| !self.model.contains_key(*p)).collect::<Vec<_>>(),
                    self.model.keys().filter(|p| !server.contains_key(*p)).collect::<Vec<_>>(),
                    server.iter().filter(|(p, c)| self.model.get(*p).is_some_and(|m| m != *c)).map(|(p, _)| p).collect::<Vec<_>>(),
                ),
            );
        }
        if self.world.dev(1).fs.files() != self.model {
            return self.fail(Kind::LimitNotConverged, "device 1 differs from the user");
        }
        for d in 0..2 {
            let state = self.world.dev(d).state.snapshot();
            if state.commit.is_some() {
                return self.fail(
                    Kind::SendRecordLost,
                    format!("device {d} still holds an unfinished commit after everything settled"),
                );
            }
            if !state.unsynced.is_empty() {
                return self.fail(
                    Kind::LimitNotConverged,
                    format!("device {d} still lists {:?}", state.unsynced),
                );
            }
        }
        Ok(())
    }
}

/// Runs one scenario of limits from `seed`.
pub fn run_limits_scenario(builder: EngineBuilder, seed: u64) -> Result<Vec<String>, Failure> {
    run_limits_scenario_with(builder, seed, false)
}

/// The same; `prune_latest` makes the cleanup of the server remove a latest version (a model of
/// a broken pruning, to show that the scenarios notice it).
pub fn run_limits_scenario_with(
    builder: EngineBuilder,
    seed: u64,
    prune_latest: bool,
) -> Result<Vec<String>, Failure> {
    let rng = Rng::new(seed);
    let options = WorldOptions::new(2)
        .seed(seed)
        .plans(&plans_text())
        .pinned("tight");
    let world = World::new(builder, options);
    world.scale_mass_threshold(4);
    let filler = world.accounts[0].create_space();
    let mut run = Run {
        world,
        rng,
        counter: seed * 1000,
        model: BTreeMap::new(),
        versions_seen: 0,
        live_seen: 0,
        deleted_since_pass: false,
        filler_items: Vec::new(),
        filler: Some(filler),
        trace: Vec::new(),
        prune_latest,
    };
    let fail = |run: &Run, step: usize, violation: Violation| Failure {
        seed,
        step,
        violation,
        trace: run.trace.clone(),
    };
    let keep = b"AMBYSIM keep this file\n".to_vec();
    run.world.dev(0).fs.user_write(KEEP, &keep);
    run.model.insert(KEEP.to_string(), keep);
    run.world.set_plan("roomy");
    if let Err(error) = run.world.settle() {
        return Err(fail(&run, 0, violation(Kind::Unexpected, error)));
    }
    run.world.set_plan("tight");
    for step in 0..40 {
        let result = match run.rng.below(100) {
            0..=29 => {
                run.write();
                Ok(())
            }
            30..=36 => {
                run.delete();
                Ok(())
            }
            37..=41 => {
                run.rename();
                Ok(())
            }
            42..=53 => {
                run.plan();
                Ok(())
            }
            54..=60 => {
                run.filler_add();
                Ok(())
            }
            61..=64 => {
                run.filler_remove();
                Ok(())
            }
            65..=69 => run.cleanup(),
            70..=71 => run.pass(1, false),
            _ => {
                let faults = run.rng.chance(35);
                run.pass(0, faults)
            }
        };
        if let Err(v) = result.and_then(|()| run.check()) {
            return Err(fail(&run, step, v));
        }
    }
    if let Err(v) = run.finish() {
        return Err(fail(&run, 40, v));
    }
    Ok(run.trace)
}
