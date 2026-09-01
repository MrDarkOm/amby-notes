# Remaining critical roadmap execution

Source: `AMBY_REMAINING_CRITICAL_ROADMAP.md`. Started 2026-08-31 and last
verified 2026-09-01 on Windows,
branch `dev`, baseline `eacf176` (remote confirmed by `git pull --ff-only`).
The only pre-existing untracked file was the supplied roadmap. No vault data
is used for testing; test fixtures and generated output are disposable.

## Baseline

`npm.cmd run verify:full`: TypeScript and ESLint passed; Vitest stopped with
356 passing tests, one failing CRLF test, and 11 missing-happy-dom worker errors.
The global PowerShell npm shim was broken; `npm.cmd` uses the installed Node
22.20.0 / npm 10.9.3 correctly. Missing dependencies were restored without changing
the dependency lock contents. The CRLF test
incorrectly doubled CR when fixtures were checked out with Windows line endings.
Rust dependencies initially required network access outside the sandbox.

## Current behavior / expected behavior / root cause / affected files

- Identity: `ParsedMarkdown::note_id` fell back to a generic canonical ULID.
  Expected: only `amby-id` is authoritative. Explicit identity states distinguish
  migration candidates; scans use a read-only cache key until confirmed migration.
  Affects frontmatter, index sync/preparation, migration, identity tests and docs.
- Search: MATCH tokenized punctuation but title matching and snippets used raw
  substring lookup. Expected: shared query terms and actual FTS match semantics.
  FTS5 generates snippets and confirms all title terms; BM25 remains in ranking.
  Affects index query and its regression matrix.
- Windows fixture test: blindly replacing LF duplicated CR. Expected: equivalent
  test input on every checkout; normalize either existing LF or CRLF first.
- Windows executable startup: library tests lacked Common Controls v6 activation,
  so rfd's imported TaskDialogIndirect prevented the executable from starting
  (`0xc0000139`). The build script gives tests a manifest while keeping Tauri's
  existing binary resource. Both tests and normal MSI/NSIS builds now start/build.
- Native folder creation: joining a Windows verbatim root with `/` produced an
  invalid Win32 path. `joinStoragePath` preserves the native separators and has
  a regression test plus live native coverage.
- Mutation failure: an index error called `mark_index_rebuild_required` while
  the command held that method's mutex. Regression first failed with a timeout;
  the fix records health on the already locked active vault. No second lock or
  competing state is introduced. Rename/move/refactor/recycle use the same fix.
- Windows path errors: relative APIs reject root/drive/UNC prefixes; component
  validation rejects reserved devices and alternate streams. Traversal is
  rejected before OS resolution so its error category is stable.

## Phase evidence

| Phase            | Result / evidence                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 baseline       | `dev` confirmed, pre-existing changes identified; environment/test issues above corrected. Final full verification recorded below.                                                                                                                                                               |
| 2 identity       | Trusted vs candidate states; no automatic trust or rewriting for generic canonical ULIDs; explicit migration/rollback, duplicate visibility, UUID and legacy tests. Modern fixtures use `amby-id`; historical migration fixtures intentionally retain `id`.                                      |
| 3 search         | One query model; FTS5 body snippets and title-column MATCH; BM25 retained. Punctuation, Unicode/Japanese/emoji-empty-query, diacritics and syntax-safety matrices.                                                                                                                               |
| 4 storage        | Reusable browser/native suite; frozen native WebView using real generated commands/Rust/temp filesystem; no mocks. Structured error categories. See `native-storage-contract.md`.                                                                                                                |
| 5 corpus         | Ten Markdown fixtures; byte-level CRLF/BOM guard; rebuild deletes only SQLite, compares all original bytes; opaque supported-paragraph edit test; insertion presentation tests.                                                                                                                  |
| 6 failures       | Atomic write stages including final publication preserve original/cleanup; dirty-state/retry/recovery/CAS tests; rename-failure React test preserves pending autosave path; real mutation index-failure deadlock regression. Native history/recycle/CAS/event tests supplement backend coverage. |
| 7 full native UI | **PASS on Windows** in the isolated real WebView harness: save/close/reopen, rename, dirty switch refusal, normal switch, external create/edit/rename/delete, recovery and conflict preservation. See `native-ui-smoke.md`.                                                                      |
| 8 macOS          | **EXCLUDED BY USER** from this execution. Historical macOS evidence is not evidence for these working changes.                                                                                                                                                                                   |
| 9 Windows        | Production MSI/NSIS build, exact-candidate NSIS install/launch/uninstall, and live storage/UI lifecycle passed. Installed production open/edit/autosave/full close/reopen/readback passed; symlink permission test is explicitly skipped with Windows error 1314.                                |
| 10 Linux         | **DEFERRED** per supplied roadmap; not claimed supported by this verification.                                                                                                                                                                                                                   |
| 11 performance   | 1k/5k/10k recorded with machine/build context in `performance-baseline.md`; all generator assertions passed.                                                                                                                                                                                     |
| 12 release       | **PARTIAL**: automated, isolated full native UI, audit, installed-production and clean committed-candidate gates passed. Prepared filesystem media and release signing remain. No release/promotion/publication performed.                                                                       |

## Verification and artifacts

- `npm.cmd run verify:full`: **PASS**, exit 0, 2026-09-01. TypeScript, ESLint,
  418 frontend tests in 67 files, Prettier, Knip, Rustfmt, strict Clippy,
  200 Rust tests and generated-binding freshness all passed. Two Rust tests are
  ignored in the default suite: performance (run separately for all three sizes)
  and Windows symlink (blocked by OS privilege). The same gate passed from clean
  committed candidate `974ff43`; evidence: `windows-committed-verify.log`.
- Native test TypeScript and the new React regression were additionally checked
  with TypeScript; the live runner now typechecks its test entry before building.
- `deadlock-regression.log`: test failed before fix; `deadlock-fixed.log`: passed.
- `npm run test:storage:live`: frozen browser asset protocol, real WebView and
  generated IPC commands: **8/8 passed**. Evidence: `.release-evidence/native-contract.log`.
- `npm run tauri build`: Windows x64 optimized build, MSI and NSIS bundles created
  from the final verified tree. `windows-production-final.log`, exit 0. MSI SHA-256:
  `ADAA5D09A641C7343A84E5B2A28862CA8ECD7DA5994A891B84D722F4BF6CC6BA`;
  NSIS SHA-256:
  `BBEDCF0F6FCE7773AE4A98EAFCB003733386BAD2F0A193A992EDFC55E716F984`.
  Both report `NotSigned`. The exact NSIS candidate installed and uninstalled with
  exit code 0 in an isolated workspace directory; its uninstall registration and
  executable were removed. Installer files are ignored generated output, not
  committed source artifacts.
- The exact installed NSIS production executable opened the disposable vault,
  edited and autosaved a note, fully closed, reopened and displayed the saved
  bytes. The original `%LOCALAPPDATA%\\Amby\\notes` directory was moved only after
  a recovery record and SHA-256 manifest were written, then restored with both
  original files byte-identical. The test installation and uninstall registration
  were removed. Evidence: `.release-evidence/production-smoke-20260901-152130/`.
- `cargo test ... windows_symlink_escape_is_rejected -- --ignored --nocapture`:
  **BLOCKED** by missing `SeCreateSymbolicLinkPrivilege` (OS error 1314).
  The ignored test is explicit and no Windows security setting was changed.
- Generated IPC bindings were regenerated through Rust tests; no binding content
  change, new production command, persistent-data migration, or permission scope.

The native harness is behind the opt-in Cargo feature `native-contract`; never
ship that feature. Its fixtures and WebView profile are temporary. No user vault,
global workspace settings, credentials, or installed app files were modified.

## Remaining work to finish this roadmap

1. If a suitably privileged test account is available, rerun Windows symlink security; do
   not disable security controls just to turn a checkbox green.
2. Run exFAT, FAT32 and SMB cases only when prepared disposable media/mounts exist.
   None was available in this session; no disk was formatted and no share invented.
3. Sign the Windows artifacts and exercise SmartScreen if a trusted code-signing
   certificate becomes available; neither the user nor machine certificate store
   currently contains one.
4. macOS work is excluded by the user's instruction. Linux remains deferred.
5. Re-run full verification after any change made to complete a remaining gate,
   then apply the feature freeze. Optional architecture recommendations remain out of scope.

## Release status

The non-macOS roadmap is **complete except for explicitly blocked environment
gates**: privileged symlink creation, prepared exFAT/FAT32/SMB media and trusted
Windows code signing. Full native UI and installed-production acceptance passed;
successful bundle generation alone is not used as runtime evidence.
