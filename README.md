<div align="center">

<img src="site/assets/icon.png" alt="Amby" width="128" height="128" />

# Amby

**Notes that stay yours.**

A calm, local-first workspace for notes, projects and stories.<br />
Everything lives as plain Markdown files in a folder on your disk — no cloud, no accounts, no lock-in.

[![Latest release](https://img.shields.io/github/v/release/MrDarkOm/amby-notes?style=flat-square&color=8b5cf6&label=release)](https://github.com/MrDarkOm/amby-notes/releases/latest)
[![Platforms](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-1c1c1c?style=flat-square)](#-download)
[![License: MIT](https://img.shields.io/badge/license-MIT-fecbc8?style=flat-square)](#license)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db?style=flat-square)](https://tauri.app)

[**Download**](#-download) · [Features](#-features) · [Creative workshop](#-creative-workshop) · [Your files](#-your-files) · [Release notes](updates/README.md) · [Develop](#-development)

</div>

---

## ⬇️ Download

| Platform                     | File                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| 🍎 **macOS** — Apple Silicon | [`Amby_aarch64.dmg`](https://github.com/MrDarkOm/amby-notes/releases/latest)             |
| 🍎 **macOS** — Intel         | [`Amby_x64.dmg`](https://github.com/MrDarkOm/amby-notes/releases/latest)                 |
| 🪟 **Windows** 10 / 11       | [`Amby_x64-setup.exe`](https://github.com/MrDarkOm/amby-notes/releases/latest) or `.msi` |
| 🐧 **Linux** — any distro    | [`Amby_amd64.AppImage`](https://github.com/MrDarkOm/amby-notes/releases/latest)          |

All builds are on the [Releases](https://github.com/MrDarkOm/amby-notes/releases) page. Amby updates
itself, and every update is signed.

> [!NOTE]
> Amby is under active development and has not reached 1.0 yet. The core is built so that data is
> never lost, but keep backups of what matters, as with any new app.

<details>
<summary><b>macOS says the app is from an unidentified developer</b></summary>

Right-click Amby → **Open**, or allow it in **System Settings → Privacy & Security**. You only need to
do this once.

</details>

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### ✍️ Live Preview and Source

A rich editor with blocks, columns and callouts — or raw Markdown in CodeMirror, on the same
document. Untouched blocks are saved byte for byte.

</td>
<td width="50%" valign="top">

### 🗃 Databases

Properties, formulas and several views of one database: table, board, gallery and list. Every row
is an ordinary note.

</td>
</tr>
<tr>
<td valign="top">

### 🕸 Links and graph

`[[Wiki links]]`, backlinks and a live link graph with filters, colour groups and a layout you can
lock in place.

</td>
<td valign="top">

### 🎨 Canvases and sketches

Lay notes out on an infinite canvas and draw by hand in Excalidraw scenes.

</td>
</tr>
<tr>
<td valign="top">

### 🔎 Spotlight-style search

One bar searches notes, folders, databases, canvases, text and tags. <kbd>Tab</kbd> switches the
type, <kbd>Enter</kbd> opens the first result.

</td>
<td valign="top">

### 🛟 History, trash and recovery

Atomic saves, version snapshots for every note, restorable deletion, crash recovery and conflict
protection when a file changes outside Amby.

</td>
</tr>
<tr>
<td valign="top">

### 🧩 Modules on demand

Tags, favourites, databases, history, graph, canvases, sketches and the workshop — enable only what
you use and the interface stays clean.

</td>
<td valign="top">

### 🌗 Themes and languages

Light and dark themes, accent colours and portable theme files that are safe to share. The
interface speaks English and Russian.

</td>
</tr>
</table>

## 🪶 Creative workshop

For people who write stories — novels, short stories, comics and whole universes, in one portable
folder.

- **Stories and pages** — a drag-and-drop page tree with statuses, word counts and a one-click
  _Compile manuscript_.
- **Characters and places** belong to stories and universes, not folders. A character's dossier shows
  their arcs.
- **Anchors and arcs** — key events and storylines attach to chapters, so next to the text you see
  where you start from and where you need to arrive.

## 📂 Your files

An Amby vault is an ordinary folder. Open any folder of Markdown — including an Obsidian vault — and
sync it with whatever you already use: iCloud Drive, Dropbox, Syncthing or Git.

```text
~/Notes
├── Projects/
│   ├── Balcony garden.md
│   ├── Plants/               # a database: rows are notes
│   └── Planting map.canvas
├── attachments/
└── .amby/                    # settings, history, index
```

```markdown
---
status: In progress
tags: [garden, spring]
---

# Balcony garden

Picking plants from [[Plants]].
```

Markdown files and attachments are the source of truth. The SQLite index only speeds up search and
links, and can be rebuilt at any time. Amby writes its own identity only as `amby-id`; a generic
frontmatter `id` belongs to you or another tool. Anything Amby doesn't understand yet stays in the
file as is — it is never silently discarded.

<details>
<summary><b>How compatibility is layered</b></summary>

Amby is not an Obsidian clone or a Notion clone. It is a modular, local-first hybrid for personal
knowledge:

- **Preservation** — unsupported Markdown, YAML and canvas data remain available in source form.
- **Interoperability** — common Markdown, frontmatter, links, tags and attachments work well with
  other tools.
- **Deep support** — richer visual editing and round-trip guarantees are added only where they are
  worth the complexity.

Perfect compatibility with every Obsidian feature is not a 1.0 requirement. Ownership of your source
— and the ability to keep using it outside Amby — is.

</details>

---

## 🛠 Development

| Layer         | Technology                         |
| ------------- | ---------------------------------- |
| Desktop shell | Tauri 2                            |
| Frontend      | React 19 + TypeScript + Vite       |
| State         | Zustand                            |
| Styling       | Tailwind CSS + Radix UI primitives |
| Rich editor   | Tiptap 3 (ProseMirror)             |
| Source editor | CodeMirror 6                       |
| Backend / IPC | Rust                               |
| Note index    | SQLite via `rusqlite`              |
| Note IDs      | ULIDs                              |

### Prerequisites

- [Node.js](https://nodejs.org/) 20.19+ or 22.12+ and npm 10+
- [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- Tauri prerequisites for your OS — see the [Tauri docs](https://tauri.app/start/prerequisites/)
- Windows: the Microsoft Edge WebView2 Runtime (included with current Windows 11 builds)

### Run and build

```bash
npm install
npm run tauri dev        # full desktop app (Rust backend + React frontend)
npm run dev              # browser-only dev server; storage falls back to localStorage
```

```bash
npm run build            # type-check + production bundle
npm run rust:check       # fast Rust validation
npm run rust:test        # Rust tests (also regenerates IPC bindings)
npm run verify:full      # the release-quality local gate
npm run tauri build      # production desktop installer
```

### Architecture

```
React workspace
    ↓
Storage port / repositories        src/lib/storage
    ↓
Tauri IPC commands                 src-tauri/src/commands
    ↓
Rust vault, history, index         src-tauri/src
    ↓
Markdown filesystem (authoritative) + SQLite index (rebuildable)
```

The frontend never touches the filesystem directly — all I/O goes through `src/lib/storage`, which
calls narrow Rust commands over Tauri IPC. When adding filesystem behaviour, add a narrow command,
expose it through the storage adapter and grant the least-privilege permission in
`src-tauri/capabilities/default.json`.

<details>
<summary><b>Project structure</b></summary>

```
amby-notes/
├── src/                        # React frontend
│   ├── components/
│   │   ├── workspace/          # App UI: editor, sidebar, tabs, databases, canvas, workshop
│   │   └── ui/                 # Reusable Radix + shadcn-style primitives
│   ├── lib/storage/            # Storage port, repositories, browser and desktop adapters
│   ├── lib/modules/            # Module lifecycle, capabilities and profiles
│   ├── locales/                # Visible interface strings
│   └── themes/                 # Portable theme definitions and appearance tokens
├── src-tauri/                  # Rust backend
│   └── src/
│       ├── commands/           # Narrow Tauri IPC boundaries
│       ├── index/              # Rebuildable SQLite search/link index
│       ├── vault/              # Vault scan and identity migration
│       ├── bundle/             # Filesystem mutations and bundle operations
│       └── frontmatter.rs      # Lossless frontmatter and atomic text writes
├── site/                       # Static landing and download page
└── updates/                    # Release notes
```

</details>

### Branches

`dev` (active work) → `beta` (stabilisation and release testing) → `main` (the current stable
build). Start feature and fix work from `dev` and promote in one direction only.

## License

[MIT](https://opensource.org/licenses/MIT) — free to use, change and share.

<div align="center">
<br />
<img src="site/assets/icon.png" alt="" width="40" height="40" />
<br />
<sub>Made with care for people who like to own their notes.</sub>
</div>
