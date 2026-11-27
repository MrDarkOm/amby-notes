# Amby AI agent action catalog

Status: catalog draft; the agent adapters are not implemented yet. Version: 1.
Inventory date: 2026-09-30, working tree with uncommitted changes.

Related documents: [contract](ai-harness.md), [journal](ai-state-format.md),
plan, orchestration,
acceptance.

## 1. How to read the catalog

This is a starter map of domain families, not a finished inventory of every
menu item. H-00 reconciles it with the real UI and native IPC, and adds input/output,
exact schemas, tests and gaps. H-01 pins every name/schema version. Until the
corresponding gate is passed, all new agent actions with the status `M`
remain `missingImplementation`, even if the app already has a similar
method. This document does not register tools and does not change app permissions.

Statuses: `M` — `missingImplementation`; `U` — `requiresUserInteraction`;
`B` — `blockedByPolicy`; `I` — `implemented` with evidence, not assigned to any
row yet. The runtime returns the full status, the reason, and module/capability versions.
Listing several action IDs in one row merges only the documentation; each
command gets its own closed schema. No wildcard tools are created.

`R`/`W` below are logical reads/changes of resources. Physical sidecars,
locks and snapshots are defined by the adapter, according to the shared metadata contract.
The word "undo" denotes the required future guarantee, not an assessment of the current UI undo.

## 2. Current integration points

| Basis            | Verified interface/path                                                                                                                | Limitation for the agent                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Storage boundary | [StoragePort](../src/lib/storage/port.ts), [DesktopAdapter](../src/lib/storage/desktop-adapter.ts)                                     | Do not hand the raw port to the model; scope and actor are needed in Rust           |
| Notes            | [commands/notes.rs](../src-tauri/src/commands/notes.rs), `readNote`, `writeNote`                                                       | Revision/generation exist; add a grant, a durable operation ID and an editor bridge |
| Structure        | [commands/mutations.rs](../src-tauri/src/commands/mutations.rs), bundle operations                                                     | Compute the whole effect closure and shared undo                                    |
| Databases        | [DatabasePort](../src/lib/storage/database-port.ts), [commands/database.rs](../src-tauri/src/commands/database.rs)                     | The existing API does not prove scoped query/aggregate and agent recovery           |
| History          | [commands/history.rs](../src-tauri/src/commands/history.rs)                                                                            | Journal pins and scoped access to old snapshots are needed                          |
| Boards           | [canvas-format.ts](../src/lib/canvas-format.ts), [sketch-format.ts](../src/lib/sketch-format.ts)                                       | A codec is not a headless command API; respect the source envelope                  |
| Settings         | [app-config.ts](../src/components/workspace/app-config.ts), [settings repository](../src/lib/storage/settings-repository.ts)           | Raw JSON writes and frontend queues do not replace backend key-level policy/CAS     |
| Themes           | [themes.ts](../src/lib/themes.ts), [theme preferences](../src/themes/preferences.ts)                                                   | Only validated data and supported values                                            |
| Modules          | [SDK](../src/lib/modules/host/sdk.ts), [types](../src/lib/modules/types.ts), [package_manager.rs](../src-tauri/src/package_manager.rs) | Check runtime isolation and installer/registry alignment                            |

## 3. Catalog and allowed reads

| Proposed actions                                     | Basis                           | Scope and result                                                       | Package; status |
| ---------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- | --------------- |
| `app.capabilities.list`, `app.capabilities.describe` | New registry                    | Only available descriptors, limitations and versions                   | H-10/H-12; M    |
| `workspace.tree.list`                                | `listFiles`                     | R of the selected subtree; scoped children/counts, cursor              | H-20; M         |
| `note.read`, `note.metadata.get`                     | `readNote`, `getNoteMetadata`   | R note; source revision, bounded chunks; no auto-includes of neighbors | H-11/H-20; M    |
| `workspace.search`                                   | `searchNotes`                   | R scope before ranking/snippets/limit; query budget                    | H-20/H-32; M    |
| `workspace.tags.list`, `workspace.links.query`       | `listTags`, `getLinkGraph`      | Scoped tags, edges and counts, both sides of a link are allowed        | H-20/H-40; M    |
| `history.list`, `history.diff`                       | Snapshots + new journal API     | R of the history of specific resources; re-check after revoke          | H-24; M         |
| `run.inspect`, `run.changes.list`                    | New runtime/journal             | Scope per each event/receipt, resumable cursor                         | H-24/H-31; M    |
| `settings.describe`, `settings.get`                  | App config + new typed registry | Only allowed keys, type/default/effective scope                        | H-44/H-45; M    |

Historical versions and snippets do not get broader rights than live
resources. When a note is moved to a forbidden section, the old note ID does not keep
access. The catalog does not reveal the names of private installed projects/skills.

## 4. Notes, tree, links, attachments

| Proposed actions                                                                  | Current basis                                                             | Scope, effects and required undo                                                               | Package; status |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------- |
| `note.create`                                                                     | `createNote` + coordinated content write                                  | W parent; no-replace, host ID; undo of an untouched object via archive                         | H-11; M         |
| `note.patch`, `note.replace`                                                      | `readNote`/`writeNote`                                                    | R/W note, exact revision; snapshot after the user's flush; lossless source patch               | H-11; M         |
| `folder.create`                                                                   | `createFolder`                                                            | W parent; undo only of an empty/unchanged created structure                                    | H-40; M         |
| `item.rename.preview`, `item.move.preview`                                        | the Rust link-rewrite plan (IPC previews removed 2026-11-22)              | R of the allowed closure; safe refusal when backlinks are closed                               | H-40; M         |
| `item.rename`, `item.move`                                                        | `renameItem`, `moveItem`                                                  | W source/destination + rewritten links/metadata; inverse domain plan                           | H-40; M         |
| `item.archive`, `archive.restore`                                                 | `archiveItem`, `restoreTrash`                                             | W of the whole bundle; ID manifest, conflict-safe restore; current rights are mandatory        | H-40; M         |
| `item.systemTrash`                                                                | `deleteItem`                                                              | External OS effect, restoration through the OS; `manualExternal`                               | H-40; U         |
| `note.properties.get`                                                             | `getNoteProperties`                                                       | R note; scoped logical sidecar projection                                                      | H-40; M         |
| `note.property.set`, `note.property.remove`, `note.properties.reorder`            | `upsertCustomProperty`, `deleteCustomProperty`, `reorderCustomProperties` | W note properties; logical field inverse, shared sidecar CAS                                   | H-40; M         |
| `note.tags.patch`, `note.links.patch`                                             | A common lossless adapter over source/frontmatter is needed               | R/W note; preserve label/unknown syntax; do not serialize UI controls                          | H-40; M         |
| `note.icon.set`                                                                   | `use-view-state-store`, `icon-values`                                     | W metadata of a specific object; typed `IconValue`, field undo                                 | H-40/H-45; M    |
| `note.layers.list`, `note.layer.create`, `note.layer.attach`, `note.layer.unlink` | `noteLayers`, `createLayer`, attach/unlink APIs                           | Bundle closure; identity/paths/metadata, reversible domain step                                | H-40; M         |
| `note.layer.archive`                                                              | There is no safe operation yet; `deleteLayer` uses system trash           | W of the layer and bundle metadata; an internal archive/restore is needed                      | H-40; M         |
| `asset.importBytes`, `asset.attach`                                               | `importAssetBytes`, existing note/bundle logic                            | W destination and referencing document; scoped input handle, MIME/size; shared assets are kept | H-40; M         |
| `history.restore`                                                                 | `restoreSnapshot`                                                         | W live resource; snapshot before restore, expected revision                                    | H-23/H-40; M    |

`note.create` with content is one logical step with recovery for the interval between
creating and filling the file. A leftover empty note is not counted as full
success. If a lossless structured patch cannot find an unambiguous fragment,
a diagnostic/preview is returned, not a mass re-serialization of the document.

`asset.importBytes` receives bounded data or a host-issued input handle.
An arbitrary absolute `sourcePath` is not set by the model. The system picker
can issue a handle for a file chosen by the user; a grant for a whole directory does not arise.

### 4.1 Discrepancy between the current deletion contracts

The project rules and [data-safety-contract](data-safety-contract.md) define vault-local
restorable deletion. The [current vault-format](vault-format.md) and the verified
`delete_item`/`archive_item` in the working tree distinguish system trash from internal
archive. H-00 must record this discrepancy before implementation. This
draft uses different action IDs and does not declare the current OS deletion
automatically reversible. These documents do not change the deletion implementation and do not
override the repository instructions.

## 5. Databases and views

The authoritative row values live in Markdown frontmatter; the schema and views live in a
durable manifest/`.ambd/`; SQLite is a rebuildable projection. Legacy shards
and the read fallback are described in [database format](database-format.md); do not
migrate them on your own "for the agent's convenience".

| Proposed actions                                                                      | DatabasePort methods / gap                                          | Scope, check and undo                                                          | Package; status |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- |
| `database.list`, `database.describe`                                                  | `listDatabases`, `getDatabaseNoteContext`                           | R schema and allowed rows; do not expose private totals                        | H-41; M         |
| `database.query`, `database.aggregate`                                                | `queryDatabase`, `aggregateDatabase`                                | Policy before computing relation/rollup/count; bounded query                   | H-41; M         |
| `database.create`, `database.rename`                                                  | `createDatabase`, `renameDatabase`                                  | W parent/container; attached/standalone, durable manifest inverse              | H-41; M         |
| `database.property.create`, `database.property.rename`, `database.properties.reorder` | The corresponding create/rename/reorder methods                     | W schema; stable propertyId/storageKey; revision-based inverse                 | H-41; M         |
| `database.property.changeType`, `database.property.delete`                            | `changeDatabasePropertyType`, `deleteDatabaseProperty`              | W schema + all changed rows; preview of losses/conversions; backups            | H-41; M         |
| `database.values.patch`, `database.relation.set`                                      | `applyDatabaseValueBatch`, `updateDatabaseRelationValue`            | R/W specific cells/notes, R relation targets, inverse of the whole batch       | H-41; M         |
| `database.row.create`, `database.asset.import`                                        | `createDatabaseRow`, `importDatabaseAsset`                          | W parent/row/assets; coordinated IDs and archive undo                          | H-41; M         |
| `database.view.get`, `database.view.create`, `database.view.update`                   | `getDatabaseView`, `createDatabaseView`, `updateDatabaseViewConfig` | R/W view and schema; allowed layout/filter/sort/group types                    | H-41; M         |
| `database.view.rename`, `database.view.duplicate`, `database.view.delete`             | DatabasePort methods of the same names                              | W view/order/default references; multi-file inverse                            | H-41; M         |
| `database.views.reorder`, `database.view.setDefault`                                  | `reorderDatabaseViews`, `setDefaultDatabaseView`                    | W manifest, expected revisions, logical inverse                                | H-41; M         |
| `database.yaml.sync`, `database.yaml.resolveConflict`                                 | `syncDatabaseYaml`, `resolveDatabaseYamlConflict`                   | W exact keys; explicit conflict resolution, dirty bridge                       | H-41; M         |
| `database.template.create`, `database.template.update`, `database.template.apply`     | The DatabasePort as read has no full API                            | A common domain contract and an inventory of the actual templates are required | H-41; M         |
| `database.linkedView.create`, `database.pageLayout.update`                            | A separate development plan; current support is not confirmed       | First an implemented module API, a scoped source and durable metadata          | H-41; M         |

The standard `undoDatabaseMutation`/`redoDatabaseMutation` are not called as "undo
the last one" without identity: the last step may turn out to be the user's. H-41
ties domain history to the harness operation IDs or uses its own verified
inverse adapter. Two independent undo mechanisms must not undo one operation
twice or lose intermediate user changes.

All layouts and property types are listed by the current module descriptor. New
capabilities from the databases plan appear
in the catalog after they are implemented and verified. A mandatory scenario cannot be closed
with a "table view" instead of another requested layout without the user's decision.

## 6. Canvas and Excalidraw

Align with the unified board plan.
One renderer does not mean one format: `.canvas` and `.excalidraw` keep
their own sources and limitations. The proposed external `board` family uses
a common command service and separate codec adapters; the old Canvas UI does not become
a second independent implementation of the agent commands.

| Proposed actions                                               | Basis/gap                                      | Scope, result and undo                                                                | Package; status   |
| -------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| `board.create`, `board.read`                                   | `createCanvasFile`, `createSketchFile`, codecs | Format set explicitly; R/W board parent/source; no UI mount                           | H-42/H-43; M      |
| `board.card.insert`, `board.card.update`, `board.card.remove`  | Common commands from the board plan            | W scene, R embedded notes/assets; stable element IDs, snapshot/inverse                | H-42/H-43; M      |
| `board.edge.connect`, `board.edge.update`, `board.edge.remove` | A headless domain service is required          | W scene; valid endpoints/bindings; a geometric link is not a database relation        | H-42/H-43; M      |
| `board.elements.patch`, `board.elements.duplicate`             | Sketch/Canvas codec + domain validator         | W selected elements, unknown fields of the others are preserved                       | H-42/H-43; M      |
| `board.group`, `board.ungroup`, `board.layout`                 | Shared grouping/layout commands                | W explicit selection; finite geometry, bounded cost, deterministic seed               | H-42/H-43; M      |
| `board.drawing.add`                                            | Excalidraw-only shapes/text/arrows             | W `.excalidraw`; `.canvas` returns unsupportedCapability                              | H-43; M           |
| `board.card.convertToNote`                                     | Composite note+board domain command            | W parent + scene; note creation and card replacement are coordinated, dependency undo | H-40/H-42/H-43; M |
| `board.validate`, `board.preview`                              | Headless validation/render bridge              | R scene and all sources included in the preview; results with revisions               | H-42/H-43; M      |
| `board.export`                                                 | The export pipeline needs an inventory         | R scene, W scoped destination or user-picked handle; no silent conversion             | H-42/H-43; M      |

Preview checks missing targets, finite coordinates, bounds, bindings and
legibility. The model does not get a screenshot with inaccessible note cards. Without rights
to the source embed, a neutral placeholder is shown without cached text.
An external URL in a card does not grant the right to perform a network fetch.

If the requested drawing cannot be expressed in the source format, the preview offers
an explicit creation/conversion of a copy. Opening a `.canvas` does not turn it into
an `.excalidraw`. Preservation of unknown JSON/opaque fields is verified with the real codecs.

## 7. Settings and appearance

`settings.patch` accepts a finite list of typed keys and expected presence/value
revisions. It does not accept a JSON file name, an arbitrary JSON pointer or the full
`prefs`. The backend refuses on an unknown key/value; normalizing invalid
input to defaults is not used as a successful execution of an agent command.

### 7.1 Proposed initial allowlist

The table lists the actually observed `AppPreferences` keys, stored globally
in `settings.json`. Workspace override support is not assumed automatically.

| Keys                                                | Values/limitations                                                | Rights and package       |
| --------------------------------------------------- | ----------------------------------------------------------------- | ------------------------ |
| `prefs.theme`                                       | `system` or an existing valid theme ID                            | Global appearance; H-44  |
| `prefs.accent`                                      | `violet`, `sky`, `teal`, `emerald`, `amber`, `rose`               | Global appearance; H-44  |
| `prefs.fontSize`                                    | Percent, 80–130 (`fontScale` follows it for older builds)         | Global appearance; H-44  |
| `prefs.fontFamily`                                  | `system`, `sans`, `serif`, `mono`                                 | Global appearance; H-44  |
| `prefs.density`                                     | `comfortable`, `compact`                                          | Global appearance; H-44  |
| `prefs.rainbowTree`, `prefs.treeGuides`             | Boolean                                                           | Global appearance; H-44  |
| `prefs.language`                                    | The registry of supported app languages                           | Global language; H-45    |
| `prefs.tooltipDelayMs`                              | Limits of the current typed registry                              | Global interaction; H-45 |
| `prefs.editor.defaultViewMode`                      | `source`, `live`, `read`; live does not bypass the lossless guard | Global editor; H-45      |
| `prefs.editor.contentWidth`                         | `normal`, `wide`, `full`                                          | Global editor; H-45      |
| `prefs.docks.leftPinned`, `prefs.docks.rightPinned` | Boolean                                                           | Global layout; H-45      |

All allowlist rows still have the status M. The remaining settings are inventoried
by H-45: absence from the initial list must have a reason and an explicit status in the
runtime catalog. A global effect is always indicated to the user, even if the
run is limited to a folder. A requirement of "only this section" does not grant a global settings grant.

| Actions/area                                                        | Basis and contract                                                                       | Package; status   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `theme.list`, `theme.create`, `theme.update`, `theme.select`        | Validator token allowlist; a new user copy, built-ins immutable; no CSS/JS/remote assets | H-44; M           |
| `workspace.layout.patch`, `workspace.session.patch`                 | `WorkspaceConfig`, `SessionFile`, existing stores; typed per-object keys, revision/undo  | H-45; M           |
| `workspace.tabs.open`, `workspace.tabs.close`, `workspace.navigate` | Existing tabs/actions; transient with an optional persisted session; dirty close guard   | H-45; M           |
| `module.describe`, `module.setEnabled`                              | Module host + database module state; enabling does not grant new permissions             | H-45; M           |
| `prefs.editor.autosaveMs`, startup/window/shortcuts settings        | Bounds, lifecycle impact, individual key policy and native checks are needed             | H-45; M           |
| Provider profiles/endpoints, credentials, network grants            | A trusted user form; model secrets are not returned                                      | H-30/H-45; U      |
| Security, journal/retention policy, agent budgets/grants            | Host control plane; the agent does not change its own rights                             | H-20/H-24/H-31; B |
| Updater, debug logs, experimental flags                             | A separate user flow; not part of the appearance grant                                   | H-45; U           |

A request to set an arbitrary installed font is not considered supported:
the current model provides four font families. Extending the list requires
a separate domain/UI contract and tests, not writing an unknown string.
Undo of a setting restores the key with regard to the absence of a value and inheritance;
a new value of a neighboring key is not lost on a shared file write.

## 8. Skills, learning, plugins and run control

| Proposed actions                                                         | Contract                                                                           | Package; status   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------- |
| `skill.list`, `skill.read`, `skill.propose`                              | Scoped metadata/content; pinned digests; a proposal does not activate the skill    | H-50/H-51/H-52; M |
| `skill.evaluate`, `skill.activate`, `skill.rollback`                     | Host-owned evaluation; exact candidate hash, ownership and activation policy       | H-61/H-63; M      |
| `memory.query`, `memory.propose`                                         | Typed provenance; fact/preference/inference are distinguished                      | H-62; M           |
| `learning.extract`, `learning.evaluate`                                  | Runtime service jobs with a separate budget; not an unbounded recursive agent tool | H-60/H-61; M      |
| `plugin.project.create`, `plugin.project.read`, `plugin.project.patch`   | Only the granted project namespace; source versioning/undo                         | H-71; M           |
| `plugin.build`, `plugin.test`, `plugin.preview`                          | Trusted fixed runner; synthetic profile, no arbitrary shell/network                | H-71/H-72; M      |
| `plugin.install`, `plugin.activate`, `plugin.rollback`, `plugin.disable` | Exact artifact + permissions; user gate for expansion, registry/recovery agreement | H-73; M           |
| `plugin.uninstall`                                                       | Keep data by default; separate cleanup with a preview                              | H-73; M           |
| `run.undo.preview`, `run.undo.apply`                                     | Dependency closure, current grant, inverse revisions; separate receipts            | H-23/H-24; M      |
| `run.stop`, `run.resume`                                                 | Trusted user controls; pending writes are reconciled first                         | H-31/H-33; U      |

Learning services are invoked by the host according to the user's setting. A skill cannot
activate a new version by itself or arbitrarily run the evaluator thousands of times.
Service operations are visible in the journal, but not all of them are tools available to the model.

## 9. Intentional boundaries

| Capability                                                                      | Status and reason                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Arbitrary `readFile`/`writeFile`, `readGlobalRaw`/`writeGlobalRaw`              | B: bypass of typed adapters, policy, invariants and undo                                |
| Shell/process/native code of the app                                            | B: outside the SDK of the workshop and the user's space                                 |
| Choosing a vault/system file, entering an API key                               | U: a trusted OS/credential flow issues a specific handle                                |
| Permanent purge, clearing AI audit/undo snapshots                               | U: user control plane, preview of irreversible consequences                             |
| Arbitrary sending of data, publishing, clipboard/external open                  | B under an ordinary grant; a separate explicitly allowed connector contract is required |
| Changing others' metadata in `.obsidian/`, `.git/` and arbitrary `.amby/` files | B: domain operations work only with their own declared metadata                         |
| Vault ID migration, backup recovery, index rebuild                              | U by default: domain maintenance, own recovery contracts                                |

An internal index refresh after a mutation is a host effect and is reflected in the receipt.
It does not allow the model to start a migration of source data. A full rebuild command
must not reveal the names/errors of closed objects through progress.

## 10. Catalog extension rule

For every new module, including the creative module,
the implementation provides a domain descriptor, source-of-truth, typed operations,
scope resolver, preconditions, verifier, undo/recovery and acceptance evidence.
Only after that does the new capability appear in the agent catalog.
An agent's request to "enable the module" does not make a planned feature implemented.

H-00/H-46 maintain a coverage ledger: user action → domain operation → agent action →
permission → inverse → scenario → evidence. For irreversible/manual actions
an honest exception is recorded; for mandatory scenarios `missingImplementation`
blocks the corresponding gate. The preparation of this catalog draft is not
evidence of the ledger's completeness.
