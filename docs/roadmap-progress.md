# Architecture stabilization progress

> Newer remaining-critical-roadmap execution and platform evidence:
> [remaining-critical-progress.md](remaining-critical-progress.md), 2026-08-31,
> Windows. The chronological macOS handoffs below are historical checkpoints.

Source plan: [`AMBY_CODEX_ROADMAP.md`](../AMBY_CODEX_ROADMAP.md), initially copied
unchanged from the supplied document on 2026-08-31. At the user's request, the
project roadmap now also contains current phase statuses, scoped release-gate
checkboxes, and a handoff for another chat. The Desktop source remains unchanged.
This file preserves the detailed chronological implementation/verification log.

## Current handoff — 2026-08-31

Phases 0–6 are implemented; continue with Phase 7, the Desktop E2E reliability
suite. Phase 6 adds a single Unicode-aware `search_terms` tokenizer in
`src-tauri/src/index/query.rs`: punctuation becomes a term boundary, `_` stays
inside identifier terms, and generated quoted-prefix clauses prevent user input
from becoming an arbitrary FTS expression. Regression coverage defines the
behavior for `C++`, `C#`, `node.js`, `file-name`, `foo/bar`, `snake_case`,
Cyrillic, and FTS syntax characters. Work remains uncommitted on `dev`, HEAD
`1d3f0d6213d41ce0dea88266c98ef914c2d34875`, alongside pre-existing user changes.
A clean checkout will not contain these changes. Read the handoff at the top of
the roadmap before continuing; older “next phase” statements below describe
historical checkpoints, not the current starting point.

Latest Phase 6 checks: Rustfmt, strict Clippy, all 10 `index::query` Rust tests,
and the complete 189-test Rust suite passed. The watcher integration test uses
a content-aware `PollWatcher` so that its same-size, same-mtime external edit
remains testable in a sandbox where the native notify backend cannot deliver
events. Native Tauri UI/IPC E2E, Windows/Linux, and remote CI remain unverified.

## Baseline — Phase 0

- Branch: `dev`, commit `1d3f0d6213d41ce0dea88266c98ef914c2d34875`.
- `git ls-remote origin refs/heads/dev` confirmed the same remote commit.
- Existing uncommitted workspace/history/navigation changes were present before
  this work and have not been reverted or included in the backend change.
- `npm run verify:full` passed before code changes: TypeScript, ESLint, 400
  Vitest tests in 64 files, Prettier, Knip, Rustfmt, strict Clippy, 147 Rust
  tests, and generated IPC binding verification.
- Pre-existing verification failures: none observed on this macOS machine.
  This does not establish Windows/Linux or desktop UI release readiness.

## Module and identity map at baseline

| Responsibility              | Modules and current behavior                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontmatter identity        | `src-tauri/src/frontmatter.rs`: `parse_markdown` reads top-level `id`; `body_with_id` assigns it; `replace_body_preserving_id` validates it for body-only save/restore.                                                                                                              |
| ID validation               | `src-tauri/src/vault/scan.rs`: `is_amby_id` accepts canonical uppercase ULIDs. `metadata_stamp` still uses second-resolution mtime.                                                                                                                                                  |
| Full index scan             | `src-tauri/src/index/sync.rs`: reads IDs, assigns missing IDs with history snapshots, skips user-managed and duplicate IDs, and maintains the path/ID map.                                                                                                                           |
| Incremental index and save  | `src-tauri/src/index/note_index.rs`: `prepare_note_at_path` reads/assigns IDs and rejects collisions; note lookup, save, and restore use indexed IDs.                                                                                                                                |
| Migration                   | `src-tauri/src/vault/migration.rs`: read-only preflight, ID assignment journal, backups, resume, and rollback all use parsed IDs. Current journal format is version 1, `add-amby-ids`.                                                                                               |
| IPC                         | `src-tauri/src/commands/notes.rs` and `commands/vault.rs`: note read/save/restore and migration commands. `src/lib/bindings.ts` is generated.                                                                                                                                        |
| Derived index relationships | `src-tauri/src/index/{schema,links,tags,refactor,query}.rs`: SQLite primary/foreign keys, backlinks, tag associations, refactoring, and search depend on note IDs.                                                                                                                   |
| Durable metadata            | `src-tauri/src/property_store.rs`, `app_data.rs`, and `recovery.rs`: custom properties, block sidecars, and recovery entries depend on stable IDs. `history.rs` provides raw-byte snapshots.                                                                                         |
| Vault and security          | `src-tauri/src/vault/{tree,scan}.rs`, `paths.rs`, `vault_context.rs`, and `bundle/`: tree ID mapping, scoped paths, vault lifecycle, and bundle mutations.                                                                                                                           |
| External updates            | `src-tauri/src/watcher.rs` and `commands/vault.rs`: event coalescing and own-write fingerprints; indexing freshness remains a separate Phase 3 task.                                                                                                                                 |
| Frontend consumers          | `src/lib/storage/{types,desktop-adapter,web-adapter-core,web-frontmatter}.ts`, `src/lib/recovery-drafts.ts`, workspace stores/file-actions, and `src/components/workspace/autosave/`. Web fallback primarily uses path IDs; its missing-file restore fallback still emits YAML `id`. |
| Compatibility fixtures      | `src-tauri/src/{frontmatter,vault_index}.rs`, `index/note_index.rs`, `src/lib/storage/storage.test.ts`, `tests/fixtures/markdown-compatibility.json`, and workspace Tiptap fixtures/tests. Existing legacy and external IDs must remain covered.                                     |

History inspection found ID validation changes in `b7adfbc` and `c874bcc`, with
subsequent preservation/recovery work in `96dad9f` and `8d9bf73`. A canonical
ULID alone does not establish that an external vault's `id` belongs to Amby.
Phase 1 must resolve provenance and migration behavior before changing the
identity parser or durable sidecar keys.

## First implementation block — lossless ID assignment

This block implements the preservation prerequisite from Phase 2 before
changing the identity model in Phase 1. Neither phase is marked fully complete:
the service field is still `id`, and no legacy-to-`amby-id` migration is added.

Root cause: `body_with_id` parsed a YAML mapping and serialized it again,
discarding comments, scalar styles, anchors, and whitespace. Its callers then
applied dominant-line-ending normalization, changing even an untouched body.
Non-string existing IDs could also be replaced because the guard checked only
the parsed string ID.

Changes:

- Insert one ID line by slicing the original source; validate the resulting
  mapping without serializing it.
- Preserve the complete old source, including BOM, mixed LF/CRLF, blank lines,
  closing delimiters, and an absent final newline.
- Accept empty/comment-only envelopes; protect existing IDs of every YAML type.
- Reject malformed/unclosed or incompatible YAML representations with a file
  path in the error, leaving the note unchanged.
- Use the existing atomic raw-byte writer for sync, incremental assignment,
  and migration. Keep history snapshots and migration backups/rollback.

Regression coverage includes presentation details, LF/CRLF/BOM combinations,
empty/no frontmatter, non-string IDs, malformed YAML, unsafe root forms, all
three filesystem assignment paths, repeat scans, raw-byte history recovery,
migration rollback, and rejected operations leaving source bytes intact.
Seven initial regression tests failed against the old implementation before
the fix was applied; filesystem failure coverage was then added.

## Verification after the first block

- `cargo test --manifest-path src-tauri/Cargo.toml id_insertion`: 9 passed
  (8 newly added tests plus one existing regression).
- `npm run verify:full`: passed, including 400 frontend tests, 155 Rust tests,
  strict Clippy, formatting, and current generated bindings.
- `npm run build`: passed.
- `git diff --check`: passed.
- The roadmap copy is byte-identical to the supplied file (`cmp` passed).
- Browser smoke with `npm run dev -- --host 127.0.0.1 --port 1425 --strictPort`:
  workspace loaded, the welcome note opened, and no warning/error console logs
  were observed. This is only a browser-fallback smoke test.
- Native `npm run tauri dev` UI testing was not run: this session did not
  establish isolated desktop app-data storage, so a launch could reopen the
  user's vault. The changed Rust paths were exercised against temporary real
  filesystem vaults; this is not a replacement for a Tauri/IPC desktop E2E run.

No commands or IPC types changed; generated bindings are unchanged. No
existing vault migration was executed outside disposable test fixtures.

## Second block — Phase 1: namespaced identity

Implemented `amby-id` as the service field with one backend constant. Generic
`id` stays user-owned; a canonical ULID without `amby-id` is a read-only legacy
compatibility candidate. Explicit namespaced values win, including invalid
values that require diagnostics rather than fallback.

The existing confirmed migration now previews legacy candidates as well as
missing IDs and writes version-2 journals. It copies the legacy value into
`amby-id`, preserving generic `id`, comments, BOM, and all other bytes. Stable
IDs and durable sidecar keys do not change. Version-1 interrupted migrations
remain resumable/rollbackable, including historical YAML serialization output.
Resume and rollback now compare complete expected bytes, protecting later body
edits as well as changed IDs.

Duplicate and invalid namespaced IDs no longer hide the note. Their bodies
remain searchable and openable with distinct index keys; unsafe body saves,
restores, and durable property mutations are blocked. The editor/properties
panel shows a Russian/English warning. Conflict keys are cache-only, never
source IDs. Refresh re-reads conflicts and handles repairs without a SQLite
path collision. The one-time index identity-version marker bypasses stale
pre-upgrade metadata caches without rewriting legacy source files.

The web fallback no longer writes filesystem paths into a generic YAML `id`
when restoring a plain Markdown note. Migration confirmation text is localized
and explicitly describes legacy copying, preserved user fields, and backups.

New regressions cover external scalar/null/numeric IDs, namespaced precedence,
invalid/duplicate visibility, FTS lookup, conflict resolution, incremental
batch duplicates, legacy byte-exact migration and rollback, both historical
v1 formats, pending-v1 resume, later-edit refusal, and durable properties after
SQLite deletion/rebuild. Existing ID tests now use canonical namespaced values;
legacy fixtures remain covered separately. A temporary-directory collision
observed in the property-store tests was fixed with unique ULID fixture names.

Phase 1 and the Phase 2 insertion prerequisite are implemented. Phase 3
(high-resolution incremental change detection) is next. General malformed-YAML
body indexing remains Phase 4; desktop Tauri E2E remains Phase 7.

## Verification after Phase 1

- `npm run verify:full`: passed (401 frontend tests in 64 files, 166 Rust
  tests, TypeScript, ESLint, formatting, Knip, strict Clippy, and bindings).
- `npm run rust:test`: passed; the full pipeline also ran the final expanded
  Rust suite. Eleven new backend identity regressions and one browser storage
  contract regression were added in this block.
- `npm run build` and `git diff --check`: passed.
- Isolated browser smoke rendered the actual DocumentEditor and InfoPanel with
  synthetic conflict and healthy note properties. Conflict: localized warning,
  CodeMirror `contenteditable=false`, property creation disabled. Healthy note:
  warning gone, `contenteditable=true`, property creation enabled. No browser
  errors or warnings. The temporary HTML fixture was removed after the check.
- Native Tauri UI/IPC E2E was not run; filesystem scenarios used temporary Rust
  test vaults. No user vault was migrated. No Tauri permissions or IPC shapes
  changed, and generated bindings remain unchanged.

For an already-open conflict tab, refresh the vault and close/reopen that tab
once the external YAML repair is complete so its cached note properties reload.

## Third block — Phase 3: precise incremental indexing

The same-second/same-size `cat` → `dog` regression failed against the previous
index cache, then passed with precise timestamps. Both full scans and individual
note upserts now store nullable Unix nanoseconds in `mtime_ns`; existing seconds
remain unchanged for UI/IPC dates. Missing/unrepresentable precise stamps never
qualify for a cache hit. Existing SQLite indexes upgrade transactionally, retain
their data, and re-read old rows once. Failure injection verifies that an
interrupted schema upgrade rolls back; repeated initialization is safe. The
version marker and cache-only recovery procedure are documented in the vault
format contract. No source-file or durable-sidecar migration is required.

Watcher callbacks enqueue paths before emitting events. Active refreshes bypass
metadata skips for those paths, including descendant notes for folder events.
OS overflow/rescan flags, pathless change events, and watcher errors invalidate
the whole vault. Other notes retain the cold-scan fast path. Queues belong to
one activation, preserve events arriving during a refresh, and retain failed
batches for retry. Root/folder events also reach open descendant buffers through
the existing clean-reload/dirty-conflict handling.

A separate persistent content hash was considered and is not needed here:
invalidated files are read directly, and existing fast self-write fingerprints
already distinguish Amby writes from external edits with identical metadata.
This avoids a new dependency, persisted hash format, and hashing every file on
cold startup. The intentional cold-scan limitation remains: an edit made while
the watcher is inactive that restores the exact precise mtime and size can
still match the metadata cache.

Eight backend regressions cover same-second edits, precise individual upserts,
same-timestamp native watcher events, FTS/tags/link-target updates, failed-refresh
retry, old-schema upgrade and rollback, folder/rescan invalidations, stale
self-write records, and vault-generation isolation. Two frontend regressions
cover file/ancestor/root matching and exclusion of similarly named siblings.

## Verification after Phase 3

- `npm run verify:full`: passed (403 frontend tests in 64 files, 174 Rust
  tests, TypeScript, ESLint, formatting, Knip, strict Clippy, and bindings).
- Real macOS `notify` integration passed on a disposable filesystem vault:
  external content changed with exactly equal mtime/size, then watcher → active
  refresh updated FTS search, tags, and resolved link targets. In the sandbox,
  the OS watcher received no events and timed out; the same test and full gate
  passed outside the sandbox. No user vault was opened or modified.
- Targeted frontend reconciliation/component lifecycle checks: 13 passed.
- `npm run build`, `git diff --check`, and byte-for-byte comparison of the
  roadmap copy with the supplied original: passed.
- Native Tauri window/IPC E2E and Windows/Linux watcher runs remain unverified.
  The real macOS backend integration does not substitute for those checks.
- No IPC type or Tauri permission changes; generated bindings are unchanged.

Phase 3 is implemented. Phase 4 (indexing bodies with malformed YAML while
preserving the source and diagnostics) is the next block.

## Fourth block — Phase 4: malformed frontmatter

Closed invalid YAML and non-mapping roots no longer remove notes from the tree
or index. Paths, filename/title fallback, body headings, body tags, wiki links,
word counts, and FTS text remain available. Unterminated frontmatter is explicitly
classified and its full source is indexed, since a body boundary cannot safely
be inferred. Read-only preflight excludes all these forms from ID migration.

Malformed notes use disposable path keys distinct from invalid/duplicate-ID
conflicts. A closed envelope remains byte-exact during body saves, including BOM
and mixed YAML line endings; body formatting uses the established convention.
An unterminated envelope is editable only as full source, never automatically
repaired. Opaque-note revisions cover the complete source so YAML-only external
edits also reject stale saves. Snapshots, atomic writes, and no-replace restoration
remain in use. Moves rebase the path key without adding an ID. Stale keys cannot
save after external repair or a boundary change; refresh/reopen loads the repaired
identity. Durable properties remain unavailable under opaque keys, and backend
property mutations also recheck YAML before a watcher refresh has occurred.

The editor and properties panel distinguish malformed-YAML warnings from ID
conflicts. Body editing remains enabled for malformed YAML; property editing is
disabled. Unterminated text forces Source mode. Existing duplicate-ID protection
remains read-only. Russian and English translations were added. Generated IPC
properties now expose `frontmatterStatus` and `bodyReadOnly`; generated bindings
were updated by the Rust exporter, not edited manually.

Link refactors restrict replacements to the Markdown body of invalid closed
envelopes and preserve raw bytes on publication/rollback. Unterminated sources
are excluded from automatic replacements. Recoverable YAML warnings now consume
completed watcher events; enumeration/read/UTF-8 failures abort indexing and
retain the prior cache plus pending events for retry. This prevents both invisible
notes after a read failure and indefinitely retained events after a YAML warning.

Nine new backend regressions cover malformed lists, indentation, scalar/array
roots, missing fences, search/tags/links, title fallback, exact body saves and
history, YAML-only conflicts, explicit source repair, property refusal, path-key
move/restoration, protected link refactors, and read-failure retry. The existing
ID-insertion-failure regression now expects opaque keys for malformed YAML and
conflict keys for actual identity problems. Four frontend policy tests verify
editing, Source enforcement, and continued ID-conflict protection.

## Verification after Phase 4

- `npm run verify:full`: TypeScript, ESLint, 407 frontend tests in 65 files,
  Prettier, Knip, Rustfmt, strict Clippy, and 183 Rust tests passed. The command
  exits nonzero only at its final `bindings:check`, whose `git diff --exit-code`
  compares intentional uncommitted generated IPC changes with HEAD. The check
  was not bypassed, and files were not staged just to make it pass.
- Repeated `cargo test --manifest-path src-tauri/Cargo.toml export_bindings`
  followed by `cmp` against the prior generated file: byte-identical. Bindings
  are current; include them with the Rust type changes when committing.
- `npm run build` and `git diff --check`: passed.
- Isolated Browser smoke rendered the real DocumentEditor and InfoPanel with
  synthetic properties. Invalid closed YAML: Live Preview remained editable and
  delivered content changes; property creation was disabled. Unterminated YAML:
  actual CodeMirror Source remained editable and delivered complete-source edits.
  ID conflict: `contenteditable=false` and read-only warning retained. Visual
  inspection passed, with no browser warnings/errors. Temporary HTML, browser
  tab, and dev server were removed/stopped afterward.
- Native Tauri window/IPC E2E and Windows/Linux runs remain unverified. Backend
  filesystem/history/restore scenarios used disposable vaults; the full suite
  also ran the real macOS watcher integration. No user vault was opened or
  migrated, and no Tauri permission was broadened.

## Phase 6 — Query tokenization

Implemented a single tokenizer used to construct FTS queries. It splits every
non-alphanumeric, non-underscore character as a boundary, preventing punctuation
from merging adjacent words (`foo-bar` no longer becomes `foobar`). The resulting
terms are the only values quoted into a fixed `AND` expression of FTS prefix
searches, so FTS operators and quoting supplied by a user cannot alter query
syntax.

Tests cover punctuation boundaries, Unicode words, intentional special-query
behavior, FTS syntax input, and an indexed-search regression showing that
`foo-bar` matches `foo-bar` but not `foobar`. `cargo fmt --check`, strict
Clippy, all ten `index::query` tests, and the complete 189-test Rust suite
passed. The same-metadata watcher integration now uses a content-aware
`PollWatcher`, avoiding the unavailable native event feed inside the sandbox
while continuing to exercise event invalidation and index refresh.

## Phase 7 — Desktop reliability suite

Implemented a compact, headless reliability suite at
`src-tauri/src/desktop_e2e_tests.rs`. Every case creates and removes its own
real vault, then exercises the same persistent backend lifecycle used by the
desktop commands: `VaultContext` activation, SQLite index, atomic note writes,
and watcher invalidation. It deliberately does not use the browser localStorage
adapter or a user vault.

`npm run test:e2e` covers save → close → reopen, flush-before-rename (no stale
file), dirty-vault flush before switching, external edit/delete/rename/create
refresh, failed stale save, failed collision rename, malformed YAML, an external
generic `id`, and CRLF+BOM/frontmatter/opaque-Markdown preservation with
duplicate IDs left on disk. `npm run test:e2e:large` is an opt-in regression
signal that measures initial scan, reopen, one-file update, and search for
1,000 notes by default; set `AMBY_E2E_LARGE_VAULT_SIZE` to `5000` or `10000`
for the other roadmap sizes.

The native Tauri WebView/IPC driver and Windows/Linux runs remain release-gate
work, because they require platform-specific GUI automation and must not be
silently represented by this deterministic backend suite.

Verification: `npm run test:e2e` passed (7 tests); `npm run test:e2e:large`
passed at 1,000 notes, reporting initial scan 140 ms, reopen 50 ms, one-file
update 36 ms, and search below 1 ms on the development machine. Rustfmt,
strict Clippy, all 196 Rust tests, and generated IPC-binding verification
passed. `npm run verify:full` reached formatting and stopped only because the
pre-existing user edit to `AMBY_CODEX_ROADMAP.md` does not satisfy Prettier;
the touched E2E file itself passes Prettier. Phase 8 (storage contract tests)
is next.

## Phase 8 — Storage contract suite (in progress)

`src/lib/storage/storage-contract.test-support.ts` now defines one reusable
browser-storage contract. It covers folder and nested-note creation, read,
write and overwrite, rename, recursive listing, deletion, missing paths,
name collisions, and the required Unicode paths (`Заметка`, `Нотатка`,
`日本語`, `emoji🔥`, and a folder containing spaces). The browser adapter runs
the contract against a fresh `localStorage` map for every test. It now rejects
missing reads, duplicate folders, rename collisions, and deletion of a missing
item rather than silently manufacturing an empty value or success.

The focused browser suite passes with 13 tests and the full frontend suite
passes with 409 tests. A real backend reliability suite already covers actual
temporary vaults in Phase 7, but it is not represented as a Tauri adapter
contract: testing generated `DesktopAdapter` invocations against a live Tauri
WebView still needs a native GUI driver. That remaining platform-native portion
must remain explicit before Phase 8 can be marked complete.

## Phases 9, 12, 13, 15, and 16 — release preparation

`docs/filesystem-security.md` records the vault-path security matrix and the
remaining pathname TOCTOU limitation. Existing path, symlink, recycle-bin,
atomic-write, and mutation regressions are the enforcement suite. `README.md`
now describes the actual storage/IPC architecture, source-of-truth model,
namespaced identity, preservation policy, and browser fallback limitations.

`tests/fixtures/compatibility-vault/` is a permanent compatibility corpus. A
Rust test copies it to a unique temporary vault, rebuilds SQLite from scratch,
asserts source bytes are unchanged, and performs a safe body save while
retaining its frontmatter envelope. `docs/performance-baseline.md` documents
the reproducible 1k/5k/10k command; the generator now varies folders, tags,
wikilinks, body length, and Unicode. `docs/release-1.0-checklist.md` separates
verified local gates from the required native and multi-platform release gates.

Phase 10's backend cleanup remains intentionally limited to the already-split
bundle and index modules: further frontmatter/AI file moves would be unrelated
churn without a correctness benefit. Phase 11 likewise remains deferred until
there is a concrete orchestration defect; current focused workspace lifecycle
tests cover the existing hooks. Native Tauri adapter/UI E2E and Windows/Linux
release checks cannot be completed from this headless macOS session.
