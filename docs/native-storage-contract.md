# Live storage contract

Run `npm run test:storage:live` on a desktop with Tauri prerequisites and WebView.
The command builds a frozen test page and launches an opt-in `native-contract`
binary with Tauri's custom asset protocol. It uses the production generated
commands, invoke handler, `DesktopAdapter`, Rust storage and real filesystem.
It does not use `vi.spyOn`, mocked invoke, a mock runtime, or browser fallback.

`src/lib/storage/storage-contract.ts` contains the identical semantic scenarios
used by browser Vitest and the native runner. Every native scenario gets its own
empty vault inside a uniquely generated temp directory. The test binary has its
own WebView profile and does not load the workspace UI or global user settings.
Rust closes the index before cleanup. Startup/report failures, timeout, assertion
failure and cleanup failure exit nonzero. The runner also requires a passing
structured report and saves `.release-evidence/native-contract.log`.

Covered: create/read/write/overwrite; nested notes and folder rename; spaces;
Russian, Ukrainian, Japanese and emoji; missing paths; note and rename collisions;
invalid rename paths; tree removal after deletion. Errors expose stable
`notFound`, `alreadyExists`, `invalidPath`, `operationFailed` categories while
retaining their original diagnostics. Quota/unavailable browser storage errors
retain their existing dedicated categories.

Four native-only scenarios additionally verify real `note-written` event delivery,
save persistence across vault reactivation, stale-revision rejection without
overwrite, history/recycle restoration, and read/write/delete traversal rejection.
Together with the four shared scenarios, all eight passed on Windows.

Desktop delegation tests remain separate and are explicitly labeled as mocked.
The native feature adds no production command or permission, and is not enabled
by the normal build command. Do not distribute a binary built with this feature.

Windows x64: passed on 2026-08-31 against the remaining-roadmap working tree.
The WebView emitted a Chrome class-unregister warning on exit; the contract and
temp-vault cleanup completed successfully. macOS: not run here. Linux: deferred.

This is a live storage contract, not evidence of a full React editor lifecycle,
installer acceptance, multi-window behavior, or manual production UI smoke.
