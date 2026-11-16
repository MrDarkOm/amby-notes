import { MarkerType, type Edge, type EdgeMarker, type Node } from "@xyflow/react"
import { OBSIDIAN_CANVAS_PRESET_COLORS } from "@/lib/themes"

// ── Obsidian Canvas JSON schema (subset) ─────────────────────────────────────
// https://jsoncanvas.org/spec/1.0/

type CanvasNodeType = "text" | "file" | "link" | "group"
type CanvasSide = "top" | "right" | "bottom" | "left"
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

interface CanvasTextNode extends CanvasNodeBase {
  type: "text"
  text: string
}

interface CanvasFileNode extends CanvasNodeBase {
  type: "file"
  file: string
  subpath?: string
}

interface CanvasLinkNode extends CanvasNodeBase {
  type: "link"
  url: string
}

interface CanvasGroupNode extends CanvasNodeBase {
  type: "group"
  label?: string
  background?: string
  backgroundStyle?: "cover" | "ratio" | "repeat"
}

type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode

interface CanvasEdge {
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
  [key: string]: unknown
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

interface CanvasGeometry {
  x: number
  y: number
  width: number
  height: number
}

interface CanvasInternalData {
  __canvasNodeType?: CanvasNodeType
  __canvasExtras?: Record<string, unknown>
  /** Geometry as read from the file: an untouched node is written back with these exact values. */
  __canvasGeom?: CanvasGeometry
  /** The whole node object of a type this app does not know; written back as it was read (CRE-02). */
  __canvasRaw?: Record<string, unknown>
}

/** Node data of the read-only placeholder shown for node types this app does not know. */
export interface UnknownNodeData {
  /** The `type` string of the original node. */
  originalType: string
  [key: string]: unknown
}

export type CanvasFlowNode = Node<TextNodeData | FileNodeData | GroupNodeData | UnknownNodeData>

const KNOWN_NODE_TYPES = new Set(["text", "file", "link", "group"])

// ── Parse / serialize ─────────────────────────────────────────────────────────

export function parseCanvas(json: string | null | undefined): CanvasFile {
  if (!json) return { nodes: [], edges: [] }
  try {
    const data = JSON.parse(json) as Partial<CanvasFile>
    return {
      ...data,
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      edges: Array.isArray(data.edges) ? data.edges : [],
    } as CanvasFile
  } catch {
    return { nodes: [], edges: [] }
  }
}

export function serializeCanvas(file: CanvasFile): string {
  return JSON.stringify(file, null, 2) + "\n"
}

export const CANONICAL_EMPTY_CANVAS = '{\n  "nodes": [],\n  "edges": []\n}\n'

/**
 * Accept only the part of the JSON Canvas format we can persist losslessly and
 * return its canonical serialized form. Unlike parseCanvas this is deliberately
 * strict: invalid editor output must never replace the on-disk canvas.
 */
export function validateAndSerializeCanvas(json: string): string {
  let data: unknown
  try {
    // A byte order mark is not JSON. The file write puts the BOM back from the file on disk.
    data = JSON.parse(json.replace(/^\uFEFF/u, ""))
  } catch {
    throw new Error("Canvas content must be valid JSON")
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Canvas content must be a JSON object")
  }
  const file = data as Partial<CanvasFile> & Record<string, unknown>
  if (Object.keys(file).length === 0) {
    return serializeCanvas({ nodes: [], edges: [] })
  }
  // JSON Canvas 1.0 makes both arrays optional: a missing one is empty (SAVE-01).
  const nodes = file.nodes ?? []
  const edges = file.edges ?? []
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new Error("Canvas content must contain nodes and edges arrays")
  }
  // Keep future/third-party top-level fields intact; nodes and edges themselves
  // are likewise carried through untouched.
  const { nodes: _nodes, edges: _edges, ...unknownFields } = file
  return JSON.stringify({ nodes, edges, ...unknownFields }, null, 2) + "\n"
}

// ── ID generation ──────────────────────────────────────────────────────────────

let counter = 0
export function newCanvasId(): string {
  counter = (counter + 1) & 0xffff
  const rand = Math.random().toString(16).slice(2, 6)
  return `${Date.now().toString(16)}${counter.toString(16).padStart(4, "0")}${rand}`
}

// ── Obsidian → XyFlow ─────────────────────────────────────────────────────────

export function toReactFlow(file: CanvasFile): {
  nodes: CanvasFlowNode[]
  edges: Edge[]
} {
  const nodes: CanvasFlowNode[] = file.nodes.map((n) => {
    const { id, type, x, y, width, height, color, ...extras } = n
    const geom: CanvasGeometry = { x, y, width, height }
    if (!KNOWN_NODE_TYPES.has(type)) {
      // Unknown type (spec extension, another app): keep the whole object and show a placeholder.
      return {
        id,
        position: { x, y },
        style: { width, height },
        width,
        height,
        type: "unknown",
        data: {
          originalType: String(type),
          __canvasRaw: n as unknown as Record<string, unknown>,
          __canvasGeom: geom,
        } as UnknownNodeData & CanvasInternalData,
        zIndex: 1,
      }
    }
    const base = {
      id,
      position: { x, y },
      style: { width, height },
      width,
      height,
    }
    if (n.type === "group") {
      return {
        ...base,
        type: "group",
        data: {
          label: n.label,
          color,
          __canvasNodeType: type,
          __canvasExtras: extras,
          __canvasGeom: geom,
        } as GroupNodeData & CanvasInternalData,
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
        data: {
          file: n.file,
          subpath: n.subpath,
          color,
          __canvasNodeType: type,
          __canvasExtras: extras,
          __canvasGeom: geom,
        } as FileNodeData & CanvasInternalData,
        zIndex: 1,
      }
    }
    if (n.type === "link") {
      // Render link as a file-ish card (url in `file` slot is fine for v1 display).
      return {
        ...base,
        type: "file",
        data: {
          file: (n as CanvasLinkNode).url,
          color,
          __canvasNodeType: type,
          __canvasExtras: extras,
          __canvasGeom: geom,
        } as FileNodeData & CanvasInternalData,
        zIndex: 1,
      }
    }
    // text (default)
    return {
      ...base,
      type: "text",
      data: {
        text: (n as CanvasTextNode).text ?? "",
        color,
        __canvasNodeType: type,
        __canvasExtras: extras,
        __canvasGeom: geom,
      } as TextNodeData & CanvasInternalData,
      zIndex: 1,
    }
  })

  const edges: Edge[] = file.edges.map((e) => {
    const { id, fromNode, fromSide, fromEnd, toNode, toSide, toEnd, color, label, ...extras } = e
    const resolvedToEnd = toEnd ?? "arrow"
    const resolvedFromEnd = fromEnd ?? "none"
    const css = colorToCss(color)
    return {
      id,
      type: "canvasEdge",
      source: fromNode,
      target: toNode,
      sourceHandle: fromSide ? `s-${fromSide}` : undefined,
      targetHandle: toSide ? `t-${toSide}` : undefined,
      markerEnd: arrowMarker(resolvedToEnd, css),
      markerStart: arrowMarker(resolvedFromEnd, css),
      style: css ? { stroke: css } : undefined,
      data: {
        color,
        label,
        toEnd: resolvedToEnd,
        fromEnd: resolvedFromEnd,
        __canvasEdgeExtras: extras,
      },
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
  __canvasEdgeExtras?: Record<string, unknown>
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
  return { width: Number(w), height: Number(h) }
}

/** Round a coordinate the user changed; keep the file's exact value when it is untouched. */
function keepOrRound(current: number, original: number | undefined): number {
  return original !== undefined && current === original ? original : Math.round(current)
}

function geometryOf(node: CanvasFlowNode, orig: CanvasGeometry | undefined): CanvasGeometry {
  const { width, height } = sizeOf(node)
  return {
    x: keepOrRound(node.position.x, orig?.x),
    y: keepOrRound(node.position.y, orig?.y),
    width: keepOrRound(width, orig?.width),
    height: keepOrRound(height, orig?.height),
  }
}

export function fromReactFlow(nodes: CanvasFlowNode[], edges: Edge[]): CanvasFile {
  const outNodes: CanvasNode[] = nodes.map((node) => {
    const data = node.data as Partial<TextNodeData & FileNodeData & GroupNodeData> &
      CanvasInternalData
    const geom = geometryOf(node, data.__canvasGeom)
    const common = { id: node.id, ...geom }
    if (node.type === "unknown" && data.__canvasRaw) {
      // Only the geometry may differ from what was read; everything else is the original.
      return { ...data.__canvasRaw, ...common } as unknown as CanvasNode
    }
    const extras = data.__canvasExtras ?? {}
    const originalType = data.__canvasNodeType
    if (node.type === "group") {
      return { ...extras, ...common, type: "group", label: data.label, color: data.color }
    }
    if (node.type === "file") {
      if (originalType === "link") {
        return { ...extras, ...common, type: "link", url: data.file ?? "", color: data.color }
      }
      return {
        ...extras,
        ...common,
        type: "file",
        file: data.file ?? "",
        subpath: data.subpath,
        color: data.color,
      }
    }
    return { ...extras, ...common, type: "text", text: data.text ?? "", color: data.color }
  })

  const outEdges: CanvasEdge[] = edges.map((e) => {
    const d = (e.data ?? {}) as CanvasEdgeData
    const toEnd = d.toEnd ?? (e.markerEnd ? "arrow" : "none")
    const fromEnd = d.fromEnd ?? (e.markerStart ? "arrow" : "none")
    const label = d.label ?? (typeof e.label === "string" ? e.label : undefined)
    return {
      ...(d.__canvasEdgeExtras ?? {}),
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

export function colorToCss(color: string | undefined): string | undefined {
  if (!color) return undefined
  if (color.startsWith("#")) return color
  return OBSIDIAN_CANVAS_PRESET_COLORS[color] ?? undefined
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
