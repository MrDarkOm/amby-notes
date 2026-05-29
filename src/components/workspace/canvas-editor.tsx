import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  Handle,
  Position,
  NodeResizer,
  addEdge,
  getBezierPath,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import MarkdownIt from "markdown-it"
import {
  FileText,
  Plus,
  StickyNote,
  Group as GroupIcon,
  Image as ImageIcon,
  Copy,
  Trash2,
  Palette,
  ArrowUpToLine,
  ArrowDownToLine,
  MoveRight,
  MoveHorizontal,
  Minus,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  parseCanvas,
  toReactFlow,
  fromReactFlow,
  serializeCanvas,
  newCanvasId,
  colorToCss,
  arrowMarker,
  duplicateGraph,
  nodeRect,
  rectContains,
  PRESET_COLOR_KEYS,
  type CanvasFlowNode,
  type CanvasEdgeData,
  type FileNodeData,
  type GroupNodeData,
  type TextNodeData,
  type CanvasEdgeEnd,
} from "@/lib/canvas-format"
import { toAssetUrl, isTauri, importAssetBytes, importAsset } from "@/lib/storage"
import { getTreeDragPayload, clearTreeDragPayload } from "@/lib/canvas-dnd"

// ── Markdown rendering for text cards ────────────────────────────────────────

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function renderCardHtml(text: string): string {
  if (!text || !text.trim()) return ""
  let html = md.render(text)
  // [[target|alias]] → clickable wikilink
  html = html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = target.trim()
    const label = (alias ?? target).trim()
    return `<span class="canvas-wikilink cursor-pointer text-sky-400 hover:underline" data-wikilink="${escapeHtml(t)}">${escapeHtml(label)}</span>`
  })
  // #tag → styled span
  html = html.replace(/(^|\s)#([\p{L}\d/_-]+)/gu, (_m, pre: string, tag: string) => `${pre}<span class="text-amber-400">#${escapeHtml(tag)}</span>`)
  return html
}

function pathStem(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path
  return base.replace(/\.[^.]+$/u, "")
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
function extFromMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg"
  if (mime.startsWith("image/")) return mime.slice(6)
  return "png"
}

// ── Shared context ────────────────────────────────────────────────────────────

interface CanvasCtxValue {
  vault: string | null
  onOpenNote?: (file: string) => void
  updateNodeData: (id: string, patch: Record<string, unknown>) => void
}
const CanvasCtx = React.createContext<CanvasCtxValue>({
  vault: null,
  updateNodeData: () => {},
})
const useCanvasCtx = () => React.useContext(CanvasCtx)

// ── Handles (4 sides, source+target, larger hit area, reveal on hover) ────────

const SIDES: Array<{ side: "top" | "right" | "bottom" | "left"; pos: Position }> = [
  { side: "top", pos: Position.Top },
  { side: "right", pos: Position.Right },
  { side: "bottom", pos: Position.Bottom },
  { side: "left", pos: Position.Left },
]

function SideHandles({ visible }: { visible: boolean }) {
  const base = cn(
    "!size-3 !border-2 !border-zinc-400 !bg-zinc-700 transition-opacity",
    visible ? "!opacity-100" : "!opacity-0",
  )
  return (
    <>
      {SIDES.map(({ side, pos }) => (
        <React.Fragment key={side}>
          <Handle id={`t-${side}`} type="target" position={pos} className={base} />
          <Handle id={`s-${side}`} type="source" position={pos} className={base} />
        </React.Fragment>
      ))}
    </>
  )
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

function TextNode({ id, data, selected }: NodeProps) {
  const { t } = useTranslation()
  const d = data as TextNodeData
  const { updateNodeData, onOpenNote } = useCanvasCtx()
  const [editing, setEditing] = React.useState(false)
  const [hover, setHover] = React.useState(false)
  const accent = colorToCss(d.color)
  const html = React.useMemo(() => renderCardHtml(d.text ?? ""), [d.text])

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-md border bg-zinc-900 text-zinc-100 shadow",
        selected ? "border-zinc-300" : "border-zinc-700",
      )}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
    >
      <NodeResizer minWidth={120} minHeight={60} isVisible={!!selected} />
      <SideHandles visible={hover || !!selected} />
      {editing ? (
        <textarea
          autoFocus
          value={d.text ?? ""}
          placeholder={t("canvas.textPlaceholder")}
          className="nodrag nowheel h-full w-full resize-none bg-transparent p-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          onChange={(e) => updateNodeData(id, { text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              setEditing(false)
            }
          }}
        />
      ) : html ? (
        <div
          className="canvas-md nowheel h-full w-full overflow-auto p-2 text-sm leading-snug text-zinc-100"
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const el = (e.target as HTMLElement).closest("[data-wikilink]") as HTMLElement | null
            if (el) {
              e.stopPropagation()
              onOpenNote?.(el.getAttribute("data-wikilink") ?? "")
            }
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center p-2 text-xs text-zinc-600">
          {t("canvas.doubleClickText")}
        </div>
      )}
    </div>
  )
}

function FileNode({ data, selected }: NodeProps) {
  const { t } = useTranslation()
  const d = data as FileNodeData
  const { vault, onOpenNote } = useCanvasCtx()
  const [hover, setHover] = React.useState(false)
  const accent = colorToCss(d.color)
  const file = d.file ?? ""
  const title = file ? pathStem(file) : ""
  const isImage = IMAGE_RE.test(file)
  const [imgUrl, setImgUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    if (isImage && file) {
      const abs = isTauri() && vault ? `${vault}/${file}` : file
      toAssetUrl(abs).then((u) => {
        if (!cancelled) setImgUrl(u)
      })
    } else {
      setImgUrl(null)
    }
    return () => {
      cancelled = true
    }
  }, [file, isImage, vault])

  return (
    <div
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-md border bg-zinc-900 text-zinc-100 shadow",
        selected ? "border-zinc-300" : "border-zinc-700",
      )}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!isImage && file) onOpenNote?.(file)
      }}
      title={file}
    >
      <NodeResizer minWidth={120} minHeight={80} isVisible={!!selected} />
      <SideHandles visible={hover || !!selected} />
      {isImage && imgUrl ? (
        <img src={imgUrl} alt={title} className="h-full w-full object-contain" draggable={false} />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
          {isImage ? <ImageIcon className="size-5 text-zinc-400" /> : <FileText className="size-5 text-zinc-400" />}
          <span className="line-clamp-3 text-sm font-medium text-zinc-200">{title || t("canvas.noteNotSelected")}</span>
          {file && !isImage ? <span className="text-[10px] text-zinc-600">{t("canvas.doubleClickOpen")}</span> : null}
        </div>
      )}
    </div>
  )
}

function GroupNode({ id, data, selected }: NodeProps) {
  const { t } = useTranslation()
  const d = data as GroupNodeData
  const { updateNodeData } = useCanvasCtx()
  const [editing, setEditing] = React.useState(false)
  const [hover, setHover] = React.useState(false)
  const accent = colorToCss(d.color) ?? "#52525b"
  return (
    <div
      className="group relative flex h-full w-full flex-col rounded-md border-2 border-dashed"
      style={{ borderColor: accent, backgroundColor: `${accent}14` }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
    >
      <NodeResizer minWidth={160} minHeight={120} isVisible={!!selected} color={accent} />
      <SideHandles visible={hover || !!selected} />
      {editing ? (
        <input
          autoFocus
          value={d.label ?? ""}
          placeholder={t("canvas.groupPlaceholder")}
          className="nodrag m-1 w-fit max-w-[90%] rounded bg-zinc-900/80 px-1 text-xs font-medium text-zinc-200 outline-none"
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault()
              setEditing(false)
            }
          }}
        />
      ) : (
        <span
          className="m-1 max-w-[90%] truncate px-1 text-xs font-medium"
          style={{ color: accent }}
        >
          {d.label || t("canvas.groupFallback")}
        </span>
      )}
    </div>
  )
}

const NODE_TYPES: NodeTypes = {
  text: TextNode,
  file: FileNode,
  group: GroupNode,
}

// ── Custom edge (label edit, arrowheads, color) ───────────────────────────────

function CanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  markerStart,
  style,
  data,
  selected,
}: EdgeProps) {
  const d = (data ?? {}) as CanvasEdgeData
  const [editing, setEditing] = React.useState(false)
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const rf = useReactFlow()
  const setLabel = (label: string) =>
    rf.setEdges((eds) => eds.map((e) => (e.id === id ? { ...e, data: { ...e.data, label } } : e)))

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={{ ...style, strokeWidth: selected ? 2.5 : 1.5 }}
      />
      <EdgeLabelRenderer>
        {editing ? (
          <input
            autoFocus
            value={d.label ?? ""}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault()
                setEditing(false)
              }
            }}
            className="nodrag nopan absolute rounded border border-zinc-600 bg-zinc-900 px-1 text-[11px] text-zinc-100 outline-none"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}
          />
        ) : d.label ? (
          <div
            className="nodrag nopan absolute cursor-text rounded bg-zinc-900/90 px-1 text-[11px] text-zinc-200"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            {d.label}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  )
}

const EDGE_TYPES: EdgeTypes = { canvasEdge: CanvasEdge }

// ── Color swatches ──────────────────────────────────────────────────────────

function ColorSwatches({ onPick }: { onPick: (key: string | undefined) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <button
        type="button"
        title={t("canvas.reset")}
        onClick={() => onPick(undefined)}
        className="size-4 rounded-full border border-zinc-600 bg-transparent"
      />
      {PRESET_COLOR_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(key)}
          className="size-4 rounded-full border border-black/30"
          style={{ backgroundColor: colorToCss(key) }}
        />
      ))}
    </div>
  )
}

// ── Lightweight context menu ──────────────────────────────────────────────────

interface MenuState {
  x: number
  y: number
  kind: "pane" | "node" | "edge"
  targetId?: string
  flow: { x: number; y: number }
}

function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-zinc-800",
        danger ? "text-red-400 hover:text-red-300" : "text-zinc-200",
      )}
    >
      {children}
    </button>
  )
}

// ── Editor ─────────────────────────────────────────────────────────────────────

export interface CanvasEditorProps {
  value: string
  onChange: (json: string) => void
  vault: string | null
  notePath?: string
  onOpenNote?: (file: string) => void
}

const clipboard: { nodes: CanvasFlowNode[]; edges: Edge[] } = { nodes: [], edges: [] }

function CanvasEditorInner({ value, onChange, vault, notePath, onOpenNote }: CanvasEditorProps) {
  const { t } = useTranslation()
  const initial = React.useMemo(() => toReactFlow(parseCanvas(value)), [])
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const rf = useReactFlow()
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const mounted = React.useRef(false)
  const [menu, setMenu] = React.useState<MenuState | null>(null)
  const dragGroup = React.useRef<{ groupId: string; start: { x: number; y: number }; members: Map<string, { x: number; y: number }> } | null>(null)

  // ── persistence ──
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    onChange(serializeCanvas(fromReactFlow(nodes, edges)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  const updateNodeData = React.useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
    },
    [setNodes],
  )

  const ctx = React.useMemo<CanvasCtxValue>(
    () => ({ vault, onOpenNote, updateNodeData }),
    [vault, onOpenNote, updateNodeData],
  )

  // ── connect ──
  const onConnect = React.useCallback(
    (conn: Connection) => {
      const edge: Edge = {
        id: newCanvasId(),
        type: "canvasEdge",
        source: conn.source,
        target: conn.target,
        sourceHandle: conn.sourceHandle ?? undefined,
        targetHandle: conn.targetHandle ?? undefined,
        markerEnd: arrowMarker("arrow"),
        data: { toEnd: "arrow", fromEnd: "none" },
      }
      setEdges((eds) => addEdge(edge, eds))
    },
    [setEdges],
  )

  // ── add nodes ──
  const makeNode = React.useCallback((type: "text" | "file" | "group", pos: { x: number; y: number }, extra?: Partial<FileNodeData>): CanvasFlowNode => {
    const id = newCanvasId()
    const base = { id, position: { x: Math.round(pos.x), y: Math.round(pos.y) }, selected: true }
    if (type === "group") {
      return { ...base, type: "group", data: { label: "" } as GroupNodeData, style: { width: 320, height: 240 }, width: 320, height: 240, zIndex: 0 }
    }
    if (type === "file") {
      return { ...base, type: "file", data: { file: extra?.file ?? "" } as FileNodeData, style: { width: 240, height: 120 }, width: 240, height: 120, zIndex: 1 }
    }
    return { ...base, type: "text", data: { text: "" } as TextNodeData, style: { width: 240, height: 120 }, width: 240, height: 120, zIndex: 1 }
  }, [])

  const addNode = React.useCallback(
    (type: "text" | "file" | "group", pos?: { x: number; y: number }) => {
      const p = pos ?? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), makeNode(type, p)])
    },
    [rf, setNodes, makeNode],
  )

  // ── duplicate / clipboard ──
  const duplicateSelection = React.useCallback(() => {
    const selNodes = rf.getNodes().filter((n) => n.selected) as CanvasFlowNode[]
    if (selNodes.length === 0) return
    const selIds = new Set(selNodes.map((n) => n.id))
    const selEdges = rf.getEdges().filter((e) => selIds.has(e.source) && selIds.has(e.target))
    const dup = duplicateGraph(selNodes, selEdges)
    setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...dup.nodes])
    setEdges((eds) => [...eds, ...dup.edges])
  }, [rf, setNodes, setEdges])

  const copySelection = React.useCallback(() => {
    const selNodes = rf.getNodes().filter((n) => n.selected) as CanvasFlowNode[]
    const selIds = new Set(selNodes.map((n) => n.id))
    clipboard.nodes = selNodes
    clipboard.edges = rf.getEdges().filter((e) => selIds.has(e.source) && selIds.has(e.target))
  }, [rf])

  const pasteClipboard = React.useCallback(() => {
    if (clipboard.nodes.length === 0) return
    const dup = duplicateGraph(clipboard.nodes, clipboard.edges, 48)
    setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...dup.nodes])
    setEdges((eds) => [...eds, ...dup.edges])
  }, [setNodes, setEdges])

  // ── colors / z-order / arrows ──
  const setNodeColor = React.useCallback((id: string, color?: string) => updateNodeData(id, { color }), [updateNodeData])

  const setEdgeColor = React.useCallback(
    (id: string, color?: string) => {
      const css = colorToCss(color)
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== id) return e
          const d = (e.data ?? {}) as CanvasEdgeData
          return {
            ...e,
            data: { ...d, color },
            style: { ...e.style, stroke: css },
            markerEnd: arrowMarker(d.toEnd ?? "arrow", css),
            markerStart: arrowMarker(d.fromEnd ?? "none", css),
          }
        }),
      )
    },
    [setEdges],
  )

  const cycleArrows = React.useCallback(
    (id: string, mode: "to" | "both" | "none") => {
      const toEnd: CanvasEdgeEnd = mode === "none" ? "none" : "arrow"
      const fromEnd: CanvasEdgeEnd = mode === "both" ? "arrow" : "none"
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== id) return e
          const d = (e.data ?? {}) as CanvasEdgeData
          const css = colorToCss(d.color)
          return {
            ...e,
            data: { ...d, toEnd, fromEnd },
            markerEnd: arrowMarker(toEnd, css),
            markerStart: arrowMarker(fromEnd, css),
          }
        }),
      )
    },
    [setEdges],
  )

  const bringTo = React.useCallback(
    (id: string, dir: "front" | "back") => {
      const zs = rf.getNodes().map((n) => n.zIndex ?? 0)
      const z = dir === "front" ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, zIndex: z } : n)))
    },
    [rf, setNodes],
  )

  const removeNode = React.useCallback((id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id))
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
  }, [setNodes, setEdges])

  const removeEdge = React.useCallback((id: string) => setEdges((eds) => eds.filter((e) => e.id !== id)), [setEdges])

  // ── group containment on drag ──
  const onNodeDragStart = React.useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (node.type !== "group") {
        dragGroup.current = null
        return
      }
      const all = rf.getNodes() as CanvasFlowNode[]
      const outer = nodeRect(node as CanvasFlowNode)
      const members = new Map<string, { x: number; y: number }>()
      for (const n of all) {
        if (n.id === node.id) continue
        if (rectContains(outer, nodeRect(n))) members.set(n.id, { x: n.position.x, y: n.position.y })
      }
      dragGroup.current = { groupId: node.id, start: { x: node.position.x, y: node.position.y }, members }
    },
    [rf],
  )

  const onNodeDrag = React.useCallback(
    (_e: React.MouseEvent, node: Node) => {
      const g = dragGroup.current
      if (!g || g.groupId !== node.id) return
      const dx = node.position.x - g.start.x
      const dy = node.position.y - g.start.y
      setNodes((nds) =>
        nds.map((n) => {
          const m = g.members.get(n.id)
          return m ? { ...n, position: { x: m.x + dx, y: m.y + dy } } : n
        }),
      )
    },
    [setNodes],
  )

  const onNodeDragStop = React.useCallback(() => {
    dragGroup.current = null
  }, [])

  // ── keyboard: copy/paste/duplicate/nudge ──
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === "c") {
        copySelection()
      } else if (mod && e.key === "v") {
        pasteClipboard()
      } else if (mod && e.key === "d") {
        e.preventDefault()
        duplicateSelection()
      } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        const step = e.shiftKey ? 20 : 1
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
        if (dx || dy) {
          const hasSel = rf.getNodes().some((n) => n.selected)
          if (hasSel) {
            e.preventDefault()
            setNodes((nds) => nds.map((n) => (n.selected ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n)))
          }
        }
      }
    }
    const el = wrapRef.current
    el?.addEventListener("keydown", onKey)
    return () => el?.removeEventListener("keydown", onKey)
  }, [copySelection, pasteClipboard, duplicateSelection, rf, setNodes])

  // ── image paste ──
  React.useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const items = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      if (items.length === 0 || !vault || !notePath) return
      e.preventDefault()
      const pos = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      for (const item of items) {
        const file = item.getAsFile()
        if (!file) continue
        const bytes = new Uint8Array(await file.arrayBuffer())
        const res = await importAssetBytes(vault, notePath, bytes, extFromMime(file.type))
        if (res) setNodes((nds) => [...nds, makeNode("file", pos, { file: res.relPath })])
      }
    }
    const el = wrapRef.current
    el?.addEventListener("paste", onPaste)
    return () => el?.removeEventListener("paste", onPaste)
  }, [vault, notePath, rf, setNodes, makeNode])

  // ── Finder file drop (Tauri) ──
  React.useEffect(() => {
    if (!isTauri() || !vault || !notePath) return
    let unlisten: (() => void) | undefined
    let lastPointer = { x: 0, y: 0 }
    const track = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener("pointermove", track)
    ;(async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        const payload = event.payload as { type: string; paths?: string[] }
        if (payload.type !== "drop" || !payload.paths) return
        const pos = rf.screenToFlowPosition(lastPointer)
        for (const src of payload.paths) {
          const res = await importAsset(vault, notePath, src)
          if (res) setNodes((nds) => [...nds, makeNode("file", pos, { file: res.relPath })])
        }
      })
    })()
    return () => {
      window.removeEventListener("pointermove", track)
      unlisten?.()
    }
  }, [vault, notePath, rf, setNodes, makeNode])

  // ── tree-note drop onto canvas ──
  const onPaneDrop = React.useCallback(
    (clientX: number, clientY: number) => {
      const payload = getTreeDragPayload()
      if (!payload) return
      clearTreeDragPayload()
      const pos = rf.screenToFlowPosition({ x: clientX, y: clientY })
      setNodes((nds) => [...nds, makeNode("file", pos, { file: payload.path })])
    },
    [rf, setNodes, makeNode],
  )

  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onUp = (e: PointerEvent) => onPaneDrop(e.clientX, e.clientY)
    el.addEventListener("pointerup", onUp)
    return () => el.removeEventListener("pointerup", onUp)
  }, [onPaneDrop])

  // ── context menu helpers ──
  const openMenu = (e: React.MouseEvent, kind: MenuState["kind"], targetId?: string) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, kind, targetId, flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) })
  }
  const closeMenu = () => setMenu(null)

  return (
    <div ref={wrapRef} tabIndex={0} className="relative h-full w-full outline-none">
      <CanvasCtx.Provider value={ctx}>
        <ReactFlow
          nodes={nodes as Node[]}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode="dark"
          fitView
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          selectNodesOnDrag={false}
          onPaneClick={closeMenu}
          onPaneContextMenu={(e) => openMenu(e as React.MouseEvent, "pane")}
          onNodeContextMenu={(e, n) => openMenu(e, "node", n.id)}
          onEdgeContextMenu={(e, ed) => openMenu(e, "edge", ed.id)}
          className="bg-background"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#3f3f46" />
          <Controls className="!border-zinc-700 !bg-zinc-900" />
          <MiniMap className="!bg-zinc-900" maskColor="rgba(0,0,0,0.6)" nodeColor="#52525b" pannable zoomable />
        </ReactFlow>

        {/* Floating add-node toolbar */}
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/90 p-1 shadow backdrop-blur">
          <ToolbarButton title={t("canvas.textCard")} onClick={() => addNode("text")}>
            <StickyNote className="size-4" />
          </ToolbarButton>
          <ToolbarButton title={t("canvas.noteCard")} onClick={() => addNode("file")}>
            <FileText className="size-4" />
          </ToolbarButton>
          <ToolbarButton title={t("canvas.group")} onClick={() => addNode("group")}>
            <GroupIcon className="size-4" />
          </ToolbarButton>
          <div className="px-1 text-[10px] text-zinc-600">
            <Plus className="size-3" />
          </div>
        </div>

        {/* Context menu */}
        {menu ? (
          <>
            <div className="fixed inset-0 z-20" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu() }} />
            <div
              className="fixed z-30 min-w-[180px] overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
              style={{ left: menu.x, top: menu.y }}
            >
              {menu.kind === "pane" ? (
                <>
                  <MenuItem onClick={() => { addNode("text", menu.flow); closeMenu() }}>
                    <StickyNote className="size-3.5 text-zinc-400" />{t("canvas.textCard")}
                  </MenuItem>
                  <MenuItem onClick={() => { addNode("file", menu.flow); closeMenu() }}>
                    <FileText className="size-3.5 text-zinc-400" />{t("canvas.noteCard")}
                  </MenuItem>
                  <MenuItem onClick={() => { addNode("group", menu.flow); closeMenu() }}>
                    <GroupIcon className="size-3.5 text-zinc-400" />{t("canvas.group")}
                  </MenuItem>
                  {clipboard.nodes.length > 0 ? (
                    <MenuItem onClick={() => { pasteClipboard(); closeMenu() }}>
                      <Copy className="size-3.5 text-zinc-400" />{t("canvas.paste")}
                    </MenuItem>
                  ) : null}
                </>
              ) : menu.kind === "node" && menu.targetId ? (
                <>
                  <MenuItem onClick={() => { duplicateSelectionOrOne(menu.targetId!); closeMenu() }}>
                    <Copy className="size-3.5 text-zinc-400" />{t("canvas.duplicate")}
                  </MenuItem>
                  <MenuItem onClick={() => { bringTo(menu.targetId!, "front"); closeMenu() }}>
                    <ArrowUpToLine className="size-3.5 text-zinc-400" />{t("canvas.bringToFront")}
                  </MenuItem>
                  <MenuItem onClick={() => { bringTo(menu.targetId!, "back"); closeMenu() }}>
                    <ArrowDownToLine className="size-3.5 text-zinc-400" />{t("canvas.sendToBack")}
                  </MenuItem>
                  <div className="flex items-center gap-1 border-t border-zinc-800 px-1 pt-1 text-zinc-500">
                    <Palette className="ml-1.5 size-3.5" />
                    <ColorSwatches onPick={(c) => { setNodeColor(menu.targetId!, c); closeMenu() }} />
                  </div>
                  <div className="border-t border-zinc-800" />
                  <MenuItem danger onClick={() => { removeNode(menu.targetId!); closeMenu() }}>
                    <Trash2 className="size-3.5" />{t("canvas.delete")}
                  </MenuItem>
                </>
              ) : menu.kind === "edge" && menu.targetId ? (
                <>
                  <MenuItem onClick={() => { cycleArrows(menu.targetId!, "to"); closeMenu() }}>
                    <MoveRight className="size-3.5 text-zinc-400" />{t("canvas.arrowRight")}
                  </MenuItem>
                  <MenuItem onClick={() => { cycleArrows(menu.targetId!, "both"); closeMenu() }}>
                    <MoveHorizontal className="size-3.5 text-zinc-400" />{t("canvas.arrowBoth")}
                  </MenuItem>
                  <MenuItem onClick={() => { cycleArrows(menu.targetId!, "none"); closeMenu() }}>
                    <Minus className="size-3.5 text-zinc-400" />{t("canvas.noArrows")}
                  </MenuItem>
                  <div className="flex items-center gap-1 border-t border-zinc-800 px-1 pt-1 text-zinc-500">
                    <Palette className="ml-1.5 size-3.5" />
                    <ColorSwatches onPick={(c) => { setEdgeColor(menu.targetId!, c); closeMenu() }} />
                  </div>
                  <div className="border-t border-zinc-800" />
                  <MenuItem danger onClick={() => { removeEdge(menu.targetId!); closeMenu() }}>
                    <Trash2 className="size-3.5" />{t("canvas.delete")}
                  </MenuItem>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </CanvasCtx.Provider>
    </div>
  )

  // Duplicate a single node (used from node context menu) by selecting then duplicating.
  function duplicateSelectionOrOne(id: string) {
    const node = rf.getNodes().find((n) => n.id === id) as CanvasFlowNode | undefined
    if (!node) return
    const dup = duplicateGraph([node], [])
    setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...dup.nodes])
  }
}

function ToolbarButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-white"
    >
      {children}
    </button>
  )
}

export function CanvasEditor(props: CanvasEditorProps) {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner {...props} />
    </ReactFlowProvider>
  )
}
