# Amby Notes — Development Plan

## Current State

### Frontend (UI — ready)
Dark theme, all components functional and polished.

| Component | File | Status |
|-----------|------|--------|
| `HeaderTabs` | `workspace/header-tabs.tsx` | ✅ Done |
| `AppSidebar` | `workspace/app-sidebar.tsx` | ✅ Done (hardcoded data) |
| `DocumentEditor` | `workspace/document-editor.tsx` | ✅ Done (no persistence) |
| `PropertiesPanel` | `workspace/properties-panel.tsx` | ✅ Done (hardcoded data) |
| `SidebarTree` | `workspace/sidebar-tree.tsx` | ✅ Done |
| `Workspace` | `workspace/workspace.tsx` | ✅ Done (wires everything) |

**What's hardcoded right now:**
- 6 documents in a static object in `workspace.tsx`
- 6 document property objects in `workspace.tsx`
- Tree structure in `app-sidebar.tsx` (`treeData`)
- Tree items and documents are not connected to the real filesystem

### Backend (Tauri / Rust — empty)
- `src-tauri/src/lib.rs` — only a placeholder `greet()` command
- No filesystem commands, no plugin integrations
- `src-tauri/src/main.rs` — just calls `run()`

---

## Stage 1 — Tauri File System Backend

**Goal:** Real read/write of files on disk.

### Rust commands to add (`src-tauri/src/lib.rs`)

```rust
open_vault(path: String)          // set root folder of the vault
list_files(path: String)          // recursive tree → Vec<TreeItem>
read_file(path: String)           // → file content as String
write_file(path: String, content: String) // save content
create_file(path: String)         // create empty .md file
create_folder(path: String)       // create folder
rename_item(old: String, new: String)     // rename/move
delete_item(path: String)         // delete file or folder
```

### Tauri plugins to add (`src-tauri/Cargo.toml`)

```toml
tauri-plugin-dialog = "2"    # folder picker dialog
tauri-plugin-fs = "2"        # filesystem access
```

### Permissions (`src-tauri/capabilities/default.json`)
Enable `fs:read`, `fs:write`, `fs:create`, `dialog:open`.

---

## Stage 2 — Replace Hardcoded Data with Real Filesystem

**Goal:** UI reads from actual files on disk.

### Changes

**`src/lib/storage.ts`** — new file, abstraction layer:
```ts
// Calls Tauri commands in desktop, falls back to localStorage in browser
export async function listFiles(path: string): Promise<TreeItem[]>
export async function readFile(path: string): Promise<string>
export async function writeFile(path: string, content: string): Promise<void>
```

**`src/components/workspace/workspace.tsx`**
- Remove static `documents` and `documentProperties` objects
- Add `vault: string | null` state — path to the open vault
- On mount: call `list_files()`, populate tree and document list
- `Document` type: add `path: string` field, replace hardcoded `id` keys

**`src/components/workspace/app-sidebar.tsx`**
- Remove static `treeData`
- Accept `items: TreeItem[]` as prop from `Workspace`

---

## Stage 3 — Auto-save

**Goal:** Content saves to disk automatically as user types.

### Changes

**`src/components/workspace/document-editor.tsx`**
- Add `useEffect` with 500ms debounce on `content` state
- On debounce trigger: call `writeFile(document.path, content)`
- Show unsaved dot `●` in tab title when content differs from saved

**`src/components/workspace/header-tabs.tsx`**
- Accept `unsavedIds: string[]` prop
- Render `●` before tab title when tab id is in that list

---

## Stage 4 — CRUD via UI

**Goal:** User can create, rename, delete documents and folders.

### New file — context menu
**`src/components/workspace/tree-context-menu.tsx`**
- Wraps `SidebarTree` items with a right-click `DropdownMenu`
- Actions: Rename, Delete, New File Here, New Folder Here

### Changes

**`src/components/workspace/app-sidebar.tsx`**
- "New" button → opens input or calls `create_file()` directly
- Pass `onCreate`, `onRename`, `onDelete` callbacks down to tree

**`src/components/workspace/sidebar-tree.tsx`**
- Support inline rename: double-click on item → `<input>` appears
- On blur or Enter: call `onRename(id, newName)`

---

## Stage 5 — Real Document Properties

**Goal:** Properties panel shows real file metadata.

### Changes

**`src/components/workspace/workspace.tsx`**
- Compute `wordCount` dynamically from current content
- `created` and `modified` from filesystem metadata (`fs::metadata`)
- Remove `revisions`, `backlinks`, `id` from hardcoded props (or compute when possible)

**`src/components/workspace/properties-panel.tsx`**
- Footer word/symbol count should reflect current editor content (pass as prop)

---

## Stage 6 — Web Preview Support (note.omlet.space)

**Goal:** App still works in browser when Tauri is not available.

### New file — `src/lib/storage.ts`
```ts
const isTauri = (): boolean => '__TAURI_INTERNALS__' in window

export async function readFile(path: string): Promise<string> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke('read_file', { path })
  }
  return localStorage.getItem(`file:${path}`) ?? ''
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke('write_file', { path, content })
  }
  localStorage.setItem(`file:${path}`, content)
}
```

In browser: vault lives in `localStorage`, tree is seeded with demo data if empty.

---

## Component Map

```
src/
├── components/
│   └── workspace/
│       ├── workspace.tsx          # root, state, data loading
│       ├── header-tabs.tsx        # tabs + sidebar toggles + window controls
│       ├── app-sidebar.tsx        # icon rail + tree
│       ├── sidebar-tree.tsx       # collapsible tree
│       ├── document-editor.tsx    # textarea + autosave
│       ├── properties-panel.tsx   # right panel: info / history / links
│       └── tree-context-menu.tsx  # [Stage 4] right-click menu
├── lib/
│   ├── utils.ts                   # cn() helper
│   └── storage.ts                 # [Stage 2] Tauri/localStorage abstraction
└── hooks/
    └── use-vault.ts               # [Stage 2] vault state hook

src-tauri/src/
├── main.rs                        # entry point
└── lib.rs                         # [Stage 1] all Tauri commands
```

---

## Priority Order

| # | Stage | Effort | Value |
|---|-------|--------|-------|
| 1 | Tauri file backend | Medium | 🔴 Blocker for everything |
| 2 | Replace hardcoded data | Medium | 🔴 Core functionality |
| 3 | Auto-save | Low | 🟠 High UX value |
| 4 | CRUD via UI | Medium | 🟠 Essential for real use |
| 5 | Real properties | Low | 🟡 Nice to have |
| 6 | Web preview support | Low | 🟡 Already deployed at note.omlet.space |
