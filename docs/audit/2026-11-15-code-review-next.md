# Code review 2026-11-15 — what is not fixed

Status: a task for a new session without context. Branch `dev`, the Amby Notes repository. The source is
[the full review report](2026-11-15-code-review.md): each finding there has its evidence and verification status.
Finding numbers (SAVE-07 and so on) come from it. Reply to the owner in Russian.

Not fixed: **114 findings** — 48 Medium and 66 Low, plus the tails of three already-fixed findings and two owner items (TREE-01, TREE-02).

## How to work

1. Read `AGENTS.md` (the project rules) and, for each finding, its description in the report.
   Line numbers in the findings are as of 2026-11-15; after fixes already made they may have shifted. Search by
   function name or code fragment and first make sure the problem is still there.
2. For each finding: first a test that fails on the current code; then the fix; then the test goes green.
3. Checks: `npm run typecheck`, `npm run lint`, `npx vitest run --maxWorkers=3`, `npm run build`; for Rust —
   `npm run rust:test`, `npm run rust:clippy`; for `sync/` — `npm run sync:test` and
   `cargo clippy --manifest-path sync/Cargo.toml --workspace --all-targets -- -D warnings`.
4. Write the entry in Russian in `updates/upd_next.md` (a section without a version change). Each fix is a separate
   commit to `dev`. Push and tags only at the owner's separate request.
5. Changes to IPC commands and to types that go into `src/lib/bindings.ts`: the `amby-ipc-change` skill. Visible texts:
   the `amby-ui-strings` skill.

## Important to know (learned in the previous session)

- Add every new `logger.*(...)` event or `tracing::...!(event = ...)` as one line in
  `src/lib/debug/allowed-events.txt` (after MOD-07 it is the only allowlist; both Rust and the
  interface read it). Otherwise the entry becomes an unnamed `diagnostic.invalid_event`. After Rust changes, run vitest too.
- Do not run `src-tauri/target/debug/amby-notes` by hand: at startup it overwrites `src/lib/bindings.ts`, and
  Vite reloads the open dev window.
- The window-management tool does not distinguish the test build from the installed Amby (one identifier,
  `amby-notes`). Do not use it for native checks; ask the owner for a live check
  (`npm run tauri dev`, a test vault).
- If the Mac goes to sleep, the full vitest run fails with random tests lasting ~900 s. Rerun the failed files
  separately, and repeat the full run later.
- Script edits: look for the boundaries of the piece being replaced only after the start of the piece; after the edit, check the file
  size.
- In auto mode, write state-changing git commands as `rtk git ...`.

## Owner decisions — do not proceed without an answer

- ~~**CORE-05**~~ — decided 2026-11-17: a foreign `id` (even a ULID) is never carried over into `amby-id`; such a
  note gets a new `amby-id`, and the `id` field is left untouched. Done (`94343ad6`).
- ~~**MOD-01**~~ — decided 2026-11-17: the key is rotated now. The old `amby-official-2026` is revoked, the new
  `amby-official-2026-11` is kept only in the owner's Keychain. Done (`ed0ffdf1`).
- ~~**CORE-15**~~ — decided 2026-11-17: in the archive, links are updated (wiki links too), the trash is
  not touched; backups, history, `.obsidian`, `.git` and other service folders are never changed.
  Done (`06947419`).
- ~~**UI-06**~~ — decided 2026-11-17: minimum macOS 13 Ventura (`minimumSystemVersion` in
  `tauri.macos.conf.json`), a fallback `vh` before `dvh`. Done (`2d5d70c`).
- ~~**IPC-03**~~ (per-window restriction) — decided 2026-11-17: do not restrict. A note window remains a
  full window; the main window shows the same notes with full rights, so the restriction gives almost
  nothing. The work is parked in the branch `fix/ipc-03-window-commands` and is not merged into `dev`. The first part of
  IPC-03 (Rust accepts only paths it has issued) is done.

## Order

First, the seven Medium findings closest to the data: SAVE-07, SAVE-06, SAVE-08, CRE-01, CRE-02, SHELL-01, SYNC-01. Then the remaining Medium, then Low.
Within groups the order is free; effort (S/M/L) is given for each finding.

## Added by the owner 2026-11-16

Not from the review; it arrived after it. TREE-01 belongs with the findings closest to the data (right after the seven Medium above).

### TREE-01 — a deleted folder without notes stays in the tree (Medium, S–M)

Symptom: after deletion the folder hangs in the tree; deleting again gives "Could not delete 1 of 1" («Не удалось удалить 1 из 1»), and the log has
`file.delete_failed` with `failureCode: notFound`. The folder is already gone from disk (it went to the trash), and sync marked it
deleted. After a restart the ghost disappears: the tree is read from disk at startup.

Condition: the folder contains no `.md`, `.canvas`, `.excalidraw` — an empty folder or a workshop folder (only `.json`).

The chain (found by reading the code, not reproduced by a test):

1. `recycle_bin.rs`, `collect_markdown_paths`: only `.md`/`.canvas`/`.excalidraw` files go into `deleted_paths`;
   the folder itself does not get there. For such a folder the list is empty.
2. `commands/mutations.rs`, `sync_mutation_result` → `tree_patch_for(..., &mutation_paths(&result))`: there are no paths.
   `vault/tree_patch.rs`, `patch_for_paths` on empty input returns `Some(TreePatch { ops: [] })` — "no changes"
   instead of `None` ("re-read").
3. `workspace-orchestration.tsx`, `applyMutationResult`: there is a patch → `patchTree` applies zero operations and
   returns `true` (`use-vault-data.ts`); the fallback `applyTreePatch` is not called (and it also looks at the empty
   `deletedPaths`).
4. The watcher does not help: `delete_item_inner` via `prepare_write` marks the disappearance of the folder in advance as its own
   write.

Also: in the index (`project_workshops` in `notes.db`) the record of the deleted workshop remains — check that
deleting a workshop folder removes it from the catalog.

Direction: put the root path (`preview.original_path`) into the deletion result — for example, into `also_touched` —
so that the patch removes the folder itself; treat an empty patch for a non-empty mutation as "don't know" (`None`). Test first:
deleting an empty folder and a folder with only `.json` removes it from the tree without a reload (Rust: the patch contains `Remove`;
frontend: no row in the tree). Check the same for archiving (`archive_item_inner`) and permanent deletion.

### TREE-02 — setting "Click on a folder only expands it" (new, S–M)

Currently a click on a folder name in the tree opens it as a card tab (a collection): `tree-row.tsx` → `onSelect` →
`use-collection-folder-select.ts` (a workshop folder opens the workshop) → `use-document-loading.ts`
`handleSelect`/`openTreeItem`. Only the chevron expands and collapses (`onToggleOpen`).

Needed: a switch in settings (the "Files" section next to the deletion mode, `settings-data.tsx`; a field in
`prefs.files` in `app-config.ts` with normalization and a default value — as now, that is, open).
Enabled → a click on a folder only expands/collapses it in the tree, with no tab and without opening the workshop.
The folder card can still be opened from the context menu ("Open in new tab" and so on).

To clarify during implementation: Enter/Space from the keyboard (`use-tree-keyboard.ts`) behave the same as a click; Cmd/Shift
still select rather than expand; a "folder" with its own note (`Name/Name.md`) is a note, and it
opens as before. Texts — through the `amby-ui-strings` skill (all languages). Tests: the setting at its default does not change
behavior; when enabled — a click changes `aria-expanded` and does not create a tab.

## Tails of what is already fixed

- **SAVE-04** (commits `97055924`, `9510cb00`): Cmd+Q and "Quit" in the app menu save edits. The tails are
  partly closed: an update flushes the edits of all windows between download and install
  (`flush-all-windows.ts`). Dock → "Quit" and `quit` via an Apple Event (`terminate_gate.rs`): the reply is
  `NSTerminateCancel`, then the usual `request_quit` on the event loop and exit on a 5 s timer; logout,
  restart and shutdown are not delayed. The first version with `NSTerminateLater` hung (checked natively
  2026-11-17); this one was checked natively separately (see `updates/upd_next.md`).
- **CORE-03** (commit `34ed06da`): history follows a rename and a move in Amby. Not covered:
  a rename that arrives through sync from another computer, and a rename of a file outside Amby.
- **EDIT-01** (commit `3d1d1633`): a table cell is one paragraph. Not checked: pasting text of
  several paragraphs into a cell.

## Medium (48)

### First: the seven findings closest to the data

- **SAVE-07** — `write_note` checks the revision and merges frontmatter before `mutation_gate`, while `write_file` does so
  inside it. A version restore from the server or a properties write between the read and the commit is overwritten by the old
  frontmatter without a conflict. → Move the check under the lock. · S / low / yes ·
  `src-tauri/src/commands/notes.rs:230-253`. Verification (sample): confirmed; the main risk is a race with a
  properties write or a restore.
- **SAVE-06** — `refreshLocalVault` (after a sync update) reads open notes one by one and
  replaces buffers according to the set of "dirty" ones taken before the loop. A note that the user began editing while another was
  being read gets the text from disk, and the next input overwrites what was typed. In addition, errors are
  swallowed without a code, and container layers are read by `id` instead of `noteId`. → Use the watcher's
  reconciliation (a fresh flag and the queue state after every `await`, a conflict when the buffer is dirty). · S /
  low / yes · `workspace-orchestration.tsx:470-486`.
- **SAVE-08** — A failure to write a recovery draft goes only to `console.warn`, and reading a draft
  on error returns `null` silently. `docs/vault-format.md` says such an error is reported. →
  A `warning` on the note card, a `logger` with a code. · S / low / yes · `src/lib/recovery-drafts.ts:174-178,361-363`.
- **CRE-01** (now Medium). Saving a sketch writes only `elements/appState/files` and `source:
"amby-notes"` (`src/components/workspace/sketch/sketch-editor.tsx:262-287`,
  `src/lib/sketch-format.ts:249-267`). Unknown top-level fields are lost; fields of individual elements
  are preserved. A snapshot in history is taken. Found in passing: `sketch-editor.tsx:203-207` on open
  turns the background `#ffffff` into `transparent` and probably writes it to disk (not verified live).
  Proposal: keep the parsed top-level fields in a ref and mix them back in on save, like
  `canvasTemplateRef` in the canvas.
- **CRE-02** — A JSON Canvas node of an unknown type (a spec extension, a new Obsidian type)
  is loaded as a text card and after any edit is saved as `type:"text", text:""`. The other
  node fields remain. In addition, on every save the coordinates of untouched nodes are rounded. → Keep an unknown
  node as is and show it as a read-only placeholder. · M / medium / yes ·
  `src/lib/canvas-format.ts:188-197`. Verification (sample): confirmed.
- **SHELL-01** — A rollback of a cancelled (answer "No" to a link rewrite) or failed move puts
  the "display" tree with the main layer's icons and types mixed in into the "raw" one. After that, resetting an icon
  or changing the main layer works incorrectly. → Use the raw tree for the rollback. · S / low / yes ·
  `workspace-orchestration.tsx:896`, `use-document-mutations.tsx:295,332,396`.
- **SYNC-01** (now Medium). The local file's hash is checked before the body is downloaded from the server, but on
  publishing it is not (`sync/core/src/engine/apply.rs:436-451` → `:601`; `src-tauri/src/sync/vault_fs.rs:383-420`).
  A note save during the download window is silently replaced by the server version, and the editor re-reads the file. This is
  mitigated: a `sync-overwrite` snapshot is always taken before the replacement, even with history off, so
  the text can be recovered from history. A weak spot the author did not mention: for a file new from the server
  there is no snapshot, and a file the user created at the same path during the download is overwritten without a copy.
  Proposal: pass the expected hash into `StagedWrite::publish` and on mismatch defer the apply
  (as in the existing path С9); add a sim test "save during `RemoteKind::Download`".

### Remaining Medium

- **IPC-01** (now Medium). "Show in Finder" for a vault does not work on the start screen and for
  inactive vaults: `paths::guard` requires an active vault (`src-tauri/src/commands/assets.rs:162`),
  and nobody awaits the promise or catches the error (`vault/vault-manager.tsx:167`). "Open folder"
  in data settings is broken the same way (`settings-data.tsx:61`). Data is not affected. Proposal: a separate command
  `reveal_vault_folder(id)` based on the vault registry, and a reply under the menu item.
- **MOD-01** (now Medium, known). The private key of the "official" signature
  (`src/lib/modules/package-manager/validator.ts:268`, `scripts/build-modules.mjs:16`) is the pair of the production
  public key (`src-tauri/src/package_manager.rs:16`); the tests prove it. Already recorded as an open
  deferred risk in `docs/security-advisories.md:62-90`. Safe for now: installed modules are not
  executed (`INSTALLED_MODULE_EXECUTION_ENABLED = false`), the install UI is hidden. It becomes High at the
  moment either of the two flags is enabled. The key stays in git history, so a key rotation is needed, not
  deleting a line.
- **SAVE-09** — The container layer ID is taken with the regex `^(?:amby-id|id):` in multiline mode (it catches a
  plain `id:` and body lines), and on failure the revision is computed as an FNV hash, which the backend does not use. As a
  result the user sees a false "changed on disk" conflict or, if the value matches the ID of another
  note, the write goes into that note. → Take the ID and revision only from the backend; keep the layer read-only
  until it responds. · S / low / yes · `file-actions/use-document-loading.ts:129-145`.
- **SAVE-10** — Renaming a canvas while a save is still queued: the write to the old path finds the
  file missing → the question "changed elsewhere" → "Overwrite" creates a copy at the old path. →
  Pause the keys and wait for the current write before renaming. · S / low / yes ·
  `file-actions/use-document-mutations.tsx:195-209`.
- **SAVE-11** (hypothesis: the mechanism is visible in the code, the effect is not measured) — `write_note` and `write_file` are
  synchronous commands. On the main thread run fsync (on macOS this is `F_FULLFSYNC`, tens of ms), the history snapshot
  and SQLite, while keyboard input in the WebView goes through the same event loop. On slow and network
  disks typing may lag. → First measure (`note.write` telemetry), then `async` plus
  `spawn_blocking`, after SAVE-07. · M / medium / no · `commands/notes.rs:193`.
- **SAVE-12** — `use-canvas-workspace.ts` and `use-sketch-workspace.ts` are near copies; SAVE-01 and SAVE-05
  have to be fixed in both. → One `useLayerWorkspace({kind, validate, emptyJson})`. · M / low / no.
- **SAVE-13** — The "integration harness" and the stress test work with a fake renderer that has its own
  "dirty" state logic. They do not run the close code, the watcher reloads or `refreshLocalVault`,
  so SAVE-02, SAVE-03 and SAVE-06 pass all the tests. → Drive the real
  `useMarkdownAutosave`, the watcher callback and `useDocStore` with a fake vault port. · M /
  low / yes · `autosave/autosave-integration-harness.test.ts:96-188`.
- **EDIT-03** — `[draft](todo)`, `a <b> c`, `<!-- later -->` typed in Live become, after reopening,
  a link, an HTML atom or a comment. A link or image address with a space stops being a
  link. An image caption ending in `\` breaks the image. The save-time check compares against
  `parse(normalized)`, which is wrong in the same way. → Escape `[ ] <` in the middle of a line, write addresses as
  `<…>`, and in tests compare the document, not `textContent`. · M / medium / yes ·
  `markdown-serializer.ts:38,59-65,424-425,509`; `markdown-block-source.ts:296-308`.
- **EDIT-04** — The invariant "an edit rewrites only its own block" is checked on an editor with only the
  schema, without the plugins (IndentShortcut, BlockAnchors, `fixTables`) that append their own transactions.
  Today there is no leak, but a future plugin will create one, and the tests will stay green. → Build the test
  editor through `buildExtensions(...)`. · S / low / no · `markdown-block-source.test.ts:282-288`.
- **EDIT-05** — `TiptapEditor.tsx` (1043 lines, 18 commits) mixes the serialization lifecycle with
  menus and pointer heuristics. A recurring class of fixes ("which DOM event came first")
  lives exactly here, and EDIT-02 is of the same class. → Extract serialization into
  `use-editor-serialization.ts` with tests; do not touch the menus. · M / medium / yes.
- **CORE-04** — Every note open calls `apply_id_migration`, and under `mutation_gate` it reads and
  parses every `.md` of the vault, even when there is nothing to migrate. With 10 thousand notes that is tens of MB per
  click and a block on all saves. → Assign IDs to new files in the watcher and index path (it reads
  them anyway); a full pass only on vault open. · M / medium / yes ·
  `desktop-adapter.ts:795-799`, `vault/migration.rs:525-609`, `commands/vault.rs:178`. Verification
  (sample): confirmed.
- **CORE-05** — The preliminary pass plans moving the legacy `id` (ULID) into `amby-id` for every
  note, and `use-vault-data.ts:339-341` applies it without confirmation. The document and a code comment
  promise a preview and confirmation. The write is reversible (there are backups), but the consent rule is not
  met. → The owner's decision: show it for confirmation or fix the document (section 7). · S /
  low / yes · `frontmatter.rs:243-249`, `docs/vault-format.md:166-176`.
- **CORE-06** — `preflight_vault`, `apply_id_migration` and `recover_id_migration` accept any folder and
  only canonicalize the path. Any window can write `amby-id` into all `.md` files of the home folder. → Accept
  only the active vault or a path issued by the system dialog (see IPC-03). · S / low / yes ·
  `commands/vault.rs:165-185`.
- **CORE-09** — For watcher fingerprints, renaming or moving a folder reads every file of the subtree
  in full (`fs::read` plus SipHash) 2–3 times under `mutation_gate`: moving a folder with 3 GB of video is 6–9 GB
  of reading and memory allocation the size of the file. → Fingerprint by metadata (size, mtime, inode) for
  moved files; hash only rewritten ones. · M / medium / yes · `watcher.rs:291-315,384-395,446-462`.
- **CORE-10** — About 100 post-mutation lines (rollback of the link-rewrite plan, `sync_path_changes`, the tree
  patch, projection) are duplicated in `rename_item_inner` and `move_item_inner`. Fixes in the history came
  in pairs. → A shared `finish_path_mutation(...)`. · S / low / no · `commands/mutations.rs:1032-1112` and
  `:1318-1395`.
- **IPC-02** — `read_app_data` and `write_app_data` accept any relative path in app-data, including
  `codex/auth.json` (ChatGPT tokens) and `claude/settings.json`. `write/delete_vault_meta` reaches any file in
  `.amby/` bypassing `mutation_gate`. API keys, by contrast, live in the keychain. → An allowlist of names in Rust,
  `write_vault_meta` under the lock. · S / low / yes · `src-tauri/src/app_data.rs:79-94,166-193`. Verification
  (sample): confirmed. Not verified whether a Claude launch ignores hooks from this `settings.json`.
- **IPC-03** — The path from the system dialog and drag-and-drop paths pass through JS, and Rust trusts the string:
  `load_vault` (switch the vault to `~`, grant the asset protocol access to all of `~` until the end of the session),
  `apply_id_migration`, `import_asset` and `import_files` (copy `~/.ssh/...` into the vault). → Remember
  in Rust the paths issued by the dialog or the drag-and-drop event and accept only those; when the vault changes,
  revoke the old access scope. · M / medium / yes · `commands/vault.rs:13-58`, `assets.rs:44-46`,
  `import_files.rs:59`.
- **IPC-04** — Four copies of "open with the system program" have diverged:
  - `open_in_explorer` on Linux opens the file itself (`xdg-open file`), bypassing the extension allowlist of
    `open_attachment`;
  - on Windows `/select` receives a `\\?\…` path; `external.rs` knows this case and fixes it, here it is not handled
    (hypothesis, not run on Windows);
  - processes are not awaited (zombies until the app exits);
  - errors are returned as raw text.

  → One `system_open.rs` module modelled on `external.rs`. · S / low / yes · `assets.rs:156-188`,
  `debug.rs:107-130`, `ai/codex/launch.rs:241-255`.

- **IPC-05** — The shared vault contract (4 cases, no move) runs in CI only against the browser
  adapter. The native run is manual. And the browser adapter already diverges from Rust: `moveItem` silently
  overwrites a file with the same name, the name is not truncated, `archiveItem` deletes permanently. → Add cases
  for move, collision, name truncation and archive; in the web adapter, refuse instead of imitating; run the native suite in CI
  (TOOL-08). · M / low / yes · `storage/storage.test.ts:31`, `web-adapter-core.ts:1159-1237`.
- **IPC-06** — Vault error categories are determined by regexes over English text with the user's path baked
  in. A folder named «Collision notes» turns "Permission denied" into "already exists". → A typed
  `{code, detail}` from the vault commands (Specta enum), one command at a time. · M / low / yes ·
  `src/lib/storage/operation-error.ts:15-27`.
- **IPC-10** — A new vault command means editing 8 files (Rust, registration, bindings, `port.ts`, two
  adapters, the repository, the wrapper in `index.ts`). 82 one-line forwarders in the repositories explain why
  `index.ts` (41 commits), `desktop-adapter.ts` (37) and `web-adapter-core.ts` (34) are at the top by change
  frequency. → Evolutionary: freeze the forwarding repositories, deliver new capabilities through a port, as
  database and project do. No one-shot merge. · M / low / no.
- **DB-01** — Editing a single cell: `find_database_container` → `discover_vault` parses the whole vault,
  then the container is walked for every affected note (the index is only a fallback path), then once more in the
  projection. All of this happens under `mutation_gate` and the `conn` lock, and this pattern occurs in about 30 places.
  Inserting 100 cells on large vaults blocks note saves. → Take the path from the `db_members` or `notes`
  index and verify by reading a single file; the container comes from `db_databases.container_path`.
  · M / medium / yes · `database/mutations/value_batch.rs`, `mutations/support.rs:54-100`. Check
  (sample): confirmed.
- **DB-02** — A new row, property or rename → a full rebuild of the projections of all databases in the vault
  inside the locks. A step-by-step path already exists for value edits. → Limit the rebuild to the affected database. ·
  L / medium / yes · `commands/database.rs:415…1371`, `projection.rs:109`.
- **DB-03** — A single error-level diagnostic anywhere in the vault (an unreadable `.md` outside databases, a duplicate
  `amby-id`) makes all rebuilds "unpublished": the created row is written but does not appear in any
  database. Value edits in existing rows go through. → Treat errors outside the container as warnings for the projection,
  or freeze only the affected database. · M / medium / yes ·
  `projection.rs:116-146`. Check (sample): confirmed.
- **DB-04** — On every render `defaultPropertyWidth` parses the JSON of every loaded row 2–3 times
  (1000 rows × 10 properties ≈ 20–30 thousand `JSON.parse` calls), and this repeats on every scroll step. →
  A memoized `Map<propertyId, width>`. · S / low / no · `table-view.tsx:168-179,496-524`.
- **DB-06** — `commands/database.rs` (2226 lines) is not a thin boundary: the sequence
  "lock → generation → projection → notification" is copied about 15 times, SQL is assembled inside,
  warnings are compared by English text. → A shared `run_database_mutation(...)` with a typed
  `ProjectionOutcome`; move the summary SQL into `database::summary`. · M / low / no.
- **CRE-03** — Completed logs in `.amby/recovery/creative/` (up to 256 KB each) are never deleted and
  are parsed on every vault open. → On open, delete completed ones older than N days. · S / low
  / yes · `src-tauri/src/project/journal.rs:234`.
- **SHELL-02** — The link graph (all notes and all edges) is re-read over IPC 150 ms after every
  tree change, even when the graph and the links panel are closed, and a new object at the root re-renders the whole
  workspace. → Load lazily, when the graph is actually needed. · M / medium / yes ·
  `use-vault-data.ts:539-573`.
- **SHELL-03** — The notices centre and the AI panel subscribe to the whole `openDocs`, so while typing
  every deferred publish recomputes the centre's sections and re-renders the docs. → A selector over
  `{id, path, flags}` and `useShallow`. · S / low / no · `notices/use-notices-centre.ts:25`, `ai-panel.tsx:78`.
- **SHELL-04** — The root passes about 110 inputs into `usePaneRenderers` and about 70 props to each layout,
  with no memoization barrier. Any slice change re-renders the whole shell, and every new feature
  is an edit in 3–4 places (hence 51 commits). → In steps: (1) overlay flags go into a small store; (2)
  layouts and panels select their own slices; (3) extract `use-active-document`. · L (in parts) / medium
  / no · `workspace-orchestration.tsx:1412-1726`.
- **MOD-05** — Two "download and enable" handlers in `settings-modules.tsx` on failure write only
  `console.error`, and nothing happens. The neighbouring `settings-package-manager.tsx` does it right
  (`reportInstallFailure`). The `v0.1.4` URL is copied several times. → One install path with a notice,
  a `catalogDownloadUrl` helper. · S / low / no · `settings-modules.tsx:645,814`.
- **MOD-06** — `ModulesTab` is a single closure of about 1000 lines with about 19 `useState`; MOD-05 appeared
  here precisely because of copy-paste. → Extract `useModuleInstallFlow`. · M / medium / yes.
- **MOD-07** — About 350 lines of `ALLOWED_EVENTS` in `logging.rs` and a mirror in `src/lib/debug/event-codes.ts`.
  Every new event is an edit in three places, and an omission in production silently turns into
  `diagnostic.invalid_event`. This is the main reason `logging.rs` changes so often. → Keep the allowlist (it is
  a privacy control), but hold it in a single data file: in Rust via `include_str!`, plus a TS filter. · M /
  low / no · `logging.rs:965-1320`.
- **UI-01** — The notice-rules check verifies colours and `text-destructive` only in the listed
  files. Outside them there are 64 red `role="alert"` blocks and 28 palette classes (for example,
  `BubbleToolbar.tsx:614`). One level looks three different ways, and themes cannot recolour it. → A rule
  instead of a file list, plus a baseline list of current offenders that can only shrink. · M / low / yes.
- **UI-02** — Action failures ("New note", following a link) go only to `console.error`:
  `use-document-crud.ts:480,535`, `use-document-loading.ts:379`, `use-wiki-navigation.ts:61`, 49
  calls in 19 files in total. → A line next to the element or a `warning` in the centre with a code; a rule in the check "no
  `console.error` without `logger`" with a baseline list. · M / low / yes.
- **UI-03** — 316 of 3696 localization keys (8.5%) are not used anywhere, for example `settings.debug.*`
  (44) and `settings.modules.*` (28). → An "unused keys" test with an allowlist of dynamic prefixes, then
  delete in one batch. · S / low / no.
- **UI-05** — `scrollbar-width` and `scrollbar-color` (`app.css:743,6548`) contrary to the "Browser engines" rule:
  on WebView2 `::-webkit-scrollbar` stops working, and on Windows the database table scrollbar loses its look.
  → Only `::-webkit-scrollbar`. · S / low / no.
- **UI-08** — Document tabs are a `motion.div` with `onClick`, without `role` and `tabIndex`, so they
  cannot be reached from the keyboard. → `role="tablist"`/`tab`, arrow keys. · M / medium (interaction with
  drag-and-drop) / yes · `header-tabs.tsx:313-360`. Check (sample): confirmed.
- **UI-09** — `ImageLightbox.tsx:86` and the centred variant of `database-side-peek.tsx:73` set
  `aria-modal`, but neither move, trap nor restore focus. → Radix `Dialog`. · S / low / no.
- **TOOL-02** — Signing the CLA by comment cannot work: `issue_comment` is run from the default branch,
  and `main` has no `cla.yml`. → Move it into `main` or state in CONTRIBUTING that signing does not work
  yet. · S / low / no.
- **TOOL-08** — The only tests that go through the real `DesktopAdapter` → IPC → Rust
  (`tests/native/*`, about 170 KB) do not run in any CI. → Try `test:storage:live` on a
  macOS runner with `continue-on-error`; if the WebView does not come up there, record that in `tests/MAP.md`. · M /
  low / no.

## Low (66)

| SAVE-14 | «Принять внешнюю» (Accept external) leaves the draft; on open it is offered again | `external-conflict-dialog.tsx:85-126` | Delete the draft on `acceptExternal` | S |
| SAVE-15 | Drafts that differ only in leading/trailing whitespace or the sketch's `appState` are silently deleted as "equal" | `recovery-restore.ts:6,66-68` | Compare exactly (only line-ending normalization) | S |
| SAVE-16 | `PerKeySerialQueue` is dead code, yet the maps name it as the basis of autosave | `src/lib/per-key-queue.ts`, `autosave/MAP.md` | Delete it, point the maps at `note-mutation-queue.ts` | S |
| EDIT-06 | Every 200 ms pause is a full serialization and 1–2 full parses (the cost is a hypothesis) | `markdown-block-source.ts:274-307` | Assemble from the block cache, skip the repeated parse | M |
| EDIT-07 | Table column width changes in Live but is not saved | `schema.ts:41` | `resizable: false` | S |
| EDIT-08 | Mixed line endings → "Source only", but the first edit in Source rewrites them, without a snapshot | `source-editor.tsx:322-364` | Document it in the matrix or take a snapshot | S |
| EDIT-09 | Numbered lists across two blank lines: Amby sees two, everyone else sees one; not documented | `markdown-block-plugins.ts:238-315` | Record it in the matrix | S |
| EDIT-10 | A failure of the admission check in Live is swallowed without a code | `note-editing-policy.ts:49-54` | `logger.warn("editor.live_admission_failed")` | S |
| EDIT-11 | Block conversions live in a UI component without tests of their own | `BlockActionsPanel.tsx:100-140,1135-1180` | Move to `block-conversion.ts` | S |
| CORE-11 | Saving a note with valid frontmatter normalizes line endings across the whole file (mixed files only) | `note_index.rs:400`, `frontmatter.rs:1628-1640` | As in the "opaque" path: a byte-for-byte envelope | S |
| CORE-12 | Rename, move, archive: an "exists" check, then `rename` — replaces a file that appeared in between | `bundle/path_ops.rs:80-98` | Rename without replacement (`RENAME_EXCL`) | M |
| CORE-13 | The "poisoned" mutex policy is applied unevenly (`.lock().unwrap()` in the watcher, `vault_context`) | `vault_context.rs:147-150`, `watcher.rs:156-159`, `database/runtime_state.rs` | `lock_or_recover` everywhere | S |
| CORE-14 | Names on create and rename are barely validated (`.git`, `CON`, `a:b`) | `bundle/execute.rs:50-53` | A shared `validate_item_name` and a repeated `confine` | S |
| CORE-15 | Link rewriting edits files in `.trash/`, `.obsidian/`, `.amby/archive` | `index/refactor.rs:243-256` | `should_descend` and replace only the link syntax | S |
| CORE-16 | `frontmatter.rs` contains the atomic-write layer (125 calls in 58 files) | `frontmatter.rs:1-200,1581-1832` | Extract into `atomic_fs.rs` | S |
| CORE-17 | Docs and maps diverge from the vault code (see section 5) | `docs/vault-format.md:440`, `agent-guidelines.md:102` | Fix them | S |
| CORE-18 | Atomic replacement drops permissions and xattrs; a name ≥ ~235 bytes cannot be saved | `frontmatter.rs:1694-1718` | A short temp-file name, copy the permissions | S |
| SYNC-03 | `path` in the synced conflict `meta.json` is not validated: a read can escape the vault (a write cannot) | `conflict_store.rs:446`, `session.rs:505` | `check_path` and reading through `VaultFs` (downgraded from Medium) | S |
| SYNC-05 | «Оставить оба» (Keep both) writes the copy with replacement and swallows errors | `sync/session.rs:676-741` | Move into `FileConflictStore`, without replacement | M |
| SYNC-06 | Four sync-event subscription failures are swallowed | `sync-notices-host.tsx:193-248` | `reportSyncListenFailed` | S |
| SYNC-07 | The temporary gate became a constant, but still goes through IPC and status | `sync/gate.rs:9` | Remove the branch, read `META_TEST_VAULT` as before | S |
| SYNC-08 | The account key and the device token are plain `String`s for the entire runtime | `sync/secrets.rs:143-182` | `Zeroizing<String>` | S |
| SYNC-09 | On failure `derive_key` would return a zero key (the failure is impossible; this is hardening) | `sync/core/src/crypto/primitives.rs:82-89` | `expect` with a justification | S |
| SYNC-10 | The list of synced `.amby` folders is stored twice; they have already diverged (`adb907ea`) | `sync/vault_fs.rs:64-70` | A single `const` from `rules` | S |
| IPC-07 | 9 dead debug "shim" commands and the `test_vault` argument | `commands/debug.rs:155-262`, `commands/sync.rs:292-301` | Delete, regenerate bindings | S |
| IPC-08 | `debug-repository` erases the generated types (`as unknown as`) | `storage/debug-repository.ts:5-32` | Call `commands.*` directly | S |
| IPC-09 | Recovery drafts and property groups go over IPC bypassing `storage/` | `recovery-drafts.ts:1,78`, `property-groups-port.ts` | A port in `storage/` or record it in the map as an exception | S |
| IPC-11 | `vault-meta` writes are not tied to the vault (a race on vault switch; timing is a hypothesis) | `app_data.rs:56-60,176-183` | `expectedGeneration` | S |
| IPC-12 | Module loading reads the whole body before the 50 MB check (duplicate of MOD-03) | `package_manager.rs:608-615` | A stream with a limit | S |
| DB-05 | An empty `expectedRevision` = "no conflict check" | `mutations/value_batch.rs:~208` | Make the revision mandatory | S |
| DB-07 | Records whose key is set by the user are on plain objects (the `Map`/`Object.create(null)` rule) | `database/use-board-lanes.ts:149-157` | `Map` + a `__proto__` test | S |
| DB-08 | A formula longer than ~64 terms fails with `formulaTooDeep` | `database/formula.rs:518-535` | Iterative evaluation | S |
| DB-09 | Large files: only `commands/database.rs` and `table-view.tsx` carry a cost | — | Split those, leave the rest alone | M |
| CRE-04 | An unreadable workshop log is silently ignored | `project/journal.rs:206-212` | Quarantine and `RecoveryRequired` | S |
| CRE-05 | Rollback deletes the workshop marker without comparing bytes | `project/recovery.rs:232-237` | Compare against the log | S |
| CRE-06 | The test workshop builder lives in the production `create.rs` | `project/create.rs:461-860` | Move to a `#[cfg(test)]` module | M |
| CRE-07 | The size of the workshop frontend (31 thousand lines, ~14 thousand of them tests) is breadth of features, not duplication | `creative/` | No separate refactoring | L |
| SHELL-05 | `secondaryTabKey`/`toggleSplit` is a dead second split model | `use-tabs-store.ts:66,129,183` | Delete | S |
| SHELL-06 | The tree helpers in `use-vault-data` are functions recreated on every render; the linter warning is not a bug, but it is fragile | `use-vault-data.ts:168-231` | `useCallback` and drop the `disable` | S |
| SHELL-07 | Settings are rewritten via an allowlist: unknown nested keys from another build are erased (downgraded) | `app-config.ts:435-537` | Keep the raw object and overlay the normalized one | M |
| SHELL-08 | `updateDockPrefs` merges into the render snapshot; `prefs` between windows is "last writer wins" | `workspace-orchestration.tsx:303-306` | Merge from `getState()` | S |
| SHELL-09 | The "special document" predicate is copied into 10+ places | `workspace-orchestration.tsx:222-226,732-770` | `isLayerDocument` | S |
| SHELL-10 | An unguarded `localStorage.setItem` in an effect; manual tree order lives only in the WebView | `panels/files-panel.tsx:218-221` | try/catch; the order goes into `workspace.json` | S |
| MOD-02 | Rust accepts unsigned `community` packages and any HTTPS address (inert for now; downgraded) | `package_manager.rs:461` | Reject `kind != official` before enabling plugins | S |
| MOD-03 | Package download reads the whole body before the size check | `package_manager.rs:608-615` | A stream with a limit | S |
| MOD-04 | No downgrade protection when publishing a package | `package_manager.rs:884-895` | Refuse when `version <= active` | S |
| MOD-08 | Aliases in the log are a non-cryptographic hash, with the salt in the same record | `logging.rs:1625-1639` | A keyed hash or document it as "for matching only" | S |
| MOD-09 | Three different definitions of "local host" in the AI code | `ai/consent.rs:46-54`, `ai.rs:299` | A single `host_class` | S |
| MOD-10 | Update failures are classified by substrings of other parties' messages | `app-updater.ts:63-69` | Pin with a test on real strings | S |
| UI-04 | `resources.ts`: structural equality is held only by the compiler; en has 31 extra `_few/_many` keys | `resources.ts` | A test for key and placeholder equality | M |
| UI-06 | `app.css` has no `@supports`, although `color-mix` (41) and `dvh` (3) are used (partly a hypothesis) | `src/themes/app.css` | `vh` before `dvh`; set `minimumSystemVersion` | S |
| UI-07 | About 38 dead classes (~100 rules, `.md-body` — 33) and 13 unused tokens | `app.css` | Delete | S |
| UI-10 | The colour buttons of the canvas panel have no accessible name | `canvas/canvas-toolbar.tsx:57-62,458-548` | `aria-label` from the locale | S |
| UI-11 | The `isEnterKey` linter rule misses `case "Enter"` and a destructured `key` | `eslint.config.js:63` | Add selectors | S |
| UI-12 | 27 hard-coded RU/EN search synonyms in the block menu | `BlockActionsPanel.tsx:211,674-680` | A locale key `blockMenu.aliases.*` | S |
| TOOL-03 | A direct `rfd = "0.16"` duplicates the dialog plugin's `rfd 0.17`; the reason in the document is outdated | `src-tauri/Cargo.toml:40` | Bump to 0.17 | S |
| TOOL-04 | `clippy::unwrap_used` is not enabled anywhere; 135 `#![allow]` suppress nothing | `src-tauri/Cargo.toml` | `[lints.clippy] unwrap_used = "deny"` | M |
| TOOL-05 | `tests/component`, `tests/e2e`, `scripts` are not checked by `tsc` | `tsconfig.json:25` | `tests/tsconfig.json` into `typecheck` | S–M |
| TOOL-06 | Linter warnings do not block the check | `package.json:21` | Fix the 4, `--max-warnings 0` | S |
| TOOL-07 | `version:check` and `test:update-channels` run only at release | `verify.yml` | Add to the `docs` job | S |
| TOOL-09 | Floating stable Rust with `-D warnings`; no MSRV, `--locked`, `.nvmrc` | `verify.yml:131,164` | `rust-toolchain.toml` and others | S |
| TOOL-10 | Actions with secrets are pinned by a mutable tag (`tauri-action@v1`) | `release.yml:244-249` | Pin by SHA; Dependabot | S |
| TOOL-11 | A stale `scripts/dev-only-paths.txt` remains on `beta`/`main` | `scripts/dev-only-paths.txt` | Add the file to the list itself | S |
| TOOL-12 | Minor map divergences (the test `empty-action.test.tsx` in the workshop map does not exist) | `creative/workshop/MAP.md:31` | Fix | S |
| TOOL-13 | `verify`/`verify:full` does not cover `sync/` (`sync:lint`, cargo-deny) | `package.json:58` | Add | S |
| TOOL-14 | Minor dependency hygiene (`@types/d3-force` in `dependencies`, overrides without a reason) | `package.json:94` | Move, document | S |
