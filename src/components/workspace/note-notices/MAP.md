# Notices of a note map

The bulb with a number and the stack of cards above the bottom bar of a note (docs/sync-plan.md, stage Э4б К3). Worn by
[document-editor.tsx](../editor/document-editor.tsx) inside the note surface; there are no strips above the note.

| Concern                                                                                                         | Owner                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bulb, stack, cards, what opens the stack by itself                                                              | [note-notices.tsx](note-notices.tsx)                                                                                                                                                                                                                |
| Look of a card: its level gives the icon, role and colours (docs/notices.md, step 1)                            | `Card` in [notice-card.tsx](notice-card.tsx) takes `level` and wears [notices/notice-level.tsx](../notices/notice-level.tsx); the colours are `--notice-*` tokens in `src/themes/app.css`                                                           |
| Warnings and questions about the properties of the note (new format, rename hint, old version, unreadable file) | [property-notices.tsx](property-notices.tsx), card in [notice-card.tsx](notice-card.tsx)                                                                                                                                                            |
| Events with no other home (save failed, draft offer, note returned)                                             | [use-note-notices-store.ts](use-note-notices-store.ts)                                                                                                                                                                                              |
| Sources read by the cards                                                                                       | external conflicts and deletion: [use-doc-store.ts](../use-doc-store.ts); sync conflicts, remote deletions: [use-sync-notices-store.ts](../sync/use-sync-notices-store.ts); warning key: [note-editing-policy.ts](../editor/note-editing-policy.ts) |
| Writers                                                                                                         | `saveFailed`: [use-markdown-autosave.ts](../file-actions/use-markdown-autosave.ts); `draftOffers`: [use-document-loading.ts](../file-actions/use-document-loading.ts); `restored`: [sync-notices-host.tsx](../sync/sync-notices-host.tsx)           |

The bulb is there only while the note has a notice, with the number. The level of a card (`danger`, `decision`, `warning`, `info`) says
how it looks, how it is announced and whether it opens the stack by itself: only `danger` and `decision` do, when a new one appears
or when the note is opened (`noticeIsUrgent` in [notice-look.ts](../notices/notice-look.ts); `data-urgent` on a card is derived from its
level). Today these are a sync conflict, a note deleted on another computer, a deleted or externally changed file, a failed save of the
text or of a property, a draft to restore, a lost id (`workspace.identityReadOnly`), properties that are read only, and the choice
after an edit made here and in an old version. Warnings (a damaged or unterminated header, a file that is only source, a newer format,
a bad line, differing values after the migration) and information ("returned", "moved", "carried over", a rename hint, an old
version) wait for a click on the bulb. The bulb takes the colour of the strongest level among its cards (`data-level`:
danger, decision, warning); with only information it is neutral (`strongestNoticeLevel`, `noticeBulbClass`). A card goes away when its source stops saying it. The
remote-deletion card steps in front of the general "file deleted" card until the way back from the archive fails. While a draft
offer waits, `document-editor.tsx` keeps the note read only so typing cannot overwrite the draft in the journal.

Tests: [note-notices.test.tsx](note-notices.test.tsx), [document-editor-notices.test.tsx](../editor/document-editor-notices.test.tsx),
[sync-notices.test.tsx](../sync/sync-notices.test.tsx).
