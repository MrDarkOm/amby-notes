# Notices of a note map

The bulb with a number and the stack of cards above the bottom bar of a note (docs/sync-plan.md, stage Э4б К3). Worn by
[document-editor.tsx](../editor/document-editor.tsx) inside the note surface; there are no strips above the note.

| Concern                                                             | Owner                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bulb, stack, cards, what opens the stack by itself                  | [note-notices.tsx](note-notices.tsx)                                                                                                                                                                                                                |
| Events with no other home (save failed, draft offer, note returned) | [use-note-notices-store.ts](use-note-notices-store.ts)                                                                                                                                                                                              |
| Sources read by the cards                                           | external conflicts and deletion: [use-doc-store.ts](../use-doc-store.ts); sync conflicts, remote deletions: [use-sync-notices-store.ts](../sync/use-sync-notices-store.ts); warning key: [note-editing-policy.ts](../editor/note-editing-policy.ts) |
| Writers                                                             | `saveFailed`: [use-markdown-autosave.ts](../file-actions/use-markdown-autosave.ts); `draftOffers`: [use-document-loading.ts](../file-actions/use-document-loading.ts); `restored`: [sync-notices-host.tsx](../sync/sync-notices-host.tsx)           |

The bulb is there only while the note has a notice, with the number. Urgent notices (a sync conflict, a deleted or externally changed
file, a failed save, a draft to restore, a note deleted on another computer) open the stack when a new one appears or when the note
is opened; warnings and the "returned" notice wait for a click on the bulb. A card goes away when its source stops saying it. The
remote-deletion card steps in front of the general "file deleted" card until the way back from the archive fails. While a draft
offer waits, `document-editor.tsx` keeps the note read only so typing cannot overwrite the draft in the journal.

Tests: [note-notices.test.tsx](note-notices.test.tsx), [document-editor-notices.test.tsx](../editor/document-editor-notices.test.tsx),
[sync-notices.test.tsx](../sync/sync-notices.test.tsx).
