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
