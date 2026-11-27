# Amby database format

Status: implemented v1 contract with additive computed/chart extensions
Document version: 1
Date: 2026-09-04

This document defines the durable format of the first version of databases. It follows the
[architecture](database-system.md) and the
[user flows](database-user-flows.md). The SQLite schema is a separate
rebuildable projection of this format.

## 1. Container structure

The current layout is **manifest version 2**. The views and templates inside the manifest still
have their own `formatVersion: 1`; these are the versions of the nested documents.

```text
Персонажи/
├── Персонажи.json   — schema, views, templates, order and settings
├── assets/
│   ├── img_<ULID>.png
│   └── pdf_<ULID>.pdf
├── Алиса.md
└── Борис/
    └── Борис.md
```

New databases are created directly in version 2. All settings, views and templates
are stored in a single JSON, and property values in the Markdown frontmatter. Attachments
are stored separately: `assets/<type>_<ULID>.<extension>` inside the container; the original name
stays in the attachment description. When existing resources are moved, their
nested paths `assets/<note-id>/<name>` are preserved so that links in values do not change.
Named resource files are not overwritten. Symbolic links are forbidden.

When a vault is opened, only a check is performed. Version 1 databases are shown
in the interface as locked until updated; a notice offers
"Update data" («Обновить данные»). Opening itself migrates nothing. On click, autosaves are
finished, the vault generation is checked, and sync is stopped
until the migration pass ends and then started again.

Before publishing, all databases are checked: the identity of templates and views, the absence
of resource collisions, the correctness of the merged JSON and the **5 MiB** limit. Unknown
fields are preserved. A non-empty legacy `records/`, duplicate manifests, corrupted
data, symbolic links and user links to `.ambd/assets/`
that cannot be migrated automatically block the conversion without changing
the source files.

Version 1 with `ambd.json` and separate `.ambd/views/` and `.ambd/templates/` is read
for the transition. The description of shards below applies to this compatibility and to the models
of nested documents, not to the file layout of new databases.

## 1.1. Sources of truth and the storage contract (ST-02)

- **Note property values** — the Markdown frontmatter of the note files in the database container is the primary source of truth. Values are written through a targeted, lightweight atomic splice (`replace_yaml_binding_lossless`), preserving the Markdown structure, BOM, line endings and third-party fields.
- **Record shards (`.ambd/records/`)** — a legacy version 1 format; version 2 neither reads nor creates them. An ordinary edit of a
  cell, Relation and row creation do not write them and do not require them. Details and
  the actual behavior are in section 6.
- **Database schema and views** — the manifest file (`<Название_Контейнера>.json` / `ambd.json`) and the saved views (`.ambd/views/`).
- **The SQLite projection** — a derived, fully rebuildable cache (`.amby/notes.db`). Deleting the SQLite database file does not lead to the loss of user data or properties.
- **Property identity and keys:**
  - `propertyId` — the immutable canonical ULID of the property in the database manifest.
  - `storageKey` — the immutable storage key in the note frontmatter, set through `yamlBinding.key`.
  - `name` — the property title shown to the user (for example, "Дата завершения" (Completion date)). Changing the display name does not require rewriting the frontmatter of thousands of notes.
- **Key resolution priority when reading:**
  1. An exact match with `storageKey` (`yamlBinding.key`).
  2. An exact match with `propertyId`.
  3. A case-insensitive match with `storageKey`.
  4. An exact match with the display `name` (legacy fallback).
  5. A case-insensitive match with `name` (legacy fallback).
- **Reserved system keys:**
  - The system keys `amby-id`, `amby-title`, `amby-views`, `amby-database` and any keys with the `amby-` prefix are reserved by the Amby core.
  - User properties named `id` or `title` are bound to the corresponding user YAML keys and never replace `amby-id`. User properties are forbidden from binding to reserved keys.
- **Format versioning:**
  - The current version of the durable format: `1`.
  - Unknown/future versions (`formatVersion > 1`): opened in **read-only** mode with a diagnostic warning; the manifest file and notes are not rewritten.
- **Value semantics:**
  - `0` and `false` are valid meaningful values and are not interpreted as empty.
  - Clearing a cell value (an empty string, an empty list of files or links) removes the corresponding key from the frontmatter (`remove_yaml_binding_lossless`).
  - Select/Status/MultiSelect options stay stable under renaming: the value in the frontmatter can be either the option name or its stable ULID (`find_option_id`).

## 2. General JSON rules

- UTF-8 without a mandatory BOM; invalid UTF-8/BOM is handled read-only.
- New writes are formatted with two spaces and a trailing LF.
- `format` and `formatVersion` are mandatory in every durable JSON file.
- The IDs of the database, properties, options, views, templates and notes are canonical uppercase
  ULIDs.
- The order of arrays is significant; the order of object keys is not used as data.
- Unknown keys are preserved when a known object is written.
- An unknown `formatVersion` opens entirely read-only.
- An unknown discriminant inside a supported version is preserved as an opaque
  entry; the other understood parts continue to be read if that is safe.
- `null` is used only where it is described. A missing property value
  is denoted by the absence of the key, not by an implicit empty string.
- JSON numbers are not used for user decimal values.

## 3. Revision and CAS

The revision is not written inside the JSON, otherwise an external editor could change
the file without updating the revision field. The backend returns an opaque revision computed
from the exact raw bytes.

Each mutation accepts `expectedRevision`:

1. the backend re-reads the file;
2. compares the raw-byte revision;
3. validates the mutation against the current state;
4. writes a sibling temporary file, flush/sync and atomically publishes;
5. returns the new revision;
6. updates the SQLite projection.

A mismatch returns a typed conflict. Last-write-wins and automatic writing
over corrupted JSON are forbidden.

## 4. Database manifest (`<Название_Контейнера>.json` / `ambd.json`)

```json
{
  "format": "amby-database",
  "formatVersion": 1,
  "databaseId": "01K4...",
  "name": "Персонажи",
  "icon": "📚",
  "cover": null,
  "locked": false,
  "membership": {
    "kind": "filesystem-descendants",
    "recursive": true
  },
  "properties": [],
  "viewOrder": ["01K4..."],
  "defaultViewId": "01K4...",
  "templateOrder": [],
  "defaultTemplateId": null
}
```

### Manifest fields

| Field               | Semantics                                                             |
| ------------------- | --------------------------------------------------------------------- |
| `databaseId`        | The stable database ID, independent of the path and name              |
| `name`              | The display name; the directory name may differ after a conflict      |
| `icon`              | The value of an existing `IconValue` or `null`                        |
| `cover`             | A database-local asset reference or `null`                            |
| `locked`            | Blocks schema/view/membership mutations through the UI                |
| `membership`        | In v1 only recursive filesystem descendants                           |
| `properties`        | The ordered shared schema                                             |
| `viewOrder`         | The ordered IDs of the `.ambd/views` files                            |
| `defaultViewId`     | The view on opening the database, or `null` if there are no views yet |
| `templateOrder`     | The ordered IDs of the `.ambd/templates` files                        |
| `defaultTemplateId` | The default template or `null`                                        |

`defaultViewId` must be present in `viewOrder`. A similar rule
applies to templates. A missing shard is not removed from the manifest automatically:
the UI shows a diagnostic and offers a repair or an explicit clearing of the reference.

### Cover

```ts
interface DatabaseCover {
  kind: "asset"
  assetId: string
  relativePath: string
  mimeType: string
}
```

`relativePath` is resolved inside `assets/` for version 2 (`.ambd/assets/` for version 1), and contains no absolute
prefix, `..`, URL or symlink escape.

## 5. Property definitions

Each definition has common fields:

```ts
interface PropertyBase {
  id: string
  name: string
  type: string
  pageVisibility: "alwaysShow" | "hideWhenEmpty" | "alwaysHide"
  yamlBinding: YamlBinding | null
}
```

The definitions supported in v1:

```ts
type PropertyDefinition =
  | (PropertyBase & { type: "text"; config: { multiline: boolean } })
  | (PropertyBase & {
      type: "number"
      config: { format: "number" | "percent" | "currency"; currency: string | null }
    })
  | (PropertyBase & { type: "checkbox"; config: Record<string, never> })
  | (PropertyBase & {
      type: "date"
      config: { includeTime: boolean; allowRange: boolean }
    })
  | (PropertyBase & { type: "select"; config: { options: SelectOption[] } })
  | (PropertyBase & {
      type: "multiSelect"
      config: { options: SelectOption[] }
    })
  | (PropertyBase & {
      type: "status"
      config: { options: StatusOption[] }
    })
  | (PropertyBase & { type: "url"; config: Record<string, never> })
  | (PropertyBase & {
      type: "files"
      config: { mediaOnly: boolean; maxItems: number | null }
    })
  | (PropertyBase & {
      type: "relation"
      config: {
        targetDatabaseId: string
        maxItems: 1 | null
        inversePropertyId: string | null
      }
    })
  | (PropertyBase & {
      type: "formula"
      config: {
        version: 1
        expression: string
        resultType: string | null
        dependencies: string[]
      }
    })
  | (PropertyBase & {
      type: "rollup"
      config: {
        relationPropertyId: string
        targetPropertyId: string
        aggregation:
          | "count"
          | "countNonEmpty"
          | "sum"
          | "average"
          | "min"
          | "max"
          | "earliest"
          | "latest"
          | "unique"
          | "percentChecked"
      }
      // A single registry: crates/amby-core/src/database/rollup.rs (`rollup-aggregations.json`
      // in the UI is checked by a test). What is allowed depends on the field type of the related database;
      // `avg` and `countUnique` are read as `average` and `unique`.
    })
```

Title, Created, Modified, Path, Tags, Backlinks, Word count, Parent and Sub-items
are system fields and are not written as a PropertyDefinition.

### Select options

```ts
interface SelectOption {
  id: string
  name: string
  color: string
}

interface StatusOption extends SelectOption {
  group: "notStarted" | "inProgress" | "done"
}
```

A record stores the option's **name** in the frontmatter (`find_option_id` finds the
option by ID, name or alias), so on renaming the old name
stays in the option's `aliases`: records saved before the rename keep
pointing to the same option. The name always outranks an alias: an alias that matches
the current name of any option is dropped.

The `update_database_property_options` command replaces the list as a whole (IDs
are kept for existing options, new ones get ULIDs), checks the color
(`#rrggbb`), the case-insensitive uniqueness of names and the Status group, and before
writing takes a snapshot of the manifest (`database-schema`). Records are not rewritten:
a deleted option stays in the values as the recorded name and is shown as
an out-of-list value (the validation warning
`missing option is retained as a diagnostic value`), so deleting an option does not
lose data; recreating an option with the same name or restoring the manifest
from the snapshot makes the value ordinary again.

### YAML binding

```ts
interface YamlBinding {
  key: string
  direction: "twoWay"
}
```

A binding is allowed for Text, Number, Checkbox, Date, Select, Multi-select, Status, URL,
Files and Relation. `key` is a non-empty top-level YAML mapping key that is not a
reserved system key; two fields of one database cannot write the same key.
Creating a new binding to a different YAML key requires a preflight of all current rows.

Renaming a property changes only the manifest: the existing binding is preserved
as a whole. If a stored property has no `yamlBinding` yet, on an explicit rename
its previous name is fixed as `key` with the direction `twoWay` in the same atomic
manifest change. Values keep being read and written under the previous key;
Markdown files, including the notes of nested databases, are not rewritten. This is the fixing
of an already used key, not a data migration. Formula and Rollup stay without a YAML
binding. The manifest goes through validation, raw-byte CAS and a snapshot before replacement.

Before writing, a read-only preflight of the current rows of the owning database is performed with the
same resolver the projection uses: if the new name would change the found YAML
value (for example, the legacy fallback disappears with an explicit binding), the operation is
rejected. Nested databases are accounted for through discovery ownership; the main
note of an attached database remains a row of the outer database. Storage keys that match after trim
and ASCII case-fold, including the IDs of other properties, also block a rename. While formulas use
references by name, renaming a field with such dependencies is rejected before
the manifest changes; automatic migration of expressions is a separate task.

### An independent display title for a note

A new record may contain the namespaced frontmatter key `amby-title`. Its
non-empty value takes priority over the first H1/body title and the file name.
A generic `title` is not captured and not changed. Changing `amby-title` does not require
renaming the file; an empty or incorrect value is ignored with
the original bytes preserved.

## 6. Record shard (legacy)

Status: a legacy format; the source of truth for values is the note frontmatter
(section 1.1). Starting with the version after 0.1.9 the following are **neither read nor
executed**: moving shard values into the frontmatter during discovery
(`legacy_records.rs`) and the explicit database migration (`migration.rs`, the commands
`detect/preflight/execute/rollback_database_migration`). Nobody deletes or rewrites the
`.ambd/records/` files. What remains:

- **Writing.** A cell edit (`apply_value_batch`), Relation and row creation do not
  create shards. The only writer is the explicit YAML sync command
  (`yaml_sync.rs`), which stores `yamlSyncBases` in the shard.
- **Projection.** Values are read from the frontmatter; the shard is needed by YAML sync and serves as
  a fallback source only for properties that are not in the frontmatter
  (the frontmatter takes precedence).
- **Diagnostics.** `diagnose_shards` flags orphan shards.
- **The document below** describes the file format; new code must not rely on
  its existence.

```json
{
  "format": "amby-database-record",
  "formatVersion": 1,
  "databaseId": "01K4...",
  "noteId": "01K5...",
  "values": {
    "01PROPERTY...": { "type": "select", "optionId": "01OPTION..." }
  },
  "yamlSyncBases": {}
}
```

The filename must match `noteId`; `databaseId` must match the nearest
owner at the time of active use. The shard of a row moved out of the database
is preserved but is not indexed as an active record.

The absence of a shard means that all database values are empty. An empty shard can be
deleted only if it has no YAML sync base, diagnostics or unknown
fields.

## 7. Property values

```ts
type PropertyValue =
  | { type: "text"; value: string }
  | { type: "number"; decimal: string }
  | { type: "checkbox"; checked: boolean }
  | {
      type: "date"
      start: string
      end: string | null
      timeZone: string | null
    }
  | { type: "select" | "status"; optionId: string }
  | { type: "multiSelect"; optionIds: string[] }
  | { type: "url"; value: string }
  | { type: "files"; items: FileValue[] }
  | { type: "relation"; targetNoteIds: string[] }
```

Rules:

- Number uses a canonical decimal string so that JSON/JavaScript does not lose
  precision; the currency format belongs to the definition.
- Date-only uses `YYYY-MM-DD` and `timeZone: null`; date-time uses an
  ISO-8601 offset and the original IANA timezone when present.
- A date range does not allow `end < start`.
- Option IDs must exist in the definition; a deleted option stays a
  diagnostic value until an explicit conversion.
- Multi-select IDs and relation targets are unique, and the display order is preserved.
- A URL is validated but never opened automatically.
- Formula/rollup values are written neither to the frontmatter nor to the legacy shard.

### Files & media

```ts
interface FileValue {
  assetId: string
  kind: "asset"
  relativePath: string
  name: string
  mimeType: string
  sizeBytes: number
}
```

`relativePath` is resolved from the row's bundle and must stay inside its
`assets/`. A remote URL, an absolute path and `..` are forbidden. Deleting a FileValue does not
delete the asset automatically.

### Relations

In the current native path `update_database_relation_value`, the forward `targetNoteIds`
and the list of the inverse property are written into the YAML of the corresponding notes. These are
mirrored durable values; the inverse list is not yet merely a computed
projection. Value changes and schema changes have separate journals, described below.
A single coordination of schema/values still needs strengthening (P0/F2): changing the schema
of a populated relation must not silently move or delete values.

The two-way **creation** of a property (`create_database_property`,
`propertyType: relation`, `relationTwoWay: true`) requires `operationId` and
the source's `expectedManifestRevision`. For another database, `expectedTargetManifestRevision`
is additionally mandatory; for a self-relation the source revision is used.
The UI gets the current target revision through the storage `listDatabases`
before sending the request; native discovery reads the raw manifest bytes.
Rust first prepares both schemas in memory: it checks the insertion point, locked and
read-only manifests, limits, and conflicts of names, YAML keys and system keys.
A self-relation creates two different properties in one manifest change.

Before the first publish, no-replace raw backups and a version-1 journal
`.amby/recovery/database_relation_schemas/<operationId>.json`
(`format: amby-relation-schema-recovery`) are saved; the backups are in
`<operationId>/<index>.bin`. It stores the request, a fingerprint without
`expectedGeneration`, the database IDs, the manifest paths, pre/post SHA-256, progress and
a result with stable forward/inverse IDs and `manifestRevisions`. An ordinary
one-way property creation does not require an operation ID and uses the previous
single-file path. The format of the Relation value journal is unchanged.

All source manifests are compared before publishing; each file and the journal
are re-checked before writing. An error starts a conditional rollback of only its own
post bytes; external edits are preserved, and an incomplete restore returns
`rollback incomplete`. Completion is recorded before watcher confirmation.
The same ID/payload returns the completed result before the source CAS, with no new
properties or writes; a different payload, or a pending or rolled-back ID, is rejected.
IPC still requires a current `expectedGeneration`: after reactivation
the client changes only the generation in the previous request; the fingerprint excludes it.
A stale generation is rejected for a replay too, preserving the active vault boundary.
A failure before the first journal is published may leave a raw backup directory without
a journal and without manifest changes; a retry with the same ID is then rejected while
preparing the directory. A new attempt needs a new ID. Such copies are preserved
and not deleted automatically; resume/cleanup of this window is not yet implemented.
On activation, an interrupted operation restores the exact raw pre bytes after
checking all pending journals. Journals/backups are not deleted by editor draft
cleanup or an index rebuild. This is the recovery of an unfinished operation, not
a user undo of the property creation.

Configuring an existing Relation and converting a field to/from Relation through
`change_database_property_type` use a version-2 schema journal in the same
namespace. Version-1 creation journals continue to be read without migration.
Version-2 distinguishes the request kind, stores the source property ID and the
`ChangedDatabasePropertyType` result. The request contains `operationId`, the source
`expectedManifestRevision` and `expectedRelatedManifestRevisions` — `databaseId`/`revision`
pairs for the related databases that were read. The UI obtains them through
`listDatabases`. A publication may change up to three manifests: the source, the previous
inverse database and the new inverse database; coinciding databases are merged into one step.

Enabling two-way mode creates the inverse property, including when converting an existing
field and within a single database. Disabling, changing the database and converting from
Relation remove the reciprocal pointer from the former inverse field,
keeping the field itself and its metadata as a one-way relation. An incomplete or invalid
pair is rejected before writing. Topology changes require that the source and inverse fields
have no durable values; automatic backfill or migration of
populated relations is not performed yet. The Markdown, record shards and templates owned by
the database are checked; read errors and malformed YAML block the conversion.
Nested databases are not part of the value check of the outer database. Configuring Relation
preserves the existing YAML binding; type conversion requires removing it.

Version-2 uses the same raw backups, journal/file CAS, conditional rollback,
activation preflight and durable replay as pair creation. The result returns
`inversePropertyId`, `manifestRevisions` and the operation ID. Recovery restores
schemas without rewriting Markdown or values. Unchanged related manifests
are also checked before each write and completion; they are not part of the rollback.
A request without a schema change returns `operationId: null`, creates no journal
and does not reserve the supplied ID. `relationMaxItems: 0` explicitly removes the limit,
`1` sets a single page, and an absent value keeps the previous limit.
Full migration of a populated
relation, user-facing schema undo and a recovery UI remain separate tasks.

A successful Relation change result contains `affectedNotes` — deduplicated
`databaseId`/`noteId` pairs of the pages actually written. They include the source,
the previous targets whose back reference was removed and the new targets whose back
reference was added. Unchanged targets of a one-way relation are not in this list.
`targetNoteIds` describes only the new set of targets. The command uses
`affectedNotes` to immediately update the derived projection of both sides.

A value change request requires a non-empty `expectedRevision` of the source page:
the SHA-256 of the source raw bytes, like `rowRevision` in a query. A mismatch rejects the request
before inverse writes are planned, including a request that does not change the value. A successful
result returns `revisions` (`noteId`, `revision`) for all written pages;
the source is included even when the same value is saved again. The UI queue takes the
revision from the result of the previous write before the query is updated.

Before publication Rust compares the current bytes of all planned notes and the
manifests that were read with the originals. Before each individual write, the checks of its file, path
and manifests are repeated. On error, files that were already published
are restored only if their bytes still match those published by this
operation; later external changes are preserved. An incomplete rollback returns an
error with `rollback incomplete` and the IDs of the affected pages.

When a relation is removed, a missing former target is skipped with a warning:
the inverse value cannot be updated. An ambiguous ID, a read error or an
invalid value of a found target stop the operation before writing. Stored
targets must be canonical uppercase ULIDs (a single `[[ULID]]` pair and
whitespace around the ID are allowed); empty strings, malformed wiki links and other values are
rejected. The request's `targetNoteIds` require canonical uppercase ULIDs. If a target
is not found and part of the catalog could not be read, that is a resolution error, not
proof that the page is absent.

The request and the result now contain a required `operationId` (1–160 ASCII
letters/digits, `-` or `_`). Before the first change to notes, Rust publishes no-replace
raw backups and a version-1 journal
`.amby/recovery/database_relations/<operationId>.json`; the backups are in the adjacent
`<operationId>/<index>.bin`. The namespace is shared across the vault so that the journal covers
both databases. The journal contains the original request, its SHA-256 fingerprint without
`expectedGeneration`, exact vault-relative paths, note/database IDs, pre/post
revisions, per-step status and the expected result. All errors writing backups and the
journal are returned to the caller. The completed result is recorded before session history
and watcher acknowledgement; the outcome and backups are not removed automatically.
Ordinary pre-write snapshots in `.amby/history/` are created earlier and may remain
if journal preparation fails; no session undo entry is added for the failed operation.
These are separate raw recovery points, not a record of a successful operation.

Repeating the same `operationId` with the same payload (except the current generation) returns
the stored result before the source CAS, without rewriting or history. A different
payload with the same ID is rejected. `completed` is a historical result, not a
claim about the current content after external edits, undo or rename. A pending
operation requires recovery; a `rolledBack` ID cannot be used again.

When a vault is opened, after the read-only check of ID migrations and before the index is loaded,
unfinished operations are automatically rolled back to the pre bytes. First, for ALL
pending journals the headers, path uniqueness, confined/no-symlink
paths, backup integrity/identity and the current pre/post revisions are checked. A modified or
deleted file, a corrupted copy, an unsupported version or an unsafe path
block activation without starting recovery. The journal and copies are kept for
conflict resolution. For unknown journal/step fields, preservation
on rewrite applies. Editor draft TTL/quota and SQLite rebuild do not delete this namespace.

Recovery also checks revisions before each restore and records progress
after it. A crash between a restore and the progress update is recognized by the exact pre bytes;
repeated recovery is safe. A write error during recovery may
leave some pages restored, but the pending journal remains for a retry.
If the notes write completed but the completion journal could not be written,
an explicit error is returned; the notes are not declared rolled back and the journal is kept.

A window for an external write remains between the check and the atomic rename; file
locking and cross-process atomicity of CAS are not guaranteed. Automatic resume,
a recovery conflict resolution UI, journal cleanup and the protocol for two-way
property creation remain the next P0 tasks.

## 8. YAML sync base

For each bound property, the record stores the last reconciled
normalized value:

```ts
type YamlSyncBase = { state: "missing" } | { state: "value"; value: PropertyValue }
```

The algorithm compares the current shard value, the current YAML value and the base:

| Shard               | YAML                | Result               |
| ------------------- | ------------------- | -------------------- |
| equals base         | changed             | import YAML          |
| changed             | equals base         | export shard         |
| changed identically | changed identically | accept new base      |
| changed differently | changed differently | field-level conflict |

An invalid YAML type is not converted silently and becomes a conflict. The YAML
envelope is changed only by a lossless splice/writer with a revision check and snapshot.

## 9. View shard

Version 2: an object inside the manifest's `views`. Version 1 also supports `.ambd/views/<view-id>.json`.

```ts
interface DatabaseViewFile {
  format: "amby-database-view"
  formatVersion: 1
  databaseId: string
  viewId: string
  name: string
  layout: "table" | "board" | "list" | "gallery" | "chart"
  openMode: "sidePeek" | "centerPeek" | "fullPage"
  subitemsMode: "nested" | "flat"
  density: "compact" | "default" | "tall" | null
  fields: ViewField[]
  filter: FilterNode | null
  sorts: SortRule[]
  group: GroupRule | null
  manualOrder: string[]
  aggregates: AggregateRule[]
  layoutConfig: LayoutConfig
}
```

The view revision is likewise computed over raw bytes. Changing one view does not change the
revision of the schema or of neighboring views.

### Field references

```ts
type FieldRef =
  | {
      kind: "system"
      field:
        | "title"
        | "created"
        | "modified"
        | "path"
        | "tags"
        | "backlinks"
        | "wordCount"
        | "parent"
        | "subitems"
    }
  | { kind: "property"; propertyId: string }
```

`ViewField` adds `visible`, `width` and `frozen`. The system Title is always
present first, visible and frozen. A missing property reference is preserved and
shown as a diagnostic column.

### Filter AST

```ts
type FilterNode =
  | { kind: "group"; operator: "and" | "or"; children: FilterNode[] }
  | {
      kind: "condition"
      field: FieldRef
      operator: string
      value?: unknown
    }
```

Operators are validated against the field type through a single registry
(`crates/amby-core/src/database/filter_operators.rs`; the UI reads the same list from
`filter-operators.json`, and a test checks that they match). Canonical names: `contains`,
`startsWith`, `equals`, `notEquals`, `greaterThan`, `greaterOrEqual`, `lessThan`,
`lessOrEqual`, `isEmpty`, `isNotEmpty`; the early spellings `is`, `isNot`, `gt`, `gte`,
`lt`, `lte` are read as the canonical ones. "Not equals" includes rows without a value.
The operand `"@currentPage"` is replaced by the backend with the ID of the page on which
the view is shown (the query's `contextPageId`); without a page the query is an error, not "all records".
The frontend does not pass SQL. V1 limits the
AST depth, the number of conditions and the operand size with backend constants.

### Sort/group/order

- A sort contains a FieldRef, a direction and an explicit null placement.
- The backend always appends `(databaseId, noteId)` as a stable tie-breaker.
- Nested mode sorts siblings; Flat mode sorts the overall result.
- Group v1 accepts Status or a single Select.
- Manual order is applied only without active sorts, but is not removed when they
  are enabled.
- Missing note IDs in manual order are preserved for a possible restore; new IDs
  are appended to the end deterministically.

### Layout config

- Table: column borders/row height, the frozen boundary (`frozenBoundary`: the field key up to
  which columns are frozen) and `wrappedFields` (keys of fields with text wrapping).
- Board: group property, card fields, cover visibility.
- List: secondary fields and indentation.
- Gallery: card size, field list and preview source (`property`, `firstImage`,
  `icon`, `none`).
- Chart: chart type, category/measure fields, aggregation and a limit on the number of
  groups. The data comes from a backend aggregate query, not a renderer-side full scan.

An unknown layout/config opens read-only without deleting the payload. Calendar and
timeline are not part of v1 yet: they still lack an agreed range-query and
fictional-time contract.

## 10. Template shard

Version 2: an object inside the manifest's `templates`. Version 1 uses `.ambd/templates/<template-id>.json`.

```json
{
  "format": "amby-database-template",
  "formatVersion": 1,
  "databaseId": "01K4...",
  "templateId": "01K6...",
  "name": "Главный герой",
  "body": "## Внешность\n\n## Характер\n",
  "values": {}
}
```

The template body is UTF-8 Markdown without an `amby-id` frontmatter. Creating a row
assigns a new ID through the ordinary note writer. Template values use the same
PropertyValue contract. Binary media is not embedded in the JSON.

## 11. Recovery and Trash

Relation value mutations use the implemented vault-wide journal from the
[Relations contract](#relations). For the other multi-file mutations, the general
contract `.ambd/recovery/<operation-id>.json` remains a target:

- versioned operation kind;
- exact source/target paths;
- expected raw revisions;
- backup/snapshot paths;
- per-step status;
- final status `planned`, `inProgress`, `completed` or `rolledBack`.

The journal is written and synced before the first change. Resume and rollback are
idempotent and never replace a file that was modified after the operation.

Deleted properties/options/views/templates and legacy shard values are first moved to
`.ambd/trash/` with a restore manifest. Ordinary Markdown notes and bundles
continue to use the vault-local `.amby/trash/`.

## 12. Validation and limits

The backend applies centralized limits to:

- the size of each JSON file and Markdown template;
- the number of properties, views, templates and select options;
- the length of names/text/URLs;
- the number of relation targets and media items;
- the depth/width of the filter AST;
- the size of a batch mutation and a page query.

Exceeding a limit returns a typed error and does not rewrite the source file.
The limit values are fixed after a benchmark baseline and are the same for desktop and
browser contract tests, except for the permitted query page size.

All filesystem paths pass the canonical vault guard. Symlink escape, absolute
paths, traversal, remote resources and executing JSON as JS are forbidden.

## 13. SQLite rebuild

The rebuild proceeds in this order:

1. find valid `ambd.json` files without entering nested `.ambd/`;
2. determine the owning database of each Markdown note by the nearest manifest;
3. load property definitions;
4. load the view/template registries and diagnose missing shards;
5. read values from the frontmatter of the notes owned by the database; a legacy record
   shard is only a fallback source for properties absent from the frontmatter;
6. keep orphan/removed legacy shards outside the active projection;
7. build relations and the inverse projection;
8. match YAML bindings and create conflicts;
9. atomically publish the new index generation.

An unreadable durable file stops the replacement of the previous healthy projection or
isolates only the affected database according to the typed outcome. It is never
treated as confirmed data deletion.

## 14. Migrations

### Layout v1 → v2

`database/layout.rs` performs an explicit upgrade via the notice button. Each
database has a version-1 journal in `.amby/migrations/database-layout-v2/<ULID>/plan.json`
and immutable `N.backup` files with the original bytes and SHA-256. First the
backup copies and the `inProgress` journal are published, then the resource copies, the merged manifest
and the removal of the preserved legacy files. Unknown files and non-empty folders are kept.
`completed` records completion; upgrading an already converted database again
does nothing. Old versions of Amby do not support manifest v2: both devices must
be upgraded.

A publication error triggers a conditional rollback. Before restoring, all
backup copies and the current source/target files are checked. Files modified by someone
are not overwritten: the journal remains for examination. On a repeated press, the unfinished
operation is first rolled back under the same conditions, then a new preflight is run.
Opening the vault itself does not start a rollback. The copies and journal are not deleted after
success and are not synced. To manually roll back a completed operation, one should
stop both programs and sync, check `plan.json` and restore the
originals from `N.backup`; new target files are deleted only if they match
the saved checksums. Markdown is not rewritten by this migration.

### Earlier migrations

- `formatVersion` is monotonic for each file type.
- A read-only preflight lists all future writes.
- Raw backups and a journal are created before any change.
- Resume/rollback are idempotent.
- The outcome is recorded before cleanup of the old format.
- Legacy `Metadata.md` and `.amby/blocks/*.json` are not converted during scan.
- Moving shard values into frontmatter and the explicit database migration were removed after 0.1.9
  (section 6): such files are no longer read as a migration source.
- An existing local `.amby/properties.json` migrates only into local-property
  shards; database values are written directly into the frontmatter of the owning note, not
  into `.ambd/records`.
- A downgrade to a version without support for the new format must not modify durable
  files.

## 15. Next contract

The normalized SQLite schema and versioned IPC types are defined in the
[runtime contract](database-runtime.md). They are a projection of the data above and
do not add sole copies of user values.
