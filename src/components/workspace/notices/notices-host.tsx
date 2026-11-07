import * as React from "react"

import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { NoticeToastHost } from "./notice-toasts-host"
import { useNoticeToastStore } from "./use-notice-toasts-store"

/**
 * What the notification centre needs running beside the workspace (docs/notices.md, section 5): the journal of
 * the vault that is open, the cleaning of the records of failed autosaves, and the toasts. The sync side
 * (the status, the events) is [`SyncNoticesHost`](../sync/sync-notices-host.tsx).
 */
export function NoticesHost() {
  const vault = useVaultStore((state) => state.vault)

  // The journal belongs to the vault that is open. Records of a failed autosave belong to its session.
  React.useEffect(() => {
    useNoteNoticesStore.setState({ closedSaveFailed: {} })
    if (vault) void useNoticeJournalStore.getState().open(vault)
  }, [vault])

  // A note that was closed with a failed autosave is open again: its own strip and, for the draft, its offer
  // say it from now on, so the record of the closed note goes.
  React.useEffect(
    () =>
      useDocStore.subscribe((state) => {
        const failures = useNoteNoticesStore.getState().closedSaveFailed
        for (const fileId of Object.keys(failures)) {
          if (!state.openDocs[fileId]) continue
          useNoteNoticesStore.getState().setClosedSaveFailed(fileId, null)
          useNoticeToastStore.getState().dismiss(`closed-save-failed:${fileId}`)
        }
      }),
    [],
  )

  return <NoticeToastHost />
}
