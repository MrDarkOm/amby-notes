import * as React from "react"
import { getDossierTemplate, type DossierTemplate } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"

/**
 * The page template of a section with its dossier layout, read when the dossier opens and again
 * when its databases change or `reload` is called. A template that cannot be read (a section
 * without one, the browser runtime) is `null`: the dossier works as plain headings.
 */
export function useDossierTemplate(databaseId: string | null): {
  template: DossierTemplate | null
  reload: () => void
} {
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [nonce, setNonce] = React.useState(0)
  const [template, setTemplate] = React.useState<DossierTemplate | null>(null)

  React.useEffect(() => {
    if (!databaseId) {
      setTemplate(null)
      return undefined
    }
    let cancelled = false
    getDossierTemplate(databaseId)
      .then((read) => {
        if (!cancelled) setTemplate(read)
      })
      .catch(() => {
        if (!cancelled) setTemplate(null)
      })
    return () => {
      cancelled = true
    }
  }, [databaseId, invalidationSeq, nonce])

  const reload = React.useCallback(() => setNonce((value) => value + 1), [])
  return { template, reload }
}
