"use client"

import * as React from "react"
import { Network } from "lucide-react"
import type { LinkGraph } from "./panel-registry"

interface GraphTabViewProps {
  graph?: LinkGraph
  selectedId?: string | null
  onSelect: (id: string) => void
}

export function GraphTabView({ graph, selectedId, onSelect }: GraphTabViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
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

  const positions = React.useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    const cx = size.w / 2
    const cy = size.h / 2
    const radius = Math.max(120, Math.min(Math.min(size.w, size.h) / 2 - 60, nodes.length * 30))
    const selectedNode = nodes.find(n => n.id === selectedId)
    if (selectedNode) map.set(selectedNode.id, { x: cx, y: cy })
    const others = nodes.filter(n => n.id !== selectedId)
    others.forEach((node, i) => {
      const angle = (Math.PI * 2 * i) / Math.max(others.length, 1) - Math.PI / 2
      map.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
    })
    return map
  }, [nodes, selectedId, size.w, size.h])

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
      <div className="shrink-0 border-b border-zinc-800 px-4 py-2">
        <p className="text-[13px] font-medium text-zinc-300">Граф связей</p>
        <p className="text-[11px] text-zinc-600">{nodes.length} узлов · {edges.length} ссылок</p>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <svg width={size.w} height={size.h} className="block">
          {edges.map((edge, i) => {
            const from = positions.get(edge.source)
            const to = positions.get(edge.target)
            if (!from || !to) return null
            return (
              <line
                key={`${edge.source}-${edge.target}-${i}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={edge.unresolved ? "stroke-zinc-700" : "stroke-sky-500/45"}
                strokeWidth="1.2"
              />
            )
          })}
          {nodes.map(node => {
            const pos = positions.get(node.id)
            if (!pos) return null
            const selected = node.id === selectedId
            return (
              <g
                key={node.id}
                className={node.unresolved ? "cursor-default" : "cursor-pointer"}
                onClick={() => { if (!node.unresolved) onSelect(node.id) }}
              >
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={selected ? 12 : 8}
                  className={selected ? "fill-sky-400" : node.unresolved ? "fill-zinc-700" : "fill-zinc-300"}
                />
                <text
                  x={pos.x}
                  y={pos.y + 22}
                  textAnchor="middle"
                  className={selected ? "fill-sky-300 text-[11px]" : "fill-zinc-500 text-[10px]"}
                >
                  {node.label.slice(0, 24)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
