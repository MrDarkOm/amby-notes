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
