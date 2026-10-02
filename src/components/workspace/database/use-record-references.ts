import * as React from "react"
import { resolveRecordReferences, type RecordReference } from "@/lib/storage"
import { createBatchResolver, type BatchResolver } from "./batch-resolver"
import { useDatabaseStore } from "./database-store"

export type ReferenceView =
  | { status: "loading" }
  | { status: "ok"; title: string; path: string }
  | { status: "missing" }
  | { status: "error"; message: string }

const resolvers = new Map<number, BatchResolver<RecordReference>>()

function resolverFor(generation: number): BatchResolver<RecordReference> {
  let resolver = resolvers.get(generation)
  if (!resolver) {
    // Only the active vault matters; drop resolvers of earlier generations.
    for (const [key, old] of resolvers) {
      old.clear()
      resolvers.delete(key)
    }
    resolver = createBatchResolver<RecordReference>(async (noteIds) => {
      const result = await resolveRecordReferences({ expectedGeneration: generation, noteIds })
      return result.references
    })
    resolvers.set(generation, resolver)
  }
  return resolver
}

function toView(reference: RecordReference | null): ReferenceView {
  if (!reference) return { status: "loading" }
  if (reference.state === "ok" && reference.title !== null) {
    return { status: "ok", title: reference.title, path: reference.path ?? "" }
  }
  return { status: "missing" }
}

/**
 * Names of the pages behind stored Relation IDs, resolved on the backend in
 * batches. Independent of any loaded search page, so a page far outside the
 * first results is named too. Known names stay visible while a refresh runs.
 */
export function useRecordReferences(noteIds: string[]): Record<string, ReferenceView> {
  const generation = useDatabaseStore((state) => state.vaultGeneration)
  const invalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const [views, setViews] = React.useState<Record<string, ReferenceView>>({})
  const lastInvalidation = React.useRef(invalidationSeq)
  const key = React.useMemo(() => [...new Set(noteIds)].sort().join(","), [noteIds])

  React.useEffect(() => {
    if (generation === null || !key) return
    const ids = key.split(",")
    const resolver = resolverFor(generation)
    // A projection change may rename or restore targets: ask again.
    if (lastInvalidation.current !== invalidationSeq) {
      lastInvalidation.current = invalidationSeq
      resolver.clear()
    }
    let cancelled = false
    for (const id of ids) {
      resolver.request(id).then(
        (reference) => {
          if (!cancelled) setViews((current) => ({ ...current, [id]: toView(reference) }))
        },
        (error) => {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error)
          setViews((current) => ({ ...current, [id]: { status: "error", message } }))
        },
      )
    }
    return () => {
      cancelled = true
    }
  }, [generation, invalidationSeq, key])

  return React.useMemo(() => {
    const result: Record<string, ReferenceView> = {}
    for (const id of noteIds) result[id] = views[id] ?? { status: "loading" }
    return result
  }, [noteIds, views])
}

/** Collects the Relation target IDs stored in rows, for batch resolution. */
export function relationTargetIds(valuesJsonList: string[]): string[] {
  const ids = new Set<string>()
  for (const valuesJson of valuesJsonList) {
    let values: unknown
    try {
      values = JSON.parse(valuesJson)
    } catch {
      continue
    }
    if (!values || typeof values !== "object") continue
    for (const value of Object.values(values as Record<string, unknown>)) {
      const targets =
        value && typeof value === "object" && (value as { type?: unknown }).type === "relation"
          ? (value as { targetNoteIds?: unknown }).targetNoteIds
          : null
      if (Array.isArray(targets)) {
        for (const id of targets) if (typeof id === "string") ids.add(id)
      }
    }
  }
  return [...ids]
}

export function referenceTitles(views: Record<string, ReferenceView>): Record<string, string> {
  const titles: Record<string, string> = {}
  for (const [id, view] of Object.entries(views)) {
    if (view.status === "ok") titles[id] = view.title
  }
  return titles
}
