import * as React from "react"
import { listNotebooks, type NotebookCatalog } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"

const NONE: NotebookCatalog | null = null

/**
 * The notebooks (folders) of the notes base, read from the disk in one read-only call: an empty
 * notebook has no note to show it, so the rows alone cannot list them. While the call is out, or
 * when it fails, there are no known notebooks and the lists show the notes' own folders only.
 * `reload` reads again and returns what it read, for a check right after a write.
 */
export function useNotebooks(
  databaseId: string | null | undefined,
  refreshKey: number,
): { catalog: NotebookCatalog | null; reload: () => Promise<NotebookCatalog | null> } {
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [catalog, setCatalog] = React.useState<NotebookCatalog | null>(NONE)

  React.useEffect(() => {
    if (!databaseId || vaultGeneration === null) {
      setCatalog(NONE)
      return undefined
    }
    let cancelled = false
    listNotebooks(databaseId)
      .then((value) => {
        if (!cancelled) setCatalog(value)
      })
      .catch(() => {
        if (!cancelled) setCatalog(NONE)
      })
    return () => {
      cancelled = true
    }
  }, [databaseId, vaultGeneration, invalidationSeq, refreshKey])

  const reload = React.useCallback(async () => {
    if (!databaseId) return null
    try {
      const value = await listNotebooks(databaseId)
      setCatalog(value)
      return value
    } catch {
      return null
    }
  }, [databaseId])

  return { catalog, reload }
}
