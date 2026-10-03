# Database UI map

Owns database surfaces and view state, not the durable database format. Cross-layer
work continues through [storage](../../../lib/storage/MAP.md) to
[the database backend](../../../../src-tauri/src/database/MAP.md).

| Concern                                  | Owner                                                                                                                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module registration / top-level surface  | [database-module.tsx](database-module.tsx), [database-workspace.tsx](database-workspace.tsx)                                                                                                                                     |
| State and orchestration                  | [database-store.ts](database-store.ts), [use-database-controller.ts](use-database-controller.ts)                                                                                                                                 |
| Query lifecycle                          | [use-database-query.ts](use-database-query.ts)                                                                                                                                                                                   |
| Table, cells, value presentation         | [table-view.tsx](table-view.tsx), [database-cell.tsx](database-cell.tsx), [database-value-cell.tsx](database-value-cell.tsx), [database-cell-value.ts](database-cell-value.ts)                                                   |
| Board/list/gallery/chart layouts         | [layouts/](layouts/), [chart-view.tsx](chart-view.tsx)                                                                                                                                                                           |
| Schema-aware value presentation          | [value-format.ts](value-format.ts), [property-value.tsx](property-value.tsx), [layouts/gallery-cover.tsx](layouts/gallery-cover.tsx), [layouts/cover-resolver.ts](layouts/cover-resolver.ts)                                     |
| View configuration                       | [view-settings-panel.tsx](view-settings-panel.tsx), [database-view-menu.tsx](database-view-menu.tsx), [database-dialogs.tsx](database-dialogs.tsx)                                                                               |
| Embedded views / navigation              | [database-view-host.tsx](database-view-host.tsx), [embedded-view-model.ts](embedded-view-model.ts), [database-navigation.ts](database-navigation.ts), [linked-reference.ts](linked-reference.ts), [tab-target.ts](tab-target.ts) |
| Note peek and editor ownership           | [database-peek-editor.tsx](database-peek-editor.tsx), [peek/database-side-peek.tsx](peek/database-side-peek.tsx), [peek/editor-surface-lease.ts](peek/editor-surface-lease.ts)                                                   |
| Relations                                | [relation-picker-popover.tsx](relation-picker-popover.tsx), [relation-chip.tsx](relation-chip.tsx), [use-relation-candidates.ts](use-relation-candidates.ts)                                                                     |
| Relation data                            | [use-record-references.ts](use-record-references.ts), [relation-settings.tsx](relation-settings.tsx)                                                                                                                             |
| Property order                           | [property-order.ts](property-order.ts)                                                                                                                                                                                           |
| Value writes (table and info panel)      | [use-property-mutation.ts](use-property-mutation.ts)                                                                                                                                                                             |
| Property options                         | [option-cell.tsx](option-cell.tsx), [property-config-editor.tsx](property-config-editor.tsx), [property-settings-ui.tsx](property-settings-ui.tsx)                                                                               |
| Property settings editor                 | [reorderable-row.tsx](reorderable-row.tsx), [property-options-dialog.tsx](property-options-dialog.tsx), [option-model.ts](option-model.ts)                                                                                       |
| Rollup wizard / computed cells           | [rollup-model.ts](rollup-model.ts), [rollup-wizard.tsx](rollup-wizard.tsx), [rollup-settings.tsx](rollup-settings.tsx), [rollup-aggregations.json](rollup-aggregations.json)                                                     |
| Saved view settings                      | [view-config.ts](view-config.ts), [use-saved-view.ts](use-saved-view.ts), [use-view-query-state.ts](use-view-query-state.ts), [legacy-hidden-properties.ts](legacy-hidden-properties.ts)                                         |
| Filter / sort editors and operator table | [view-filter-editor.tsx](view-filter-editor.tsx), [view-sort-editor.tsx](view-sort-editor.tsx), [filter-editor-model.ts](filter-editor-model.ts), [filter-operators.json](filter-operators.json)                                 |
| Board lanes and chart data               | [use-board-lanes.ts](use-board-lanes.ts), [board-lanes-view.tsx](board-lanes-view.tsx), [chart-view.tsx](chart-view.tsx)                                                                                                         |
| Icons / board columns prompt             | [board-group-prompt.tsx](board-group-prompt.tsx), [page-icon.tsx](page-icon.tsx), [view-icon.tsx](view-icon.tsx), [icon-picker-button.tsx](icon-picker-button.tsx)                                                               |
| Clipboard / CSV                          | [editing/](editing/)                                                                                                                                                                                                             |

Gallery, List and Board cards show values through `value-format.ts`: schema order,
option names/colors, Relation titles from the caller (a neutral pending chip when
unknown), at most three non-empty properties, never option/note IDs or file paths.
Board lanes come from the Select/Status options (empty lanes included); values of a
removed option keep their own lane. Gallery covers resolve through the batched
`resolveDatabaseAssetPaths` command and load lazily; a missing or broken image
leaves a placeholder. Keep durable paths out of the renderer.

Relation pickers search the whole target database on the backend
(`searchRelationCandidates`, keyset paging) and name selected or stored pages through
`resolveRecordReferences` (batched, `use-record-references.ts`); never name a link from
a loaded search page and never treat a failed search as an empty list (it would offer
a duplicate page). Table cells and the info panel write through one hook,
`use-property-mutation.ts`: per-row queue shared by all editors, the latest returned
revision, one operation ID per action, Relation via its own command. Side peek has no
property editor of its own; the info panel edits the open note's properties.

Persisted view settings (column widths, wrapping, frozen column, hidden fields, filter,
sorts, card properties and gallery card size) live in the view document and are
written only by `useSavedView`: local apply at once, debounced write, and a conflicting
write is re-applied on top of the newer document, so settings changed in two windows
both survive. Search and selection stay session state. Queries receive the saved
filter and sorts as `filter`/`sorts` over an inline source, never as a saved-view source,
so a result never waits for the projection to catch up with a save. Operators come from
`filter-operators.json`, which a Rust test keeps equal to the backend registry; a saved
filter the editor cannot show (OR, nested groups) is kept intact and can only be reset.
Board lanes take counts from one aggregate and page each lane on its own; the chart
aggregates with the same filter and search and recounts on projection changes.

An `amby-db` block is a `DatabaseViewHost`: it reads the shared saved view (layout, filter, sorts,
card properties, widths) and never writes it. The embedding owns only what its reference
states, a `layout` and an extra `filter`, both saved back into the block's fence. Both filters
must hold. The `@currentPage` filter operand is replaced by the backend with the page the
view sits on (the note ID from the editor's asset context); without a page it is an error,
never match-all. Creating a record from a view whose filter ties a relation to the current
page also links the new record to that page, and says so when another condition may still
hide it. Rows and databases open through `database-navigation.ts`, which the workspace
registers. Rollup (relation → field → function) offers only combinations the backend
registry allows; computed cells show zero, "no data" and a failed calculation differently.

Cards of Gallery, Board and List are `CardSurface` elements (`div role=button`): a click or
Enter on the card opens the record, while keys and clicks inside a property control stay in the
control. Pass `cardEdit` to make card properties editable with the same `DatabaseCell`s as the
table; Select/Status/Multi-select use `OptionCell`. How a record opens (`sidePeek`,
`centerPeek`, `fullPage`) is the view's `openMode`; the peek shows the record's properties
above its note.

A database row identifies a note; peek must share document/save ownership with
the workspace. Keep query and mutation state in the controller/store. Do not
parse durable files or duplicate backend validation in a second persistence path.

The existing row mutation queue passes the last returned source revision to both
Relation and ordinary value edits. Each queued action owns one operation ID;
reuse it only when retrying that same payload. Keep this revision override in the queue; a
stale query response must not reset the revision of a completed write.

The property-create action reads the target manifest revision through storage
and gives each reciprocal Relation creation one operation ID. Source and target
schemas are validated and journaled by Rust; do not publish the inverse property
from the renderer or create a second schema state owner.

Relation configuration/type conversion likewise owns one operation ID and reads
the related raw revisions through storage. Keep the current reciprocal target
and requested target distinct when retargeting; Rust coalesces all schema writes.
Type/target changes omit limit and two-way overrides to preserve existing settings.
Unlimited Relation cardinality is an explicit setting, not omission of the current limit.

Read the relevant sections of [frontend design](../../../../docs/database-frontend.md)
and [user flows](../../../../docs/database-user-flows.md), checking document status
against implementation. These design documents include intended behavior; tests
and current code establish what is available. Use colocated store, query, cell,
linked-reference, clipboard, layout and editor-lease tests for the changed concern.
