# Performance baseline

Run `npm run test:e2e:large` for a disposable, deterministic 1,000-note vault.
Set `AMBY_E2E_LARGE_VAULT_SIZE=5000` or `10000` for the larger roadmap sizes.
The test reports initial scan, warm reopen, one-file reindex, and indexed
search latency. It is a regression signal, not a benchmark with fixed limits:
record hardware, operating system, and build mode beside future results.

Latest development-machine 1,000-note result (2026-08-31): initial scan 166
ms, reopen 53 ms, single-file update 45 ms, search 0.28 ms. Memory after open
is intentionally omitted until it can be measured consistently by the native
desktop runner.

## Windows measurement — 2026-08-31

Source: `eacf176` plus the remaining-critical-roadmap working changes (identity
and FTS fixes). CPU: AMD Ryzen 7 5700X, 8 cores. RAM: 31.93 GiB. OS: Windows
10.0.26200, x64. Rust 1.95.0 MSVC, cargo test debug/unoptimized build.
This is one sample per size on the local temporary filesystem, without fixed
performance thresholds. Other build/verification work was running; these are
development reference measurements, not isolated production benchmarks.

| Notes  | Initial scan | Warm reopen | One-file update + refresh | Search   |
| ------ | ------------ | ----------- | ------------------------- | -------- |
| 1,000  | 1.205 s      | 0.583 s     | 0.534 s                   | 1.565 ms |
| 5,000  | 6.087 s      | 3.339 s     | 2.260 s                   | 1.807 ms |
| 10,000 | 13.382 s     | 9.962 s     | 7.234 s                   | 4.934 ms |

Commands: `node scripts/run-large-e2e.mjs`, with
`AMBY_E2E_LARGE_VAULT_SIZE` set to `1000`, `5000`, and `10000` in turn.
All three assertions passed. Logs: `performance-1000.log`,
`performance-5000.log`, `performance-10000.log` (ignored local evidence).
The update metric includes the full refresh, not just the single SQLite row.
Do not compare these Windows/debug numbers directly to the older macOS sample.
Resident WebView memory remains unmeasured.

## macOS measurement — 2026-10-02

Source: branch `checkpoint/handoff-stage2`. Apple M5, macOS 26.6.2, Rust 1.95.0,
`cargo test` debug/unoptimized build, one sample per size, local temporary
filesystem, other work idle. Command: `AMBY_E2E_LARGE_VAULT_SIZE=<n> npm run test:e2e:large`.

| Notes  | Initial scan | Warm reopen | One-file update + refresh | Search  |
| ------ | ------------ | ----------- | ------------------------- | ------- |
| 1,000  | 0.254 s      | 0.084 s     | 0.046 s                   | 0.40 ms |
| 10,000 | 2.784 s      | 0.949 s     | 0.518 s                   | 1.16 ms |

Reading: scan and reopen scale roughly linearly. The one-file update grows about
11x for 10x notes, so a single edit still refreshes work proportional to vault
size. That is the evidence for handoff task S7.3 (incremental index/tree); it is
a debug-build figure and must be re-measured in release before acting. Do not
compare with the Windows numbers above (different OS, hardware and build).

## Database fixture generator — 2026-09-12

`npm run db:fixture -- --size 10000|50000|100000` creates a disposable database
fixture under the operating system temporary directory. It contains a manifest,
20 properties, four views, duplicate Unicode titles, empty values, exact
decimal strings, dates, multi-value fields and self-relations. The generator
does not accept a vault path and does not read an existing vault. It is a
dataset generator, not a completed performance result: database cold rebuild,
warm open, query p50/p95, memory and 50k/100k native UI measurements are NOT
RUN for this batch.

## Windows repeat — 2026-09-01

Current `dev` working tree after the NTFS race/rollback regressions, on the same
Windows machine and debug test profile. Both deterministic generators passed.

| Notes  | Initial scan | Warm reopen | One-file update + refresh | Search   |
| ------ | ------------ | ----------- | ------------------------- | -------- |
| 1,000  | 1.157 s      | 0.584 s     | 0.511 s                   | 1.456 ms |
| 10,000 | 14.925 s     | 7.206 s     | 4.962 s                   | 3.260 ms |

Evidence: `.release-evidence/windows-perf-1k.log` and
`.release-evidence/windows-perf-10k.log`. These measurements cover the indexed
backend path. WebView input latency and resident memory remain unmeasured, so
the full manual `WIN-PERF` row remains PARTIAL.

## macOS repeat — 2026-09-04

Current worktree on macOS arm64, Rust debug test profile. The deterministic
large-vault smoke passed at every roadmap size:

| Notes  | Initial scan | Warm reopen | One-file update + refresh | Search   |
| ------ | ------------ | ----------- | ------------------------- | -------- |
| 1,000  | 222 ms       | 53 ms       | 46 ms                     | 0.400 ms |
| 5,000  | 1.177 s      | 294 ms      | 252 ms                    | 0.735 ms |
| 10,000 | 2.399 s      | 619 ms      | 522 ms                    | 1.167 ms |

Commands: `AMBY_E2E_LARGE_VAULT_SIZE=1000 npm run test:e2e:large`, then the same
command with `5000` and `10000`. These are indexed backend measurements only;
WebView input latency, DOM counts and resident memory remain unmeasured.

## Database projection repeat — 2026-09-12

Command: `npm run db:benchmark -- --size 10000`. macOS arm64, Rust debug test
profile, one run per phase. The fixture contains 10,000 database rows and 20
properties; the numbers are a baseline for this checkout, not release limits.

| Rows   | Vault index sync | Database rebuild | First page (100) | Three searches |
| ------ | ---------------- | ---------------- | ---------------- | -------------- |
| 10,000 | 1.747 s          | 4.972 s          | 28.2 ms          | 122.6 ms       |

The benchmark also verifies the complete count (10,000) and a search checksum
(590). 50,000/100,000 runs, p50/p95 series, memory and native UI latency remain
NOT RUN; repeat the same command for those sizes before calling EX-02/EX-43
complete.

## Relation picker search — 2026-10-02

Command: `cargo test --manifest-path src-tauri/Cargo.toml --lib relation_search_p95 -- --ignored --nocapture`.
macOS arm64, Rust debug test profile, in-memory SQLite projection with 10,000
database members, 270 samples (empty query, title searches, a miss, and keyset
continuation pages of 50).

| Records | p50     | p95     | max     |
| ------- | ------- | ------- | ------- |
| 10,000  | 3.88 ms | 5.13 ms | 6.42 ms |

Backend query only (`searchRelationCandidates`); IPC and WebView rendering are not
included. The target in the database parity plan is p95 ≤ 150 ms.

## Creative workshop: 300 stories × 50 pages — 2026-10-14

Stage 0 of the workshop plan measured this only in the debug profile
(discover 1.34 s, first open 6.5 s, reopen 4.4 s); stage 7 repeats it in **release**. Command:
`cargo test --release --manifest-path src-tauri/Cargo.toml --lib bench_300_stories_50_pages -- --ignored --nocapture`
(`src-tauri/src/desktop_e2e_tests.rs`). Apple M5, macOS 26.7.1, Rust 1.95.0, release profile (opt-level 3,
no LTO), AC power, local temporary filesystem, nothing heavy running. Three consecutive runs, each on a fresh
disposable vault of 301 databases and 15,300 notes (a plain dataset of databases and notes: no
`amby-workshop.json`, so the workshop catalog itself costs almost nothing in it).

| Build                                    | `discover_vault` | First open (activation + index + projection) | Warm reopen |
| ---------------------------------------- | ---------------- | -------------------------------------------- | ----------- |
| debug (stage 0, Apple M-series, one run) | 1.340 s          | 6.511 s                                      | 4.444 s     |
| release                                  | 0.962 s          | 3.302 s                                      | 2.199 s     |
| release                                  | 0.964 s          | 3.243 s                                      | 2.244 s     |
| release                                  | 1.068 s          | 3.307 s                                      | 2.236 s     |

Reading: release is about 2x faster than debug, the spread across release runs is under 10%. **Risk:** warm
reopen of a 300-story vault is about 2.2 s in release, above the ~1.5 s that feels instant; the cost is the
vault scan and database projection that grow with the note count (compare the 10,000-note rows above), not
the workshop layer. Nothing was changed to improve the numbers. WebView first paint, input latency and
resident memory with this vault remain unmeasured.

## Release profile — 2026-11-02

Apple M5, macOS 26.6.2, `cargo test --release` (the large-vault smoke), three samples per
size, other work idle. Before: default release profile; after: `lto = "fat"`,
`codegen-units = 1`, `strip = "symbols"` in `src-tauri/Cargo.toml`. Medians:

| Notes  | Build  | Initial scan | Warm reopen | One-file update + refresh | Search  |
| ------ | ------ | ------------ | ----------- | ------------------------- | ------- |
| 1,000  | before | 128 ms       | 51 ms       | 26.4 ms                   | 0.18 ms |
| 1,000  | after  | 129 ms       | 50 ms       | 26.2 ms                   | 0.17 ms |
| 10,000 | before | 1.484 s      | 610 ms      | 318 ms                    | 0.56 ms |
| 10,000 | after  | 1.475 s      | 607 ms      | 317 ms                    | 0.54 ms |

Binary (`target/release/amby-notes`): 32.2 MB → 22.3 MB. Build time on this machine: release
binary 50 s → 207 s, release test binary 98 s → 260 s.

Reading: the profile changes size, not speed — scan, reopen and update are bound by file
reads and SQLite, not by compiled code. A one-file update still costs ~12x more at 10x notes
in a release build, so the next speed win is the incremental tree/index update (S7.3), not
compiler settings. Frontend for reference (`npm run build`): 240 JS files, 13.2 MB of JS in
`dist/assets`; the largest chunk is 1.78 MB, the entry `index-*.js` 540 KB with 38
`modulepreload` links. Startup time is not measured: frontend events reach the log file only
in debug mode.

## Single-file actions — 2026-11-02 (incremental tree and index)

Apple M5, macOS 26.6.2, `cargo test --release` of `desktop_e2e_large_vault_smoke_reports_scan_reopen_update_and_search`
(release profile with LTO off and 16 codegen units to shorten the build; the section above shows the profile does not
change speed), three runs per size, medians, other work idle. Each action runs through the same function the IPC command
runs (`*_inner`), with the database runtime enabled as in the app. "Refresh after" is what the renderer used to do
after an action: `load_active_vault` (a full scan, the whole tree and every note over IPC). It no longer runs after an
action; the column is kept to show what was saved. The last column is an edit made outside the app: before, the whole
vault was refreshed (`one_file_update`); now the watcher's path is refreshed by path.

| Notes  | Build  | Create  | Rename  | Move    | Trash   | Refresh after | External edit |
| ------ | ------ | ------- | ------- | ------- | ------- | ------------- | ------------- |
| 1,000  | before | 13.0 ms | 32.2 ms | 31.8 ms | 10.8 ms | 20.5 ms       | 26.5 ms       |
| 1,000  | after  | 10.4 ms | 9.6 ms  | 9.6 ms  | 8.2 ms  | not run       | 0.78 ms       |
| 10,000 | before | 51.5 ms | 357 ms  | 356 ms  | 11.5 ms | 278 ms        | 330 ms        |
| 10,000 | after  | 15.2 ms | 90.4 ms | 89.5 ms | 11.8 ms | not run       | 4.05 ms       |

Cost at 10,000 notes divided by cost at 1,000 notes: create 1.5x, trash 1.4x (target: at most 2x); rename 9.4x and move
9.3x (was 11x); external edit 5.2x (was 12x). In absolute terms the renderer waits 15 ms for a create and 4 ms for an
external edit at 10,000 notes, where it waited about 330 ms. The 10,000-note create "before" was noisy (35 to 165 ms);
the earlier run without the database runtime gave 15 to 30 ms.

What changed: a rename or a move rebuilt the whole database projection even when nothing in a database moved
(about 175 ms at 10,000 notes); it is now rebuilt only when a path is inside a database folder or is one. The link
rewrite read and parsed every Markdown, canvas and sketch file; it now reads them in parallel and parses only those
that contain the old path as text. The follow-up full refresh is replaced by a tree patch built from the disk for the
touched paths (`vault/tree_patch.rs`) and by `refresh_vault_paths` for watcher events and notes without a mutation result.

What still grows with the vault, and why:

- **Rename and move (about 85 ms at 10,000 notes).** Rewriting literal references (`](Old.md)`, `"Old.md"` in any
  note, in YAML or in a canvas) needs the text of every file; the index holds only note bodies and no canvas files, and
  trusting it could miss a reference the watcher has not reported yet. Removing the read needs a persisted reference
  index (a new rebuildable SQLite table and indexing of canvas and sketch files): a decision for the owner.
- **Link resolution (3.5 ms at 10,000 notes).** `resolve_links_for_note` builds a lookup of all titles and paths on
  every save and every point refresh, because link keys are compared in Unicode lower case, which SQLite cannot do.
- **Identity snapshot (2 ms).** `collect_note_index_identities` reads every id and path before a mutation.
- **Full reload still used** after a property migration that follows a move, after a creative-workshop write, after
  a restore with no path, for watcher bursts above 200 events or a rescan request, and on opening or re-indexing.
