# Specification of the Hybrid Knowledge Management System (Bundle Note + SQLite)

## 1. The "Bundle Note" Concept

The system eliminates redundant folders in the early stages of content creation. A note is created as a single `Name.md` file. The transition to a "bundle" structure (a folder) happens only when additional data layers need to be stored.

## 2. Transformation Triggers (Lazy Transformation)

The conversion of the `Name.md` file into the `Name/Name.md` directory happens automatically when one of the following events occurs:

- **Drop event:** Importing media files (images, PDF) into the editor.
- **Layer switch:** Activating a visual mode (Canvas, Excalidraw, Database) with the button next to the edit-view switcher.
- **Manual attachment:** Adding an attached file via the context menu.

### Storage structure on disk

```plaintext
MyVault/
└── Note_Name/
    ├── Note_Name.md         <-- Main text (Markdown)
    ├── Note_Name.canvas     <-- Visual map (JSON)
    ├── Note_Name.excalidraw <-- Diagrams and sketches
    └── assets/              <-- Local media resources
```

## 3. Multi-Layer Interface (Multi-View)

The user works in a single window, switching between views via tabs.

| **Mode**     | **Source file**        | **Technology**           |
| ------------ | ---------------------- | ------------------------ |
| **Editor**   | `Name.md`              | CodeMirror / TipTap      |
| **Canvas**   | `Name.canvas`          | React Flow / Svelte Flow |
| **Database** | `Metadata.md` / SQLite | Custom Form UI           |
| **Sketch**   | `Name.excalidraw`      | @excalidraw/excalidraw   |

## 4. File Management Logic (Backend: Rust/Tauri)

### Atomic rename

When an entity's name is changed in the UI, the backend performs a transaction at the FS level:

1. Rename the `.md` file.
2. Rename the related layer files (`.canvas`, `.excalidraw`).
3. Rename the bundle's parent directory.

### Drag-and-Drop absorption

When `A.md` is moved onto `B.md`:

1. The `B/` directory is created (if it did not exist).
2. `A.md` (together with its bundle) is moved inside `B/`.
3. In the interface, `A` is displayed as a child page of `B`.

## 5. Integrity and Recovery (Ctrl+Z)

- **Container preservation rule:** When all files are removed from a bundle, the folder is not deleted automatically, to prevent conflicts when actions are rolled back (Undo).
- **Cleanup command:** Fully removing empty containers is moved into a separate service operation.
- **Recovery logic:** When the deletion of the `Doc.md` file is undone, the system checks for a folder with the same name. If the folder was restored earlier, the file is automatically moved inside it to restore the bundle's integrity.

## 6. Integration of Dynamic Databases

A hybrid approach is used to store structured data.

- **Embedded DB:** Inside the `.md` file, a code block with metadata is used. The frontend interprets it as a table widget.
- **SQLite Sync:** Changes in the UI (entering data into a table) trigger an `UPDATE` SQL query. The data is synchronized between the Markdown metadata and the local SQLite database to enable complex queries and filtering.

## 7. Technical Stack

| **Component** | **Technology** | **Role**                               |
| ------------- | -------------- | -------------------------------------- |
| **Backend**   | Rust (Tauri)   | FS Access, SQLite (rusqlite), indexing |
| **Frontend**  | TS + React/Vue | Interface rendering, widget logic      |
| **Database**  | SQLite         | Link indexing, metadata, fast search   |
| **Events**    | Notify (Rust)  | Real-time monitoring of FS changes     |

## 8. Key Advantages

1. **Order in the FS:** No scattering of files across root directories.
2. **Portability:** Moving a bundle folder preserves all links and media assets.
3. **Scalability:** The ability to start with plain text and grow the functionality up to a database without changing the entity.
