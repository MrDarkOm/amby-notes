# Verification map

[vitest.config.ts](../vitest.config.ts) includes both `src/**/*.test.{ts,tsx}` and
`tests/**/*.test.{ts,tsx}`. Default environment is Node; component files opt into
`happy-dom`. Check an existing nearby test before choosing a harness.

| Change                               | Verification owner                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure logic, stores, parsers, queues  | Colocated tests beside the implementation in `src/`                                                                                                                                                           |
| React interactions and lifecycle     | [component/](component/), plus colocated `*.test.tsx`                                                                                                                                                         |
| Markdown syntax                      | [markdown.test.ts](../src/components/workspace/tiptap/markdown.test.ts), [rich-editor fixtures](../src/components/workspace/tiptap/fixtures/), [shared indexing corpus](fixtures/markdown-compatibility.json) |
| Vault identity / source preservation | [compatibility-vault/](fixtures/compatibility-vault/), [Rust compatibility tests](../src-tauri/src/index/compatibility_fixtures_test.rs)                                                                      |
| Package version agreement            | [package-versions.json](fixtures/package-versions.json), frontend validator and Rust package-manager tests                                                                                                    |
| Native persistence contract          | [native/storage-contract.ts](native/storage-contract.ts), [native/note-contract.ts](native/note-contract.ts), [native_contract.rs](../src-tauri/src/native_contract.rs)                                       |
| Native debug contract                | [native/debug-contract.ts](native/debug-contract.ts)                                                                                                                                                          |
| Editor behaviour in a real browser   | [e2e/](e2e/) with [playwright.config.ts](../playwright.config.ts): Playwright + WebKit against the built browser bundle                                                                                       |
| Filesystem success/failure/rollback  | Rust tests beside services and [desktop_e2e_tests.rs](../src-tauri/src/desktop_e2e_tests.rs)                                                                                                                  |

Focused iteration: `npm run test -- <test-path>` or
`npm run rust:test -- <test-filter>`. For completion run `npm run verify` and
`npm run build`; Rust/desktop changes have the additional requirements in
[AGENTS.md](../AGENTS.md). Passing tests in an isolated area are not proof that
the integrated application passes.

For real desktop testing consult [native-storage-contract.md](../docs/native-storage-contract.md)
and [native-ui-smoke.md](../docs/native-ui-smoke.md) before running the matching
`test:storage:live` / `test:native:ui` scripts. These need the native environment;
browser fallback and happy-dom do not establish watcher, WebView, dialog or OS
filesystem behavior. Use disposable fixture vaults, not personal notes.

Real-browser suite: `npm run test:browser` (once per machine:
`npm run test:browser:install`, about 80 MB of WebKit). It builds the bundle, serves
it with `vite preview` and drives the localStorage web adapter in WebKit, the engine of
the desktop webview; `AMBY_E2E_DEV=1` targets the dev server instead. happy-dom cannot
see a frozen main thread, a redraw loop, real typing or an editor built twice — add a
case in [e2e/](e2e/) when a change is about any of those. Notes are synthetic strings in
[e2e/fixtures.ts](e2e/fixtures.ts) (never `.md` files Prettier could rewrite, never
personal notes); every case seeds its own vault in a fresh browser context. Specs take `test`
from [e2e/support.ts](e2e/support.ts), not from Playwright: its keyboard waits until the rich
editor is ready for keys (ProseMirror re-applies its selection 20 ms after a focus and learns
of a click from a later `selectionchange`), so a case never needs a pause after a click.
`AMBY_E2E_JANK=<ms>` keeps the page's main thread busy in bursts and reproduces a loaded
machine; run it with `--repeat-each` before trusting a new case that types. The suite is not part of `npm run verify` (it needs the browser binary); CI runs it on
macOS as the "Editor in WebKit" job of [verify.yml](../.github/workflows/verify.yml), with
one retry and the traces of failed cases kept as an artifact. It does not cover the native
window, the Rust side or the system webview's own painting.

Preserve fixture BOM/CRLF bytes. Add meaningful acceptance and rejection/failure
cases for format and persistence changes; avoid tests that just mirror code.
Do not add tests solely for a reversible copy or layout adjustment.

Relation command/projection acceptance also runs through
[native/database-contract.ts](native/database-contract.ts): link, unlink and
replacement across two databases must update inverse queries before rebuild.
[projection_test.rs](../src-tauri/src/database/projection_test.rs) covers inverse Rollup, self-relation deduplication,
projection failure warnings and source-byte preservation without a watcher.

Backup catalog and stale activation checks cross real IPC in
[native/backup-contract.ts](native/backup-contract.ts). Restore byte preservation,
exclusive destinations and interrupted operations are covered beside
[backup_restore.rs](../src-tauri/src/sync/backup_restore.rs).
