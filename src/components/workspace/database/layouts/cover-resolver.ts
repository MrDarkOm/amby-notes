import { createBatchResolver, type BatchResolver } from "../batch-resolver"

/** Cover path lookups: stored relative path → validated absolute image path. */
export type CoverResolver = BatchResolver<string>

export function createCoverResolver(
  resolve: (relativePaths: string[]) => Promise<Array<string | null>>,
  delayMs?: number,
): CoverResolver {
  return createBatchResolver<string>(resolve, delayMs)
}
