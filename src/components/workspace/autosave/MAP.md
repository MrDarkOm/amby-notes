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

Body saves and standalone property writes share [note-mutation-queue.ts](../note-mutation-queue.ts).
Property edits increment a per-note revision before their optimistic update; older reads must
not replace that state. Publishing metadata never replaces dirty body text or its external-edit revision.
Pending property writes participate in the close/switch save barrier; new property
intents are blocked while `useVaultStore.switching` changes the backend context.

[use-vault-data.ts](../use-vault-data.ts) closes the active workspace with `loadVault(null)`:
flush autosaves and persist its session before clearing buffers and returning to the start screen.
Canceling a failed-save confirmation leaves the vault attached. Detached records stay in
recent history (`VaultRecord.detached`); successful activation reconnects them.

A failed save of an open note sets `saveFailed` in [note-notices](../note-notices/MAP.md) (cleared by the next successful save or a
new load); the native error dialog stays only for a note that is no longer open. A recovery draft that differs from the disk is
not asked about in a dialog: `resolveMarkdownRecoveryLoad` returns it as an `offer`, `use-document-loading.ts` registers it as a
draft offer (accept: draft into the buffer, history snapshot, queued save; reject: drop it from the journal) and the note stays read
only until the answer. The journal keeps the draft meanwhile. Canvas and sketch still use the confirm dialog.

The save that may first rewrite a block's source asks for a history snapshot through
[source-rewrite.ts](source-rewrite.ts) (`rewritesSource` on the write).

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
