# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Amby Notes — a Tauri 2 desktop notes app. The Rust shell handles filesystem and SQLite-backed vault indexing; the React 19 + TypeScript + Vite frontend renders the workspace UI.

## Commands

- `npm run dev` — Vite dev server only (browser; Tauri APIs unavailable, storage falls back to localStorage)
- `npm run tauri dev` — full desktop app with Rust backend (use this when changes touch filesystem or Tauri commands)
- `npm run build` — `tsc` typecheck + Vite production bundle (this is the closest thing to a test suite; run it before claiming work is done)
- `npm run tauri build` — production desktop bundle
- `cd src-tauri && cargo check` — fast Rust validation without producing an app bundle

No test runner is configured and there is no `npm test`. Verify changes via `npm run build`, `cargo check`, and manual testing in `npm run tauri dev`.

## Architecture

### Two-process split

- **Frontend** (`src/`) — React renderer. Calls Tauri commands via `@tauri-apps/api`.
- **Backend** (`src-tauri/src/`) — Rust. All filesystem I/O, vault indexing, and link-graph computation live here. Tauri commands are defined in `lib.rs` (keep them there unless a module grows large enough to justify splitting, per `AGENTS.md`). `vault_index.rs` holds the SQLite index (ULIDs for note IDs). `frontmatter.rs` parses YAML frontmatter.

The frontend never touches the filesystem directly — it goes through `src/lib/storage.ts`, which wraps the Tauri IPC calls and provides a localStorage fallback for browser-only `npm run dev`. When adding filesystem behavior, add a Rust command in `lib.rs`, expose it through `storage.ts`, and update `src-tauri/capabilities/default.json` if a new permission is needed.

### Frontend structure

- `src/components/workspace/` — app-specific workspace UI: editor, sidebar, tabs, properties panel, search, tags. The root container is `workspace.tsx`, which owns vault state, open documents, tabs, tree items, favorites, unsaved tracking, and sidebar visibility. State is plain React hooks — there is no Redux/Zustand/Context store.
- `src/components/ui/` — reusable Radix + shadcn-style primitives. Do not put workspace-specific logic here.
- `src/lib/` — shared utilities and the `storage.ts` abstraction. Use the `cn()` helper from `src/lib/utils.ts` for conditional class names.
- `src/hooks/` — React hooks.

### Editor

Two editors over the same document, switchable side-by-side:
- Tiptap 3 for the rich editor (`document-editor.tsx`). Autosaves on a ~500ms debounce via the Tauri `write_file` command.
- CodeMirror 6 with `lang-markdown` for source mode (`source-editor.tsx`).

Round-tripping between them uses `prosemirror-markdown` / `markdown-it`.

### Data flow

Open vault → Rust `open_vault` + `load_vault_data` scan the folder and update the SQLite index → frontend receives tree + note index + link graph → clicking a note calls `read_file` → editor edits trigger debounced `write_file` → unsaved set drives the dot indicator in `header-tabs.tsx`.

## Conventions

- Filenames are kebab-case (e.g., `document-editor.tsx`); exported React components are PascalCase.
- Tailwind utilities + `cn()`; styling lives inline, not in CSS modules.
- Path alias `@/*` → `src/*` (configured in `tsconfig.json` / Vite).
- TypeScript strict mode is on.
- ESLint and Prettier are not configured — match surrounding style.
- Commit subjects use conventional prefixes (`feat:`, `fix:`, `chore:`) and stay imperative and specific.
- Keep Tauri permissions narrow in `src-tauri/capabilities/default.json`. Treat filesystem-permission changes as high-risk and verify both browser fallback and desktop paths.
