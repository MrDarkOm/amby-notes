"use client"

import * as React from "react"
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react"
import type { CanvasEdgeData } from "@/lib/canvas-format"

export function CanvasEdge({
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
            className="nodrag nopan absolute rounded border border-border bg-card px-1 text-[11px] text-foreground outline-none"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          />
        ) : d.label ? (
          <div
            className="nodrag nopan absolute cursor-text rounded bg-card/90 px-1 text-[11px] text-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
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
