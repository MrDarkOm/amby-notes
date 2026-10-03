import * as React from "react"
import { queryDatabase } from "@/lib/storage"
import { useDatabaseStore } from "./database-store"

/**
 * Whether any record has a value for the property: `null` until known. Re-checked when
 * `refreshKey` changes (the property's settings were saved). A failed check counts as no
 * values, since the backend refuses an unsafe change in any case.
 */
export function usePropertyHasValues(
  databaseId: string,
  propertyId: string,
  refreshKey: string,
): boolean | null {
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const [has, setHas] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    if (vaultGeneration === null || !databaseId) return
    let cancelled = false
    queryDatabase({
      expectedGeneration: vaultGeneration,
      databaseId,
      source: { kind: "inline", spec: { sorts: [] } },
      filter: {
        kind: "condition",
        field: { kind: "property", propertyId },
        operator: "isNotEmpty",
      },
      page: { limit: 1 },
    }).then(
      (result) => {
        if (!cancelled) setHas(result.rows.length > 0)
      },
      () => {
        if (!cancelled) setHas(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [databaseId, propertyId, refreshKey, vaultGeneration])

  return has
}
