# Amby database user flows

Status: architecture proposal
Document version: 1
Date: 2026-09-04

This document makes the [system plan](database-system.md) concrete through
user actions and verifiable results. Technical formats and IPC must not
contradict these flows.

## 1. General rules

- A database row is always a real Markdown note.
- The owning database is determined by the nearest parent `ambd.json`.
- The schema is stored in `ambd.json`; views and templates live in their own `.ambd`
  shards listed in the manifest.
- Values of the shared schema are stored in `.ambd/records/<note-id>.json`.
- SQLite serves fast queries and is fully rebuilt from the durable
  files.
- Every operation first saves durable data, then updates the index.
- An index error after a durable commit is shown as `rebuildRequired`, not as
  a false "data not saved".
- Automatic migration, deletion of unknown data, and last-write-wins
  are forbidden.

## 2. Creating a standalone database

### Main flow

1. The user chooses `Новая база данных` (New database).
2. They specify a name and a destination directory.
3. They choose `Пустая` (Empty) or `Копировать структуру существующей` (Copy the structure of an existing one).
4. When copying, they choose the source database; the schema, views, and row
   templates are copied, but not rows, values, or assets.
5. Optionally they choose an IconValue and a cover.
6. Amby checks for name collisions and whether writing is possible.
7. The backend atomically creates the directory and `ambd.json` version 1.
8. The database appears in the Files and Databases panels and opens in Table view.

### Result on disk

```text
Персонажи/ (Characters/)
├── ambd.json
└── .ambd/
    ├── records/
    ├── recovery/
    └── trash/
```

Empty service directories may be created lazily on the first write.

### Errors

- If the path appeared after preflight, the operation does not replace it and offers
  another name.
- If `ambd.json` could not be created, the empty temporary container is cleaned up.
- If cleanup failed, the exact remaining path is shown; it is not considered a
  successfully created database.

## 3. Attaching a database to a note

1. The user opens a note and chooses `Подключить базу данных` (Attach a database).
2. If the note is a single file, the preview shows its conversion into a bundle.
3. If the note already has child notes, the preview lists the future rows
   and Title/ID conflicts.
4. The user confirms the operation.
5. The backend uses the existing safe bundle promotion and creates
   `ambd.json` without replacing a file that has appeared.
6. The note gets a `База данных` (Database) layer; the `Текст` (Text) layer remains available.
7. Existing child notes become rows without an additional move.

If creating `ambd.json` fails, the bundle promotion is rolled back. If the rollback
did not complete, Amby shows a recovery action and does not hide the changed paths.

## 4. Creating a row

### From Table/List/Gallery

1. The user clicks `New`.
2. They choose a row template or use the default.
3. They enter a unique Title.
4. Amby merges the template defaults with the unambiguous values of the current filter;
   the view context takes priority.
5. The backend creates a real `.md`, assigns `amby-id`, writes the initial
   database values, and updates the index.
6. The row opens in Side peek.

### From Board

Creating inside a column additionally assigns the corresponding Status or
Select. This value takes priority over the template.

### Title

- The Title is unique across the whole owning database, including sub-items.
- The check uses the same Unicode/case normalization as the index.
- The Title renames the `.md` and the bundle through a safe refactor.
- On a conflict, the write does not start; the UI suggests a free name.

### Partial failure

Creating the note, the initial values, and the index change are returned as a single
`MutationOutcome`. If the note was created but the shard was not, the operation either rolls back
only the just-created no-replace file, or leaves a recovery journal. It does not
show a ready row without explicit diagnostics.

## 5. Opening a row

### Side peek by default

- A single click opens Side peek and keeps the view visible.
- On a wide screen the Markdown description is on the left, the properties on the right.
- On a narrow screen the properties collapse above the text.
- `Escape` closes the peek.
- `Ctrl/Cmd + click` opens a regular tab.
- The `Открыть полностью` (Open in full) button turns the current preview into a tab.

The peek and the tab use one document store, autosave queue, and property state.
Opening one note in two ways does not create independent dirty buffers.

The view stores the mode `sidePeek`, `centerPeek`, or `fullPage`; the first delivery may
include only a fully working Side peek.

## 6. Page properties

The peek and the Info panel show two sections:

```text
Свойства базы «Персонажи» (Properties of the database "Characters")
Личные свойства заметки (The note's personal properties)
```

- `+` in the first section changes the shared schema after a lock/revision check.
- `+` in the second section creates a property of this note only.
- A database property is visible on all rows, even if the value is empty.
- A personal property does not become a column and does not take part in a database query.
- An explicit command can convert a compatible personal property into a shared one after a
  preview of all affected values.

For a database property, the page offers `Всегда показывать` (Always show), `Скрывать
пустое` (Hide empty), and `Всегда скрывать` (Always hide). The setting does not change the visibility of the column in views.

## 7. Editing cells

- Text uses debounce and a mandatory flush on blur, close, and unmount.
- Checkbox, Date, Select, Status, Media, and Relation are written immediately.
- Until the durable commit is confirmed, the cell shows a pending state.
- An error keeps the entered value in a recovery draft and offers retry.
- A stale revision returns a conflict instead of overwriting the new value.
- A single record shard is written through a queue keyed by `noteId`.

Table supports arrows, Enter, Tab, Shift+Tab, Escape, and copy/paste. Pasting a
range first shows type errors and is executed as a single batch
operation.

## 8. Creating and changing the schema

### Creating a property

The first version supports Title, Text, Number, Checkbox, Date, Select,
Multi-select, Status, URL, Files & media, and Relation. Title is a system property and
cannot be deleted.

### Rename

The display name changes, but `propertyId`, values, filters, and the YAML binding
are preserved.

### Changing the type

1. Amby builds a read-only conversion preview.
2. It shows the number of successful, empty, and incompatible values.
3. After confirmation it creates a snapshot/journal.
4. Incompatible values are preserved as a diagnostic payload.

### Deletion

The property definition and values are moved to `.ambd/trash` and can be
fully restored. Permanent deletion is a separate cleanup command.

## 9. YAML sync

The user can explicitly bind a database property to a YAML key.

- Text, Number, Checkbox, Date, Select, Multi-select, and URL are supported.
- Relation, Files & media, and computed properties remain Amby-only.
- Renaming a property does not change the YAML key automatically.
- Enabling, renaming the key, and disabling all show a preview.
- A YAML change made by an external editor reaches the database after a watcher refresh.
- A simultaneous change to the YAML and the shard creates a field-level conflict.
- The user chooses the Amby value, the YAML value, or enters the final one manually.
- Until the conflict is resolved, the note's other fields keep working.

## 10. Relations

### One-way relation

1. The user creates a Relation and chooses any target database, including the
   current one.
2. They choose cardinality: one record or several.
3. In the cell they search rows of the target database and the `noteId` is saved.
4. Clicking the value opens the target page in Side peek.

### Two-way relation

1. The user enables `Создать обратное свойство` (Create reverse property) and names both sides.
2. Preflight checks the revisions and the lock of both databases.
3. A journal atomically coordinates the two `ambd.json` files.
4. One canonical edge is stored; the reverse value is computed by the index.

If the target is deleted, unavailable, or has left the target database, the Relation does not
disappear. It gets the state `unresolved` or `outsideDatabase` and stays
openable when the file is available.

## 11. Sub-items and folders

### Creating a child row

1. The user chooses `Добавить sub-item` (Add sub-item) or drags a row onto a row.
2. A single parent `.md` becomes a bundle if necessary.
3. The child file is physically moved into the bundle.
4. `Parent` and `Sub-items` are recomputed from the tree.

Regular folders can group files but are not rows. If a row
has its own `ambd.json`, its main `.md` remains a row of the outer database,
while the child notes belong to the inner database.

### Display

- `Nested` preserves the hierarchy and sorts the siblings of each level.
- `Flat` shows and sorts all rows together.
- If a filter matched only a child, it is shown with the parent's breadcrumb.
- Ordinary child values are not inherited from the parent.

### Deleting a parent

The user chooses to delete the whole bundle with its sub-items, or to delete the parent and
lift the children to its level. The preview shows the number of pages; the operation is
journaled and restored as a whole.

## 12. Adding existing notes

1. `Добавить существующие страницы` (Add existing pages) opens a vault search.
2. Amby excludes the current rows and shows the owning database of each
   result.
3. The preview lists filesystem moves and link refactors.
4. After confirmation the regular move/refactor pipeline is used.
5. The moved note keeps its `amby-id`, body, personal properties, and assets.
6. The old database values remain in the source container for a possible
   return.

Dragging from the Files panel triggers the same flow. A note cannot have two
owning databases; for a second context, use a Relation or a linked view.

A move from another database requires an explicit mapping of compatible properties. Nothing
is matched automatically by display name alone.

## 13. Views

### General rules

- One database has several saved views.
- The data is shared; filters, sorts, group, layout, and property visibility are independent.
- Settings are saved automatically to `.ambd/views/<view-id>.json`.
- Quick search is temporary.
- Without an active sort, a manual order by `noteId` is available.
- Title is always the first frozen column; additional ones can be pinned.

### Table

Full editing of typed cells, resize/reorder/hide/freeze of columns,
multi-sort, AND/OR filters, group/subgroup, and footer aggregates.

### Board

In the first version, grouping is only by Status or a single Select. Dragging between
columns atomically changes the value. Multi-select and Relation do not duplicate one
row across several columns.

### List

A compact list with chosen additional properties and the same
filter/sort/sub-item modes.

### Gallery

Preview source: the chosen Files & media → the note's first image → IconValue
→ an empty preview. The set of properties on the card is configured in the view.

## 14. Linked views

1. In a note, `/` or "+" → "Представление базы данных" (Database view): choose a database, then a saved view or
   a layout (table, board, list, gallery).
2. A portable `amby-db` block "shortcut" is created: a tab with a reference to `databaseId`, its own
   name/icon, and a copy of the chosen view's settings.
3. The tab is edited as in the database itself: filter, sort, search, layout, properties, values.
   Changes stay in the block and do not change the view in the database; the values are shared.
4. Clicking the active tab opens the settings (name, icon, layout, source, duplicate,
   delete); "+" adds a tab, including one for another database.
5. `Открыть базу` (Open database) opens the source.

A missing database leaves the tab in place with a diagnostic and a button to choose
a new source. An unknown block version is preserved byte-exact and read-only.

## 15. Databases panel and global Search

The panel automatically finds standalone databases and database layers, and shows
saved views, favorites, and create/attach commands. A database or view opens
in a tab; a view can be dragged into Markdown as a linked block.

Global Search searches property values and filters by Database, Property, Status,
and Relation through the shared query engine. When the module is off, these filters are hidden,
while regular Markdown search keeps working.

## 16. Lock database

A locked database allows changing values and the body of pages, but forbids:

- schema mutations;
- changes to persistent view settings;
- filesystem membership and sub-item moves;
- deleting/attaching the database layer.

Temporary search and filters are allowed. External filesystem changes cannot be
blocked: the watcher reflects them and shows a warning.

## 17. Bulk actions and CSV

Multi-select supports changing a property/Relation, move, and delete-to-Trash.
The whole operation goes through preflight and a single recovery journal.

CSV import shows the mapping, the types, and the future Markdown files. By default it
creates new rows and never updates an existing one just on a
Title match. CSV export dumps the current view or the whole database; Relation and Media
are represented by portable links.

In the first version, CSV does not update existing rows. A future update mode requires
an explicit `amby-id` column and a revisions preview.

## 18. History and Undo

- A schema mutation creates a snapshot of `ambd.json`; a view/template mutation creates a
  snapshot of the corresponding shard.
- Text-cell edits are merged into a session entry rather than written on every character.
- A batch, a multi-cell paste, and a CSV import are each a single recoverable
  operation.
- Undo uses the same safe backend path with revision checks.
- An unfinished journal is offered for resume/rollback on the next open.

## 19. Deleting and restoring a database

### Remove the database, keep the pages

`ambd.json` and `.ambd/` are moved to the vault-local Trash. The container becomes a
regular folder, and all `.md` files remain available.

### Delete together with the pages

The preview shows the database, nested databases, the number of notes, and the size of assets.
The whole container is moved to Trash.

Both operations have restore. Purge is performed separately and does not allow partially
remaining schema/records.

## 20. Turning the module off

1. Amby flushes pending writes or shows an error.
2. It stops database subscriptions and derived calculations.
3. It hides all creation points, views, panels, and database-layer controls.
4. It does not change `ambd.json`, `.ambd/`, embedded blocks, or Markdown rows.
5. A standalone database is displayed as a regular folder; an attached main note as a
   regular note with child files.
6. Turning it back on validates the durable files and rebuilds the SQLite projection.

## 21. External changes and portability

- A new `.md` inside a container becomes a row after a watcher refresh.
- An external duplicate Title or `amby-id` is not fixed automatically; all
  conflicting files remain visible.
- A corrupted `ambd.json`/record shard is not overwritten and switches only the
  affected part to read-only.
- Copying a full container to another vault carries over rows, schema, views,
  templates, values, and internal relations.
- Missing external Relations stay unresolved.
- A manual copy of a container inside the same vault creates diagnosable duplicate
  IDs. Full cloning with ID regeneration is a separate future command.

## 22. Closed product decisions

### Moving a row between databases

An explicit mapping of compatible fields is used. The user confirms each
pair `source property → target property`; a name match alone is not enough.
The old values are kept in the source container for a possible return.

### CSV update

The first version only creates new rows. Update mode is added later and
works by an explicit `amby-id` column with a revisions preview. Title is never
used as an implicit identifier.

## 23. UX specification readiness criterion

The map is agreed. JSON Schema, the SQLite schema, IPC, and component state machines
can be designed without additional product assumptions.
