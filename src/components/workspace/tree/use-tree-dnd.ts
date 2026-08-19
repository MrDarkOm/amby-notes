"use client"

import * as React from "react"
import { setTreeDragPayload, clearTreeDragPayload } from "@/lib/canvas-dnd"
import { ROOT_DROP_TARGET, type PtrDrag } from "./tree-types"

export function useTreeDnd({
  onMoveItem,
}: {
  onMoveItem?: (sourceId: string, targetId: string | null) => void
}) {
  const [ptrDrag, setPtrDrag] = React.useState<PtrDrag | null>(null)
  const ptrDragRef = React.useRef<PtrDrag | null>(null)
  const onMoveItemRef = React.useRef(onMoveItem)
  const pointerDownRef = React.useRef<{
    id: string
    name: string
    path: string
    x: number
    y: number
  } | null>(null)

  React.useEffect(() => {
    ptrDragRef.current = ptrDrag
  }, [ptrDrag])

  React.useEffect(() => {
    onMoveItemRef.current = onMoveItem
  }, [onMoveItem])

  const onPtrDragStart = React.useCallback(
    (id: string, name: string, path: string, x: number, y: number) => {
      pointerDownRef.current = { id, name, path, x, y }
    },
    [],
  )

  React.useEffect(() => {
    function onMove(e: PointerEvent) {
      const pd = pointerDownRef.current
      const drag = ptrDragRef.current

      if (drag) {
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
        const targetEl = el?.closest("[data-drag-target]") as HTMLElement | null
        const candidate = targetEl?.getAttribute("data-drag-target") ?? null
        const validTarget =
          candidate === ROOT_DROP_TARGET
            ? ROOT_DROP_TARGET
            : candidate && candidate !== drag.sourceId && !candidate.startsWith(drag.sourceId + "/")
              ? candidate
              : null
        setPtrDrag((prev) =>
          prev ? { ...prev, ghostX: e.clientX, ghostY: e.clientY, targetId: validTarget } : null,
        )
        return
      }

      if (pd) {
        const dx = Math.abs(e.clientX - pd.x)
        const dy = Math.abs(e.clientY - pd.y)
        if (dx > 5 || dy > 5) {
          const { id: startId, name: startName, path: startPath } = pd
          pointerDownRef.current = null
          const suppress = (ev: MouseEvent) => {
            ev.stopPropagation()
            ev.preventDefault()
            document.removeEventListener("click", suppress, true)
          }
          document.addEventListener("click", suppress, true)
          setTreeDragPayload({ id: startId, name: startName, path: startPath })
          setPtrDrag({
            sourceId: startId,
            sourceName: startName,
            startX: pd.x,
            startY: pd.y,
            ghostX: e.clientX,
            ghostY: e.clientY,
            active: true,
            targetId: null,
          })
        }
      }
    }

    function onUp(_e: PointerEvent) {
      const drag = ptrDragRef.current
      pointerDownRef.current = null
      if (drag) {
        if (drag.targetId) {
          onMoveItemRef.current?.(
            drag.sourceId,
            drag.targetId === ROOT_DROP_TARGET ? null : drag.targetId,
          )
        }
        setPtrDrag(null)
      }
      setTimeout(() => clearTreeDragPayload(), 0)
    }

    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
    return () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
    }
  }, [])

  return {
    ptrDrag,
    onPtrDragStart,
  }
}
