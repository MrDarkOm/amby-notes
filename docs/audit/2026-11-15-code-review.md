# Amby Notes codebase review — 2026-11-15

Status: a snapshot on a date, not a contract. Branch `dev`, the review started at commit `1bc05acd`; during the review `9505e583` and `7b0bd586`
landed in `dev` (they commit changes that at the start were in the working copy).
The review only read the code: nothing is fixed. The method and the results of the checks are in the appendix.

---

## 1. One-page summary

**Overall state.** The codebase is in good engineering shape: all checks pass (types, linter, knip, maps,
strict Clippy, 4203 vitest tests). The most dangerous places — atomic write, path canonicalization, ID migration,
workshop and database journals, sync cryptography — are done carefully and covered by failure tests. They do not
need rewriting. The risks found sit elsewhere: on **neighboring, less-traveled paths**. A protection exists on one
path and is forgotten on the neighboring one (the archive does not let you delete the vault, but "Delete" does). A Markdown note reports a
save failure, while a canvas stays silent. The rule "there are no unsaved changes" is held in three places, and they
disagree. One more pattern is a **full vault walk on frequent operations** (opening a note, editing a database
cell). This disagrees with the recorded "mutations do not re-read the whole vault": the statement is true only
for an ordinary note save.

**Main risks to user data** (all confirmed by an independent check against the code):

1. A note in the vault root with the same name as the vault folder (`~/Notes/Notes.md`) turns
   "Delete permanently" into deletion of the **whole vault** (CORE-01).
2. With a full disk, closing the window loses text, although the card promises it is "in a draft" (SAVE-02).
3. There are three ways to lose the latest edits unnoticed: Cmd+Q does not wait for the save (SAVE-04); an action
   from the block menu done only with the mouse is not saved (EDIT-02); a race of a "clean" buffer with an external edit
   (SAVE-03).
4. A single non-UTF-8 file makes it impossible to open the vault and any note (CORE-02).

**Top 10 findings**

| #   | ID      | Severity | Gist                                                                                                                    |
| --- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | CORE-01 | Critical | A root note named after the vault folder: "Delete" and "Rename" act on the whole vault                                  |
| 2   | SAVE-02 | Critical | The window closes after a failed save even if the draft was not written; the interface promises a draft                 |
| 3   | SAVE-04 | High     | Cmd+Q and Dock "Quit" skip the save before exit: up to ~1 s of typing is lost                                           |
| 4   | EDIT-02 | High     | Delete, duplicate, "Turn into" and block color from the handle menu are not saved if there was no keyboard input before |
| 5   | SAVE-03 | High     | A scheduled autosave overwrites an external edit without a conflict                                                     |
| 6   | SAVE-01 | High     | An unreadable or "non-strict" `.canvas`/`.excalidraw` (BOM, no `edges`) opens empty, and the first edit overwrites it   |
| 7   | CORE-02 | High     | A single non-UTF-8 `.md` blocks opening the vault and all notes                                                         |
| 8   | EDIT-01 | High     | A line break in a heading or table cell is written so that it reads back differently                                    |
| 9   | CORE-03 | High     | A note's history is tied to the path: after a rename or move the "History" panel is empty                               |
| 10  | SAVE-05 | High     | A canvas or sketch save failure is invisible: no card, no "unsaved" dot                                                 |

Total: **129 findings** — 2 Critical, 8 High, 53 Medium, 66 Low. Each Critical and High was checked by a separate
verifier who saw only the claim and the references. All were confirmed; four High were downgraded to Medium,
one Critical to High. Of the Medium/Low, 14 findings were checked by sample: none was refuted, three were downgraded.

**What is in good shape and does not need touching:** the atomic-write core and `paths::confine`; seamless YAML
editing; ID migration (journal, backups, rollback); the "a block keeps its source text" design in the editor;
`AutosaveCoordinator`; workshop journals; database projection (it can be rebuilt without loss); sync cryptography
and the protection against a malicious server; the debug log (allowlists, no raw errors);
`commands/external.rs`; `promote.mjs`.

---

## 2. Assessment by area

The trend comes from the commit history: the number of commits touching the area in the last 30 days against the previous
60 days (in parentheses — commits with the `fix` subject). To compare the pace, divide the second number by two.

| Area                         | State                                                                                             | Main risk                                                                                    | Trend (30 d / 31–90 d)                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ★ Saving                     | Needs attention: the queue core is good, around it three sources of truth about the "dirty" state | SAVE-02, SAVE-03, SAVE-04                                                                    | 34 (13 fix) / 29 (4 fix) — noticeably more fixes                       |
| ★ Editor and Markdown        | Good: untouched blocks are preserved byte for byte, no bypass found                               | Content created by the editor itself (EDIT-01) and the tie of saving to DOM events (EDIT-02) | 27 (3) / 56 (15) — stabilizing after the spike of 7–12 October         |
| ★ Rust vault core            | Good in primitives, but checks are forgotten on neighboring paths                                 | CORE-01, CORE-02, CORE-03                                                                    | 46 (10) / 37 (7) — higher pace                                         |
| ★ Sync                       | Good: cryptography and server protection are well thought out; the link with the app is weaker    | SYNC-01 (an edit during download), SYNC-02                                                   | 275 (46) / — (the area is new, almost all history is within 30 days)   |
| ★ Storage/IPC boundary       | Satisfactory: window permissions are narrow, CSP is strict, but some commands trust paths from JS | IPC-02, IPC-03 (defense in depth)                                                            | 63 (9) / 46 (5)                                                        |
| Databases                    | Good on data, weak on speed on large vaults                                                       | DB-01, DB-02, DB-03                                                                          | 41 (7) / 31 (8) — flat                                                 |
| Workshop, canvases, sketches | Good: journals are reliable; metadata is lost on save                                             | CRE-01, CRE-02 (and SAVE-01)                                                                 | 24 (4) / 23 (1)                                                        |
| Workspace shell              | Satisfactory: state is in stores, but the root is a props-forwarding node                         | SHELL-01, SHELL-04                                                                           | 70 (16) / 41 (8) — higher pace                                         |
| Modules, AI, updates, log    | Good on AI key and update security; a known debt on package signing                               | MOD-01 (known, deferred), MOD-05                                                             | 41 (14) / 12 (1) — growth                                              |
| Appearance and texts         | Satisfactory: the notice model is in place, but the check sees only the listed files              | UI-01, UI-02, UI-08                                                                          | 117 (25) / 62 (7) — the project's most frequent file is `resources.ts` |
| Tooling and documentation    | Good, with one hole in the gate                                                                   | TOOL-01 (the bindings check checks nothing), TOOL-08                                         | 244 (30) / 82 (14)                                                     |

---

## 3. Findings

### 3.1. Cross-cutting patterns

One cause in different places. It is better to fix at the pattern level rather than each finding separately.

**А. "A protection exists on one path and is forgotten on the neighboring one."** The archive forbids touching the vault root and `.amby/`,
while deletion and rename do not (CORE-01). The trash preview checks the name, while restore does not (CORE-07).
`is_service_path` is case-insensitive, while `is_excluded_path` is case-sensitive (SYNC-02). Writing conflicts goes through
`VaultFs::resolve`, while reading goes through `vault.join` (SYNC-03). `commands/external.rs` checks the extension
against an allowlist, while `open_in_explorer` does not (IPC-04). The ID migration commands accept any folder (CORE-06,
IPC-03). The cure is common: one guard function per input class, called by all neighboring paths, and a test "all
commands of the class refuse the same way".

**Б. "Unsaved" is defined in three places, and they disagree.** The flag in `useDocStore`, the state of the
`AutosaveCoordinator` queue and the gate "was there a user action" in `TiptapEditor` live separately.
SAVE-03: the flag is cleared, but the save is still in the queue. EDIT-02: there is a change, but the gate did not count it.
SAVE-06: a re-read with a snapshot of the flag taken before the loop. SAVE-05: the canvas never sets the flag. One
source of truth is needed: "dirty = flag OR queue busy", and all re-read paths ask exactly that.

**В. Silent failures on non-Markdown paths.** The notice model is well implemented for notes, but canvases
(SAVE-05), the recovery journal (SAVE-08), file actions (UI-02), module installation (MOD-05), sync
subscriptions (SYNC-06), "Show in Finder" (IPC-01) and the admission check in Live (EDIT-10) go only to
`console.error` or nowhere. The notice-rules check does not catch "only `console.error`" (UI-01, UI-02).

**Г. A full vault walk on frequent operations.** Every note open (CORE-04), every cell edit
(DB-01), every new database row or property (DB-02), every tree change (SHELL-02, the link graph),
renaming a folder with attachments (CORE-09, files are read in full 2–3 times). All of this runs under
`mutation_gate` and blocks note saves. An ordinary note save does not do this: the statement
"mutations do not re-read the vault" is true only for it.

**Д. One bad file breaks everything.** A non-UTF-8 file blocks opening (CORE-02). An error-level failure in any
note freezes publication of all databases (DB-03). A damaged workshop journal is silently ignored (CRE-04).
The rule "unreadable ≠ deleted" is right, but the punishment should affect one file, not the whole vault.

**Е. Tests check the model, not the real path.** The autosave harness works with a fake renderer
(SAVE-13). Edit invariants are checked on an editor without live plugins (EDIT-04). The shared vault contract
in CI runs only against the browser adapter (IPC-05). `bindings:check` after `rust:test` compares the file
with itself (TOOL-01). Native contracts do not run in any CI (TOOL-08). That is exactly why the Critical and
High findings from items Б and В passed all 4203 tests.

**Ж. One fix — in two copies.** Rename and move (CORE-10), canvas and sketch (SAVE-12), 15 copies of
the database command plumbing (DB-06), four copies of "open with the system program" (IPC-04), the list of log events
in Rust and TS (MOD-07), the list of synchronized `.amby` folders (SYNC-10). Half of the "paired" fixes in
the history come from here.

**З. Unknown fields are lost when saving JSON.** For Markdown the rule "preserve the unknown" is followed
strictly. For the JSON formats it is weaker: the top-level fields of a sketch (CRE-01), unknown canvas node types (CRE-02),
unknown settings keys from another build (SHELL-07).

### 3.2. Summary table

Verification status:

- "✔ confirmed" — an independent verifier confirmed it against the code;
- "◐ partly" — confirmed, but with corrections;
- "↓" — severity lowered by the verifier;
- "author" — confirmed in code only by the area's author, without independent verification (a Medium/Low sample);
- "hypothesis" — the mechanism is visible in the code, the effect is not measured.

Effort: S ≤ half a day, M — 1–3 days, L — more. The "Unc." column marks findings in files that
were uncommitted at the start of the review (details in the appendix).

| ID       | Area        | Sev.                   | Gist                                                                                               | Check      | Effort | Unc. |
| -------- | ----------- | ---------------------- | -------------------------------------------------------------------------------------------------- | ---------- | ------ | ---- |
| CORE-01  | Rust core   | Critical               | A root note named after the folder → deletion or rename of the whole vault                         | ✔          | S      |      |
| SAVE-02  | Saving      | Critical               | Closing the window on a failed save and a failed draft loses text                                  | ✔          | M      |      |
| SAVE-01  | Saving      | High (↓ from Critical) | An unreadable canvas or sketch opens empty, the first edit overwrites it                           | ✔ ↓        | S      |      |
| SAVE-03  | Saving      | High                   | A "clean" buffer reload moves a scheduled save onto an external revision                           | ✔          | S      |      |
| SAVE-04  | Saving      | High                   | Quitting the app (Cmd+Q) does not save pending edits                                               | ✔          | M      |      |
| SAVE-05  | Saving      | High                   | A canvas or sketch save failure is silent                                                          | ✔          | S      |      |
| CORE-02  | Rust core   | High                   | A single non-UTF-8 `.md` blocks the vault                                                          | ✔          | M      |      |
| CORE-03  | Rust core   | High                   | History by path: invisible after a rename, a new note gets someone else's                          | ✔          | M      |      |
| EDIT-01  | Editor      | High                   | A break in a heading or cell and blocks in a cell are written with loss                            | ✔          | M      |      |
| EDIT-02  | Editor      | High                   | Block menu actions done only with the mouse are not saved                                          | ✔          | S      | yes* |
| SYNC-01  | Sync        | Medium (↓ from High)   | An edit during the body download is silently replaced (a copy exists in history)                   | ◐ ↓        | M      |      |
| CRE-01   | Workshop    | Medium (↓)             | A sketch loses unknown top-level fields and `source` on the first edit                             | ◐ ↓        | S      |      |
| IPC-01   | storage/IPC | Medium (↓)             | "Show in Finder" for a vault silently does not work                                                | ✔ ↓        | S      | yes  |
| MOD-01   | Modules     | Medium (↓)             | The private key of the "official" package signature is in the sources (known, deferred)            | ✔ ↓        | M      |      |
| SAVE-06  | Saving      | Medium                 | `refreshLocalVault` replaces buffers by a snapshot of "dirty" taken before the loop                | author     | S      |      |
| SAVE-07  | Saving      | Medium                 | `write_note` checks the revision outside `mutation_gate`                                           | ✔ (sample) | S      |      |
| SAVE-08  | Saving      | Medium                 | A draft write failure is reported to no one                                                        | author     | S      |      |
| SAVE-09  | Saving      | Medium                 | The container layer ID is taken by a regex in the frontend, the revision by a foreign hash         | author     | S      |      |
| SAVE-10  | Saving      | Medium                 | Renaming a canvas during a save → a false conflict, "Overwrite" resurrects the old file            | author     | S      |      |
| SAVE-11  | Saving      | Medium                 | Every autosave is a synchronous fsync and SQLite on the main thread                                | hypothesis | M      |      |
| SAVE-12  | Saving      | Medium                 | The canvas and sketch hooks are near copies                                                        | author     | M      |      |
| SAVE-13  | Saving      | Medium                 | The saving tests check a fake renderer                                                             | author     | M      |      |
| EDIT-03  | Editor      | Medium                 | `[..](..)`, `<b>`, addresses with a space typed in Live read back differently                      | author     | M      | yes* |
| EDIT-04  | Editor      | Medium                 | Edit invariants are checked without live plugins                                                   | author     | S      |      |
| EDIT-05  | Editor      | Medium                 | `TiptapEditor.tsx` mixes saving with menus; recurring fixes are here                               | author     | M      |      |
| CORE-04  | Rust core   | Medium                 | Every note open reads and parses the whole vault                                                   | ✔ (sample) | M      |      |
| CORE-05  | Rust core   | Medium                 | Legacy ULIDs in `id` are migrated without confirmation, although the document promises it          | author     | S      |      |
| CORE-06  | Rust core   | Medium                 | The ID migration commands accept any folder                                                        | author     | S      |      |
| CORE-07  | Rust core   | Medium                 | Restoring from the service trash trusts `name` from the manifest                                   | author     | S      |      |
| CORE-08  | Rust core   | Medium                 | History auto-cleanup deletes the "safety" snapshots and swallows errors                            | author     | S      |      |
| CORE-09  | Rust core   | Medium                 | A rename or move reads every file of the subtree in full 2–3 times                                 | author     | M      |      |
| CORE-10  | Rust core   | Medium                 | ~100 lines are duplicated in rename and move                                                       | author     | S      |      |
| SYNC-02  | Sync        | Medium                 | Exclusions are case-sensitive: `.GIT/config` is written to `.git/config` on macOS and Windows      | ✔ (sample) | S      |      |
| SYNC-04  | Sync        | Medium                 | A panic in apply leaves the watcher's event batch open until restart                               | author     | S      |      |
| IPC-02   | storage/IPC | Medium                 | `read/write_app_data` are available for the Codex and Claude sign-in files                         | ✔ (sample) | S      |      |
| IPC-03   | storage/IPC | Medium                 | Commands trust absolute paths from JS (`load_vault`, `import_asset`…)                              | author     | M      |      |
| IPC-04   | storage/IPC | Medium                 | Four copies of the system "open" have diverged (Linux opens the file)                              | author     | S      |      |
| IPC-05   | storage/IPC | Medium                 | The shared vault contract in CI is only the browser adapter                                        | author     | M      |      |
| IPC-06   | storage/IPC | Medium                 | Error categories are regexes over English text containing the user's path                          | author     | M      |      |
| IPC-10   | storage/IPC | Medium                 | The forwarding layer: one command = an edit of 8 files                                             | author     | M      |      |
| DB-01    | Databases   | Medium                 | Every cell edit walks the whole vault                                                              | ✔ (sample) | M      |      |
| DB-02    | Databases   | Medium                 | A row or property → a full rebuild of all databases' projections                                   | author     | L      |      |
| DB-03    | Databases   | Medium                 | One error in any note freezes all databases                                                        | ✔ (sample) | M      |      |
| DB-04    | Databases   | Medium                 | `table-view.tsx` parses each row's JSON several times per render                                   | author     | S      | yes  |
| DB-06    | Databases   | Medium                 | `commands/database.rs` is not a thin boundary, 15 copies of plumbing                               | author     | M      |      |
| CRE-02   | Workshop    | Medium                 | A canvas node of unknown type is saved as empty text                                               | ✔ (sample) | M      |      |
| CRE-03   | Workshop    | Medium                 | Completed workshop journals are never deleted                                                      | author     | S      |      |
| SHELL-01 | Shell       | Medium                 | Rolling back a cancelled move writes the "display" tree into the "raw" one                         | author     | S      |      |
| SHELL-02 | Shell       | Medium                 | The link graph is re-read after every tree change                                                  | author     | M      |      |
| SHELL-03 | Shell       | Medium                 | A subscription to the whole `openDocs` redraws the dock and the AI panel while typing              | author     | S      |      |
| SHELL-04 | Shell       | Medium                 | The root has ~110 inputs into `usePaneRenderers`, ~70 props per layout                             | author     | L      |      |
| MOD-05   | Modules     | Medium                 | Module install failures are only `console.error`; the v0.1.4 URL is in several copies              | author     | S      | yes  |
| MOD-06   | Modules     | Medium                 | `ModulesTab` is one component of ~1000 lines                                                       | author     | M      | yes  |
| MOD-07   | Modules     | Medium                 | The log events allowlist is 350 lines in Rust and a mirror in TS                                   | author     | M      | yes  |
| UI-01    | Texts       | Medium                 | The notice check sees only the listed files: 64 red `role="alert"` + 28 palette classes outside it | author     | M      | yes  |
| UI-02    | Texts       | Medium                 | User action failures only go to `console.error` (49 calls in 19 files)                             | author     | M      |      |
| UI-03    | Texts       | Medium                 | 316 localization keys (8.5%) are unused                                                            | author     | S      |      |
| UI-05    | Texts       | Medium                 | `scrollbar-width/color` against the rule: on WebView2 the scrollbar look breaks                    | author     | S      |      |
| UI-08    | Texts       | Medium                 | Document tabs are not reachable from the keyboard                                                  | ✔ (sample) | M      |      |
| UI-09    | Texts       | Medium                 | `aria-modal` without a translation and focus trapping                                              | author     | S      |      |
| TOOL-01  | Tooling     | Medium                 | `bindings:check` after `rust:test` always passes                                                   | ✔ (sample) | S      |      |
| TOOL-02  | Tooling     | Medium                 | Signing the CLA by comment does not work: `cla.yml` is not in `main`                               | author     | S      |      |
| TOOL-08  | Tooling     | Medium                 | Native contracts (real IPC) do not run in CI                                                       | author     | M      |      |

\* The file was uncommitted, but the bug itself predates these changes (verified).

Low-severity findings (66 of them) are in the table in section 3.5.

### 3.3. Critical and High in detail

#### CORE-01 — A root note named after the vault folder: "Delete" and "Rename" act on the whole vault

- **Area / category:** Rust core, correctness. **Severity:** Critical. **Verification:** ✔ confirmed.
- **Evidence:**
  - `src-tauri/src/bundle/scan.rs:26-43`: a note is treated as the main note of a "bundle" if the parent
    folder's name matches its name. There is no check for the vault root:
    `path.parent()…file_name()… == stem`.
  - `src-tauri/src/bundle/notes.rs:113-118`: `resolve_item_root` returns `path.parent()`, that is, the vault
    itself.
  - `src-tauri/src/recycle_bin.rs:98-113`: `preview_move_to_trash` checks only
    `starts_with(&vault_path)`, and the root passes that check.
  - `recycle_bin.rs:142`: `fs::remove_dir_all(&preview.original_path)`.
  - `src-tauri/src/bundle/execute.rs:55-88`: rename does `parent.join(trimmed)` in the folder above the
    vault.
  - For comparison, `src-tauri/src/archive.rs:210-215` refuses: "The vault itself cannot be archived".
- **Scenario:** the vault is `~/Notes`, and the root contains `Notes.md` — a common layout. The tree shows it
  as an ordinary note, and the frontend blocks nothing: `use-document-crud.ts:51-57` repeats the same
  logic. What happens on each action:
  - "Delete permanently" → `remove_dir_all(~/Notes)`: all notes, attachments, `.amby/history` and recovery
    drafts disappear. The confirmation window names only the note.
  - "Delete" in the default mode → the whole vault goes to the system trash; it can be restored from there.
  - "Rename" to "Journal" → the vault folder is renamed to `~/Journal`, outside the permitted
    area.
  - Root `ambd.json` and `<Name>.json` have the same effect (`database/discovery.rs:25-45`).
- **Proposal:** a file directly in the vault root is never treated as the main note of a bundle. In
  `preview_move_to_trash`, which is shared by all three modes, refuse for the root and for service paths the
  same way the archive does. Rename must re-check `new_dir` through `confine`. Tests are written first: a
  temporary vault with a note named after the folder in its root; deletion in three modes and
  rename.
- **Effort:** S. **Change risk:** low. **Tests first:** yes. There are currently no tests for this case.

#### SAVE-02 — Closing the window after a save failure loses text, while the UI promises a draft

- **Area:** saving, correctness. **Severity:** Critical. **Verification:** ✔ confirmed.
- **Evidence:**
  - `src/components/workspace/use-vault-data.ts:503-537`: the window-close handler writes
    `window_close.autosave_flush_failed` to the log, and then calls `destroy()` anyway in `finally`.
  - `src/lib/recovery-drafts.ts:76-87`, `src-tauri/src/recovery.rs:42-44`: the draft is stored only in
    `<vault>/.amby/recovery/`, on the same disk as the notes.
  - `src-tauri/src/recovery.rs:14,142-146`: a limit of 5 MB per draft.
  - The texts promise a draft without checking: `src/locales/resources.ts:5215-5218` (vault switch) and
    `:6555-6556` (the "did not save" card).
- **Scenario:** the disk is full. Saving the note and writing the draft fail together. The card says:
  "The text stays in the editor and in a temporary draft". The user closes the window, and the text is gone
  everywhere. The vault switch behaves the same way after confirmation, whose text says that drafts are
  saved. The second path to loss is a large note (over 5 MB): the draft is not written even when there is
  free space.
- **Proposal:** `flushAutosaveGeneration` must report exactly what failed (the file or the draft) and whether
  every dirty buffer has a durable copy. If it does not, the window does not close, and a `decision`-level
  question is asked via `confirm()`. Show the texts "in a draft" and "drafts saved" only when that is true.
  Optionally: a fallback draft in app-data if the vault is on another disk.
- **Effort:** M. **Risk:** medium. **Tests first:** yes. There is currently no test for the close handler
  after a failed flush: tests mock `onCloseRequested`.

#### SAVE-01 — An unreadable or "non-strict" canvas or sketch opens empty, and the first edit overwrites it

- **Severity:** High (the author rated it Critical; downgraded because by default the history snapshot keeps
  the original bytes). **Verification:** ✔ confirmed.
- **Evidence:**
  - `src/components/workspace/orchestration/use-canvas-workspace.ts:108-114` and
    `use-sketch-workspace.ts:102-108`: first the base revision of the real file is taken, then the strict
    format check; if that throws, `catch {}` substitutes an empty buffer. Nothing is written to the log,
    there is no notice and no read-only mode.
  - `src-tauri/src/commands/notes.rs:16-24`: `read_file` returns the BOM as is.
  - `src/lib/canvas-format.ts:122-136`: without `nodes` or `edges` the file is rejected.
- **What triggers it:** a BOM in the file; JSON Canvas without an `edges` or `nodes` key (per the
  specification they are optional); git conflict markers; a JSON error after a manual edit; a one-off read
  failure. Files saved by Obsidian and files from excalidraw.com do not cause the problem.
- **Scenario:** we open such a canvas → we see an empty field → we add a node → `write_file` passes the
  revision check (the base revision is real) → the file is atomically replaced with
  `{nodes:[new], edges:[]}`. The only copy left is the `file-save` snapshot in history. If history is off,
  the original is lost (which is already Critical). For a note's canvas layer, the history panel looks at the
  `.md`, and it may not be possible to restore the layer from the UI (not verified).
- **Proposal:** on a read or parse failure, the layer opens read-only with a `danger`-level card and without
  a base revision. Strip the BOM before `JSON.parse`. Read missing `nodes`/`edges` as `[]`, and preserve the
  other keys. While at it, merge the two hooks (SAVE-12).
- **Effort:** S. **Risk:** low. **Tests first:** yes. There are no "open a bad file → edit" tests.

#### SAVE-03 — Scheduled autosave overwrites an external edit without a conflict

- **Severity:** High. **Verification:** ✔ confirmed.
- **Evidence:**
  - `src/components/workspace/orchestration/use-pane-editor-props.tsx:324-328`: `onContentClean` calls
    `markSaved` unconditionally.
  - `src/components/workspace/file-actions/use-markdown-autosave.ts:130,140,196-205`: the content to save is
    taken at the moment it is enqueued, while `expectedRevision` is read only at launch.
  - `src/components/workspace/use-vault-data.ts:823-827,872-878`: with a "clean" buffer the watcher
    substitutes the external text and its revision. It waits only for a write that is already in progress,
    not for one scheduled by the timer.
- **Scenario:**
  1. The user types text; a save of "B" is scheduled in 500 ms.
  2. They type and erase a character faster than 200 ms. The Markdown matches the previous one, so
     `onContentClean` → `markSaved` fires, although "B" is still in the queue.
  3. In that same half second an external edit "E" arrives (another window, sync, another program). The
     buffer is considered clean and loads "E" together with its revision.
  4. The timer fires: "B" is written over "E", and the revision check passes.
  5. The editor shows "E", the disk holds "B", and nobody reports it.
- **Proposal:** treat the state as "dirty" if "flag OR queue busy": call `markSaved` in `onSaveSuccess` and in
  `onContentClean` only if `autosave.inspect(key)` shows no pending work. All paths that reload a "clean"
  buffer (watcher, `amby:note-written`, `refreshLocalVault`, history) check the same
  thing. See pattern Б.
- **Effort:** S. **Risk:** low. **Tests first:** yes. The harness test "reloads clean external edits" does
  not cover this case: it has no pending save.

#### SAVE-04 — Quitting the app (Cmd+Q, "Quit" in the Dock) does not save pending edits

- **Severity:** High. **Verification:** ✔ confirmed.
- **Evidence:**
  - Mechanism: `NSApp terminate:` → tao handles only `applicationWillTerminate:` → tauri-runtime-wry emits
    only `RunEvent::Exit`. No window receives `CloseRequested`.
  - `src-tauri/src/state.rs:75-91`: the app event handler handles only `Reopen` and
    `Destroyed`.
  - `use-vault-data.ts:507-535`: the only hook for flushing edits is the window close.
- **How much is lost:** Tiptap serializes 200 ms after typing stops, autosave waits another 500 ms by default
  (configurable up to 10 s), and the draft is written after 0.5–1 s. By default the disk is missing roughly
  the last 0.7 s of typing, and the text of the last ~1.2 s is lost entirely because there is no draft yet.
  "Typed and pressed Cmd+Q" is the most ordinary way to quit on macOS.
- **Also:** `app-updater.ts:116-117` calls `relaunch()` without flushing edits. The settings window is closed
  via `destroy()` (`state.rs:67`), bypassing its own handler.
- **Proposal:** in Rust, handle `RunEvent::ExitRequested` (`prevent_exit`). If Tauri on macOS does not raise
  it for `terminate:`, intercept Quit with a custom menu item. Then broadcast a "flush edits" event to the
  windows and exit when all have answered, or on timeout. Native test: type text → Cmd+Q → open the note
  again.
- **Effort:** M. **Risk:** medium. **Tests first:** yes. A native check is needed: the harness exits through
  `handle.exit()`, which is a different path.

#### SAVE-05 — A canvas or sketch save failure is not visible

- **Severity:** High. **Verification:** ✔ confirmed.
- **Evidence:**
  - `use-canvas-workspace.ts:91-94` and `use-sketch-workspace.ts:87-90`: `onSaveFailure` only writes
    `logger.error` to the log.
  - The canvas never calls `markUnsaved`, so the tab has no "unsaved" dot
    (`pane-tab-bar.tsx:147`).
  - There is no retry until the next edit (`autosave-coordinator.ts:119,247,295-301`).
- **Scenario:** the disk is full or permissions are missing. A Markdown note shows a `danger`-level card, but
  the canvas shows nothing. The user keeps working, believing the board is saved. Mitigation: the draft is
  written before each save and deleted only after success, so on reopening a "restore the draft?" question
  will appear. The "invalid serialization" part is practically unreachable.
- **Proposal:** send a layer's save failure to the same place as a note's failure (`setSaveFailed` or
  `closedSaveFailed` plus a popup message), clear the notice after success, and set the `markUnsaved` flag.
  Replace `console.*` calls with `logger` with a code.
- **Effort:** S. **Risk:** low. **Tests first:** yes.

#### CORE-02 — A single non-UTF-8 file blocks opening the vault and all notes

- **Severity:** High. **Verification:** ✔ confirmed.
- **Evidence:**
  - `src-tauri/src/vault/migration.rs:546`: `fs::read_to_string(path)…?` inside the walk aborts the whole
    preflight pass, and the error does not name the offending file.
  - `src/lib/storage/desktop-adapter.ts:797-799`: before every `readNote`, `applyIdMigration` is called, and
    it starts with a full preflight pass.
  - `use-vault-data.ts:319`: opening a vault starts with `preflightVault`.
  - A second obstacle: the full index scan also reads strictly (`index/sync.rs:99-108`), and this is
    pinned by a test.
- **Scenario:** a note in UTF-16 (Windows Notepad, "Unicode") or in cp1251 from an old export lands in a
  visible folder. The vault does not open: a generic "failed to open" appears, without the file name. If the
  vault is already open, no note opens any more. Data is not corrupted, which is why this is High rather
  than Critical. Hidden folders, `.obsidian`, `.git`, `.amby` and non-`*.md` files are skipped.
- **Proposal:** the preflight pass records unreadable files in the report (as is already done for corrupted
  frontmatter) and skips them. The index keeps the stored row or an "unreadable" stub with a warning that
  names the path. Remove the migration on every `readNote` (CORE-04). Fixing only `migration.rs:546` is not
  enough: the index also blocks opening.
- **Effort:** M. **Risk:** medium. **Tests first:** yes. There are no preflight-pass tests with a non-UTF-8
  file.

#### CORE-03 — History is bound to the path: after rename, move or archive the versions are not visible

- **Severity:** High. **Verification:** ✔ confirmed.
- **Evidence:**
  - `src-tauri/src/history.rs:20-32`: `SnapshotMetadata` has `source_path` but no note ID.
  - `history.rs:633`: `list_snapshots` searches by exact path match.
  - `commands/mutations.rs`: rename and move do not touch the history manifest.
  - `src/components/workspace/history/use-history.ts:88`: the history panel searches only by path.
- **Scenario:** a note was edited for weeks, then renamed — the "History" panel is empty. A new note created
  at the old path shows someone else's versions, and "Restore" would write someone else's text into it. This
  can be undone: a snapshot is taken before restoring. Data is not lost, history is only appended to. But the
  `note-rewrite` snapshot, on which the owner's condition for normalization in Live Preview depends,
  becomes unavailable after the very first rename. The document (`docs/vault-format.md:408-446`) does not
  promise that history follows a rename.
- **Proposal:** add an optional `note_id` field to the new snapshot metadata — this is adding a field, not
  changing the shape; search by ID, with a fallback search by path. Or atomically rewrite `source_path` on
  rename and move under `history_lock`. This changes a durable format, so it follows the migration
  rules.
- **Effort:** M. **Risk:** medium. **Tests first:** yes ("snapshot → rename → the list is
  non-empty").

#### EDIT-01 — A line break in a heading or table cell is written in a way that reads back differently

- **Severity:** High. **Verification:** ✔ confirmed.
- **Evidence:**
  - `src/components/workspace/tiptap/markdown-serializer.ts:394-401`: `hardBreak` writes `\` and a newline
    everywhere.
  - `markdown-serializer.ts:534-537`: in a cell, all newlines are turned into a space.
  - The schema allows `block+` in a cell (`@tiptap/extension-table`); tables have no Enter handling.
  - Nobody intercepts Shift-Enter and Mod-Enter.
- **Scenario:**
  - Shift-Enter in a heading → `# Заголовок\` and a separate paragraph. After reopening: a heading with a
    stray `\` and a separate paragraph.
  - Enter in a cell → two paragraphs in the cell → on disk they are merged into one.
  - Shift-Enter in a cell → a literal `\ `.
  - A list or heading in a cell (via the `/` menu or typing `- `) turns into text.
  - Text is not lost, but the structure changes and stays in the file. This is not syntax read from disk:
    the editor itself creates it. The Live admission check fires only on load.
- **Proposal:** first, round-trip tests: a heading with a break, a cell with two paragraphs, with a break,
  with a list. Then narrow the schema: exactly one `paragraph` in a cell, Enter in a cell moves to the next
  row or does nothing, a line break in a heading is forbidden. If breaks in cells are needed — write `<br>`
  and read it back (with a golden-sample test and a rejection test). The choice is a question for the owner
  (section 7).
- **Effort:** M. **Risk:** medium. **Tests first:** yes.

#### EDIT-02 — Block-menu actions done only with the mouse are not saved

- **Severity:** High. **Verification:** ✔ confirmed, with a correction: the edit is not lost if there was any
  keyboard action before leaving the note.
- **Evidence:**
  - `src/components/workspace/tiptap/TiptapEditor.tsx:370-378`: `if (!isUserAction) return`. The "dirty" flag
    is set only after this check.
  - `TiptapEditor.tsx:939-953`: the user-action flag is set only by keydown, input, paste, cut and drop.
  - `BlockHandles.tsx:257-270` (Delete, Duplicate) and
    `BlockActionsPanel.tsx:132-137,218-234,610-640,1172` (Turn into, split, color, emoji, list type) do not
    set the `uiEvent` mark. For comparison, `TableControls.tsx:122` and dragging
    (`use-block-drag.ts:448`) do set it.
- **Scenario:** opened a note, typed nothing, hovered the mouse over a block, clicked the handle and chose
  "Delete". The block disappeared on screen, but when switching to another tab or closing, the edit is not
  written. Opened again — the block is in place, and nothing says so anywhere.
- **Proposal:** first an e2e test: open a note → delete a block via the handle → wait for autosave → check
  the file. Then either mark all block-menu transactions via `setMeta("uiEvent")`, or, better, invert the
  rule: any transaction with `docChanged` counts unless it is explicitly marked as "programmatic". The
  protection against a temporary empty block stays.
- **Effort:** S. **Risk:** low. **Tests first:** yes.

#### Downgraded after verification (were High)

- **SYNC-01** (now Medium). The hash of the local file is checked before the body is downloaded from the
  server, but not on publication (`sync/core/src/engine/apply.rs:436-451` → `:601`; `src-tauri/src/sync/vault_fs.rs:383-420`).
  A note save during the download window is silently replaced by the server version, and the editor rereads
  the file. This is mitigated: a `sync-overwrite` snapshot is always taken before the replacement, even with
  history off, so the text can be recovered from history. A gap the author did not mention: for a file that
  is new from the server there is no snapshot, and a file the user created at the same path during the
  download is overwritten without a copy. Proposal: pass the expected hash into `StagedWrite::publish` and,
  on mismatch, defer the apply (as in the existing path С9); add a sim test "save during `RemoteKind::Download`".
- **CRE-01** (now Medium). Saving a sketch writes only `elements/appState/files` and `source:
"amby-notes"` (`src/components/workspace/sketch/sketch-editor.tsx:262-287`,
  `src/lib/sketch-format.ts:249-267`). Unknown top-level fields are lost; fields of individual elements are
  preserved. A history snapshot is taken. Found in passing: `sketch-editor.tsx:203-207` turns the `#ffffff`
  background into `transparent` on open and probably writes it to disk (not verified live).
  Proposal: keep the parsed top-level fields in a ref and mix them in on save, like
  `canvasTemplateRef` for the canvas.
- **IPC-01** (now Medium). "Show in Finder" for a vault does not work on the start screen and for inactive
  vaults: `paths::guard` requires an active vault (`src-tauri/src/commands/assets.rs:162`), and nobody
  awaits the promise or catches the error (`vault/vault-manager.tsx:167`). "Open folder" in the data
  settings is broken in the same way (`settings-data.tsx:61`). Data is not affected. Proposal: a separate
  command `reveal_vault_folder(id)` using the vault registry, and a response under the menu item.
- **MOD-01** (now Medium, known). The private key of the "official" signature
  (`src/lib/modules/package-manager/validator.ts:268`, `scripts/build-modules.mjs:16`) is the pair of the
  production public key (`src-tauri/src/package_manager.rs:16`), as the tests prove. Already recorded as an
  open deferred risk in `docs/security-advisories.md:62-90`. Safe for now: installed modules are not
  executed (`INSTALLED_MODULE_EXECUTION_ENABLED = false`), and the install UI is hidden. It becomes High the
  moment either of the two flags is turned on. The key stays in git history, so a key rotation is needed,
  not deleting the line.

### 3.4. Medium in detail

Format: essence → scenario → proposal · effort / risk / tests first · evidence.

**Saving**

- **SAVE-06** — `refreshLocalVault` (after a sync update) reads open notes one by one and replaces buffers
  according to the set of "dirty" ones taken before the loop. A note that started being edited while another
  one was being read gets the text from disk, and the next input overwrites what was typed. In addition,
  errors are swallowed without a code, and container layers are read by `id` instead of `noteId`. → Use the
  watcher's check (a fresh flag and the queue state after every `await`, a conflict for a dirty buffer). · S
  / low / yes · `workspace-orchestration.tsx:470-486`.
- **SAVE-07** — `write_note` checks the revision and merges frontmatter before `mutation_gate`, while `write_file` does so
  inside it. Restoring a version from the server or a property write between the read and the commit is overwritten by the old
  frontmatter without a conflict. → Move the check under the lock. · S / low / yes ·
  `src-tauri/src/commands/notes.rs:230-253`. Verification (sample): confirmed; the main risk is a race with a
  property write or a restore.
- **SAVE-08** — A recovery-draft write failure goes only to `console.warn`, and a draft read on error
  returns `null` silently. `docs/vault-format.md` says such an error is reported. → A `warning` on the note
  card, `logger` with a code. · S / low / yes · `src/lib/recovery-drafts.ts:174-178,361-363`.
- **SAVE-09** — A container layer's ID is taken with the regex `^(?:amby-id|id):` in multiline mode (it catches a
  plain `id:` and body lines), and on failure the revision is computed as an FNV hash, which the backend does not use. As a
  result the user sees a false "changed on disk" conflict or, if the value matches another note's ID, the write goes into that
  note. → Take the ID and revision only from the backend; until it responds, keep the layer read-only. ·
  S / low / yes · `file-actions/use-document-loading.ts:129-145`.
- **SAVE-10** — Renaming a canvas while a save is still queued: the write to the old path finds the file
  missing → a "changed somewhere else" question → "Overwrite" creates a copy at the old path. → Pause the
  keys and wait for the current write before renaming. · S / low / yes ·
  `file-actions/use-document-mutations.tsx:195-209`.
- **SAVE-11** (hypothesis: the mechanism is visible in the code, the effect is not measured) — `write_note`
  and `write_file` are synchronous commands. The main thread runs fsync (on macOS this is `F_FULLFSYNC`, tens
  of ms), the history snapshot and SQLite, and keyboard input in the WebView goes through the same event
  loop. On slow and network disks, typing may lag. → First measure (`note.write` telemetry), then `async`
  plus `spawn_blocking`, after SAVE-07. · M / medium / no · `commands/notes.rs:193`.
- **SAVE-12** — `use-canvas-workspace.ts` and `use-sketch-workspace.ts` are almost copies; SAVE-01 and SAVE-05 have to be fixed in both.
  → A single `useLayerWorkspace({kind, validate, emptyJson})`. · M / low / no.
- **SAVE-13** — The "integration harness" and the stress test work with a fake renderer that has its own
  "dirty" state logic. They do not run the close code, the watcher reloads or `refreshLocalVault`, so
  SAVE-02, SAVE-03 and SAVE-06 pass all the tests. → Run the real `useMarkdownAutosave`, the watcher
  callback and `useDocStore` with a fake vault port. · M / low / yes ·
  `autosave/autosave-integration-harness.test.ts:96-188`.

**Editor**

- **EDIT-03** — `[черновик](todo)`, `a <b> c`, `<!-- позже -->` typed in Live become, after reopening, a
  link, an HTML atom or a comment. A link or image address with a space stops being a link. An image caption
  ending in `\` breaks the image. The save-time check compares against `parse(normalized)`, which is just as
  wrong. → Escape `[ ] <` in the middle of a line, write addresses as `<…>`, and in tests compare the
  document, not `textContent`. · M / medium / yes ·
  `markdown-serializer.ts:38,59-65,424-425,509`; `markdown-block-source.ts:296-308`.
- **EDIT-04** — The invariant "an edit rewrites only its own block" is checked on an editor with only the schema, without the plugins
  (IndentShortcut, BlockAnchors, `fixTables`) that append their own transactions. Today there is no leak, but a future plugin will
  create one, and the tests will stay green. → Build the test editor through `buildExtensions(...)`. · S / low / no ·
  `markdown-block-source.test.ts:282-288`.
- **EDIT-05** — `TiptapEditor.tsx` (1043 lines, 18 commits) mixes the serialization lifecycle with menus and
  pointer heuristics. The recurring class of fixes ("which DOM event came first") lives exactly here, and
  EDIT-02 is of the same class. → Extract serialization into `use-editor-serialization.ts` with tests; do
  not touch the menus. · M / medium / yes.

**Rust core**

- **CORE-04** — Every note open calls `apply_id_migration`, which, under `mutation_gate`, reads and parses
  every `.md` in the vault, even when there is nothing to migrate. With 10 thousand notes that is tens of MB
  per click and a block on all saves. → Assign IDs to new files in the watcher and index path (it reads them
  anyway); a full pass only when a vault is opened. · M / medium / yes ·
  `desktop-adapter.ts:795-799`, `vault/migration.rs:525-609`, `commands/vault.rs:178`. Verification
  (sample): confirmed.
- **CORE-05** — The preflight pass plans moving the legacy `id` (ULID) to `amby-id` for every note, and
  `use-vault-data.ts:339-341` applies it without confirmation. The document and a code comment promise a
  preview and confirmation. The write is reversible (there are backups), but the consent rule is not
  followed. → The decision is the owner's: show it for confirmation or fix the document (section 7). · S /
  low / yes · `frontmatter.rs:243-249`, `docs/vault-format.md:166-176`.
- **CORE-06** — `preflight_vault`, `apply_id_migration` and `recover_id_migration` accept any folder and only
  canonicalize the path. Any window can write `amby-id` into every `.md` in the home folder. → Accept only
  the active vault or a path issued by the system dialog (see IPC-03). · S / low / yes ·
  `commands/vault.rs:165-185`.
- **CORE-07** — Restoring from `.amby/trash/` takes `name` from JSON without checking
  (`trash_root.join(id).join(&entry.name)`). An absolute name replaces the base of the path. A planted manifest (a vault from a cloud
  folder, git, someone else's backup) with `"name": "/Users/x/.ssh/id_ed25519"` moves that file into the vault. The preview does check
  the same field. → Apply the same check and `confine_rel_no_symlinks`. · S / low / yes ·
  `recycle_bin.rs:280,365`, `recycle_bin_preview.rs:45-57`.
- **CORE-08** — History auto-cleanup (a toggle in settings, 30 days by default) also deletes the
  `note-rewrite`, `sync-overwrite` and `restore` snapshots — exactly the ones promised as a safety net (the
  owner's condition for Live Preview, "the only copy of what was overwritten"). Cleanup errors are swallowed
  (`let _ =`). The document states "is not cleaned automatically". → Exclude these reasons from
  auto-cleanup or keep the latest snapshot of each reason; add `logger`; fix the document. · S / low / yes ·
  `history.rs:599-621`.
- **CORE-09** — For watcher fingerprints, renaming or moving a folder reads every file of the subtree in
  full (`fs::read` plus SipHash) 2–3 times under `mutation_gate`: moving a folder with 3 GB of video is 6–9
  GB of reads and memory allocation sized by the file. → A metadata fingerprint (size, mtime, inode) for
  moved files; hash only rewritten ones. · M / medium / yes · `watcher.rs:291-315,384-395,446-462`.
- **CORE-10** — About 100 lines after the mutation (rollback of the link-rewrite plan, `sync_path_changes`,
  tree patch, projection) are duplicated in `rename_item_inner` and `move_item_inner`. Fixes in history came
  in pairs. → A shared `finish_path_mutation(...)`. · S / low / no · `commands/mutations.rs:1032-1112` and
  `:1318-1395`.

**Sync**

- **SYNC-02** — `is_excluded_path` compares `.git`, `.amby`, `.obsidian`, `.trash` byte-for-byte, while
  `is_service_path` is case-insensitive. An incoming `.GIT/config` on APFS or NTFS is written over
  `.git/config` (and `core.fsmonitor` there means command execution on the next `git status`), and
  `.AMBY/...` into Amby's state. A malicious server cannot do this by itself (headers are authenticated),
  but the holder of the space key or a Linux device with a `.Git` folder can. → Compare case-insensitively;
  on Windows reject 8.3 names (`GIT~1`). · S / low / yes · `sync/core/src/engine/rules.rs:11-16`.
  Verification (sample): confirmed.
- **SYNC-04** — Between `batch_begin` and `batch_end` in apply there is no protection (RAII). The session
  catches a panic and keeps working, but the watcher event batch stays open until restart: windows no longer
  learn about external edits, and the protection "external edit with a dirty buffer = conflict" is switched
  off. → A guard with `Drop` or a depth reset on `Outcome::Panicked`. · S / low / yes ·
  `sync/core/src/engine/sync.rs:468-471`, `src-tauri/src/watcher.rs:180-196`.

**Storage/IPC boundary** (everything below is defense in depth: exploitation needs a script in the window,
and the CSP `script-src 'self'` is the main barrier)

- **IPC-02** — `read_app_data` and `write_app_data` accept any relative path in app-data, including `codex/auth.json` (ChatGPT tokens) and
  `claude/settings.json`. `write/delete_vault_meta` reaches any file in `.amby/` bypassing `mutation_gate`. API keys, by contrast, are
  kept in the keychain. → An allowlist of names in Rust, `write_vault_meta` under the lock. · S / low / yes ·
  `src-tauri/src/app_data.rs:79-94,166-193`. Verification
  (sample): confirmed. Not verified whether the Claude launch ignores hooks from this `settings.json`.
- **IPC-03** — The path from the system dialog and drag-and-drop paths pass through JS, and Rust trusts the
  string: `load_vault` (switch the vault to `~`, granting the asset protocol access to all of `~` until the
  end of the session), `apply_id_migration`, `import_asset` and `import_files` (copy `~/.ssh/...` into the
  vault). → Remember in Rust the paths issued by the dialog or the drag-and-drop event, and accept only
  those; on a vault switch, revoke the old access scope. · M / medium / yes · `commands/vault.rs:13-58`,
  `assets.rs:44-46`, `import_files.rs:59`.
- **IPC-04** — Four copies of "open with the system program" have diverged:
  - `open_in_explorer` on Linux opens the file itself (`xdg-open file`), bypassing the extension allowlist
    of `open_attachment`;
  - on Windows `/select` receives a `\\?\…` path; `external.rs` knows this case and fixes it, here it is not
    handled (hypothesis, not run on Windows);
  - processes are not awaited (zombies until the app exits);
  - errors are returned as raw text.

  → A single `system_open.rs` module modeled on `external.rs`. · S / low / yes · `assets.rs:156-188`,
  `debug.rs:107-130`, `ai/codex/launch.rs:241-255`.

- **IPC-05** — The shared vault contract (4 cases, no move) runs in CI only against the browser adapter. The
  native run is manual. And the browser adapter already diverges from Rust: `moveItem` silently overwrites a
  file with the same name, the name is not trimmed, `archiveItem` deletes permanently. → Add cases for move,
  collision, name trimming and archive; in the web adapter — a refusal instead of imitation; a native run in
  CI (TOOL-08). · M / low / yes · `storage/storage.test.ts:31`, `web-adapter-core.ts:1159-1237`.
- **IPC-06** — Vault error categories are determined by regexes over English text with the user's path baked
  in. A folder named "Collision notes" turns "Permission denied" into "already exists". → A typed
  `{code, detail}` from the vault commands (Specta enum), one command at a time. · M / low / yes ·
  `src/lib/storage/operation-error.ts:15-27`.
- **IPC-10** — A new vault command is an edit to 8 files (Rust, registration, bindings, `port.ts`, two
  adapters, the repository, the wrapper in `index.ts`). 82 one-line forwards in the repositories explain
  why `index.ts` (41 commits), `desktop-adapter.ts` (37) and `web-adapter-core.ts` (34) are at the top by
  change frequency. → Evolutionarily: freeze the forwarding repositories, expose new capabilities through a
  port, as database and project do. No single-shot merge. · M / low / no.

**Databases**

- **DB-01** — Editing a single cell: `find_database_container` → `discover_vault` parses the whole vault,
  then for each affected note the container is walked (the index is only a fallback path), then once more in
  the projection. All of this runs under `mutation_gate` and the `conn` lock, and this pattern appears in roughly 30 places.
  Inserting 100 cells on large vaults blocks note saving. → Take the path from the `db_members` or `notes`
  index and verify it by reading a single file; take the container from `db_databases.container_path`.
  · M / medium / yes · `database/mutations/value_batch.rs`, `mutations/support.rs:54-100`. Check
  (sampled): confirmed.
- **DB-02** — A new row, property or rename → a full rebuild of the projections of all databases in the vault
  inside the locks. For value edits there is already an incremental path. → Limit the rebuild to the affected database. ·
  L / medium / yes · `commands/database.rs:415…1371`, `projection.rs:109`.
- **DB-03** — A single error-level diagnostic anywhere in the vault (an unreadable `.md` outside databases, a duplicate
  `amby-id`) makes all rebuilds "unpublished": the created row is written, but does not appear in any
  database. Value edits in existing rows go through. → Treat errors outside a container as warnings for the
  projection, or freeze only the affected database. · M / medium / yes ·
  `projection.rs:116-146`. Check (sampled): confirmed.
- **DB-04** — On every render `defaultPropertyWidth` parses the JSON of every loaded row 2–3 times
  (1000 rows × 10 properties ≈ 20–30 thousand `JSON.parse` calls), and this repeats on every scroll step. →
  A memoized `Map<propertyId, width>`. · S / low / no · `table-view.tsx:168-179,496-524`.
- **DB-06** — `commands/database.rs` (2226 lines) is not a thin boundary: the
  "lock → generation → projection → notification" sequence is copied about 15 times, SQL is assembled inside,
  and warnings are compared by their English text. → A common `run_database_mutation(...)` with a typed
  `ProjectionOutcome`; move the summary SQL into `database::summary`. · M / low / no.

**Workshop**

- **CRE-02** — A JSON Canvas node of an unknown type (a spec extension, a new Obsidian type)
  is loaded as a text card and after any edit is saved as `type:"text", text:""`. The node's other
  fields remain. In addition, every save rounds the coordinates of untouched nodes. → Store the unknown
  node as is and show it as a read-only placeholder. · M / medium / yes ·
  `src/lib/canvas-format.ts:188-197`. Check (sampled): confirmed.
- **CRE-03** — Completed journals in `.amby/recovery/creative/` (up to 256 KB each) are never deleted and
  are parsed on every vault open. → On open, delete completed ones older than N days. · S / low
  / yes · `src-tauri/src/project/journal.rs:234`.

**Shell**

- **SHELL-01** — Rolling back a cancelled move (answer "No" to the link rewrite) or a failed move puts
  the "display" tree, with icons and main-layer types mixed in, into the "raw" one. After that, resetting an icon
  or changing the main layer works incorrectly. → Use the raw tree for the rollback. · S / low / yes ·
  `workspace-orchestration.tsx:896`, `use-document-mutations.tsx:295,332,396`.
- **SHELL-02** — The link graph (all notes and all edges) is re-read over IPC 150 ms after every
  tree change, even when the graph and the links panel are closed, and the new object at the root re-renders the whole
  workspace. → Load lazily, when the graph is actually needed. · M / medium / yes ·
  `use-vault-data.ts:539-573`.
- **SHELL-03** — The notices centre and the AI panel subscribe to the entire `openDocs`, so while typing
  every deferred publication recomputes the centre's sections and re-renders the docs. → A selector over
  `{id, path, flags}` and `useShallow`. · S / low / no · `notices/use-notices-centre.ts:25`, `ai-panel.tsx:78`.
- **SHELL-04** — The root passes about 110 inputs into `usePaneRenderers` and about 70 props to each layout,
  with no memoization barrier. Any slice change re-renders the whole shell, and every new capability
  is an edit in 3–4 places (hence 51 commits). → In steps: (1) overlay flags go into a small store; (2)
  layouts and panels select their own slices; (3) extract `use-active-document`. · L (in parts) / medium
  / no · `workspace-orchestration.tsx:1412-1726`.

**Modules, AI, log**

- **MOD-05** — Two "download and enable" handlers in `settings-modules.tsx` on failure write only
  `console.error`, and nothing happens. The neighbouring `settings-package-manager.tsx` does it correctly
  (`reportInstallFailure`). The `v0.1.4` URL is copied several times. → One install path with a notice,
  a `catalogDownloadUrl` helper. · S / low / no · `settings-modules.tsx:645,814`.
- **MOD-06** — `ModulesTab` is a single closure of about 1000 lines with about 19 `useState` calls; MOD-05 appeared
  here precisely because of copy-paste. → Extract `useModuleInstallFlow`. · M / medium / yes.
- **MOD-07** — About 350 lines of `ALLOWED_EVENTS` in `logging.rs` and a mirror in `src/lib/debug/event-codes.ts`.
  Every new event is an edit in three places, and an omission in production silently turns into
  `diagnostic.invalid_event`. This is the main reason for the frequent changes to `logging.rs`. → Keep the allowlist (it is
  a privacy control), but hold it in a single data file: in Rust via `include_str!`, plus a TS filter. · M /
  low / no · `logging.rs:965-1320`.

**Appearance and texts**

- **UI-01** — The notice-rules check verifies colours and `text-destructive` only in the listed
  files. Outside them there are 64 red `role="alert"` blocks and 28 palette classes (for example,
  `BubbleToolbar.tsx:614`). One level looks three different ways, and themes cannot recolour it. → A rule
  instead of a file list, plus a baseline list of the current places that can only shrink. · M / low / yes.
- **UI-02** — Action failures ("New note", following a link) go only to `console.error`:
  `use-document-crud.ts:480,535`, `use-document-loading.ts:379`, `use-wiki-navigation.ts:61`, 49
  calls in 19 files in all. → A line next to the element or a `warning` in the centre with a code; a rule in the check "no
  `console.error` without `logger`" with a baseline list. · M / low / yes.
- **UI-03** — 316 of 3696 localization keys (8.5%) are not used anywhere, for example `settings.debug.*`
  (44) and `settings.modules.*` (28). → An "unused keys" test with an allowlist of dynamic prefixes, then
  delete in one batch. · S / low / no.
- **UI-05** — `scrollbar-width` and `scrollbar-color` (`app.css:743,6548`) contrary to the "Browser engines" rule:
  on WebView2 `::-webkit-scrollbar` stops working, and on Windows the database table's scrollbar loses its look.
  → Only `::-webkit-scrollbar`. · S / low / no.
- **UI-08** — Document tabs are a `motion.div` with `onClick`, without `role` and `tabIndex`, so they cannot be
  reached from the keyboard. → `role="tablist"`/`tab`, arrow keys. · M / medium (interaction with
  drag and drop) / yes · `header-tabs.tsx:313-360`. Check (sampled): confirmed.
- **UI-09** — `ImageLightbox.tsx:86` and the centred variant of `database-side-peek.tsx:73` set
  `aria-modal`, but do not move, hold or return focus. → Radix `Dialog`. · S / low / no.

**Tooling**

- **TOOL-01** — `bindings:check` compares a fresh export with the working-copy file, while `rust:test` (the
  `export_bindings` test) overwrites it beforehand. A stale committed `bindings.ts` is caught neither in
  CI, nor in `verify:full`, nor at release. → Run the check before `rust:test` or add `git diff
--exit-code src/lib/bindings.ts` after it. · S / low / no · `src-tauri/src/lib.rs:429-440`,
  `.github/workflows/verify.yml:202-204`. Check (sampled): confirmed.
- **TOOL-02** — Signing the CLA by comment cannot work: `issue_comment` runs from the default
  branch, and `main` has no `cla.yml`. → Move it to `main` or state in CONTRIBUTING that signing does not
  work yet. · S / low / no.
- **TOOL-08** — The only tests that go through the real `DesktopAdapter` → IPC → Rust
  (`tests/native/*`, about 170 KB) are not run in any CI. → Try `test:storage:live` on a
  macOS runner with `continue-on-error`; if the WebView does not come up there, record that in `tests/MAP.md`. · M /
  low / no.

### 3.5. Low

| ID       | Summary                                                                                                                          | Where                                                                         | Proposal                                                         | Effort |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| SAVE-14  | "Accept external" leaves the draft behind; it is offered again on open                                                           | `external-conflict-dialog.tsx:85-126`                                         | Delete the draft on `acceptExternal`                             | S      |
| SAVE-15  | Drafts that differ only in leading/trailing whitespace or a sketch's `appState` are silently deleted as "equal"                  | `recovery-restore.ts:6,66-68`                                                 | Compare exactly (only normalize line endings)                    | S      |
| SAVE-16  | `PerKeySerialQueue` is dead code, yet the maps call it the foundation of autosave                                                | `src/lib/per-key-queue.ts`, `autosave/MAP.md`                                 | Delete it, point the maps to `note-mutation-queue.ts`            | S      |
| EDIT-06  | Every 200 ms pause is a full serialization and 1–2 full parses (a hypothesis about the cost)                                     | `markdown-block-source.ts:274-307`                                            | Assemble from the block cache, skip the repeat parse             | M      |
| EDIT-07  | Table column width changes in Live but is not saved                                                                              | `schema.ts:41`                                                                | `resizable: false`                                               | S      |
| EDIT-08  | Mixed line endings → "Source only", but the first edit in Source rewrites them, without a snapshot                               | `source-editor.tsx:322-364`                                                   | Document it in the matrix or take a snapshot                     | S      |
| EDIT-09  | Numbered lists separated by two blank lines: Amby sees two, everything else sees one; not documented                             | `markdown-block-plugins.ts:238-315`                                           | Record it in the matrix                                          | S      |
| EDIT-10  | A failure of the admission check in Live is swallowed without a code                                                             | `note-editing-policy.ts:49-54`                                                | `logger.warn("editor.live_admission_failed")`                    | S      |
| EDIT-11  | Block conversions live in a UI component with no tests of their own                                                              | `BlockActionsPanel.tsx:100-140,1135-1180`                                     | Move into `block-conversion.ts`                                  | S      |
| CORE-11  | Saving a note with valid frontmatter normalizes line endings across the whole file (mixed files only)                            | `note_index.rs:400`, `frontmatter.rs:1628-1640`                               | As in the "opaque" path: a byte-for-byte envelope                | S      |
| CORE-12  | Rename, move, archive: an "exists" check, then `rename` — replaces a file that appeared in between                               | `bundle/path_ops.rs:80-98`                                                    | Rename without replacement (`RENAME_EXCL`)                       | M      |
| CORE-13  | The "poisoned" mutex policy is applied unevenly (`.lock().unwrap()` in the watcher, `vault_context`)                             | `vault_context.rs:147-150`, `watcher.rs:156-159`, `database/runtime_state.rs` | `lock_or_recover` everywhere                                     | S      |
| CORE-14  | Names on create and rename are barely validated (`.git`, `CON`, `a:b`)                                                           | `bundle/execute.rs:50-53`                                                     | A common `validate_item_name` and a repeated `confine`           | S      |
| CORE-15  | Link rewriting edits files in `.trash/`, `.obsidian/`, `.amby/archive`                                                           | `index/refactor.rs:243-256`                                                   | `should_descend` and replace only the link syntax                | S      |
| CORE-16  | `frontmatter.rs` contains the atomic-write layer (125 calls in 58 files)                                                         | `frontmatter.rs:1-200,1581-1832`                                              | Extract into `atomic_fs.rs`                                      | S      |
| CORE-17  | Documents and maps diverge from the vault code (see section 5)                                                                   | `docs/vault-format.md:440`, `agent-guidelines.md:102`                         | Fix them                                                         | S      |
| CORE-18  | Atomic replacement drops permissions and xattrs; a name of ≥ ~235 bytes cannot be saved                                          | `frontmatter.rs:1694-1718`                                                    | A short temp-file name, copy the permissions                     | S      |
| SYNC-03  | The `path` in a conflict's synced `meta.json` is not validated: a read can escape the vault (a write cannot)                     | `conflict_store.rs:446`, `session.rs:505`                                     | `check_path` and read through `VaultFs` (downgraded from Medium) | S      |
| SYNC-05  | "Keep both" writes the copy with replacement and swallows errors                                                                 | `sync/session.rs:676-741`                                                     | Move into `FileConflictStore`, without replacement               | M      |
| SYNC-06  | Four sync-event subscription failures are swallowed                                                                              | `sync-notices-host.tsx:193-248`                                               | `reportSyncListenFailed`                                         | S      |
| SYNC-07  | The temporary gate became a constant, but still goes through IPC and status                                                      | `sync/gate.rs:9`                                                              | Remove the branch, read `META_TEST_VAULT` as before              | S      |
| SYNC-08  | The account key and the device token are plain `String`s for the whole run time                                                  | `sync/secrets.rs:143-182`                                                     | `Zeroizing<String>`                                              | S      |
| SYNC-09  | On failure `derive_key` would return a zero key (the failure is impossible; this is hardening)                                   | `sync/core/src/crypto/primitives.rs:82-89`                                    | `expect` with a justification                                    | S      |
| SYNC-10  | The list of synced `.amby` folders is stored twice; a divergence has already happened (`adb907ea`)                               | `sync/vault_fs.rs:64-70`                                                      | A single `const` from `rules`                                    | S      |
| IPC-07   | 9 dead debug "shim" commands and the `test_vault` argument                                                                       | `commands/debug.rs:155-262`, `commands/sync.rs:292-301`                       | Delete, regenerate bindings                                      | S      |
| IPC-08   | `debug-repository` erases the generated types (`as unknown as`)                                                                  | `storage/debug-repository.ts:5-32`                                            | Call `commands.*` directly                                       | S      |
| IPC-09   | Recovery drafts and property groups go over IPC bypassing `storage/`                                                             | `recovery-drafts.ts:1,78`, `property-groups-port.ts`                          | A port in `storage/` or record it in the map as an exception     | S      |
| IPC-11   | `vault-meta` writes are not bound to a vault (a race on vault switch; a timing hypothesis)                                       | `app_data.rs:56-60,176-183`                                                   | `expectedGeneration`                                             | S      |
| IPC-12   | Module download reads the whole body before the 50 MB check (duplicate of MOD-03)                                                | `package_manager.rs:608-615`                                                  | A stream with a limit                                            | S      |
| DB-05    | An empty `expectedRevision` = "no conflict check"                                                                                | `mutations/value_batch.rs:~208`                                               | Make the revision mandatory                                      | S      |
| DB-07    | Records whose key is user-defined are on plain objects (the `Map`/`Object.create(null)` rule)                                    | `database/use-board-lanes.ts:149-157`                                         | `Map` + a `__proto__` test                                       | S      |
| DB-08    | A formula longer than ~64 terms fails with `formulaTooDeep`                                                                      | `database/formula.rs:518-535`                                                 | Iterative evaluation                                             | S      |
| DB-09    | Large files: only `commands/database.rs` and `table-view.tsx` carry a real cost                                                  | —                                                                             | Split those, leave the rest alone                                | M      |
| CRE-04   | An unreadable workshop journal is silently ignored                                                                               | `project/journal.rs:206-212`                                                  | Quarantine and `RecoveryRequired`                                | S      |
| CRE-05   | Rollback deletes the workshop marker without comparing bytes                                                                     | `project/recovery.rs:232-237`                                                 | Compare against the journal                                      | S      |
| CRE-06   | The test workshop builder lives in the production `create.rs`                                                                    | `project/create.rs:461-860`                                                   | Move into a `#[cfg(test)]` module                                | M      |
| CRE-07   | The size of the workshop frontend (31 thousand lines, ~14 thousand of them tests) is breadth of capability, not duplication      | `creative/`                                                                   | No separate refactoring                                          | L      |
| SHELL-05 | `secondaryTabKey`/`toggleSplit` is a dead second split model                                                                     | `use-tabs-store.ts:66,129,183`                                                | Delete                                                           | S      |
| SHELL-06 | The tree helpers in `use-vault-data` are functions recreated on every render; the linter warning is not a bug, but it is fragile | `use-vault-data.ts:168-231`                                                   | `useCallback` and remove the `disable`                           | S      |
| SHELL-07 | Settings are rewritten through an allowlist: unknown nested keys from another build are erased (downgraded)                      | `app-config.ts:435-537`                                                       | Keep the raw object and overlay the normalized one               | M      |
| SHELL-08 | `updateDockPrefs` merges into the render snapshot; `prefs` between windows is "last writer wins"                                 | `workspace-orchestration.tsx:303-306`                                         | Merge from `getState()`                                          | S      |
| SHELL-09 | The "special document" predicate is copied into 10+ places                                                                       | `workspace-orchestration.tsx:222-226,732-770`                                 | `isLayerDocument`                                                | S      |
| SHELL-10 | An unguarded `localStorage.setItem` in an effect; the manual tree order exists only in the WebView                               | `panels/files-panel.tsx:218-221`                                              | try/catch; keep the order in `workspace.json`                    | S      |
| MOD-02   | Rust accepts unsigned `community` packages and any HTTPS address (currently inert; downgraded)                                   | `package_manager.rs:461`                                                      | Reject `kind != official` before plugins are enabled             | S      |
| MOD-03   | Package download reads the whole body before the size check                                                                      | `package_manager.rs:608-615`                                                  | A stream with a limit                                            | S      |
| MOD-04   | No downgrade protection when publishing a package                                                                                | `package_manager.rs:884-895`                                                  | Refuse when `version <= active`                                  | S      |
| MOD-08   | Aliases in the log are a non-cryptographic hash, with the salt in the same record                                                | `logging.rs:1625-1639`                                                        | A keyed hash or document it as "for matching only"               | S      |
| MOD-09   | Three different definitions of "local host" in the AI code                                                                       | `ai/consent.rs:46-54`, `ai.rs:299`                                            | A single `host_class`                                            | S      |
| MOD-10   | Update failures are classified by substrings of other parties' messages                                                          | `app-updater.ts:63-69`                                                        | Pin it with a test on real strings                               | S      |
| UI-04    | `resources.ts`: only the compiler enforces structural equality; en has 31 extra `_few/_many` keys                                | `resources.ts`                                                                | A test for key and placeholder equality                          | M      |
| UI-06    | `app.css` has no `@supports`, although `color-mix` (41) and `dvh` (3) are used (partly a hypothesis)                             | `src/themes/app.css`                                                          | `vh` before `dvh`; set `minimumSystemVersion`                    | S      |
| UI-07    | About 38 dead classes (~100 rules, `.md-body` — 33) and 13 unused tokens                                                         | `app.css`                                                                     | Delete                                                           | S      |
| UI-10    | The canvas panel's colour buttons have no accessible name                                                                        | `canvas/canvas-toolbar.tsx:57-62,458-548`                                     | `aria-label` from the locale                                     | S      |
| UI-11    | The `isEnterKey` lint rule misses `case "Enter"` and a destructured `key`                                                        | `eslint.config.js:63`                                                         | Add selectors                                                    | S      |
| UI-12    | 27 hard-coded RU/EN search synonyms in the block menu                                                                            | `BlockActionsPanel.tsx:211,674-680`                                           | Locale key `blockMenu.aliases.*`                                 | S      |
| TOOL-03  | A direct `rfd = "0.16"` duplicates `rfd 0.17` of the dialog plugin; the reason in the document is out of date                    | `src-tauri/Cargo.toml:40`                                                     | Raise to 0.17                                                    | S      |
| TOOL-04  | `clippy::unwrap_used` is not enabled anywhere; 135 `#![allow]` suppress nothing                                                  | `src-tauri/Cargo.toml`                                                        | `[lints.clippy] unwrap_used = "deny"`                            | M      |
| TOOL-05  | `tests/component`, `tests/e2e`, `scripts` are not checked by `tsc`                                                               | `tsconfig.json:25`                                                            | `tests/tsconfig.json` in `typecheck`                             | S–M    |
| TOOL-06  | Linter warnings do not block the check                                                                                           | `package.json:21`                                                             | Fix 4, `--max-warnings 0`                                        | S      |
| TOOL-07  | `version:check` and `test:update-channels` run only at release                                                                   | `verify.yml`                                                                  | Add to the `docs` job                                            | S      |
| TOOL-09  | Floating stable Rust with `-D warnings`; no MSRV, `--locked`, `.nvmrc`                                                           | `verify.yml:131,164`                                                          | `rust-toolchain.toml` and others                                 | S      |
| TOOL-10  | Actions with secrets are pinned by a mutable tag (`tauri-action@v1`)                                                             | `release.yml:244-249`                                                         | Pin by SHA; Dependabot                                           | S      |
| TOOL-11  | A stale `scripts/dev-only-paths.txt` remains on `beta`/`main`                                                                    | `scripts/dev-only-paths.txt`                                                  | Add the file to the list itself                                  | S      |
| TOOL-12  | Minor map discrepancies (the test `empty-action.test.tsx` in the workshop map does not exist)                                    | `creative/workshop/MAP.md:31`                                                 | Fix                                                              | S      |
| TOOL-13  | `verify`/`verify:full` does not cover `sync/` (`sync:lint`, cargo-deny)                                                          | `package.json:58`                                                             | Add                                                              | S      |
| TOOL-14  | Minor dependency hygiene (`@types/d3-force` in `dependencies`, overrides without a reason)                                       | `package.json:94`                                                             | Move, document                                                   | S      |

---

## 4. Obsolete code and dependencies

**Can be removed (not used by anything):**

- 9 debug commands "for old frontends" and `open_devtools`/`is_devtools_open` (IPC-07). There are no old
  frontends: the interface is baked into the binary.
- The `test_vault` argument and the `GATES_PASSED = true` gate branch (SYNC-07, IPC-07). Keep reading
  `META_TEST_VAULT` for compatibility.
- `src/lib/per-key-queue.ts` and its test (SAVE-16).
- `secondaryTabKey`/`toggleSplit` (SHELL-05).
- 316 localization keys (UI-03), about 38 dead classes and 13 CSS tokens (UI-07).
- 135 lines of `#![allow(clippy::unwrap_used…)]` — after a real ban is enabled (TOOL-04).
- The test path `WorkshopKind::Partial` — move it out of production code (CRE-06).
- The `property_store.rs` writers (only `#[cfg(test)]`) — mark them as test data (CORE-17).

**Compatibility shims that are alive and needed:** reading the v1 history manifest, the v1 ID migration logs,
the old workshop log names (they are only cleaned up), `META_TEST_VAULT`. Do not touch them while old files
may still sit in app-data or vaults.

**Dependencies — update now** (within `^`, patch and minor; afterwards `verify` and `test:browser`):

- Tiptap 3.32.2 → 3.34.0, all `@tiptap/*` at once;
- vite 8.3.8, zustand 5.1.0 (read the release notes);
- @playwright/test 1.65, eslint 10.15, typescript-eslint 8.72.2;
- prettier 3.10 — as a separate commit with the reformatting;
- mermaid 12.3, motion 14.14, lucide-react 1.73, postcss 8.5.33.

In Rust: `rfd` 0.16 → 0.17 (TOOL-03) — the only duplicate that belongs to us.

**Do not update now:**

- **Tailwind 4:** the new engine requires fresh CSS features (cascade layers, `@property`), while the
  "Browser engines" policy keeps old WebKit and WebKitGTK in mind; besides, it is a configuration rewrite.
- **TypeScript 7:** a new compiler, needs a separate tooling compatibility plan.
- **i18next 27 / react-i18next 18:** major versions with API changes; no benefit for the product.
- **happy-dom 21:** the risk of breaking 437 test files for zero benefit.
- **knip 6.45:** can be updated, but not urgent.

**Duplicate Rust versions** (`cargo tree -d`, about 30 crates: getrandom ×4, base64 ×3, etc.) come from
Tauri, wry, zbus and specta, not from our direct dependencies. There is nothing to fix them with and no reason to.

---

## 5. Documentation-versus-code discrepancies

| Document                                                        | What it says                                                                                  | What the code does                                                                                            | Finding          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| `docs/vault-format.md:440-443`                                  | History is "not cleaned automatically", keeps the 20 most recent                              | There is automatic cleanup (`history.rs:599-621`), «Очистить всё» (Clear all) deletes everything              | CORE-08, CORE-17 |
| `docs/vault-format.md:166-176`                                  | Migration of the inherited `id` happens after preview and confirmation                        | Applied silently on open                                                                                      | CORE-05          |
| `docs/vault-format.md` (recovery log)                           | A draft write failure is reported                                                             | Only `console.warn`                                                                                           | SAVE-08          |
| `docs/ai/agent-guidelines.md:102`                               | `.amby/properties.json` — a durable file next to the notes, write through `property_store.rs` | Values live in frontmatter, the `property_store.rs` writers are test-only                                     | CORE-17          |
| `docs/ai/agent-guidelines.md` ("Generated IPC Bindings")        | CI rejects stale bindings                                                                     | The check always passes                                                                                       | TOOL-01          |
| `docs/ai/agent-guidelines.md` ("Browser engines")               | "ESLint enforces this" (`isEnterKey`)                                                         | The rule skips `case "Enter"`                                                                                 | UI-11            |
| `src-tauri/src/MAP.md`                                          | Index calculations do not rewrite files                                                       | `assign_missing_identities` writes `amby-id` during scanning                                                  | CORE-17          |
| `src/components/workspace/autosave/MAP.md`, `src/lib/MAP.md:20` | The queue is `PerKeySerialQueue`                                                              | Dead code; in practice it is `note-mutation-queue.ts`                                                         | SAVE-16          |
| `autosave/MAP.md` (Verification)                                | The harness and the stress test are integration coverage                                      | A fake renderer                                                                                               | SAVE-13          |
| `src/lib/storage/MAP.md`                                        | Components do no direct file IO                                                               | `recovery-drafts.ts`, `property-groups-port.ts` go to IPC directly                                            | IPC-09           |
| `docs/markdown-compatibility.md:108`                            | Mixed line endings are "Source only", as if preserved                                         | The first edit in Source normalizes them                                                                      | EDIT-08          |
| Syntax matrix                                                   | —                                                                                             | Splitting numbered lists with two blank lines is not described                                                | EDIT-09          |
| The owner's Live Preview decision record                        | Footnotes stay "opaque"                                                                       | Since 2026-10-08 (`a42fc13a`) footnotes are editable; no losses found, but the condition is formally weakened | section 7        |
| `creative/workshop/MAP.md:31`                                   | Test `empty-action.test.tsx`                                                                  | The file does not exist                                                                                       | TOOL-12          |
| `docs/security-advisories.md`                                   | The reason for the direct `rfd`                                                               | Outdated                                                                                                      | TOOL-03          |
| `scripts/dev-only-paths.txt` on `main`                          | An old version of the list                                                                    | Outdated (harmless)                                                                                           | TOOL-11          |
| The brief and the project memory                                | "Mutations do not re-read the whole vault"                                                    | True for saving a note; false for opening a note and for databases                                            | CORE-04, DB-01   |

Otherwise the maps are in good shape: a script-based spot check of 32 maps found one real
discrepancy. The rest are omissions, not errors.

---

## 6. What not to do

| Tempting                                                                                                                           | Why it will not pay off                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Split `history.rs`, `database/format.rs`, `validation.rs`, `projection.rs`, `formula.rs`, `query.rs`, `package_manager.rs` by size | Long but cohesive: one responsibility per file, tests alongside. There are no recurring fixes caused by size                                                                   |
| Split `workspace-orchestration.tsx` by size                                                                                        | It is a cohesive composition root; what makes it expensive is prop drilling. The SHELL-04 steps (overlays into the store, slices in consumers) will help, not cutting the file |
| Split `header-tabs.tsx`, `settings-dialog.tsx`, `BlockActionsPanel.tsx`, `use-vault-data.ts`, `app.css` by size                    | Frequent changes come from new features, not from tangled state. The real problems of these files are EDIT-02/11, SAVE-03/06, UI-07                                            |
| Split the `sync/core` engine modules                                                                                               | The modules correspond one to one to the plan sections Д10–Д18; the simulator and mutation checks are built on them                                                            |
| Make `web-adapter-core.ts` an exact copy of the Rust vault                                                                         | It is a fallback path for development. It is cured by failures and a shared contract (IPC-05), not by a new imitation                                                          |
| Merge the repositories, `index.ts` and the storage ports in one go                                                                 | There are very many call sites. Better to freeze and move to the ports gradually (IPC-10)                                                                                      |
| Replace seamless YAML editing with a "parse → write" library                                                                       | Comments, quotes and order would be lost, which violates the rule about unknown content                                                                                        |
| Rewrite paths on `cap-std`                                                                                                         | The TOCTOU window is described in the code and is narrow; cheap input checks first (CORE-01/06/07)                                                                             |
| Rewrite the block-source design in the editor                                                                                      | It is the best part of the editor; the problems are in the content that the editor itself produces                                                                             |
| Bring back modal questions about drafts                                                                                            | The current non-modal cards are the right solution                                                                                                                             |
| Turn on `isolate: false` in vitest                                                                                                 | −15 seconds out of 63 at the cost of flaky, order-dependent failures (shared stores, `vi.mock`, happy-dom globals)                                                             |
| Add more table virtualization                                                                                                      | Rows are already virtualized; DB-04 (JSON parsing during render) is what is slow, and that is what to fix                                                                      |
| Tailwind 4 / TypeScript 7 / i18next 27 now                                                                                         | See section 4                                                                                                                                                                  |
| Turn on `freezePrototype`                                                                                                          | Decided earlier: it breaks d3 at startup                                                                                                                                       |

---

## 7. Plan

### 7.1. Quick wins (≤ half a day each; wherever behavior changes — a red test first)

| Task                                                                                                      | Benefit                                                   | Cost   | Risk | Tests first                 |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------ | ---- | --------------------------- |
| CORE-01: the vault root and service paths cannot be deleted or renamed                                    | Closes the most dangerous one — loss of the whole vault   | S      | low  | yes                         |
| EDIT-02: any transaction with `docChanged` counts (or a `uiEvent` tag in the block menu)                  | Mouse actions stop being lost                             | S      | low  | yes (e2e)                   |
| SAVE-03: `markSaved` and a "clean" reload ask the autosave queue                                          | External edits stop being overwritten                     | S      | low  | yes                         |
| SAVE-01 + SAVE-05 (together with SAVE-12): a bad canvas is read-only; strip the BOM; failures are visible | Canvases and sketches stop being silently lost            | S–M    | low  | yes                         |
| CORE-07, CORE-06, SYNC-02, SYNC-03: input checks modeled on the neighboring paths                         | Closes escaping the vault and writing into `.git`/`.amby` | S each | low  | yes                         |
| CORE-08: safety snapshots are not deleted by auto-cleanup; errors go to the log; fix the document         | Keeps the promised Live Preview safety net                | S      | low  | yes                         |
| SYNC-04: an RAII guard for the event batch                                                                | The watcher does not go deaf after a panic                | S      | low  | yes                         |
| TOOL-01: `git diff --exit-code src/lib/bindings.ts` after `rust:test`                                     | Restores a real IPC check                                 | S      | low  | no                          |
| SAVE-08, EDIT-10, SYNC-06, MOD-05: failures go to `logger` with a code and to their own place             | Failures are visible to the user and in the log           | S each | low  | partly                      |
| DB-04: memoize column widths                                                                              | Smooth scrolling of large tables                          | S      | low  | no                          |
| UI-05, UI-09, EDIT-07                                                                                     | Windows appearance, focus, not losing column widths       | S each | low  | no                          |
| IPC-07, SAVE-16, SHELL-05, SYNC-07: delete dead code                                                      | A smaller IPC surface and fewer false trails              | S      | low  | no (typecheck and bindings) |
| TOOL-06, TOOL-07, TOOL-11, TOOL-03                                                                        | A stricter gate, fewer surprises at release               | S      | low  | no                          |

### 7.2. Tasks for separate plans

| Plan                                             | What it includes                                                         | Benefit                                              | Cost | Risk                            | Tests first                              |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- | ---- | ------------------------------- | ---------------------------------------- |
| **A single source of truth about unsaved state** | SAVE-02, SAVE-06, SAVE-13, EDIT-05, the remainder of SAVE-03             | Removes a whole class of silent losses (pattern Б)   | M–L  | medium                          | yes: tests on real hooks first (SAVE-13) |
| **Quitting the app**                             | SAVE-04, flushing edits before `relaunch()`, closing the settings window | Cmd+Q without losses                                 | M    | medium                          | yes, a native test                       |
| **Resilience to a single bad file**              | CORE-02, DB-03, CRE-04, CORE-04                                          | The vault opens, databases work                      | M    | medium                          | yes                                      |
| **Hot paths without a full walk**                | CORE-04, DB-01, DB-02, CORE-09, SHELL-02                                 | Speed on large vaults, no save blocking              | L    | medium                          | yes, plus the `db:benchmark` benchmark   |
| **History by note ID**                           | CORE-03 (an additive `note_id` field), document                          | History survives a rename                            | M    | medium (format)                 | yes; under the migration rules           |
| **Tables and line breaks in the editor**         | EDIT-01, EDIT-03, EDIT-04                                                | Edits in Live read back the same way                 | M    | medium                          | yes (samples and failure tests)          |
| **Path provenance in IPC**                       | IPC-03, IPC-02, CORE-06, a window-label check for dangerous commands     | Defense in depth against a script in the window      | M    | medium (drag-and-drop, recents) | yes                                      |
| **Typed vault errors**                           | IPC-06, IPC-04                                                           | Correct texts, no regexes over paths                 | M    | low                             | yes                                      |
| **Finish the notice migration**                  | UI-01, UI-02 (a rule check and a baseline list that only shrinks)        | The notice model is truly everywhere                 | M    | low                             | yes (a baseline test)                    |
| **Native contract in CI**                        | TOOL-08, IPC-05                                                          | Real IPC is checked on every push                    | M    | low                             | —                                        |
| **Round-tripping of unknown JSON fields**        | SHELL-07, CRE-01, CRE-02                                                 | Other builds and programs do not lose their own data | M    | medium                          | yes                                      |
| **Plumbing for database and mutation commands**  | DB-06, CORE-10                                                           | Fixes stop coming in pairs                           | M    | low                             | no (tests already exist)                 |

### 7.3. Strategic questions for the owner

1. **SAVE-02: when there is neither a file nor a draft at close.** Keep the window open and ask
   ("keep the window / close and lose the text")? Recommendation: yes. This is a `decision`-level question, and it is
   always better than a silent loss. Is a fallback draft in app-data needed if the vault is on another disk?
2. **CORE-05: inherited ULIDs in `id`.** The code migrates them silently, the document promises confirmation. Which
   is right? Recommendation: show them for confirmation (the rule about foreign metadata).
3. **CORE-08: automatic history cleanup.** May it delete `note-rewrite` and `sync-overwrite` snapshots? Whether
   the condition for normalization in Live Preview holds depends on this. Recommendation: never delete
   the last snapshot of each of these reasons.
4. **EDIT-01: tables.** Exactly one paragraph per cell (strict GFM, simpler) or `<br>` support (more convenient,
   needs a round-trip test)? Recommendation: strict first, `<br>` on request.
5. **Footnotes (condition 1 of the Live Preview decision).** Since 2026-10-08 footnotes are editable, while the decision
   record says "opaque". No losses found. Update the decision record or make footnotes opaque again?
6. **MOD-01: when to change the package signing key.** By the recorded rule — before third-party plugins are enabled.
   I suggest also rejecting `community` packages in Rust right away (MOD-02): it is one line, and the
   invariant will hold not only through a flag in the frontend.
7. **CORE-15: rewriting links inside `.amby/archive`.** Should archived notes get new
   links on rename (currently yes, along with `.trash/` and `.obsidian/`)?
8. **UI-06: minimum macOS version.** Set `minimumSystemVersion` (Safari ≥ 16.2 covers
   `color-mix`) or support fallbacks?
9. **IPC-03 and window permissions.** Restrict dangerous commands (vault change, migration, import, leaving
   sync) to the `main` and `settings` windows by window label? Cheap and does not get in the way of the UI.

---

## 8. Appendix

### 8.1. Method

- **Phase 0:** the orchestrator ran the project checks once and collected the metrics (below).
- **Phase 1:** 11 subagents only read code, each in its own area. The starred areas (saving,
  editor, Rust core, sync, the storage/IPC boundary) were reviewed by Opus 5.5, the rest by Sonnet 5.5. Each
  had a shared brief with the project rules, the owner's decisions, an "already resolved" list and the finding
  format. The subagents did not run builds or tests. Four reviews were interrupted by the usage limit; after the limit reset
  they continued from where they stopped.
- **Phase 2:** for each of the 14 Critical/High findings a separate verifier (Opus 5.5) received only the
  claim and the references and tried to refute them from the code. Outcome: 12 fully confirmed (for some, lines and wording were
  corrected), 2 partially (SYNC-01, CRE-01), none refuted, 5 downgraded. Of Medium/Low, 14 were spot-checked
  (about 11%) by two verifiers: none refuted, 3 downgraded. The threshold "wrong in more than one
  of five" was not exceeded, so a full re-verification was not done.
- **Phase 3:** the orchestrator consolidated the findings, merged duplicates across areas (MOD-03 = IPC-12; SYNC-07 and
  IPC-07; CORE-17 absorbed the document discrepancies) and singled out the patterns.

### 8.2. Phase 0 check results

| Command                         | Exit code                          | Result                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`             | 0                                  | no errors                                                                                                                                                                                                                                             |
| `npm run lint`                  | 0                                  | 0 errors, 4 warnings: `database/option-actions.tsx:29` (react-refresh), `file-actions/use-document-mutations.tsx:423` (missing dependency `refreshTree` — not a bug, SHELL-06), 2 unused imports in `tests/component/bundle-remote-tabs.test.tsx:6-7` |
| `npm run knip`                  | 0                                  | clean (one configuration hint about `.css`)                                                                                                                                                                                                           |
| `npm run docs:check`            | 0                                  | "31 maps, 5 entry/guideline documents" — OK                                                                                                                                                                                                           |
| `npm run rust:clippy`           | 0                                  | strict mode `-D warnings`, clean                                                                                                                                                                                                                      |
| `npm outdated`                  | 1 (usual when outdated ones exist) | 30 packages, see section 4                                                                                                                                                                                                                            |
| `cargo tree -d` (src-tauri)     | 0                                  | about 30 crates in several versions, almost all transitive from Tauri                                                                                                                                                                                 |
| `npx vitest run --maxWorkers=3` | 0                                  | 437 files, 4203 tests, all passed, 63 s (module import — 31% of the time)                                                                                                                                                                             |

Not run: `test:browser` (Playwright), the native harnesses, `rust:test`, `sync:test`. The review only
read code; the final build is `npm run build` (see 8.6).

### 8.3. Metrics

- **Size:** about 450 thousand lines in `.ts/.tsx/.rs/.css/.mjs/.js` including tests, without `bindings.ts`, lock files and
  `node_modules`. The largest areas: creative 31.3k, database UI 29.2k, tiptap 25.8k,
  `src/lib` 23.7k, `sync/core` 19.6k, `sync/sim` 19.5k, sync UI 12.4k, `sync/conformance`
  12.3k, `tests` 11.5k, Rust database mutations 10.4k.
- **Top files by lines:** `resources.ts` 9070, `app.css` 7207, `commands/database.rs` 2226,
  `logging.rs` 2040, `project/text_test.rs` 2023, `tests/native/database-contract.ts` 2002,
  `database/format.rs` 1992, `sync/server_history_tests.rs` 1900, `database/validation.rs` 1883,
  `frontmatter.rs` 1836, `database/projection.rs` 1796, `workspace-orchestration.tsx` 1726,
  `sync/sim/src/mini.rs` 1690, `sync/session_tests.rs` 1668, `web-adapter-core.ts` 1661,
  `package_manager.rs` 1639, `table-view.tsx` 1618, `project/create.rs` 1580, `history.rs` 1519,
  `commands/mutations.rs` 1503, `formula.rs` 1489, `query.rs` 1470, `create_test.rs` 1417,
  `settings-modules.tsx` 1377, `sync/session.rs` 1360, `creative-panel.test.tsx` 1358, `links_test.rs`
  1349, `projection_test.rs` 1343, `relation_schema_recovery.rs` 1333, `BlockActionsPanel.tsx` 1283.
- **Hot spots** (changes over 90 days × lines): `resources.ts` (131 × 9070),
  `workspace-orchestration.tsx` (51 × 1726), `web-adapter-core.ts` (34 × 1661), `desktop-adapter.ts`
  (37 × 1203), `commands/mutations.rs` (28 × 1503), `logging.rs` (20 × 2040), `commands/database.rs`
  (18 × 2226), `storage/index.ts` (41 × 860), `frontmatter.rs` (18 × 1836), `sync/session.rs` (24 × 1360),
  `use-vault-data.ts` (27 × 1146), `lib.rs` (61 × 457).
- **Fixes:** over 90 days there were 730 commits, 112 of them with the `fix` subject. By area, what was counted was file touches by
  `fix` commits, not the number of commits (hence "47" for the editor, while there are fewer commits, see EDIT-05):
  `src/lib` 57, tiptap 47, sync UI 37, Rust sync 35, Rust databases 33, tests 30,
  `src-tauri/commands` 26.
- **Oldest untouched files:** `tiptap/wrap-shortcuts.ts` (2026-05-16), `use-smart-placement.ts`
  (05-18), `lib/canvas-dnd.ts` (05-27), `transclusion-context.ts` (05-31). All small and simple.
- **Markers:**
  - `eslint-disable` — 30 (27 of them `react-hooks/exhaustive-deps`; the ones checked in the editor and shell
    are justified);
  - `#[allow(...)]` — 178 (135 useless `unwrap_used` in tests, see TOOL-04; 10 `dead_code`, 12
    `too_many_arguments`);
  - `unwrap`/`expect` in production Rust code — a few dozen, almost all on static invariants; on
    a mutex — CORE-13;
  - in the production code of the sync crates — 2, both justified;
  - TODO/FIXME/HACK in the sources — 0.

### 8.4. What was not checked and why

- **Runtime:** nothing was reproduced in a running app (the review only read code).
  SAVE-04 and SAVE-11 need native verification; Windows behavior (IPC-04, 8.3 names in SYNC-02) was
  not run.
- **Saving:** the save path in Source (CodeMirror); the web adapter save path; multi-window
  behavior deeper than the `amby:note-written` handler.
- **Editor:** drag-and-drop and column resizing in depth; media paste and drop deeper than
  address construction.
- **Rust core:** `index/links.rs`, `query.rs`, `schema.rs`; `property_groups/`; `tree_patch.rs`,
  `shadow_check.rs`; the system trash `move_path` on macOS and Linux; a watcher event storm (Rust has no
  debounce — not checked whether the renderer dampens it).
- **Sync:** the internals of `sync/sim` and `conformance`; the server's `admin.rs`, `maintenance.rs`, `store.rs`
  (cleanup, GC); recovery in `server_history.rs`; `backup*`; correctness of the `props_groups` merge and
  `merge`; simultaneous `sync_enable_vault` from two windows.
- **Databases:** `relation_recovery.rs`/`relation_schema_recovery.rs`, `yaml_sync.rs`, `layout.rs`; SQL
  construction in `validation/format/query` (injection through field names); whether the user can see the
  `staleReadOnly` state.
- **Workshop:** `links.rs`, the large tests `text_test.rs` and `links_test.rs`, `project-port.ts`, input checking
  in `commands/project.rs` after line 150; notices and localization in the large uncommitted
  diffs.
- **Modules and AI:** the internals of `ai/claude_code/`, `ai/tools.rs`, `provider_stream.rs`; the frontend
  `ai/` (5.6k lines) — only a search for raw errors; `community/` (sandbox, revocation); whether
  Claude Code's `--restricted` works against hooks in `settings.json` (affects IPC-02).
- **Appearance:** token contrast; database table keyboard handling in depth; real rendering in WebKitGTK and
  WebView2.
- **Tooling:** the logic of `update-channels.mjs`; whether the tests compile under strict `tsc`; the internals of
  `sync-gates.yml`.
- **IPC boundary:** input checking inside the large domain command files — only the boundary was checked (the guard on the
  first argument).

### 8.5. Findings in files that were uncommitted at the start of the review

At the start of the review the working copy had 56 modified or new files (`git status --short`). During the review
the owner committed them in `9505e583` ("checkpoint accumulated window, IME and agent workflow changes") and
`7b0bd586`. The review went by the current contents. Findings that concern these files:

| Finding         | File                                                                        | Is the bug related to these changes                                                                    |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| EDIT-02         | `tiptap/BlockActionsPanel.tsx`                                              | No: the diff only switched Enter to `isEnterKey`; the save gate is older (`14ed4787` or earlier)       |
| EDIT-03         | `tiptap/BubbleToolbar.tsx`, `BlockInsertPanel.tsx`, `BlockActionsPanel.tsx` | No                                                                                                     |
| EDIT-11, UI-12  | `tiptap/BlockActionsPanel.tsx`                                              | No                                                                                                     |
| UI-01           | `tiptap/BubbleToolbar.tsx:614` and other UI files                           | No: notice migration debt                                                                              |
| UI-11           | `eslint.config.js`, new `src/lib/keyboard.ts`                               | Partly: the `isEnterKey` rule was added by these changes and has gaps; `keyboard.ts` itself is correct |
| DB-04           | `database/table-view.tsx`                                                   | No                                                                                                     |
| IPC-01          | `vault/vault-manager.tsx`                                                   | No                                                                                                     |
| IPC-07, CORE-13 | `src-tauri/src/lib.rs`, `src-tauri/src/state.rs`                            | No; SAVE-04 refers to `state.rs:75-91` — the app event handler in its current form                     |
| MOD-05, MOD-06  | `settings/settings-modules.tsx`                                             | No                                                                                                     |
| MOD-07          | `src-tauri/src/logging.rs`, `src/lib/debug/event-codes.ts`                  | No                                                                                                     |

Separately: `confirm-dialog-host.tsx` from these changes is a good model (focus on the safe button, focus
return, `isEnterKey`); the only remark is the red `secret.error` text (relates to UI-01).

### 8.6. Final actions

An entry was added to the "For developers" section of `updates/upd_next.md`. After that
`npm run build` was run; its result was reported in the chat reply.
