# Amby Notes

A local-first desktop notes app built with Tauri 2, React 19, and Rust. Your notes stay on your filesystem as plain Markdown files — no cloud, no accounts, no lock-in.

## Features

- **Vault-based** — open any folder as a vault; notes are `.md` files you own
- **Dual editor** — switch between a rich WYSIWYG editor (Tiptap) and raw Markdown source (CodeMirror) on the same document
- **SQLite index** — fast search and link graph backed by an in-process SQLite database, rebuilt on vault open
- **Wiki-style links** — `[[note name]]` links between notes, tracked in a link graph
- **YAML frontmatter** — parsed and displayed in a properties panel
- **Autosave** — debounced writes on every edit; unsaved indicator in tabs
- **Tags & favorites** — organize notes without moving files
- **Tiered settings** — per-vault and global configuration stored separately

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 |
| Frontend | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS + Radix UI primitives |
| Rich editor | Tiptap 3 (ProseMirror) |
| Source editor | CodeMirror 6 |
| Backend / IPC | Rust |
| Note index | SQLite via `rusqlite` |
| Note IDs | ULIDs |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Tauri CLI prerequisites for your OS — see the [Tauri docs](https://tauri.app/start/prerequisites/)

### Development

```bash
# Install JS dependencies
npm install

# Run the full desktop app (Rust backend + React frontend)
npm run tauri dev

# Browser-only dev server (no Tauri APIs; storage falls back to localStorage)
npm run dev
```

### Build

```bash
# Type-check + production bundle (run before committing)
npm run build

# Fast Rust validation without a full bundle
cd src-tauri && cargo check

# Production desktop installer
npm run tauri build
```

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
