# Specification of the Hybrid Knowledge Management System (Bundle Note + SQLite)

## 1. The "Bundle Note" Concept

The system eliminates redundant folders in the early stages of content creation. A note is created as a single `Name.md` file. The transition to a "bundle" structure (a folder) happens only when additional data layers need to be stored.

### Workspace module

`amby.supernotes` controls the workspace commands for bundle creation, nesting via a
document target, and layer management. Standard and pre-existing non-Minimal
workspaces inherit it. With the module off, existing bundles appear as folders
with separate rows for the main document and its layers. Their physical paths,
identifiers, and local assets are preserved. Open and edit content from its file
row. Deleting or archiving a file row acts on that file, preserving the directory
and its other contents. A database stays a separate file row inside the folder
even after its Markdown layer is removed. Selecting the folder row acts on
the whole folder. With the module on, deleting a bundle's main document acts
on the whole bundle.
Rename and move linked files as a group from the folder row.

The canonical tree and its incremental patches carry bundle membership from the
filesystem. The workspace projects it without rewriting files. A same-named
Markdown file written into a folder is still recognized by its layout, including
after a remote move, restoration, or creation in another application. Creative
Studio creates story bundles through its own workflow.

## 2. Transformation Triggers (Lazy Transformation)

Creating a child note, moving a document onto a note, or creating a missing
layer can move `Name.md` to `Name/Name.md`. Converting a folder creates the
same-named main note inside it. Attaching a standalone Canvas or Excalidraw also
creates a bundle.

Adding a text layer to a database or an existing bundle creates the Markdown
file beside the other layers. The sidebar uses the files on disk to decide
which layers it can add, regardless of the layer used for the row's icon.
Removing a layer from the document menu sends that file to the system trash
and makes its attachment action available again.

Media imported into a standalone note uses the vault's shared `assets/`.
An existing bundle uses its local `assets/`.

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
