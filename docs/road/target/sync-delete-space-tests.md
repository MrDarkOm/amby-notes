# Deleting a server space: test package

Date: 12 November 2026. Branch: `codex/sync-delete-space`, from `dev`.
Contract: appendix Л of the [plan](../../sync-plan.md). The owner's main condition:
only the server copy is deleted; local files on all devices remain.

## Package boundary

This is preparation before implementation under section 6 of the plan. The new DELETE responds
`501 not_implemented`; the client and runtime methods are `todo!()`. There is no delete button or new IPC command
in the app. The stubs do not perform any deletion. Existing tests are not changed.

The server/client and runtime tests are each written by a separate session of its own, from appendix Л and the public
interfaces. This session's tools do not provide Sonnet and Opus; the independent sessions use the available model.
This does not replace the Opus review required by the plan or the approval of a separate tests commit.

## Coverage and the red run

Building the tests and the expected failure on the stub are checked separately; a build or environment
error does not count as a red check.

| Suite                                              | Requirements and observable result                                                                                                                                              | Run                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `sync/conformance/tests/delete_space.rs`           | Л1–Л5: owner and revoked device, indistinguishable refusals, physical bodies and parts, current/old versions, quota, isolation, commit/upload race, SSE, restart and retry      | 6 tests build; all 6 fail on `501 not_implemented`     |
| `sync/client/tests/delete_space.rs`                | Л1, Л2, Л5, Л9: method/ID/token, actual absence of a body, refusal codes, lost response and retry                                                                               | 5 tests build; all 5 fail on the client's `todo!()`    |
| `src-tauri/src/sync/runtime_delete_space_tests.rs` | Л6–Л9: bytes of notes, attachments and durable data; stop before DELETE, someone else's space, refusal and the new state.db schema; legacy server, retry, ID and another device | 14 tests build; all 14 fail on the runtime's `todo!()` |

Targeted server and client run (no external server setup):

```sh
env -u AMBY_SYNC_URL -u AMBY_SYNC_ADMIN_CMD cargo test --manifest-path sync/Cargo.toml \
  -p amby-sync-conformance -p amby-sync-client --test delete_space --no-fail-fast
```

Result: exit code 101, 11 expected failures, no build errors and no environment failures.
Logs: `/tmp/amby-delete-space-server-tests.log` and `/tmp/amby-delete-space-client-tests.log`.
Both suites compile (`--no-run`), and the targeted Clippy passes with `-D warnings`.

An independent review by the available model found weak points before the freeze: waiting for the second device
could finish before the pass; the old server did not record which requests it actually received; the order
"save the disabled state → DELETE" was checked only by the final state. The errors were
fixed before the first commit: pass counters, HTTP request logs and a SQLite check
at the moment of DELETE were added. A repeat independent review was done; the checks of the state after
a late response were additionally strengthened, not only the snapshot before it. The outcome of a stale request is not fixed as the only
rollback strategy: the actual state and the safety of the new session are checked. A state-save failure is checked in SQLite, where
`META_ENABLED` is stored; `ConnectionStore::save` saves the account and is not suitable for this check.

Targeted app run:

```sh
env -u AMBY_SYNC_URL -u AMBY_SYNC_ADMIN_CMD cargo test --manifest-path src-tauri/Cargo.toml \
  sync::runtime_delete_space_tests -- --nocapture
```

Result: exit code 101, 14 expected failures on the runtime stub, no timeouts and no background panics.
Log: `/tmp/amby-delete-space-runtime-tests.log`.

## Additional scenarios before the freeze

- Л6: a multithreaded fake holds the pass at GET changes and keeps accepting connections;
  DELETE must not overtake the pass. After the barrier is released, the spy checks `META_ENABLED=0`.
- Л9: the DELETE response is held while the runtime switches to another vault or another
  account; the late result must not change the new link or credentials.
- A lost DELETE response is checked in the client and runtime: local bytes are preserved, the link stays
  disabled, and a retry with `404` is confirmed by an empty GET list of spaces.
- On the second device, the following are checked: a completed pass, a saved `enabled=0`, activation through a
  new runtime after a restart, and byte-for-byte preservation of local files.
- Two simultaneous backend calls are not modelled separately; the Л11 protection against a repeated click belongs
  to the next UI package. Л10–Л11 and IPC are not implemented yet; tests for them must precede the code.

## Next package

After the frozen tests are reviewed and committed separately — another session implements the server,
client and runtime. The interface — separate tests before code: extending the shared confirmation with typing
the name, the row menu, localized results, IPC with generated Specta bindings.
Targeted browser and native checks, a native build and a check on two computers are needed.
The server on the internet and users' vaults are not changed in this package.

## Repository checks

- `npm run build` — passed.
- `npm run verify` — reaches `rust:test` and stops as expected on the new runtime tests:
  1699 old tests passed, 14 new ones failed on `todo!()`, 14 were skipped. Before that, docs,
  version, TypeScript, ESLint, 4130 Vitest tests (428 files), update-channel tests,
  Prettier, Knip, Rustfmt and the app's strict Clippy passed. Log: `/tmp/amby-delete-space-verify-complete.log`.
- `npm run bindings:check` — passed (checked separately, since the overall verify stops
  on the intentionally red tests). There are no IPC or generated bindings changes.
- Strict Clippy of the `sync/` workspace — passed.
- After the last strengthening of the stale checks: the runtime-test build (`--no-run`),
  Rustfmt and the app's strict Clippy passed again; all 14 targeted tests again fail precisely on `todo!()`.
- 26 existing conformance tests for `spaces` and `info` — passed.
- `npm run sync:req-check` — 91/91 earlier requirements; the new Л1–Л11 were reconciled separately against the matrix
  of this report, the script does not account for them yet.
- The first run in the sandbox was interrupted after refusals of the local listener and the system trash;
  the final run was done with access to temporary local servers, without an external `AMBY_SYNC_URL`.
- A native UI check and an installer build were not performed: this package has no button, no IPC command,
  no Tauri changes and no deletion implementation; they must be done after implementation.
