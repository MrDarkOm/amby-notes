# Windows CLI and MCP test handoff

Tested on Windows against `origin/dev` commit `3b4e7297a8c2bef54521f74c45e6d5386878846c` (0.1.9-beta.8), in a separate worktree and disposable test vaults.

- `npm ci`: passed; npm reported 9 moderate and 1 high vulnerabilities.
- `npm run build:desktop -- --debug --bundles nsis`: passed, producing `Amby_0.1.9_x64-setup.exe` (28.61 MiB).
- The installer contains `amby.exe` next to `amby-notes.exe`. Installation was not tested: an existing Windows installation shares the installer registry keys, and no clean profile or VM was available.
- The extracted `amby.exe --help` and `node scripts/check-bundled-cli.mjs <extracted-amby.exe>` passed. The MCP test verifies writes within the granted folder and rejection outside it.
- `AMBY_NATIVE_CLI_BIN=<extracted-amby.exe> npm run test:storage:live`: failed with `Expected desktopProtocolVersion from desktop`. Other failing scenarios in the final run included rename/delete (Windows access denied) and the isolated Debug disk-failure check; inspect a fresh full report for all failures.

A separate diagnostic run temporarily instrumented the dispatch result and pipe I/O. The diagnostic changes were reverted after the run. Relevant output:

```text
CLI pipe probe expected=vaultNotActive actual=vaultNotActive
CLI pipe I/O failure: Kind(UnexpectedEof)
CLI pipe probe expected=desktopProtocolVersion actual=desktopRequestInterrupted
Native CLI probe failed: Expected desktopProtocolVersion from desktop
```

The immediate failure is an incomplete pipe exchange mapped to `desktopRequestInterrupted`. The reason for the EOF was not established. The diagnostic run used the built CLI sidecar; the later unmodified run reproduced the same assertion with the CLI extracted from the installer. This is not evidence of a successful installation or of macOS behavior.

## Windows retest after pipe fix

The first connection returns `vaultNotActive`; the second connects to the pending pipe instance. Windows still counts the preceding instance during handle teardown. Creating the next listener then failed with `ERROR_PIPE_BUSY` (231) at the two-instance limit. `accept` returned an error, the desktop stopped its listener and dropped the already-connected second instance, so the client saw `UnexpectedEof` and mapped it to `desktopRequestInterrupted`.

The listener now waits for a free instance on error 231 while retaining the connected instance. The current-user SID ACL and server SID verification are unchanged. The client still sends each request once, with no replay after connection. A Windows regression test reproduced both the server error and the client failure before the change, and passed after it with the expected two full error responses.

- Debug NSIS build: passed. Extracted `amby.exe --help` and `check-bundled-cli.mjs`: passed, including folder-scoped MCP write acceptance and denial.
- Full `test:storage:live`, with `AMBY_NATIVE_CLI_BIN` set to the executable extracted from the new installer: failed overall. The `CLI and MCP delegation preserve the native edit conflict contract` scenario passed, including rename, move, archive, restore, recovery and scoped MCP through the running native test desktop. The shared rename/delete scenario also passed in this run.
- Attachment import failed with `Source is not a file` for a test path consisting of a Windows verbatim (`\\?\`) vault path followed by `/Original Report.pdf`. The fixture constructs this path with a forward slash, then the asset command checks `Path::is_file`; this is outside the CLI named-pipe path. The preceding `writeFile` uses a different guarded filesystem path. This is a Windows fixture/path compatibility issue to investigate separately.
- Debug disk-failure scenario failed at `Status reports the sanitized writer error`: the test creates a directory where the log file should be and requires `IoError`. Opening a directory for writing on this Windows machine independently returned access denied; the Rust logger maps `PermissionDenied` separately from `IoError`. The observed test output does not include the actual status value, so this is an explanation supported by the reproduction, not a direct capture of that value. This test uses Tauri debug commands and not the CLI pipe.
- A previous run had intermittent `StorageOperationError: Отказано в доступе. (os error 5)` in the shared rename/delete scenario. It did not recur in the fixed full run; its root cause was not established. The scenario calls storage commands directly and is separate from CLI pipe dispatch.
- No clean Windows VM was available; installation remains unverified to avoid replacing the existing installation. Local full report: `.release-evidence/native-contract.log` (ignored by Git).
- `npm run rust:test`: after fixing the test harness to keep Tokio running while the intentionally interrupted client observes EOF, that CLI test passed. The full run still failed in `archive_migration::tests::k11g_opening_a_vault_runs_the_migration_before_anything_else` with Windows error 33 (file region locked) at `archive_test_support.rs:105`, and `index::compatibility_fixtures_test::tests::compatibility_vault_rebuild_does_not_mutate_sources_and_safe_body_save_preserves_envelope` with `Option::unwrap()` on `None` at `compatibility_fixtures_test.rs:143`. The core suite reported 972 passed, 2 failed, 7 ignored; the workspace run stopped there. These failures do not exercise the CLI pipe.
- `npm run rust:clippy` (workspace, all targets, warnings denied): passed. Final `npm run build`: passed. `npm run verify` and an installation in a clean VM were not run.
