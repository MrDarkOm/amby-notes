import { MarkerType, type Edge, type EdgeMarker, type Node } from "@xyflow/react"

// ── Obsidian Canvas JSON schema (subset) ─────────────────────────────────────
// https://jsoncanvas.org/spec/1.0/

export type CanvasNodeType = "text" | "file" | "link" | "group"
export type CanvasSide = "top" | "right" | "bottom" | "left"
export type CanvasEdgeEnd = "none" | "arrow"

interface CanvasNodeBase {
  id: string
  type: CanvasNodeType
  x: number
  y: number
  width: number
  height: number
  /** Preset "1".."6" or hex like "#rrggbb". */
  color?: string
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: "text"
  text: string
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: "file"
  file: string
  subpath?: string
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: "link"
  url: string
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: "group"
  label?: string
  background?: string
  backgroundStyle?: "cover" | "ratio" | "repeat"
}

export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode

export interface CanvasEdge {
  id: string
  fromNode: string
  fromSide?: CanvasSide
  fromEnd?: CanvasEdgeEnd
  toNode: string
  toSide?: CanvasSide
  toEnd?: CanvasEdgeEnd
  color?: string
  label?: string
}

export interface CanvasFile {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

// ── XyFlow node data shapes ──────────────────────────────────────────────────

export interface TextNodeData {
  text: string
  color?: string
  [key: string]: unknown
}

export interface FileNodeData {
  file: string
  subpath?: string
  color?: string
  [key: string]: unknown
}

export interface GroupNodeData {
  label?: string
  color?: string
  [key: string]: unknown
}

export type CanvasFlowNode = Node<TextNodeData | FileNodeData | GroupNodeData>

const EMPTY: CanvasFile = { nodes: [], edges: [] }

// ── Parse / serialize ─────────────────────────────────────────────────────────

export function parseCanvas(json: string | null | undefined): CanvasFile {
  if (!json) return { nodes: [], edges: [] }
  try {
    const data = JSON.parse(json) as Partial<CanvasFile>
    return {
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      edges: Array.isArray(data.edges) ? data.edges : [],
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

export function serializeCanvas(file: CanvasFile): string {
  return JSON.stringify(file, null, 2) + "\n"
}

export function emptyCanvas(): CanvasFile {
  return { nodes: [], edges: [] }
}

export function isEmptyCanvas(file: CanvasFile): boolean {
  return file.nodes.length === 0 && file.edges.length === 0
}
void EMPTY

// ── ID generation ──────────────────────────────────────────────────────────────

let counter = 0
export function newCanvasId(): string {
  counter += 1
  return `${Date.now().toString(16)}${counter.toString(16).padStart(3, "0")}`
}

// ── Obsidian → XyFlow ─────────────────────────────────────────────────────────

export function toReactFlow(file: CanvasFile): {
  nodes: CanvasFlowNode[]
  edges: Edge[]
} {
  const nodes: CanvasFlowNode[] = file.nodes.map((n) => {
    const base = {
      id: n.id,
      position: { x: n.x, y: n.y },
      style: { width: n.width, height: n.height },
      width: n.width,
      height: n.height,
    }
    if (n.type === "group") {
      return {
        ...base,
        type: "group",
        data: { label: n.label, color: n.color } as GroupNodeData,
        // Groups render behind other nodes and never grab pointer events on body.
        zIndex: 0,
        selectable: true,
        draggable: true,
      }
    }
    if (n.type === "file") {
      return {
        ...base,
        type: "file",
        data: { file: n.file, subpath: n.subpath, color: n.color } as FileNodeData,
        zIndex: 1,
      }
    }
    if (n.type === "link") {
      // Render link as a file-ish card (url in `file` slot is fine for v1 display).
      return {
        ...base,
        type: "file",
        data: { file: (n as CanvasLinkNode).url, color: n.color } as FileNodeData,
        zIndex: 1,
      }
    }
    // text (default)
    return {
      ...base,
      type: "text",
      data: { text: (n as CanvasTextNode).text ?? "", color: n.color } as TextNodeData,
      zIndex: 1,
    }
  })

  const edges: Edge[] = file.edges.map((e) => {
    const toEnd = e.toEnd ?? "arrow"
    const fromEnd = e.fromEnd ?? "none"
    const css = colorToCss(e.color)
    return {
      id: e.id,
      type: "canvasEdge",
      source: e.fromNode,
      target: e.toNode,
      sourceHandle: e.fromSide ? `s-${e.fromSide}` : undefined,
      targetHandle: e.toSide ? `t-${e.toSide}` : undefined,
      markerEnd: arrowMarker(toEnd, css),
      markerStart: arrowMarker(fromEnd, css),
      style: css ? { stroke: css } : undefined,
      data: { color: e.color, label: e.label, toEnd, fromEnd },
    }
  })

  return { nodes, edges }
}

export function arrowMarker(end: CanvasEdgeEnd, css?: string): EdgeMarker | undefined {
  return end === "arrow"
    ? { type: MarkerType.ArrowClosed, color: css, width: 18, height: 18 }
    : undefined
}

export interface CanvasEdgeData {
  color?: string
  label?: string
  toEnd?: CanvasEdgeEnd
  fromEnd?: CanvasEdgeEnd
  [key: string]: unknown
}

// ── XyFlow → Obsidian ─────────────────────────────────────────────────────────

function sizeOf(node: CanvasFlowNode): { width: number; height: number } {
  const w =
    (node.style?.width as number | undefined) ??
    (node.width as number | undefined) ??
    (node.measured?.width as number | undefined) ??
    250
  const h =
    (node.style?.height as number | undefined) ??
    (node.height as number | undefined) ??
    (node.measured?.height as number | undefined) ??
    120
  return { width: Math.round(Number(w)), height: Math.round(Number(h)) }
}

export function fromReactFlow(nodes: CanvasFlowNode[], edges: Edge[]): CanvasFile {
  const outNodes: CanvasNode[] = nodes.map((node) => {
    const { width, height } = sizeOf(node)
    const common = {
      id: node.id,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      width,
      height,
    }
    const data = node.data as Partial<TextNodeData & FileNodeData & GroupNodeData>
    if (node.type === "group") {
      return { ...common, type: "group", label: data.label, color: data.color }
    }
    if (node.type === "file") {
      return {
        ...common,
        type: "file",
        file: data.file ?? "",
        subpath: data.subpath,
        color: data.color,
      }
    }
    return { ...common, type: "text", text: data.text ?? "", color: data.color }
  })

  const outEdges: CanvasEdge[] = edges.map((e) => {
    const d = (e.data ?? {}) as CanvasEdgeData
    const toEnd = d.toEnd ?? (e.markerEnd ? "arrow" : "none")
    const fromEnd = d.fromEnd ?? (e.markerStart ? "arrow" : "none")
    const label = d.label ?? (typeof e.label === "string" ? e.label : undefined)
    return {
      id: e.id,
      fromNode: e.source,
      fromSide: handleToSide(e.sourceHandle, "s"),
      toNode: e.target,
      toSide: handleToSide(e.targetHandle, "t"),
      toEnd,
      fromEnd,
      color: d.color,
      label: label && label.length > 0 ? label : undefined,
    }
  })

  return { nodes: outNodes, edges: outEdges }
}

function handleToSide(
  handle: string | null | undefined,
  prefix: "s" | "t",
): CanvasSide | undefined {
  if (!handle) return undefined
  const side = handle.replace(`${prefix}-`, "")
  if (side === "top" || side === "right" || side === "bottom" || side === "left") {
    return side
  }
  return undefined
}

// ── Color mapping (Obsidian presets → CSS) ────────────────────────────────────

const PRESET_COLORS: Record<string, string> = {
  "1": "#e93147", // red
  "2": "#ec7500", // orange
  "3": "#e0ac00", // yellow
  "4": "#08b94e", // green
  "5": "#00bfbc", // cyan
  "6": "#7852ee", // purple
}

export function colorToCss(color: string | undefined): string | undefined {
  if (!color) return undefined
  if (color.startsWith("#")) return color
  return PRESET_COLORS[color] ?? undefined
}

export const PRESET_COLOR_KEYS = ["1", "2", "3", "4", "5", "6"] as const

// ── Geometry ──────────────────────────────────────────────────────────────────

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function nodeRect(node: CanvasFlowNode): Rect {
  const width =
    (node.style?.width as number | undefined) ??
    (node.width as number | undefined) ??
    (node.measured?.width as number | undefined) ??
    250
  const height =
    (node.style?.height as number | undefined) ??
    (node.height as number | undefined) ??
    (node.measured?.height as number | undefined) ??
    120
  return { x: node.position.x, y: node.position.y, width: Number(width), height: Number(height) }
}

/** True when `inner`'s center lies within `outer` (Obsidian-style loose containment). */
export function rectContains(outer: Rect, inner: Rect): boolean {
  const cx = inner.x + inner.width / 2
  const cy = inner.y + inner.height / 2
  return (
    cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height
  )
}

// ── Duplication (remap ids, offset) ──────────────────────────────────────────

export function duplicateGraph(
  nodes: CanvasFlowNode[],
  edges: Edge[],
  offset = 32,
): { nodes: CanvasFlowNode[]; edges: Edge[] } {
  const idMap = new Map<string, string>()
  const newNodes = nodes.map((n) => {
    const id = newCanvasId()
    idMap.set(n.id, id)
    return {
      ...n,
      id,
      position: { x: n.position.x + offset, y: n.position.y + offset },
      selected: true,
    }
  })
  // Only keep edges whose both ends are inside the duplicated set.
  const newEdges = edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      ...e,
      id: newCanvasId(),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      selected: true,
    }))
  return { nodes: newNodes, edges: newEdges }
}
