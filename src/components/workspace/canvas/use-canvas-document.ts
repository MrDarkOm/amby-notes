"use client"

import * as React from "react"
import {
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react"

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
  type CanvasFlowNode,
  type CanvasEdgeData,
  type FileNodeData,
  type GroupNodeData,
  type TextNodeData,
  type CanvasEdgeEnd,
} from "@/lib/canvas-format"

const clipboard: { nodes: CanvasFlowNode[]; edges: Edge[] } = { nodes: [], edges: [] }

export function useCanvasDocument({
  value,
  onChange,
  wrapRef,
}: {
  value: string
  onChange: (json: string) => void
  wrapRef: React.RefObject<HTMLDivElement | null>
}) {
  const [initial] = React.useState(() => toReactFlow(parseCanvas(value)))
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasFlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const rf = useReactFlow()
  const mounted = React.useRef(false)
  const dragGroup = React.useRef<{
    groupId: string
    start: { x: number; y: number }
    members: Map<string, { x: number; y: number }>
  } | null>(null)

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
  const makeNode = React.useCallback(
    (
      type: "text" | "file" | "group",
      pos: { x: number; y: number },
      extra?: Partial<FileNodeData>,
    ): CanvasFlowNode => {
      const id = newCanvasId()
      const base = { id, position: { x: Math.round(pos.x), y: Math.round(pos.y) }, selected: true }
      if (type === "group") {
        return {
          ...base,
          type: "group",
          data: { label: "" } as GroupNodeData,
          style: { width: 320, height: 240 },
          width: 320,
          height: 240,
          zIndex: 0,
        }
      }
      if (type === "file") {
        return {
          ...base,
          type: "file",
          data: { file: extra?.file ?? "" } as FileNodeData,
          style: { width: 240, height: 120 },
          width: 240,
          height: 120,
          zIndex: 1,
        }
      }
      return {
        ...base,
        type: "text",
        data: { text: "" } as TextNodeData,
        style: { width: 240, height: 120 },
        width: 240,
        height: 120,
        zIndex: 1,
      }
    },
    [],
  )

  const addNode = React.useCallback(
    (type: "text" | "file" | "group", pos?: { x: number; y: number }) => {
      const p =
        pos ?? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
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

  const hasClipboard = clipboard.nodes.length > 0

  // ── colors / z-order / arrows ──
  const setNodeColor = React.useCallback(
    (id: string, color?: string) => updateNodeData(id, { color }),
    [updateNodeData],
  )

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

  const removeNode = React.useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id))
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
    },
    [setNodes, setEdges],
  )

  const removeEdge = React.useCallback(
    (id: string) => setEdges((eds) => eds.filter((e) => e.id !== id)),
    [setEdges],
  )

  const duplicateNode = React.useCallback(
    (id: string) => {
      const node = rf.getNodes().find((n) => n.id === id) as CanvasFlowNode | undefined
      if (!node) return
      const dup = duplicateGraph([node], [])
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...dup.nodes])
    },
    [rf, setNodes],
  )

  // ── group containment on drag ──
  const onNodeDragStart = React.useCallback(
    (_e: MouseEvent | TouchEvent, node: Node) => {
      if (node.type !== "group") {
        dragGroup.current = null
        return
      }
      const all = rf.getNodes() as CanvasFlowNode[]
      const outer = nodeRect(node as CanvasFlowNode)
      const members = new Map<string, { x: number; y: number }>()
      for (const n of all) {
        if (n.id === node.id) continue
        if (rectContains(outer, nodeRect(n)))
          members.set(n.id, { x: n.position.x, y: n.position.y })
      }
      dragGroup.current = {
        groupId: node.id,
        start: { x: node.position.x, y: node.position.y },
        members,
      }
    },
    [rf],
  )

  const onNodeDrag = React.useCallback(
    (_e: MouseEvent | TouchEvent, node: Node) => {
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
            setNodes((nds) =>
              nds.map((n) =>
                n.selected ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
              ),
            )
          }
        }
      }
    }
    const el = wrapRef.current
    el?.addEventListener("keydown", onKey)
    return () => el?.removeEventListener("keydown", onKey)
  }, [copySelection, pasteClipboard, duplicateSelection, rf, setNodes, wrapRef])

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    makeNode,
    addNode,
    setNodes,
    updateNodeData,
    duplicateSelection,
    copySelection,
    pasteClipboard,
    hasClipboard,
    setNodeColor,
    setEdgeColor,
    cycleArrows,
    bringTo,
    removeNode,
    removeEdge,
    duplicateNode,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
  }
}
