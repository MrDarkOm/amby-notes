# Database UI map

Owns database surfaces and view state, not the durable database format. Cross-layer
work continues through [storage](../../../lib/storage/MAP.md) to
[the database backend](../../../../src-tauri/src/database/MAP.md).

| Concern                                 | Owner                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Module registration / top-level surface | [database-module.tsx](database-module.tsx), [database-workspace.tsx](database-workspace.tsx)                                                                                   |
| State and orchestration                 | [database-store.ts](database-store.ts), [use-database-controller.ts](use-database-controller.ts)                                                                               |
| Query lifecycle                         | [use-database-query.ts](use-database-query.ts)                                                                                                                                 |
| Table, cells, value presentation        | [table-view.tsx](table-view.tsx), [database-cell.tsx](database-cell.tsx), [database-value-cell.tsx](database-value-cell.tsx), [database-cell-value.ts](database-cell-value.ts) |
| Board/list/gallery/chart layouts        | [layouts/](layouts/), [chart-view.tsx](chart-view.tsx)                                                                                                                         |
| View configuration                      | [database-view-menu.tsx](database-view-menu.tsx), [database-dialogs.tsx](database-dialogs.tsx)                                                                                 |
| Linked views / navigation               | [linked-view.tsx](linked-view.tsx), [linked-reference.ts](linked-reference.ts), [tab-target.ts](tab-target.ts)                                                                 |
| Note peek and editor ownership          | [database-peek-editor.tsx](database-peek-editor.tsx), [peek/database-side-peek.tsx](peek/database-side-peek.tsx), [peek/editor-surface-lease.ts](peek/editor-surface-lease.ts) |
| Relations / property order              | [relation-picker-popover.tsx](relation-picker-popover.tsx), [relation-config-dialog.tsx](relation-config-dialog.tsx), [property-order.ts](property-order.ts)                   |
| Clipboard / CSV                         | [editing/](editing/)                                                                                                                                                           |

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
