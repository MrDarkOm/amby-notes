# Amby

A fully open-source, local-first desktop knowledge workspace built with Tauri 2, React 19, TypeScript, and Rust. Amby is primarily for personal notes and projects, combining Markdown ownership and wiki-style knowledge links with a Notion-like Properties, Collections, blocks, and workspace experience — while keeping its own product identity. Your notes stay on your filesystem as plain Markdown files — no cloud, no accounts, no lock-in.

## Features

- **Vault-based** — open any folder as a vault; notes are `.md` files you own
- **Modular hybrid workspace** — Markdown notes alongside Properties, Collections, multiple views, portable blocks, and workspace presets (in development)
- **Dual editor** — switch between a rich WYSIWYG editor (Tiptap) and raw Markdown source (CodeMirror) on the same document
- **SQLite index** — derived index for search and link graph, rebuilt on vault open
- **Wiki-style links** — `[[note name]]` links between notes, tracked in a link graph
- **YAML frontmatter** — parsed and displayed in a properties panel
- **Autosave** — debounced writes on every edit; unsaved indicator in tabs
- **Tags & favorites** — organize notes without moving files
- **Tiered settings** — per-vault and global configuration stored separately

Git integration, local and cloud AI providers, and a full editor for Amby's own
Canvas format are part of the 1.0 direction. Deeper Excalidraw compatibility is
scoped separately so the core product can remain portable and open.

## Product direction

Amby is not intended to be an Obsidian clone or a Notion clone. Its target experience is a modular local-first hybrid for personal knowledge: files and links remain portable, while structured properties, collections, views, and focused workspaces make the knowledge base easier to use day to day.

Compatibility is deliberately layered:

- **Preservation** — unsupported Markdown, YAML, and canvas data remains available in source form instead of being silently discarded.
- **Interoperability** — common Markdown, frontmatter, links, tags, and attachments work well with other tools.
- **Deep support** — richer visual editing and round-trip guarantees are added only where they are worth the complexity.

Perfect compatibility with every Obsidian feature is not a 1.0 requirement. The 1.0 requirement is that users retain ownership of their source and can continue using it outside Amby.

## Tech stack

| Layer         | Technology                         |
| ------------- | ---------------------------------- |
| Desktop shell | Tauri 2                            |
| Frontend      | React 19 + TypeScript + Vite       |
| Styling       | Tailwind CSS + Radix UI primitives |
| Rich editor   | Tiptap 3 (ProseMirror)             |
| Source editor | CodeMirror 6                       |
| Backend / IPC | Rust                               |
| Note index    | SQLite via `rusqlite`              |
| Note IDs      | ULIDs                              |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20.19+ or 22.12+
- npm 10+
- [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- Tauri CLI prerequisites for your OS — see the [Tauri docs](https://tauri.app/start/prerequisites/)
- Windows: the Microsoft Edge WebView2 Runtime. It is included with current Windows 11 builds; install the Evergreen runtime if it is missing.

### Development

```bash
# Install JS dependencies
npm install

# Run the full desktop app (Rust backend + React frontend)
npm run tauri dev

# Browser-only dev server (no Tauri APIs; storage falls back to localStorage)
npm run dev

# Run all required local checks: TypeScript, ESLint, Vitest, and Rust
npm run verify
```

### Build

```bash
# Type-check + production bundle (run before committing)
npm run build

# Fast Rust validation without a full bundle
npm run rust:check

# Rust unit tests (also regenerates IPC bindings in debug builds)
npm run rust:test

# Production desktop installer
npm run tauri build
```

## Branch workflow

- `dev` is the integration branch for active and experimental development.
- `beta` receives completed work from `dev` for stabilization and release testing.
- `main` contains the current stable build. Until version 1.0, it only receives the completed 1.0 scope from `beta`.

Start all feature and fix work from `dev`. Promote changes in one direction: `dev` → `beta` → `main`.

## Project structure

```
amby-notes/
├── src/                        # React frontend
│   ├── components/
│   │   ├── workspace/          # App-specific UI (editor, sidebar, tabs, search)
│   │   └── ui/                 # Reusable Radix + shadcn-style primitives
│   ├── hooks/                  # React hooks
│   └── lib/
│       └── storage.ts          # Tauri IPC wrapper (+ localStorage fallback)
└── src-tauri/                  # Rust backend
    └── src/
        ├── lib.rs              # All Tauri commands
        ├── vault_index.rs      # SQLite note index
        └── frontmatter.rs      # YAML frontmatter parser
```

## Architecture notes

The frontend never accesses the filesystem directly — all I/O goes through `storage.ts`, which calls Rust commands over Tauri IPC. This means the app works in a browser (`npm run dev`) using localStorage as a fallback, and in production it uses the real filesystem through Rust.

When adding new filesystem behavior: add a Rust command in `lib.rs` → expose it in `storage.ts` → add the required permission in `src-tauri/capabilities/default.json`.

## License

MIT
