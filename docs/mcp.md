# Amby MCP tools

Run `amby --vault /path/to/vault mcp` as a local stdio MCP server. The process
selects one vault at startup. The default grant is read-only. Use
`--allow-write` for the visible vault or `--allow-write=Projects/` to grant
writes under an existing folder. Reads cover the visible vault in both modes.
Standard output is reserved for JSON-RPC. Tool calls return text containing JSON
for compatibility and provide `structuredContent` for newer negotiated MCP
versions.

## Tools

| Tool                                    | Arguments                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_notes`                          | `query` and optional `limit`                                                                                                                 |
| `list_folder`                           | `path`                                                                                                                                       |
| `read_note`                             | `id` and optional `offset`, `maxChars`                                                                                                       |
| `get_links`                             | `id`                                                                                                                                         |
| `list_archive`                          | None                                                                                                                                         |
| `list_databases`                        | None                                                                                                                                         |
| `read_database`                         | `databaseId`                                                                                                                                 |
| `query_database`                        | `databaseId` and optional `search`, `limit`, `cursor`                                                                                        |
| `list_workshops`                        | None                                                                                                                                         |
| `read_workshop`                         | `workshopId`                                                                                                                                 |
| `read_story`                            | `storyId`                                                                                                                                    |
| `new_note`, `append_note`, `write_note` | `path`, `content` and optional `dryRun`                                                                                                      |
| `rename_item`                           | `path`, `name` (a new stem for a file) and optional `dryRun`                                                                                 |
| `move_item`                             | `path`, `folder` (an existing directory or `.`) and optional `dryRun`                                                                        |
| `archive_item`, `restore_item`          | `path` and optional `dryRun`                                                                                                                 |
| `create_database`                       | `parent`, `name`                                                                                                                             |
| `create_database_row`                   | `databaseId`, `title`                                                                                                                        |
| `rename_database`                       | `databaseId`, `name`, `expectedRevision`                                                                                                     |
| `rename_database_property`              | `databaseId`, `propertyId`, `name`, `expectedRevision`                                                                                       |
| `add_database_property`                 | `databaseId`, `name`, `propertyType`, `expectedRevision` and optional `options`                                                              |
| `set_database_value`                    | `databaseId`, `noteId`, `propertyId`, `expectedRevision`, `operationId`, `value`                                                             |
| `create_database_relation`              | `databaseId`, `targetDatabaseId`, `name`, `inverseName`, `expectedRevision`, `expectedTargetRevision`, `operationId` and optional `maxItems` |
| `set_database_relation`                 | `databaseId`, `noteId`, `propertyId`, `targetNoteIds`, `expectedRevision`, `operationId` and optional `dryRun`                               |
| `create_workshop`                       | `parent`, `name`, `operationId`                                                                                                              |
| `create_story`                          | `workshopId`, `title`, `operationId`                                                                                                         |
| `update_workshop`                       | `workshopId`, `expectedRevision`, `operationId` and at least one of `name`, `tags`                                                           |
| `create_text_page`                      | `storyId`, `title`, `levelId`, `orderKey` and optional `parentNoteId`, `formatId`                                                            |
| `create_workshop_section`               | `workshopId`, `name`, `expectedRevision`, `operationId`                                                                                      |

Use the note ID from `search_notes` or `list_folder` for `read_note` and `get_links`.
Paths are vault-relative. `restore_item` takes an archive-relative path from
`list_archive`. For a root-level creation pass `parent: "."`. The database and
workshop tool results include stable IDs. `read_database` returns the manifest
revision, and `query_database` returns a raw revision for each row. Use the
revisions returned by the read tools when making conditional writes.

Database renames update the display name in the manifest. Property renames
keep the key used by stored values. Workshop updates change the name and tags
in the workshop marker. To create a manuscript page, use the level and format
IDs from `read_story`. An `orderKey` contains 1–64 ASCII letters or digits and
controls the page order within its parent.

## Workspace modules

Database and workshop tools are listed only while their workspace modules are
enabled. Workshop tools require both Creative and Databases. A Standard
workspace with no saved module settings starts with Databases enabled and
Creative off. If a client still has a tool cached after deactivation, its next
call returns `moduleDisabled`. Re-list the tools after changing modules.
A delegated mutation also checks the desktop database runtime.

## Database relations

`create_database_relation` creates a reciprocal pair of properties. Pass the
latest manifest revisions from `read_database` for both databases. For a
self-relation, pass the same revision twice. `maxItems: 1` limits the forward
property to one target. When omitted, the property can hold multiple targets.

`set_database_relation` replaces the target note IDs for an existing Relation.
Pass an empty list to unlink all targets from the source row. The preview
returns the exact record paths that will be written, including inverse values
that will be removed. Source and inverse writes require membership in the
grant. A one-way relation writes the source value and still validates the
requested targets. When any record would be written outside the grant,
preview and publication return `outsideWriteScope`.

Both operations use the existing Relation journals. Repeating a completed
request with the same `operationId` and arguments returns its previous result.
Use the revisions returned by the mutation for the next change.

## Write grants and previews

A preview returns `affectedPaths`, including the moved folder or file and any
files that would be rewritten. A folder entry represents the whole subtree.
Preview and publication both check the full plan against the grant. A rename
that requires an inbound link rewrite outside the folder returns
`outsideWriteScope`. The operation is prepared again under the writer lock at
publication, so intervening edits cannot make a preview grant wider access.

A folder grant also covers database and workshop writes in that folder.
Database values accept the typed [property value format](database-format.md#7-property-values)
or `null` to clear a value. Supported property additions and edits cover text,
numbers, checkboxes, dates, URLs, Select, Multi-select and Status.
`create_workshop` creates the starter sections, and `create_workshop_section`
creates a custom section. Journaled writes use a client-supplied
`operationId`. Retry the same request with the same ID, and use a fresh ID after
changing its arguments.

Read tools use a read-only catalog or an ephemeral in-memory projection. Row
queries use 25 rows by default and at most 100 per page. Pass `nextCursor` back
as `cursor` to continue. Catalogs return up to 100 entries and mark truncation.
Complex writes use a bounded request and a bounded affected-path preview.
Clients should inspect the tool error field. Common codes include
`accessDenied`, `outsideWriteScope`, `revisionConflict`, `operationIdReused`,
`vaultNotActive`, `recoveryRequired` and `desktopRequestInterrupted`.

When desktop Amby owns the lease, complex operations use the
[local IPC endpoint](cli-ipc.md). The app validates the active vault and the
tool's grant again before publishing. Simple note edits retain the existing
external-edit workflow. An interrupted request with an unconfirmed result is
never automatically executed twice.
