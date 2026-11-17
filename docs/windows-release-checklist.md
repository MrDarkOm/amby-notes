# Windows: separate manual acceptance for Amby Notes

Status: **PARTIAL**, 1 September 2026: automated core/live-storage,
isolated full UI smoke, MSI/NSIS build, exact NSIS
install/launch/uninstall, and NTFS race/rollback barriers completed. The extended
manual matrix remains partial; unavailable environments are explicitly marked BLOCKED.

NSIS install/launch/uninstall passed in an isolated directory on 2026-09-01,
including registry cleanup. The exact installed production executable passed
open/edit/autosave/full close/reopen/readback against a disposable vault. The real
settings directory was restored with both original files matching their preflight
SHA-256 manifest. The exact final artifacts report `NotSigned`: MSI SHA-256
`ADAA5D09A641C7343A84E5B2A28862CA8ECD7DA5994A891B84D722F4BF6CC6BA`, NSIS SHA-256
`BBEDCF0F6FCE7773AE4A98EAFCB003733386BAD2F0A193A992EDFC55E716F984`.
The symlink test was stopped by system error 1314 (insufficient privileges).
Details: remaining-critical-progress.md.
This file is an instruction guide,
not proof of passing. Fill in the result of each step after verification.
macOS/APFS, unit tests, and a successful Windows build do not substitute for Windows runtime.

Remaining tasks: [AUDIT_ISSUES.md](../AUDIT_ISSUES.md), especially MANUAL-05.
Full historical protocol MANUAL-01—07: `git show 1d3f0d6:AUDIT_ISSUES.md`.
Contracts: `docs/vault-format.md`, `docs/markdown-compatibility.md`.

## 1. Safe environment

- Use a separate Windows VM/test account and only a disposable
  vault. Do not open working notes, and do not use real API keys.
- A separate bundle ID **does not isolate** global settings: the app uses
  `%LOCALAPPDATA%\Amby\notes`. A separate user account also isolates Credential
  Manager; do not copy user settings or the WebView profile here.
- Do not format existing drives for testing. For exFAT/FAT32, use
  a pre-prepared empty medium or test volume. For network testing, use only
  a dedicated test folder with no third-party data.
- Save evidence outside the vault, `%TEMP%`, and Git. Do not delete fixtures and logs on FAIL.
  Do not include keys, provider responses, personal paths, or other Credential Manager entries
  in screenshots/logs. Disabling Defender, Gatekeeper-like checks, or UAC
  is not required to pass the test.
- On the first FAIL, stop the corresponding suite, record expected/actual,
  save a copy of the state, and file a separate fix. Do not mark an unavailable
  medium or an unverified race as PASS.

Fill in the verification passport:

```text
Date / tester:
Windows edition, version, build:
Architecture / CPU / RAM:
Commit / git status / local changes:
Amby version / installer SHA-256:
WebView2 version:
Mode: installed release build / tauri dev:
Vault path (test only):
Evidence path (not TEMP and not vault):
NTFS volume / case-sensitivity:
exFAT volume:
FAT32 volume:
Network protocol / server / mount / hard-link support:
```

## 2. Build and installation — WIN-BUILD

If you have a Windows installer of the **exact revision under test**, use it and
record the SHA-256. A macOS `.dmg` is not suitable for Windows.

Building from source requires Git, Node 22.12+ and npm 10+, the Rust MSVC toolchain,
Microsoft C++ Build Tools with Desktop development with C++, and WebView2.
MSI may require the VBScript system component. Current steps:
[official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows)
(checked when drafted on 2026-08-31). These are Tauri prerequisites, not a promise
of Amby support on every version of Windows.

In PowerShell from a **fresh checkout of the agreed checkpoint commit**:

```powershell
git rev-parse HEAD
git status --short
node --version
npm --version
rustc -Vv
rustup show active-toolchain
npm ci
npm run verify
npm run audit:npm
npm run tauri build
```

Check `$LASTEXITCODE` immediately after each command; stop on a non-zero code.
`verify` already includes Rust tests and bindings export. Exit 0 is expected;
if bindings differ, save the diff and check the revision — do not discard or
stage the file just for a green result.
`audit:rust` in the repository uses Bash: if Git Bash and cargo-audit are available,
run `npm run audit:rust` and save the result; otherwise record BLOCKED for this
step. Do not add new advisory exceptions. A Linux CI audit does not replace runtime.

- [x] **WIN-BUILD.1** All available commands completed successfully; logs saved.
- [x] **WIN-BUILD.2** The chosen `.msi`/NSIS `.exe` from
      `src-tauri/target/release/bundle/` installs and launches in the test
      profile. Record separately which installer type was tested.
- [ ] **WIN-BUILD.3** The first window is not blank; you can select the test vault,
      create a note, save it, and read it back after a full restart.
- [x] **WIN-BUILD.4** Signature recorded (`NotSigned`); a separate SmartScreen
      warning flow was not run. A successful
      build alone does not prove a trusted signature or safe installation.

## 3. Minimal fixtures and state snapshots

Through Amby, create notes `CaseNote`, a folder `CaseFolder` with a child note, and
a note `CaseBundle`. In the latter, enable Canvas/Sketch and a nested note so
you get a bundle with main Markdown, `.canvas`, `.excalidraw`, and child. Wait for save.
For links, create a separate note with a wikilink to `CaseNote`.

After closing the app, copy the test vault to a separate backup folder.
Save the list of relative paths and SHA-256 hashes of the source files. Record `.amby`
separately: index/session may change without modifying source notes.
Test the same set on each claimed filesystem.

Example of safely recording hashes in PowerShell; variables point only to
folders created for testing, not the entire drive:

```powershell
$testVault = Read-Host 'Full path of the disposable vault'
$testEvidence = Read-Host 'Full path of the existing evidence folder outside the vault'
$resolvedVault = (Resolve-Path -LiteralPath $testVault).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath $testEvidence -PathType Container)) {
  throw 'Create a separate evidence folder and retry'
}
$sourceFiles = Get-ChildItem -LiteralPath $resolvedVault -File -Recurse -Force |
  Where-Object { $_.FullName -notmatch '[\\/]\.amby[\\/]' }
$sourceFiles | ForEach-Object {
  [PSCustomObject]@{
    Path = $_.FullName.Substring($resolvedVault.Length + 1)
    Bytes = $_.Length
    SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
} | Export-Csv -LiteralPath (Join-Path $testEvidence ('hashes-' + [Guid]::NewGuid() + '.csv')) -NoTypeInformation -Encoding UTF8
```

After rename, compare the hash of the corresponding file at the expected new path.
For an inbound wikilink, only the expected target change is allowed; for it,
check the exact diff and the presence of a pre-refactor snapshot. Do not require
the entire vault to remain unchanged after an operation that intentionally updates a link.

## 4. Filesystem portability — mandatory continuation of MANUAL-05

| Step      | Where to run            | Action and PASS criterion                                                                                                                                                                                                                                                                                          |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WIN-FS.1  | Windows / NTFS          | In the UI, rename `CaseNote` → `casenote` → `CaseNote`. On disk there is exactly one note with the exact casing, stable ID and body preserved; the tab and link open the right note.                                                                                                                               |
| WIN-FS.2  | Windows / NTFS          | Similarly `CaseFolder` → `casefolder` → `CaseFolder`. All children are accessible, their ID/content are unchanged; the tree is not duplicated after restart.                                                                                                                                                       |
| WIN-FS.3  | Windows / NTFS          | Similarly rename the bundle. Container, main Markdown, Canvas, and Excalidraw consistently change basename; children/assets are preserved. All layers open after restart.                                                                                                                                          |
| WIN-FS.4a | Each claimed FS         | Pre-create a target with sentinel `DO-NOT-OVERWRITE-WIN`. Try rename/create/import into the occupied path. A safe refusal or picking another name per operation contract is acceptable; sentinel is byte-exact, source is intact. This is only a pre-existing collision, not a race.                               |
| WIN-FS.4b | Each claimed FS         | **PASS for NTFS 2026-09-01.** Separately test a target appearing **between check and publication**. Requires a reproducible timing trace/barrier in an isolated test driver. The foreign target remains byte-exact; the operation does not report overwrite; leaves no temp/reservation. Other FSs remain BLOCKED. |
| WIN-FS.5  | Windows / NTFS          | **PASS 2026-09-01.** Reproduce a failure mid-bundle-rename and rollback: after the first step succeeds, block the next step with controlled fault injection/targeted sharing lock. All original names and bytes must return, with no mixed container/main/sidecars.                                                |
| WIN-FS.6  | Real exFAT              | Create a note, import a file and an image, reopen, compare bytes. Repeat WIN-FS.4a/4b; verify the actual fallback without hard links rather than inferring it from a successful NTFS test.                                                                                                                         |
| WIN-FS.7  | Real FAT32              | Separately repeat WIN-FS.6; use small files, do not test the 100MB limit on multi-gigabyte fixtures.                                                                                                                                                                                                               |
| WIN-FS.8  | Dedicated SMB/NFS mount | Record actual share/hard-link support properties, repeat create/import/collision and restart. For a configuration without hard links, separately confirm the fallback. If such a mount is unavailable, BLOCKED. Do not disconnect the shared network to induce a failure.                                          |

For WIN-FS.4b/5 **do not change production code at random** and do not try to pass off
a preflight collision via repeated manual clicks as a race. Without a ready
driver, hand these two steps to an agent on Windows requiring temporary
barriers in a copy of the project and real file operations. Existing Rust tests
`case_only`, `rollback`, `no_replace` are useful as regressions, but do not cover these
manual rows on their own. Save the injection diff and timing log with the result.

The actual NTFS run on 2026-09-01 used test-only thread-local barriers,
which are absent in the release build. `target_created_at_publish_barrier_is_never_replaced`
created a foreign target immediately before hard-link publication: the operation returned
`AlreadyExists`, the sentinel remained byte-exact, and exactly one file remained in the directory.
`bundle_rename_failure_after_first_inner_step_rolls_back_every_file` successfully
renamed main inside the already-moved container, then injected an error before
the second inner step: the old container/main/Canvas/Excalidraw/child returned with original
bytes, with no new container and no temporary siblings. Evidence:
`.release-evidence/windows-fs-boundaries.log` and
`.release-evidence/windows-fs-boundaries-rollback.log`; the injection lives
only under `cfg(test)` in `frontmatter.rs` and `bundle/execute.rs`.

## 5. Windows data-safety smoke

This is a transfer of checks to Windows, not a new PASS of old macOS suites.
Detailed alternative branches are available in the MANUAL sections of the historical
protocol: `git show 1d3f0d6:AUDIT_ISSUES.md`.

- [ ] **WIN-DATA.1 / MANUAL-01:** open the same note in two windows. A clean window
      receives changes; on competing unsaved edits a conflict appears.
      Test accept external, explicit local save, and manual merge; do not lose
      the second version silently. Closing one window does not break the other's watcher.
- [ ] **WIN-DATA.2 / MANUAL-02:** external edit/rename/delete in the disposable vault
      are reflected in the tree. A dirty document is not closed or overwritten
      silently. Explicit restore of a deleted note preserves ID/frontmatter; if the path
      is already occupied by a sentinel file, restore refuses to overwrite it.
- [ ] **WIN-DATA.3 / MANUAL-03:** modify a note and immediately close the window/
      switch vault. After reopen, the text is preserved. Separately in the test
      profile, test a crash between durable draft and save; terminate only the exact
      selected PID of the test Amby process. Without a proven interval — BLOCKED.
- [ ] **WIN-DATA.4 / MANUAL-03:** on restart, if the recovery draft differs — there is
      an explicit accept/decline choice. Test both branches and failure/retry; the draft does not
      disappear until a successful save. Repeat for Canvas. The Windows folder Read-only
      checkbox is not proof of write denial: a verified
      restricted ACL/controlled error only in the test folder is required.
- [ ] **WIN-DATA.5 / MANUAL-03:** fixture with UTF-8 BOM, CRLF, unknown YAML, and
      trailing blank lines. After normal save and restore, there is exactly one
      BOM at byte 0, and expected CRLF and YAML are preserved. Without editing, the hash is the same;
      after editing, unchanged parts are compared separately.
- [ ] **WIN-DATA.6 / MANUAL-04:** history preview/restore works; before restore
      a snapshot of the current version is created. A corrupted snapshot is not restored.
      Explicit cleanup keeps the last 20 versions of each note and reconciles
      manifest/files. Account for 10-minute coalescing of autosaves: fast typing
      does not create 21 independent snapshots. Interrupted cleanup is a separate
      controlled scenario, otherwise BLOCKED.
- [ ] **WIN-DATA.7:** deletion through Amby moves data to vault-local
      `.amby/trash`; restore brings back main and layers. The system trash is not
      sufficient evidence. Do not delete all of `.amby`: properties/history/recovery
      are not equivalent to a single rebuildable index.

## 6. Windows UI, credentials, and search smoke

- [ ] **WIN-UI.1 / MANUAL-06:** Explorer → editor batch file + image + image
      is inserted in the original order, including an empty editor tail. Test
      normal and used scaled DPI. Hashes of imported assets match.
- [ ] **WIN-UI.2:** close a tab during column resize without closing the whole
      app; release the mouse. Guide/label disappear, and the editor for another note
      works. Self/descendant tree drop is safely rejected; valid move works.
- [ ] **WIN-UI.3:** Quick Open distinguishes identical names; split does not create
      two editable panes of the same file ID. Close/reopen before autosave preserves
      the dirty buffer and all subsequent edits; dirty is cleared only after save.
- [ ] **WIN-KEY.1 / MANUAL-07:** in the test profile, create a model and save a
      **synthetic** key without sending a request to the provider. After a full
      restart, the key remains available and masked; settings contain a credential ID,
      not the secret. Inspect only the newly created test Credential Manager
      entry for service `com.ambynotes.ai`; do not export third-party entries.
- [ ] **WIN-KEY.2:** a whitespace-only update and Delete remove the test credential;
      after restart the secret is absent and no dangling reference remains.
- [ ] **WIN-KEY.3:** controlled settings write failure is visible in the UI, the old file
      is preserved. Controlled AI network/timeout/HTTP errors do not contain the secret,
      request content, or provider response body. Use a local stub,
      not real paid calls; record an untested branch as NOT RUN.
- [ ] **WIN-PERF:** on synthetic vaults of 1k/10k, measure first and repeated
      name/content/tag queries, input latency, and result rendering. Verify limit 50,
      debounce, clear-before-dispatch, and absence of read-all IPC fan-out.
      An older response does not replace a newer one; physical cancellation of backend SQL is currently not
      implemented. Do not carry macOS ms over into Windows results.

## 7. Summary and handover

For each row, keep a record (a checkmark without a record is insufficient):

```text
Step: WIN-...
Environment / filesystem / commit:
Status: PASS | FAIL | BLOCKED | NOT RUN | NOT_APPLICABLE
Actions / expected:
Actual:
Evidence: relative names of log/screenshot/before-after hashes
Proof of timing/failure boundary, if required:
Note / issue:
```

| Section            | Summary 2026-09-01                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WIN-BUILD          | PARTIAL: build/install/open/edit/save/restart/uninstall PASS; clean create-note in the installed build and signed/SmartScreen flow are not proven.                           |
| WIN-FS.1—5 / NTFS  | PARTIAL: 4b/5 PASS with real files and barriers; case-only file/folder/bundle and collision pass Rust tests, but a new UI run was not visible to the automation API.         |
| WIN-FS.6 / exFAT   | BLOCKED: no prepared disposable exFAT volume.                                                                                                                                |
| WIN-FS.7 / FAT32   | BLOCKED: no prepared disposable FAT32 volume.                                                                                                                                |
| WIN-FS.8 / network | BLOCKED: no dedicated SMB/NFS mount.                                                                                                                                         |
| WIN-DATA           | PARTIAL: native UI external/conflict/recovery smoke and backend failure/history/trash/BOM contracts PASS; multi-window, crash window, and ACL UI branches are not proven.    |
| WIN-UI             | PARTIAL: media order/DPI, resize cleanup, tree transaction, Quick Open/split/dirty contracts pass tests; the full manual suite was not repeated.                             |
| WIN-KEY            | PARTIAL: real synthetic Credential Manager store/masked readback/exact backend read/delete PASS, no leftover test credentials; UI model/settings branches were not repeated. |
| WIN-PERF           | PARTIAL: Windows 1k/10k backend scan/reopen/update/search PASS; WebView input latency and resident memory were not measured.                                                 |

Close test processes, delete only the created test credentials through the UI,
keep fixtures/evidence until acceptance. Do not delete them automatically and do not commit
the vault/secrets/installers. Return a filled-in copy of this file and safe logs.

`MANUAL-05` can become PASS only for the actually verified matrix. Passing
NTFS does not cover exFAT/FAT32/network. Windows x64 does not confirm Windows ARM64.
Overall release readiness is determined by a separate repeat of FINAL-02 after analyzing
the results; this checklist alone does not change the declared platform support.
