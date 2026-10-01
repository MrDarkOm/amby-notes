# Save, recovery and conflict map

Use this route for lost edits, stale dirty flags, vault switches and external edits.
Read [vault format](../../../../docs/vault-format.md) before changing persistence.

| Stage                                    | Owner                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor callbacks, save scheduling        | [use-markdown-autosave.ts](../file-actions/use-markdown-autosave.ts)                                                                                                         |
| Per-document save coordination           | [autosave-coordinator.ts](autosave-coordinator.ts)                                                                                                                           |
| Flush/cancel across lifecycle boundaries | [autosave-lifecycle.ts](autosave-lifecycle.ts)                                                                                                                               |
| Shared document buffers / dirty versions | [use-doc-store.ts](../use-doc-store.ts), [document-buffer-lifecycle.ts](../document-buffer-lifecycle.ts)                                                                     |
| Initial/recovery loading                 | [use-document-loading.ts](../file-actions/use-document-loading.ts), [markdown-recovery-load.ts](../markdown-recovery-load.ts), [recovery-restore.ts](../recovery-restore.ts) |
| Watcher reconciliation                   | [external-note-reconciliation.ts](../external-note-reconciliation.ts), [watcher-tree-reconciliation.ts](../watcher-tree-reconciliation.ts)                                   |
| Conflict signal and UI                   | [conflict-events.ts](conflict-events.ts), [external-conflict-dialog.tsx](../external-conflict-dialog.tsx)                                                                    |
| Queue and durable draft bridge           | [per-key-queue.ts](../../../lib/per-key-queue.ts), [recovery-drafts.ts](../../../lib/recovery-drafts.ts)                                                                     |
| Filesystem save and recovery             | [storage map](../../../lib/storage/MAP.md), [Rust map](../../../../src-tauri/src/MAP.md)                                                                                     |

Saves are serialized per file. A stale completion must not clear a newer edit;
recovery is retained until filesystem publication succeeds. Local unsaved changes
turn external changes/deletion into conflicts. Never silently close or overwrite
the dirty buffer. Follow the existing revision/generation checks across vault and
window lifecycle transitions; do not create a second autosave queue in a component.

Verification: colocated coordinator/lifecycle/integration tests,
[use-markdown-autosave.test.ts](../file-actions/use-markdown-autosave.test.ts),
[document-persistence-stress.test.tsx](../../../../tests/component/document-persistence-stress.test.tsx),
then targeted browser/native scenarios. Include a failed save, a newer edit during
an in-flight save, external mutation and a vault/tab transition for relevant changes.
