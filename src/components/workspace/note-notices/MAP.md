# Notices of a note map

The strip of the notices of a note and the panel of cards it opens (docs/sync-plan.md, stage Э4б К3; docs/notices.md, section 7). The
strip peeks out from behind the top edge of the floating bottom bar of the note, a little narrower than the bar, its foot under it.
[document-editor.tsx](../editor/document-editor.tsx) hands `NoteNotices` to [document-body.tsx](../editor/document-body.tsx) as `notices`, which
passes it to [document-area-controls.tsx](../editor/document-area-controls.tsx) and the `above` slot of
[page-floating-bar.tsx](../page-chrome/page-floating-bar.tsx); there is nothing above the note and no bulb.

| Concern                                                                                                         | Owner                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strip, panel of cards, what opens the panel by itself                                                           | [note-notices.tsx](note-notices.tsx)                                                                                                                                                                                                                |
| Look of a card: its level gives the icon, role and colours (docs/notices.md, step 1)                            | `Card` in [notice-card.tsx](notice-card.tsx) takes `level` and wears [notices/notice-level.tsx](../notices/notice-level.tsx); the colours are `--notice-*` tokens in `src/themes/app.css`                                                           |
| Warnings and questions about the properties of the note (new format, rename hint, old version, unreadable file) | [property-notices.tsx](property-notices.tsx), card in [notice-card.tsx](notice-card.tsx)                                                                                                                                                            |
| Events with no other home (save failed, draft offer, note returned)                                             | [use-note-notices-store.ts](use-note-notices-store.ts)                                                                                                                                                                                              |
| Sources read by the cards                                                                                       | external conflicts and deletion: [use-doc-store.ts](../use-doc-store.ts); sync conflicts, remote deletions: [use-sync-notices-store.ts](../sync/use-sync-notices-store.ts); warning key: [note-editing-policy.ts](../editor/note-editing-policy.ts) |
| Writers                                                                                                         | `saveFailed`: [use-markdown-autosave.ts](../file-actions/use-markdown-autosave.ts); `draftOffers`: [use-document-loading.ts](../file-actions/use-document-loading.ts); `restored`: [sync-notices-host.tsx](../sync/sync-notices-host.tsx)           |

The strip is there only while the note has a notice. Folded it is one line and one button (`aria-expanded`): the icon of the most
serious level, the title of its card cut to one line, "+N" for the other cards, a dot of that level and a chevron; open, it grows
upwards into the panel of all the cards (limited height, scrolls inside; animation by the motion tokens, instant for reduced motion)
and the line stays at its foot. The level of a card (`danger`, `decision`, `warning`, `info`) says how it looks, how it is announced
and whether it opens the panel by itself: only `danger` and `decision` do, when a new one appears or when the note is opened
(`noticeIsUrgent` in [notice-look.ts](../notices/notice-look.ts); `data-urgent` on a card is derived from its level). Today these are a
sync conflict, a note deleted on another computer, a deleted or externally changed file, a failed save of the text or of a property, a
draft to restore, a lost id (`workspace.identityReadOnly`), properties that are read only, and the choice after an edit made here and
in an old version. Warnings (a damaged or unterminated header, a file that is only source, a newer format, a bad line, differing
values after the migration) and information ("returned", "moved", "carried over", a rename hint, an old version) wait for a click on
the strip. The icon and the dot take the colour of the most serious level among the cards (`data-level` on the strip; `mostSeriousNoticeLevel`). A card goes away when its source stops saying it. The
remote-deletion card steps in front of the general "file deleted" card until the way back from the archive fails. While a draft
offer waits, `document-editor.tsx` keeps the note read only so typing cannot overwrite the draft in the journal.

Tests: [note-notices.test.tsx](note-notices.test.tsx), [document-editor-notices.test.tsx](../editor/document-editor-notices.test.tsx),
[sync-notices.test.tsx](../sync/sync-notices.test.tsx).
