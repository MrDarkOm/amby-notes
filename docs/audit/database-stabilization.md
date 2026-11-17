# Independent audit of the Amby Notes database stabilization results

> **Status as of 2026-11-02:** partially outdated. R1 and R7 (migration rollback, legacy `ambd.json`) are resolved: the migration module was removed in commit `3efd792`. R2, R4, R6, R8 have not been re-checked against the current code.

## Re-check of fixes R1–R8

Re-check date: 2026-09-20. The new working version was checked after the Gemini fixes and after the first diagnostic patch was applied. **There are real fixes, but not all audit findings are closed. Acceptance of migration safety and of the whole plan has not yet been passed.**

The original eight regression tests now pass. Checks of neighbouring scenarios revealed eight failures: seven in Rust and one in a React hook. They were run in a separate copy of the sources; the production code of the current working copy was not changed during the audit.

### What was fixed and confirmed

- The three previously reproduced filter queries are fixed: `multiSelect`, Checkbox and Select. Their original tests pass.
- Reading the numeric result of a Formula as the input of the next Formula now works in the original scenario. Handling of other computed result types was added.
- Undo/Redo uses `db_members`, a check that paths belong to the active vault was added; `load_vault` clears the history. These changes are confirmed by the code and by the passing standard tests; a separate native acceptance of vault switching was not performed in this audit.
- Rollback now rejects a note changed after the migration **if the migration itself rewrote it**. In the original scenario the check passes.
- The actual hosts limit is now 16, and the response keeps the invalidation number recorded when the query was started. This is not enough to guarantee a repeated load — see R8 below.

### Current status of the findings

| Item | Status after fixes             | Reason                                                                                                                                                   |
| ---- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | Not closed, P1                 | Rollback still erases new edits in notes that were put into the backup but were not changed by the migration.                                            |
| R2   | Not fixed, P1                  | The durable batch/relations/undo protocol and recovery after a process interruption are still not wired in.                                              |
| R3   | Main stated defects fixed      | Path check, history clearing and table name are fixed; expected generation in the Undo/Redo IPC and native scenarios remain part of the full acceptance. |
| R4   | Not closed, P1                 | The Select name history exists only in memory and conflicts between properties; stable keys of ordinary properties are also not finished.                |
| R5   | Three reproduced defects fixed | This confirms specific queries, but not the whole ST-09: saved views, groupings, layouts and native paths require separate acceptance.                   |
| R6   | Partial, P2                    | The result depends on property order; a cycle with references by names is not diagnosed.                                                                 |
| R7   | Partial, P1/P2                 | Legacy `ambd.json` still requires migration; the new directory cleanup may delete files without a backup. Resume is not implemented.                     |
| R8   | Not closed, P2                 | A change during a running query does not trigger a repeated query after the old response.                                                                |

### R1: CAS does not check all restorable files

**Reproduction:** a note already contains `Status: In Progress`, so there is no need to carry the value over into it from the shard. The migration still copies the note into the backup. After the migration the user appends text. Rollback returns success and erases the appended text.

Cause: preflight includes all notes of the database in the backup, `post_migration_hashes` is formed only for `planned_writes`, and rollback restores all files from the backup. A missing hash is treated as permission to overwrite. Also, hashes are written to the on-disk journal only after the changes are made, which does not provide verifiable recovery if the process crashes between steps.

Sources: [migration.rs:287](../../src-tauri/src/database/migration.rs#L287), [migration.rs:555](../../src-tauri/src/database/migration.rs#L555), [migration.rs:706](../../src-tauri/src/database/migration.rs#L706).

**Needed:** plan the full set of restorable/deletable resources with expected states; do not restore files that the migration did not change unless necessary. Missing information in the journal must block an unsafe overwrite. The durable journal and expected revisions must be saved before files are changed. Also check deletion of a note after the migration, an incomplete journal and a partial rollback.

### R2: the report item was replaced by a different check

In the independent audit, R2 means recovery of multi-file operations after a failure. In the new Gemini report, the protection of a future manifest version is described under this number. The check of the future format passed even before these fixes and was explicitly marked in the original audit as successful, not as a defect.

`apply_value_batch` still keeps the original bytes in memory, writes files one by one and ignores errors of the compensating rollback. The journal/recovery functions remain disabled with `#[allow(dead_code)]`. A successful future-format test confirms neither crash recovery nor idempotent repetition of the operation after a restart.

Source: [mutations.rs:1625](../../src-tauri/src/database/mutations.rs#L1625), [mutations.rs:1693](../../src-tauri/src/database/mutations.rs#L1693).

**Needed:** close the original ST-04, using a durable journal before writing and verifiable recovery. Test forced interruption between every step, rollback errors and repetition of an operationId after a fresh start. Such process interruptions were not performed in the current audit; the absence of a wired-in protocol was established from the code.

### R4: the global name history does not provide durable storage

`OPTION_NAME_HISTORY: HashMap<String, String>` was added, keyed only by the option name. It is filled as a side effect of YAML serialization, is not saved to disk and has no database/property/vault scope.

**Two cases were reproduced:**

1. Serialize `In Progress` → rename to `Doing` → clear the in-memory map, simulating a new process → read the saved YAML. Instead of the previous ULID, the string `In Progress` is obtained.
2. After serializing a value of another property with the same name but a different ID, reading the first renamed value also loses the link to the previous ID.

Source: [format.rs:10](../../src-tauri/src/database/format.rs#L10), [format.rs:467](../../src-tauri/src/database/format.rs#L467), [format.rs:919](../../src-tauri/src/database/format.rs#L919).

**Needed:** store a stable option ID in the durable representation, or use versioned persistent aliases in the schema of the specific property with conflict resolution. A global process map must not determine the interpretation of user data. Separately, finish the stable property key: at the moment renaming an ordinary field still rewrites YAML en masse.

The restart check was performed by resetting the global map in a test, without a real Tauri restart. This accurately models the loss of the only added alias storage mechanism.

### R6: formulas depend on column order, and cycles by names are hidden

**Reproduction:** `Price=100`, `Tax=20`, `Total=Price+Tax`, `Doubled=Total*2`. In the original order the test passes. After reordering the property definitions so that Doubled comes before Total, the value 240 does not appear. For the cycle `Total=Doubled+1`, `Doubled=Total*2` the function returns `Ok(())` instead of a cycle error.

The graph is built by ID, but dependencies from expressions return names. The `config.dependencies` field is not used by this graph. As a result the order comes from the property list, and evaluation errors continue to be swallowed. Previously saved results may additionally hide the inconsistency until a full rebuild.

Source: [formula.rs:775](../../src-tauri/src/database/formula.rs#L775), [formula.rs:837](../../src-tauri/src/database/formula.rs#L837).

**Needed:** a single resolution of references to stable IDs before building the graph, a common order for Formula/Rollup, explicit diagnostics of cycles and errors. Check arbitrary property order, rename, rebuild with an empty SQLite and incremental update.

### R7: deleting directories does not replace completing the migration

**Two cases were reproduced:**

- If the original manifest is named `ambd.json`, after a successful operation `needs_migration` remains `true`. The "canonical" path is chosen by a function that returns the existing legacy file; the condition for deleting the old manifest preserves it.
- The file `future-metadata.bin` in `.ambd/records` is deleted together with the directory and is absent from the backup: preflight lists only top-level JSON, and `remove_dir_all` deletes all the contents. The disappearance of the file was confirmed by checking both the original path and the corresponding backup path.

Source: [migration.rs:545](../../src-tauri/src/database/migration.rs#L545), [migration.rs:615](../../src-tauri/src/database/migration.rs#L615).

**Needed:** enumerate and verify in advance all resources affected by the deletion; preserve unknown files or block the conversion with a diagnostic. Delete only resources explicitly included in the successful plan, after checking their backup and transfer. Determine completion/resume by a versioned protocol that accounts for the legacy manifest, not by the fact that two folders are absent. Do not ignore cleanup errors.

### R8: loss of the repeated query after invalidation

**Reproduced with a React hook test:** start a query → call `invalidateHosts()` before it completes → return the old response. `queryDatabase` is called once instead of twice. The updated invalidation number honestly remains different from the response number, but a new query does not start.

Cause: during invalidation the effect sees an in-flight query and exits. Completion of this query changes the host, but host/status are not among the effect's dependencies, and there is no separate scheduling of a repeated query.

Source: [use-database-query.ts:258](../../src/components/workspace/database/use-database-query.ts#L258).

**Needed:** explicitly schedule a repeated query when a newer invalidation is detected after the current one completes, or build an effect/state machine that guarantees its start. Add a check that publishing an old response does not make the data definitively current. Canonicalization of keys and cleanup of auxiliary maps also remain part of ST-08.

### Checks of the repeated audit

| Check                                                 | Result                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Original eight `review_` Rust tests                   | 8 PASS, included in the full Rust run                                                 |
| `npm run rust:test`                                   | 335 PASS, 2 ignored                                                                   |
| Frontend as part of `npm run verify`                  | 654 PASS, 106 files                                                                   |
| TypeScript / ESLint / Prettier                        | PASS before the next verify stage                                                     |
| `npm run rust:clippy` separately                      | PASS                                                                                  |
| `npm run build`                                       | PASS                                                                                  |
| `npm run verify`                                      | FAIL on Knip: unused exported types `DatabaseUndoRedoResult`, `DatabaseHistoryStatus` |
| `npm run rust:fmt` separately                         | FAIL; formatting does not fully pass yet, the repository has pre-existing drift       |
| Bindings generation during rust:test                  | Contents matched the state before the check                                           |
| New Rust `review2_` scenarios in a separate copy      | 7 FAIL                                                                                |
| New React hook `review2:` scenario in a separate copy | 1 FAIL                                                                                |
| Native UI, 50k/100k, forced process termination       | Not performed in this audit; the original full acceptance is not confirmed            |

The new checks extend the earlier ones with specific scenarios from the original criteria. The eight green tests of the first set did not mean that they exhaust the whole contract.

### Release version

The user confirmed that the move from `0.1.3` to `0.1.4` and the release preparation were explicitly authorized. The earlier remark about a premature version change is withdrawn.

The remaining findings of this audit belong to the next `0.1.5` cycle. This is a boundary of the release scope, not a change in the actual test results and identified risks.

### Materials and order of the next rework

The first file `database-stabilization-regressions.patch` has already been applied by Gemini to the sources; it does not need to be applied again. The new [database-stabilization-followup-regressions.patch](../road/database-stabilization-followup-regressions.patch) contains only additional tests. To reproduce, use a separate copy of the current working version with dependencies installed:

```sh
git apply docs/road/database-stabilization-followup-regressions.patch
cargo test --manifest-path src-tauri/Cargo.toml --lib ::tests::review2_ -- --nocapture --test-threads=1
npx vitest run src/components/workspace/database/use-database-query.test.ts -t 'review2:'
```

Sequential execution of the Rust tests is needed because of the check of global process state. This is a diagnostic patch; when moving the tests into the permanent suite, the states/processes should be isolated and dependencies between tests removed. The patch does not fix the production files.

1. Close the loss of edits in rollback and the deletion not backed by a backup; then implement the **original R2** with fault injection and restart.
2. Replace the global Select history with a durable format and finish the stable property keys.
3. Fix the computation graph, the completion of the legacy migration and the repeated query after invalidation.
4. Run the full matrix ST-00…ST-12, including native and the new format at 10k/50k/100k. Include the results of negative scenarios and the limitations in the report.
5. Run the full `npm run verify` and `npm run build`. Do not replace the full gate with the `verify:fast` command; do not close an audit item by checking a different function with a similar name.

## History of the previous check

The original audit is preserved below for traceability. Its descriptions reflect the state **before the latest fixes**; the current statuses and results are above. In particular, the old errors of the Undo table and of the three filters have already been fixed.

Date: 2026-09-20. The project working copy was checked, branch `dev`, HEAD `f43b9cf`. The assessment applies to the current uncommitted state, including the new `migration.rs` and `database/history.rs`.

## Conclusion

The work contains useful fixes, but the completion of all ST-00…ST-12 is not confirmed. It cannot yet be accepted as a finished stabilization or as a ready, safe migration. There is a reproduced loss of new edits during rollback, unfinished recovery of multi-file operations, and errors in filters and computations. The DONE marks and acceptance checkmarks in the original plan must be reviewed against the actual scenarios.

The check was performed without fixing the project's working files. Additional tests were run only in a separate temporary copy of the sources. The test patch is attached next to this document. Personal vaults were not used. The generated bindings after the standard Rust tests match the state before the check.

## What has actually been improved

- Calls to the dangerous automatic migration and to the bulk synchronization of properties into Markdown were removed from vault opening and reindexing. A test of source file immutability and recovery was added.
- Numbers are serialized without an intermediate `f64`; saving of Date and Files became more complete: the date structure, range, time zone and attachment metadata are supported.
- Preflight/backup/journal for migration, compensating rollback of batch and relations, Formula/Rollup computation in the projection, and basic Undo/Redo stacks with revision checks were added.
- There are changes to InfoPanel/PropertyEditor and a limit on the number of cache entries.

These improvements are significant, but the existence of modules and passing unit tests do not yet confirm the completion of the corresponding contracts.

## Findings by priority

### R1 — P1. Migration rollback erases changes made after the migration

**Reproduced.** Scenario: migrate a database → append text to a note → run rollback. The operation returns `Ok(())`, and the new text disappears. In `rollback_migration` the restore is performed without checking the current revision and without saving the new bytes before the replacement.

Source: [migration.rs:667](../../src-tauri/src/database/migration.rs#L667).

In addition, `migration_id` is appended directly to the recovery path, the journal is optional, and its belonging to the database is not checked. This requires a separate check of the paths and of the journal contents.

**Fix:** before the first write, check the expected post-migration revisions of all files, validate the ID/path/journal, and return a clear conflict on changes. Ensure recovery on a partial rollback. Add tests for new edits, a corrupted journal and a path escaping the recovery directory.

### R2 — P1. Multi-file operations have no working recovery after a process interruption

**Established from the code.** Batch writes files sequentially and keeps the original bytes in memory. On an ordinary error an attempt at reverse writing is made, and its errors are ignored. If the process terminates between two writes, this branch is not executed. The durable batch journal/recovery functions remain `#[allow(dead_code)]` and are not connected to the active write path. A similar compensating rollback is used for relations.

Source: [mutations.rs:1625](../../src-tauri/src/database/mutations.rs#L1625), [mutations.rs:1693](../../src-tauri/src/database/mutations.rs#L1693).

The existence of separate history snapshots does not replace a journal of the composition, revisions and result of the overall operation. A real process kill was not performed in this check; the absence of an active protocol is visible in the code.

**Fix:** connect a single durable protocol for batch/relations/undo: plan, backup data, expected revisions, progress and outcome. Check the result of the rollback. Add fault injection between every step and repetition after a restart.

### R3 — P1. Undo/Redo are not isolated between vaults; the projection update contains a wrong table name

**Established from the code.** The history is registered at the application level, is indexed only by `database_id` and stores absolute paths. The `clear` method is not called when switching vaults. Risk scenario: change a database in vault A, open its copy with the same ID in vault B, press Undo — the history may restore the file in A. The revision check does not prevent this if the file in A has not changed since the operation. The undo/redo IPC has no expected vault generation and no check that the stored paths belong to the active vault.

Source: [history.rs:47](../../src-tauri/src/database/history.rs#L47), [history.rs:103](../../src-tauri/src/database/history.rs#L103), [commands/database.rs:738](../../src-tauri/src/commands/database.rs#L738).

When updating the projection after undo/redo, `SELECT ... FROM db_notes` is executed, although the membership table is called `db_members`. The error is swallowed; for a two-way relation, the affected notes of the other database end up in the update of the source database.

Source: [commands/database.rs:764](../../src-tauri/src/commands/database.rs#L764).

**Fix:** the history must be bound to the vault identity/generation; reset it on vault change, check paths and generation at the IPC boundary, and update both databases correctly. Check two vaults with identical IDs and a relation undo between two databases.

### R4 — P1. Stable keys and renaming of options are not finished

**Reproduced for Select.** The value is serialized by the option name, for example `In Progress`. After the option is renamed to `Doing`, the value that is read gets `option_id = "In Progress"` instead of the previous ID. The test named `st03_select_status_multiselect_rename_resilience` in the working project does not actually rename the option, so it does not catch this error.

Source: [format.rs:882](../../src-tauri/src/database/format.rs#L882), [format.rs:2221](../../src-tauri/src/database/format.rs#L2221).

Also, `storage_key()` only returns the existing `yamlBinding.key`; creating an ordinary property leaves `yamlBinding: null`, and `frontmatter_key()` uses the mutable name. Renaming a field still walks through the Markdown files and rewrites keys, ignoring write errors, without a common operation and without filtering nested databases/service directories.

Source: [format.rs:408](../../src-tauri/src/database/format.rs#L408), [mutations.rs:489](../../src-tauri/src/database/mutations.rs#L489), [mutations.rs:1258](../../src-tauri/src/database/mutations.rs#L1258).

**Fix:** fix an immutable key when a property is created and migrated; an ordinary rename must change the display name. Ensure durable storage of option IDs and explicit compatibility with legacy names. Check specifically save → rename → reload/rebuild.

### R5 — P2. The interface produces unsupported filters

**Three cases were reproduced on the query compiler with the arguments of the active UI:**

- `multiSelect` is rejected: the backend branch expects `multiselect` with different casing. The new standard test manually writes the wrong type variant into SQLite and hides the discrepancy.
- Checkbox is sent as the JSON string `"true"`, whereas the backend expects the boolean `true`.
- Select and Status keep the `contains` operator, which the backend does not support for these types; the reproduction was done for Select.

Source: [use-database-query.ts:115](../../src/components/workspace/database/use-database-query.ts#L115), [query.rs:964](../../src-tauri/src/database/query.rs#L964).

**Fix:** a single contract of types and operators, correct serialization of boolean/option IDs, a test of a real frontend request against the backend. Separately, finish the saved filter AST, multiple sorts and portable view settings: the current filter changes do not close the whole ST-09.

### R6 — P2. A chain of numeric formulas is not computed; errors are hidden

**Reproduced with correct property ULIDs and references by names:** `Price=100`, `Tax=20`, `Total=Price+Tax`, `Doubled=Total*2`. Total gets 120, and for Doubled the value 240 does not appear. When reading inputs, `value_type=number` is recognized, while the computed Total is written with `value_type=formula` and turns into Null at the next computation.

Source: [formula.rs:901](../../src-tauri/src/database/formula.rs#L901), [formula.rs:1003](../../src-tauri/src/database/formula.rs#L1003).

The graph matches dependencies to IDs, although expressions may reference names. Errors of evaluation and of recalculation calls are swallowed, after which the projection is marked healthy. Formulas are computed before rollups; a full common dependency graph and user configuration of Rollup are not confirmed.

Source: [formula.rs:775](../../src-tauri/src/database/formula.rs#L775), [projection.rs:321](../../src-tauri/src/database/projection.rs#L321), [mutations.rs:482](../../src-tauri/src/database/mutations.rs#L482).

**Fix:** typed results of computed fields, dependencies by stable IDs, a common Formula/Rollup order, explicit errors in the projection/UI. Check chains, cycles by real names, rename, external edit and both rebuild strategies.

### R7 — P2. After a successful migration the database is again considered to require migration

**Reproduced.** After `execute_migration`, a repeated `detect_migrations` returns `needs_migration=true`: the old shards remain, and the detector relies on their presence and does not take a successful outcome into account. Resuming an unfinished operation is also not wired in. The existence of a JSON journal does not by itself confirm idempotence/resume.

Source: [migration.rs:145](../../src-tauri/src/database/migration.rs#L145), [migration.rs:594](../../src-tauri/src/database/migration.rs#L594).

In the frontend, generated IPC migration functions were found, but not a user flow detect/preflight/execute/rollback through storage. The "controlled migration" acceptance through the UI cannot be performed yet.

**Fix:** a versioned transition state, detection of completion and of unfinished journals, a safe resume; define further reading of legacy shards without competing sources of truth. Do not delete old files until the verifiable protocol completes.

### R8 — P2. Protection of the cache from stale responses is not finished

**Established from the code.** The response is marked `loadedInvalidationSeq: state.invalidationSeq`, that is, with the current number at the time of the response, not with the number for which the query was started. If a change occurred during the query, the old response may end up marked as current. The `querySequences` that are never reset in production remain, as do the dependence of the JSON key on the order in which fields are inserted and a monolithic workspace of more than 3000 lines.

Source: [use-database-query.ts:201](../../src/components/workspace/database/use-database-query.ts#L201).

**Fix:** accept a result only for the recorded generation/query/invalidation; after a new invalidation, guarantee a new query. Add a controlled test with a deferred response, cleanup of auxiliary maps and a canonical key. Limiting the number of hosts does not by itself close ST-08.

## Actual assessment of the stages

| Stage | Assessment                | What is required for acceptance                                                                                                |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| ST-00 | Partial                   | Extend the baseline with scenarios that reproduce real user paths and failure boundaries.                                      |
| ST-01 | Main criterion confirmed  | The automatic destructive migration was removed; the open/reindex immutability test passes.                                    |
| ST-02 | Partial                   | Real stable keys, safe rename and format transition.                                                                           |
| ST-03 | Partial                   | A number of codecs were fixed; stability of option IDs under rename is not met.                                                |
| ST-04 | Do not accept             | There is no active durable recovery of the common protocol.                                                                    |
| ST-05 | Do not accept             | Unsafe rollback; repeated detection of the migration; no proven resume and no finished UI.                                     |
| ST-06 | Partial                   | The UI was improved; the claimed adapter file does not exist, the scenario dirty editor plus property change is not confirmed. |
| ST-07 | Partial                   | There is an equivalence test, but errors of the computed projection are hidden; the full watcher/rebuild matrix is not proven. |
| ST-08 | Partial                   | The hosts limit exists, the invalidation race remains; the workspace split was not done.                                       |
| ST-09 | Do not accept as complete | Filter errors were reproduced; saved views and all layouts did not pass the stated acceptance.                                 |
| ST-10 | Do not accept             | Numeric chains do not work, the common Formula/Rollup graph and diagnostics are not finished.                                  |
| ST-11 | Do not accept             | No history isolation between vaults, wrong table when updating the projection.                                                 |
| ST-12 | Not confirmed             | The full verify fails; there is no evidence for native and for 50k/100k of the new format.                                     |

## Discrepancies between the log and the implementation

- Line 479 of the ST plan (`docs/archive/Road/database-stabilization-gemini-plan.md` in git, commit 7b838c8) declares the implementation of `use-note-properties-adapter.ts`; there is no such file. This does not cancel the real InfoPanel changes, but the description of the result is wrong.
- Lines 496–498 name the limit 16, `querySeqRef` and canonical JSON sorting. In fact the limit 50 is in `database-store.ts`; the `querySequences` map is used, and the key does not sort fields.
- The stated backup path `.amby/migrations/<id>/backup` does not match the implementation `.ambd/recovery/migration-<millis>`.
- All acceptance checkmarks are ticked, although the ST-12 entry contains only 10k metrics and individual commands. There are no 50k/100k results and no real native UI smoke in the log.
- The benchmark called a check of the new format uses a generator with `ambd.json` and `.ambd/records`; user values are not written by this generator into note YAML. It does not prove the scalability of the claimed new format. Source: [generate-database-fixture.mjs:125](../../scripts/generate-database-fixture.mjs#L125), [line 228](../../scripts/generate-database-fixture.mjs#L228).

## Checks of this assessment

| Check                                                     | Result                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                           | PASS                                                                                                                                                                |
| TypeScript, ESLint, version check as part of verify       | PASS                                                                                                                                                                |
| Frontend tests                                            | 654 PASS, 106 files                                                                                                                                                 |
| `npm run rust:test`                                       | 327 PASS, 2 ignored                                                                                                                                                 |
| `npm run rust:clippy`                                     | PASS                                                                                                                                                                |
| `npm run verify`                                          | FAIL on Prettier for `database-stabilization-gemini-plan.md`; the subsequent steps of the common gate were not run                                                  |
| `npm run knip` separately                                 | FAIL: two unused exported Undo/Redo types in storage/index.ts                                                                                                       |
| `npm run rust:fmt` separately                             | FAIL; there are remarks in the new migration.rs too. The repository also has known pre-existing formatting drift, not all remarks should be attributed to this work |
| Repeated bindings generation by the standard rust:test    | Bytes matched the state before the check                                                                                                                            |
| Additional checks in the sources copy                     | 8 tests: 7 FAIL, 1 PASS                                                                                                                                             |
| Native UI, packaging, 50k/100k, real process interruption | Not run in this assessment                                                                                                                                          |

The additional check that passed: a batch change for a manifest of a future version is rejected without changing the note. This scenario is not included in the list of defects.

The additional checks that failed: rollback after new edits; repeated detection of a successful migration; Select after rename; numeric Formula chain; multiSelect, Checkbox and Select filters.

[The patch with reproducing checks](../road/database-stabilization-regressions.patch) adds eight tests to the checked state. This is diagnostic material, not a product fix. Seven tests must remain red until the found defects are fixed; the check of the future manifest version already passes.

To reproduce, apply the patch **in a separate copy of the current working version** and run from the root of that copy:

```sh
git apply docs/road/database-stabilization-regressions.patch
cargo test --manifest-path src-tauri/Cargo.toml --lib ::tests::review_ -- --nocapture
```

The patch adds tests that use temporary vaults; it does not change production code. After subsequent changes the patch context may need adaptation.

## Order of rework for Gemini

1. Fix the statuses and the log according to the facts. Preserve existing user changes; do not rewrite test expectations to get a green result.
2. First close R1–R3: safe rollback, working durable recovery, isolation of Undo/Redo and a correct projection of related databases. Add tests of failure boundaries and restart.
3. Finish ST-02/ST-03/ST-05: stable keys and option IDs, unambiguous completion/resume of the migration, a user preflight, consistent reading of legacy and the new format.
4. Fix R5/R6/R8 and finish ST-06…ST-10 with end-to-end tests interface → IPC → files → SQLite → reload. Check a dirty editor, saved views, both vaults, all claimed layouts.
5. Update the generator of the new format; run 10k/50k/100k and native smoke on a disposable vault. Save the results, conditions and limitations.
6. After the fixes, run the full verify and build, and reconcile docs/changelog with the observed behavior. Mark DONE only when the original stage criteria are met.

The original plan, the Gemini report, and the production code were not changed when this audit was added. This document and the diagnostic patch were added to the repository; an entry about the audit was added to updates.md.

## Re-check after the new Gemini report

The new `database-stabilization-review.md` claims full completion but does not refute the listed defects. Re-checking the Rust code against the copy of the previous audit revealed no changes to the production parts of the sources. The remaining wrong table name `db_notes`, the `multiselect` filter branch, and the hosts limit of 50 instead of the claimed 16 were also checked.

The new report contains additional unconfirmed claims: there is no `doesNotContain` operator in query.rs; the described backup path does not match the code. A successful `npm run build` confirms that the project builds, but not migration safety, completeness of the runtime functions, or a successful full verify.

The previous independent audit was originally in a temporary directory and could not be found by searching only inside the repository. This document makes the audit results available in the project. What should be passed to Gemini is this audit and the diagnostic patch, not just the completion report.

Checks when adding the audit: `npm run build` — PASS; `git apply --check docs/road/database-stabilization-regressions.patch` — PASS; formatting of this audit — PASS. A repeated `npm run verify` again passed 654 frontend tests and stopped at Prettier: there are now warnings in both the original plan and the new Gemini report. The production code was not changed; Rust tests, Clippy, and the diagnostic scenarios were not re-run, so their results above refer to the original audit.
