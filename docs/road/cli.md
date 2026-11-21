# CLI and a core without Tauri: plan

Status as of 2026-11-18: **steps 0–4 implemented.** Open decisions are in
section 8. Data work follows the "tests first" rule (section 6 of the [sync plan](../sync-plan.md)).

| Step | What                                                      | Status      |
| ---- | --------------------------------------------------------- | ----------- |
| 0    | Cargo workspace, `amby-core` moved out without Tauri      | implemented |
| 1    | `amby` for reading, `--json`, read-only `amby mcp`        | implemented |
| 2    | Simple writes (create, append, replace) with snapshots    | implemented |
| 3    | Complex operations while the app is closed, vault lock    | implemented |
| 4    | Handing operations to the running app over a local socket | implemented |

## 1. In short

- **One `amby` program for people, scripts and AI.** By default it prints readable terminal output; with
  `--json` it gives a stable response shape, exit codes and errors as JSON. For AI there is also `amby mcp`, an
  MCP server over stdio that connects to Claude Code, Codex or Cursor with one line of settings.
- **Core first, then the CLI.** The vault logic moves into an `amby-core` crate without Tauri. The CLI depends
  only on it: a small binary without WebKit/GTK, and core tests do not link Tauri. Step 0 is useful on its own.
- **Data safety comes before convenience.** Reading is always safe; writes use the same atomic paths and
  snapshots as the app; journaled operations are never run by two processes at once.

## 2. Step 0. The core apart from Tauri

### 2.1. What the code shows (2026-11-17)

- Vault and index (`vault/`, `index/`, `vault_context.rs`, `paths.rs`), bundles (`bundle/`), `history.rs`, the
  archive, `frontmatter.rs`, `atomic_fs.rs`, `durable.rs` and recovery do not use Tauri.
- `database/` and `project/` touch Tauri only through `watcher.rs`: they take `WatcherState` (the "I made this
  write myself" mark) and `is_amby_temporary_file`. That is plain code; only sending events to a window
  (`emit`) needs Tauri. So `watcher.rs` splits in two: the marks go to the core, the events stay in the app.
- Types for `bindings.ts` derive `specta::Type`; Specta does not depend on Tauri. The types stay in the core,
  and the binding export in the app works as before.
- The read-only AI tools (`ai/tools.rs`: `search_notes`, `read_note`, `list_folder`, `get_links`) do not use
  Tauri and move to the core; `amby mcp` serves the same tools.
- Really tied to Tauri: `commands/`, `state.rs`, `lib.rs`, event sending in `watcher.rs`, `logging.rs`, AI
  providers (`ai.rs`, `ai/turn.rs`, launching Codex and Claude Code), `updater.rs`, `package_manager.rs`,
  `app_data.rs`, `credentials.rs`, `terminate_gate.rs`, starting sync (`sync/mod.rs`, `sync/app_hooks.rs`).
  They stay in the app.

### 2.2. Layout

- A root `Cargo.toml` with a workspace. `sync/` keeps its own workspace for now.
- `crates/amby-core`: vault, index, bundles, database, projects, properties, history, archive, recovery,
  watcher marks, read-only AI tools.
- `src-tauri`: only the app (commands, windows, events, logging, AI providers, updates, credentials, starting
  sync); depends on `amby-core`.
- `crates/amby-cli`: the `amby` binary; depends only on `amby-core` (step 1).
- The sync workspace stays separate. The core uses its existing property-group and vault-path rules.
  Moving the sync engine into the core is a separate decision.

### 2.3. Rules for the move

- Behavior does not change. Existing tests move with their modules and stay green **without changing their
  assertions** — this is the safety net of the move.
- Files move with `git mv` (history is kept), in a commit separate from the `crate::` path fixes.
- Visibility: anything that is `pub(crate)` today and used on both sides of the boundary becomes `pub` or
  moves. This is the most painstaking part; do not add needless `pub`.
- Boundary guard in CI: `cargo tree -p amby-core` must not contain `tauri`.
- Do the move at a quiet time, with no parallel Rust branches in flight.
- Update `src-tauri/src/MAP.md`, `src-tauri/MAP.md`, `docs/ai/MAP.md`, and the `rust:test` / `rust:clippy`
  scripts.

Done when: `npm run verify`, `npm run rust:test` (bindings unchanged), strict Clippy and a native build pass;
the "no Tauri" check in CI is green; the `rust:test` time for the core is recorded before and after.

## 3. Step 1. Reading and `--json`

See the [CLI contract](../cli.md) for build and install instructions. Commands: `amby vault list|use`, `amby ls [folder]`, `amby cat <note>`, `amby search <query>`,
`amby links|backlinks <note>`, `amby tags`, `amby open <note>` (open it in the app).

- The vault is chosen with `--vault <path>`, the `AMBY_VAULT` variable, `vault use`, or the last vault opened in the app.
- A note is given by path, title or `amby-id`; an ambiguous match is an error listing the candidates.
- The CLI reads a read-only snapshot of the SQLite index and committed WAL. If the snapshot
  is missing, unusable, or stale, it reads Markdown into an ephemeral in-memory catalog.
- `--json`: a stable, versioned schema; errors are codes without raw text (as in the [notice rules](../notices.md)).
- Terminal help and errors support English and Russian based on the locale environment.

`amby mcp` (read-only): stdio, the same tools as the Codex bridge (`ai/codex/mcp.rs`, `ToolHost`). Paths do
not leave the vault; `.amby/`, sync keys and credentials are not reachable.

## 4. Step 2. Simple writes

Commands: `amby new <note>`, `amby append <note>`, `amby write <note>` (text from stdin or a file).

- Writes go through `atomic_fs`; a new note is a no-replace create; a replace takes a history snapshot first.
- BOMs, line endings and unknown frontmatter are kept; `amby-id` is never changed.
- For an open app such a write is an ordinary external edit: a clean note is reread, and unsaved edits lead
  to a conflict. Sync picks up the change through the watcher.
- `--dry-run` shows a diff without writing.
- **AI:** `amby mcp` writes only with `--allow-write`, which can be limited to a folder
  (`--allow-write=Projects/`). Every changed existing note gets a snapshot marked `ai-edit`.
  Write tools and CLI commands share the same checks. See the [editing contract](../cli.md#editing-notes).

## 5. Step 3. Complex operations

The CLI supports rename and move with link rewriting, archive and restore, and
read-only previews. Structural moves include note bundles, database files and
workshop folders. Existing database and workshop journal replay is shared with
desktop activation.

- The CLI and desktop app take the same exclusive vault lock in
  `.amby/operation.lock`. Desktop Amby holds the lock until it exits.
- The CLI records moves and rewrites before publishing them. The next structural
  command, `amby recover`, or desktop activation resumes pending work. Recovery
  stops and keeps the journal when a file has changed since the interrupted
  operation.
- See the [CLI contract](../cli.md#structural-operations) for targets and exit codes.

## 6. Step 4. Working next to an open app

The CLI hands structural writes to desktop Amby when the desktop owns the
lease for the requested vault. The desktop checks the current vault, orders
the request with editor saves, and refreshes the index and windows after
publication. Unix uses a user-only domain socket. Windows uses a local named
pipe restricted to the user's SID. See the [local IPC contract](../cli-ipc.md)
for framing, errors and timeouts.

The expanded stdio tool surface has its own [MCP implementation plan](mcp.md).

## 7. Installation

- Desktop release packages include `amby` next to the application executable.
  AppImage runs it through `--amby-cli`. Development bundles use
  `npm run build:desktop`. See [installation](../cli.md#installation) for shell
  access on macOS, Windows and Linux.
- Settings → General → Command line puts the command on PATH and removes it
  (2026-11-20; see [installation](../cli.md#installation)).
- A separate headless Linux build of `amby` — after step 0, if there is demand.

## 8. Owner decisions

Open:

1. Scope of the first release: step 1, or steps 1–2 at once. Proposal: 1–2; without writes the CLI is of
   little use to AI.
2. What comes first: terminal convenience or `amby mcp`. Proposal: `amby mcp`; its base already exists.

Non-goals: a terminal editor (TUI), managing sync and the account from the CLI, third-party plugins,
arbitrary shell commands for AI.
