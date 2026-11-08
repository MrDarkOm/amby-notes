import * as React from "react"

import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { deriveCentre, liveWarningIds, type Centre, type CentreInput } from "./centre-entries"
import { useNoticesCentreStore } from "./use-notices-centre-store"

/**
 * What the notification centre says now, derived from the live causes in the stores (the status of the sync,
 * the open notes, the failed autosaves). The sections are not stored: they change with their causes.
 * Whoever reads it also lets a hidden record come back after its cause has gone.
 */
export function useNoticesCentre(): Centre {
  const vault = useVaultStore((state) => state.vault)
  const conflicts = useSyncNoticesStore((state) => state.conflicts)
  const stop = useSyncNoticesStore((state) => state.stop)
  const limits = useSyncNoticesStore((state) => state.limits)
  const itemErrors = useSyncNoticesStore((state) => state.itemErrors)
  const remoteDeleted = useSyncNoticesStore((state) => state.remoteDeleted)
  const restoreFailed = useSyncNoticesStore((state) => state.restoreFailed)
  const openDocs = useDocStore((state) => state.openDocs)
  const externalConflicts = useDocStore((state) => state.externalConflicts)
  const saveFailed = useNoteNoticesStore((state) => state.saveFailed)
  const propertyFailed = useNoteNoticesStore((state) => state.propertyFailed)
  const draftOffers = useNoteNoticesStore((state) => state.draftOffers)
  const closedSaveFailures = useNoteNoticesStore((state) => state.closedSaveFailed)
  const hidden = useNoticesCentreStore((state) => state.hidden)
  const reconcile = useNoticesCentreStore((state) => state.reconcile)

  const input = React.useMemo<CentreInput>(
    () => ({
      vault,
      conflicts,
      stop,
      limits,
      itemErrors,
      openDocs,
      externalConflicts,
      saveFailed,
      propertyFailed,
      draftOffers,
      remoteDeleted,
      restoreFailed,
      closedSaveFailures,
      hidden,
    }),
    [
      vault,
      conflicts,
      stop,
      limits,
      itemErrors,
      openDocs,
      externalConflicts,
      saveFailed,
      propertyFailed,
      draftOffers,
      remoteDeleted,
      restoreFailed,
      closedSaveFailures,
      hidden,
    ],
  )
  const centre = React.useMemo(() => deriveCentre(input), [input])
  const liveWarnings = React.useMemo(() => liveWarningIds(input).join("\n"), [input])
  React.useEffect(() => {
    reconcile(liveWarnings === "" ? [] : liveWarnings.split("\n"))
  }, [liveWarnings, reconcile])
  return centre
}
