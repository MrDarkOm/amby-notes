# Frontend and UX runtime of Amby databases

Status: proposed contract
Document version: 1
Date: 2026-09-04

This document continues the
[architecture](database-system.md),
[user flows](database-user-flows.md),
[durable format](database-format.md) and
[runtime contract](database-runtime.md). It fixes state ownership,
component boundaries and the behavior of Table, Board, List, Gallery, side peek and linked
views.

## 1. The main interface principle

Table, Board, List and Gallery are four representations of one query model, not
four independent data editors.

```text
DatabasePort
     │
     ▼
database controller ──► useDatabaseStore
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
          view chrome      row layouts    inspector / peek
               │              │              │
               └──────── shared typed value controls ───────┘
```

Components:

- do not call Tauri commands directly;
- do not keep their own copy of server rows;
- identify rows by `noteId`, fields by `FieldRef`, views by `viewId`;
- get I/O only through `DatabasePort` and controller actions;
- use the existing theme tokens, `IconValue` and the localization registry;
- reuse the regular document buffer/autosave for the page text.

## 2. Integration with the current workspace

### 2.1 Tabs

`database` is added to `TabKind`. For compatibility with the current model:

- `tab.fileId` holds `databaseId`;
- the selected `viewId` is kept in session state by `tab.key`;
- switching between views of one database is not added to the Back/Forward history;
- switching to another database uses the regular tab history;
- "Open in new tab" (`Открыть в новой вкладке`) can open the same database with a different view;
- the tab title is taken from the database header, not from the directory name.

A standalone database opens as a database tab. An attached database can
be rendered by the same `DatabaseWorkspace` inside the existing layer of the document's
place. Both variants use one store/controller and differ only in
`host`.

```ts
type DatabaseHost =
  | { kind: "tab"; tabKey: string }
  | { kind: "layer"; noteId: string }
  | { kind: "linkedBlock"; noteId: string; blockId: string }
```

`workspace-orchestration.tsx` selects only the host component. Loading,
editing and dialogs are not moved into `workspace.tsx`.

### 2.2 Split and focus mode

In the first version a database tab occupies the primary pane and uses side peek for
rows. Opening a database tab while a document split is active applies the existing
policy of closing the secondary pane. Two full database panes in a split are a
separate extension after measuring memory and scroll performance.

In focus mode the database view stays available. Activity panels become
overlays as they do now; side peek also becomes an overlay and does not shrink the view to
an unusable width.

### 2.3 Databases panel

`ComingSoonPanel` is replaced with `DatabasesPanel`, which shows:

- attached and standalone databases;
- favorite databases and views;
- saved views inside each database;
- the broken/read-only/recovery state;
- commands to create, attach, open and show in Files.

The panel gets its data through `useDatabaseStore` selectors, not by extending the
generic `PanelRenderProps` with dozens of callbacks. `PanelRenderProps` passes
only a navigation adapter where it is actually needed.

Dragging a view into the editor uses the internal MIME type
`application/x-amby-database-view` with `databaseId` and `viewId`. No path or raw JSON is
passed in the drag payload.

## 3. Proposed file structure

```text
src/components/workspace/database/
├── database-workspace.tsx
├── database-controller.ts
├── database-selectors.ts
├── use-database-store.ts
├── use-database-lifecycle.ts
├── database-session-state.ts
├── database-tab-view.tsx
├── database-layer-view.tsx
├── database-header.tsx
├── database-view-tabs.tsx
├── database-toolbar.tsx
├── database-status-banner.tsx
├── query/
│   ├── query-key.ts
│   ├── query-cache.ts
│   ├── filter-editor.tsx
│   ├── sort-editor.tsx
│   └── group-editor.tsx
├── layouts/
│   ├── table-view.tsx
│   ├── board-view.tsx
│   ├── list-view.tsx
│   └── gallery-view.tsx
├── cells/
│   ├── database-cell.tsx
│   ├── cell-editor-layer.tsx
│   ├── text-cell.tsx
│   ├── number-cell.tsx
│   ├── checkbox-cell.tsx
│   ├── date-cell.tsx
│   ├── option-cell.tsx
│   ├── url-cell.tsx
│   ├── files-cell.tsx
│   └── relation-cell.tsx
├── editing/
│   ├── database-edit-queue.ts
│   ├── cell-selection.ts
│   ├── clipboard.ts
│   └── validation.ts
├── peek/
│   ├── database-side-peek.tsx
│   └── editor-surface-lease.ts
├── properties/
│   ├── property-list.tsx
│   ├── property-value-control.tsx
│   └── database-property-definition-dialog.tsx
└── dialogs/
    ├── database-operation-preview.tsx
    ├── database-conflict-dialog.tsx
    ├── database-recovery-dialog.tsx
    └── csv-import-dialog.tsx

src/components/workspace/panels/databases-panel.tsx
src/components/workspace/tiptap/database-block-view.tsx
```

Pure state/query/clipboard code does not import React and is covered by Node Vitest.
Reusable visual primitives stay in `components/ui`; database semantics are not
moved into UI primitives.

## 4. State ownership

### 4.1 Server and cache state

A single `useDatabaseStore` contains:

```ts
interface DatabaseState {
  module: DatabaseModuleState
  vaultGeneration: number | null
  projection: ProjectionVersion | null

  databasesById: Record<string, DatabaseHeader>
  schemasByDatabaseId: Record<string, DatabaseSchemaResource>
  viewsById: Record<string, DatabaseViewResource>
  templatesById: Record<string, DatabaseTemplateResource>

  queryEntries: Record<QueryKey, DatabaseQueryEntry>
  sessionsByHost: Record<DatabaseHostKey, DatabaseViewSession>
  pendingByOperationId: Record<string, PendingDatabaseOperation>
  conflictsByKey: Record<string, DatabaseConflict>
  diagnosticsById: Record<string, DatabaseDiagnostic>
}
```

The store is not persisted as a whole in app settings. Durable views live in database
files, and the runtime cache is cleared when the vault changes. Only safe local
preferences are persisted from session state: the last view for a host, quick search
if needed, and the sizes of temporary panels.

`databasesById` and the resource maps are updated only by the controller. Layout components
get narrow selectors so that typing in one cell does not redraw the whole table.

### 4.2 Session state of one host

```ts
interface DatabaseViewSession {
  host: DatabaseHost
  databaseId: string
  viewId: string | null
  quickSearch: string
  transientOverrides: DatabaseQueryOverrides
  selection: CellSelection | RowSelection
  editingCell: CellAddress | null
  expandedGroups: Set<string>
  collapsedRowIds: Set<string>
  scrollAnchor: ScrollAnchor | null
  peek: PeekState
}
```

A linked block gets an independent session: its filter/layout overrides do not
change the source view. Two tabs of the same database also have separate selection, scroll and
peek state, but share the query cache when the query key matches.

### 4.3 Document state

The Markdown body of a row is not stored in the database store. Side peek calls the regular
`readNote`, puts the result into `useDocStore` and uses the shared autosave
coordinator. Therefore editing a page from a database and from Files has the same
conflict, recovery and byte-preservation guarantees.

Database properties are not added to `Document.noteProperties` as string
`CustomProperty` values. The inspector merges the two typed sources at the level of the
presentation model.

## 5. Lifecycle state machine

```text
disabled
   │ enable
   ▼
enabling ── validation/rebuild ──► ready
   │ error                         │ index warning
   ▼                               ▼
failed                         degraded
                                   │ rebuild needed
                                   ▼
                            rebuildRequired

ready/degraded ── unfinished journal ──► recoveryRequired
ready/degraded ── disable + flush ─────► disabled
```

Semantics:

- `enabling`: database entry points are visible but disabled, with progress;
- `ready`: reading and permitted mutations are available;
- `degraded`: the last whole projection is readable, part of the data is read-only;
- `rebuildRequired`: confirmed optimistic values are visible, new queries are
  blocked or explicitly marked stale until the rebuild;
- `recoveryRequired`: reading the last safe projection is allowed, new
  conflicting mutations are blocked;
- `failed`: regular notes keep working.

`onDeactivate` calls `flushAll` first. If the flush fails, the toggle
stays on and shows an error; data is not abandoned for the sake of a UI change.

## 6. Query entry state machine

```ts
type QueryStatus = "idle" | "loading" | "ready" | "refreshing" | "loadingMore" | "stale" | "error"
```

Rules:

- the first load shows a skeleton of the current layout;
- `refreshing` keeps the previous rows and does not reset scroll;
- a new filter/sort change cancels the old in-flight request;
- `staleCursor` clears only the query pages and re-requests the first one;
- an event with a new `{ epoch, seq }` marks the affected entries `stale`;
- an invisible host is not updated immediately, but the invalidation is kept;
- infinite loading starts before the last visible row is reached;
- an error on the next page does not hide the data already loaded.

The query key is computed from:

```text
vaultGeneration + databaseId + base view revision + normalized overrides + field set
```

Scroll position, selection and open popovers are not part of the query key.

## 7. View chrome

The common shell of all layouts:

```text
DatabaseWorkspace
├── DatabaseHeader
│   ├── icon + title
│   ├── lock / favorite / more
│   └── create row
├── DatabaseViewTabs
├── DatabaseToolbar
│   ├── quick search
│   ├── filter
│   ├── sort
│   ├── group
│   ├── properties
│   └── layout options
├── DatabaseStatusBanner
├── active layout
└── DatabaseSidePeek
```

View tabs switch without fully reloading the database header/schema. Creating,
renaming, duplicating and deleting a view go through view mutation CAS.

Quick search is temporary. Filter, sort, group, visible fields, density and layout
options change the saved view with a debounce and a mandatory flush when the host closes.
If the view revision changed externally, the UI offers to:

- load the external version;
- save the local configuration as a new view;
- compare the changes if both changed different fields.

There is no automatic last-write-wins.

## 8. Common row model

All layouts receive:

```ts
interface DatabaseRowModel {
  databaseId: string
  noteId: string
  title: string
  icon: string | null
  pathLabel: string
  parentNoteId: string | null
  depth: number
  breadcrumb: DatabaseBreadcrumbItem[]
  values: Record<PropertyId, PropertyValue | null>
  systemValues: DatabaseSystemValues
  revision: string
  pendingFields: Set<FieldKey>
  conflicts: Record<FieldKey, DatabaseConflict>
}
```

A layout can request a reduced field set. Adding a new visible column
reloads the query with an extended field set; it does not perform N per-row queries.

System Title is always the first/frozen column in Table and the main interactive element in
the other layouts. Clicking Title opens the page; clicking a value edits the
property.

## 9. Table

### 9.1 Rendering

Table is implemented as an ARIA grid on `div`, not as a huge DOM `<table>`:

- vertical row virtualization via `@tanstack/react-virtual`;
- horizontal virtualization of unpinned columns;
- a separate sticky layer for frozen columns;
- a fixed height estimate per density;
- group headers and the aggregate footer have their own virtual item kind;
- overscan is small and is tuned only by benchmark.

A DOM cell gets a stable key `{noteId}:{fieldKey}`, but the editor draft lives
in the store/editor layer and is not lost when the virtual row unmounts.

### 9.2 Selection

```ts
interface CellSelection {
  anchor: CellAddress
  focus: CellAddress
  mode: "cell" | "range"
}

interface CellAddress {
  noteId: string
  field: FieldRef
}
```

Selection stores IDs, not just indexes. The current query result builds a
temporary ID → position map. After filter/sort/invalidation:

- if both boundaries exist, the range is recomputed;
- if only one remains, the selection collapses to it;
- if the rows disappeared, the selection is cleared;
- a pending edit is never applied to a new row by the old index.

### 9.3 Keyboard contract

| Key                             | Action                                              |
| ------------------------------- | --------------------------------------------------- |
| Arrow keys                      | move the active cell                                |
| Shift + Arrow                   | extend the range                                    |
| Enter                           | open the editor / commit and go down                |
| Shift + Enter                   | commit and go up                                    |
| Tab / Shift + Tab               | commit and go right/left                            |
| Escape                          | cancel the draft or clear the range                 |
| Space on Checkbox               | toggle the value                                    |
| Cmd/Ctrl + C                    | copy TSV                                            |
| Cmd/Ctrl + V                    | preflight multi-cell paste                          |
| Delete/Backspace outside editor | preview clearing the selected values                |
| Cmd/Ctrl + Z                    | database undo, if the cell editor does not own undo |

Browser/native clipboard errors are shown unobtrusively and do not change the selection.

### 9.4 Resize, reorder, freeze

- During resize the width is local and is updated through pointer capture.
- It is written to the durable view once, on pointer up.
- Reorder works by stable field refs.
- Title cannot be hidden, moved from the first position or unfrozen.
- Additional frozen columns form a contiguous prefix; gaps are forbidden.
- An enabled sort blocks manual row drag, but does not erase the manual order.

### 9.5 Row grip and manual order

- A Table and List row has a grip on the left (a button, visible on hover/focus); Gallery cards
  are dragged as a whole (except for interactive elements inside).
- In Table and List, drag "lifts" the row: it follows the cursor vertically (`database-row-lifted`),
  the others shift by its height (`row-drag-layout.ts`, motion); the target is determined by geometry
  (Table) or by the slots captured at pickup (List, Gallery), not by the moving rows. When
  a sort is active, drag does not start, and `onBlockedDrag` offers to reset the sort.
- Drag uses pointer events: a 5px threshold, a marker on the side of the row under the cursor, auto-scroll at
  the edges, Escape cancels. Pressing the grip without movement opens the row menu; the up/down
  arrows on the grip move the row by one place.
- Drop writes `manualOrder` of the form (`row-order.ts`): visible rows that are not yet placed
  enter the list after the placed ones, entries for rows that are not loaded are kept. The query
  receives `manualOrder` only while the view has no sorts; the backend puts the listed IDs first
  in list order, the rest by title. The order is part of the cursor hash.
- The grip (Table, List) and the selection checkbox (Table only) hang in the left margin beyond the table surface:
  in Table this is a column outside the scroll area, synchronized with its scrolling; in List the scroll area
  is shifted to the left. The left padding of the database column leaves room for them. The `amby-db` block in a note
  does not show the grip (the margin is taken by the editor's block handles). In a drag the Gallery
  is drawn as a regular grid: the dragged card is replaced by a drop zone, the others shift (`layout`);
  the cursor is checked against the slots captured at pickup, so the shift does not make the target oscillate.
- The row menu (grip or right click): icon and title in place, favorite, properties (the same editors as in peek),
  "Open" (as in the view, new tab, new window), copy link (`[[name]]`),
  duplicate (`duplicate_database_row`: a new page next to it, with its own `amby-id`/`amby-title`),
  "Move to…" (moving the file into the folder of another database through the tree) and delete (as in the tree).
  A locked database offers no changing actions and does not allow dragging.

## 10. Cell editing

### 10.1 The common control contract

```ts
interface PropertyValueControlProps<T extends PropertyValue> {
  definition: PropertyDefinition
  value: T | null
  draft: T | null
  state: CellEditState
  readOnly: boolean
  onDraftChange(value: T | null): void
  onCommit(): void
  onCancel(): void
}
```

A control knows nothing about the note path, SQLite, IPC or the optimistic cache.
`CellEditorLayer` positions the popover through a portal, so the virtualizer and
`overflow: hidden` do not clip the Date/Select/Relation/Files editors.

### 10.2 Cell state

```text
idle ── edit ──► editing ── commit ──► validating
 ▲                 │ escape                │ valid
 │                 └───────────────────────┤
 │                                         ▼
 └──── success ◄──── saving ◄──────── optimistic
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
             error              conflict
```

- Text commit: blur, Enter or a debounce with a flush.
- Number keeps a string draft and is parsed only on commit.
- Checkbox usually performs an immediate commit.
- Select/Status commits by choosing an option.
- Multi-select keeps the popover open and commits a batch on close.
- Date saves date-only or date-time strictly according to the definition.
- URL is not opened by the same click that edits it; open is a separate
  safe command.
- The Relation picker searches the target database through paginated backend search.
- Files are first imported into the row bundle, then the value mutation references the
  confirmed asset.

### 10.3 The queue

`DatabaseEditQueue` serializes the mutations of one resource:

- the cell key is `{databaseId}:{noteId}:{propertyId}`;
- Title uses a separate filesystem-operation key;
- a new value can coalesce a Text draft that has not been sent yet;
- an in-flight mutation is not cancelled after a durable write;
- a batch has one operation ID and is not split by the frontend into unrelated
  single writes;
- flush is triggered on view/tab/vault change, peek close, module disable and the
  `beforeunload` desktop window lifecycle.

## 11. Paste and bulk editing

The clipboard parser is a pure function:

1. Reads TSV preserving empty cells and rows.
2. Projects the rectangle onto visible editable fields.
3. Converts each row by property type.
4. Collects all errors without writing.
5. Shows a preview for a destructive/large batch.
6. Sends a single `apply_database_value_batch`.

Relation and Files values and unknown Select options are not created implicitly on
paste. The UI offers an explicit mapping/creation of options only through a separate
preview. Partial success is forbidden.

Row selection exists separately from the cell range and is used for move,
relation, delete-to-Trash and a batch property action.

## 12. Board

Board gets the same filtered rows, grouped only by Status or
a single Select.

- a column has an option ID, including a separate `empty` lane;
- dragging a card between lanes sends a single value mutation;
- the optimistic card moves immediately and is marked pending;
- an error returns the card to its original lane without losing scroll;
- card order inside a lane follows the active sorts or the manual view order;
- Relation/Multi-select are not used as the group field in v1;
- the lane footer shows a count;
- card properties are chosen from the view fields;
- Title opens side peek, the drag handle does not open the page.

Lanes are virtualized horizontally, cards inside a long lane vertically.
Only the visible lanes with a small overscan are mounted at a time.

## 13. List

List is the most compact read/edit layout:

- Title, icon, breadcrumb and the selected secondary fields;
- nested mode shows a disclosure control and indentation;
- flat mode shows a breadcrumb instead of indentation;
- inline edit is allowed for simple secondary fields;
- complex Relation/Files open the shared editor popover;
- the whole row opens side peek, except for interactive controls;
- virtualization is vertical with a single fixed height per density.

## 14. Gallery

Gallery uses a responsive CSS grid and vertical virtualization of rows, not a
separate virtualization of each card.

Preview order:

1. the explicitly chosen Files & media property;
2. the first image of the note;
3. `IconValue`;
4. a neutral placeholder.

Only visible images get an asset URL. Preview uses lazy loading,
a limited decode size and does not load remote resources. A card shows a
configurable list of fields; Title opens side peek. Empty/broken media gives a
diagnostic placeholder but does not break the whole grid.

## 15. Sub-items

Nested and flat layouts use one projection:

- collapsed IDs belong to the session, not to the durable view;
- a filter match of a child without its parent shows the child and a breadcrumb;
- expanding a parent does not load the whole tree in advance;
- dragging a row/card onto another row calls a membership operation preview;
- a cycle, a move into its own descendant and an intersection with a nested database
  are rejected by the backend;
- deleting a parent always opens a choice of `with children` or `promote
children` if sub-items exist.

Manual order is stored by note IDs and applied among siblings in nested mode.

## 16. Side peek and the row page

### 16.1 Geometry

On a wide window side peek takes the right part of the main content with resize within
roughly 420–760 px. Below the adaptive threshold it becomes an overlay
over almost the whole content. The global activity bar and sidebar are not duplicated inside.

```text
┌──────── database view ────────┬──────── side peek ────────┐
│ rows/cards                    │ title + page actions      │
│                               │ Markdown body             │
│                               │                           │
└───────────────────────────────┴───────────────────────────┘
                                             right Info panel
                                             inspects peek row
```

Side peek uses the existing `DocumentEditor` in compact chrome mode, not a
new Markdown editor. Its header adds:

- close;
- previous/next row of the current query;
- open as a full page;
- show in Files;
- move/delete via preview.

### 16.2 Inspector target

The right Info panel gets a discriminated target:

```ts
type InspectorTarget =
  | { kind: "activeTab"; tabKey: string }
  | { kind: "databaseRow"; hostKey: string; databaseId: string; noteId: string }
```

While a peek is open the database row takes priority. After it closes the target returns
to the active tab. The property list has two clearly separated blocks:

1. database properties in schema order and with `pageVisibility`;
2. local note properties.

Both use the shared `PropertyValueControl`, but only a database property changes
`.ambd/records`; a local property continues through the existing property-store path.

### 16.3 Shared document buffer

Opening a peek:

1. selects the row without changing the active workspace tab;
2. reuses the loaded `useDocStore` buffer or reads the note;
3. opens the regular autosave lifecycle;
4. changes the inspector target after a successful load;
5. restores focus to the original cell after closing.

If the same note is already being edited in another surface of the same window,
`EditorSurfaceLease` guarantees a single writable owner. Before the lease is handed over
the current surface is flushed; the others show the live content read-only.
This keeps two Tiptap instances from independently saving one buffer.

Escape closes the peek only after the active cell/editor popover finishes.
If the flush fails it stays open and shows a recovery choice.

"Open as a full page" (`Открыть полной страницей`) opens a regular document tab, keeps the origin
`{databaseId, viewId, noteId}` for the return command and closes the peek after
the editor lease is successfully handed over.

## 17. Linked views in Markdown

A new reference block stores the JSON from the format contract directly in the `amby-db` fence:

```amby-db
{"version":2,"views":[{"id":"v1","databaseId":"01...","title":"","layout":"table","config":{}}]}
```

A version 2 block is a "shortcut" to a database: several tabs, each with its own database, its own name and icon,
layout and a private copy of the view settings (`config` in the view-document format: filter, sorts,
fields, layoutConfig, group). The name and icon belong to the shortcut, not to the database; the tab tooltip
names the database. The block does not write the database's saved views; choosing a saved view copies its
settings. The first format (`databaseId` + `viewId`) opens as a shortcut with one tab and is
rewritten to version 2 only when the block is edited.

`DatabaseBlockView`:

- parses the reference through a typed parser;
- uses the host `{ kind: "linkedBlock" }`;
- shows source data and local overrides;
- limits the height, but allows opening the view in a database tab;
- does not store or save its own rows;
- on a missing source shows a diagnostic placeholder;
- when the module is disabled leaves the portable fence unchanged;
- shows an unknown version read-only and serializes it byte-exact.

The current prototype `.amby/blocks/<block-id>.json` is not automatically turned into a
new reference. It opens as a legacy read-only block with an explicit migration
command: create a real database, materialize rows as Markdown notes,
show a preview and replace the fence only after success.

Changing linked-block overrides goes through a change of Markdown node attributes and
the regular lossless editor serialization. It does not write the source view shard.

## 18. Schema and property dialogs

The current `PropertyEditor` cannot be extended with string `value/settings`. It is
split into:

- `PropertyValueControl` — edits one typed value;
- `DatabasePropertyDefinitionDialog` — type/config/options/YAML binding;
- `LocalPropertyDefinitionDialog` — the current local schema;
- a shared `PropertyIconPicker` on `IconValue`/`EmojiPickerPanel`.

Changing a property type always shows a preflight:

- the number of affected non-empty values;
- valid/invalid conversions;
- relations/options/YAML effects;
- backup/recovery behavior.

Renaming a property does not change the property ID or the YAML key. Deleting a property/option
that is in use is not performed from a popover with one click: a preview and Trash are required.

## 19. Relation picker

The Relation editor consists of paginated search, selected chips and a command to open the
target.

- the target database is determined by the definition, not by user text;
- search runs over Title and the selected display fields;
- already selected IDs are not duplicated;
- a single relation closes the picker after selection;
- an inverse relation is shown as computed and does not send a separate write;
- a missing/outsideDatabase target is kept as a chip with a diagnostic state;
- creating a new target row from the picker uses the target database's template;
- circular relations are allowed as data, but the UI does not expand them recursively.

## 20. View autosave

View settings have a queue separate from cell values:

- fast pointer/typing updates change the local draft;
- a debounce saves a semantic patch with the expected view revision;
- closing a popover/host performs a flush;
- a new external revision is not overwritten;
- the layout query is restarted only if the patch affects the data set/order;
- resize/card field visibility can update the layout without a query;
- a failure of one view autosave does not block editing of row values.

Creating a temporary filter while the popover is open can be cancelled with Escape. After
confirmation it becomes part of the saved view automatically.

## 21. Errors, stale state and recovery

Display levels:

| Event                  | UI                                                   |
| ---------------------- | ---------------------------------------------------- |
| Cell validation        | inline at the cell, the draft is kept                |
| Revision/YAML conflict | cell marker + conflict dialog                        |
| Query page error       | inline retry after the last rows                     |
| View revision conflict | banner/popover, data keeps being readable            |
| Broken shard           | row/property diagnostic, read-only scope             |
| Rebuild required       | common database banner with a rebuild action         |
| Recovery required      | modal before conflicting mutations                   |
| Module failure         | Databases panel; the regular workspace keeps working |

A toast is not used as the only place for an error: a disappearing toast must not
be the only way to learn that a value was not saved.

An optimistic value with a confirmed durable write and a broken index stays
visually successful with a warning. The UI does not offer to retry this mutation.

## 22. Accessibility

- Table has `role="grid"`, row/column counts and an active descendant.
- In the normal state there is one tab stop per grid; arrows move the active cell.
- The editor popover moves focus inside and returns it to the cell on close.
- Board drag has a keyboard alternative through the menu `Переместить в статус` (Move to status).
- The color of Select/Status is never the only carrier of meaning.
- Pending, error, conflict and read-only have an icon/text state.
- Gallery/List cards have distinguishable accessible names.
- Resize handles are available from the keyboard and announce the current width.
- Reduced motion disables animated card moves and the peek transition.

All interface strings are added as one dotted key to all languages of
`src/locales/resources.ts`; dynamic property names are not translated.

## 23. Themes and the Amby visual style

The mechanics take their basis from Notion, but visually it stays Amby:

- the existing `background`, `card`, `border`, `accent`, `muted`,
  `ring` tokens are used;
- density inherits the global setting, a view can override it;
- layout CSS lives in theme-owned static definitions when it is a visual token;
- a database component does not embed theme palettes;
- encoded icons are rendered only through `IconValue`;
- side peek and popovers use the existing Radix primitives and z-index
  conventions.

The Notion interface must not be copied pixel for pixel, nor a second set of
grays introduced. Interaction patterns and information density are adopted.

## 24. Module boundary

`ModulePermission` is extended with narrow capabilities:

```ts
type DatabaseModulePermission = "read-databases" | "write-databases"
```

The Databases module declares a UI panel, read/write notes for row pages and
read/write database capabilities. The backend still checks that the module is active;
the frontend manifest by itself is not a security boundary.

On disable:

- the panel, database tabs/layer controls and insert commands are hidden;
- an open database host is flushed first, then turns into a regular
  folder/note context or is closed by the existing tab policy;
- linked blocks become inert placeholders, the fence is kept;
- `useDatabaseStore` clears caches and editor drafts;
- clean peek document buffers can be evicted by the regular doc lifecycle;
- local note properties keep working.

## 25. Test strategy

### Pure Vitest

- query key normalization;
- event invalidation by epoch/seq;
- cell/row selection after sort/filter/delete;
- TSV parse and typed conversion;
- optimistic queue coalescing, ordering, retry and flush;
- view autosave revision conflict;
- module/query/cell state transitions;
- linked block version parser and byte preservation;
- gallery preview choice;
- inspector target priority;
- editor surface lease.

### Component tests

Happy DOM is used only for compact control/dialog contracts:

- keyboard grid navigation;
- focus return from the editor popover;
- relation picker selection;
- read-only/conflict markers;
- view toolbar draft/commit;
- a legacy block does not call a write automatically.

Virtualization geometry and pointer drag do not rely only on a jsdom-like
environment; they go through native UI scenarios.

### Manual/native scenarios

- 10,000 rows in all four layouts;
- fast typing with an immediate tab/peek close;
- simultaneous editing in two windows;
- external edit of a record/YAML/view;
- Table resize/freeze/scroll;
- keyboard-only Table and Board;
- drag in Board, sub-item and linked view;
- module off/on with open hosts;
- side peek → full page → back to originating row;
- compact window, focus mode and both sidebars;
- asset previews with missing/corrupt media.

## 26. Frontend implementation order

1. Add generated database types/port and a pure `useDatabaseStore` without UI.
2. Introduce the `database` tab kind, the lifecycle controller and a read-only workspace shell.
3. Implement a read-only Table with virtualization and query pagination.
4. Add shared typed cells, selection and a single-value edit queue.
5. Connect side peek to the existing doc store/autosave and the Info inspector.
6. Add view tabs/toolbar/autosave and schema dialogs.
7. Implement List and Gallery on top of the common row model.
8. Implement Board and an atomic drag mutation.
9. Replace the prototype `AmbyBlockView` with the new linked view with a legacy migration path.
10. Add batch/paste, Relation/Files, sub-items and operation previews.
11. Add module disable/recovery UX and native multi-window scenarios.
12. Run a benchmark and optimize only the measured bottlenecks.

Each slice includes localization keys, selectors, pure tests and a manual scenario.
No layout gets its own storage path or a separate row value.

## 27. Closed decisions

1. One database store serves all layouts and hosts.
2. The Markdown body stays in the existing document store/autosave.
3. Side peek uses the real `DocumentEditor`, not a reduced text
   editor.
4. The right Info panel inspects the peek row and shows two property sections.
5. Table virtualizes rows and unpinned columns.
6. The editor draft survives the unmounting of a virtual cell.
7. Selection is stored by stable IDs.
8. Saved view autosave uses CAS; quick search stays temporary.
9. A linked view does not copy rows and has independent local overrides.
10. A legacy block migrates only explicitly, via a preview.
11. One note has one writable editor owner per window.
12. A database tab is not added to the second split pane in the first version.
13. A save error stays next to the object, not only in a toast.
14. Layouts use the Amby design system, adopting only the mechanics from Notion.

## 28. Next step

No architectural product questions blocking the first slice remain.
The DB Roadmap turns the contracts into a concrete PR backlog:
files to change, dependencies, acceptance criteria, tests and a safe
order for enabling the feature flag.
