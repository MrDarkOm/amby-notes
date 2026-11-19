# Amby database system

Status: architectural proposal; the value-storage section has been replaced by
the actual contract (see below)
Document version: 1
Date: 2026-09-04 (storage contract clarified 2026-10-02)

> **Current value-storage contract.** Row property values live in the
> frontmatter of the row's Markdown note; `.ambd/records/<note-id>.json` is a
> legacy and transitional format, not the primary storage. The exact rules are in
> the [database format](database-format.md), section 1.1. Wherever the text below
> says "record shard" or "property shard" in the sense of value storage, read that
> sentence of the 2026-09-04 proposal as obsolete.

## 1. Goal

Amby databases should offer the convenience of Notion-like collections without
creating a second, closed document model. The main invariant:

> Every database row is an ordinary Markdown note with a stable `amby-id`.

A database defines a shared property schema, a way of including notes, and a set
of views. The note text, attachments, and related layers remain available without
the databases module. SQLite is used only as a rebuildable index and is not the
source of truth.

In this document, "database" means a user collection, and "index" means the
internal `.amby/notes.db`.

## 2. What is worth borrowing from Notion

What to borrow is not the look of the table but the separation of entities:

- a row is a page, not an anonymous record;
- the property schema belongs to the data source, and the values belong to rows;
- several views show the same data in different ways;
- filters, sorts, grouping, and column visibility belong to a specific view;
- a linked view refers to the source database, so a change to the data is
  visible everywhere, while a local view setting does not change the source;
- a relation links records by stable identifiers, and a rollup computes an
  aggregate on top of a relation.

In Amby this must work on top of files and stable identifiers, without cloud
entities and without executing arbitrary SQL or JavaScript.

Notion reference materials:

- <https://www.notion.com/help/what-is-a-database>
- <https://www.notion.com/help/views-filters-and-sorts>
- <https://www.notion.com/help/relations-and-rollups>
- <https://www.notion.com/help/guides/databases-reimagined-whats-changed>

## 3. Audit of the current state

Currently the repository contains three independent prototypes of the same feature.

### 3.1. Database layer

`bundle/layers.rs` can create a `Metadata.md` with an `amby-db` block, but the
content `[]` has no version, no stable schema, and no backend service. The layer
can be created from several UI entry points, even though the `databases` module
is marked `preview`.

### 3.2. Embedded `amby-db` block

`AmbyBlockView.tsx` stores a simple table of rows in
`.amby/blocks/<block-id>.json`. It has no typed columns, no binding of rows
to notes, no versioning, no CAS/revision, no handling of save errors,
no cross-window synchronization, and no recovery. A deferred write is cancelled
on unmount, so the last edit may potentially never reach
the disk.

### 3.3. Custom properties

`properties.json` and `note_custom_properties` already give notes properties, but
every `CustomProperty` contains both the field definition and its value at once.
The type, value, and settings are represented as strings. This shape does not allow
having a single shared database schema, reliably changing types, building relation/rollup, or
validating queries.

### 3.4. Module boundary

The current `activeModules` mostly controls panel buttons. The manifest
permissions are still advisory, the lifecycle hooks are empty, and the database layer's actions are not tied
to a single capability check. So "disabled" is not yet a real
module state.

### 3.5. Audit conclusion

Capabilities must not be grown separately in `AmbyBlockView`, `Metadata.md`, and
`CustomProperty`. First, a single domain of properties and databases is needed; then all UI entry points
must become its clients.

## 4. Domain model

### 4.1. Core entities

```text
Markdown note (Record)
        │ stable amby-id
        ▼
Database membership ──► Database definition ──► Property definitions
        │                         │
        │                         └─────────────► Saved views
        ▼
Property values
```

#### Record

A reference to an existing note:

```ts
interface RecordRef {
  noteId: string
}
```

The row title is the system property `title`, tied to the displayed
note name. A non-empty namespaced `amby-title` takes priority over the first
H1/body title and the file name. Displayed names may coincide; identity and
links always use the full `amby-id`. Changing `amby-title` does not have to
rename the file, and an explicit filesystem rename remains a separate
operation through the refactor pipeline.

Opening a row opens the same note in a peek, a tab, or a separate window.
Creating a row goes through the ordinary safe note-creation command.

#### DatabaseDefinition

```ts
interface DatabaseDefinition {
  format: "amby-database"
  formatVersion: 1
  databaseId: string
  name: string
  membership: { kind: "filesystem-descendants"; recursive: true }
  properties: PropertyDefinition[]
  viewOrder: string[]
  defaultViewId: string | null
  templateOrder: string[]
  defaultTemplateId: string | null
}
```

`databaseId`, property identifiers, select/status option identifiers, view
identifiers, and template identifiers are ULIDs. The displayed name is never used as a key. The runtime
revision is computed from raw bytes and is not stored inside the JSON.

#### Membership

The database's composition is determined by the file hierarchy, not by a hidden list:

- notes inside a directory with `ambd.json` are rows of the database;
- ordinary subfolders can be used as categories; their notes remain
  rows of the same database;
- a bundle folder containing a same-named main note represents a row with
  child rows;
- the nearest parent container with `ambd.json` is the owner of the row;
- moving a note in or out adds it to or removes it from the database without a separate
  membership record.

An example of Notion-like sub-items:

```text
Персонажи/
├── ambd.json
├── Алиса/
│   ├── Алиса.md
│   ├── Ученик Алисы.md
│   └── Семья/
│       └── Сестра Алисы.md
└── Борис.md
```

`Алиса` (Alice), `Ученик Алисы` (Alice's Student), `Сестра Алисы` (Alice's Sister), and `Борис` (Boris) are rows of one database.
The Student and Sister are displayed as child rows of Alice; the ordinary folder
`Семья` (Family) helps organize files but is not itself a row. The system
properties `Parent` and `Sub-items` are computed from the file structure.

Dragging and dropping a row onto another row performs an ordinary safe filesystem
move. If the parent was a single `.md`, it is first atomically turned into a
bundle. A cycle cannot be created, and a row cannot be moved outside the permitted
vault.

Deleting a row with sub-items offers to delete the whole bundle to Trash or to delete
only the parent and atomically lift the child rows to its level. The preview
shows the number of all affected pages.

A row of an outer database may have its own database layer. Its main
same-named `.md` remains a row of the outer database, while the child notes belong
to the nearest inner `ambd.json`. The scan must not include them in
both databases at once.

#### PropertyDefinition and PropertyValue

The definition is separated from the value and is represented as a discriminated union, not as
a set of strings:

```ts
type PropertyDefinition =
  | { id: string; name: string; type: "text" }
  | { id: string; name: string; type: "number"; format: NumberFormat }
  | { id: string; name: string; type: "checkbox" }
  | { id: string; name: string; type: "date"; includeTime: boolean }
  | { id: string; name: string; type: "select" | "status"; options: SelectOption[] }
  | { id: string; name: string; type: "multiSelect"; options: SelectOption[] }
  | { id: string; name: string; type: "url" }
  | { id: string; name: string; type: "files"; mediaOnly: boolean }
  | {
      id: string
      name: string
      type: "relation"
      targetDatabaseId: string
      maxItems: 1 | null
      inverse: InverseRelation | null
    }
  | { id: string; name: string; type: "rollup"; config: RollupConfig }
  | { id: string; name: string; type: "formula"; expression: FormulaAst }
```

Values are also typed. Dates store an ISO value, the original timezone, and an
optional range end; a number does not pass through a localized string;
select stores the option ID; relation stores a `noteId`. An unknown or newer
value is preserved as an opaque payload and shown read-only instead of
being deleted.

`Status` differs from an ordinary Select: its options belong to configurable
groups `notStarted`, `inProgress`, and `done`; the names and colors of the options themselves
remain user-defined.

Ordinary values of a child row are not inherited from the parent. `Parent` and
`Sub-items` reflect only the hierarchy; explicitly obtaining the parent's data later
is done through relation/rollup or formula.

The system fields `title`, `created`, `modified`, `path`, `tags`, `backlinks`, and
`wordCount` are computed from the note/index. They can be shown, filtered, and
sorted, but cannot be deleted like an ordinary database field.

### 4.2. Local properties and database properties

The existing custom properties of a note remain local properties. Database
fields are a shared schema and are not copied into every note. In the Info panel,
properties are shown in sections:

```text
Local properties
Projects / database properties
Clients / database properties
```

A note has one owning database, determined by the nearest parent
`ambd.json`. In other databases it appears through a Relation, and in other places of the
interface through a linked view of the source database. Identical displayed field names
from different databases do not mean the same `propertyId`.

## 5. Sources of truth and on-disk format

### 5.1. Database definition

The database definition is stored in `ambd.json` inside its container. This is a special
portable file, not a user note and not a SQLite row:

```json
{
  "format": "amby-database",
  "version": 1,
  "id": "01...",
  "name": "Projects",
  "membership": { "kind": "filesystem-descendants", "recursive": true },
  "properties": [],
  "views": []
}
```

For a layer database and a standalone database, the structure differs only in whether a
main note is present:

```text
Персонажи истории/          Персонажи/
├── Персонажи истории.md    ├── ambd.json
├── ambd.json               ├── Алиса.md
├── Алиса.md                └── Борис.md
└── Борис.md
```

Amby hides `ambd.json` in its tree and recognizes a container as a database by the
exact `format` and a supported version. Unknown JSON fields are preserved.
A corrupted or too-new file does not block opening the main note or
nested rows: the database switches to read-only Source/Repair mode.

SQLite mirrors the definition for queries, but deleting `.amby/notes.db`
must fully restore the schema and views from `ambd.json`.

### 5.2. Database property values

Database values are stored in the frontmatter of the rows' Markdown notes, inside the portable
database container. There is no separate value storage:

```text
Персонажи/
├── Персонажи.json   (or the legacy ambd.json)
├── .ambd/
│   ├── views/
│   ├── templates/
│   ├── recovery/
│   └── trash/
└── Алиса.md         ← frontmatter with property values
```

`.ambd/` is hidden in the Amby tree and excluded from note indexing. A cell write
surgically changes only the needed frontmatter key (`replace_yaml_binding_lossless`)
with a raw-byte revision check; the rest of the YAML, the BOM, and line endings are preserved.
Bulk operations use the recovery journal `.amby/recovery/`.

If a note is moved out of the database, its frontmatter is not changed: the values stay
in the note but do not participate in this database's queries. Cleanup is performed only by an explicit
command with a preview and confirmation.

Schema, view, and template files are durable data, not a cache. Copying or
moving a database folder carries the schema, views, templates, and values together with the
Markdown rows. `notes.db` remains the only deletable and fully
rebuildable part.

Legacy: `.ambd/records/<note-id>.json` from early versions of the format are, when a
database is detected, moved into frontmatter and deleted; while they exist, the projection
reads them as a fallback source, and frontmatter takes priority. Details are in the
[database format](database-format.md), section 6.

### 5.3. Local note properties

The current monolithic `.amby/properties.json` continues to apply only to
local note properties. Before intensive table editing, it must be
moved by a versioned migration to per-note shards in `.amby/properties/notes/`.
This migration does not move database values back into the global storage.

Moving off `properties.json` requires a separate migration under the rules of
`docs/engineering.md`: read-only preflight, raw backup, journal, idempotent
resume, rollback, and recording of the result. The old file is not deleted until
a successful check is confirmed.

The original design (2026-09-04) assumed a hybrid model: a full
typed record in a property shard and an explicit binding of selected fields to YAML.
In practice, frontmatter became the primary storage, and the YAML binding (`yamlBinding`)
determines only the storage key. Relations, computed fields, and internal IDs are not
exported to YAML.

Two-way synchronization in the first version supports Text, Number, Checkbox,
Date, Select, Multi-select, and URL. Files & media and Relation remain Amby-only.
The YAML key is stored as a separate stable binding: renaming a property does not change
the key without a separate preview. If the shard and the external YAML changed the same field after
the common revision, Amby shows a field-level conflict and does not apply
last-write-wins. This three-way logic applies to the explicit YAML sync command;
an ordinary cell edit does not use it.

### 5.4. Embedded linked view

`amby-db` in an ordinary note no longer stores its own rows. It refers to a
database and a saved view:

````markdown
```amby-db
{"version":1,"databaseId":"01...","viewId":"01..."}
```
````

On insertion, the configuration of the selected view is copied into the block's local overrides.
Rows and values remain shared, but subsequent changes to the filter, sort,
or layout inside the block do not change the source saved view. The block offers the commands
`Open source database` and `Reset from source view`.

A cell change goes into the frontmatter of the source note, a change to the shared schema goes into the
database manifest (`<Name>.json` / `ambd.json`),
and a change to the local view goes into the block's portable configuration. `.amby/blocks/`
may be a cache or a recovery draft, but not the only copy of the configuration or
data.

### 5.5. Row templates

A database may store several versioned templates in
`.ambd/templates/<template-id>.json`; `ambd.json` stores their order and the default ID.
A template contains a name, a Markdown body skeleton, and initial values of the shared
properties. The New button offers a choice of template.

A template is copied only when a note is created. Its subsequent change does not
rewrite rows that were already created. Media is not embedded as binary data in the
JSON; a template may contain only portable links or instructions for
explicit asset copying.

## 6. SQLite as a rebuildable query index

The index normalizes data into roughly the following tables:

```text
database_defs(id, note_id, revision, source_json)
database_properties(id, database_id, type, name, position, config_json)
database_members(database_id, note_id, position, source)
database_values(database_id, note_id, property_id, value_type, value_json)
database_relations(property_id, source_note_id, target_note_id, position)
database_views(id, database_id, type, name, position, config_json)
```

Foreign keys and indexes are mandatory. The cache is built from `ambd.json` and property
shards. Unknown versions are not indexed as partially understood data.

The frontend does not send SQL. It sends a versioned `DatabaseQuery`:

```ts
interface DatabaseQuery {
  databaseId: string
  filter: FilterGroup | null
  sorts: SortRule[]
  group: GroupRule | null
  search: string | null
  cursor: string | null
  limit: number
}
```

Rust validates IDs, operator types, filter AST depth, and limits, then builds
parameterized SQL. The order is always deterministic: after the user's
sort rules, `noteId` is appended. For large result sets a keyset cursor is used,
and the UI virtualizes rows and columns.

The response contains a `snapshotRevision`. A mutation with a stale revision returns a
conflict instead of silently overwriting an external or cross-window change.

## 7. Views

`DatabaseView` stores only a projection over the data:

- layout: `table`, `board`, `list`, `gallery`, and `chart`; calendar and timeline
  are reserved until the range-query contract is ready;
- the order, width, and visibility of properties;
- a filter AST with explicit AND/OR groups;
- a sequence of sorts;
- group/subgroup;
- the row open mode;
- settings of the specific layout.

A view contains no copies of rows. Transient values — selection, scroll,
an unfinished resize, an open menu — remain session state and do not end up in
`ambd.json`.

Filters, multi-level sorting, group/subgroup, and the order and visibility of properties
are saved automatically in the current view. Quick text search remains
temporary. To change settings without touching the source view, the user
duplicates the view. The filter AST supports explicit nested AND/OR groups.

Without an active sort, rows can be reordered manually. The manual order is
stored by `noteId` separately for each view; an enabled sort temporarily
disables reorder but does not delete the saved order.

A view has a sub-items mode, `nested` or `flat`. In nested mode, the siblings of each level
are sorted while preserving the hierarchy; in flat mode, all rows
are sorted as one set. If a filter matches a child row but not
its parent, the result stays visible with a muted breadcrumb up to the parent.

The first implemented version includes `table`, `board`, `list`, `gallery`, and
a backend-driven `chart`. Chart receives the aggregate result on the Rust side and a
limited number of groups, without loading the whole database into React.
Table remains the first technical slice on which types,
saving, and the query engine are proven. Title always remains the first frozen column;
the user can pin additional columns. The footer supports Count,
Count empty, Sum, Average, Min, and Max within the result of the current view.

The first version of Board groups only by Status and single Select; moving a
card between columns changes the field value. Multi-select and Relation do not
group a Board, so as not to create several visual copies of one row.
List shows a compact configurable set of properties. Gallery chooses the card
preview in the following order: the specified Files & media field, the first image from
the note, the note icon, an empty preview. Calendar, timeline, forms, and
automations remain for later stages.

On click, a row opens in a Side peek by default, without closing the database. Inside
there are two property sections and an ordinary Markdown description editor. A button
opens the same note in a full tab; `Escape` closes the peek, and
`Ctrl/Cmd + click` opens a tab right away. A view stores the open mode
`sidePeek`, `centerPeek`, or `fullPage`; the first version may start with a working
`sidePeek` and add the other modes without changing the data format.

On a wide screen, Side peek shows the Markdown description on the left and two property
sections on the right. On a narrow screen, the properties become a collapsible block above
the text. Both layouts use one document/property state, not separate
copies.

The Databases panel shows standalone databases and database layers, expands
their saved views, and allows pinning frequently used items. From the panel
you can open a database/view in a tab, create a standalone database, attach a
database layer to the current note, or drag a view into the editor as a linked
`amby-db` block.

Global Search uses the same query contract and can search property
values, as well as restrict the result by database, property, Status, and
Relation. When the Databases module is disabled, database-specific filters are hidden,
and ordinary Markdown search keeps working.

A database can be locked. In the locked state, editing values
and page content is allowed, but changing the schema, saved views, and file
membership is forbidden. Search and temporary filters remain available; unlocking is explicit.

For a row page, the schema stores a per-field setting independent of views:
`alwaysShow`, `hideWhenEmpty`, or `alwaysHide`. It controls the Info panel/peek but
not the visibility of a column in a particular view.

The interface composition follows the familiar Notion mechanics — header, view tabs,
Filter, Sort, Group, Properties, Search, and New — but uses Amby's components,
typography, IconValue, and theme tokens. Density is inherited from the global
setting and can be overridden by a view with the value `compact`, `default`, or
`tall`.

Creating a row from an unambiguously filtered view or a Board column fills in
the corresponding values. The creation context takes priority over a conflicting
default from a row template, so that the new row does not disappear from the current view.

## 8. Relations, rollups, and formulas

### Relations

A relation stores stable `noteId`s, so rename/move breaks nothing. When
creating the field, any target database is selected, including the current one, and the cardinality
limits the value to one record or allows several. The user can
create a reverse field with a separate name. The reverse side is computed from the
canonical relation edge and is not written as a second independent value.
A deleted or temporarily unavailable note remains an unresolved reference and
can be restored from Trash.

If the related note has left the target database, the edge is preserved and marked
`outsideDatabase`; the link keeps opening. When a container is copied into
another vault, internal relations are restored by ID, while missing
external targets remain unresolved until the corresponding database/note appears.

### Rollups

A rollup specifies a relation property, a target property, and an allowlisted aggregate:
`count`, `countUnique`, `sum`, `average`, `min`, `max`, `earliest`, `latest`.
The value is computed and cached; it never becomes a source of truth.

### Formulas

Formula is its own parser and a typed AST. `eval`, JavaScript,
dynamic import, network access, and raw SQL are forbidden. Functions are pure and allowlisted,
and evaluation has depth/operation limits. The dependency graph detects cycles and
shows a diagnostic value instead of hanging.

Relation is part of the first user-facing version. Formula has a versioned
config and a bounded pure Rust evaluator. Rollup config and validation are ready for
compatible relation/target IDs, but the dependency scheduler, computed cache, and
editor wizard remain for the next stage.

## 9. The boundary of the disable-able module

Two things need to be separated:

- **Property kernel** — a small, always-available core of types/values needed by the
  Info panel, search, and other modules;
- **Databases module** — collection schemas, membership, query engine, views,
  database layer, and embedded views.

When `databases` is disabled:

- the panel, layer creation/attachment, the database layer switch,
  database block insert commands, and database-specific settings are hidden;
- query subscriptions, formula/rollup evaluation, and building of the
  database-specific cache are not started;
- existing database manifests, legacy `Metadata.md`, `amby-db` blocks, and legacy
  shards are not modified or deleted;
- ordinary notes, local properties, search, links, and editors work;
- the generic Markdown editor sees `amby-db` as a preserved code fence;
- re-enabling validates the durable files and rebuilds the index.

Disabling first flushes pending confirmed mutations and unsubscribes the UI.
It does not start a format migration. If the flush cannot be completed, the user
gets an explicit error, and the module does not report a false "disabled" state.

All entry points use one capability check. It is not allowed to hide the
panel separately and leave the layer creation command active. Backend commands also
check the capability state/context rather than relying on the absence of a button.

`activeModules` is responsible for functionality, and the activity-bar layout only for the
placement/visibility of buttons. These concepts must not merge again into one
check.

## 10. Frontend architecture and IPC

```text
Database UI / Info panel / Folder view / Search
                    │
                    ▼
             useDatabaseStore
                    │
                    ▼
            DatabaseRepository
                    │
                    ▼
               StoragePort
              /           \
        Tauri adapter    Web adapter
              │
              ▼
      Rust database service
      ├── definition parser
      ├── property store
      ├── query compiler
      └── index projector
```

Components do not read `loadVaultJSON` and do not write sidecars directly.
`AmbyBlockView` becomes a renderer/controller, not a storage. The workspace
receives a normalized state through one Zustand store and focused hooks;
the table, Info panel, and Folder view do not create parallel copies of rows.

Minimal backend operations:

```text
list_databases
read_database_definition
create_database
update_database_schema(expected_revision)
query_database(query, snapshot_revision?)
set_database_value(note_id, property_id, value, expected_revision)
apply_database_batch(expected_revisions)
add_database_member / remove_database_member
```

The mutation result distinguishes the durable commit from the index state:

```ts
interface DatabaseMutationOutcome {
  durableRevision: string
  indexState: "healthy" | "rebuildRequired"
  warnings: string[]
  changedNoteIds: string[]
}
```

If the durable file is already written but the SQLite update failed, the command does not
return an ambiguous "nothing saved". It reports the commit and
`rebuildRequired`; a repeated scan restores the cache.

The Web adapter implements the same contract on a small reference engine. Shared
contract tests must pass for the desktop and the browser fallback, even if the
browser version does not promise the performance of the native backend.

## 11. Concurrency, history, and external changes

- All value writes of one note are serialized by `noteId`.
- Schema/view writes are serialized by `databaseId`.
- Every mutation uses an expected revision; last-write-wins is forbidden.
- Changing a property of an open dirty note must not clear the dirty state or
  overwrite the body.
- A successful mutation publishes a cross-window event with the new revision.
- The autosave UI is not cleared before a durable acknowledgement.
- Text cells are saved through a debounce with a mandatory flush on blur,
  unmount, and view close. Discrete types are saved immediately. An error
  leaves a recovery draft and a visible pending/error state.
- Before a schema replacement, a bulk operation, and a migration, a snapshot
  or recovery journal is created.
- Deleting a row goes through the vault-local Trash, because a row is a note.
- Removal from membership does not delete the note. Database values are deleted only by
  a separate confirmed cleanup operation.
- Restore brings back the link and values by the same `noteId`.
- Renaming a property preserves its ID and values. A type change requires a preview;
  unconvertible values are preserved as diagnosable data.
- A deleted column and its values first go into the database's recoverable trash,
  rather than being destroyed immediately.

Deleting a database is split into two commands. `Remove database, keep pages` sends
`ambd.json` and `.ambd/` to Trash and turns the container into an ordinary folder, keeping
all the `.md` files. `Delete database with pages` shows the number of affected notes
and moves the whole container to the vault-local Trash.

For Files & media, a single row becomes a bundle if necessary, and the
imported file is atomically placed in its `assets/`. The value contains
a relative link. Clearing the value does not delete the asset automatically;
unused attachments are deleted by a separate operation with a preview.

Attaching a database layer to a note with existing child notes first
shows a preview; after confirmation they become rows without physical
moving. The `Add existing pages` command and dragging from the tree, by contrast, explicitly
show the upcoming filesystem moves, preserve IDs/links/assets, and use the
existing refactor pipeline. A row cannot have two owning
databases at once.

Multi-selection supports bulk change of a property, Relation, move, and
delete-to-Trash. The operation is validated as a whole and executed through a journal: after
a partial failure, resume or rollback is available.

Table supports arrows, Enter, Tab, Shift+Tab, Escape, and range copy/paste.
Pasting several cells first validates the types and shows a preview of
inapplicable values; it is executed as one batch operation.

CSV import first shows the column mapping, the types, and the list of Markdown
notes to be created. CSV export works for the current view or the whole database; Relation
and Files & media are serialized as portable links. Import does not overwrite
existing notes on a single title match.

Creating a new database offers an empty database or a copy of the schema, views, and row
templates of an existing database without rows. Full cloning with rows/assets and
regeneration of all internal IDs remains for after the first version. A manual copy
inside one vault with duplicate IDs is diagnosed and never fixed
automatically.

A database has an IconValue and an optional cover link to a container asset.
A schema mutation creates a snapshot of `ambd.json`, and a view/template mutation creates a
snapshot of the corresponding shard. A value edit takes a snapshot of the note before
writing; edits of a single cell are merged into the session
history, and batch/CSV import is recorded as one recoverable operation. Undo
does not create a bypassing unsafe write path.

## 12. Errors and safe degradation

IPC must return stable machine codes at least for:

```text
moduleDisabled
databaseNotFound
schemaRevisionConflict
recordRevisionConflict
schemaMismatch
invalidPropertyValue
malformedDatabaseDefinition
unsupportedDatabaseVersion
identityConflict
noteReadOnly
staleQueryCursor
indexRebuildRequired
```

None of these errors must make a Markdown note unavailable. When the
schema is not understood, the database becomes read-only, the source `ambd.json` remains
openable in Source/Repair mode, and opaque fields are not discarded.

## 13. Migrating existing prototypes

### Existing custom properties

They migrate into local note properties without changing the semantics. Moving into the
shared database schema is done by a separate wizard with a mapping preview by
`name + type`; the source values are not deleted until the result is confirmed.

### Existing `Metadata.md` with `[]`

It is considered a legacy empty database layer. The file is not rewritten during ordinary
scanning. On first open, a preview is shown for creating a version-1
`ambd.json`, a backup, and the option to cancel. After a successful check, the old file
stays in the backup until an explicit cleanup operation.

### Existing block sidecars

A `columns + rows` table cannot be automatically turned into a database of notes:
the rows have no `noteId`, and creating a note for each row changes the vault.
Therefore the legacy block stays available read-only/editable in the old mode, and
an explicit Convert command shows:

- which notes will be created;
- which column to use as the title;
- the type and ID of each new property;
- where the database will be placed;
- which files and snapshots will appear.

The source JSON is kept until the conversion is completed and verified.

## 14. Implementation plan

### Stage 0 — contract and legacy protection

- Fix the formats and fixtures.
- Close the loss of the last debounced write of the legacy block: flush on blur/unmount,
  error handling, and a recovery draft.
- Tie all database entry points to a single capability check.
- Keep the experimental flag off by default.

### Stage 1 — property kernel

- Introduce shared typed unions and runtime validation.
- Implement a versioned migration of local `properties.json` into property shards.
- ~~Add a database-local `.ambd/records` for the values of the shared schema.~~ Replaced
  by the decision of 2026-10-02: values are stored in the frontmatter of notes.
- Add revision/CAS, write queues, mutation outcomes, and cross-window events.
- Move the Info panel to the new repository without changing the user UX.

### Stage 2 — DatabaseDefinition and Table

- Implement a safe `ambd.json` parser/writer.
- Add a normalized SQLite projection and rebuild.
- Implement filesystem membership, creation of a row-note, sub-items,
  universal Relation, typed cells, table query, pagination, and virtualization.
- Hook up field-level History/Undo and manual row order.
- Replace the panel placeholder with a real list of databases.

### Stage 3 — Views, List, and linked blocks

- Saved table views, property visibility/order/width, filters, sorts, and search.
- List projection and the Side peek open mode.
- An `amby-db` reference block without its own copy of rows.
- Folder view and Search use the shared query API.

### Stage 4 — Board and Gallery

- A shared group/subgroup model.
- Board for Status and single Select.
- Table aggregates and column freezing.
- Gallery with Files & media, the first image, and the icon as a fallback.
- Multi-select batch operations and CSV import/export with preview.
- Completion of the first user-facing release with four layouts.

### Stage 5 — Advanced relations and rollups

- Two-way relations, unresolved references, and aggregates.
- Tests for rename/move/trash/restore and cycles between databases.

### Stage 6 — Formulas

- Parser, type checker, dependency graph, execution budget, and diagnostic UI.

### Stage 7 — Multi-source views

A single view will be able to combine several owning databases without changing their
file ownership:

- `sourceRefs` stores stable `databaseId`s and user aliases;
- the system fields Title, Created, Modified, Path, and Tags are shared;
- properties of different databases are never merged automatically by displayed
  name;
- the user creates a unified column only through an explicit mapping of compatible
  `{ databaseId, propertyId }` pairs;
- the query compiler builds a parameterized `UNION ALL` and adds
  `(databaseId, noteId)` as a stable cursor tie-breaker;
- editing is routed to the owning database and into the frontmatter of its note;
- moving a row between databases remains a separate filesystem operation with a preview of the
  property mapping;
- an unavailable source leaves the view partially working and shows diagnostics,
  without deleting the reference;
- a multi-source view is stored in the host `.ambd/views/<view-id>.json` or in the
  portable configuration of an embedded block, while the schemas of the source databases remain
  independent.

Multi-source is not part of the first version: first a single source must prove
the correctness of membership, typed queries, relations, and conflict handling.

Each stage must be a separate small PR. Format
migration, query engine, and the full UI must not be combined into one delivery.

## 15. Required checks

### Modularity

- Disabling hides all entry points and does not change durable files.
- After a restart, the module stays disabled.
- Re-enabling restores the same databases and views.
- The Simple preset opens notes with database blocks without losing bytes.

### Integrity

- Deleting `notes.db`, `-wal`, and `-shm` followed by a rebuild does not change the result.
- Renaming/moving a note preserves membership, values, and relations.
- Moving a row in and out changes membership according to the file structure.
- Drag-and-drop onto a row creates a sub-item without duplicating the note.
- The nearest nested `ambd.json` correctly changes the owning database.
- Copying a full container into another vault preserves the schema, views,
  templates, values, and relations after an index rebuild.
- Excluding and re-adding a row restores the previous values.
- Trash/restore returns the row with the same `noteId`.
- Deleting a parent separately from sub-items does not leave a partially moved
  bundle on failure.
- Both database deletion commands are recoverable without losing pages or the schema.
- Changing a template does not rewrite existing rows.
- Deleting a media value does not delete the asset without separate confirmation.
- A simultaneous change of YAML and a legacy shard during an explicit YAML sync yields a
  field-level conflict.
- A batch failure is recovered through resume/rollback without partial hiding.
- CSV import does not overwrite a note merely because of a title match.
- External Title duplicates are visible and are not renamed automatically.
- Unmount/blur does not lose the last debounced cell edit.
- Multi-cell paste goes through shared type validation before writing.
- Relation stays available and diagnosable after the target leaves the database.
- A Board drag atomically changes Status/Select and rolls back correctly on error.
- A corrupted database manifest or legacy shard is not overwritten.
- An old revision cannot overwrite an external or cross-window change.
- A failure after the durable write and before the index update yields `rebuildRequired`, not a
  false rollback.

### Compatibility

- The new `ambd.json` and the reference `amby-db` have golden/contract fixtures.
- Unknown JSON fields are preserved.
- An unsupported version works only read-only.
- Corrupted JSON is never overwritten by automatic repair.

### Queries

- All filter operators have tests for null/empty and a wrong type.
- Sort is stable for equal values.
- The cursor detects a stale snapshot.
- No user text is concatenated into SQL.
- A cyclic formula ends with a diagnostic.

### Scale

A benchmark vault of at least 10,000 notes and 20 properties must be fixed.
The first table screen must not load all rows into React. Specific p95
budgets are approved after a baseline on Windows/macOS/Linux and then become
a regression contract.

## 16. Decisions for the first production slice

Decisions accepted by default:

1. A row is always a Markdown note.
2. The schema lives in `ambd.json`, views/templates in their own `.ambd` shards.
3. Database values live in the frontmatter of the row notes; `.ambd/records` is legacy
   (decision of 2026-10-02, see the [database format](database-format.md), section 1.1);
   SQLite is only an index.
4. Membership and sub-items are determined by the actual file nesting.
5. The first version contains Table, Board, List, Gallery, and a universal Relation.
6. Side peek is the default row open mode.
7. Databases support new-row templates without back-synchronization.
8. Excluding a row keeps the values until a separate cleanup command.
9. A nested database takes over ownership of its child rows.
10. A linked view shares the data but stores local display settings.
11. Rollup and formula are deferred until a stable property/query kernel.
12. A field's frontmatter key is set by a stable `yamlBinding` binding; there is no
    value sidecar.
13. A database supports locking the structure without locking the values.
14. YAML sync is two-way for simple types and resolves conflicts per field.
15. A view saves settings automatically and has its own manual order.
16. The first version supports batch operations and CSV import/export.
17. History coalesces input, while bulk changes are journaled as a whole.
18. Title is unique in the owning database and renames the real file.
19. Sub-items are displayed in nested or flat mode.
20. Text autosave is always flushed, and the table supports keyboard/paste.
21. Table has a frozen Title and aggregates; Board groups by Status/Select.
22. The visibility of a property on the page does not depend on the visibility of a view column.
23. The property kernel stays available to the app; the Databases module is disable-able.
24. Disabling never deletes or migrates data.
25. The frontend does not get raw SQL and does not write sidecars directly.
26. Multi-source views are added as a separate stage through an explicit typed mapping.

Any change to items 1–3 changes the source-of-truth model and requires a separate
architectural decision before implementation begins. Item 3 has already been revised by such a
decision: see section 1.1 of the database format.
