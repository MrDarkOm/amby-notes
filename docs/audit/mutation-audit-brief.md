# Task: investigating "the app does not notice its own changes"

For the agent continuing the work. Project: Amby Notes (Tauri 2 / Rust in `src-tauri/src/`, React 19 / TS in `src/`, Zustand, sync in `sync/` and `src-tauri/src/sync/`). First read `AGENTS.md` and `docs/ai/MAP.md`.

## State

- Branch `dev`, commit `f841c938`, working tree clean. Nothing has been pushed to GitHub.
- The notices work (`docs/notices.md`, §16) is finished and merged.
- The needed result: a table of gaps and a plan. The code is not changed at this stage.

## Problem

The file watcher (`src-tauri/src/watcher.rs`, `reconcile_self_write`) deliberately skips Amby's own writes: by write fingerprint, not by time. This means every Rust operation must itself tell the UI what it changed. Otherwise the screen shows stale data. Two confirmed cases have already been fixed:

1. A deleted sketch stayed in the tree: `deleted_paths` in Rust contained only `.md`, fixed in `recycle_bin.rs`.
2. A database showed "0 rows" after a property migration: open databases were not re-read, fixed in `use-document-mutations.tsx` and `property-migration.ts`.

The main open question is sync. If the watcher also treats sync writes as "its own", then after receiving edits from another computer an open note or database may show stale data. This has not been verified.

## Stage 1. Inventory (facts only)

Write it to `docs/audit/mutation-inventory.md`. The `docs/audit` folder exists only in `dev`. If the file already exists, a previous session started it: check it and complete it.

1. **Rust commands that change data.** All `#[tauri::command]` in `src-tauri/src/` that write, move, rename, delete, archive, or restore notes, folders, canvases and sketches, attachments, databases (fields, rows, values, views), properties and property groups, history, trash, vault settings, modules. One table row per command:
   - name and `file:line`;
   - what it changes;
   - what it returns (type; whether there is a list of what changed — `FsMutationResult` with `deletedPaths` / `pathChanges` / `treePatch`, revisions);
   - whether it sends an event (`emit`) and which one.
2. **Calls in the UI.** For each command — all call sites in `src/`, usually via `src/lib/storage/`, and what the calling code does with the result: `applyMutationResult` / `handleApplyMutation`, `patchDoc`, `refreshTree`, `useDatabaseStore…invalidate…`, or nothing.
3. **Subscriptions.** All `listen(` calls and backend event subscriptions in `src/`: file, event, what the handler updates.
4. **Writes outside commands.** Applying remote edits via sync, migrations, restore, background tasks. For each write:
   - what it writes;
   - whether it is registered as the app's own write for the watcher;
   - whether it sends an event to the UI.
5. **What could not be determined** and where you looked.

## Stage 2. Analysis

Write it to `docs/audit/mutation-refresh-gaps.md`. Based on the inventory, for each operation answer the question: what should be updated on screen after it, and is it? Check the tree, open notes (buffer and revision), open canvases and sketches, open databases (rows, fields, the list of databases), the properties panel, history and the log. Analyze sync separately and in detail, per the item above.

The outcome:

- a table of gaps: operation, what is not updated, consequence for the person, how dangerous it is for the data;
- a recommendation: close the gaps one by one or introduce a general rule — every operation returns a list of what changed (files, databases, fields), and the UI decides from it what to re-read. The tree already partly works this way via `treePatch`.

## Rules

- At these stages do not change code, do not commit, do not switch branches. Only the two report files are written.
- Do not touch `src/lib/bindings.ts`.
- Do not open the installed `/Applications/Amby.app`: it holds the owner's real vault.
- The report to the owner is in Russian, simple. It includes: how many commands, calls, subscriptions, and background writes were found; the main gaps; the answer about sync.
