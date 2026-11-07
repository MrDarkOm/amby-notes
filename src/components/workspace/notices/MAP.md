# Notification centre map

The notices of the application outside the strip of a note (docs/notices.md, sections 2–6 and 12). The look of a
level (icon, role, colours) is shared by every place: [notice-level.tsx](notice-level.tsx), [notice-look.ts](notice-look.ts).
The strip of a note: [note-notices map](../note-notices/MAP.md). The sync side that feeds the centre: [sync map](../sync/MAP.md).

| Concern                                                                                                               | Owner                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The panel: "Needs a decision", "Attention", the journal; each record leads to the place where it is decided           | [notices-panel.tsx](notices-panel.tsx); registered in [panel-definitions.tsx](../panel-definitions.tsx) as the panel `notices-centre`, opened by the bell (the action `notices` with `opens`), see [use-sidebar-layout.ts](../use-sidebar-layout.ts)                                                                                    |
| What the first two sections say: derived from the live causes each time, never stored; hiding; the number on the bell | [centre-entries.ts](centre-entries.ts) (pure: `deriveCentre`, `centreCounter`, `noteNoticeId`), [use-notices-centre.ts](use-notices-centre.ts) (reads the stores), [use-notices-centre-store.ts](use-notices-centre-store.ts) (hidden records, in memory), the bell: [use-notices-dock-summary.ts](../sync/use-notices-dock-summary.ts) |
| Titles of the stops of the sync                                                                                       | [stop-words.ts](stop-words.ts)                                                                                                                                                                                                                                                                                                          |
| The journal (info and success, per vault, seven days, in the data of the application)                                 | [lib/notices/](../../../lib/notices/notice-journal.ts): `notice-journal.ts` (pure), `journal-storage.ts` (file `notice-journal/<hash>.json` through `readGlobalRaw`/`writeGlobalRaw`), `use-notice-journal-store.ts`                                                                                                                    |
| Toasts: announce only danger and a decision about something not on the screen                                         | [use-notice-toasts-store.ts](use-notice-toasts-store.ts), [notice-toasts-host.tsx](notice-toasts-host.tsx) (top right, ten seconds each, paused by the pointer, three and "N more")                                                                                                                                                     |
| Running beside the workspace: journal of the open vault, clean-up of the records of failed autosaves, the toasts      | [notices-host.tsx](notices-host.tsx) (mounted in [workspace.tsx](../workspace.tsx)); the sync side is [sync-notices-host.tsx](../sync/sync-notices-host.tsx)                                                                                                                                                                            |
| Leading to a note from the centre or a toast                                                                          | [note-open-request.ts](note-open-request.ts) (event, answered in [workspace-orchestration.tsx](../workspace-orchestration.tsx)); the centre itself is opened with `requestOpenPanel` ([panel-navigation.ts](../panel-navigation.ts))                                                                                                    |

How a notice gets into the centre, by who writes it:

- **Derived (not stored):** sync conflicts, a stop of the sync, the limits of the plan and the files that failed
  (`useSyncNoticesStore`, fed by `SyncNoticesHost` from the status of the sync); the copies of the cards of open notes
  (`save-failed`, `external-deleted`, `external-change`, `draft`, `property-failed`, `remote-deleted`) with the id
  `noteNoticeId(document id, card)`, so a decision in the strip or in the centre removes both; a failed autosave of a note that
  is no longer open (`closedSaveFailed` of `useNoteNoticesStore`, written by
  [use-markdown-autosave.ts](../file-actions/use-markdown-autosave.ts), cleared by the next successful save or when the note is
  opened again; the text is in the recovery draft until then).
- **Journal:** a note that came back, the result of a choice in a conflict ([conflict-outcome.ts](../sync/conflict-outcome.ts)),
  the merge of the edits of two computers (`sync-merged`; an open note also gets a quiet card), the copy of the vault made before
  the first pass, a failed automatic update ([app-updater.ts](../../../lib/app-updater.ts)).
- **Toasts** (only these): a new conflict of a note that is not open, a new stop of the sync, a failed autosave of a note that is
  not open. At the start and at a change of the vault what exists is the starting point and is not announced.

Tests sit beside the files: [centre-entries.test.ts](centre-entries.test.ts), [notices-centre.test.tsx](notices-centre.test.tsx),
[notice-toasts.test.tsx](notice-toasts.test.tsx), [notices-sources.test.tsx](notices-sources.test.tsx),
[notice-journal.test.ts](../../../lib/notices/notice-journal.test.ts).
