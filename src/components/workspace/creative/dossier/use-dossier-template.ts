import * as React from "react"
import { getDossierTemplate, type DossierTemplate } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"

/**
 * The page template of a section with its dossier layout, read when the dossier opens and again
 * when its databases change or `reload` is called. A template that cannot be read (a section
 * without one, the browser runtime) is `null`: the dossier works as plain headings.
 */
export function useDossierTemplate(
  databaseId: string | null,
  generation: number | null,
): {
  template: DossierTemplate | null
  reload: () => void
} {
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [nonce, setNonce] = React.useState(0)
  const [answer, setAnswer] = React.useState<{
    databaseId: string
    generation: number | null
    template: DossierTemplate
  } | null>(null)

  React.useEffect(() => {
    if (!databaseId) {
      setAnswer(null)
      return undefined
    }
    let cancelled = false
    getDossierTemplate(databaseId)
      .then((read) => {
        if (!cancelled) setAnswer({ databaseId, generation, template: read })
      })
      .catch(() => {
        if (!cancelled) setAnswer(null)
      })
    return () => {
      cancelled = true
    }
  }, [databaseId, generation, invalidationSeq, nonce])

  const reload = React.useCallback(() => setNonce((value) => value + 1), [])
  const template =
    answer?.databaseId === databaseId && answer.generation === generation ? answer.template : null
  return { template, reload }
}
