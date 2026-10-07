# Storage boundary map

All frontend vault I/O enters through [../storage.ts](../storage.ts) (facade) and
[index.ts](index.ts). Components must not introduce direct desktop filesystem I/O.

| Concern                                  | Owner                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared adapter API and types             | [port.ts](port.ts), [types.ts](types.ts)                                                                                                                                                                                                       |
| Domain-facing repositories               | [notes-repository.ts](notes-repository.ts), [mutations-repository.ts](mutations-repository.ts), [history-repository.ts](history-repository.ts), [assets-repository.ts](assets-repository.ts), [settings-repository.ts](settings-repository.ts) |
| Tauri implementation                     | [desktop-adapter.ts](desktop-adapter.ts), generated [bindings.ts](../bindings.ts)                                                                                                                                                              |
| Browser implementation                   | [web-adapter.ts](web-adapter.ts), [web-adapter-core.ts](web-adapter-core.ts)                                                                                                                                                                   |
| Browser format/search/tree helpers       | [web-frontmatter.ts](web-frontmatter.ts), [web-search.ts](web-search.ts), [web-tree.ts](web-tree.ts), [web-metadata.ts](web-metadata.ts), [web-history.ts](web-history.ts)                                                                     |
| Database boundary                        | [database-port.ts](database-port.ts), [database-types.ts](database-types.ts)                                                                                                                                                                   |
| Creative project boundary                | [project-port.ts](project-port.ts), [project-types.ts](project-types.ts) (generated types, `ProjectOperationError`)                                                                                                                            |
| Errors, IPC results, path representation | [operation-error.ts](operation-error.ts), [ipc-result.ts](ipc-result.ts), [storage-path.ts](storage-path.ts), [web-storage-error.ts](web-storage-error.ts)                                                                                     |
| Debug operations                         | [debug-repository.ts](debug-repository.ts)                                                                                                                                                                                                     |
| Executable shared contract               | [storage-contract.ts](storage-contract.ts), [storage-contract.test-support.ts](storage-contract.test-support.ts)                                                                                                                               |

Trace a change from repository → port → adapter →
[Rust commands](../../../src-tauri/src/commands/). Update both adapters' supported
behavior explicitly; browser localStorage cannot reproduce native filesystem,
watcher, dialog, history or trash guarantees. Do not infer desktop correctness
from a passing browser fallback test.

Read [vault format](../../../docs/vault-format.md) and
[native storage contract](../../../docs/native-storage-contract.md) for I/O changes.
Command/type changes require Rust Specta annotations, registration and regenerated
bindings through `npm run rust:test`.

Relation requests require the source `expectedRevision` and an `operationId`.
The same ID/payload replays a durable outcome without a second write; a new edit
needs a new ID. Results return raw-byte
`revisions` for the next queued edit. Results include `affectedNotes` as database/note ID pairs from
the successful durable write plan. `targetNoteIds` is the resulting value, not
the complete set of changed pages. Keep generated and domain-facing types aligned.

Two-way Relation property creation requires `operationId` and the source raw
`expectedManifestRevision`; cross-database pairs also require
`expectedTargetManifestRevision`. Read the current target revision through
`listDatabases`, which discovers raw manifest revisions in the native adapter.
The result includes `inversePropertyId` and `manifestRevisions`; replay returns
the same property IDs. Ordinary creation keeps its existing one-file contract.

Existing Relation configuration and conversion to/from Relation use one
`operationId` and `expectedRelatedManifestRevisions` for related databases,
read through `listDatabases`. Results include all written `manifestRevisions`.
The renderer submits one intent; Rust plans and journals reciprocal changes.

Project writes (`createProject`, `createProjectSection`) take an `operationId` per user
intent: repeating the same call returns the recorded answer (`replayed: true`) and never a
second set, and the same ID with another payload is `operationIdReused`. Sections change
the structure file only with the `expectedProjectRevision` the caller last read. Paths in
project results are vault-relative. The browser fallback lists nothing and refuses creation.
See [project backend map](../../../src-tauri/src/project/MAP.md).

Verification: [storage.test.ts](storage.test.ts), focused repository/port tests,
[ipc-vault-scope.test.ts](../ipc-vault-scope.test.ts), and relevant live/native
scenarios from [the tests map](../../../tests/MAP.md).
