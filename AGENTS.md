# Amby Notes — agent entry point

Amby is a local-first desktop knowledge workspace: Tauri 2 / Rust, React 19 /
TypeScript / Vite, Zustand, Tiptap 3 and CodeMirror 6. Users own their Markdown
and attachments. SQLite is rebuildable; durable sidecars and recovery data are not.

## Read progressively

1. Read this file, then choose the relevant route in [MAP.md](MAP.md).
2. Read only that area's `MAP.md`, the implementation, and nearby tests. For a
   cross-layer task, follow the linked boundary maps. Paths in maps are relative
   to the map containing the link.
3. Before editing, read the applicable sections of
   [detailed guidelines](docs/agent-guidelines.md). Before persistence, indexing,
   frontmatter, serialization, rename/move, history or trash changes, also read
   [vault format](docs/vault-format.md) and
   [Markdown compatibility](docs/markdown-compatibility.md).
4. Search narrowly with `rg` / `rg --files`. Do not bulk-load all maps, docs,
   fixtures, generated bindings, lockfiles, or archived plans. Broaden the search
   when the selected route is insufficient. Maps describe ownership, not every
   function; confirm behavior in code and tests.

## Boundaries that always apply

- Frontend filesystem I/O goes through `src/lib/storage.ts` → `src/lib/storage/`
  → Tauri commands. Browser development uses a limited localStorage adapter.
- Extend focused hooks and Zustand stores; keep `workspace.tsx` a facade and
  avoid parallel state in the orchestration component. Rust owns vault paths,
  atomic writes, watching, migrations, history, trash and indexing.
- Never hand-edit `src/lib/bindings.ts`. IPC/type changes require Specta
  annotations and `npm run rust:test` to regenerate bindings in the same batch.
- Preserve unknown content, BOMs and line endings. In Live Preview an unedited block is
  written as the bytes it was read from and only an edited block is rewritten; a block
  that cannot be rewritten without loss is kept as its source text. Keep autosaves serialized,
  recovery until successful save, and external edits as conflicts when dirty.
  Use existing atomic/no-replace writes, snapshots and restorable deletion paths.
- Never silently change user frontmatter IDs or other apps' metadata. Persistent
  migrations need versioning, preflight, backups, completion detection, outcome
  recording and rollback. Never treat all of `.amby/` as a disposable cache.
- Visible strings belong in `src/locales/resources.ts` with all translations;
  static visuals belong in `src/themes/`. Use `IconValue` for encoded icons.
- Keep Tauri permissions narrow and vault paths canonicalized. Never commit
  secrets, vault contents, recovery data, `dist/` or `src-tauri/target/`.
- Preserve unrelated working changes. Start feature/fix work from `dev`.
- Branches: `dev` (work, plus the development files in `scripts/dev-only-paths.txt`:
  agent instructions, maps, plans) → `beta` (to try out) → `main` (the product).
  Move work only with `npm run promote -- beta|main`, never by hand: it drops the
  development files. Tag `vX.Y.Z-beta.N` only on `beta`, `vX.Y.Z` only on `main`;
  never tag `dev`.

## Finish each batch

- Update `updates/upd_next.md` in Russian for every meaningful change, including
  docs and tooling. Preserve accumulated entries. Do not bump versions routinely.
- Format touched files with Prettier / Rustfmt. Run `npm run docs:check` when
  changing maps, entry points or mapped paths. Run `npm run build` after every
  batch, including docs-only work; run `npm run verify` before requesting review.
  Rust changes also require `npm run rust:test`; backend-heavy changes require
  strict Clippy. Report failed or unavailable checks accurately.
- Storage/IPC/windowing/watcher/dialog changes need targeted browser and native
  testing. Tauri configuration, plugins, permissions, IPC, packaging or updater
  changes also need a native build, or an explicit reason it could not run.
- An explicit request to **commit and push accumulated changes** triggers the
  cumulative patch release workflow in
  [the release rules](docs/agent-guidelines.md#public-change-log-and-cumulative-releases).
  Read it before versioning or committing. Tags, GitHub Releases and branch
  promotion need separate explicit authorization.
- When ownership, entry points or contracts change, update the nearest map in
  the same batch. Keep this file small; put details in maps/contracts. Claude Code
  and Gemini CLI import this file from their root adapters.
