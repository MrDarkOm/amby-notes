import * as React from "react"
import { resolveDatabaseAssetPaths } from "@/lib/storage"
import { createCoverResolver } from "./cover-resolver"

/** Resolves the cover images of one database's cards; cleared when the database or vault changes. */
export function useCoverResolver(databaseId: string | undefined, vaultGeneration: number | null) {
  const coverResolver = React.useMemo(
    () =>
      createCoverResolver(async (relativePaths) => {
        if (!databaseId || vaultGeneration === null) return relativePaths.map(() => null)
        const result = await resolveDatabaseAssetPaths({
          expectedGeneration: vaultGeneration,
          databaseId,
          relativePaths,
        })
        return result.paths
      }),
    [databaseId, vaultGeneration],
  )
  React.useEffect(() => () => coverResolver.clear(), [coverResolver])
  return coverResolver
}
