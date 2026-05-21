"use client"

import * as React from "react"
import { Network, RotateCw } from "lucide-react"
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force"
import type { LinkGraph } from "./panel-registry"

interface GraphTabViewProps {
  graph?: LinkGraph
  selectedId?: string | null
  onSelect: (id: string) => void
}

interface SimNode extends SimulationNodeDatum {
  id: string
  label: string
  unresolved?: boolean
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode
  target: string | SimNode
  unresolved?: boolean
}

const ZOOM_MIN = 0.1
const ZOOM_MAX = 4

export function GraphTabView({ graph, selectedId, onSelect }: GraphTabViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const [size, setSize] = React.useState({ w: 800, h: 600 })

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect
      if (r) setSize({ w: Math.max(200, r.width), h: Math.max(200, r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []

  // Keep stable refs to node objects across re-renders so positions persist.
  const nodeMapRef = React.useRef<Map<string, SimNode>>(new Map())
  const simRef = React.useRef<Simulation<SimNode, SimLink> | null>(null)
  const [, setTick] = React.useState(0)

  // Build / sync sim nodes and links whenever graph topology changes.
  const { simNodes, simLinks } = React.useMemo(() => {
    const next = new Map<string, SimNode>()
    nodes.forEach(n => {
      const prev = nodeMapRef.current.get(n.id)
      if (prev) {
        prev.label = n.label
        prev.unresolved = n.unresolved
        next.set(n.id, prev)
      } else {
        next.set(n.id, {
          id: n.id,
          label: n.label,
          unresolved: n.unresolved,
          x: (Math.random() - 0.5) * 200,
          y: (Math.random() - 0.5) * 200,
        })
      }
    })
    nodeMapRef.current = next
    const simNodes = Array.from(next.values())
    const simLinks: SimLink[] = edges
      .filter(e => next.has(e.source) && next.has(e.target))
      .map(e => ({ source: e.source, target: e.target, unresolved: e.unresolved }))
    return { simNodes, simLinks }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph])

  // Create / restart simulation.
  React.useEffect(() => {
    if (simNodes.length === 0) return
    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id(d => d.id)
          .distance(80)
          .strength(0.7),
      )
      .force("charge", forceManyBody().strength(-220))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(18))
      .alpha(1)
      .alphaDecay(0.04)
      .on("tick", () => setTick(t => (t + 1) & 0xffff))

    simRef.current = sim
    return () => {
      sim.stop()
      if (simRef.current === sim) simRef.current = null
    }
  }, [simNodes, simLinks])

  // Viewport: pan + zoom.
  const [view, setView] = React.useState({ tx: 0, ty: 0, zoom: 1 })
  React.useEffect(() => {
    // Recenter when container resizes (first measurement).
    setView(v => (v.tx === 0 && v.ty === 0 ? { tx: size.w / 2, ty: size.h / 2, zoom: v.zoom } : v))
  }, [size.w, size.h])

  const panStateRef = React.useRef<{ startX: number; startY: number; baseTx: number; baseTy: number } | null>(null)
  const dragStateRef = React.useRef<{
    nodeId: string
    pointerId: number
    moved: number
  } | null>(null)

  function screenToGraph(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    return { x: (sx - view.tx) / view.zoom, y: (sy - view.ty) / view.zoom }
  }

  function handleBgPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if ((e.target as Element).closest("[data-node-id]")) return
    panStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseTx: view.tx,
      baseTy: view.ty,
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const drag = dragStateRef.current
    if (drag) {
      const node = nodeMapRef.current.get(drag.nodeId)
      if (node) {
        const g = screenToGraph(e.clientX, e.clientY)
        node.fx = g.x
        node.fy = g.y
        drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY)
        simRef.current?.alpha(0.3).restart()
      }
      return
    }
    const pan = panStateRef.current
    if (pan) {
      setView(v => ({
        ...v,
        tx: pan.baseTx + (e.clientX - pan.startX),
        ty: pan.baseTy + (e.clientY - pan.startY),
      }))
    }
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    const drag = dragStateRef.current
    if (drag) {
      const node = nodeMapRef.current.get(drag.nodeId)
      if (node) {
        node.fx = null
        node.fy = null
      }
      // Treat near-zero movement as a click.
      if (drag.moved < 4) {
        const n = nodes.find(x => x.id === drag.nodeId)
        if (n && !n.unresolved) onSelect(drag.nodeId)
      }
      dragStateRef.current = null
    }
    panStateRef.current = null
    try {
      ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  function handleNodePointerDown(e: React.PointerEvent, nodeId: string) {
    e.stopPropagation()
    dragStateRef.current = { nodeId, pointerId: e.pointerId, moved: 0 }
    const node = nodeMapRef.current.get(nodeId)
    if (node) {
      node.fx = node.x
      node.fy = node.y
    }
    ;(svgRef.current as Element | null)?.setPointerCapture(e.pointerId)
  }

  function handleWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const factor = Math.exp(-e.deltaY * 0.0015)
    setView(v => {
      const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom * factor))
      const k = nextZoom / v.zoom
      return {
        tx: sx - (sx - v.tx) * k,
        ty: sy - (sy - v.ty) * k,
        zoom: nextZoom,
      }
    })
  }

  function recenter() {
    nodeMapRef.current.forEach(n => {
      n.fx = null
      n.fy = null
    })
    simRef.current?.alpha(1).restart()
    setView({ tx: size.w / 2, ty: size.h / 2, zoom: 1 })
  }

  if (nodes.length === 0 || edges.length === 0) {
    return (
      <div ref={containerRef} className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <Network className="size-12 text-zinc-700" />
        <p className="text-[14px] text-zinc-500">Нет связей</p>
        <p className="text-[12px] text-zinc-600">Добавь ссылки вида [[Заметка]]</p>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2">
        <div>
          <p className="text-[13px] font-medium text-zinc-300">Граф связей</p>
          <p className="text-[11px] text-zinc-600">{nodes.length} узлов · {edges.length} ссылок</p>
        </div>
        <button
          type="button"
          onClick={recenter}
          className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          title="Перезапустить раскладку"
        >
          <RotateCw className="size-3.5" />
          Центр
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <svg
          ref={svgRef}
          width={size.w}
          height={size.h}
          className="block touch-none select-none"
          style={{ cursor: panStateRef.current ? "grabbing" : "grab" }}
          onPointerDown={handleBgPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.zoom})`}>
            {simLinks.map((edge, i) => {
              const s = edge.source as SimNode
              const t = edge.target as SimNode
              if (s.x == null || s.y == null || t.x == null || t.y == null) return null
              return (
                <line
                  key={`${typeof edge.source === "string" ? edge.source : s.id}-${typeof edge.target === "string" ? edge.target : t.id}-${i}`}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  className={edge.unresolved ? "stroke-zinc-700" : "stroke-sky-500/45"}
                  strokeWidth={1.2 / view.zoom}
                />
              )
            })}
            {simNodes.map(node => {
              if (node.x == null || node.y == null) return null
              const selected = node.id === selectedId
              const r = selected ? 12 : 8
              return (
                <g
                  key={node.id}
                  data-node-id={node.id}
                  className={node.unresolved ? "cursor-default" : "cursor-pointer"}
                  onPointerDown={e => handleNodePointerDown(e, node.id)}
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={r}
                    className={selected ? "fill-sky-400" : node.unresolved ? "fill-zinc-700" : "fill-zinc-300"}
                  />
                  <text
                    x={node.x}
                    y={node.y + r + 12}
                    textAnchor="middle"
                    style={{ fontSize: 11 / Math.max(view.zoom, 0.6) }}
                    className={selected ? "fill-sky-300" : "fill-zinc-500"}
                  >
                    {node.label.slice(0, 24)}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}
