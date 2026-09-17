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
