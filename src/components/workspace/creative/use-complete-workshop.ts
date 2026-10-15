import * as React from "react"
import { useTranslation } from "react-i18next"
import { completeWorkshop, type CompletedWorkshop, type WorkshopSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { projectErrorText } from "./project-error"
import { projectLabels } from "./project-labels"
import { useProjectStore } from "./project-store"

export interface CompleteWorkshopState {
  pending: boolean
  error: string | null
  /** Parts the backend left alone (a taken folder, a locked database), named for the author. */
  skipped: string[]
  run: () => Promise<void>
}

/**
 * "Create the missing sections": one call that adds the absent bases and links of a workshop.
 * One operation ID per workshop file revision, so a retry of the same request is answered from the
 * record; the catalog is read again after it, whatever happened, so the panel shows what is there.
 */
export function useCompleteWorkshop(
  workshop: WorkshopSummary | null,
  onChanged?: () => Promise<void> | void,
): CompleteWorkshopState {
  const { t } = useTranslation()
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [skipped, setSkipped] = React.useState<string[]>([])
  const operations = React.useRef(new Map<string, string>())

  const run = React.useCallback(async () => {
    if (!workshop || vaultGeneration === null || pending) return
    const key = `${workshop.workshopId}:${workshop.fileRevision}`
    let operationId = operations.current.get(key)
    if (!operationId) {
      operationId = `complete-${crypto.randomUUID()}`
      operations.current.set(key, operationId)
    }
    setPending(true)
    setError(null)
    setSkipped([])
    let completed: CompletedWorkshop | null = null
    try {
      completed = await completeWorkshop({
        expectedGeneration: vaultGeneration,
        operationId,
        workshopId: workshop.workshopId,
        labels: projectLabels(t),
      })
    } catch (caught) {
      setError(t("creative.complete.failed", { message: projectErrorText(t, caught) }))
    } finally {
      try {
        await onChanged?.()
        await useProjectStore.getState().refresh?.()
      } finally {
        setPending(false)
      }
    }
    if (completed && completed.skipped.length > 0) setSkipped(completed.skipped)
  }, [onChanged, pending, t, vaultGeneration, workshop])

  return { pending, error, skipped, run }
}
