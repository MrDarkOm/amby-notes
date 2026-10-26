# Sync workspace map

Encrypted sync through a self-hosted server. The plan and every decision (Р1–Р14, promises О1–О8,
failures С1–С14) are in [sync-plan.md](../docs/sync-plan.md); read it before changing anything here.
**Tests come before code** (plan, section 6): do not edit a test to make it pass. A test that looks
wrong stops the work and is fixed in its own commit after review.

A separate Cargo workspace (decision Р12): it does not touch `src-tauri/target` or the app gates.
License AGPL-3.0-only. The application uses `client`, `core` and `proto` by path from
[src-tauri/src/sync/](../src-tauri/src/sync/mod.rs) (stage Э4: the connect screen, and the real ports, the
session and the screen of the sync of a vault around the engine of Э3).

| Path                                       | Owns                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| [proto/](proto/src/lib.rs)                 | wire constants of the protocol: part size, machine error codes (appendix Б)                                     |
| [core/](core/src/lib.rs)                   | cryptography (Э1) and the sync engine (Э3), no Tauri; I/O only through interfaces                               |
| [core/src/engine/](core/src/engine/mod.rs) | the sync engine (Э3): ports and types, the pass, decisions of table Р7, appendix В                              |
| [server/](server/src/lib.rs)               | blind storage server (Э2): all of appendix Б; Dockerfile, compose with Caddy, README                            |
| [conformance/](conformance/src/lib.rs)     | server conformance suite: HTTP tests against any address, real client crypto (Э2)                               |
| [sim/](sim/src/lib.rs)                     | deterministic simulation of the engine (Э3): virtual devices, the real server, faults, invariants, mini-engines |
| [simrun/](simrun/src/main.rs)              | runs the random scenarios of `sim` against the real engine for hours, in a few processes (Э3)                   |
| [client/](client/src/lib.rs)               | async client of the sign-in protocol (reqwest + rustls, no Tauri), shared by the app (Э4)                       |
| [reference/](reference/)                   | independent Python reference of the byte format; generates `vectors/format-v1.json`                             |
| [vectors/](vectors/)                       | test vectors: `standards.json` (from RFCs, by hand) and `format-v1.json` (generated)                            |
| [deny.toml](deny.toml)                     | cargo-deny: licenses and advisories                                                                             |
| [core/fuzz/](core/fuzz/Cargo.toml)         | cargo-fuzz targets (nightly only)                                                                               |

Commands (see [package.json](../package.json)): `npm run sync:test`, `sync:lint` (fmt, clippy,
cargo-deny), `sync:conformance:red` (sorts the failures of the stub server by reason),
`sync:sim:red` (sorts the failures of the stub engine; it was the red run of the tests-first step and is green now), `sync:sim:run -- <first seed> <count> [quick|folders]` (the long run of the random scenarios against the real engine), `sync:conformance:docker` (build the image, run the suite against the container), `sync:req-check` ([script](../scripts/sync-req-check.mjs): every requirement is named
in a test), `sync:mutants`, `sync:fuzz -- <target>`, `sync:reference:setup`,
`sync:reference:vectors`. CI: [sync.yml](../.github/workflows/sync.yml); the two gates before real notes (sharded mutation
testing and the long simulation) run from [sync-gates.yml](../.github/workflows/sync-gates.yml) on a push to
`gates/run`, merged by [sync-gates-summary.mjs](../scripts/sync-gates-summary.mjs).
The second gate run and the regression of seed 23390 are tracked in
[sync-gates-second-report.md](../docs/Road/sync-gates-second-report.md); its frozen scenario tests
are [gates_regressions.rs](sim/tests/gates_regressions.rs).

The exact byte format is appendix "Точный формат v1" of the plan; the Python reference and the Rust
code must agree with it byte for byte.

Stage report with the red run and open questions for review: [sync-e1-report.md](../docs/Road/sync-e1-report.md).

Names of a device and of a space (Ф34): [core/src/crypto/name.rs](core/src/crypto/name.rs); the vectors are the `names`
section of `vectors/format-v1.json`, made by the Python reference like the rest.

The protocol is appendix Б of the plan (decisions П1–П41). The suite starts a server in the process
(`AMBY_SYNC_URL` unset) or goes to the address in `AMBY_SYNC_URL`, creating users through
`AMBY_SYNC_ADMIN_CMD`; tests that move the clock, restart the server or read its data directory
always use their own server in the process. Stage report with the red run, the implementation and the
mutation run: [sync-e2-report.md](../docs/Road/sync-e2-report.md).

Inside [server/src/](server/src/lib.rs):

| File                                            | Owns                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [db.rs](server/src/db.rs)                       | SQLite in WAL mode, schema version and migrations (checked before and after), `instance_id`, fake-salt secret |
| [store.rs](server/src/store.rs)                 | `BlobStore` (files under `blobs/`, parts, atomic join) and `UserStore` (database) behind traits               |
| [plans.rs](server/src/plans.rs)                 | the plans file: strict parsing, effective limits under the server ceilings (appendix Е, П50–П54)              |
| [quota.rs](server/src/quota.rs)                 | live / pending / history bytes by queries over the indexes, the plan of a user (П55, П61)                     |
| [state.rs](server/src/state.rs)                 | `AppState`: settings, clock, stores, the broadcast channel for event streams                                  |
| [config.rs](server/src/config.rs)               | `AMBY_SYNC_*` variables, the HTTPS rule                                                                       |
| [app.rs](server/src/app.rs)                     | the router; unknown path and wrong method answer in JSON                                                      |
| [http/util.rs](server/src/http/util.rs)         | errors (П4), strict hex (П2), reading a body with a limit (П8), token check (П5), client address (П16)        |
| [http/account.rs](server/src/http/account.rs)   | prelogin, enrol, login, recover, keys, devices (П11–П19)                                                      |
| [http/throttle.rs](server/src/http/throttle.rs) | the two failure counters (П16)                                                                                |
| [http/spaces.rs](server/src/http/spaces.rs)     | spaces and the ownership lookup (П6, П20)                                                                     |
| [http/blobs.rs](server/src/http/blobs.rs)       | bodies in parts, resume, ranges, quota (П21–П25, П42)                                                         |
| [http/commit.rs](server/src/http/commit.rs)     | the atomic commit (П26–П30)                                                                                   |
| [http/feed.rs](server/src/http/feed.rs)         | compressed change feed, history (П31–П33)                                                                     |
| [http/events.rs](server/src/http/events.rs)     | server-sent events, closed for a revoked device (П34)                                                         |
| [maintenance.rs](server/src/maintenance.rs)     | cleanup by the `Clock` only (П35–П37)                                                                         |
| [admin.rs](server/src/admin.rs)                 | `user add                                                                                                     | list | remove`, `backup` (П38, П39) |
| [main.rs](server/src/main.rs)                   | the command line, `serve` with cleanup every ten minutes, `healthcheck`                                       |

Appendix Е (tariffs and limits; decisions П50–П62, Д73–Д78, У1–У5). Written **tests first**: the stubs below answer
`not_implemented` / `501`, the tests are red as intended, another session writes the code with the tests frozen. Report with the
table "requirement → test", the red run and the open points: [sync-plans-tests-report.md](../docs/Road/sync-plans-tests-report.md).
`npm run sync:plans:red` groups the red tests of this workspace by reason (checks the list in
[plans-red-manifest.json](plans-red-manifest.json) with [plans_red.py](plans_red.py); after the implementation `--expect-green`),
`sync:plans:red:app` does the same for the application and vitest, `sync:plans:measure` is the measurement of the quota check (Е.10-7).

| Path                                                                                                                                                                             | Owns                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [server/src/plans.rs](server/src/plans.rs)                                                                                                                                       | the plans file (П50–П52), `EffectiveLimits` (П54): stubs                                                                             |
| [server/tests/plans.rs](server/tests/plans.rs), [migration.rs](server/tests/migration.rs)                                                                                        | parsing, resolution, ceilings; schema 1 → 2 (П58) with the hand-made fixture [common/legacy_v1.rs](server/tests/common/legacy_v1.rs) |
| [conformance/tests/plans.rs](conformance/tests/plans.rs), `quota.rs`, `blobs.rs`, `limits.rs`, `spaces.rs`, `commits.rs`, `retention.rs`, `admin.rs`, `durability.rs`, `info.rs` | the rows of Е.9 on a running server; [measure.rs](conformance/tests/measure.rs) is the ignored measurement                           |
| `admin::run_cli` in [server/src/admin.rs](server/src/admin.rs)                                                                                                                   | the commands `user plan …`, `plans …`, `space …` (П53): stub, `main.rs` forwards to it                                               |
| [sim/tests/limits_e.rs](sim/tests/limits_e.rs), [sim/src/limits.rs](sim/src/limits.rs)                                                                                           | engine scenarios Д73–Д78 against the real server with plans; random scenarios with the six invariants of Е.9 and the history ceiling |
| [client/tests/account.rs](client/tests/account.rs)                                                                                                                               | `SyncClient::account`, `blob_start_replacing`, `blob_delete` (stubs in `client/src/spaces.rs`)                                       |

Running your own server: [server/README.md](server/README.md) and
[server/docker-compose.yml](server/docker-compose.yml).

The sign-in client (stage Э4, the connect screen; report with the decisions for review:
[sync-e4-connect-report.md](../docs/Road/sync-e4-connect-report.md)). Tests run against the server of
`conformance` in the process (`Target::from_env`, so also against a container):

| File                                                                 | Owns                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [client/src/url.rs](client/src/url.rs)                               | the address of a server and the `https://` rule (П41)                                                                      |
| [client/src/error.rs](client/src/error.rs)                           | `ClientError`: machine codes of table Б.0.1, plain sentences (`describe`), `Retry-After`                                   |
| [client/src/api.rs](client/src/api.rs)                               | one method per request: info, prelogin, enroll, login, recover, keys, devices; no redirects, answer size limit, timeouts   |
| [client/src/spaces.rs](client/src/spaces.rs)                         | spaces, bodies in parts, commits (a version conflict is an answer), the change feed, notifications (SSE), limits (Б.3–Б.6) |
| [client/src/flows.rs](client/src/flows.rs)                           | prepare an account (nothing sent), enrol, sign in, recover, devices; a new device signs in under a placeholder name first  |
| [client/examples/second_device.rs](client/examples/second_device.rs) | a second device for the manual check ([native-ui-smoke.md](../docs/native-ui-smoke.md))                                    |

Stage Э3 (engine, tests first): rules are appendix В of the plan (decisions Д1–Д72). The ports and
types are in [core/src/engine/](core/src/engine/mod.rs); the engine is written against the tests of
`sim/` and `core/tests/`, which were written and reviewed first. The simulation and the tests of the
engine are in `sim/`; stage report with the red run, the implementation and the mutation run:
[sync-e3-report.md](../docs/Road/sync-e3-report.md).

Inside [core/src/engine/](core/src/engine/mod.rs) (public: ports, model, names, consistency, stream,
rules, sync; the rest is private to the engine):

| File                                                                   | Owns                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [ports.rs](core/src/engine/ports.rs)                                   | `LocalFs`, `Remote`, `StateStore`, `Clock` and the types they speak in                                   |
| [model.rs](core/src/engine/model.rs)                                   | the state of a device, the report of a pass, stops and approvals                                         |
| [names.rs](core/src/engine/names.rs)                                   | names of the system, collision keys, conflict copy names (Р7, Р9)                                        |
| [consistency.rs](core/src/engine/consistency.rs)                       | meaning of the header fields (Д65)                                                                       |
| [stream.rs](core/src/engine/stream.rs)                                 | opening a body as a stream (Ф24, Д68)                                                                    |
| [rules.rs](core/src/engine/rules.rs)                                   | what is not synchronised (Р4), the mass-change threshold (Р8)                                            |
| [sync.rs](core/src/engine/sync.rs)                                     | the `SyncEngine` trait, the real `Engine` and the steps of a pass (Д10): protections, cursor, report     |
| [scan.rs](core/src/engine/scan.rs)                                     | the local overview: listing, fast check, hashes, links and odd names (Д12, Д61, Д64)                     |
| [classify.rs](core/src/engine/classify.rs)                             | untouched, edited, moved, gone: renames by unique hash, by whole folder, by hint (Д13, Д70)              |
| [feed.rs](core/src/engine/feed.rs)                                     | reading the change feed, opening headers, forged, contradicting and newer-format records (Д14, Д65, Д66) |
| [decide.rs](core/src/engine/decide.rs)                                 | the table Р7 as one function of base, local and server (Д16, Д21–Д47); no I/O                            |
| [plan.rs](core/src/engine/plan.rs)                                     | the server version of an item and the actions the decisions produce                                      |
| [apply.rs](core/src/engine/apply.rs)                                   | application of incoming changes: folders, renames, writes with snapshot, trash (Д17, Д49, Д53)           |
| [push.rs](core/src/engine/push.rs)                                     | outgoing changes: resumable uploads, commits written to the state before they are sent (Д6, Д7, Д18)     |
| [flow.rs](core/src/engine/flow.rs), [util.rs](core/src/engine/util.rs) | early exits of a pass; small helpers                                                                     |

Inside [sim/](sim/src/lib.rs): `vfs.rs` (files in memory with history and trash), `world.rs` (server,
account, devices), `fault.rs` (crashes, lost requests, lies of the server), `invariants.rs`
(раздел 7), `scenario.rs` (random scenarios; `AMBY_SIM_SCENARIOS`, `AMBY_SIM_SEED`), `mini.rs` (the
correct mini-engine and seven broken ones), `limits.rs` + `broken_limits.rs` (scenarios of the limits of appendix Е and the broken engines they must catch), `dsl.rs` (helpers for the directed tests in `sim/tests/`).

Stage Э4 (the engine in the application, light order: tests first, one session, one review). The real
ports and the session are in [src-tauri/src/sync/](../src-tauri/src/sync/mod.rs) (`vault_fs.rs`,
`state_db.rs`, `remote.rs`, `session.rs`, `runtime.rs`); the carried-over fixes of Э3 are in the engine:
`FsError::AccessDenied` / `UnsyncedReason::NoAccess` (one refused file stops only itself), a file that stands
for a parked item with an invalid name is not uploaded again after a full reconcile (`push.rs`), the copy of the
second item on one path (Д71) is a listed conflict (`MoveAct::placed_as`). The test client of the server
(`conformance/src/http.rs`) keeps and reuses its connections and repeats a failed transport. Report with the red
run, open questions and the native check: [sync-e4-engine-report.md](../docs/Road/sync-e4-engine-report.md).

Stage Э4б (conflicts v2: the merge of a note and the conflict store; strict order, tests first). The rules are appendix Г of the
plan (decisions Г1–Г36). The tests were written first (red run in the report), the code was written against them in another session.
Report with the red run, the implementation and the open questions: [sync-e4b-report.md](../docs/Road/sync-e4b-report.md).

| File                                                                                         | Owns                                                                                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [core/src/engine/merge.rs](core/src/engine/merge.rs)                                         | `merge_text`: the three-way merge of a note by lines and Markdown blocks (К1, Г5, Г11–Г15)               |
| [core/src/engine/conflict_set.rs](core/src/engine/conflict_set.rs)                           | the set of a conflict in `.amby/conflicts/<id>/`: paths, identifier v2, `meta.json` (К2, Г21–Г22)        |
| `StateStore::base_put / base_get / base_prune` in [ports.rs](core/src/engine/ports.rs)       | the base of the merge on the device, `.amby/sync/bases/` (Г6–Г9)                                         |
| [sim/src/linemerge.rs](sim/src/linemerge.rs)                                                 | the reference merge of the simulation (independent of the core; the mini-engine and the checks use it)   |
| [sim/src/conflicts.rs](sim/src/conflicts.rs)                                                 | an independent reader and writer of the layout of a set (Г21–Г23) for the mini-engine and the invariants |
| [sim/tests/merge_k1.rs](sim/tests/merge_k1.rs), [conflicts_k2.rs](sim/tests/conflicts_k2.rs) | directed scenarios of К1 and К2 against the real engine and the correct mini-engine                      |
| [core/tests/engine_merge.rs](core/tests/engine_merge.rs) and `engine_merge_props.rs`         | the table of cases and the properties of the merge, bytes included                                       |
| `core/tests/engine_conflict_set.rs`, `engine_conflict_rules.rs`                              | the layout of a set and the rule of Р4 for `.amby/conflicts/`                                            |

How the engine uses them: `decide.rs` makes the place of the second version (`copy_for`: a set with identifier v2, or the old
copy beside the file inside `.amby/conflicts/`, Г19), loads nothing itself; `sync.rs` reads the bases of the items that both sides may
have edited (`load_bases`) before deciding and prunes the bases at the end of every pass (`prune_bases`, Г9); `apply.rs` tries
`merge_text` when it applies Д29/Д31 (`apply_put`), writes the files of a set in the order of Г23 (`write_copy`, `finish_set`) and keeps a
base when a file is written from the server or becomes the common version (`keep_base_of_file`, Г8 а, в); `push.rs` keeps the sent bytes as
the base before the commit leaves (Г8 б). In the application: `state_db.rs` keeps the bases in `.amby/sync/bases/<item>/<hash>`,
`conflict_store.rs` is the store behind `session.rs` (the list, the two versions, the three resolutions; the comparison and the
buttons of К3/К4 use it), and `session.rs` tells `SessionHooks::merged_after_edits` once per pass.

The simulation has two new invariants (`Kind::MergeLoss`, `NotMerged`, `ConflictNotStored`, `Marks`; merge episodes in `scenario.rs`) and
five new broken mini-engines (`MergeDropsLine`, `NeverMerges`, `ConflictCopyInTree`, `MergeWritesMarks`, `MergeWithoutBase`). In the
application: [conflict_store.rs](../src-tauri/src/sync/conflict_store.rs) is the port of the store of conflicts for the interface of К3 and К4
(contract: appendix Г, Г.3).
