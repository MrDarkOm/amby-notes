import { create } from "zustand"
import { loadVaultJSON, saveVaultJSON } from "@/lib/storage"

/** `.amby/graph-layout.json`: where the nodes of a locked graph stand. */
export const GRAPH_LAYOUT_FILE = "graph-layout.json"
const GRAPH_LAYOUT_VERSION = 1

export interface GraphPoint {
  x: number
  y: number
}

/** The graph point in the middle of the view and the zoom, so any window size can restore it. */
export interface GraphCamera {
  cx: number
  cy: number
  zoom: number
}

interface GraphLayoutFile {
  version: number
  locked: boolean
  nodes?: Record<string, [number, number]>
  camera?: GraphCamera
}

interface GraphLayoutState {
  loaded: boolean
  locked: boolean
  positions: ReadonlyMap<string, GraphPoint>
  camera: GraphCamera | null
  /** Reads the layout of the open vault. A missing or unreadable file leaves the graph free. */
  load: () => Promise<void>
  /** Pins the graph as it stands now and saves it. Rejects when the file cannot be written. */
  lock: (positions: ReadonlyMap<string, GraphPoint>, camera: GraphCamera) => Promise<void>
  unlock: () => Promise<void>
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

/** Reads the file defensively: broken entries are skipped, an unknown version is ignored. */
export function parseGraphLayout(raw: unknown): {
  locked: boolean
  positions: Map<string, GraphPoint>
  camera: GraphCamera | null
} {
  const positions = new Map<string, GraphPoint>()
  const file = raw && typeof raw === "object" ? (raw as Partial<GraphLayoutFile>) : {}
  if (file.version !== GRAPH_LAYOUT_VERSION || file.locked !== true) {
    return { locked: false, positions, camera: null }
  }
  for (const [id, point] of Object.entries(file.nodes ?? {})) {
    if (Array.isArray(point) && finite(point[0]) && finite(point[1])) {
      positions.set(id, { x: point[0], y: point[1] })
    }
  }
  const c = file.camera
  const camera = c && finite(c.cx) && finite(c.cy) && finite(c.zoom) && c.zoom > 0 ? c : null
  return { locked: true, positions, camera }
}

export const useGraphLayoutStore = create<GraphLayoutState>((set) => ({
  loaded: false,
  locked: false,
  positions: new Map(),
  camera: null,
  load: async () => {
    try {
      const parsed = parseGraphLayout(await loadVaultJSON<unknown>(GRAPH_LAYOUT_FILE, null))
      set({ ...parsed, loaded: true })
    } catch {
      set({ locked: false, positions: new Map(), camera: null, loaded: true })
    }
  },
  lock: async (positions, camera) => {
    const nodes: Record<string, [number, number]> = {}
    positions.forEach((p, id) => {
      // Two decimals are far finer than a pixel and keep the file small.
      nodes[id] = [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]
    })
    const file: GraphLayoutFile = { version: GRAPH_LAYOUT_VERSION, locked: true, nodes, camera }
    await saveVaultJSON(GRAPH_LAYOUT_FILE, file)
    set({ locked: true, positions: new Map(positions), camera })
  },
  unlock: async () => {
    const file: GraphLayoutFile = { version: GRAPH_LAYOUT_VERSION, locked: false }
    await saveVaultJSON(GRAPH_LAYOUT_FILE, file)
    set({ locked: false, positions: new Map(), camera: null })
  },
}))
