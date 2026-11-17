# Sync: gate reports

Status as of 2026-11-03. The gates are passed (run 40383686825: 64,000 scenarios, 64 mutation shards, 50 survivors explained), `GATES_PASSED = true`, and sync works on real vaults. Plan, decisions, and protocol contract: [../sync-plan.md](../sync-plan.md). What is left: [target/sync.md](target/sync.md). Reports of stages Э1–Э4б and appendix Е are in the local archive.

| Part                          | What                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| 1. Gates in GitHub Actions    | Two runs: mutants and the long simulation                        |
| 2. Analysis of the second run | Result and final decision                                        |
| 3. Surviving mutants          | Why some are considered equivalent (tests refer to this section) |
| 4. The apply-swap bug         | Analysis of a mini-engine failure                                |

---

## Part 1. Sync gates in GitHub Actions: report

_Formerly the file `sync-gates-ci-report.md`, merged 2026-11-03._

Date: 24 October 2026. Task: prepare in Actions the two runs from "Gates before real notes" (`docs/sync-plan.md`, Э4) and do a trial run of the commands locally. There have been no runs on GitHub yet, nothing has been pushed (`GATES_PASSED` was not changed).

### What was done

- `.github/workflows/sync-gates.yml` — a single file, four groups of jobs.
- `scripts/sync-gates-summary.mjs` — combines the results of the shards into one report.
- A section "How the gates are run" in `docs/sync-plan.md`, an entry in `updates/upd_next.md`, a line in `sync/MAP.md`.

### How to run

```bash
git push origin HEAD:gates/run
```

If the branch already exists, `--force` is needed. It is precisely a `push` to a branch, not a button and not a schedule: such triggers work only for the file on `main`, and `sync/` gets there at release. One run goes at a time (the `concurrency: sync-gates` group; a second one is queued rather than cancelling the first). All actions are pinned to full SHAs (checked with `git ls-remote`), permissions are `contents: read`.

### Mutation testing

- What is covered: the entire `core/src`, that is, both the cryptography (it was already run in Э1: 346 mutants) and the engine. There are currently **1501 mutants**. `npm run sync:mutants` also takes the whole `amby-sync-core` package.
- `cargo-mutants` is pinned to 27.1.0 (same as the owner's), 20 shards `--shard k/20 --sharding round-robin` (75–76 mutants each; without `round-robin` the shards came out unequal).
- **Which tests.** Engine mutants are killed mostly by the simulation tests (`sync/sim/tests`), not by the core tests, so both packages are used: `--test-package amby-sync-core --test-package amby-sync-sim`. A quirk of 27.1 (noticed during the trial): the "baseline" cargo-mutants run goes over the core only, while the mutants already go over both packages; `sync.yml` separately checks the full suite before the run.
- **Accelerated suite.** `sim/tests/self_check.rs` was removed from the tests: it checks the mini-engine and the invariants of the simulation itself and does not call `amby_sync_core::engine` (verified: the file has no real `Engine`), and it alone takes longer than all the others together (124 s versus about 80 s in `release`). All tests that run the real engine remain. The build uses `CARGO_PROFILE_DEV_OPT_LEVEL=2`: simulation tests without optimization take minutes (`rows_p7.rs` — 4.5 minutes), and in `--release` rebuilding each mutant is more expensive (17 s versus 9 s in a trial of 23 mutants); at level 2 the overflow checks and `debug_assert` remain, and the arithmetic mutants need them.
- **Timeout** is set explicitly: `--timeout 600 --build-timeout 1200`. The automatic one is derived from the baseline run (core only, 6–20 s), and a surviving mutant that runs the whole suite (105 s in the trial) would get a false timeout.
- Exit codes 2 (survivors) and 3 (timeouts) are findings, not a job failure. Each shard puts its `mutants.out` into the artifact `mutants-<k>` for 30 days.
- The summary (`gates-summary`, `$GITHUB_STEP_SUMMARY`): how many were caught, survived, timed out, unviable; a list of survivors with file and line; a list of timeouts. The summary job fails if any shard did not arrive.

### Long simulation

- `sync/simrun`, 20 jobs × 4 processes (the number of runner cores) × 2 modes (`quick`, `folders`) × 400 seeds = **64,000 scenarios**, seeds do not overlap: process g takes seeds `1 + 400·g .. 400·(g+1)`.
- Failed seeds are printed in the summary together with the command `cargo run --release --manifest-path sync/Cargo.toml -p amby-sync-simrun -- <seed> 1 <mode>`; full logs with the trace are in the artifacts `sim-logs-<k>`. A failure of the test client's transport itself (`INFRA`) is printed separately and also turns the summary red.
- **Broken engines.** The `self-check` job runs `self_check` (all 12 deliberately broken mini-engines must be caught, the correct one must pass) from four starting seeds: 1, 100001, 200001, 300001 (`AMBY_SIM_SEED`); locally, with seed 300001 all 23 tests passed (109 s in `release`).
- A note about Linux: `simrun` waits for ports to be freed with the command `netstat -an -p tcp`, which is macOS syntax; on Linux it prints nothing and the wait does not trigger. This is safe: in the trial there was about one connection per scenario, and everything is bound by the CPU (key derivation), not by ports. `simrun` was not changed.

### What was checked locally

| Check                                                          | Result                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actionlint` 1.7.12                                            | no findings                                                                                                                                                   |
| Prettier on the new files                                      | clean                                                                                                                                                         |
| Mutations: same flags, shard `7/400`                           | 4 mutants: 3 caught, 1 survived (`engine/push.rs:180`, `+` → `*`); baseline run 6 s; ~5.5 min with the first build; the survivor ran the whole suite in 105 s |
| Mutations: shard `0/400` with both packages                    | 8 mutants: 6 caught, 2 unviable, 4 min                                                                                                                        |
| Mutations: `engine/rules.rs`, 23 mutants                       | all caught; on average 9 s build + 6 s tests per mutant (7 min); in `--release` 17 + 4 s                                                                      |
| Simulation: job step with 2 processes × 3 seeds                | 12 scenarios, all passed, 15 s                                                                                                                                |
| Simulation speed                                               | about 2–3 s per scenario on this Mac (with other load present)                                                                                                |
| Summary script on real output and on an artificial failed seed | reports correct; exit code 1 if a shard is missing                                                                                                            |

The machine was busy with other sessions at the time, so the timings are approximate.

### Time estimate on GitHub

Runners of a public repository have 4 cores. Up to 20 jobs run at once, so the two big groups share the queue.

| Group          |   Jobs | One runner                              | Note                                                                                                         |
| -------------- | -----: | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Mutations      |     20 | 1–1.5 h (large margin to the 6 h limit) | ~75 mutants: caught ones take 15–20 s each, survivors 2–4 min; plus 5 min for installation and build         |
| Simulation     |     20 | 0.7–1.2 h                               | 800 scenarios per process at 2–3 s each                                                                      |
| Broken engines |      4 | 5–10 min                                |                                                                                                              |
| Summary        |      1 | 1 min                                   |                                                                                                              |
| **Total**      | **45** |                                         | **Wall-clock time roughly 2–3 h** (all 40 big jobs do not fit into 20 concurrent ones, they go in two waves) |

This is an estimate from local figures, not a measurement on GitHub: the first real run will show the runner time. If some mutation shard does not fit, the number of shards and `MUTANT_SHARDS` change in one place of the file (together with the `matrix.shard` list).

### What remains

1. After review, the coordinator pushes the branch: `git push origin HEAD:gates/run` — this will be a trial run on the current code.
2. The real run — after appendix Е (plans) is merged: the gates are not closed by a run after which the engine code changed.
3. Surviving mutants are analyzed by a human (the rule is written in `docs/sync-plan.md`): either a test that is red on the mutant, or a note on why the mutant is equivalent.
4. Known equivalent mutants from Э3: `stream.rs:140` (`-=` → `/=`) and `stream.rs:157` (`<` → `<=`); `stream.rs:161` (`Interrupted`) is a real hole, and in Э4 there is a test for it, `engine_stream_interrupted.rs`.

---

## Part 2. Sync: analysis of the second gate run

_Formerly the file `sync-gates-second-report.md`, merged 2026-11-03._

Basis: [GitHub Actions 40203799332](https://github.com/MrDarkOm/amby-notes/actions/runs/40203799332),
code `f8cc8c14cb9d8d8a60868c373139f42e55697aa5`. This is an analysis of the result, not permission
to sync real notes. The historical results below are preserved;
the final outcome is in the next section.

### Final outcome, 27 October

[Run 40383686825](https://github.com/MrDarkOm/amby-notes/actions/runs/40383686825),
commit `9a7b22490479e6b2c42abbaf6b7e6029ee90ce36`, finished successfully after a targeted
rerun of the only interrupted shard no. 18 (the runner received a shutdown during the build).
The full set was not rerun for this targeted restart.

- All 64,000 scenarios passed: 0 errors and 0 INFRA; the simulator self-checks passed.
- 64/64 mutation shards were received: 1376 caught, 50 survived, 159 do not build,
  0 timeouts, 0 unknown outcomes; 1585 mutations in total.
- All 50 survivors are matched with explanations: 49 from the table of equivalents below,
  plus the new filter `push.rs:714` (rationale in the section on the rerun at `20fff98`).
  After the targeted rerun the list of survivors did not change.
- The owner confirmed the result and the continuation to the backup and to lifting the restriction
  in this chat on 27 October. Do not start new full runs without their agreement.

The next stage is implemented in the app: an external verified copy before the first
pass and before resuming old enabled vaults without a receipt; the path and the
restore instructions are visible in settings. The contract is
[vault-format.md](../vault-format.md#backup-and-git-policy). The `sync/core` kernel
did not change after the final run.

### Run result

#### Rerun at `20fff98` (26 October)

[Run 40281140178](https://github.com/MrDarkOm/amby-notes/actions/runs/40281140178)
completed all 64,000 scenarios without errors and INFRA; the simulator self-checks passed.
Mutations returned 62 of 64 shards: 1335 caught, 45 survived, 155 do not build,
no timeouts. Shards 30 and 31 were interrupted by a runner shutdown, including during a rerun
of the failed jobs (attempt 2). The gates remain incomplete.

Both shards contain a mutation of `util::parent` that returns a constant `Some("")`
or `Some("xyzzy")`. In `ancestors` this causes an infinite loop with a growing `Vec`.
This explains a possible memory exhaustion, but the runner log does not prove the cause
of the shutdown. A direct unit test `parent_stops_at_the_root_and_removes_one_component` was added:
it checks that the traversal ends and that exactly one component is removed, it runs in the core lib
before the integration scenarios and does not call `ancestors` on a broken `parent`.
Local cargo-mutants 27.1.0: baseline green, both mutations caught, no timeouts
(2 mutants in 17 seconds). The working engine code and the frozen tests did not change.

The new surviving variant `push.rs:714`, replacing `&&` with `||` in the filter
`!base.deleted && base.body_id.is_some()`, is equivalent for a valid state:
`check_header` requires a body for a live file and no body for a deleted object.
In these two cases both conditions coincide. A live folder has no body, but it cannot
be the base of a sent file with the same ID (`check_kind_unchanged`); changes without
a body are discarded before this filter. For a new file with no entry in `state.items`
both variants leave `old_size = 0`. The remaining surviving variants require reconciliation
with the earlier table after all 64 shards are received; an incomplete result does not close the gates.

The local check of the app after the merge once failed by timeout in
`sync::runtime_tests::the_renames_of_amby_reach_the_next_pass`; a separate rerun
also failed. The previous full run and a temporary separate diagnostic scenario
passed. A possible race in the test setup: `enable` already starts a pass,
the subsequent `sync_now` may queue the next one, and waiting for the first
upload to become visible on the server does not mean all passes have finished.
The rename and the writing of the hint happen after this wait, while the pass may have already taken an empty
list of hints. In the app commands the hint is written before the files change;
the test does it afterwards. This is a hypothesis, not a proven fix:
the original test and the app code were not changed, the temporary diagnostic test was deleted.
The next full rerun without a parallel heavy simulation passed: 2829 frontend tests
and 1044 app tests, including this one; `npm run verify` and the build
are green. The whole sync workspace in release: 1087 passed tests, 2 ignored.
Strict Clippy of the kernel and the documentation check also passed.

Below are preserved the results of the original run `f8cc8c1`.

- Simulation: 63,998 successful scenarios out of 64,000. Seed `23390` failed in both modes
  (`quick`, `folders`) with `Unexpected: device 1: the pass ended with Busy` at step 19.
- The simulator self-check on four starting seeds passed.
- Mutations: 62 of 64 shards returned results: 1272 caught, 108 survived, 150 do not build,
  no timeouts. Shards 25 and 26 were interrupted by a runner shutdown; artifacts from them are missing.
  The partial log of shard 26 contains two more surviving mutants (`decide.rs:80:55` and
  `sync.rs:423:59`) that are not among the 108 of the summary.
- The gate outcome is not passed. An incomplete summary cannot be considered final proof.

### Seed 23390: a classifier bug

After crashes and renames, two live entries temporarily referred to
`Ideas/Deep/AMBYSIM-6.md`. When the file disappeared, `classify` put the missing entries into
a table by path; one entry displaced another. For the displaced identifier the class
was absent altogether. The decision took the absence of a class for `Same`, did not find the file, and
skipped the entry without holding the cursor. Subsequent passes no longer saw the skipped
server version 3 and again tried to send an edit with base 2: the server invariably
returned a conflict, and after five attempts the engine answered `Busy`.

In a separate commit, two red tests `gates_regressions.rs` were added first:
the original unchanged scenario `23390` in both modes. Both failed for the original reason.
The fix completes the classification over **all live entries**, keeping the classes
already found and assigning `Deleted` only to the missing ones. This does not change the state format,
the merge rules, or the thresholds of the protections. After the fix both tests are green.

Additionally, seeds `23301..23400` were checked locally in both modes: 200 successful
scenarios, with no failures and no transport retries. This does not replace a new full run of the gates.

### Д75: changes without a size increase in a mixed commit

Targeted checks revealed one more defect: `Out.blob.is_some()` means
that the entry has a body, but does not mean an increase in the space used. A rename
carries the previous body, a shrink carries a new body of smaller size. After `507` the previous
split classified both cases as growth and held them back together with the new upload.

A separate commit added the red tests `quota_rename_regression.rs`. The fix
compares the encrypted size of the new version with the size of the live database, like the server
rule П56-в: only a positive increase counts as growth. The part with no increase in size
is sent first; the unfinished record is kept for the pending part.
The `NoRoom` result carries over exactly the pending changes, so that a rename that was already
sent does not end up in the `QuotaFull` list.

After the fix both tests are green. The wrong expectation of the old version in the
shrinking test was corrected in a separate commit `70cc540` with the owner's explicit consent
on 26 October; the other checks of that frozen test were kept.

A separate red test `quota_split_safety.rs` reproduced the overwriting of an unfinished
part: two items may reference the same body, so shrinking one item
does not always reduce the total size. The server may also reject a part that the forecast
considered non-growing. Previously the result of its repeated `commit` was ignored, and the next
part replaced the record of the unfinished upload. Now the rejection is returned to the caller
code; the pending commit is not overwritten. This test is green after the fix.

### Д13: the record of a folder that used to be empty

The mutant `classify.rs:179` turned out not to be equivalent. A folder that was synced empty
keeps its record once files appear in it. When recognizing a move, `old` contained
this record, but `now` accounted only for new empty directories. The record of the now
non-empty folder did not take part in the comparison, and the move was not recognized.

A separate commit added a red `classify_survivor.rs`: the original folder ID
must be preserved after a move together with its files. The fix accounts for the
corresponding directory records when comparing trees. The test, the existing folder
scenarios and the previous classifier checks are green after the fix.

### Surviving mutations

The line numbers below refer to the code of run `f8cc8c1`, not to later line shifts.
The cryptography, `conflict_set`, `merge` and `stream` have not changed since the trial run:
verified by comparing `eab5655..f8cc8c1`. The justifications from the earlier
[analysis](sync.md#equivalent-mutants) are kept for the same
exact replacements, not automatically for any mutant on the same line.

#### Kept justifications (28)

- `crypto/header.rs:154:9`: replacing `||` with `&&` does not let through a path with a leading/trailing `/`:
  the next check for empty segments still returns `InvalidPath`.
- `crypto/header.rs:194:40`, `conflict_set.rs:226:40`: `|` and `^` are equal for non-overlapping
  high and low nibbles.
- `crypto/header.rs:281:9`: `expecting` writes only the description of a serde error; in `decode_header_json`
  this error is converted into a fixed `BAD` regardless of the text.
- `crypto/header.rs:305:9`, `309:9`, `313:9`: the JSON slice parser does not use
  `visit_string`/`visit_none`; `visit_unit` and `Value::default()` return `Null`.
- `crypto/padme.rs:17:12`: for length 2 both branches give 2.
- `crypto/recovery_code.rs:30:52`, `42:44`, `42:72`, `133:46`: the combined bits do not
  overlap, `|` and `^` are equal. `135:40`: after 32 bytes 4 bits remain, so the outer
  guard `bits >= 8` rules out writing a 33rd byte even when `<` is replaced with `<=`.
- `merge.rs:112:9`: at the checked position after a last line without `\n`, only an insertion is possible.
- `merge.rs:172:69`: on a mismatch, the LCS table rule makes the changed comparison
  equivalent to the original.
- `merge.rs:244:17`, `246:21`, `257:18`, `257:22`, `262:19`, `274:27`, `278:18`, `278:22`:
  single-line spots do not extend edits, a closing fence does not continue a block,
  multiplying by 1 and computing the boundary give the same result (exact reasons in the earlier analysis).
- `merge.rs:310:32` (three replacements: `>` with `<`, `==`, `>=`): both sides are extended to the same
  spot; `341:33`: the subtracted boundaries are equal, the added/subtracted amount is zero.
- `stream.rs:140:16`: in this branch `filled == SEALED_CHUNK_LEN + 1`, so subtraction and
  integer division leave the same single byte.

### How the strength of the new tests was verified

The mutations from the artifacts were applied one after another to the source code via the exact diffs,
and each time the file was restored in `finally`. The release target was run with the new
targeted test: the normal code must pass, and the mutant must fail on an assertion,
not on the build. The earlier frozen tests were not weakened. In the new helper
functions only the redundant `clone()` calls on `Copy` types were removed and Rustfmt was applied.

Checked: the quota boundaries, repeated `413`/`507`/`UNKNOWN_BLOB`, preservation of unrelated
unfinished uploads, content changing after an interruption, exact quota filling,
the source of an equal limit, independent errors of several records, and the range of
supported protocol versions. The original tests were not replaced by server stubs:
where a rare sequence of rejections is needed, it is set up through the public `Remote`.

Two mutants from the incomplete log of part 26 were checked separately: `sync.rs:423:59`
is caught by `read_only_survivor` (two remembered new formats on the next pass),
`decide.rs:80:55` by `known_server_conflict_survivor` (an already known server copy
outside the current feed, deleted locally before a new conflict).

The final table of exact replacements is given at the end of the report. Five earlier justifications
turned out to be insufficient and were re-checked: the two `scan.rs:67` differ on a deleted
zero-size base and an unreadable empty file; `apply.rs:707` on a damaged base/meta
of an already existing set; `push.rs:661` on tombstone cleanup between the feed and the commit;
`sync.rs:318` on a change of deleted for a folder of the same version without a change of hash/body.
All five were caught by the new tests.

### Unchanged restrictions

When an already saved commit is retried, `507` under Д76/Д7 still holds it whole;
later batches do not replace this record. Extending the splitting to such a retry is
a separate contract change, and it was not made in this edit. The new splitting applies
to the first reliably rejected mixed batch and protects the saved record when a part
is rejected again.

Two interrupted GitHub jobs do not count as successful. After the engine change a
new **full** gate run is needed; a partial rerun of the old code does not replace it.
Pushing/running the gates is subject to the owner's permission; lifting the restriction on real vaults is
only after they confirm the new full results and a backup has been prepared.

### Full list of 108 surviving replacements

Locally: **56 caught by tests, 49 equivalent, 3 replaced by an algorithm fix**.
Each row corresponds to a specific mutant name from the run's `outcomes.json`; identical
coordinates with different operators are not merged. "Caught" means an assertion failure in the new
release test on the exact diff of the mutant with green original code. Line numbers are from `f8cc8c1`.

| Location                         | Replacement                                                                                                 | Outcome    | Check / reason                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto/header.rs:154:9`         | replace \|\| with &&                                                                                        | Equivalent | An empty split segment rejects the same absolute/trailing-slash paths.                                                                                      |
| `crypto/header.rs:194:40`        | replace \| with ^                                                                                           | Equivalent | The high and low nibbles do not overlap: OR = XOR.                                                                                                          |
| `crypto/header.rs:281:9`         | replace <impl Visitor<'de> for StrictVisitor>::expecting -> fmt::Result with Ok(Default::default())         | Equivalent | The expecting text never leaves: any serde error is converted to a fixed BAD.                                                                               |
| `crypto/header.rs:305:9`         | replace <impl Visitor<'de> for StrictVisitor>::visit_string -> Result<Value, E> with Ok(Default::default()) | Equivalent | The slice JSON parser does not call visit_string.                                                                                                           |
| `crypto/header.rs:309:9`         | replace <impl Visitor<'de> for StrictVisitor>::visit_none -> Result<Value, E> with Ok(Default::default())   | Equivalent | JSON null calls visit_unit, not visit_none.                                                                                                                 |
| `crypto/header.rs:313:9`         | replace <impl Visitor<'de> for StrictVisitor>::visit_unit -> Result<Value, E> with Ok(Default::default())   | Equivalent | Value::default() and the original visit_unit both return Null.                                                                                              |
| `crypto/padme.rs:17:12`          | replace < with <=                                                                                           | Equivalent | With len=2, exponent=1 and mask=0; both branches return 2.                                                                                                  |
| `crypto/recovery_code.rs:30:52`  | replace \| with ^                                                                                           | Equivalent | The combined bit ranges do not overlap: OR = XOR.                                                                                                           |
| `crypto/recovery_code.rs:42:44`  | replace \| with ^                                                                                           | Equivalent | The combined bit ranges do not overlap: OR = XOR.                                                                                                           |
| `crypto/recovery_code.rs:42:72`  | replace \| with ^                                                                                           | Equivalent | The combined bit ranges do not overlap: OR = XOR.                                                                                                           |
| `crypto/recovery_code.rs:133:46` | replace \| with ^                                                                                           | Equivalent | The combined bit ranges do not overlap: OR = XOR.                                                                                                           |
| `crypto/recovery_code.rs:135:40` | replace < with <=                                                                                           | Equivalent | After 32 bytes, 4 bits remain; bits>=8 rules out the 33rd byte.                                                                                             |
| `engine/apply.rs:170:36`         | replace && with \|\|                                                                                        | Caught     | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `three_independent_swaps_do_not_break_a_cycle_after_the_last_round`                   |
| `engine/apply.rs:170:45`         | replace < with <=                                                                                           | Caught     | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `three_independent_swaps_do_not_break_a_cycle_after_the_last_round`                   |
| `engine/apply.rs:298:58`         | replace == with !=                                                                                          | Caught     | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `an_acyclic_rename_chain_never_uses_a_swap_name`                                      |
| `engine/apply.rs:299:35`         | replace match guard next == index with true                                                                 | Caught     | [apply_chain_survivors](../../sync/sim/tests/apply_chain_survivors.rs): `three_rename_chain_does_not_break_a_false_cycle`                                   |
| `engine/apply.rs:299:40`         | replace == with !=                                                                                          | Caught     | [apply_chain_survivors](../../sync/sim/tests/apply_chain_survivors.rs): `three_rename_chain_does_not_break_a_false_cycle`                                   |
| `engine/apply.rs:303:23`         | replace += with *=                                                                                          | Equivalent | With a valid move graph, a chain ends and a cycle returns to index before the guard counter is reached.                                                     |
| `engine/apply.rs:304:26`         | replace > with ==                                                                                           | Equivalent | With a valid move graph, a chain ends and a cycle returns to index before the guard counter is reached.                                                     |
| `engine/apply.rs:304:26`         | replace > with >=                                                                                           | Equivalent | With a valid move graph, a chain ends and a cycle returns to index before the guard counter is reached.                                                     |
| `engine/apply.rs:452:55`         | replace && with \|\|                                                                                        | Caught     | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `a_renamed_md_to_txt_with_two_edits_is_not_merged`                                    |
| `engine/apply.rs:459:31`         | replace && with \|\|                                                                                        | Caught     | [apply_gate_survivors](../../sync/sim/tests/apply_gate_survivors.rs): `a_renamed_md_to_txt_with_two_edits_is_not_merged`                                    |
| `engine/apply.rs:707:29`         | replace match guard existing == bytes with true                                                             | Caught     | [conflict_set_repair_survivor](../../sync/sim/tests/conflict_set_repair_survivor.rs): `a_matching_other_file_does_not_hide_a_damaged_base_or_metadata`      |
| `engine/classify.rs:120:24`      | replace == with !=                                                                                          | Equivalent | A candidate containing a file is already added via its ancestors; an empty folder without a probe hash is not matched.                                      |
| `engine/classify.rs:162:37`      | replace && with \|\|                                                                                        | Equivalent | root is non-empty and not the old path; the fixed suffix and unique paths do not produce a repeated root.                                                   |
| `engine/classify.rs:162:52`      | replace && with \|\|                                                                                        | Equivalent | root is non-empty and not the old path; the fixed suffix and unique paths do not produce a repeated root.                                                   |
| `engine/classify.rs:179:33`      | replace == with !=                                                                                          | Replaced   | The condition was replaced; red `classify_survivor` / `classify_owned_target` turn green.                                                                   |
| `engine/conflict_set.rs:226:40`  | replace \| with ^                                                                                           | Equivalent | The high and low nibbles do not overlap: OR = XOR.                                                                                                          |
| `engine/decide.rs:109:37`        | replace > with >=                                                                                           | Equivalent | An equal version cannot change path/deleted: the rollback check fires first.                                                                                |
| `engine/decide.rs:335:9`         | replace Decider<'a>::no_copy_name with ()                                                                   | Caught     | [core_survivors](../../sync/sim/tests/core_survivors.rs): `decide_reports_when_every_conflict_copy_name_is_unavailable`                                     |
| `engine/decide.rs:395:49`        | replace > with >=                                                                                           | Equivalent | Equal item IDs are ruled out by the preceding condition other.item_id != srv.item.                                                                          |
| `engine/decide.rs:540:44`        | replace > with >=                                                                                           | Equivalent | Equal item IDs are ruled out by the preceding condition other.item_id != srv.item.                                                                          |
| `engine/decide.rs:559:44`        | replace < with <=                                                                                           | Equivalent | Equal item IDs are ruled out by the preceding condition other.item_id != srv.item.                                                                          |
| `engine/decide.rs:959:23`        | replace == with !=                                                                                          | Equivalent | The condition body contains only a comment, no actions.                                                                                                     |
| `engine/decide.rs:1001:13`       | delete match arm Lc::Deleted                                                                                | Equivalent | The arm is replaced by the same set_base; touched affects outgoing file deletions, not folders.                                                             |
| `engine/decide.rs:1006:25`       | replace match guard renamed with true                                                                       | Equivalent | create_dir on an existing Same folder is idempotent; cleanup does not delete a live folder.                                                                 |
| `engine/merge.rs:112:9`          | replace Hunk<'_>::is_insertion -> bool with true                                                            | Equivalent | After a last line without LF, only an insertion is possible at the compared position.                                                                       |
| `engine/merge.rs:172:69`         | replace + with *                                                                                            | Equivalent | LCS mismatch branch: T[i][j]=max(T[i+1][j],T[i][j+1]); the comparisons are equal.                                                                           |
| `engine/merge.rs:244:17`         | replace < with <=                                                                                           | Equivalent | A single-line spot does not extend the edit; a closing fence does not continue the block.                                                                   |
| `engine/merge.rs:246:21`         | replace < with <=                                                                                           | Equivalent | A single-line spot does not extend the edit; a closing fence does not continue the block.                                                                   |
| `engine/merge.rs:257:18`         | replace - with +                                                                                            | Equivalent | The boundary of a single-line spot coincides with its start: the changed extension does not alter the range.                                                |
| `engine/merge.rs:257:22`         | replace > with >=                                                                                           | Equivalent | The boundary of a single-line spot coincides with its start: the changed extension does not alter the range.                                                |
| `engine/merge.rs:262:19`         | replace + with *                                                                                            | Equivalent | The closing YAML --- line is additionally scanned; it creates no spot, and then i matches.                                                                  |
| `engine/merge.rs:274:27`         | replace + with *                                                                                            | Equivalent | The end is computed from the original i and includes its line; both formulas give the same end.                                                             |
| `engine/merge.rs:278:18`         | replace - with +                                                                                            | Equivalent | The boundary of a single-line spot coincides with its start: the changed extension does not alter the range.                                                |
| `engine/merge.rs:278:22`         | replace > with >=                                                                                           | Equivalent | The boundary of a single-line spot coincides with its start: the changed extension does not alter the range.                                                |
| `engine/merge.rs:310:32`         | replace > with <                                                                                            | Equivalent | Both sides extend to the same spot; the changed branch gives the same boundaries.                                                                           |
| `engine/merge.rs:310:32`         | replace > with ==                                                                                           | Equivalent | Both sides extend to the same spot; the changed branch gives the same boundaries.                                                                           |
| `engine/merge.rs:310:32`         | replace > with >=                                                                                           | Equivalent | Both sides extend to the same spot; the changed branch gives the same boundaries.                                                                           |
| `engine/merge.rs:341:33`         | replace + with -                                                                                            | Equivalent | last.be == h.be: the added/subtracted difference is zero.                                                                                                   |
| `engine/push.rs:64:31`           | replace \|\| with &&                                                                                        | Equivalent | Deleted/unmaterialised entries do not have class Same; a Same folder is not a scan.files file.                                                              |
| `engine/push.rs:64:64`           | replace \|\| with &&                                                                                        | Equivalent | Deleted/unmaterialised entries do not have class Same; a Same folder is not a scan.files file.                                                              |
| `engine/push.rs:97:17`           | delete match arm (_, Lc::Same \| Lc::Blocked)                                                               | Equivalent | The lower arm _=>{} performs the same no-op.                                                                                                                |
| `engine/push.rs:233:57`          | replace && with \|\|                                                                                        | Caught     | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `push_does_not_skip_a_same_size_different_content_file`                                   |
| `engine/push.rs:460:33`          | replace > with <                                                                                            | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_replacing_a_body_credits_its_current_sealed_size`                                         |
| `engine/push.rs:460:33`          | replace > with ==                                                                                           | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_replacing_a_body_credits_its_current_sealed_size`                                         |
| `engine/push.rs:460:33`          | replace > with >=                                                                                           | Equivalent | The only difference requires version=0 and body Some; a new record has body None, and the server version is >=1.                                            |
| `engine/push.rs:460:37`          | replace && with \|\|                                                                                        | Caught     | [undelete_credit_survivor](../../sync/sim/tests/undelete_credit_survivor.rs): `an_edited_file_undeleting_a_deleted_base_has_no_replace_credit`              |
| `engine/push.rs:462:17`          | delete match arm (Some(_), old)                                                                             | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_replacing_a_body_credits_its_current_sealed_size`                                         |
| `engine/push.rs:468:36`          | replace == with !=                                                                                          | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_resuming_an_exact_pending_upload_works_with_no_free_quota`                                |
| `engine/push.rs:468:54`          | replace && with \|\|                                                                                        | Caught     | [resume_survivors](../../sync/sim/tests/resume_survivors.rs): `changed_content_does_not_bypass_the_quota_resume_forecast`                                   |
| `engine/push.rs:468:72`          | replace == with !=                                                                                          | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_resuming_an_exact_pending_upload_works_with_no_free_quota`                                |
| `engine/push.rs:468:90`          | replace == with !=                                                                                          | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_resuming_an_exact_pending_upload_works_with_no_free_quota`                                |
| `engine/push.rs:472:31`          | replace > with >=                                                                                           | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_changed_content_waits_for_pending_quota_without_a_new_upload`                             |
| `engine/push.rs:492:31`          | replace == with !=                                                                                          | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_blob_start_413_does_not_set_quota_full`                                                 |
| `engine/push.rs:544:42`          | replace && with \|\|                                                                                        | Caught     | [resume_survivors](../../sync/sim/tests/resume_survivors.rs): `changed_content_of_an_existing_item_gets_a_new_pending_body`                                 |
| `engine/push.rs:595:64`          | replace match guard reason == code::QUOTA_EXCEEDED with true                                                | Caught     | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `push_does_not_turn_a_non_quota_blob_rejection_into_quota_full`                           |
| `engine/push.rs:658:74`          | replace > with <                                                                                            | Caught     | [expired_commit_survivors](../../sync/sim/tests/expired_commit_survivors.rs): `an_undelete_survives_cleanup_between_feed_and_commit`                        |
| `engine/push.rs:658:74`          | replace > with ==                                                                                           | Caught     | [expired_commit_survivors](../../sync/sim/tests/expired_commit_survivors.rs): `an_undelete_survives_cleanup_between_feed_and_commit`                        |
| `engine/push.rs:658:74`          | replace > with >=                                                                                           | Equivalent | A current_version=0/base_version=0 conflict is impossible: a missing item with base 0 is created.                                                           |
| `engine/push.rs:661:20`          | delete !                                                                                                    | Caught     | [expired_commit_survivors](../../sync/sim/tests/expired_commit_survivors.rs): `an_undelete_survives_cleanup_between_feed_and_commit`                        |
| `engine/push.rs:674:32`          | replace < with <=                                                                                           | Caught     | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_commit_413_at_the_server_ceiling_keeps_server_as_the_limit_source`                     |
| `engine/push.rs:674:32`          | replace < with ==                                                                                           | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_413_does_not_mark_a_folder_as_too_large`                                                |
| `engine/push.rs:674:32`          | replace < with >                                                                                            | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_413_does_not_mark_a_folder_as_too_large`                                                |
| `engine/push.rs:687:64`          | replace match guard reason == code::UNKNOWN_BLOB with false                                                 | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_with_a_missing_body_is_rebuilt`                                                  |
| `engine/push.rs:691:61`          | replace == with !=                                                                                          | Caught     | [unknown_blob_current_survivor](../../sync/sim/tests/unknown_blob_current_survivor.rs): `current_commit_unknown_blob_keeps_other_chunk_upload_during_retry` |
| `engine/push.rs:699:64`          | replace match guard reason == code::QUOTA_EXCEEDED with true                                                | Caught     | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_pending_commit_with_a_non_quota_rejection_is_kept_unchanged`                           |
| `engine/push.rs:706:57`          | replace && with \|\|                                                                                        | Replaced   | The growth-based split replaced the blob predicate; red `quota_rename_regression` and `quota_split_safety` turn green.                                      |
| `engine/push.rs:706:60`          | delete !                                                                                                    | Replaced   | The growth-based split replaced the blob predicate; red `quota_rename_regression` and `quota_split_safety` turn green.                                      |
| `engine/push.rs:750:42`          | replace && with \|\|                                                                                        | Caught     | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_commit_413_at_the_server_ceiling_keeps_server_as_the_limit_source`                     |
| `engine/push.rs:762:5`           | replace mark_too_large with ()                                                                              | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_413_does_not_mark_a_folder_as_too_large`                                                |
| `engine/push.rs:767:42`          | replace && with \|\|                                                                                        | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_413_does_not_mark_a_folder_as_too_large`                                                |
| `engine/push.rs:767:45`          | delete !                                                                                                    | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_413_report_marks_only_bodies_over_the_new_limit`                                 |
| `engine/push.rs:768:79`          | replace > with <                                                                                            | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_413_report_marks_only_bodies_over_the_new_limit`                                 |
| `engine/push.rs:768:79`          | replace > with ==                                                                                           | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_413_report_marks_only_bodies_over_the_new_limit`                                 |
| `engine/push.rs:768:79`          | replace > with >=                                                                                           | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_commit_413_report_marks_only_bodies_over_the_new_limit`                                 |
| `engine/scan.rs:67:32`           | replace && with \|\|                                                                                        | Caught     | [deleted_scan_survivors](../../sync/sim/tests/deleted_scan_survivors.rs): `a_deleted_zero_size_base_does_not_make_a_new_oversized_file_readable`            |
| `engine/scan.rs:67:60`           | replace && with \|\|                                                                                        | Caught     | [deleted_scan_survivors](../../sync/sim/tests/deleted_scan_survivors.rs): `a_deleted_zero_size_base_does_not_make_a_new_oversized_file_readable`            |
| `engine/scan.rs:76:16`           | delete !                                                                                                    | Equivalent | A recursive listing includes directories: every non-empty directory is marked by its direct child.                                                          |
| `engine/scan.rs:93:29`           | delete !                                                                                                    | Caught     | [core_survivors](../../sync/sim/tests/core_survivors.rs): `scan_does_not_read_a_new_oversized_file_just_because_a_listed_file_has_its_size`                 |
| `engine/scan.rs:146:24`          | delete !                                                                                                    | Caught     | [core_survivors](../../sync/sim/tests/core_survivors.rs): `scan_does_not_read_a_new_oversized_file_just_because_a_listed_file_has_its_size`                 |
| `engine/stream.rs:140:16`        | replace -= with /=                                                                                          | Equivalent | filled=N+1 and N=SEALED_CHUNK_LEN: (N+1)-N=(N+1)/N=1.                                                                                                       |
| `engine/sync.rs:170:55`          | replace < with >                                                                                            | Caught     | [protocol_version_survivor](../../sync/sim/tests/protocol_version_survivor.rs): `a_server_supporting_versions_one_through_two_accepts_this_client`          |
| `engine/sync.rs:254:24`          | replace match guard reason == code::BLOB_TOO_LARGE with false                                               | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_rechecks_a_tightened_file_limit`                                         |
| `engine/sync.rs:254:24`          | replace match guard reason == code::BLOB_TOO_LARGE with true                                                | Caught     | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_pending_commit_with_a_non_quota_rejection_is_kept_unchanged`                           |
| `engine/sync.rs:254:31`          | replace == with !=                                                                                          | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_rechecks_a_tightened_file_limit`                                         |
| `engine/sync.rs:261:68`          | replace match guard reason == code::UNKNOWN_BLOB with true                                                  | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:261:75`          | replace == with !=                                                                                          | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_with_a_missing_body_is_rebuilt`                                          |
| `engine/sync.rs:267:54`          | replace == with !=                                                                                          | Caught     | [unknown_blob_survivors](../../sync/sim/tests/unknown_blob_survivors.rs): `pending_unknown_blob_preserves_an_unrelated_completed_upload`                    |
| `engine/sync.rs:275:24`          | replace match guard reason == code::QUOTA_EXCEEDED with false                                               | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:275:24`          | replace match guard reason == code::QUOTA_EXCEEDED with true                                                | Caught     | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `a_pending_commit_with_a_non_quota_rejection_is_kept_unchanged`                           |
| `engine/sync.rs:275:31`          | replace == with !=                                                                                          | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:281:42`          | delete !                                                                                                    | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:281:58`          | replace && with \|\|                                                                                        | Caught     | [limits_survivors](../../sync/sim/tests/limits_survivors.rs): `ls_a_pending_commit_keeps_507_and_reports_only_files`                                        |
| `engine/sync.rs:318:21`          | replace \|\| with &&                                                                                        | Caught     | [folder_rollback_survivor](../../sync/sim/tests/folder_rollback_survivor.rs): `a_same_version_folder_with_changed_deleted_flag_stops_before_writes`         |
| `engine/sync.rs:404:56`          | replace == with !=                                                                                          | Caught     | [protocol_survivors](../../sync/sim/tests/protocol_survivors.rs): `ps_feed_reports_multiple_corrupt_items`                                                  |
| `engine/sync.rs:559:17`          | replace \|\| with &&                                                                                        | Equivalent | The preliminary edited allows only a live materialised file; these guards are already false.                                                                |
| `engine/sync.rs:560:17`          | replace \|\| with &&                                                                                        | Equivalent | The preliminary edited allows only a live materialised file; these guards are already false.                                                                |

---

## Part 3. Sync gates: analysis of surviving mutants and the mini-engine failure

_Formerly the file `sync-gates-survivors-report.md`, merged on 2026-11-03._

Date: 25 October 2026. Branch `claude/priceless-turing-155156` (from the local `dev`, commits are local only). Basis: the trial gate run `40105164912` (code `eab5655`, before the plans): 202 surviving mutants (MISSED) and 19 timeouts (TIMEOUT) in `sync/core`. The list was analyzed line by line against the **current** `dev`: `apply.rs`, `classify.rs`, `decide.rs`, `merge.rs`, `feed.rs`, `stream.rs`, `util.rs` and the encryption have not changed since `eab5655`; the lines in `push.rs`, `scan.rs`, `sync.rs` shifted because of the plans and were matched by text.

**The engine code was not changed** (only tests and test tooling: `sim/src/mini.rs`, `sim/src/vfs.rs`). Nothing was pushed, no versions or tags.

### Summary

|                           | Mutants |
| ------------------------- | ------- |
| Killed by a new test      | **166** |
| Equivalent (reason below) | **52**  |
| Unresolved                | **3**   |
| Total (202 + 19)          | 221     |

All 19 timeouts were killed (verified by a rerun: no timeouts at all). Unresolved: two `apply.rs:170` mutants (tied to the engine bug found, see below) and `decide.rs:80:55`.

**A real engine bug was found** (section "Engine bug"): swapping the names of two files together with an independent rename of a third is not accepted completely. The test for it is red, so it is marked `#[ignore]`; a message was sent to the coordinator, this is stop point No. 4 from the brief.

### How it was verified

Each mutant was checked with `cargo mutants` on a small sample (`--re` by file and line), against the new tests only, with `CARGO_PROFILE_DEV_OPT_LEVEL=2`, as in `sync-gates.yml`. The full gate run was not started. To check mutants of the real engine, the simulation tests are wired in through stubs in `core/tests`, so that `cargo mutants` can pass `--test <name>` to both packages; the stubs are not committed.

What matters for the gates:

- **Timeouts.** A mutant that makes a loop infinite hangs the earlier tests too. The test that "kills" it must run before them and end with a failure: `cargo test` stops at the first failed test file. Therefore files with loop protection are named `a0_…` (they come first alphabetically) and limit the call time (`merge_text`, `open_body_stream`) with a thread and a wait; the feed read loop is limited by a request counter. Such files contain no test that could wait forever.
- The new engine tests are in `sim/tests/survivors_*.rs`, the tests of pure functions are in `core/tests/a0_merge_survivors.rs` and `a0_stream_survivors.rs`.

### Failure of the reference mini-engine (seed 200019)

`sim/tests/self_check.rs` `the_correct_mini_engine_passes_the_simulation` with `AMBY_SIM_SEED=200019`, step 13: "Protection: the vault folder is empty: the pass sent changes to the server (Р8)".

**This is a bug in the mini-engine, not a false positive of the invariant.** At steps 9–10 device 1's process died and the commit request "did not arrive": an unconfirmed commit was left in the state. At step 13 the vault folder is empty. The real engine (`sync.rs`, "Д55" and then "С2, Д7") first checks for an empty folder and stops without sending anything; the mini-engine first re-sent the unconfirmed commit (server head 5 → 6) and only then checked for an empty folder. The invariant Р8 ("a protection stop sends nothing") is correct. Fixed in `sim/src/mini.rs`: the empty-folder check now goes before re-sending the pending commit, as in the real engine. A full `self_check.rs` run (23 tests) and seed 200019 are green. The frozen tests were not changed.

### Engine bug (stop point No. 4)

`apply_plan` does three rounds of renames and breaks a cycle (`break_cycle`) only in a round with no progress. If the receiving device gets a "name swap" of two files (a↔b) together with an independent rename of a third (c→d) in one pass, round 0 makes progress (c→d), the cycle is broken only in round 1, and three rounds are not enough: the file stays under the service name `b.md.amby-swap-0`, and the very next step of the pass (`push`) sends this state to the server. Result: the names are swapped on all devices, including the one where the user made the swap. No content is lost. A pure swap and a cycle of three work (there are tests for them, green).

- Red test: `sim/tests/survivors_apply_decide.rs::sv_a_swap_of_two_names_with_an_independent_rename_is_finished` (`#[ignore]`; run with `cargo test --release -p amby-sync-sim --test survivors_apply_decide -- --ignored`).
- Reproduction and details: `side-session-notes/…/apply-swap-bug.md`.
- The mutants `apply.rs:170:36` and `170:49` (`&&` → `||` in the cycle-breaking condition) **cure** this case, so a test that is green on the real engine will not kill them. They stay "unresolved" until the engine is fixed; after the fix the red test will turn green and will close them too.
- A related observation, not a bug: a cycle of four or more files or two independent cycles in one pass leave some of the renames for the next pass (they will finish in it, no names are lost).

### Equivalent mutants

An equivalent mutant is one with no observable difference from the original code (or where the difference is impossible through the public interface).

#### Encryption and `conflict_set` (12)

- `crypto/header.rs:154:9` (`||` → `&&` in `check_path`): `starts_with('/') || ends_with('/')` is fully covered by the next check "empty segment after `split('/')`" — the same `InvalidPath`.
- `crypto/header.rs:194:40`, `engine/conflict_set.rs:226:40` (`|` → `^` when assembling a byte from two hexadecimal digits): `(a << 4) | b`, `b` ≤ 15, the bits do not overlap — `|` and `^` give the same result.
- `crypto/header.rs:305:9`, `309:9`, `313:9` (`visit_string`, `visit_none`, `visit_unit` → `Ok(Default::default())`): `serde_json::from_slice` never calls `visit_string` (only `visit_str`/`visit_borrowed_str`) and `visit_none` (`null` arrives in `visit_unit`); the result of `Default::default()` for `Value` is `Null`, so `visit_unit` does not change.
- `crypto/padme.rs:17:12` (`len < 2` → `<=`): for `len == 2` further on `exponent = 1`, `mask = 0`, and the answer is the same `2`.
- `crypto/recovery_code.rs:30:52`, `42:44`, `42:72`, `133:46` (`|` → `^`): the shifted values do not overlap in bits.
- `crypto/recovery_code.rs:135:40` (`written < bytes.len()` → `<=`): after 32 bytes, 4 bits (fewer than 8) remain in the accumulator, and the condition `bits >= 8` does not let it reach the 33rd byte.

#### `classify.rs` (3)

- `120:24` (`record.kind == Folder` → `!=` when picking candidate folders): a candidate is needed only if there is a file with a hash under it, and the folder's path is already added by that file's ancestors.
- `162:37`, `162:52` (`&&` → `||` in the condition `!root.is_empty() && root != dir && !found…`): `root` is never empty, and `root != dir` is always true (the path `dir + suffix` is the path of a missing record, not of a new file); there are no repeats because the paths are unique.

#### `stream.rs` (1), `scan.rs` (2)

- `stream.rs:140:16` (`filled -= SEALED_CHUNK_LEN` → `/=`): at this point `filled` always equals `SEALED_CHUNK_LEN + 1`, and `(N+1)/N == (N+1)-N == 1`.
- `scan.rs:66:32`, `66:60` (now `67:32`, `67:60`; `&&` → `||` in `by_path`): the extra records (deleted, folders) get only into the "this file is too large" check and into `missing_sizes`; they make a difference only for sizes smaller than the smallest body (45 bytes), and the resulting "Не синхронизируется" (Not synced) list comes out the same (the upload itself rejects such a file).

#### `sync.rs` (2), `push.rs` (2)

- `sync.rs:266:21` (now `318:21`, `||` → `&&` in `differs`): a difference only in `deleted` or only in `kind` is impossible for a reconciled record (it always differs in the hash as well), so both variants give the same `differs`.
- `sync.rs:470:17` (now `559:17`): in `load_bases` the condition "`kind != File` / `is_unmaterialised`" is cut off earlier by the class (folders and unmaterialised records are never "edited").
- `push.rs:62:64` (now `64:64`): for folders and unmaterialised records the class is not `Same`, and there is nothing to update.
- `push.rs:95:17` (now `97:17`, "delete the `(_, Same | Blocked)` arm"): the arm is replaced by `_ => {}` below.

#### `apply.rs` (9)

- `170:58` `<` → `<=`: in the last round without progress there is nothing left to break the cycle with.
- `298:58`, `299:35`, `299:40`, `303:23`, `304:26` (`==`, `>=`): the graph "rename → rename whose source is my target" consists of simple chains and cycles, so the guard counter `steps` is unreachable, and a "stuck chain without a cycle" is unreachable from user actions: a rename onto an occupied name looks to the engine like an edit and a deletion, not like a rename (verified).
- `459:31` (`&&` → `||` in `wants_base && local.len() <= MAX`): differs only in memory use (the server body is downloaded into memory in full before the merge); the files and the network are the same.
- `707:29` (`existing == bytes` → `true` in `put_file`): differs only when a conflict-set file already exists with different content — this does not happen with the same set identifier.

#### `decide.rs` (7)

- `109:37` (`>` → `>=` in `leaving`), `540:44` (`>` → `>=`), `559:44` (`<` → `<=`), `395:49` (`>` → `>=`): equal identifiers or versions are already ruled out by the previous condition.
- `959:23` (`==` → `!=` in `occupant`): inside the condition is an empty block (only a comment).
- `1001:13` (delete the `Lc::Deleted` arm in `known_folder`): the arm is replaced by `_ => set_base(...)`; `touched.remove` is needed only for files.
- `1006:25` (guard `renamed` → `true`): for a folder that was not renamed, `create_dir` on an existing folder does nothing (no event), and `cleanup` is protected by a live record.

#### `merge.rs` (14)

- `112:9` (`is_insertion` → `true`): compared with `b.bs == a.be`; if `a` closes the file (the last line without `\n`), then `a.be` is the end of the base, and only an insertion starts there.
- `172:69` (`j + 1` → `j * 1`): on a mismatch `T[i][j] = max(T[i+1][j], T[i][j+1])`, so `T[i+1][j] >= T[i][j]` is equivalent to the original.
- `244:17`, `246:21`, `257:18` (`-` → `+`), `257:22`, `262:19` (`+` → `*`), `274:27`, `278:18` (`-` → `+`), `278:22`: single-line "spots" do not extend any edit (an edit is either inside or outside), the closing `---` line is never a continuation, `close * 1 == close`, and `i + 1` in the table gives the same end (`e` starts at `i` and immediately counts line `i`).
- `310:32` (`>` → `<`, `==`, `>=`): for replacement edits the "insertion" branch and the "replacement" branch extend to the same spot, because the other side is extended to that same spot anyway; `>=` is equivalent to the original.
- `341:33` (`+` → `-`): `last.be - h.be` is always 0 here (spots are not nested).

### Unresolved (3)

- `apply.rs:170:36`, `170:49` — see "Engine bug".
- `decide.rs:80:55` (`delete !` in `server_live`): the difference is visible only with a live conflict-set record in a state whose file disappeared from disk in the same pass; no scenario from user actions could be found.

### What was added

| File                                   | Purpose                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/tests/a0_merge_survivors.rs`     | comparison boundaries, fences, tables, formulas, header keys, edit extension, merging with a second simple implementation of the comparison                           |
| `core/tests/a0_stream_survivors.rs`    | a source that always fails; an interrupted read; a read into a full buffer                                                                                            |
| `sim/tests/a0_survivors_feed_loop.rs`  | the feed is read once and ends (loop protection)                                                                                                                      |
| `sim/tests/survivors_feed_util.rs`     | a page damaged once; writing a new format; folder order                                                                                                               |
| `sim/tests/survivors_classify_scan.rs` | folder moves, empty folders, limits, two spellings of a name, disappearance of the vault folder                                                                       |
| `sim/tests/survivors_sync_push.rs`     | cursor and head, time and versions, report counters, uploads, order of commit parts, check before sending, merge bases, records of one version with different content |
| `sim/tests/survivors_apply_decide.rs`  | a file changed during the pass, name swap, conflict sets, paths of two records, renames made by the app                                                               |
| `sim/src/vfs.rs`                       | `set_list_not_found` — the listing fails with `NotFound` while the folder exists                                                                                      |
| `sim/src/mini.rs`                      | order of checks as in the real engine (seed 200019)                                                                                                                   |

Not verified: the full gate run on GitHub (the owner starts it); tests added after the last local `cargo mutants` run on the corresponding file were checked by hand by substituting a line (162:32, `170:58 ==`) or by a second run; for the other green tests the killed mutants are listed per the run results.

### A note on narrowing the work

After receiving the message, the coordinator asked not to touch `merge.rs` and the encryption (merging is protected by the rule "only lines of the three inputs, otherwise a conflict", the encryption was verified in Э1) and to record them as "deferred". By then they had already been analyzed: `merge.rs` — 48 killed and 14 equivalent, the encryption and `conflict_set` — 12 equivalent (sections above). Nothing was additionally deferred; no new work was done after the request. Everything is committed, nothing merged.

---

## Part 4. Found while analyzing the apply.rs:170 mutants (break_cycle / rename rounds)

_Formerly the file `apply-swap-bug.md`, merged on 2026-11-03._

Branch: claude/priceless-turing-155156. The engine code was NOT changed.

### Codex fix (25 October)

With the owner's permission the bug was reproduced by the ready-made test: on device 1 there remained
`S/a.md=AAA` and `S/b.md.amby-swap-0=BBB`. Only `#[ignore]` was removed from the test, the checks were not changed.
In `apply_plan` the breaking of a detected cycle no longer depends on the progress of independent
renames: it is checked after each of the first two rounds. The Д49 limit of three rounds
is kept; `break_cycle` still moves only a participant of the found cycle.
The test and all neighboring `survivors_apply_decide` scenarios passed: 39/39.
This fix does not replace the final gate run.

### What happens

The receiving device (d1) gets from the server a "name swap" of two files (a↔b) together with an independent
rename of a third file (c→d) in the same pass. `apply_plan` does 3 rounds of renames
(`for round in 0..3`) and breaks a cycle (`break_cycle`) only if there is NO progress in a round and round < 2.
The independent rename c→d gives "progress" in round 0, the cycle is broken only in round 1, and there is no room
left for the third round: the file stays under the service name `b.md.amby-swap-0`, and the very next step of the
pass (`push`) sends this state to the server as an ordinary one. As a result the names are swapped on ALL
devices, including the one where the user made the swap.

### Reproduction (devices d0, d1; on both S/a.md=AAA, S/b.md=BBB, S/c.md=CCC)

d0: a→tmp, pass; b→a, pass; tmp→b + c→d, pass. d1: one pass.
Expected on d1 (as on d0): S/a.md=BBB, S/b.md=AAA, S/d.md=CCC.
Got: S/a.md=AAA, S/b.md.amby-swap-0=BBB, S/d.md=CCC; after settle the same on d0 and on the server.
A pure swap without the third rename works correctly (a↔b in 3 rounds). A cycle of three (a→b→c→a) also.

### Data

Content is not lost (BBB lies in the file `b.md.amby-swap-0`), but the names are wrong everywhere and an
extra synced file with a service name appears.

### Test

`sim/tests/survivors_apply_decide.rs::sv_a_swap_with_an_independent_rename_...` — marked `#[ignore]`
(red on the current engine). Run: `cargo test --release -p amby-sync-sim --test survivors_apply_decide -- --ignored`.
