# Windows Audit — September 28, 2026

> **Status as of 2026-11-02:** a snapshot as of 2026-09-28 (Amby 0.1.5). The caret loss after autosave has been fixed; the other items in the table were not re-checked against the current code — verify before working on them.

## Scope of the check

The local working copy of Amby 0.1.5 on the `dev` branch was checked, including the current
uncommitted fixes. Environment: Windows NT 10.0, build 26200.9457,
WebView2 154.0.4258.37, Node.js 22.20.0, Rust/Cargo 1.95.0.

The manual scenarios were run in a separate native window with disposable notes,
real editors, and Tauri IPC. The test profile, settings, SQLite, and
WebView were kept separate from the user's profile. The regular development window
was left running. The user's notes were not used as test
data.

For the measurements, a local diagnostic panel was added outside the React app:
`requestAnimationFrame` intervals, long tasks, focus events, editor DOM replacements,
and autosave state. The export goes through `storage.ts`.
The frontend was built without HMR; the chunk-splitting configuration differs from the regular
production build. This is a check of the real app in WebView2,
but not a certification of the installer or a measurement of the release binary.

## Confirmed results and priorities

| Priority | Result                                                                        | Status                                             |
| -------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| P1       | After autosave, the tree took focus away from Live Preview                    | Fixed and re-verified in the native window         |
| P1       | The Markdown compatibility check is not wired into editor mode selection      | Needs a fix; the defect is common to all platforms |
| P1       | File and index commands run synchronously on the Tauri main thread            | Confirmed by code; risk of freezes on large vaults |
| P2       | The regular Rust test target does not compile on Windows because of Unix APIs | Test portability needs fixing                      |
| P2       | The native deletion and diagnostics tests diverge from the current contracts  | Three false/outdated expectations, detailed below  |
| P3       | Excalidraw shows ⌘ shortcuts on Windows                                       | Confirmed by the UI and by strings in the code     |
| P3       | Path validation allows COM¹/²/³ and LPT¹/²/³                                  | Confirmed gap in the reserved-name check           |

### Caret loss: cause and fix

In `tree/sidebar-tree.tsx`, the effect that restores keyboard focus depended
on `flatRows`. Autosave and file events updated the tree, after which the
effect focused the selected row again. The earlier fix for the stability of
`editorProps` in Tiptap did not close this path.

Before the fix, the first input was saved, but continued typing without a click did not reach
the note. The diagnostics recorded focus leaving the editor about
1.1 seconds after typing, without a new click. The editor DOM was not replaced during this.

The effect now checks the focus owner before scheduling and inside the RAF.
The editor and other panels keep focus; keyboard navigation of the tree
keeps working. The regression test failed before the change and passes after it.

After the fix, typing, several autosaves,
a regular key, Backspace, and continued typing without a click were checked in sequence. All control phrases were
read back from disk. Focus loss was recorded only when the measurement export
button was pressed on purpose. The same scenario passed in CodeMirror and in a note of 1000 paragraphs.

### Markdown loss protection is not applied in the interface

A file with the footnote `Footnote[^1]` and the definition `[^1]: ...` opened in Live
Preview. The diagnostics reported `source: 0`, `livePreview: 1`
and the incompatibility reason `footnotes` at the same time.

`tiptap/markdown-compatibility.ts` explicitly rejects footnotes. However,
`roundTripCheck` is called by tests and diagnostics, while mode selection in
`editor/document-editor.tsx` relies on `noteEditingPolicy`, which checks the
frontmatter state. The check of whether an exact Markdown round trip is possible
is not included in that policy.

This violates the contract in `docs/markdown-compatibility.md` and is a potential risk of
altering unsupported Markdown during editing. Loss of content
in this scenario is not claimed: the source file stayed intact, and editing
the test footnote was done after explicitly switching to Source mode.

Compatibility needs to be checked before a document is admitted to Live Preview and when
that mode is chosen explicitly. The check should be tied to the content/revision,
and the full parse should not be repeated on every autosave metadata update.

### Main thread and vault scale

`commands/notes.rs` (`read_note`, `write_note`, `get_note_properties`) and
`commands/vault.rs` (`load_vault`, `load_active_vault`, `list_files`) use
synchronous Tauri commands. They perform file work and index work.
`use-vault-data.ts` calls `refreshTree` after a batch of watcher events;
`load_active_vault` calls `active.refresh()`.

According to the [Tauri documentation on commands](https://v2.tauri.app/develop/calling-rust/),
synchronous commands run on the main thread by default; heavy work
can block the interface. This is a confirmed architectural risk. The measurements
below show the cost of a refresh, but are not a measurement of the duration of
a specific window freeze for a user.

The test `desktop_e2e_large_vault_smoke_reports_scan_reopen_update_and_search`
was run on this machine in the debug profile. It creates notes in three folders,
opens the vault, reopens it, changes one file, passes the event
to the watcher queue, calls `active.refresh()`, and performs a search.

| Notes  | First open | Reopen  | One file change + refresh | Search  |
| ------ | ---------- | ------- | ------------------------- | ------- |
| 1000   | 1.425 s    | 715 ms  | 351 ms                    | 1.15 ms |
| 10,000 | 13.393 s   | 6.849 s | 3.428 s                   | 2.84 ms |

When the number of notes grew 10 times, updating a single file became about
10 times slower. Next step: profile `ActiveVault::refresh`,
move the blocking work off the main thread while preserving the order of writes,
revision checks, and vault generations. Then repeat the measurements in the release profile.

## Native interface

In the test vault, after the accumulated fixes, a long freeze when
switching Excalidraw was not reproduced. Three text → Excalidraw
transitions each, with returns, were run on an empty canvas and on a synthetic drawing of 1000
rectangles. The drawing was actually displayed; its external change
was picked up through the watcher.

| Scenario                                            | Max RAF interval | Long tasks                      | Result                                         |
| --------------------------------------------------- | ---------------- | ------------------------------- | ---------------------------------------------- |
| Short note, typing and autosave after the focus fix | 50 ms            | 54 and 51 ms                    | Typing continues without a click, no conflicts |
| Repeated switches of an empty Excalidraw            | 25.1 ms          | None                            | No long freeze seen                            |
| Drawing of 1000 shapes and repeated switches        | 66.7 ms          | 64 ms                           | No long freeze seen                            |
| Opening and two inputs in a note of 1000 paragraphs | 100.1 ms         | Tasks longer than 50 ms present | Both inputs saved, focus is kept               |

RAF and long tasks measure JavaScript work in the WebView. They do not separately measure
the window message loop, key delivery latency, or physical display latency.
The results do not cover a user drawing with attachments and a large
vault at the same time.

In the Excalidraw panel, the Undo/Redo hints contain `⌘Z` and `⇧⌘Z`, even though the app
runs on Windows. In `sketch-editor.tsx` these strings are set directly; next to them there is already
an `isMac` definition that can be used for correct hints.

## Files, trash, and tests

- The native IPC scenarios confirmed Unicode create/read/write, repeated
  writes, renaming of files and folders, collision protection, saving after
  re-activation, rejection of a stale revision, and rejection of escapes beyond the vault boundary.
- The rapid typing/erasing scenario with real saves and events passed.
  In the manual typing checks, no false external-conflict dialog appeared.
- The system trash successfully accepted two of the audit's own disposable files:
  a regular path and a nested path 341 UTF-16 code units long. Restoring
  from the system trash was not checked manually. This is a result on this machine,
  not a guarantee for UNC, network drives, or other Windows settings.
- `paths::confine` rejects standard device names and dangerous components,
  but allows COM¹/²/³ and LPT¹/²/³. Microsoft also classifies these variants as
  [reserved names](https://learn.microsoft.com/windows/desktop/FileIO/naming-a-file).
  Path validation was checked, not the creation of a file with such a name.

Native contract harness: **11 of 14 scenarios passed**. The three remaining
results are explained by the test expectations:

1. The restore test expects `delete_item` to populate `.amby/trash`.
   The current implementation sends the file to the system trash; `.amby/trash`
   is used separately by `archive_item`.
2. The deletion-failure test blocks `.amby/trash`, expecting `delete_item` to fail.
   This directory takes no part in the current system deletion.
3. The diagnostic log error test expects only `IoError`.
   Windows returns **PermissionDenied** when trying to open a directory
   as a file. The error is correctly returned to the calling code and to the status;
   the test had already passed the flush-failure and time-limit checks, then failed
   on an overly narrow string expectation.

These three results are not evidence of note loss. The tests and documentation
need to be aligned with the "Archive / system trash" split, and the expectation of
a sanitized error needs to be made portable.

The regular Rust test target does not compile: `database/mutations_test.rs:1177`
uses `std::os::unix::fs::PermissionsExt`,
and line 1223 uses `Permissions::from_mode`. To continue the audit only in
an ignored test copy, this single Unix test was restricted with `#[cfg(unix)]`.
After that: **365 Rust tests passed, 4 ignored**. This does not mean that
the regular `npm run rust:test` in the working repository is fixed.

CI already has a Rust Windows/macOS/Linux matrix and a Windows bundle job.
The problem is not the absence of a Windows job: the current non-portable test blocks
it from passing. The native scenarios of interaction with the editors are not part of
the regular `verify`.

## Checks and local artifacts

- SidebarTree regression checks: 9 tests passed, including keeping
  editor focus and keyboard navigation of the tree.
- `npm run build`: succeeded, TypeScript and the frontend bundle checked.
- `npm run verify`: the version check, TypeScript, and ESLint passed (one
  existing warning in `settings-modules.tsx`), **851 tests in 135 files passed**.
  The gate stopped at Prettier: nine existing files need
  formatting (`document-actions.tsx`, `use-document-crud.ts`,
  `header-tabs.tsx`, `EmojiPickerPanel.tsx`, `tree-icons.tsx`, `tree-row.tsx`,
  `workspace-orchestration.tsx`, `mutations-repository.ts`, `app.css`).
  The subsequent Rust stages did not run in this run; a separate check
  found the non-portable test described above.
- The focus change does not alter the file format, IPC, or Tauri permissions.
  The app version was not bumped.

Local artifacts are kept in the ignored directory
`.release-evidence/windows-audit-20260928/`: `caret-before.json`,
`caret-after.json`, `sketch-empty.json`, `sketch-1000.json`, `large-note.json`,
`markdown-mode.json`, `large-vault-1000.log`, `large-vault-10000.log`,
`shell-paths.log`, `rust-audit.log`, `native-contract.log`, `verify.log`,
`build.log`, and the test profile. They are not intended for commit or delivery.

## What else to check before a Windows release

### Addendum: silent auto-update at launch

After the auto-update change, the following were checked: a short server check, the absence of
confirmations, a shared Promise for repeated calls, network/download/signature errors,
restart, and resource release. Component checks confirm that the
workspace is not mounted during installation and restart, and that a change to the
setting after launch is applied at the next launch. The checks also pass
under React StrictMode. The manual update check keeps its interface.

- Targeted update, launch, and localization tests: **22 passed**.
- Repeated `npm run verify`: **870 tests in 136 files passed**; TypeScript
  and ESLint passed with the same existing warning. The check stopped on the
  same nine Prettier files listed above. The first parallel run
  exceeded the timeout of one existing test; after compilation finished,
  the repeated run passed without changing the test.
- `npm run build`: succeeded. `npm run tauri build -- --no-bundle`: succeeded,
  a Windows release executable was built with the installer's silent mode in the configuration.
- In browser mode, the opening of the workspace and the new auto-update hint
  in settings were checked. Tauri dev was rebuilt and launched; automatic
  installation is disabled in dev. The manual check of the native interface in this session
  was not completed: the window control tool twice returned
  `failed to activate captured window`.
- The transition between two signed installed versions, MSI/NSIS, and
  restart after a real installation have not been checked yet. A build without bundling
  and tests with a mocked IPC do not replace this scenario.

The version stayed at 0.1.5; the key, HTTPS endpoint, and permissions were not changed. The logs
of this check: `.release-evidence/updater-verify.log` and
`.release-evidence/updater-native-build.log`.

### Remaining scenarios

1. Wire in the Markdown compatibility protection and check Live/Source transitions
   on a corpus of unsupported constructs.
2. Fix the portability of the Rust test and update the native contracts
   so that the Windows gate really passes.
3. Profile and offload the main thread on vaults of 1000/10,000 notes;
   check the same scenarios in a release build and on a user drawing.
4. Check MSI/NSIS, launch without a toolchain, update, and closing with unsaved
   changes in the installed app.
5. Separately go through DPI 125/150/200%, moving a window between monitors, IME,
   UNC/OneDrive, antivirus/file locks, sleep/resume, and restoring from the system
   trash. These scenarios are not covered by this audit.

No comparable measurements were taken on macOS. The different engines
([WebView2 and WKWebView](https://v2.tauri.app/reference/webview-versions/))
explain why a separate UI check is needed, but on their own
they do not prove the cause of a specific Windows defect.

## Pre-commit check

After the audit, the obstacles to a full local check were removed: the Prettier
findings were fixed, and the batch-write rollback test gained a separate Windows
scenario with a blocked atomic file replacement. It verifies that both
original notes survive the failure. The Unix scenario with directory permissions is kept.

`npm run verify` passed in full: **876 frontend tests in 136 files**,
**366 Rust tests**, four previously ignored Rust tests, TypeScript, ESLint
(one existing warning), Prettier, Knip, Rustfmt, strict Clippy, and a check that
the generated IPC bindings are up to date. The formatting and Unix-test
compilation errors mentioned above reflect the state of the audit's initial run.

The version stays at 0.1.5 at the user's request to commit and push without a release;
the accumulated public notes remain in `updates/upd_next.md`. A signed
update between installed versions on macOS and Linux was not verified in this Windows session.
Full gate log: `.release-evidence/precommit-verify.log`.
