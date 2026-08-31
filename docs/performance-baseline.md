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
