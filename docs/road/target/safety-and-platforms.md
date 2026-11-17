# Data safety and platforms: what is left

## Module signing key (high importance)

The private part of the former official key `amby-official-2026` was stored in the repository; the key has been revoked
(2026-11-17) and replaced with the key `amby-official-2026-11`: its secret part exists only in the owner's Keychain
(`npm run modules:new-key`), the public part is written into the code. Before third-party modules are enabled
(`INSTALLED_MODULE_EXECUTION_ENABLED`), packages are published and plugins are announced, the packages must be re-signed.
Also needed: signing the whole manifest and limiting the download size while streaming. Details:
[../../security-advisories.md](../../security-advisories.md).

## Write protocol leftovers (from the 2026-09/10 handoff)

Full text: local archive, `docs/archive/handoffs/claude-handoff.md`.

- A shared `JournalFile` and the `recovery-required` outcome outside Relation; blocking only the affected database.
- A process-kill test in the failure matrix.
- A conflict resolution window for an external edit; shared write protection for Canvas/Excalidraw.
- Management of quarantined journals and the trash (currently only a notice).
- A restart/conflict matrix in a real WebView.
- Final independent acceptance.

## Windows and Linux

- Checklist [../../windows-release-checklist.md](../../windows-release-checklist.md): WIN-DATA, WIN-UI,
  WIN-KEY, WIN-PERF are open.
- The Windows trash (`SHFileOperationW`) may delete large files and files on network drives without a warning.
- Linux: the native vault check is postponed ([../../native-storage-contract.md](../../native-storage-contract.md)).

## Performance

Measurements: [../../performance-baseline.md](../../performance-baseline.md). S7.2–S7.4 not started; first a repeat
measurement after the incremental tree.
