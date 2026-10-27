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

`tests/native/database-contract.ts` adds a real database IPC scenario: two-way
Relation link, unlink and replacement report every written page, update inverse
queries immediately, publish the latest projection sequence and match a later
explicit rebuild. It checks that a stale source revision replay is rejected
without changing either note or the projection, returned revisions match raw
bytes, and consecutive edits use the returned source revision before a query
refresh. It also exercises durable operation-ID replay across vault activation,
payload mismatch rejection and a controlled crash window: all records are set to
journal backups, only the source publish remains applied, and a pending journal
triggers exact rollback before queries on activation. This is a synthetic
interrupted-state fixture using real IPC/files, not a process kill or power-loss
simulation. It uses the same disposable-vault runner; it does not assert
filesystem locking or elimination of all crash/OS races.

The same scenario checks reciprocal property creation: raw source/target
manifest revisions, same-ID replay before/after reactivation with the current
generation, stale-generation and changed-payload rejection, and a stale target
revision without writes. A controlled schema journal fixture leaves only the
source manifest published; activation restores both raw backups, rebuilds both
schema projections, remains idempotent on another activation, and rejects reuse
of the rolled-back operation ID. This is also synthetic interruption evidence,
not a process-kill or power-loss test. The browser adapter requires desktop
runtime for property creation, so browser-only testing cannot establish this
filesystem contract.

Existing Relation configuration/type conversion is covered by that same IPC
scenario: conversion of an empty field to a reciprocal Relation across databases
and within one database, stale related revision and changed-payload rejection
without writes, disconnection preserving the counterpart as a one-way property,
and completed conversion replay with the current generation after activation.
Version-2 schema journal interruption (one and three manifest steps), conditional
rollback after a read-only related schema changes, malformed YAML, legacy aliases
and metadata preservation have focused Rust coverage. The native interrupted-state
fixture above still exercises version-1 property creation. Manual dialog smoke
and Windows/Linux execution remain separate checks.

The native updater scenario checks the compiled release identity against the app
version and verifies that the generic plugin check (including a downgrade flag)
is denied by real WebView capabilities. It makes no update request and performs
no installation. This does not certify signed artifact replacement.
