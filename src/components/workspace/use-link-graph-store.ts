import * as React from "react"
import { create } from "zustand"
import type { LinkGraph } from "./panel-registry"

const EMPTY: LinkGraph = { nodes: [], edges: [] }

interface LinkGraphState {
  graph: LinkGraph
  /** How many mounted views need the graph right now (graph tab, links panel, backlink count). */
  consumers: number
  /** The tree or vault changed after the graph was read, so the next consumer must read it again. */
  stale: boolean
  setGraph: (graph: LinkGraph) => void
  /** Empties the graph (a vault closed or is rebuilding) and marks it as needing a read. */
  reset: () => void
  markStale: () => void
  /** Registers a consumer; the returned function removes it. */
  acquire: () => () => void
}

/**
 * The link graph lives apart from the workspace root: the vault-data hook fills it only while a
 * consumer is mounted, and consumers read it through selectors, so a new graph re-renders only
 * the views that show it (SHELL-02).
 */
export const useLinkGraphStore = create<LinkGraphState>((set) => ({
  graph: EMPTY,
  consumers: 0,
  stale: true,
  setGraph: (graph) => set({ graph, stale: false }),
  reset: () => set({ graph: EMPTY, stale: true }),
  markStale: () => set({ stale: true }),
  acquire: () => {
    set((state) => ({ consumers: state.consumers + 1 }))
    let released = false
    return () => {
      if (released) return
      released = true
      set((state) => ({ consumers: Math.max(0, state.consumers - 1) }))
    }
  },
}))

/** Marks the calling view as needing the graph for as long as it is mounted (and `active`). */
export function useLinkGraphConsumer(active = true): void {
  React.useEffect(() => {
    if (!active) return
    return useLinkGraphStore.getState().acquire()
  }, [active])
}

/** The whole graph, for a view that lists or draws it. */
export function useLinkGraph(active = true): LinkGraph {
  useLinkGraphConsumer(active)
  return useLinkGraphStore((state) => state.graph)
}

/** How many notes link to `id`. The selector returns a number, so unrelated changes do not re-render. */
export function useBacklinkCount(id: string | null | undefined, active = true): number {
  useLinkGraphConsumer(active && Boolean(id))
  return useLinkGraphStore((state) => {
    if (!id) return 0
    let count = 0
    for (const edge of state.graph.edges) if (edge.target === id) count += 1
    return count
  })
}
