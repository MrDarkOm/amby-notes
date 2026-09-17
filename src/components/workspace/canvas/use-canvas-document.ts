"use client"

import * as React from "react"
import {
  useNodesState,
  useEdgesState,
  addEdge,
  reconnectEdge as rfReconnectEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
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
  type CanvasFile,
  type CanvasEdgeData,
  type FileNodeData,
  type GroupNodeData,
  type TextNodeData,
  type CanvasEdgeEnd,
} from "@/lib/canvas-format"
import { registerEditorSerialization } from "../tiptap/editor-serialization-lifecycle"
import { CanvasHistory } from "./canvas-history"
import {
  alignNodes,
  distributeNodes,
  getNodeRect,
  type AlignmentType,
  type DistributionAxis,
} from "./canvas-alignment"
import { computeAutoLayout, type LayoutOptions } from "./canvas-layout"

const clipboard: { nodes: CanvasFlowNode[]; edges: Edge[] } = { nodes: [], edges: [] }

export function useCanvasDocument({
  value,
  onChange,
  wrapRef,
  onLocalEdit,
}: {
  value: string
  onChange: (json: string) => void
  wrapRef: React.RefObject<HTMLDivElement | null>
  onLocalEdit?: () => void
}) {
  const canvasTemplateRef = React.useRef<CanvasFile | null>(null)
  if (!canvasTemplateRef.current) canvasTemplateRef.current = parseCanvas(value)
  const [initial] = React.useState(() => toReactFlow(canvasTemplateRef.current!))
  const [nodes, setNodes, applyNodesChange] = useNodesState<CanvasFlowNode>(initial.nodes)
  const [edges, setEdges, applyEdgesChange] = useEdgesState<Edge>(initial.edges)
  const rf = useReactFlow()
  const onChangeRef = React.useRef(onChange)
  const onLocalEditRef = React.useRef(onLocalEdit)
  onChangeRef.current = onChange
  onLocalEditRef.current = onLocalEdit
  const nodesRef = React.useRef(nodes)
  const edgesRef = React.useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges
  const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistMaxTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPublishedRef = React.useRef<string | null>(null)
  if (lastPublishedRef.current === null) {
    lastPublishedRef.current = serializeCanvas(canvasTemplateRef.current!)
  }

  // Track cursor position for pasting
  const mousePosRef = React.useRef<{ x: number; y: number } | null>(null)

  // History manager
  const historyRef = React.useRef(new CanvasHistory({ nodes: initial.nodes, edges: initial.edges }))
  const [canUndo, setCanUndo] = React.useState(false)
  const [canRedo, setCanRedo] = React.useState(false)

  const updateHistoryStatus = React.useCallback(() => {
    setCanUndo(historyRef.current.canUndo())
    setCanRedo(historyRef.current.canRedo())
  }, [])

  const recordSnapshot = React.useCallback(
    (customNodes?: CanvasFlowNode[], customEdges?: Edge[]) => {
      const currentNodes = customNodes ?? nodesRef.current
      const currentEdges = customEdges ?? edgesRef.current
      const pushed = historyRef.current.push({ nodes: currentNodes, edges: currentEdges })
      if (pushed) updateHistoryStatus()
    },
    [updateHistoryStatus],
  )

  const dragGroup = React.useRef<{
    groupId: string
    start: { x: number; y: number }
    members: Map<string, { x: number; y: number }>
  } | null>(null)

  const publishCanvas = React.useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    if (persistMaxTimerRef.current) clearTimeout(persistMaxTimerRef.current)
    persistTimerRef.current = null
    persistMaxTimerRef.current = null
    const flow = fromReactFlow(nodesRef.current, edgesRef.current)
    const template = canvasTemplateRef.current!
    const json = serializeCanvas({
      ...template,
      nodes: flow.nodes,
      edges: flow.edges,
    })
    if (json === lastPublishedRef.current) return
    lastPublishedRef.current = json
    onChangeRef.current(json)
  }, [])

  const schedulePublish = React.useCallback(
    (delayMs = 500) => {
      onLocalEditRef.current?.()
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null
        publishCanvas()
      }, delayMs)
      if (!persistMaxTimerRef.current) {
        persistMaxTimerRef.current = setTimeout(
          () => {
            persistMaxTimerRef.current = null
            publishCanvas()
          },
          Math.max(500, delayMs),
        )
      }
    },
    [publishCanvas],
  )

  React.useEffect(() => {
    const parsed = parseCanvas(value)
    const serialized = serializeCanvas(parsed)
    if (serialized === lastPublishedRef.current) return
    canvasTemplateRef.current = parsed
    lastPublishedRef.current = serialized
    const nextFlow = toReactFlow(parsed)
    setNodes(nextFlow.nodes)
    setEdges(nextFlow.edges)
    historyRef.current = new CanvasHistory({ nodes: nextFlow.nodes, edges: nextFlow.edges })
    updateHistoryStatus()
  }, [value, setNodes, setEdges, updateHistoryStatus])

  React.useEffect(() => registerEditorSerialization({ flush: publishCanvas }), [publishCanvas])

  React.useEffect(
    () => () => {
      publishCanvas()
    },
    [publishCanvas],
  )

  // Track mouse coordinates for pasting at cursor
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY }
    }
    el.addEventListener("mousemove", onMove)
    return () => el.removeEventListener("mousemove", onMove)
  }, [wrapRef])

  const onNodesChange = React.useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      applyNodesChange(changes)

      // Never publish or record history for pure selection changes
      const nonSelectChanges = changes.filter((change) => change.type !== "select")
      if (nonSelectChanges.length === 0) return

      const finishedResize = changes.some(
        (change) => change.type === "dimensions" && change.resizing === false,
      )
      if (finishedResize) {
        recordSnapshot()
        schedulePublish(0)
        return
      }

      const activeGesture = changes.some(
        (change) =>
          (change.type === "position" && change.dragging === true) ||
          (change.type === "dimensions" && change.resizing === true),
      )
      if (activeGesture) {
        schedulePublish(500)
      }
    },
    [applyNodesChange, recordSnapshot, schedulePublish],
  )

  const onEdgesChange = React.useCallback(
    (changes: Parameters<typeof applyEdgesChange>[0]) => {
      applyEdgesChange(changes)
      const nonSelect = changes.filter((change) => change.type !== "select")
      if (nonSelect.length > 0) {
        if (nonSelect.some((change) => change.type === "remove")) {
          recordSnapshot()
        }
        schedulePublish(0)
      }
    },
    [applyEdgesChange, recordSnapshot, schedulePublish],
  )

  // ── Undo / Redo ──
  const undo = React.useCallback(() => {
    const previous = historyRef.current.undo()
    if (!previous) return
    setNodes(previous.nodes)
    setEdges(previous.edges)
    updateHistoryStatus()
    schedulePublish(0)
  }, [schedulePublish, setEdges, setNodes, updateHistoryStatus])

  const redo = React.useCallback(() => {
    const next = historyRef.current.redo()
    if (!next) return
    setNodes(next.nodes)
    setEdges(next.edges)
    updateHistoryStatus()
    schedulePublish(0)
  }, [schedulePublish, setEdges, setNodes, updateHistoryStatus])

  const updateNodeData = React.useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((nds) => {
        const next = nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))
        recordSnapshot(next, edgesRef.current)
        return next
      })
      schedulePublish()
    },
    [recordSnapshot, schedulePublish, setNodes],
  )

  // ── Connect & Reconnect ──
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
      setEdges((eds) => {
        const next = addEdge(edge, eds)
        recordSnapshot(nodesRef.current, next)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setEdges],
  )

  const onReconnect = React.useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      setEdges((eds) => {
        const next = rfReconnectEdge(oldEdge, newConnection, eds)
        recordSnapshot(nodesRef.current, next)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setEdges],
  )

  // ── Add Nodes ──
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
          data: { label: "", __canvasNodeType: "group" } as GroupNodeData,
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
          data: { file: extra?.file ?? "", __canvasNodeType: "file" } as FileNodeData,
          style: { width: 260, height: 160 },
          width: 260,
          height: 160,
          zIndex: 1,
        }
      }
      return {
        ...base,
        type: "text",
        data: { text: "", __canvasNodeType: "text" } as TextNodeData,
        style: { width: 240, height: 120 },
        width: 240,
        height: 120,
        zIndex: 1,
      }
    },
    [],
  )

  const addNode = React.useCallback(
    (
      type: "text" | "file" | "group",
      pos?: { x: number; y: number },
      extra?: Partial<FileNodeData>,
    ) => {
      const p =
        pos ?? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      const newNode = makeNode(type, p, extra)
      setNodes((nds) => {
        const next = [...nds.map((n) => ({ ...n, selected: false })), newNode]
        recordSnapshot(next, edgesRef.current)
        return next
      })
      schedulePublish(0)
    },
    [makeNode, recordSnapshot, rf, schedulePublish, setNodes],
  )

  const addNodesAndEdges = React.useCallback(
    (newNodes: CanvasFlowNode[], newEdges: Edge[]) => {
      const existingNodeIds = new Set(nodesRef.current.map((n) => n.id))
      const existingEdgeIds = new Set(edgesRef.current.map((e) => e.id))

      const idMap = new Map<string, string>()
      const sanitizedNodes = newNodes.map((n) => {
        if (existingNodeIds.has(n.id)) {
          const freshId = newCanvasId()
          idMap.set(n.id, freshId)
          return { ...n, id: freshId, selected: true }
        }
        return { ...n, selected: true }
      })

      const sanitizedEdges = newEdges.map((e) => {
        const source = idMap.get(e.source) ?? e.source
        const target = idMap.get(e.target) ?? e.target
        const edgeId = existingEdgeIds.has(e.id) ? newCanvasId() : e.id
        return { ...e, id: edgeId, source, target, selected: true }
      })

      const nextNodes = [
        ...nodesRef.current.map((n) => ({ ...n, selected: false })),
        ...sanitizedNodes,
      ]
      const nextEdges = [...edgesRef.current, ...sanitizedEdges]

      setNodes(nextNodes)
      setEdges(nextEdges)
      recordSnapshot(nextNodes, nextEdges)
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setEdges, setNodes],
  )

  // ── Duplicate / Clipboard ──
  const duplicateSelection = React.useCallback(() => {
    const selNodes = rf.getNodes().filter((n) => n.selected) as CanvasFlowNode[]
    if (selNodes.length === 0) return
    const selIds = new Set(selNodes.map((n) => n.id))
    const selEdges = rf.getEdges().filter((e) => selIds.has(e.source) && selIds.has(e.target))
    const dup = duplicateGraph(selNodes, selEdges)
    const nextNodes = [...nodesRef.current.map((n) => ({ ...n, selected: false })), ...dup.nodes]
    const nextEdges = [...edgesRef.current, ...dup.edges]
    setNodes(nextNodes)
    setEdges(nextEdges)
    recordSnapshot(nextNodes, nextEdges)
    schedulePublish(0)
  }, [recordSnapshot, rf, schedulePublish, setEdges, setNodes])

  const copySelection = React.useCallback(() => {
    const selNodes = rf.getNodes().filter((n) => n.selected) as CanvasFlowNode[]
    const selIds = new Set(selNodes.map((n) => n.id))
    clipboard.nodes = selNodes
    clipboard.edges = rf.getEdges().filter((e) => selIds.has(e.source) && selIds.has(e.target))
  }, [rf])

  const pasteClipboard = React.useCallback(
    (targetPos?: { x: number; y: number }) => {
      if (clipboard.nodes.length === 0) return
      let offsetPos = targetPos
      if (!offsetPos && mousePosRef.current) {
        offsetPos = rf.screenToFlowPosition(mousePosRef.current)
      }

      if (offsetPos && clipboard.nodes.length > 0) {
        // Find bounding box center of clipboard nodes
        let minX = Infinity
        let minY = Infinity
        for (const n of clipboard.nodes) {
          if (n.position.x < minX) minX = n.position.x
          if (n.position.y < minY) minY = n.position.y
        }
        const dx = offsetPos.x - minX
        const dy = offsetPos.y - minY

        const idMap = new Map<string, string>()
        const newNodes = clipboard.nodes.map((n) => {
          const id = newCanvasId()
          idMap.set(n.id, id)
          return {
            ...n,
            id,
            position: { x: Math.round(n.position.x + dx), y: Math.round(n.position.y + dy) },
            selected: true,
          }
        })
        const newEdges = clipboard.edges
          .filter((e) => idMap.has(e.source) && idMap.has(e.target))
          .map((e) => ({
            ...e,
            id: newCanvasId(),
            source: idMap.get(e.source)!,
            target: idMap.get(e.target)!,
            selected: true,
          }))

        const nextNodes = [...nodesRef.current.map((n) => ({ ...n, selected: false })), ...newNodes]
        const nextEdges = [...edgesRef.current, ...newEdges]
        setNodes(nextNodes)
        setEdges(nextEdges)
        recordSnapshot(nextNodes, nextEdges)
      } else {
        const dup = duplicateGraph(clipboard.nodes, clipboard.edges, 48)
        const nextNodes = [
          ...nodesRef.current.map((n) => ({ ...n, selected: false })),
          ...dup.nodes,
        ]
        const nextEdges = [...edgesRef.current, ...dup.edges]
        setNodes(nextNodes)
        setEdges(nextEdges)
        recordSnapshot(nextNodes, nextEdges)
      }
      schedulePublish(0)
    },
    [recordSnapshot, rf, schedulePublish, setEdges, setNodes],
  )

  const hasClipboard = clipboard.nodes.length > 0

  // ── Group Selection ──
  const groupSelection = React.useCallback(() => {
    const selNodes = rf.getNodes().filter((n) => n.selected) as CanvasFlowNode[]
    if (selNodes.length === 0) return

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    for (const n of selNodes) {
      const rect = getNodeRect(n)
      if (rect.x < minX) minX = rect.x
      if (rect.x + rect.width > maxX) maxX = rect.x + rect.width
      if (rect.y < minY) minY = rect.y
      if (rect.y + rect.height > maxY) maxY = rect.y + rect.height
    }

    const padding = 24
    const headerSpace = 36
    const groupX = minX - padding
    const groupY = minY - padding - headerSpace
    const groupW = maxX - minX + padding * 2
    const groupH = maxY - minY + padding * 2 + headerSpace

    const groupId = newCanvasId()
    const groupNode: CanvasFlowNode = {
      id: groupId,
      type: "group",
      position: { x: Math.round(groupX), y: Math.round(groupY) },
      width: Math.round(groupW),
      height: Math.round(groupH),
      style: { width: Math.round(groupW), height: Math.round(groupH) },
      data: { label: "", __canvasNodeType: "group" },
      zIndex: 0,
      selected: true,
    }

    setNodes((nds) => {
      // Unselect previous, select new group
      const nextNodes = [groupNode, ...nds]
      recordSnapshot(nextNodes, edgesRef.current)
      return nextNodes
    })
    schedulePublish(0)
  }, [recordSnapshot, rf, schedulePublish, setNodes])

  // ── Colors / Z-Order / Arrows / Labels ──
  const setNodeColor = React.useCallback(
    (id: string, color?: string) => {
      updateNodeData(id, { color })
    },
    [updateNodeData],
  )

  const setEdgeColor = React.useCallback(
    (id: string, color?: string) => {
      const css = colorToCss(color)
      setEdges((eds) => {
        const next = eds.map((e) => {
          if (e.id !== id) return e
          const d = (e.data ?? {}) as CanvasEdgeData
          return {
            ...e,
            data: { ...d, color },
            style: { ...e.style, stroke: css },
            markerEnd: arrowMarker(d.toEnd ?? "arrow", css),
            markerStart: arrowMarker(d.fromEnd ?? "none", css),
          }
        })
        recordSnapshot(nodesRef.current, next)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setEdges],
  )

  const cycleArrows = React.useCallback(
    (id: string, mode: "to" | "both" | "none") => {
      const toEnd: CanvasEdgeEnd = mode === "none" ? "none" : "arrow"
      const fromEnd: CanvasEdgeEnd = mode === "both" ? "arrow" : "none"
      setEdges((eds) => {
        const next = eds.map((e) => {
          if (e.id !== id) return e
          const d = (e.data ?? {}) as CanvasEdgeData
          const css = colorToCss(d.color)
          return {
            ...e,
            data: { ...d, toEnd, fromEnd },
            markerEnd: arrowMarker(toEnd, css),
            markerStart: arrowMarker(fromEnd, css),
          }
        })
        recordSnapshot(nodesRef.current, next)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setEdges],
  )

  const setEdgeLabel = React.useCallback(
    (id: string, label: string) => {
      setEdges((eds) => {
        const next = eds.map((e) => {
          if (e.id !== id) return e
          const d = (e.data ?? {}) as CanvasEdgeData
          return {
            ...e,
            label,
            data: { ...d, label },
          }
        })
        recordSnapshot(nodesRef.current, next)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setEdges],
  )

  const bringTo = React.useCallback(
    (id: string, dir: "front" | "back") => {
      const zs = rf.getNodes().map((n) => n.zIndex ?? 0)
      const z = dir === "front" ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1
      setNodes((nds) => {
        const next = nds.map((n) => (n.id === id ? { ...n, zIndex: z } : n))
        recordSnapshot(next, edgesRef.current)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, rf, schedulePublish, setNodes],
  )

  const removeNode = React.useCallback(
    (id: string) => {
      const nextNodes = nodesRef.current.filter((n) => n.id !== id)
      const nextEdges = edgesRef.current.filter((e) => e.source !== id && e.target !== id)
      setNodes(nextNodes)
      setEdges(nextEdges)
      recordSnapshot(nextNodes, nextEdges)
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setEdges, setNodes],
  )

  const removeSelected = React.useCallback(() => {
    const selNodes = new Set(
      rf
        .getNodes()
        .filter((n) => n.selected)
        .map((n) => n.id),
    )
    const selEdges = new Set(
      rf
        .getEdges()
        .filter((e) => e.selected)
        .map((e) => e.id),
    )
    if (selNodes.size === 0 && selEdges.size === 0) return

    const nextNodes = nodesRef.current.filter((n) => !selNodes.has(n.id))
    const nextEdges = edgesRef.current.filter(
      (e) => !selEdges.has(e.id) && !selNodes.has(e.source) && !selNodes.has(e.target),
    )
    setNodes(nextNodes)
    setEdges(nextEdges)
    recordSnapshot(nextNodes, nextEdges)
    schedulePublish(0)
  }, [recordSnapshot, rf, schedulePublish, setEdges, setNodes])

  const removeEdge = React.useCallback(
    (id: string) => {
      setEdges((eds) => {
        const next = eds.filter((e) => e.id !== id)
        recordSnapshot(nodesRef.current, next)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setEdges],
  )

  const duplicateNode = React.useCallback(
    (id: string) => {
      const node = rf.getNodes().find((n) => n.id === id) as CanvasFlowNode | undefined
      if (!node) return
      const dup = duplicateGraph([node], [])
      setNodes((nds) => {
        const next = [...nds.map((n) => ({ ...n, selected: false })), ...dup.nodes]
        recordSnapshot(next, edgesRef.current)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, rf, schedulePublish, setNodes],
  )

  // ── Align & Distribute ──
  const alignSelection = React.useCallback(
    (type: AlignmentType) => {
      const selIds = new Set(
        rf
          .getNodes()
          .filter((n) => n.selected)
          .map((n) => n.id),
      )
      if (selIds.size < 2) return
      setNodes((nds) => {
        const next = alignNodes(nds, selIds, type)
        recordSnapshot(next, edgesRef.current)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, rf, schedulePublish, setNodes],
  )

  const distributeSelection = React.useCallback(
    (axis: DistributionAxis) => {
      const selIds = new Set(
        rf
          .getNodes()
          .filter((n) => n.selected)
          .map((n) => n.id),
      )
      if (selIds.size < 3) return
      setNodes((nds) => {
        const next = distributeNodes(nds, selIds, axis)
        recordSnapshot(next, edgesRef.current)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, rf, schedulePublish, setNodes],
  )

  // ── Auto Layout ──
  const autoLayout = React.useCallback(
    (options?: LayoutOptions) => {
      setNodes((nds) => {
        const next = computeAutoLayout(nds, edgesRef.current, options)
        recordSnapshot(next, edgesRef.current)
        return next
      })
      schedulePublish(0)
    },
    [recordSnapshot, schedulePublish, setNodes],
  )

  // ── Group Containment On Drag ──
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
    recordSnapshot()
    schedulePublish(0)
  }, [recordSnapshot, schedulePublish])

  const onSelectionDragStop = React.useCallback(() => {
    recordSnapshot()
    schedulePublish(0)
  }, [recordSnapshot, schedulePublish])

  // ── Keyboard shortcuts ──
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const isEditable = target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA"
      if (isEditable) return

      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) {
          redo()
        } else {
          undo()
        }
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault()
        redo()
      } else if (mod && e.key.toLowerCase() === "c") {
        copySelection()
      } else if (mod && e.key.toLowerCase() === "v") {
        pasteClipboard()
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault()
        duplicateSelection()
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault()
        groupSelection()
      } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        const step = e.shiftKey ? 20 : 1
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
        if (dx || dy) {
          const hasSel = rf.getNodes().some((n) => n.selected)
          if (hasSel) {
            e.preventDefault()
            setNodes((nds) => {
              const next = nds.map((n) =>
                n.selected ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
              )
              return next
            })
            recordSnapshot()
            schedulePublish(0)
          }
        }
      }
    }
    const el = wrapRef.current
    el?.addEventListener("keydown", onKey)
    return () => el?.removeEventListener("keydown", onKey)
  }, [
    copySelection,
    pasteClipboard,
    duplicateSelection,
    groupSelection,
    undo,
    redo,
    recordSnapshot,
    rf,
    schedulePublish,
    setNodes,
    wrapRef,
  ])

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onReconnect,
    makeNode,
    addNode,
    addNodesAndEdges,
    setNodes,
    setEdges,
    updateNodeData,
    duplicateSelection,
    copySelection,
    pasteClipboard,
    hasClipboard,
    groupSelection,
    alignSelection,
    distributeSelection,
    autoLayout,
    setNodeColor,
    setEdgeColor,
    cycleArrows,
    setEdgeLabel,
    bringTo,
    removeNode,
    removeSelected,
    removeEdge,
    duplicateNode,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onSelectionDragStop,
    undo,
    redo,
    canUndo,
    canRedo,
  }
}
