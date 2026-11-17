# Excalidraw as Amby's unified board: detailed assignment for Claude Code

> **Status as of 2026-11-02:** not started. The plan's new capabilities are not implemented in the code; the basis is the previous board editor (`src/components/workspace/canvas/`, `canvas-editor.tsx`, `src/lib/canvas-format.ts`). Findings F01–F12 have not been re-checked against the current code.

Date: 30 September 2026.

Status: an implementation plan based on the current code. The new capabilities described are not yet implemented. The proposed names of types, files, commands and extension formats are not existing APIs.

## 1. Goal and expected result

Evolve the built-in Excalidraw into a unified Amby board editor that lets people work with notes, build tidy maps and edit existing Obsidian `.canvas` files. The user should be able to use a single tool for structured maps and free drawing.

The main scenario: open an existing map, drag a note onto it, read and change it, pull a connection out to a new card, tidy up a branch, save, restart the app and carry on working. The map must stay compatible with its original format, and notes must remain ordinary Markdown files.

### 1.1. Required complete version

- Opening and editing supported JSON Canvas 1.0 directly in `.canvas` through the new board.
- Preserving and evolving existing `.excalidraw` files, including arbitrary drawings.
- Two toolsets in one interface: "Map" and "Drawing", with explicit accounting for format capabilities.
- Full Markdown cards and live cards for notes, attachments and web links.
- Inserting notes from the tree, search, creating a new note from the board, turning a text card into a note.
- Convenient connections: creating, reconnecting, labelling, direction, snapping to sides, creating a card from the end of a connection.
- Groups, alignment, distribution, managed auto-layout, working with branches.
- Board search, minimap, restoring the view position, keyboard navigation.
- Verified undo/redo, autosave, external-change conflicts, recovery after a crash.
- `.canvas` portability, explicit conversion to a `.excalidraw` copy, controlled export of the compatible part of a drawing to `.canvas`.
- PNG/SVG export with the visible content of cards, not only their frames.
- A single user-facing module after acceptance is complete, without automatic conversion of old files.

### 1.2. What must not delay this version

Collaborative editing, cloud sync, AI map generation, a full PDF editor, arbitrary third-party JavaScript add-ons, full compatibility with the Obsidian Excalidraw plugin format `.excalidraw.md`, automatic extraction of semantic relations from text and a finished "Creative workshop" are separate tasks.

Excalidraw itself is not a ready-made domain model of notes and relations. "Add-ons" in this assignment are internal Amby extensions through managed commands, cards and the engine's public API. A new platform for arbitrary plugins is not required.

## 2. How to start and keep within the boundaries of the work

1. Read `AGENTS.md`, this document, `docs/vault-format.md`, `docs/markdown-compatibility.md`, `docs/data-safety-contract.md`, `docs/engineering.md`, `docs/themes-and-localization.md` and `docs/claude-handoff.md`.
2. Check the current `git status`, the branch, the full tracked diff and the contents of the relevant untracked files. At the time of preparation: branch `dev`, HEAD `698c3eb`, app version `0.1.5`, a significant uncommitted diff from other work.
3. Preserve the existing changes. Do not use reset/clean/stash to clean the working tree. Do not rewrite previous plans and statuses as if they were completed.
4. Check each finding below against the current implementation. This document records the state as of the analysis date and does not replace reading the code.
5. The subject of this document is boards. The old database and security plans do not mean an instruction to finish all their stages before Excalidraw. Implement or reuse only the necessary shared prerequisites, above all saving with revision checking and the shared editor lifecycle.
6. If a shared mechanism is already being developed by other work, use one agreed interface. Do not create a second transaction engine, a second Markdown editor or a separate system of note identifiers.
7. Work in complete stages E0–E12. Do not mark a stage as ready because components exist or a parser test passes: verify the production path from opening to re-reading the file.
8. After each batch update `updates/upd_next.md`, format the affected files, run the required checks and record the actual result.
9. Do not change the version, do not commit/push, do not create tags, releases or branch promotions without a separate instruction from the user.
10. For checks use separate synthetic vaults. Do not experiment with the user's notes.

## 3. Confirmed existing foundation

Versions installed at the time of analysis: `@excalidraw/excalidraw` 0.18.1, `@xyflow/react` 12.11.2. Re-check the ranges in `package.json` and the actual version before development. Upgrading the library is not a required part of the assignment.

| Area                       | Existing touchpoints                                                                                            | What to use                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Excalidraw wrapper         | `src/components/workspace/sketch/sketch-editor.tsx`                                                             | Element creation, public props, lifecycle and integration with the workspace                                                       |
| Note card                  | `src/components/workspace/sketch/sketch-note-embeddable.tsx`                                                    | Initial visual implementation; the loading model needs replacing                                                                   |
| Toolbar                    | `src/components/workspace/sketch/sketch-objects-toolbar.tsx`                                                    | Basic tools, adaptive expansion                                                                                                    |
| Drawing format             | `src/lib/sketch-format.ts` and tests                                                                            | Existing saving, runtime state filtering; separate reading, diagnostics and creating a new file                                    |
| Old Canvas                 | `src/components/workspace/canvas/`                                                                              | Cards, handles, labels, DnD, groups, templates, history, minimap                                                                   |
| JSON Canvas                | `src/lib/canvas-format.ts` and tests                                                                            | Initial schema description and preserving extras; separate the codec from React Flow                                               |
| Layout                     | `canvas-alignment.ts`, `canvas-layout.ts`                                                                       | Verified parts of the geometry; do not consider the layout algorithm sufficient for cycles and complex graphs without verification |
| Templates and Mermaid      | `canvas-templates.ts`, `canvas-mermaid.ts`                                                                      | Reuse generation through domain commands, not through a second renderer                                                            |
| Board buffers              | `orchestration/use-sketch-workspace.ts`, `use-canvas-workspace.ts`                                              | Current integration of autosave, recovery and loading                                                                              |
| Shared autosave            | `autosave/autosave-coordinator.ts`, `autosave-lifecycle.ts`                                                     | Per-document queue, vault generations, flush, operation results                                                                    |
| Documents                  | `use-doc-store.ts`, `file-actions/use-markdown-autosave.ts`                                                     | The single note buffer, dirty state, conflicts, the current note save path                                                         |
| Editor surface             | `editor/document-body.tsx`, `editor/document-editor.tsx`, `editor/note-editing-policy.ts`                       | Layer routing and the Source/Live Preview admission rules                                                                          |
| Editing right              | `database/peek/editor-surface-lease.ts`                                                                         | The existing mechanism of a single writable editor surface; extend it and check all callers                                        |
| Markdown preview           | `common/card-markdown.ts`, `tiptap/transclusion-view.tsx`                                                       | The basic preview and the existing safe-display constraints                                                                        |
| Selecting and moving notes | `common/note-picker-modal.tsx`, `src/lib/canvas-dnd.ts`                                                         | Shared note selection and pointer-based drag from the tree                                                                         |
| Storage                    | `src/lib/storage.ts`, `src/lib/storage/port.ts`, repositories and adapters                                      | The only file I/O boundary in the frontend                                                                                         |
| Backend                    | `src-tauri/src/frontmatter.rs`, `history.rs`, `paths.rs`, `recovery.rs`, `watcher.rs`                           | Atomic writes, history, path restrictions, recovery, external events                                                               |
| Rename/move                | `src-tauri/src/index/refactor.rs`, `bundle/`, mutation commands                                                 | Re-pointing links and file-tree operations                                                                                         |
| Modules                    | `sketch/sketch-module.tsx`, `canvas/canvas-module.tsx`, `src/lib/modules/`, `modules.ts`, `module-lifecycle.ts` | Registering file handlers, configuration, enabling/disabling and saving before disabling                                           |
| Themes and strings         | `src/themes/`, `src/locales/resources.ts`                                                                       | All static styles, tokens, the Russian source and the other translations                                                           |

During the initial audit, 9 related Vitest files were run, and 41 tests passed. This is not a check of the whole program, the native UI, import from Obsidian or all the problems found.

## 4. Initial findings and required fixes

### F01. A load error is masked by an empty document — P0

In `loadSketchBuffer` and `loadCanvasBuffer` a read/validation exception is replaced with a new empty document. `parseSketch` and `parseCanvas` also have a tolerant fallback. This conflates "a new document" with "an existing document was not read". After a user action the empty state may go into autosave at the original path.

Fix: a typed load result, the original bytes and a diagnostic state; a new empty file is created only by an explicit create command. A corrupted, inaccessible or unsupported file does not get a writable editor. Recovery is handled separately, preserving the on-disk original and with a confirmed choice of recovery.

### F02. Extra drawing fields are lost at the editor boundary — P0

`serializeSketch` can accept unknown top-level fields, but `handleChange` and `flushSketch` pass only `elements`, `appState`, `files`. As a result the original `source`, extra data and potential extensions do not go through the real editing cycle. An isolated serializer test does not detect this.

Fix: a source envelope, preserving unknown fields by stable IDs, a test through the real editor callback. Separately check that upstream `restoreElements` does not drop unknown element fields. For unsupported types that cannot be saved safely, use view/source mode rather than letting elements vanish.

### F03. The history contract does not match the 0.18.1 API — P0

The locally hand-written `ExcalidrawImperativeAPI` contains `commitToHistory`. In the installed library `updateScene` uses `captureUpdate`; `IMMEDIATELY`, `NEVER`, `EVENTUALLY` are available.

Fix: the library's real published types, or inferring the type from the public prop; local actions are deliberate undo checkpoints, external reload and initialization stay out of history. Remove the fictitious typing that hides the incompatibility. Check the result of undo/redo, not only the argument of a mock function.

### F04. Note cards do not update following the content — P1

In `SketchNoteEmbeddable` reading depends on `[notePath, vault]`. There is no subscription to the note's dirty buffer, its save or watcher invalidation. The same card can show stale content until it is remounted.

Fix: a shared preview/document provider that prioritizes the current open buffer, with subscriptions and a cache. Do not re-read one file independently for each card.

### F05. Excalidraw links do not take part in the current rename — P0

The card creates `amby://note/${encodeURIComponent(relPath)}`. The backend refactor looks for Markdown occurrences and a string of the form `"relative/path.md"`; a URI with a prefix and encoding does not match. Example: `amby://note/Folder%2FNote.md`.

Fix: a shared link parser/resolver, typed rewriting of the corresponding JSON fields and integration with rename/move. For notes with a reliable `amby-id` preserve the ID and the portable path; for the rest preserve the path, without passing off a temporary index ID as stable.

### F06. Treating `.canvas` in the sketch parser is not an import — P0

The current drawing validator accepts an object without `elements`. JSON Canvas passes as a drawing with an empty scene, and `nodes`/`edges` remain extra fields until the next save from the editor.

Fix: separate codecs and explicit format detection; a mismatch between extension and content requires a diagnostic. Adding `.canvas` to the manifest without an adapter is forbidden.

### F07. A partial JSON Canvas implementation is not the same as full display — P1

In the old Canvas, `link` is displayed through a file-card; `subpath` and the group background may be saved in the data without corresponding display. The validator requires both `nodes` and `edges`, although they are optional in the specification.

Fix: a support matrix and separate tests for reading, display, modification and saving. The presence of a field in TypeScript is not feature readiness.

### F08. Working with Excalidraw's internal DOM is fragile — P1

There are `querySelector` calls on `data-testid` and internal CSS classes for undo/redo, zoom, menus; a `MutationObserver` modifies the hyperlink popup and adds a Browse button.

Fix: use public callbacks and our own React action panel for the card. If the library does not provide a public undo command, keep the available upstream controls/shortcuts or make a documented isolated integration. Do not invent a non-existent API and do not replace the selector dependency with synthetic keyboard events without verification.

### F09. Full serialization is performed on every `onChange` — P1

`handleChange` starts with JSON serialization of all elements and files, including changes that may relate to the view. The disk debounce does not eliminate this cost.

Fix: cheap detection of document changes, coalescing and bounded checkpoints; a final flush is mandatory. Verify the decision by profiling, not only by the number of saves.

### F10. The link format is accepted more broadly than it is actually rendered — P1

`validateEmbeddable` accepts `note:`, while the custom renderer/open handler process only `amby://note/`. In several handlers `decodeURIComponent` is not protected against errors.

Fix: a single parsing function with a typed invalid result, a defined policy for legacy links, a safe placeholder for malformed URIs.

### F11. An arbitrary Markdown string is not yet a full card — P1

An Excalidraw text card is a rectangle with an ordinary text label. It is not a Markdown editor. `renderCardHtml` creates styled wiki-link spans, but the sketch card itself has no handler for navigating through them.

Fix: separate "caption/sticker" from "Markdown card"; use a single safe preview and link routing. Do not store the only copy of Markdown as drawn text.

### F12. Shared board protection by revisions is not yet proven — P0

The current sketch/canvas coordinators call the generic `writeFile`. The handoff and the data-safety contract explicitly note the need for shared protection against stale writes. A watcher, an atomic rename and a sequential queue do not by themselves verify that the source file has not been changed externally.

Fix: a read/write outcome consistent with the rest of the project, with a raw revision, a pre-publish check, history and a typed conflict. Do not promise perfect cross-process CAS on an ordinary file system: document the residual window for an external race and the recovery guarantees.

## 5. Architectural decision

### 5.1. One user-facing editor, two source formats

`.canvas` and `.excalidraw` remain independent formats on disk. The new interface uses Excalidraw as the main renderer and interaction engine. The document format determines the permitted operations, and the selected «Карта/Рисование» (Map/Drawing) panel is a convenience for accessing them.

| Document                   | Authoritative content                                         | Permitted actions                                                         | Saving                                   |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `.canvas`                  | The source JSON Canvas and its preserved opaque fragments     | Cards, files, links, groups and connections within the supported contract | The same `.canvas` is updated            |
| `.excalidraw`              | The source Excalidraw scene, its envelope and Amby extensions | Cards plus ordinary shapes, drawings, images and engine tools             | The same `.excalidraw` is updated        |
| Unsupported/corrupted file | The source bytes                                              | View diagnostics, view the source, save an explicit copy                  | Autosave to the source path is forbidden |

Do not create two independently editable full representations of a document. For `.canvas`, the Excalidraw scene is a projection of the source model. For `.excalidraw`, ordinary engine elements remain the source scene, while the domain indexes of cards and connections are derived from its metadata. Both documents have one sequence of local changes and one persistence coordinator.

### 5.2. An early technical prototype is a mandatory precondition

Before mass migration of the UI, verify with the real Excalidraw 0.18.1:

1. A React/DOM card with Markdown, scrolling and text editing.
2. Dragging a card by its title, resize and pan at 25%, 100%, 200% zoom.
3. An arrow bound to an embeddable and its behavior on resize/move.
4. Four custom connection points and creating a new card from the end of an arrow.
5. Pointer-event availability on top of an HTML card, focus, text selection and IME.
6. A group without unintended clipping or changes to the stacking order.
7. A custom card in PNG/SVG export and in a portable native file.
8. Action history, duplication and clipboard for managed objects.

For each check, record: the public API used, the limitations, and proof in the browser and in Tauri. Do not treat `renderEmbeddable` as an automatic solution for export, history or intercepting all events.

If the required action is impossible through the public API, first look for a local adaptation without changing the engine. Then set up a small isolated patch/fork with the reason, the maintenance size, the license and update checks. Do not bury the dependency in a monkey patch of internal objects. Until a critical scenario is solved, the old Canvas remains available as a temporary fallback; this does not mean the replacement is complete.

### 5.3. Separation of responsibility

The proposed logical parts, not a mandatory list of new files:

- `board-document`: format, source data, capability flags, dirty/checkpoint and diagnostics.
- `canvas-codec`: JSON Canvas without a dependency on React Flow or Excalidraw.
- `excalidraw-codec`: the source scene, unknown fields and Amby extensions.
- `canvas-scene-adapter`: projection of `.canvas` into a scene and translation of changes back into domain-model commands.
- `board-commands`: creating, changing, deleting, grouping, connecting and layout.
- `board-note-provider`: identity resolution, the shared open buffer, preview cache, invalidation.
- `board-persistence`: shared autosave/recovery through the storage port, without direct FS.
- `board-renderer`: Excalidraw and custom React overlays/panels; it does not own a durable copy of the note.
- `board-view-state`: viewport, selection, the open panel and local view settings.

Place the parts in the existing `sketch/`, `canvas/`, `common/`, `orchestration/` or a small shared `board/` according to actual reuse. Do not create an abstract platform for the sake of future extensions. `workspace.tsx` must not become the owner of a new parallel board model.

### 5.4. Commands and history

A single execution path for domain actions is needed. The proposed minimal set:

```text
createTextCard / insertNoteCard / insertAssetCard / insertLinkCard
updateCardContent / updateCardGeometry / updateCardAppearance
connectCards / reconnectEdge / updateEdge / removeEdge
groupSelection / ungroupSelection / moveGroup
alignSelection / distributeSelection / layoutSelection
duplicateSelection / removeSelection / convertTextCardToNote
```

Each command has a document identity, a generation, an expected local checkpoint and a defined undo boundary. Creating a card together with a connection is one action. A drag across hundreds of pointer events is one undo step. Updating a preview after a note is saved is not a board edit.

Direct scene changes by the built-in tools must also go through reconciliation of managed objects. It is mandatory to verify delete/duplicate/paste/group/undo from Excalidraw's own menu and shortcuts: the domain model must not see only the Amby panel itself.

Do not maintain an independent `CanvasHistory` and the upstream Excalidraw history at the same time for one editable board. Choose the history owner after E1 and synchronize the related metadata in the same checkpoint.

## 6. Data, identity and preservation of the unknown

### 6.1. Do not mix identifiers

Distinguish the note ID, the card ID on the board, the Excalidraw element ID and the connection ID. One note can have several cards on one or different boards; each has its own geometry. Duplicating a card does not duplicate the note.

For `.canvas`, preserve the source node/edge IDs. If one card is rendered by several scene elements, maintain a stable `nodeId → elementIds` mapping, including label/background/preview. For an imported source, do not regenerate all IDs on every open.

### 6.2. Proposed note reference

```ts
// Conceptual schema for design. Does not exist in code at the date of the plan.
interface BoardNoteReference {
  path: string // portable vault-relative path
  noteId?: string // only a trusted stable ID, if one already exists
  subpath?: string // a preserved reference to a heading/block
}
```

Resolve the ID and the path consistently. If a trusted ID is unambiguously found at a new path, show the current note, and update the saved path through a controlled mutation. If the ID and the path point to different existing notes, show a reference conflict instead of a silent substitution. With duplicate IDs, do not pick a random result.

Existing legacy `amby://note/...` links must keep opening. Updating them is not permission to mass-rewrite frontmatter. The remark "this note has no stable ID" must not block reading a card by path; editing follows the current note policy.

### 6.3. Amby extensions in `.excalidraw`

For managed elements, use the engine-supported `customData` with its own namespace and a version. For example:

```json
{
  "customData": {
    "amby": {
      "version": 1,
      "kind": "note-card",
      "cardId": "board-local-id",
      "note": { "path": "Projects/Plan.md", "noteId": "existing-trusted-id" },
      "display": { "mode": "preview" }
    }
  }
}
```

This is an example of a future contract. Validate real note IDs, limit payload sizes, and do not treat any `customData` as trusted. Preserve third-party namespaces. On a conflict with an already existing key or a newer version, do not overwrite it.

Durable Markdown card texts, connections and user layout settings are stored with the document, and not only in SQLite or in the recoverable `.amby/` cache. The text of a linked note is not copied as a second editable source. A preview snapshot is acceptable only as an explicitly aging derived image/preview for portability and export.

For `.canvas`, the standard node/edge fields are the primary contract. Optional Amby extensions do not replace `text`, `file`, `subpath` or endpoints. Before writing new extension fields, verify that they are preserved during real editing in Obsidian. If a foreign application drops them, the main map must still remain fully functional; the inability to preserve additional settings must be documented.

### 6.4. Source envelope and preservation

The loader keeps the raw source, the format, the revision, the recognized objects and the opaque data. It separately distinguishes an empty new document from a non-empty unknown format.

- Opening, changing the theme, pan/zoom, viewing a card and closing without edits do not change the file's bytes and do not create a history snapshot.
- On editing, only the affected fields/objects change. Unknown data, array order, identifiers, source Markdown and attachments are not lost.
- Implement saving through a parser with source ranges/structural patches wherever byte preservation outside the change is needed. Do not replace this with a regexp over arbitrary JSON.
- Do not claim byte-exact for `JSON.parse → JSON.stringify`: such a cycle changes formatting and can lose number precision and duplicate keys.
- For ambiguous JSON, duplicate keys, values outside the safe numeric range or future types, choose a supported lossless path or a view/source mode. Do not "fix" the file on load.
- Take the BOM and the source EOL style into account at the level of the raw source and the backend write. Compute the revision over the full source, not over the normalized projection.
- Preserve unknown fields both on the real editor path and during undo, reload, restore, duplication and export-copy.
- Deleting a visible known card may delete the corresponding source node and its connections. The absence of an unknown element in the projection does not mean intentional deletion.

The new extension format is first documented and covered by fixtures, and only then is writing enabled. Migrating an existing durable format requires a version, a preflight, a backup, an outcome, completion detection and a safe rollback.

## 7. `.canvas` compatibility contract

The main external source: [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/). During implementation, read the specification directly; test its optional fields and default values.

| Object/property      | Required behavior of the new board                                             | Check                                             |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| Top-level            | `nodes`/`edges` may be absent; unknown fields remain                           | `{}`, only nodes, only edges, extensions          |
| Node order           | Preserves z-order; groups are not automatically moved to the back              | Overlapping cards and a group                     |
| Text                 | Stores the source Markdown, visually renders the safe part                     | Callouts, tables, wiki links, code, opaque syntax |
| File                 | Refers to an existing file without copying it                                  | Markdown, image, PDF and an unknown attachment    |
| Subpath              | Opens/shows the needed heading or block; is not dropped                        | Repeated headings, missing anchor, block ID       |
| Link                 | A separate URL card, not an attempt at `readFile(https://...)`                 | HTTP(S), offline, invalid URL                     |
| Group                | An area with a label and source bounds, without mandatory clipping             | Nested and intersecting groups                    |
| Group background     | Preserves the path and mode; correctly renders a supported image               | cover, ratio, repeat, missing asset               |
| Sizes/coordinates    | Do not change merely because of opening or DOM measurement                     | Negative coordinates, different sizes             |
| Colors               | Preserves source preset/hex, renders through the theme mapping                 | All presets and a custom hex                      |
| Edge                 | Preserves endpoints, sides, arrowheads, label, color                           | Both directions, without arrows, without sides    |
| Multiple connections | Preserves separate edge IDs between the same nodes                             | Parallel edges and different labels               |
| Cycles/self-edge     | Does not lose the connection; if interaction is limited, preserves and reports | A→B→C→A and A→A                                   |
| Dangling edge        | Shows a diagnosable problem, does not delete silently                          | A non-existent endpoint                           |
| Unknown extension    | Stored opaquely; not applied as JS/HTML                                        | Third-party fields on document/node/edge          |
| Unknown node type    | Preserves losslessly or blocks visual write                                    | A future type and unrelated known nodes           |

### 7.1. Open, convert and export are different actions

"Open `.canvas`" keeps the source path and format. "Create an Excalidraw copy" creates a new file via no-replace, leaving the source and its attachments in place. "Export to `.canvas`" pre-classifies objects: exactly representable, requiring explicit conversion, unrepresentable.

A freehand drawing must not be automatically turned into a raster image in `.canvas`, drawings must not be deleted, and the meaning of connections must not be lost. When there are limitations, show a concrete list and offer to export the selected compatible part or to save a native copy. Cancelling creates no side files.

JSON Canvas has no standard way to preserve arbitrary freehand strokes, all arrow shapes and all Excalidraw parameters. In `.canvas`, these tools must lead to explicit work with a copy or be unavailable with a clear explanation. Choosing a toolbar does not change the file extension.

### 7.2. Compatibility levels

Separately mark data preservation, rendering correctness and editability. For example, a preserved group background without rendering is preservation PASS, rendering PARTIAL. A file that remained syntactically valid but lost one card is not considered compatible.

Golden fixtures must pass the path `source → loader → live editor → edit → writer → reopen`. A manual check of representative fixtures in the current version of Obsidian, recording the version, is needed. If Obsidian is unavailable, record this as a check not performed and do not claim full visual compatibility.

## 8. Cards and working with notes

### 8.1. Card kinds

| Kind          | Data                                                      | Main actions                                                        |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Markdown card | Text directly in the board                                | Read, edit, turn into a note                                        |
| Note          | A reference to a Markdown file/ID and an optional subpath | Read live content, open on the side/in a tab, replace the reference |
| Attachment    | Portable path                                             | Show a supported preview, open the file, replace the reference      |
| Web link      | URL                                                       | Show a local URL card, open via a safe opener                       |
| Sticker/label | An ordinary Excalidraw element                            | A quick label and styling in a native document                      |

Notes need modes: «Название» (Title), «Кратко» (Brief), «Содержимое» (Content). The initial size is a reasonable preset, height is limited; a long document scrolls inside. Automatic text updates must not unexpectedly push the whole map apart. Auto-height is a separate explicit setting.

### 8.2. Shared provider

The order of obtaining data: the current open buffer → a cache by identity/revision → a read through storage. When several cards refer to one note, share the request and the result. A vault change cancels/invalidates old requests; a late response does not reach the new vault.

The cache must account for the revision, subpath, preview mode and the necessary renderer options. The watcher and a local save invalidate the corresponding note, not all cards in the world. Access errors, a missing file, an unresolved anchor and malformed metadata have different states; past content may be shown as stale, but not as current.

Notes with an invalid/duplicate ID and unsupported Markdown follow the general repository rules. A card must not "heal" YAML by regexp-removing frontmatter or run a migration for the sake of a preview.

### 8.3. Editing

The first reliable path is a side editor for the selected note that keeps its place on the map. Add inline editing after verifying the shared lifecycle. Use the existing Markdown-editor policy: only byte-exact syntax is allowed in Live Preview, the rest is edited in Source.

Extend `EditorSurfaceLeaseManager` for the board surface or extract it into a shared location, preserving the semantics. The presence of the manager in `database/peek/` does not prove that all surfaces already use it: check the real callers. One note has one writable owner in a window. Other cards show the current preview and an action to go to the active editor. Before a transfer — flush and a correct handover of the dirty state, without a second autosave timer.

The note text history and the board geometry history are different areas. When focus is in a note editor, `Cmd/Ctrl+Z` undoes text; when focus is on the board, it undoes a board action. A focus change does not lose unsaved data.

### 8.4. Creating a note and converting a card

The command proposes a name and a folder with a reasonable default based on the board's location. A unique name is determined by the backend no-replace, and not only by a frontend check. The new note is created by the existing note creation path with correct identity.

When converting a Markdown card, preserve the text byte-exact, its coordinates, sizes, color and all connections; replace the content source with the created note. If creating the file failed, the card remains a text card. If the file was created but the board write did not complete, the operation reports a recoverable partial outcome and allows re-linking the already created file without a duplicate.

Undo of the conversion returns the text card, but does not silently delete the created note, which the user may already have changed. Define and show this behavior. An automatic rollback of the new file is allowed only if the operation has proved it unchanged and follows the existing restorable deletion contract; no direct `unlink` of user files.

### 8.5. Internal links and attachments

Handle `[[note]]`, aliases, headings, block refs, ordinary Markdown links, local images and transclusions through the existing resolver/storage. Relative links inside a note are resolved from the note, not from the board file. For a text card, fix the resolution context relative to the board.

Moving a card's text into a note in another folder requires an analysis of relative links: either preserve the context without changing the text by choosing the folder, or an explicit controlled re-linking with a check of the source. Do not claim byte-exact conversion if links were silently changed in the process.

Limit nested transclusions by depth, count and size. Cycles A→B→A show a placeholder. Clicking a link must not simultaneously drag the card or open the whole note on a double click.

PDF/audio/video and unknown attachments must at minimum be preserved as working file cards. Add rich previews according to the capabilities of the existing storage and renderer; do not treat the absence of a full PDF editor as a blocker.

## 9. Connections: the exact interaction contract

### 9.1. Basic actions

- On hover/selection of a card, show connection points at the top, right, bottom and left; the hit area stays comfortable at different zoom levels.
- Dragging from a point to another card creates a connection with a route preview and highlighting of a valid target.
- Dragging into empty space opens a choice of "Text / Note / Existing note". After the choice, a card and a connection are created in one action. `Escape` leaves the source document unchanged.
- A selected connection has both ends available for reconnecting. Cancelling returns the previous endpoints and geometry.
- Double-clicking a label opens an inline input; Enter finishes, Escape cancels. A connection without a label has an explicit add action.
- Available: "no arrows", "arrow to target", "arrow to source", "bidirectional", color change and deleting the connection.
- Several connections between the same cards are preserved separately. Repeating the gesture must not silently overwrite an existing label.
- Deleting a card correctly deletes its local connections from the current board and restores everything with one undo. The note itself is not deleted.

### 9.2. Binding and routing

Use the engine's native binding as far as it provides the contract. On import/programmatic creation, consistently update endpoints, the reverse `boundElements`, label binding and element versions. Writing only `startBinding` on the arrow is not enough.

A straight and an orthogonal route are mandatory variants for a native board. For `.canvas` this is a representation of a standard connection; do not present non-standard route points/styles as JSON Canvas fields. When sides are absent, use the documented auto-detection without pointlessly saving new fields just because the file was opened.

Verify binding for moving/resizing both cards, negative coordinates, groups, duplicate/paste, undo and zoom changes. In the prototype, investigate `focus/gap` and `fixedPoint` of exactly the installed version; do not copy formulas from another major/minor API.

Full obstacle-avoiding routing is a separate degree of quality. In the first version the route must be deterministic and must not pass through the endpoint cards. For arbitrary obstacles, measure the effect and the cost of more complex routing; do not promise "zero crossings" for any graph.

### 9.3. A visual connection and a relation between notes

An ordinary arrow belongs to the board. It does not append `[[...]]` to Markdown and does not create a database Relation. A "related to" label by itself is not a durable relation outside the board.

A future "Create relation" command may use the databases/creative module API after a separate specification. Do not add a second source of domain relations in this release. For useful navigation, a rebuildable index "Which boards a note is placed on" is acceptable; its source is the board files, not a hidden write into Markdown.

## 10. Interface modes, groups and maps

### 10.1. "Map" mode

Main tools: select, pan the canvas, text card, note, connection, group, attachment. New cards have even outlines, ordinary readable typography, consistent paddings and sizes. Do not change the roughness/font/background of already existing elements when switching the mode.

The properties panel is contextual: for a card — source/kind/color, for a connection — endpoints/label/arrowheads, for a group — name/background. All actions are available from the keyboard and through menus; hover is not the only way to control.

### 10.2. "Drawing" mode

Keep the ordinary Excalidraw tools, library, freehand, shapes, text, images and frames. Note cards remain available. The UI must not cover upstream controls so that functions disappear without a replacement.

For `.canvas`, show only permitted operations or offer an explicit native copy before an incompatible action is performed. Do not draw an object that the next autosave would silently drop.

### 10.3. Keyboard and focus

| Context               | Action             | Expected behavior                                                                       |
| --------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| Board                 | Space + drag       | Pan; does not type a space into an inactive editor                                      |
| Card in map mode      | Tab                | Create a child card with one connection when the branch map is enabled                  |
| Card in map mode      | Enter              | Create a sibling card in a defined branch; with an ambiguous parent, an explicit choice |
| Selection             | Delete/Backspace   | Delete board elements, not note files                                                   |
| Board                 | Cmd/Ctrl+Z, redo   | Board history                                                                           |
| Note/text editor      | The same shortcuts | History and navigation of the corresponding editor                                      |
| Any temporary gesture | Escape             | Cancel connection/edit/menu without changing the source                                 |
| Board                 | Cmd/Ctrl+F         | Search the board; focus and jump to the found card                                      |

Tab/Enter are not intercepted in input, textarea, contenteditable, IME composition and accessible keyboard navigation outside the branch-creation mode. Resolve shortcut conflicts with Excalidraw at the focus router level; do not attach handlers to the whole window without restricting them to the active surface.

### 10.4. Groups

For JSON Canvas, a group is a visual area. Do not consider an Excalidraw frame and group exact equivalents: a frame can change clipping and membership.

Determine members at the start of the gesture by the adopted rule and do not recompute them chaotically at every pixel of the drag. Moving a group moves the selected members and connections consistently. Check the intersection of two groups, nesting, a partially included card and a manual move outside.

Hiding/collapsing a group does not delete the child nodes. For shared/cyclic graphs, "collapse branch" requires an explicitly chosen tree/root; do not hide nodes used by another open branch without a clear behavior. Local collapsing can be stored as view state; a portable state requires a documented extension contract.

### 10.5. Layout

Mandatory: alignment by sides/centers, equal spacing, grid and guides, horizontal/vertical layout, layout of only the selection, and pinned positions. Auto-layout runs by an explicit command with a preview or a single undo; new data must not constantly rebuild a manual composition.

Consider the existing `computeAutoLayout` as a starting algorithm. Check DAGs, cycles, disconnected components, groups and variable card sizes. If insufficient, choose a layout library after a local comparison, rather than writing a complex graph engine from scratch. Check the dependency's version/license/size before adding it. Arrow routing is recomputed consistently with the final geometry.

Mind-map: a root, child/sibling cards, left/right or radial placement. A full free graph is not required to have a single parent; do not resolve ambiguity with an arbitrary first edge.

## 11. Saving, external changes and recovery

### 11.1. One document lifecycle

The loader returns raw content, format, revision and diagnostics. The editor changes the local revision. The persistence coordinator saves the last confirmed model through storage. A successful write returns a new disk revision; it becomes the base of the next save.

Do not confuse the dirty state of the board with the dirty state of a note opened from a card. Closing the board must first handle the note editor lease owned by its surface, the serialization flush and autosave/recovery of both documents.

### 11.2. Mandatory failure boundaries

1. Read/validation: an error does not turn into an empty writable buffer.
2. Write preparation: the source revision and scope are checked by the backend.
3. History snapshot: a mandatory error stops replacing the source.
4. Temporary write/publication: an error does not zero the source file.
5. Response of an old write: does not clear the new dirty state and the new recovery draft.
6. External change: a clean document is refreshed, a dirty document gets a conflict.
7. External deletion: the dirty buffer remains available for recovery/copy; autosave does not recreate the file without a chosen action.
8. Vault change: old requests and saves do not reach the new scope.
9. Crash/restart: the last unsaved edit is restored through the existing journal with an explicit choice on divergence.
10. Rename of an open dirty board/note: buffer remap, queue, recovery and references are consistent; a late save does not create the old path.

### 11.3. Rename/move of links

Handle both the standard `.canvas` file/subpath and group background, and the Excalidraw note reference/customData/legacy URI. Change only the link fields, and not a coinciding label text, code block or foreign metadata. Percent-encoding is decoded in a controlled way exactly once; an error does not bring the board down.

Cases needed: spaces, Cyrillic, Unicode normalization, `#`, `%`, folder moves, case-only rename on a corresponding FS and bundle promotion. Do not rewrite links beyond the vault and do not open them by bypassing the guard.

In a multi-file refactor, create a preflight/recovery point and account for dirty open boards. A file on disk must not be rewritten and then have the old editor buffer bring back the old link. Use the shared mutation protocol, including a recoverable partial outcome and an idempotent retry.

### 11.4. View state

The viewport, last selection, open panel, local zoom and search results must not make the source dirty on their own. Store them in the existing view-state system keyed by vault/document, with remap on rename. On reopen, restore a valid viewport; fit-to-content only for the first open or an explicit command.

Do not store Excalidraw library files inside an arbitrary appState. If user library items must survive a restart, define a separate versioned portable/user-settings contract, use `onLibraryChange`, and verify module disabling. Do not treat the presence of a library button as proof of its persistence.

## 12. Export and portability

### 12.1. PNG/SVG

The card's own HTML renderer does not guarantee that its content lands in the engine's export. Verify this path in E1; implement a dedicated export projection or a controlled card snapshot if the upstream API does not account for it.

- Export the whole board or the selection, choose the background and a sensible scale.
- Account for arrow labels, groups, images, fonts and the light/dark theme.
- For a long card, define explicitly: visible area or expanded content. Do not crop silently and do not change the source board's sizes for the sake of export.
- A snapshot export corresponds to one consistent checkpoint, including the current dirty note buffer when viewing is allowed.
- Export does not change the source document, its history and dirty flags.
- Do not embed executable HTML/JavaScript or arbitrary external resources in the SVG.
- Show attachment/font loading errors before the success message of the export.

### 12.2. Native Excalidraw outside Amby

Ordinary shapes/files must keep working. For an Amby note card, define a visual fallback: title/path/preview snapshot as derived data, if generic Excalidraw cannot run the custom renderer. Do not promise live reading of the local vault by a third-party application.

Verify the scenario "open in standalone Excalidraw → edit an ordinary shape → open in Amby again". Preservation of customData, managed IDs and the fallback must be confirmed. If a third-party editor removed the extension data, Amby shows the degradation rather than replacing the remaining content with a new empty object.

### 12.3. `.excalidraw.md`

Do not route Obsidian Excalidraw plugin files into the ordinary JSON parser. Their Markdown wrapper, links and possible packed content require a separate adapter and fixtures. Until it is implemented — source/diagnostics or an explicit instruction to export to supported JSON, without autosaving over the source Markdown.

## 13. Performance, accessibility and security

### 13.1. Measurements

First record a release-build baseline on a known device, browser and Tauri separately. Synthetic sets:

| Set | Composition                                  | What is checked                                                |
| --- | -------------------------------------------- | -------------------------------------------------------------- |
| S   | 50 cards, 75 links, 10 notes, several images | Everyday gestures, startup, autosave                           |
| M   | 300 cards, 450 links, 100 unique notes       | Viewport culling, shared preview cache, search, layout         |
| L   | 1000 cards, 1500 links, 300 unique notes     | Stability, memory, gradual loading, cancelling long operations |

Add variants with one long note, many cards of one file, and a native drawing with large image assets. Do not assess load by the number of DOM nodes alone.

Preliminary targets on the fixed device: visible response of an ordinary action p95 up to 100 ms on S/M, no repeated long main-thread tasks during pan, smoothness close to the screen refresh rate, first useful frame of M within 2 seconds with a warm cache. These are targets, not results. If they are unrealistic on the target WebView, record the measurements and a justified budget before declaring the stage ready.

For L the priority is no freezes/data loss, explicit progress and the ability to cancel. The numbers for serialization time, parse/load, layout, number of readFile calls and memory consumption are mandatory; a single FPS screenshot is insufficient.

### 13.2. Optimization

- Do not serialize the full `files` blob on every hover, scroll or selection.
- Check the document versions of elements and meaningful appState; if needed, use the available public scene version API.
- Coalesce changes with a maximum delay and a mandatory flush at lifecycle boundaries.
- Support visibility/simplified preview outside the viewport without losing source nodes and connected edges.
- Do not mount a separate Tiptap for every visible card: there is one active editor, the rest are previews.
- Limit the cache by memory and correctly release leases/listeners/observers on close and vault change.
- Move heavy layout/parse to a worker when necessary, without giving it a way around the storage boundary.
- A preview update of one note must not redraw the whole workspace or re-read the tree.

### 13.3. Accessibility and styling

Strings go only in `src/locales/resources.ts`, for all supported languages. Theme and palette — `src/themes/`. Icons — `IconValue` and the existing encoded values. Do not pass an encoded icon as an ordinary text string.

Keyboard focus must be visible, cards and links have accessible names, and the selected/editing state is announced to assistive technologies. An accessible list of board objects is needed for navigation where canvas rendering alone is insufficient. Colour is not the only carrier of link type/direction. Check contrast, reduced motion, a narrow panel and system scale.

### 13.4. Security boundaries

All FS goes through the storage/Rust guards. Relative paths are normalized without allowing escape from the vault; an absolute path, `..`, symlink and foreign URI do not bypass the guard. Do not widen the static Tauri filesystem scopes.

HTML in Markdown is not executed. A web card by default shows the URL without a background network request and without an arbitrary iframe. A rich embed is allowed by a separate safe policy. Check `javascript:`, `data:`, `file:`, malformed percent-encoding and unsupported schemes.

Imported SVG/HTML and JSON customData are not code. Text sizes, file sizes, the number of objects and nesting depth have verifiable limits. On exceeding them — diagnostics/cancel, not a partially written document. Diagnostic logs must not print note contents and secret URLs.

## 14. Merging modules and moving off the old Canvas

Keep the ID `amby.excalidraw` as the owner of the extended board unless the current module architecture requires otherwise. The user-facing name can be made "Доска" (Board)/"Excalidraw" through localization. Renaming does not require migration of user files.

### 14.1. Transition period

The old `amby.canvas` and React Flow remain available until the new `.canvas` mode is fully accepted. Do not register two competing writers/file handlers for one extension without an explicit choice of owner. Use a feature flag or a resolver strategy, not a random module activation order.

Keep the existing layer paths: `.canvas` and `.excalidraw` can lie in a bundle at the same time and contain different documents. A single UI does not mean merging these two files. Tabs/layer selection must unambiguously show which document is open.

Verify `.sketch`: the manifest declares the extension, but actual support for the tree, backend scan, creation and loading must be proven. Do not remove a declared legacy handler without diagnostics/a migration contract, and do not present an alias as the full Sketch.app format.

### 14.2. Switching the default

After E10–E11, make the new renderer the owner of `.canvas`, update the registry/profile/default handlers and the raw fallback when the module is disabled. Disabling first performs serialize/flush/recovery; on failure, the module state must not turn an unsaved document into an inaccessible one.

If the configuration transfer `amby.canvas → amby.excalidraw` changes persistent settings, it has a version, idempotency and rollback. Do not enable a module that the user explicitly disabled without a clear transition rule. Distinguish the absence of the old setting from the user's explicit refusal.

### 14.3. Removing the old renderer

Only after the matrix is completed, manual checks pass, parity of the existing useful actions is reached, and there are no React Flow calls in the working `.canvas` path. First extract the shared codecs/geometry/templates, then remove the dead wrapper and dependencies if they are really not needed anywhere else.

`@xyflow/react` may be needed by a future or another module; check current usages and knip. Do not delete the `canvas/` folder wholesale together with useful tests and the format. A reversible renderer switch must not require converting files back.

## 15. Implementation plan by stage

The numbering reflects dependencies. Within a stage, independent tasks can be reordered, but integration and checks are performed on a consistent state. It is not allowed to stop work after E1 or E4 and call the whole plan implemented.

### E0. Baseline, fixtures and contract

Dependencies: none. Result: a verified current state and reproducible examples.

- E0.1: reconcile F01–F12, actual dependency versions and current shared persistence changes.
- E0.2: assemble a synthetic fixture vault with `.canvas`, `.excalidraw`, notes, links, attachments, foreign metadata and malformed files.
- E0.3: record the original hashes/bytes, application versions and baseline S/M/L.
- E0.4: clarify the history owner, document identity, raw preservation rules and format compatibility in a short ADR.
- E0.5: record the currently failing gates separately from future regressions; do not substitute "all green" from an old report for the baseline.

Acceptance: fixtures are reproducible, risks are named, minimal source-preservation tests run through the real loaders. The result of the stage still gives no grounds to change the default handler.

### E1. P0 fix and Excalidraw feasibility check

Dependencies: E0. Result: a safe existing integration and a working prototype of the critical interactions.

- E1.1: typed load failures, a ban on the empty fallback for existing files, negative tests.
- E1.2: an envelope preserving additional fields on callback/flush/reopen.
- E1.3: real API types, `captureUpdate`, undo boundaries, no dirty from mount/theme/pan.
- E1.4: a shared parser for the legacy note URI and a protected decode; fix the obvious rename gap while preserving unknown source.
- E1.5: perform all eight prototype checks from §5.2, including the live renderer, not just mocks.
- E1.6: choose a single history scheme and a source↔scene mapping method; record the limitations/the minimal upstream patch needed.

Acceptance: F01/F02/F03/F06/F10 are closed by executable checks; card, resize, link, undo and export feasibility are shown in Tauri. If a critical interaction is impossible, do not continue the mass migration on an unverified assumption.

### E2. Consistent board saving and recovery

Dependencies: E1 and an agreed shared mutation contract. Result: boards are saved with revision/conflict semantics.

- E2.1: extend/reuse the storage port and Rust commands for reading the raw revision and safely writing a board; IPC type versions and generated bindings are consistent.
- E2.2: move the sketch/canvas writers to this path with history and typed outcomes.
- E2.3: perform failure injection per §11.2, including external write/delete and old save responses.
- E2.4: verify rename/remap of pending queues, closing a layer/window, vault switch and module disable.
- E2.5: keep recovery drafts until the current write actually succeeds; the journal is readable after restart.

Acceptance: the source is not corrupted at failure boundaries, a stale save is detected within the documented contract, recovery after a crash is available. An atomic write without a revision check does not close the stage.

### E3. Independent JSON Canvas codec and domain commands

Dependencies: E1; connect saving only after E2. Result: a supported `.canvas` model not tied to React Flow.

- E3.1: extract the codec/validator/opaque envelope from `canvas-format.ts` without breaking the old renderer.
- E3.2: implement optional arrays, schema diagnostics, preservation of unknown fields and the raw-source policy.
- E3.3: define operations on nodes/edges, ID mapping and a meaningful diff; preserve the original defaults/absence of fields.
- E3.4: add fixtures for all rows of §7, malformed/future cases and a byte-exact no-op.
- E3.5: define typed format capabilities, including incompatible drawing actions.

Acceptance: the codec and real operations do not lose unknown content; invalid data does not lead to a writable empty scene. The old Canvas keeps opening.

### E4. `.canvas` in the new board: first vertical delivery

Dependencies: E2, E3 and the proven E1 prototype. Result: open, change and save a simple real map through Excalidraw.

- E4.1: text/file/link/group projection with the original coordinates, sizes, IDs and z-order.
- E4.2: edges projection with endpoints, sides, arrowheads, color and labels; a single undo boundary.
- E4.3: translate move/resize/create/delete/duplicate into changes of the source document; echo suppression does not swallow real edits.
- E4.4: a format-aware toolbar; an unsupported operation offers an explicit copy before the document is changed.
- E4.5: controlled handler routing under a flag and reopen from the real disk.

Acceptance: an imported fixture is changed in the new UI, saved as `.canvas`, and reopened with the data preserved. A test of only `toScene/fromScene` is insufficient. The old handler remains as a fallback for now.

### E5. Live notes, Markdown cards and attachments

Dependencies: E4; the provider can also be used by a native sketch. Result: one note remains one document on all surfaces.

- E5.1: a shared note provider/cache/subscriptions, missing/error/stale states and identity resolution.
- E5.2: a Markdown card with source text and a safe preview; the existing Source/Live Preview guard.
- E5.3: sidebar editing through the shared doc store and a lease, correct focus/undo/flush.
- E5.4: wiki/Markdown links, attachments, headings/blocks, bounded transclusions.
- E5.5: display modes and sizes; a preview update does not change geometry or source dirty without a command.
- E5.6: a test tab→card→another card, an external change and readonly ID cases.

Acceptance: changes to one note are visible in all its cards without remounting; two independent writable buffers do not work at the same time.

### E6. Convenient links and keyboard map creation

Dependencies: E4, the basic E5 cards. Result: a full main interaction cycle.

- E6.1: four ports, hover/focus states, endpoint binding and target preview.
- E6.2: drag-to-empty → choose/create a card → a link as a single action.
- E6.3: reconnecting both ends, labels, direction, color, straight/orthogonal routing.
- E6.4: multiedges, cycles/self-edges, deletion and restoration of linked elements.
- E6.5: Tab/Enter for managed branches, Escape/cancel, shortcuts inside the active surface.
- E6.6: real mouse/trackpad/keyboard checks at different zoom levels and in locked mode.

Acceptance: §9 works without touching the engine's internal DOM for domain actions; there are no dangling bindings after duplicate/delete/undo.

### E7. Note creation, DnD and safe renaming

Dependencies: E2, E5, E6. Result: the board is embedded in Amby's file model.

- E7.1: pointer drag from the tree, inserting an existing note, multi-selection where the tree supports it.
- E7.2: creating a Markdown file from the board and converting a text card while preserving links.
- E7.3: attachment import through the current storage, clipboard image, drop at the correct scene position.
- E7.4: complete reference rewrite for `.canvas` and `.excalidraw`, bundles, Unicode and subpaths.
- E7.5: coordination of dirty buffers/queues/history/recovery on rename, restore and external deletion.
- E7.6: separate tests for a partial result of a multi-file operation and for re-running it.

Acceptance: renaming a note/folder does not break cards; the source note is not duplicated when a card is copied; a creation failure does not destroy the original text.

### E8. Groups, auto-layout, search and navigation

Dependencies: E5–E7. Result: convenient daily work with medium-sized maps.

- E8.1: groups, labels, backgrounds, moving members, nested/overlap semantics.
- E8.2: align/distribute/snap, layout of the selected area, pinned nodes and a single undo checkpoint.
- E8.3: a managed mind-map root/branch and collapsing while preserving the source nodes.
- E8.4: search of titles and of the accessible content of cards, highlighting the result, fit selection, minimap.
- E8.5: saving viewport/view-state without a source write, navigating back to a place on the map.
- E8.6: adapt the existing templates/Mermaid where they were already provided; keep converter diagnostics and do not promise editable shapes for the SVG fallback.

Acceptance: operations work on a cyclic/disconnected fixture, pinned nodes do not jump, search results open the right object, hiding does not delete the source data.

### E9. Export, format limitations and external portability

Dependencies: E4–E8. Result: the user can transfer and show their work.

- E9.1: PNG/SVG whole/selection with the content of managed cards and predictable clipping.
- E9.2: explicit `.canvas → .excalidraw` copy and a preflight `.excalidraw → .canvas` export.
- E9.3: native fallback/round-trip in standalone Excalidraw, preservation of custom metadata.
- E9.4: reading after a `.canvas` change in Obsidian, unknown extension survival and recording the limitations.
- E9.5: an export failure/cancel does not change the source, does not overwrite the existing target and does not leave unclear partial files.

Acceptance: visual artifacts are checked by eye, the loss report is accurate, external checks are named with versions. A skipped external check cannot be replaced by the statement "the JSON is valid".

### E10. Performance, accessibility and UI quality

Dependencies: E5–E9. Result: measured quality for S/M/L and the supported platforms.

- E10.1: eliminate full stringify on view-only events, cache dedup and a viewport preview strategy.
- E10.2: measure main-thread, reads, serializer/parse/layout time, memory and cleanup after repeated opening.
- E10.3: keyboard/object-list accessibility, focus recovery, IME, reduced motion, dark/light and a narrow layout.
- E10.4: check all supported locale resources and theme boundaries.
- E10.5: security-negative fixtures for paths, URIs, SVG/HTML, large payloads and recursive embeds.

Acceptance: real measurements and deviations from the targets are published; no claims about native performance from the dev browser alone.

### E11. Overall regression and confirmation of the Canvas replacement

Dependencies: E1–E10. Result: a single evidence matrix over real user scenarios.

- E11.1: go through the automated and manual matrix §16 on the final code.
- E11.2: check the browser fallback and the packaged Tauri, window close, module disable, restart and vault change.
- E11.3: run `npm run verify`, `npm run build`, and the necessary Rust/native checks sequentially.
- E11.4: perform a separate review of data safety, handlers, history and imports; fix the regressions found and repeat the affected scenarios.
- E11.5: compile a parity list of the old Canvas: carried over, improved, known limitation. Do not hide missing commands.

Acceptance: no open P0/P1 data loss/substitution; the basic scenarios work. A temporary fallback to the old Canvas is explicitly marked if still required; in that case the full replacement is not declared.

### E12. Default switch, cleanup and handoff

Dependencies: E11. Result: the new editor is the main one for boards, old files are preserved.

- E12.1: perform a controlled switch of the `.canvas` handler and profile/module config, check explicit disabled preferences.
- E12.2: keep a documented reversible renderer rollback for the stabilization period without converting data back.
- E12.3: remove only provably dead UI/code, keep the shared codecs/tests; check dependencies and knip.
- E12.4: update the docs on formats, compatibility, shortcuts, recovery and the public changelog with the actually implemented behaviour.
- E12.5: a final gate/build on the final tree, a report on native/external checks, remaining limitations and the location of the evidence.

Acceptance: a fresh install and an upgrade of settings open both formats with the correct renderer, old bundles are not merged, disabling the module does not lose data. The application version does not change without a separate release command.

## 16. Acceptance matrix

Each row must have an automated regression where the logic can be automated, and manual evidence where the result depends on the real canvas/WebView. Do not mark all checks as passed with a single mocked component test.

| ID  | Scenario                                            | Expected result                                                           |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| A01 | Open and close both formats without edits           | Source bytes/hash/mtime do not change                                     |
| A02 | Pan, zoom, theme, select and preview scroll         | No document save and no new undo actions                                  |
| A03 | Invalid/truncated JSON and read error               | Diagnostics, the source is not replaced by an empty scene                 |
| A04 | Pass a `.canvas` into the sketch load path          | Typed mismatch, no silent coercion                                        |
| A05 | Top-level/node/edge/element unknown fields          | Preserved after a real edit/save/reopen                                   |
| A06 | Duplicate keys, future type, oversized integer      | Lossless handling or an explicit readonly, without loss                   |
| A07 | BOM/CRLF and Markdown in a JSON string              | Preserved per contract; no-op byte-exact                                  |
| A08 | JSON Canvas optional arrays/default endpoints       | Correct loading and unchanged defaults                                    |
| A09 | Z-order, overlapping groups, group backgrounds      | Representation and round-trip preserve the original meaning               |
| A10 | Import a map with text/file/link/group              | All objects are displayed with the correct type                           |
| A11 | Reopening after an edit in Obsidian                 | No loss of nodes/edges/links; limitations recorded                        |
| N01 | One note in a tab and three cards                   | One buffer, current content in all previews                               |
| N02 | Two attempts to edit one note                       | One writable owner and a clear transition to it                           |
| N03 | Markdown is not allowed in Live Preview             | Source, the original text stays byte-exact                                |
| N04 | Subpath heading/block, alias, missing anchor        | The correct fragment or an exact diagnostic                               |
| N05 | Wiki links, local images and transclusions          | Correct resolution context, no raw HTML execution                         |
| N06 | Note rename/move and folder/bundle promotion        | Cards stay linked, the old path is not recreated                          |
| N07 | Legacy ID, missing ID, duplicate ID                 | Shared identity policy, no hidden migration                               |
| N08 | Create a note on a name collision                   | A unique no-replace result, the foreign file is intact                    |
| N09 | Convert text card → note, then undo                 | Text/links restored; the note is not silently deleted                     |
| N10 | Board write error after creating a note             | Recoverable outcome, retry does not create a duplicate                    |
| N11 | External edit/deletion of a linked note             | Preview invalidation or an explicit conflict with the dirty editor        |
| N12 | Cyclic transclusions and long notes                 | Bounded loading, the interface stays manageable                           |
| C01 | Create, label, change the direction of a link       | Endpoints, label and arrows are preserved                                 |
| C02 | Drag-to-empty, confirm/cancel                       | One command or no changes                                                 |
| C03 | Reconnect both ends and Escape                      | A new binding or an exact return to the previous one                      |
| C04 | Move/resize endpoints at three zoom levels          | The arrow is bound to the correct side                                    |
| C05 | Parallel edges, cycle, self-edge                    | No silent deduplication or disappearance                                  |
| C06 | Delete/duplicate/paste/undo via the upstream UI     | Source and managed metadata stay consistent                               |
| C07 | Copy a connected fragment between boards            | New local IDs, correct internal bindings, note refs preserved             |
| C08 | Locked mode and an inactive hidden layer            | Change/drag/drop commands do not bypass the lock                          |
| L01 | Move a group with selected members                  | Geometry and links move consistently                                      |
| L02 | Layout selection with pinned nodes and a cycle      | Deterministic result, pinned stay still, undo is complete                 |
| L03 | Collapse/expand a branch with a shared child        | Source is not lost, the shared node's behaviour is defined                |
| L04 | Search, fit selection, reopen viewport              | Navigation to the right object without source mutation                    |
| D01 | Failure of history/temp write/publication           | The source is intact, success is not declared                             |
| D02 | External write between load and save                | Typed conflict within the documented limits, recovery available           |
| D03 | Save response N after edit N+1                      | The new dirty state and the draft are not cleared                         |
| D04 | Crash before/after publication                      | Recovery distinguishes the original/saved/new state                       |
| D05 | Dirty external delete and window close              | The buffer is not lost and does not create a file without a chosen action |
| D06 | Vault switch during load/save/preview               | No data leak/write into another vault                                     |
| D07 | Rename during a pending autosave                    | The single correct path and recovery key                                  |
| D08 | Module disable on a failed flush                    | Edits remain available; disabling is correctly aborted                    |
| X01 | PNG/SVG with note cards, labels and assets          | Content is visible and corresponds to the checkpoint                      |
| X02 | Export cancel/target collision/error                | Source and the existing target are unchanged                              |
| X03 | Native → Canvas with unrepresentable strokes        | A preliminary loss report, no silent deletion                             |
| X04 | Canvas → native copy                                | Source untouched, the new copy opens                                      |
| X05 | Standalone Excalidraw round-trip                    | Working shapes, verified metadata/fallback preservation                   |
| S01 | Traversal/symlink/malformed URI                     | Backend guard and a safe diagnostic                                       |
| S02 | Script/HTML/SVG/remote embed payload                | No execution/background arbitrary access                                  |
| P01 | S/M/L and reopening 20 times                        | Measurements, no unexplained growth of listeners/cache                    |
| P02 | Many cards of one file                              | Read dedup, local updates without a full tree refresh                     |
| U01 | Keyboard, IME, focus, screen reader list            | Accessible control without shortcut conflicts                             |
| U02 | Themes, languages, narrow panel, platform modifiers | Readable UI and correct labels/commands                                   |
| M01 | Both `.canvas`/`.excalidraw` layers in one bundle   | Both separate documents are available, data is not mixed                  |
| M02 | Upgrade profiles/disabled modules/rollback          | An idempotent transition preserving the user's choice                     |

### 16.1. Mandatory end-to-end user run

1. Open a synthetic vault with a map from Obsidian and a native drawing.
2. Open the `.canvas`; check the number/types of objects, position, labels and groups.
3. Drag an existing note, open it in the side panel, change the text, see the updated card.
4. From a card port, pull a link into an empty space, create a new card and label the link.
5. Turn the new text card into a note, then rename the note and the folder.
6. Move/resize cards, group them, align them, run a selection layout with a pinned node.
7. Undo and redo actions several times; check the note text separately from the board history.
8. Change the map with an external process while there are local unsaved edits; resolve the conflict without losing either version.
9. Close the window, restart, restore a test crash draft and make sure the viewport is correct.
10. Export PNG/SVG, visually check the cards and labels.
11. Open the saved `.canvas` in Obsidian and again in Amby.
12. Create a native copy, draw an arbitrary shape, check the standalone round-trip and the explicit limitation of the reverse Canvas export.
13. Disable and enable the module; both source files stay available and intact.

## 17. Checks and work artifacts

### 17.1. Automated checks

For each batch — focused tests on the affected logic and `npm run build`. Before handing a stage over for review — `npm run verify` according to the current `package.json`. In the repository `verify` includes more checks than the old short description in AGENTS: do not replace it with an arbitrary reduced set.

```sh
npm run verify
npm run build
```

After Rust/IPC changes, run the Rust tests and check the generated bindings; backend-heavy work requires strict Clippy. If a full `verify` has already run these commands on an unchanged tree, record the result and do not repeat without a reason.

```sh
npm run rust:test
npm run rust:clippy
npm run rust:fmt
npm run bindings:check
```

Format touched frontend/docs with Prettier, Rust with Rustfmt. New fixtures and tests must check user-visible properties and failure boundaries, not repeat the implementation literally.

Vitest supports the existing happy-dom tests, but canvas mocks do not confirm real binding/focus/export. Supplement with real browser interaction scenarios and the packaged WebView. If necessary, extend the existing harness; do not treat the absence of the original browser component infrastructure as a reason to leave an interaction unverified.

### 17.2. Native checks

Changes to storage, IPC, watcher, dialogs, shortcuts and window lifecycle are checked in `npm run tauri dev`; the browser `npm run dev` checks only the web fallback. After IPC/config/permissions/packaging changes a corresponding native build is needed.

Choose a debug bundle supported by the local platform without signing/publishing, and document the exact command. Do not run different Cargo feature builds in parallel in a shared target: in earlier work this already caused unrepresentative rustdoc/artifact errors.

Check macOS, Windows and Linux according to the availability of real environments. Mark a missing platform as "not verified" with a list of its scenarios. Do not change the CSP/scopes for the sake of a passing test and do not declare production packaging verified from a browser preview.

### 17.3. Documentation to update during implementation

- `docs/vault-format.md`: durable board metadata, refs, revision/recovery, import/export boundaries.
- `docs/markdown-compatibility.md`: only actual changes to the shared Markdown rules, if there were any.
- New `docs/board-format.md` or equivalent: extension versions, ownership IDs, mapping and compatibility.
- New `docs/board-compatibility.md` or equivalent: JSON Canvas/external Excalidraw matrix, supported/partial/readonly cases.
- `docs/engineering.md`: actual new testing commands/fixtures, if any appeared.
- `docs/claude-handoff.md`: the stages reached, the actual checks and what remains.
- `updates/upd_next.md`: only completed user results and exact developer outcomes; do not advertise the whole plan as an already-done feature.

### 17.4. Evidence and the stage report

Locally keep versioned synthetic fixtures, original/final hashes, round-trip results, test logs, native commands, screenshots/recordings and performance measurements. Do not commit the user's vault, recovery payloads, secrets, bundles and machine paths.

Each stage's report contains: the completed task IDs, the affected contracts, command results with exit status, manual scenarios and the environment, known limitations, remaining blockers. The phrase "tests passed" without naming the set does not close the stage.

A new regression blocks handing over the stage. Do not fix an existing unrelated failure by silently expanding scope and do not weaken a test to get green; record the original and current state, continue independent work and explicitly state which gate is not closed. Commit/push are permissible only on separate instruction and per the AGENTS rules.

## 18. Decisions to avoid

- Registering `.canvas` in the sketch manifest without a two-way adapter.
- Automatically renaming `.canvas` to `.excalidraw` or writing Excalidraw JSON under the `.canvas` extension.
- Fully reconstructing a document only from visible scene elements without an opaque source.
- Simultaneous independent editing of the source model and the scene model with mutual useEffect synchronizations.
- Writing a note directly from a card via a new `writeFile` autosave, bypassing the shared note lifecycle.
- Stable links only by title or only by a temporary SQLite ID.
- A hidden YAML migration just to insert a note onto a map.
- DOM selectors on upstream test IDs as the main API for domain operations.
- A CSS override that hides an error or a missing tool instead of implementing the behaviour.
- Uncontrolled file deletion on undoing a card creation.
- Declaring a picture with a map snapshot a full editable Canvas export.
- Automatically turning arrows into Markdown links/database relations.
- Removing the old Canvas before verifying feature parity and the integrity of imported files.
- Releasing/bumping the version as part of an ordinary development stage.

## 19. Sources and currency check

The primary source about the current program is the listed working-tree files, including uncommitted changes. External documentation was checked on 30 September 2026; before using an API, compare it with the installed library version.

- [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) — the structure of portable maps and the default values.
- [Excalidraw props](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/) — `customData`, custom embeds, link/paste/library callbacks.
- [Excalidraw imperative API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api) — scene updates, capture policy, scrolling and the other public actions.
- [Obsidian Canvas](https://help.obsidian.md/plugins/canvas) — help for the user-facing tool; check actual compatibility on fixtures in an available version of the application.

The plan does not assume that the online docs exactly match package 0.18.1. In case of a conflict, first check the local types/runtime and record a reproduction.

## 20. Ready-made prompt for Claude Code

```text
Read AGENTS.md and docs/excalidraw-canvas-claude-plan.md in full.
Implement the described unified Amby board on top of Excalidraw in stages E0–E12:
compatible opening/editing of .canvas, live note cards,
convenient links, groups and layout, reliable saving and verified export.

Keep the entire current uncommitted diff and re-verify findings F01–F12
against the current code. First the baseline, P0 and a real interaction prototype;
do not connect .canvas directly to the sketch parser and do not remove the old Canvas
before the overall acceptance. Use the existing storage, doc store,
autosave/recovery, Markdown policy and module lifecycle.

This is the implementation of the boards plan specifically. Read the old handoff plans as context
for shared constraints and dependencies, but do not restart unrelated projects.
If a required shared mechanism is already being changed, reuse the agreed
contract, do not create a parallel one.

Follow the compatibility matrix, the Source/Live Preview rules and the integrity of
user data. Create new files no-replace; do not migrate
frontmatter and do not convert source .canvas files automatically.

After each batch update updates/upd_next.md, format the touched files,
run focused tests and npm run build. Before a stage review run the full
npm run verify; for Rust/IPC and desktop changes add the necessary
Rust, bindings and native checks. Check the real renderer and Tauri,
not only mocked components. Record limitations and tests not run.

Continue sequentially until the intended scope is complete;
do not present a prototype or the first .canvas import as the whole plan being done.
Make routine decisions yourself per the contract. On a proven
public API blocker, document the options and continue independent work;
do not hide reduced capabilities and do not bypass data protection.

Do not commit, push, tag, publish or bump the version without a separate
instruction. Result: a working editor, regression fixtures/tests,
updated contracts and an E0–E12 report with actual results.
```
