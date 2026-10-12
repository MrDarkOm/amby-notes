import * as React from "react"
import { resolveDatabaseAssetPaths } from "@/lib/storage"
import { createCoverResolver, type CoverResolver } from "../../database/layouts/cover-resolver"

/**
 * One batched picture resolver per database, made when a row of it first asks and dropped when
 * the vault changes or the list goes away. The world mixes pages of several databases (a
 * universe's and its stories'), and a resolver answers for one.
 */
export function usePortraitResolvers(
  vaultGeneration: number | null,
): (databaseId: string) => CoverResolver {
  const resolvers = React.useRef(new Map<string, CoverResolver>())

  React.useEffect(() => {
    const own = resolvers.current
    return () => {
      own.forEach((resolver) => resolver.clear())
      own.clear()
    }
  }, [vaultGeneration])

  return React.useCallback(
    (databaseId: string) => {
      let resolver = resolvers.current.get(databaseId)
      if (!resolver) {
        resolver = createCoverResolver(async (relativePaths) => {
          if (vaultGeneration === null) return relativePaths.map(() => null)
          const result = await resolveDatabaseAssetPaths({
            expectedGeneration: vaultGeneration,
            databaseId,
            relativePaths,
          })
          return result.paths
        })
        resolvers.current.set(databaseId, resolver)
      }
      return resolver
    },
    [vaultGeneration],
  )
}
