"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react"
import type { CanvasEdgeData } from "@/lib/canvas-format"
import { useCanvasCtx } from "./canvas-context"

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
  const { t } = useTranslation()
  const d = (data ?? {}) as CanvasEdgeData
  const { setEdgeLabel } = useCanvasCtx()
  const [editing, setEditing] = React.useState(false)
  const [tempLabel, setTempLabel] = React.useState(d.label ?? "")

  React.useEffect(() => {
    setTempLabel(d.label ?? "")
  }, [d.label])

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  const commitLabel = () => {
    setEditing(false)
    if (tempLabel !== (d.label ?? "")) {
      setEdgeLabel?.(id, tempLabel)
    }
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        interactionWidth={20}
        style={{
          ...style,
          strokeWidth: selected ? 2.5 : 1.5,
        }}
        className="cursor-pointer hover:stroke-primary"
      />
      <EdgeLabelRenderer>
        {editing ? (
          <div
            className="nodrag nopan absolute z-30 flex items-center shadow-lg"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            <input
              autoFocus
              value={tempLabel}
              placeholder={t("canvas.edgeLabelPlaceholder")}
              onChange={(e) => setTempLabel(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitLabel()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  setTempLabel(d.label ?? "")
                  setEditing(false)
                }
              }}
              className="rounded-md border border-border bg-card px-2 py-0.5 text-xs text-foreground outline-none ring-1 ring-ring"
            />
          </div>
        ) : d.label ? (
          <div
            className="nodrag nopan absolute z-10 cursor-pointer rounded-md border border-border/60 bg-card/95 px-1.5 py-0.5 text-xs font-medium text-foreground shadow-xs hover:scale-105"
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
        ) : selected ? (
          <button
            type="button"
            className="nodrag nopan absolute z-10 cursor-pointer rounded border border-dashed border-border bg-card/80 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-60 shadow-xs hover:opacity-100"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            onClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            + {t("canvas.addLabel")}
          </button>
        ) : null}
      </EdgeLabelRenderer>
    </>
  )
}
